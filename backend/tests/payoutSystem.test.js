/**
 * payoutSystem.test.js
 *
 * Integration tests for the Payout Management System services.
 * Tests call service functions directly (no HTTP layer) for speed.
 *
 * IMPORTANT: setup.js MUST be the first require — it sets DB_PATH before
 * any service module loads db.js, which opens the SQLite file at require-time.
 */

'use strict';

const { resetDb } = require('./setup');                             // ← MUST be first

const ledgerService     = require('../src/services/ledgerService');
const saleService       = require('../src/services/saleService');
const payoutService     = require('../src/services/payoutService');
const withdrawalService = require('../src/services/withdrawalService');

// Give each test up to 10 s (file I/O on slow CI disks).
jest.setTimeout(10_000);

// Wipe all rows before each test so tests are fully order-independent.
beforeEach(() => {
  resetDb();
});

/* ============================================================
   Ledger & balance
   ============================================================ */

describe('Ledger & balance', () => {
  test('1. getBalance returns 0 for a user with no entries', () => {
    expect(ledgerService.getBalance('no-such-user')).toBe(0);
  });

  test('2. Multiple addEntry calls are reflected in getBalance', () => {
    // Positive entry: credit 100
    ledgerService.addEntry({ userId: 'u1', type: 'ADVANCE', amount: 100, note: 'credit' });
    // Negative entry: debit 37.50
    ledgerService.addEntry({ userId: 'u1', type: 'WITHDRAWAL', amount: -37.5, note: 'debit' });
    // Another credit
    ledgerService.addEntry({ userId: 'u1', type: 'REFUND', amount: 10, note: 'refund' });

    // Expected: 100 - 37.5 + 10 = 72.5
    expect(ledgerService.getBalance('u1')).toBe(72.5);
  });
});

/* ============================================================
   Advance payout
   ============================================================ */

describe('Advance payout', () => {
  test('3. Sale earning=40: advance job pays exactly 4 (10%) and marks advance_paid', () => {
    saleService.createSale({ userId: 'u1', brand: 'brand_1', earning: 40 });
    const { processedCount, totalAdvancePaid } = payoutService.runAdvancePayoutJob();

    expect(processedCount).toBe(1);
    expect(totalAdvancePaid).toBe(4);

    const sales = saleService.getSalesByUser('u1');
    expect(sales[0].advance_paid).toBe(1);
    expect(sales[0].advance_amount).toBe(4);

    expect(ledgerService.getBalance('u1')).toBe(4);
  });

  test('4. Running the advance job TWICE only pays the advance once', () => {
    const sale = saleService.createSale({ userId: 'u1', brand: 'brand_1', earning: 40 });
    payoutService.runAdvancePayoutJob(); // first run
    payoutService.runAdvancePayoutJob(); // second run — should be a no-op for this sale

    // Balance must still be 4, not 8
    expect(ledgerService.getBalance('u1')).toBe(4);

    // Only one ADVANCE ledger entry should exist for this sale
    const entries = ledgerService.getLedgerForUser('u1');
    const advanceEntries = entries.filter(
      (e) => e.type === 'ADVANCE' && e.sale_id === sale.id
    );
    expect(advanceEntries).toHaveLength(1);
  });

  test('5. Running the advance job with no eligible sales returns processedCount=0 and does not error', () => {
    const result = payoutService.runAdvancePayoutJob();
    expect(result.processedCount).toBe(0);
    expect(result.totalAdvancePaid).toBe(0);
    expect(result.results).toHaveLength(0);
  });

  test('6. Multiple pending sales for the same user are all advanced in one run', () => {
    saleService.createSale({ userId: 'u1', brand: 'brand_1', earning: 40 });
    saleService.createSale({ userId: 'u1', brand: 'brand_2', earning: 100 });
    saleService.createSale({ userId: 'u1', brand: 'brand_3', earning: 60 });

    const { processedCount, totalAdvancePaid } = payoutService.runAdvancePayoutJob();

    // 10% of (40 + 100 + 60) = 20
    expect(processedCount).toBe(3);
    expect(totalAdvancePaid).toBe(20);
    expect(ledgerService.getBalance('u1')).toBe(20);
  });
});

/* ============================================================
   Reconciliation — replicating the assignment's worked example
   ============================================================ */

