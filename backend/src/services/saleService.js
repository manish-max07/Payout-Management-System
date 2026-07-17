'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../db');

// ---------------------------------------------------------------------------
// Idempotency via conditional WHERE clauses
//
// `markAdvancePaid` and `markReconciled` intentionally include extra conditions
// in their WHERE clauses beyond just `WHERE id = ?`. For example:
//
//   WHERE id = ? AND advance_paid = 0
//   WHERE id = ? AND status = 'pending'
//
// This means the UPDATE is a no-op if the row has already been processed.
// The caller can detect this by inspecting the returned `changes` count:
//   - changes === 1  → update applied successfully
//   - changes === 0  → row was already in the target state (double-processing
//                      attempt detected; caller should handle it as an error
//                      or a graceful no-op depending on context)
//
// This conditional WHERE pattern is the core idempotency mechanism for the
// entire system — it ensures that advance payouts and reconciliation can never
// be applied twice, even if a batch job or API call fires more than once.
// ---------------------------------------------------------------------------

/**
 * Ensure a user row exists (no-op if already present).
 * Sales require a valid user_id FK, so we create a stub row if needed.
 *
 * @param {string} userId
 */
function ensureUserExists(userId) {
  db.prepare('INSERT OR IGNORE INTO users (id) VALUES (?)').run(userId);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new sale for a user.
 *
 * @param {object} params
 * @param {string} params.userId  - ID of the user who made the sale.
 * @param {string} params.brand   - Brand name associated with the sale.
 * @param {number} params.earning - Gross earning amount (must be > 0).
 * @returns {object} The newly created sale row.
 */
function createSale({ userId, brand, earning }) {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new Error('userId must be a non-empty string.');
  }
  if (typeof brand !== 'string' || brand.trim() === '') {
    throw new Error('brand must be a non-empty string.');
  }
  if (typeof earning !== 'number' || !isFinite(earning) || earning <= 0) {
    throw new Error('earning must be a positive number.');
  }

  ensureUserExists(userId);

  const id = uuidv4();

  db.prepare(`
    INSERT INTO sales (id, user_id, brand, earning, status, advance_paid, advance_amount, created_at)
    VALUES (?, ?, ?, ?, 'pending', 0, 0, datetime('now'))
  `).run(id, userId, brand, earning);

  return db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
}

/**
 * Fetch a single sale by its id.
 *
 * @param {string} saleId
 * @returns {object|null} The sale row, or null if not found.
 */
function getSaleById(saleId) {
  return db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId) ?? null;
}

/**
 * Fetch all sales belonging to a user, newest first.
 *
 * @param {string} userId
 * @returns {object[]}
 */
function getSalesByUser(userId) {
  return db.prepare(`
    SELECT * FROM sales
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId);
}

/**
 * Fetch every sale in the system, newest first.
 * Intended for admin/overview views.
 *
 * @returns {object[]}
 */
function getAllSales() {
  return db.prepare('SELECT * FROM sales ORDER BY created_at DESC').all();
}

/**
 * Fetch all sales that are still pending AND have not yet had an advance paid.
 * This is the exact query used by the advance-payout batch job to find eligible
 * sales for the current run.
 *
 * @returns {object[]}
 */
function getPendingUnadvancedSales() {
  return db.prepare(`
    SELECT * FROM sales
    WHERE status = 'pending'
      AND advance_paid = 0
  `).all();
}

/**
 * Mark a sale as having had an advance payout issued.
 *
 * The WHERE clause includes `AND advance_paid = 0` as a safety guard — if this
 * function is called twice for the same sale, the second call will match no
 * rows and return changes = 0, letting the caller detect the double-processing
 * attempt. See the idempotency note at the top of this file.
 *
 * @param {string} saleId
 * @param {number} advanceAmount - The advance amount that was paid out.
 * @returns {number} Number of rows changed (1 = success, 0 = already advanced).
 */
function markAdvancePaid(saleId, advanceAmount) {
  const result = db.prepare(`
    UPDATE sales
    SET advance_paid = 1,
        advance_amount = ?
    WHERE id = ?
      AND advance_paid = 0
  `).run(advanceAmount, saleId);

  return result.changes;
}

/**
 * Reconcile (approve or reject) a sale.
 *
 * The WHERE clause includes `AND status = 'pending'` as a guard — only a sale
 * that is currently pending can be reconciled. If called on an already-approved
 * or already-rejected sale, changes = 0 is returned so the caller can surface
 * an appropriate error. See the idempotency note at the top of this file.
 *
 * @param {string} saleId
 * @param {'approved'|'rejected'} newStatus
 * @returns {number} Number of rows changed (1 = success, 0 = already reconciled).
 */
function markReconciled(saleId, newStatus) {
  if (newStatus !== 'approved' && newStatus !== 'rejected') {
    throw new Error(
      `Invalid status "${newStatus}". Must be "approved" or "rejected".`
    );
  }

  const result = db.prepare(`
    UPDATE sales
    SET status = ?,
        reconciled_at = datetime('now')
    WHERE id = ?
      AND status = 'pending'
  `).run(newStatus, saleId);

  return result.changes;
}

module.exports = {
  createSale,
  getSaleById,
  getSalesByUser,
  getAllSales,
  getPendingUnadvancedSales,
  markAdvancePaid,
  markReconciled,
};
