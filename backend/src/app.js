'use strict';

const express = require('express');
const cors = require('cors');

const usersRouter = require('./routes/users');
const salesRouter = require('./routes/sales');
const payoutsRouter = require('./routes/payouts');
const withdrawalsRouter = require('./routes/withdrawals');

const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(cors()); // Allow all origins — fine for local dev / this assignment
app.use(express.json());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.use('/api/users', usersRouter);
app.use('/api/sales', salesRouter);
app.use('/api/payouts', payoutsRouter);
app.use('/api/withdrawals', withdrawalsRouter);

/**
 * GET /api/health
 * Simple liveness probe — useful for the frontend to check connectivity
 * before making data requests.
 */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// Global error-handling middleware
// Must be registered LAST and must have exactly four parameters so Express
// recognises it as an error handler.
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[Error] ${err.message}`);
  if (res.headersSent) {
    // If headers were already sent (e.g. streaming), delegate to the default
    // Express finalhandler to close the connection cleanly.
    return next(err);
  }
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// Export the app without calling listen() here so it can be imported and
// tested independently with supertest or similar tools.
module.exports = app;
