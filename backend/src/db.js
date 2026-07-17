/**
 * Database connection and schema for the Payout Management System.
 *
 * Balance semantics:
 *   - Amounts in `ledger_entries` are SIGNED:
 *       positive  → credit  (money added to the user's balance)
 *       negative  → debit   (money taken from the user's balance)
 *   - A user's current withdrawable balance is always computed on-the-fly as
 *       SELECT SUM(amount) FROM ledger_entries WHERE user_id = ?
 *     It is NEVER stored as a separate mutable field on the user record.
 *     This is intentional: it ensures full auditability and prevents
 *     balance-drift bugs that arise from updating a cached balance column.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// ---------------------------------------------------------------------------
// Resolve the database file path.
// DB_PATH env var lets tests (or CI) point at a separate database file
// without touching the real production data.
// Default: backend/data/payout.db (relative to this file's location).
// ---------------------------------------------------------------------------
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'payout.db');
const dataDir = path.dirname(dbPath);

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);

// ---------------------------------------------------------------------------
// PRAGMAs
// ---------------------------------------------------------------------------
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Schema
//
// Creation order matters: tables must exist before they can be referenced by
// a foreign key in another table.
//   1. users          – no dependencies
//   2. withdrawals    – references users
//   3. sales          – references users
//   4. ledger_entries – references users, sales, and withdrawals
// ---------------------------------------------------------------------------
db.exec(`
  -- 1. users
  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    name       TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- 2. withdrawals
  CREATE TABLE IF NOT EXISTS withdrawals (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id),
    amount     REAL NOT NULL,
    status     TEXT NOT NULL DEFAULT 'PENDING'
                 CHECK(status IN ('PENDING','COMPLETED','FAILED','CANCELLED','REJECTED')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    settled_at TEXT
  );

  -- 3. sales
  CREATE TABLE IF NOT EXISTS sales (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id),
    brand          TEXT NOT NULL,
    earning        REAL NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending'
                     CHECK(status IN ('pending','approved','rejected')),
    advance_paid   INTEGER NOT NULL DEFAULT 0,
    advance_amount REAL    NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reconciled_at  TEXT
  );

  -- 4. ledger_entries
  CREATE TABLE IF NOT EXISTS ledger_entries (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id),
    sale_id       TEXT REFERENCES sales(id),
    withdrawal_id TEXT REFERENCES withdrawals(id),
    type          TEXT NOT NULL
                    CHECK(type IN ('ADVANCE','FINAL_ADJUSTMENT','WITHDRAWAL','REFUND')),
    amount        REAL NOT NULL,
    note          TEXT,
    created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_sales_user_status
    ON sales(user_id, status);

  CREATE INDEX IF NOT EXISTS idx_ledger_user
    ON ledger_entries(user_id);

  CREATE INDEX IF NOT EXISTS idx_withdrawals_user_status
    ON withdrawals(user_id, status);
`);

module.exports = db;
