/**
 * ledgerService.js
 *
 * DESIGN PRINCIPLE — SINGLE WRITER:
 * This file is the ONLY place in the codebase allowed to write to the
 * `ledger_entries` table. All other services (payoutService, withdrawalService,
 * etc.) MUST call `addEntry()` rather than inserting into the table directly.
 *
 * Why? Keeping all ledger writes funnelled through one module means:
 *  - Accounting logic is centralized and auditable. If there is ever a bug in
 *    a balance calculation, there is exactly one file to check.
 *  - Validation (allowed entry types, required fields) is applied consistently
 *    on every write, with no risk of a caller bypassing it.
 *  - Tracing a balance discrepancy is straightforward — the entire financial
 *    history of any user is built exclusively from rows that passed through
 *    `addEntry()`.
 *
 * This file deliberately knows nothing about advance-payout percentages,
 * reconciliation rules, or sale/withdrawal business logic. It only knows about
 * ledger entries and balances.
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const ALLOWED_TYPES = ['ADVANCE', 'FINAL_ADJUSTMENT', 'WITHDRAWAL', 'REFUND'];

/**
 * Insert a new ledger entry and return the persisted row.
 *
 * @param {object} params
 * @param {string} params.userId        - The user this entry belongs to.
 * @param {string|null} [params.saleId]       - Related sale id (optional).
 * @param {string|null} [params.withdrawalId] - Related withdrawal id (optional).
 * @param {string} params.type          - One of ADVANCE | FINAL_ADJUSTMENT | WITHDRAWAL | REFUND.
 * @param {number} params.amount        - Signed amount: positive = credit, negative = debit.
 * @param {string|null} [params.note]   - Human-readable note (optional).
 * @returns {object} The inserted ledger entry row.
 */
function addEntry({ userId, saleId = null, withdrawalId = null, type, amount, note = null }) {
  if (!ALLOWED_TYPES.includes(type)) {
    throw new Error(
      `Invalid ledger entry type "${type}". Allowed values are: ${ALLOWED_TYPES.join(', ')}.`
    );
  }

  const id = uuidv4();

  // Ensure a user row exists — ledger_entries.user_id has a FK to users(id).
  // Using INSERT OR IGNORE means we never overwrite an existing user record,
  // and callers don't need to manually create a user before writing ledger entries.
  db.prepare('INSERT OR IGNORE INTO users (id) VALUES (?)').run(userId);

  db.prepare(`
    INSERT INTO ledger_entries (id, user_id, sale_id, withdrawal_id, type, amount, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(id, userId, saleId, withdrawalId, type, amount, note);

  const row = db.prepare(`
    SELECT * FROM ledger_entries WHERE id = ?
  `).get(id);

  return row;
}

/**
 * Return the current balance for a user as a number rounded to 2 decimal
 * places (to avoid floating-point accumulation artefacts).
 *
 * @param {string} userId
 * @returns {number}
 */
function getBalance(userId) {
  const { balance } = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS balance
    FROM ledger_entries
    WHERE user_id = ?
  `).get(userId);

  return Math.round(balance * 100) / 100;
}

/**
 * Return all ledger entries for a user, oldest first.
 *
 * @param {string} userId
 * @returns {object[]}
 */
function getLedgerForUser(userId) {
  return db.prepare(`
    SELECT *
    FROM ledger_entries
    WHERE user_id = ?
    ORDER BY created_at ASC
  `).all(userId);
}

/**
 * Check whether an ADVANCE entry has already been recorded for a given sale.
 *
 * Belt-and-braces defensive check: the canonical source of truth for "was an
 * advance already paid?" is the ledger itself, NOT just the `sales.advance_paid`
 * boolean flag. A flag can drift from reality (e.g. if a write to one table
 * succeeds but a write to another fails), whereas the ledger only contains rows
 * that were actually written via `addEntry()`. Callers should treat a `true`
 * return from this function as a hard veto against issuing a duplicate advance.
 *
 * @param {string} saleId
 * @returns {boolean}
 */
function hasAdvanceBeenPaid(saleId) {
  const { count } = db.prepare(`
    SELECT COUNT(*) AS count
    FROM ledger_entries
    WHERE sale_id = ?
      AND type = 'ADVANCE'
  `).get(saleId);

  return count > 0;
}

module.exports = { addEntry, getBalance, getLedgerForUser, hasAdvanceBeenPaid };
