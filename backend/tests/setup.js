'use strict';

/**
 * setup.js — Test environment bootstrap for the Payout Management System.
 *
 * IMPORTANT: This file must be require()'d as the very first line in any test
 * file, BEFORE any service modules are loaded. This ensures DB_PATH is set
 * before better-sqlite3 opens the database file (db.js reads DB_PATH at
 * require-time, and Node's module cache means it only runs once per process).
 */

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Point all DB operations at the test database BEFORE db.js is loaded.
// ---------------------------------------------------------------------------
const TEST_DB_PATH = path.join(__dirname, 'test-data', 'test-payout.db');
process.env.DB_PATH = TEST_DB_PATH;

// Ensure the test-data directory exists.
fs.mkdirSync(path.dirname(TEST_DB_PATH), { recursive: true });

// Now it's safe to load db.js — it will open (or create) the test database.
const db = require('../src/db');

// ---------------------------------------------------------------------------
// resetDb — wipe all rows between tests.
//
// We DELETE rather than drop/recreate the file because Node's module cache
// keeps the better-sqlite3 connection open for the lifetime of the process.
// Deleting the file would leave db.js pointing at a now-gone file handle.
// Truncating via DELETE preserves the open connection and the schema while
// giving each test a clean slate.
//
// Deletion order must respect FK constraints (children before parents):
//   ledger_entries → withdrawals → sales → users
// ---------------------------------------------------------------------------
function resetDb() {
  db.exec(`
    DELETE FROM ledger_entries;
    DELETE FROM withdrawals;
    DELETE FROM sales;
    DELETE FROM users;
  `);
}

module.exports = { db, resetDb };
