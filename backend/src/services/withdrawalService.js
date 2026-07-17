'use strict';

/**
 * withdrawalService.js
 *
 * WITHDRAWAL LIFECYCLE:
 *
 * 1. INITIATION  — The user's current balance is immediately debited from the
 *    ledger with a WITHDRAWAL entry (negative amount). This is an optimistic
 *    debit: the money is "spoken for" right away so the balance drops to zero
 *    and the user cannot double-withdraw while the payment gateway is in flight.
 *
 * 2. SETTLEMENT  — Once the payment gateway reports back:
 *    - COMPLETED  → no further ledger action; the debit stands.
 *    - FAILED / CANCELLED / REJECTED → a REFUND entry (positive amount) is
 *      written to credit the money back, restoring the user's withdrawable
 *      balance so they can try again.
 *
 * This mirrors how real payment gateways work: you debit immediately on
 * initiation and only know the final outcome asynchronously. The ledger
 * always reflects the current "real" balance regardless of gateway latency.
 */

const { v4: uuidv4 } = require('uuid');
const ledgerService = require('./ledgerService');
const db = require('../db');

/** Minimum hours that must elapse between COMPLETED withdrawals. */
const WITHDRAWAL_COOLDOWN_HOURS = 24;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the most recently COMPLETED withdrawal for a user.
 *
 * WHY ONLY 'COMPLETED' COUNTS TOWARD THE COOLDOWN:
 * A withdrawal that ended as FAILED, CANCELLED, or REJECTED never actually
 * moved any money out of the system (the ledger debit was reversed via a
 * REFUND entry). Penalising a user for a failed gateway attempt would be
 * unfair and would directly violate the assignment requirement that users be
 * allowed to "initiate another withdrawal for that amount" after a failure.
 * Only a COMPLETED withdrawal — one that truly settled — resets the 24-hour
 * clock.
 *
 * @param {string} userId
 * @returns {object|null}
 */
function getLastCompletedWithdrawal(userId) {
  return (
    db
      .prepare(`
        SELECT * FROM withdrawals
        WHERE user_id = ?
          AND status = 'COMPLETED'
        ORDER BY settled_at DESC
        LIMIT 1
      `)
      .get(userId) ?? null
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initiate a withdrawal for the user's full available balance.
 *
 * Checks:
 *  1. Balance must be > 0.
 *  2. At least 24 hours must have elapsed since the last COMPLETED withdrawal.
 *
 * If both checks pass, atomically debits the ledger and creates a PENDING
 * withdrawal record.
 *
 * @param {string} userId
 * @returns {object} The created withdrawal row.
 */
function initiateWithdrawal(userId) {
  const balance = ledgerService.getBalance(userId);

  if (balance <= 0) {
    throw new Error('No withdrawable balance available.');
  }

  // Cooldown check — only COMPLETED withdrawals count (see getLastCompletedWithdrawal).
  const lastCompleted = getLastCompletedWithdrawal(userId);
  if (lastCompleted) {
    const settledAt = new Date(lastCompleted.settled_at);
    const now = new Date();
    const hoursElapsed = (now - settledAt) / (1000 * 60 * 60);

    if (hoursElapsed < WITHDRAWAL_COOLDOWN_HOURS) {
      const hoursRemaining = Math.ceil(WITHDRAWAL_COOLDOWN_HOURS - hoursElapsed);
      throw new Error(
        `Cooldown period active. You can initiate the next withdrawal in ${hoursRemaining} hour${hoursRemaining === 1 ? '' : 's'}.`
      );
    }
  }

  let createdWithdrawal;

  const doInitiate = db.transaction(() => {
    const id = uuidv4();

    db.prepare(`
      INSERT INTO withdrawals (id, user_id, amount, status, created_at)
      VALUES (?, ?, ?, 'PENDING', datetime('now'))
    `).run(id, userId, balance);

    createdWithdrawal = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);

    ledgerService.addEntry({
      userId,
      withdrawalId: createdWithdrawal.id,
      type: 'WITHDRAWAL',
      amount: -balance, // negative = debit
      note: `Withdrawal initiated for ${createdWithdrawal.id}`,
    });
  });

  doInitiate();

  return createdWithdrawal;
}

/**
 * Settle a withdrawal with a final outcome from the payment gateway.
 *
 * COMPLETED  → debit stands; no further ledger action.
 * FAILED / CANCELLED / REJECTED → REFUND entry credits the amount back.
 *
 * Uses the same conditional-WHERE idempotency pattern as saleService: the
 * UPDATE only matches while status = 'PENDING', so duplicate settlement
 * calls are caught at the DB level.
 *
 * @param {string} withdrawalId
 * @param {'COMPLETED'|'FAILED'|'CANCELLED'|'REJECTED'} outcome
 * @returns {object} The updated withdrawal row.
 */
function settleWithdrawal(withdrawalId, outcome) {
  const VALID_OUTCOMES = ['COMPLETED', 'FAILED', 'CANCELLED', 'REJECTED'];
  if (!VALID_OUTCOMES.includes(outcome)) {
    throw new Error(
      `Invalid outcome "${outcome}". Must be one of: ${VALID_OUTCOMES.join(', ')}.`
    );
  }

  const withdrawal = db
    .prepare('SELECT * FROM withdrawals WHERE id = ?')
    .get(withdrawalId) ?? null;

  if (!withdrawal) {
    throw new Error('Withdrawal not found.');
  }

  if (withdrawal.status !== 'PENDING') {
    throw new Error('Withdrawal has already been settled.');
  }

  let updatedWithdrawal;

  const doSettle = db.transaction(() => {
    const result = db.prepare(`
      UPDATE withdrawals
      SET status = ?,
          settled_at = datetime('now')
      WHERE id = ?
        AND status = 'PENDING'
    `).run(outcome, withdrawalId);

    if (result.changes === 0) {
      // Race guard: another process settled this between our pre-check and now.
      throw new Error('Withdrawal was already settled by another process.');
    }

    if (outcome !== 'COMPLETED') {
      // Money never left — credit it back via a REFUND entry.
      // withdrawal.amount is stored positive; the original ledger debit was
      // written as -withdrawal.amount at initiation.
      ledgerService.addEntry({
        userId: withdrawal.user_id,
        withdrawalId: withdrawal.id,
        type: 'REFUND',
        amount: withdrawal.amount, // positive = credit back
        note: `Refund: withdrawal ${withdrawal.id} ${outcome.toLowerCase()}`,
      });
    }

    updatedWithdrawal = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(withdrawalId);
  });

  doSettle();

  return updatedWithdrawal;
}

/**
 * Fetch all withdrawals for a user, newest first.
 *
 * @param {string} userId
 * @returns {object[]}
 */
function getWithdrawalsByUser(userId) {
  return db.prepare(`
    SELECT * FROM withdrawals
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId);
}

module.exports = {
  WITHDRAWAL_COOLDOWN_HOURS,
  initiateWithdrawal,
  settleWithdrawal,
  getLastCompletedWithdrawal,
  getWithdrawalsByUser,
};