describe('Reconciliation', () => {
  test('7. Full assignment scenario: 3 × earning=40, advance job, then reject/approve/approve', () => {
    // Create 3 sales for john_doe, brand_1, earning=40 each
    const s1 = saleService.createSale({ userId: 'john_doe', brand: 'brand_1', earning: 40 });
    const s2 = saleService.createSale({ userId: 'john_doe', brand: 'brand_1', earning: 40 });
    const s3 = saleService.createSale({ userId: 'john_doe', brand: 'brand_1', earning: 40 });

    // Run advance job — each sale gets 10% of 40 = 4 → total advance = 12
    const { totalAdvancePaid } = payoutService.runAdvancePayoutJob();
    expect(totalAdvancePaid).toBe(12);

    // Balance after advances = 12
    expect(ledgerService.getBalance('john_doe')).toBe(12);

    // Reconcile sale 1 as rejected → adjustment = -4 (claw back the advance)
    payoutService.reconcileSale(s1.id, 'rejected');

    // Reconcile sale 2 as approved → adjustment = 40 - 4 = 36
    payoutService.reconcileSale(s2.id, 'approved');

    // Reconcile sale 3 as approved → adjustment = 40 - 4 = 36
    payoutService.reconcileSale(s3.id, 'approved');

    // --- Assertions ---

    // Sum of FINAL_ADJUSTMENT entries only (the "final payout" portion, per the assignment):
    //   sale1 rejected: -4
    //   sale2 approved: +36
    //   sale3 approved: +36
    //   Total FINAL_ADJUSTMENT = -4 + 36 + 36 = 68
    //
    // NOTE: The assignment's stated ₹68 refers specifically to the net value of
    // the final reconciliation adjustments — NOT the total balance including the
    // earlier advances. The full balance also includes the ₹12 already credited
    // as advances, making the true total balance ₹80 (12 + 68).
    const allEntries = ledgerService.getLedgerForUser('john_doe');
    const finalAdjustmentTotal = allEntries
      .filter((e) => e.type === 'FINAL_ADJUSTMENT')
      .reduce((sum, e) => sum + e.amount, 0);

    // Floating-point safe comparison
    expect(Math.round(finalAdjustmentTotal * 100) / 100).toBe(68);

    // Total balance = advances (12) + final adjustments (68) = 80
    expect(ledgerService.getBalance('john_doe')).toBe(80);
  });

  test('8. Approved sale with no prior advance: final adjustment = full earning', () => {
    // Manually create a sale and reconcile WITHOUT running the advance job first,
    // so advance_paid=0 and advance_amount=0.
    const sale = saleService.createSale({ userId: 'u1', brand: 'b', earning: 50 });
    const result = payoutService.reconcileSale(sale.id, 'approved');

    // adjustment should be earning - 0 = 50
    expect(result.adjustment).toBe(50);
    expect(ledgerService.getBalance('u1')).toBe(50);
  });

  test('9. Rejected sale with no prior advance: final adjustment = 0 (nothing to claw back)', () => {
    const sale = saleService.createSale({ userId: 'u1', brand: 'b', earning: 50 });
    const result = payoutService.reconcileSale(sale.id, 'rejected');

    // adjustment = -advance_amount = -0 = 0
    expect(result.adjustment).toBe(0);
    expect(ledgerService.getBalance('u1')).toBe(0);
  });

  test('10. Reconciling an already-reconciled sale throws and does not create duplicate entries', () => {
    const sale = saleService.createSale({ userId: 'u1', brand: 'b', earning: 40 });
    payoutService.reconcileSale(sale.id, 'approved');

    // Second reconcile attempt must throw
    expect(() => payoutService.reconcileSale(sale.id, 'approved')).toThrow(/already/i);

    // Only one FINAL_ADJUSTMENT entry should exist
    const entries = ledgerService.getLedgerForUser('u1');
    const adjustments = entries.filter((e) => e.type === 'FINAL_ADJUSTMENT');
    expect(adjustments).toHaveLength(1);
  });

  test('11. Reconciling a non-existent sale id throws a not-found error', () => {
    expect(() => payoutService.reconcileSale('does-not-exist', 'approved')).toThrow(/not found/i);
  });

  test('12. Reconciling with an invalid status throws an error', () => {
    const sale = saleService.createSale({ userId: 'u1', brand: 'b', earning: 40 });
    expect(() => payoutService.reconcileSale(sale.id, 'pending')).toThrow();
    expect(() => payoutService.reconcileSale(sale.id, 'banana')).toThrow();
  });
});

/* ============================================================
   Withdrawals & cooldown
   ============================================================ */

