'use strict';

/**
 * payoutService.js
 *
 * Implements two core business rules of the payout system:
 *
 * 1. ADVANCE PAYOUT (runAdvancePayoutJob)
 *    When a sale is first recorded, the seller receives an advance of 10% of
 *    their gross earning upfront, before the sale is verified/reconciled.
 *    Example: sale.earning = 40 → advance = 40 × 0.10 = 4.00
 *
 * 2. FINAL ADJUSTMENT (reconcileSale)
 *    Once a sale is reconciled by an admin:
 *      - APPROVED: seller receives the remaining balance (earning − advance).
 *        Example: 40 − 4 = 36.00 credited to the ledger.
 *      - REJECTED: the advance is clawed back (advance negated).
 *        Example: −4.00 debited from the ledger (seller returns the advance).
 *
 * This file is the only place that knows about the 10% advance rule and the
 * approved/rejected adjustment math. saleService and ledgerService are
 * deliberately kept ignorant of these business rules.
 */

const saleService = require('./saleService');
const ledgerService = require('./ledgerService');
const db = require('../db');

/** Advance payout percentage — 10% of gross earning. */
const ADVANCE_PERCENTAGE = 0.10;

// ---------------------------------------------------------------------------
// runAdvancePayoutJob
// ---------------------------------------------------------------------------

/**
 * Batch job: find every pending sale that has not yet had an advance paid, and
 * issue a 10% advance payout for each one.
 *
 * WHY THIS JOB IS SAFE TO RUN MULTIPLE TIMES / CONCURRENTLY:
 * Each sale is processed inside its own db.transaction(). Inside that
 * transaction, saleService.markAdvancePaid() issues:
 *
 *   UPDATE sales SET advance_paid = 1 ... WHERE id = ? AND advance_paid = 0
 *
 * SQLite's serialized writer model means only one caller can successfully flip
 * `advance_paid` from 0 to 1 for a given sale — every subsequent caller gets
 * rows changed = 0 and is skipped BEFORE a ledger entry is written.
 * This makes duplicate ledger entries structurally impossible even if this job
 * is triggered twice in quick succession or by two concurrent processes.
 *
 * @returns {{ processedCount: number, totalAdvancePaid: number, results: object[] }}
 */
function runAdvancePayoutJob() {
  const eligibleSales = saleService.getPendingUnadvancedSales();

  const results = [];
  let processedCount = 0;
  let totalAdvancePaid = 0;

  for (const sale of eligibleSales) {
    const advanceAmount = Math.round(sale.earning * ADVANCE_PERCENTAGE * 100) / 100;

    const processSale = db.transaction(() => {
      const changed = saleService.markAdvancePaid(sale.id, advanceAmount);

      if (changed === 0) {
        // Another process already advanced this sale between our query and now —
        // the idempotency guard caught it; skip cleanly.
        return { saleId: sale.id, userId: sale.user_id, advanceAmount, status: 'skipped' };
      }

      ledgerService.addEntry({
        userId: sale.user_id,
        saleId: sale.id,
        type: 'ADVANCE',
        amount: advanceAmount,
        note: `Advance payout (10%) for sale ${sale.id}`,
      });

      return { saleId: sale.id, userId: sale.user_id, advanceAmount, status: 'paid' };
    });

    const result = processSale();
    results.push(result);

    if (result.status === 'paid') {
      processedCount += 1;
      totalAdvancePaid = Math.round((totalAdvancePaid + advanceAmount) * 100) / 100;
    }
  }

  return { processedCount, totalAdvancePaid, results };
}

// ---------------------------------------------------------------------------
// reconcileSale
// ---------------------------------------------------------------------------

/**
 * Reconcile a sale as approved or rejected, and write the corresponding final
 * adjustment ledger entry.
 *
 *   approved → credit  (earning − advance_amount)
 *   rejected → debit   (−advance_amount)  — claw back the advance
 *
 * Defense in depth:
 *  - Pre-check: gives a clean error message if the sale is already reconciled
 *    before we even attempt the transaction.
 *  - DB-level guard (inside markReconciled): WHERE status = 'pending' ensures
 *    only one caller can ever reconcile a given sale, catching race conditions
 *    that slip past the pre-check.
 *
 * @param {string} saleId
 * @param {'approved'|'rejected'} newStatus
 * @returns {{ saleId, newStatus, advancePaid, earning, adjustment }}
 */
function reconcileSale(saleId, newStatus) {
  if (newStatus !== 'approved' && newStatus !== 'rejected') {
    throw new Error(`Invalid status "${newStatus}". Must be "approved" or "rejected".`);
  }

  const sale = saleService.getSaleById(saleId);
  if (!sale) {
    throw new Error('Sale not found.');
  }

  // Pre-check: friendly error before hitting the DB guard.
  if (sale.status !== 'pending') {
    throw new Error('Sale has already been reconciled.');
  }

  let adjustment;

  const doReconcile = db.transaction(() => {
    const changed = saleService.markReconciled(saleId, newStatus);

    if (changed === 0) {
      // Race condition: another caller reconciled this sale between our
      // pre-check and this transaction — DB-level guard caught it.
      throw new Error('Sale was already reconciled by another process.');
    }

    if (newStatus === 'approved') {
      adjustment = Math.round((sale.earning - sale.advance_amount) * 100) / 100;
    } else {
      // rejected: claw back the advance (negative = debit).
      // || 0 coerces JavaScript's -0 (produced when advance_amount = 0) to 0,
      // so strict equality checks in tests and callers behave as expected.
      adjustment = Math.round(-sale.advance_amount * 100) / 100 || 0;
    }

    ledgerService.addEntry({
      userId: sale.user_id,
      saleId: sale.id,
      type: 'FINAL_ADJUSTMENT',
      amount: adjustment,
      note: `Final adjustment (${newStatus}) for sale ${sale.id}: earning=${sale.earning}, advance_paid=${sale.advance_amount}`,
    });
  });

  doReconcile();

  return {
    saleId,
    newStatus,
    advancePaid: sale.advance_amount,
    earning: sale.earning,
    adjustment,
  };
}

module.exports = { ADVANCE_PERCENTAGE, runAdvancePayoutJob, reconcileSale };
