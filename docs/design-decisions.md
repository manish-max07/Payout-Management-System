# Design Decisions — User Payout Management System

---

### 1. Append-Only Ledger Instead of a Mutable Balance Column

**Decision:** User balances are not stored anywhere. Every credit/debit is an immutable row in `ledger_entries`. Balance is computed on demand as `SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE user_id = ?` (see `ledgerService.getBalance()`).

**Reasoning:**
- **Auditability by construction:** the full transaction history of every user is available as a sorted sequence of ledger rows. There is no way to alter a past balance without leaving a trace.
- **No balance-drift bugs:** a mutable `users.balance` column requires every code path that touches money to also atomically update the balance field. Missing one update (e.g. in an error path) causes silent drift. With an append-only ledger, the balance is always exactly the sum of what actually happened — it cannot drift.
- **Natural history display:** the frontend ledger table (`GET /api/users/:userId/ledger`) is a direct render of the raw rows — no extra history tables needed.

**Trade-off:** Balance is O(n) to compute where n = number of ledger entries for that user, versus O(1) for a cached column. At the scale of this assignment this is negligible. At production scale (millions of entries per user), the mitigation is a **materialised/cached balance** — a separate `user_balances` table updated inside the same transaction as each `ledger_entries` insert. The append-only ledger remains the source of truth; the cached balance is a read-optimisation that must be invalidated (or recomputed) on every ledger write.

---

### 2. Conditional WHERE-Clause Idempotency Instead of Application-Level Locks

**Decision:** Guarded updates use a conditional `WHERE` clause that matches only when the row is in the expected pre-state:

```sql
-- saleService.markAdvancePaid
UPDATE sales SET advance_paid=1, advance_amount=?
WHERE id = ? AND advance_paid = 0

-- saleService.markReconciled
UPDATE sales SET status=?, reconciled_at=datetime('now')
WHERE id = ? AND status = 'pending'

-- withdrawalService.settleWithdrawal
UPDATE withdrawals SET status=?, settled_at=datetime('now')
WHERE id = ? AND status = 'PENDING'
```

The caller receives `result.changes` and treats `0` as a conflict/no-op signal.

**Reasoning:** `better-sqlite3` is synchronous and SQLite serialises all writers. There is no interleaving within a `db.transaction()` block — the transaction is atomic by definition. Two concurrent Express requests that race to advance the same sale will be serialised by SQLite; one succeeds (`changes=1`), the other is a no-op (`changes=0`). No external lock service or mutex is needed.

**Trade-off:** This pattern relies on SQLite's single-writer model. A migration to **multi-instance deployment against PostgreSQL** would require a different strategy:
- A `UNIQUE` partial index (e.g. `CREATE UNIQUE INDEX … ON ledger_entries(sale_id) WHERE type='ADVANCE'`) to enforce at the DB level that only one ADVANCE entry can exist per sale.
- Or `SELECT … FOR UPDATE` row-level locking inside a transaction to hold the lock while checking the current state before writing.
- The conditional-WHERE pattern itself still works in Postgres, but without SQLite's single-writer guarantee, two concurrent transactions could both read `advance_paid=0` before either has committed — making the DB-level constraint the true guard.

---

### 3. Optimistic Debit on Withdrawal Initiation

**Decision:** When a withdrawal is initiated, the ledger is debited immediately (a `WITHDRAWAL` entry with `amount = -balance` is written). The money is only credited back if settlement fails (a `REFUND` entry is written). A `COMPLETED` settlement requires no ledger action.

**Reasoning:**
- **Models real payment gateway UX:** in a real integration, funds are "reserved" or "sent" at initiation time. The gateway reports success or failure asynchronously. Debiting immediately means the user's displayed balance drops to zero the moment they initiate — preventing confusion about whether the money is still available.
- **Prevents double-withdrawal:** without the immediate debit, a user could call `POST /api/withdrawals` twice in rapid succession before either is settled, both seeing `balance=80` and both passing the balance check. The optimistic debit means the second call sees `balance=0` and is correctly rejected.

**Trade-off:** If a withdrawal is stuck in `PENDING` indefinitely (e.g. the payment gateway never calls back), the user's balance is locked at zero with no recourse. In production, this requires a **timeout/reconciliation job** that transitions stale `PENDING` withdrawals to `FAILED` (triggering a `REFUND` entry) after a configurable deadline. This job is outside the scope of this assignment.