describe('Withdrawals & cooldown', () => {
  test('13. Withdrawing with zero balance throws an error and creates no withdrawal row', () => {
    expect(() => withdrawalService.initiateWithdrawal('u1')).toThrow(/balance/i);

    const withdrawals = withdrawalService.getWithdrawalsByUser('u1');
    expect(withdrawals).toHaveLength(0);
  });

  test('14. Withdrawing with positive balance creates PENDING withdrawal and immediately debits ledger', () => {
    // Credit the user first via a ledger entry
    ledgerService.addEntry({ userId: 'u1', type: 'ADVANCE', amount: 50, note: 'seed' });
    expect(ledgerService.getBalance('u1')).toBe(50);

    const withdrawal = withdrawalService.initiateWithdrawal('u1');

    expect(withdrawal.status).toBe('PENDING');
    expect(withdrawal.amount).toBe(50);

    // Balance must be 0 immediately after initiation (optimistic debit)
    expect(ledgerService.getBalance('u1')).toBe(0);
  });

  test('15. Settling COMPLETED leaves balance at 0 (no refund entry)', () => {
    ledgerService.addEntry({ userId: 'u1', type: 'ADVANCE', amount: 50, note: 'seed' });
    const w = withdrawalService.initiateWithdrawal('u1');
    withdrawalService.settleWithdrawal(w.id, 'COMPLETED');

    expect(ledgerService.getBalance('u1')).toBe(0);

    const entries = ledgerService.getLedgerForUser('u1');
    const refunds = entries.filter((e) => e.type === 'REFUND');
    expect(refunds).toHaveLength(0);
  });

  test('16. Settling FAILED credits the amount back; balance restored; REFUND entry exists', () => {
    ledgerService.addEntry({ userId: 'u1', type: 'ADVANCE', amount: 50, note: 'seed' });
    const w = withdrawalService.initiateWithdrawal('u1');

    expect(ledgerService.getBalance('u1')).toBe(0); // debited at initiation

    withdrawalService.settleWithdrawal(w.id, 'FAILED');

    expect(ledgerService.getBalance('u1')).toBe(50); // refunded

    const entries = ledgerService.getLedgerForUser('u1');
    const refunds = entries.filter((e) => e.type === 'REFUND');
    expect(refunds).toHaveLength(1);
    expect(refunds[0].amount).toBe(50);
  });

  test('17. After a FAILED withdrawal, user can immediately withdraw again (no cooldown)', () => {
    // Assignment Q2: only COMPLETED withdrawals trigger the cooldown.
    // A failed attempt should not block the next withdrawal.
    ledgerService.addEntry({ userId: 'u1', type: 'ADVANCE', amount: 50, note: 'seed' });

    const w = withdrawalService.initiateWithdrawal('u1');
    withdrawalService.settleWithdrawal(w.id, 'FAILED'); // refund credited back

    // This must NOT throw a cooldown error
    expect(() => withdrawalService.initiateWithdrawal('u1')).not.toThrow();
  });

  test('18. After a COMPLETED withdrawal, another attempt within 24 h throws cooldown error', () => {
    ledgerService.addEntry({ userId: 'u1', type: 'ADVANCE', amount: 50, note: 'seed' });

    const w = withdrawalService.initiateWithdrawal('u1');
    // Settle COMPLETED — this sets settled_at = now (within the last second)
    withdrawalService.settleWithdrawal(w.id, 'COMPLETED');

    // Credit more balance so balance check passes and we reach the cooldown check
    ledgerService.addEntry({ userId: 'u1', type: 'REFUND', amount: 50, note: 'top-up for cooldown test' });

    // Immediately trying again must throw the cooldown error
    expect(() => withdrawalService.initiateWithdrawal('u1')).toThrow(/hour/i);
  });

  test('19. Settling a withdrawal twice throws an error', () => {
    ledgerService.addEntry({ userId: 'u1', type: 'ADVANCE', amount: 50, note: 'seed' });
    const w = withdrawalService.initiateWithdrawal('u1');
    withdrawalService.settleWithdrawal(w.id, 'COMPLETED');

    expect(() => withdrawalService.settleWithdrawal(w.id, 'FAILED')).toThrow(/already/i);
  });

  test('20. Settling a non-existent withdrawal id throws a not-found error', () => {
    expect(() => withdrawalService.settleWithdrawal('does-not-exist', 'COMPLETED')).toThrow(/not found/i);
  });
});
