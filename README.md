# Payout Management System

A ledger-based affiliate payout system implementing advance payouts, sale reconciliation, and withdrawal management. This is my submission for the Faym SDE Intern assignment.

---

## Live Demo

| | URL |
|---|---|
| **Frontend Dashboard** | [https://payout-management-system-rz4o.vercel.app/](https://payout-management-system-rz4o.vercel.app/) |
| **Backend API** | [https://payout-management-system-8tnq.onrender.com/api](https://payout-management-system-8tnq.onrender.com/api) |

> **Note:** the backend is hosted on Render's free tier, which spins down after ~15 minutes of inactivity. The first request after idle may take 20-30 seconds to wake up. The free tier also doesn't support persistent disks, so the database resets on redeploys/restarts. For guaranteed persistent data, run locally following the setup instructions below.

---

## About This Project

This is my submission for Faym's SDE Intern assignment. I implemented a **User Payout Management System** covering advance payouts, reconciliation, ledger-based accounting, a 24-hour withdrawal cooldown, and failed-payout recovery, as per the assignment's LLD/system-design brief.

Domain context: *sales* represent purchases made through a creator's affiliate link. *Reconciliation* reflects whether the order survived the brand's return window. Approved means the payout stands; rejected means the advance is clawed back.

---

## Note on the Frontend

The assignment only required a working backend with API endpoints. No frontend was requested. I built one anyway as a testing and demo convenience.

I designed it as **two side-by-side panels** that reflect the two real actors in the system:

- **Admin Console** (left panel) - create test sales, trigger the advance payout job, approve or reject pending sales.
- **User App** (right panel) - a phone-styled view showing the creator's live balance, sales list, withdrawal history, and full ledger activity feed.

Actions on the admin side update the user side live, since both panels read from the same backend state. It is a functional testing harness, not a production UI.

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Backend runtime** | Node.js |
| **Backend framework** | Express 5 |
| **Database** | better-sqlite3 (SQLite, synchronous API) |
| **Tests** | Jest |
| **Frontend** | Vanilla HTML / CSS / JS, no framework, no build step |
| **Fonts** | Google Fonts (Space Grotesk + Inter) |
| **Frontend deploy** | Vercel |
| **Backend deploy** | Render |

---

## Project Structure

```
payout-management-system/
├── backend/
│   ├── src/
│   │   ├── db.js                  # SQLite schema + connection
│   │   ├── services/
│   │   │   ├── ledgerService.js   # Append-only ledger, balance computation
│   │   │   ├── saleService.js     # Sales CRUD + idempotency guards
│   │   │   ├── payoutService.js   # Advance math, reconciliation math
│   │   │   └── withdrawalService.js # Withdrawal lifecycle, cooldown
│   │   ├── routes/
│   │   │   ├── users.js
│   │   │   ├── sales.js
│   │   │   ├── payouts.js
│   │   │   └── withdrawals.js
│   │   └── app.js                 # Express app (no listen, testable separately)
│   ├── tests/
│   │   ├── setup.js               # Test DB isolation
│   │   └── payoutSystem.test.js   # 20 Jest tests
│   └── server.js                  # Entry point
├── frontend/
│   ├── index.html
│   ├── css/style.css
│   ├── js/
│   │   ├── app.js
│   │   ├── config.js              # Auto-generated (gitignored)
│   │   └── config.example.js
│   ├── scripts/generate-config.js
│   ├── package.json
│   └── vercel.json
└── docs/
    ├── LLD.md
    ├── schema.md
    └── design-decisions.md
```

---

## Business Rules Implemented

- **Advance payout (10%)** - a batch job credits 10% of each pending sale's earning as an advance. Idempotent: running the job repeatedly never double-pays a sale (`WHERE advance_paid = 0` guard at the database level).
- **Reconciliation math** - when a sale is approved, the seller receives the remaining balance (`earning - advance`). When rejected, the advance is clawed back. Both outcomes are written as immutable `FINAL_ADJUSTMENT` ledger entries.
- **24-hour withdrawal cooldown** - keyed off the last **completed** withdrawal only. A withdrawal that failed, was cancelled, or was rejected never moved real money, so it does not reset the cooldown clock.
- **Failed/cancelled/rejected payout recovery** - if a withdrawal settles as anything other than `COMPLETED`, a `REFUND` ledger entry immediately credits the full amount back. The user can re-initiate a withdrawal straight away, with no cooldown penalty for a payout that never actually completed.

---

## Local Setup

```bash
# 1. Clone the repository
git clone https://github.com/manish-max07/payout-management-system.git
cd payout-management-system
```

```bash
# 2. Install backend dependencies
cd backend
npm install
```

```bash
# 3. Start the backend (runs on http://localhost:3000)
node server.js
```

```bash
# 4. Configure the frontend API URL
cd ../frontend
cp js/config.example.js js/config.js
# config.js defaults to http://localhost:3000/api, no edits needed for local dev
```

```bash
# 5. Serve the frontend (any static server works)
npx serve -p 5500 .
# or: python -m http.server 5500
# then open http://localhost:5500 in your browser
```

```bash
# 6. Run the test suite
cd backend
npm test
```

---

## API Reference

| Method | Path | Body | Description |
|---|---|---|---|
| `GET` | `/api/health` | - | Liveness check -> `{ status: 'ok' }` |
| `GET` | `/api/users/:userId/balance` | - | Current ledger balance for a user |
| `GET` | `/api/users/:userId/ledger` | - | All ledger entries for a user, oldest first |
| `POST` | `/api/sales` | `{ userId, brand, earning }` | Create a new sale (status=pending) |
| `GET` | `/api/sales` | `?userId=` (optional) | List sales, all or filtered by user |
| `GET` | `/api/sales/:id` | - | Fetch a single sale |
| `POST` | `/api/sales/:id/reconcile` | `{ status: 'approved'\|'rejected' }` | Reconcile a pending sale; writes FINAL_ADJUSTMENT ledger entry |
| `POST` | `/api/payouts/advance/run` | - | Run advance payout batch job (idempotent) |
| `POST` | `/api/withdrawals` | `{ userId }` | Initiate withdrawal for full balance; debits ledger immediately |
| `PATCH` | `/api/withdrawals/:id/settle` | `{ outcome: 'COMPLETED'\|'FAILED'\|'CANCELLED'\|'REJECTED' }` | Settle a pending withdrawal; refunds ledger if not COMPLETED |
| `GET` | `/api/withdrawals` | `?userId=` (required) | List withdrawals for a user |

---

## Worked Example (matches assignment spec)

Reproduces the assignment's own numbers: 3 sales x Rs.40 earning, one rejected, two approved.

```bash
# Create 3 sales (run this command 3 times, save the returned "id" values)
curl -s -X POST http://localhost:3000/api/sales \
  -H "Content-Type: application/json" \
  -d '{"userId":"john_doe","brand":"brand_1","earning":40}'

# Run the advance payout job (10% x 3 x Rs.40 = Rs.12 total advance)
curl -s -X POST http://localhost:3000/api/payouts/advance/run
# -> { "processedCount": 3, "totalAdvancePaid": 12, ... }

# Reconcile: sale 1 rejected, sales 2 & 3 approved
curl -s -X POST http://localhost:3000/api/sales/$SALE1/reconcile \
  -H "Content-Type: application/json" -d '{"status":"rejected"}'

curl -s -X POST http://localhost:3000/api/sales/$SALE2/reconcile \
  -H "Content-Type: application/json" -d '{"status":"approved"}'

curl -s -X POST http://localhost:3000/api/sales/$SALE3/reconcile \
  -H "Content-Type: application/json" -d '{"status":"approved"}'

# Check final balance
curl -s http://localhost:3000/api/users/john_doe/balance
# -> { "userId": "john_doe", "balance": 80 }
```

**Two numbers to understand:**

| Figure | Value | What it represents |
|---|---|---|
| Sum of `FINAL_ADJUSTMENT` entries | **Rs.68** | The assignment's stated "Final Payout": -4 (rejected) + 36 (approved) + 36 (approved) |
| Total ledger balance | **Rs.80** | The actual withdrawable amount: Rs.12 advance + Rs.68 adjustments |

> The assignment's "Rs.68" refers to the net reconciliation adjustments only, not the total spendable balance (which also includes the Rs.12 already credited as advances). See [docs/LLD.md section 7](docs/LLD.md) for a full breakdown.

---

## Documentation

| Document | Description |
|---|---|
| [docs/LLD.md](docs/LLD.md) | Low-Level Design: module responsibilities, key workflows, sequence diagram, idempotency explanation, terminology clarification |
| [docs/schema.md](docs/schema.md) | Database schema: all four tables with column types and constraints, ER diagram, index rationale |
| [docs/design-decisions.md](docs/design-decisions.md) | 8 annotated design decisions with reasoning and trade-offs (append-only ledger, SQLite choice, optimistic debit, cooldown logic, and more) |

---

## Testing

I wrote 20 Jest tests covering the full business-logic surface:

- Ledger balance computation
- Advance payout idempotency (running the job twice never double-pays a sale)
- Reconciliation math, including the exact assignment worked example (3 x Rs.40, Rs.68 adjustments, Rs.80 balance)
- Withdrawal initiation and optimistic debit
- Settlement outcomes: completed, failed (with refund), cancelled, rejected
- 24-hour cooldown enforcement
- **Failed-payout recovery**: after a `FAILED` withdrawal, the user can immediately withdraw again with no cooldown penalty
- Error cases: non-existent sale, already-reconciled sale, zero balance withdrawal, settling an already-settled withdrawal

```bash
cd backend
npm test
```

```
Test Suites: 1 passed, 1 total
Tests:       20 passed, 20 total
```

---

## Author

I'm Manish Kumar. I built this project as my submission for the Faym SDE Intern assignment.