---

### 4. 24-Hour Cooldown Keyed Off Last COMPLETED Withdrawal Only

**Decision:** The cooldown check in `withdrawalService.getLastCompletedWithdrawal()` queries `WHERE status = 'COMPLETED'` — `FAILED`, `CANCELLED`, and `REJECTED` withdrawals do not count toward the cooldown.

**Reasoning:** The assignment contains a deliberate tension between two of its own rules:
- **Rule 3:** "A user can only make one withdrawal every 24 hours."
- **Question 2 (edge case):** "What happens if a withdrawal fails? … Allow the user to initiate another withdrawal for that amount."

These rules are only simultaneously satisfiable if "one withdrawal every 24 hours" is interpreted as "one *successful* (COMPLETED) withdrawal every 24 hours." Counting a failed withdrawal toward the cooldown would directly contradict Question 2. Counting only `COMPLETED` withdrawals resolves both rules without contradiction:
- Rule 3 is satisfied: a user cannot successfully withdraw more than once per 24 hours.
- Question 2 is satisfied: a failed withdrawal leaves the cooldown timer untouched; the user can retry immediately.

This interpretation is documented in `withdrawalService.getLastCompletedWithdrawal()` with an inline comment.

---

### 5. SQLite via `better-sqlite3` Instead of PostgreSQL/MySQL

**Decision:** The database is SQLite, accessed via the synchronous `better-sqlite3` driver. The database file lives at `backend/data/payout.db` (configurable via `DB_PATH` environment variable for tests).

**Reasoning:**
- **Zero setup:** a reviewer can clone the repository and run `npm install && node server.js` with no external database process to start.
- **Synchronous API simplifies transaction reasoning:** `better-sqlite3`'s synchronous `db.transaction()` means transaction logic is written as ordinary sequential code — no `async/await` chains, no callback-based commit/rollback.
- **Sufficient for assignment scope:** the system is single-instance, single-process. SQLite's single-writer model is a feature, not a limitation, at this scale — it makes the idempotency pattern in Decision 2 trivially correct.

**Trade-off:** SQLite is not horizontally scalable. A production deployment would migrate to **PostgreSQL** with:
- A connection pool (`pg-pool` or Prisma/Drizzle ORM).
- Async transaction management (`BEGIN … COMMIT` in an async context).
- Row-level locking or unique constraints to replace the SQLite single-writer idempotency guarantee (see Decision 2).
- The `DB_PATH` environment variable convention would be replaced by a `DATABASE_URL` connection string.

The schema and service interfaces are designed to be database-agnostic enough that this migration would require changes only in `db.js` and the raw SQL strings — the service API contracts would not change.

---

### 6. Advance Payout as a Triggered Batch Job Rather Than Synchronous on Sale Creation

**Decision:** The advance payout is not paid when a sale is created. It is paid by explicitly calling `POST /api/payouts/advance/run`, which processes all eligible sales in one batch via `payoutService.runAdvancePayoutJob()`.

**Reasoning:**
- **Assignment language implies a batch model:** the assignment describes the advance job as something that "runs" (implying a discrete trigger), not as a side-effect of creating a sale. Implementing it as a batch job matches this framing.
- **Idempotency is demonstrable:** because the job is a separate, explicitly triggered action, its idempotency property (safe to run multiple times — the `WHERE advance_paid=0` guard ensures no sale is advanced twice) is both testable in isolation (tests 3–6 in `payoutSystem.test.js`) and demonstrable live in the frontend dashboard.
- **Separation of concerns:** sale creation and advance payment are distinct business events. Decoupling them means the advance percentage or batch eligibility criteria can change without touching `saleService.createSale()`.

**Trade-off:** In a real deployment, the batch job would be triggered by a scheduler (cron, BullMQ, etc.) rather than a manual HTTP call. The HTTP endpoint (`POST /api/payouts/advance/run`) exists to make the batch job inspectable and triggerable during development and review — it would be protected by admin authentication in production. The core job logic (`runAdvancePayoutJob()`) is already written as a pure function with no HTTP coupling, so wiring it to a scheduler requires only adding a scheduler call alongside the existing route.
