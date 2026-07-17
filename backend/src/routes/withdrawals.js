'use strict';

const { Router } = require('express');
const withdrawalService = require('../services/withdrawalService');

const router = Router();

/**
 * POST /api/withdrawals
 * Initiate a withdrawal for the user's full available balance.
 * Body: { userId }
 */
router.post('/', async (req, res, next) => {
  try {
    const { userId } = req.body;
    const withdrawal = withdrawalService.initiateWithdrawal(userId);
    res.status(201).json(withdrawal);
  } catch (err) {
    const msg = err.message.toLowerCase();
    // Known user-facing errors → 400
    if (msg.includes('no withdrawable balance') || msg.includes('hours remain') || msg.includes('cooldown')) {
      return res.status(400).json({ error: err.message });
    }
    // Unexpected errors → 500 via global handler
    next(err);
  }
});

/**
 * PATCH /api/withdrawals/:id/settle
 * Settle a withdrawal with a gateway outcome.
 * Body: { outcome: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'REJECTED' }
 */
router.patch('/:id/settle', async (req, res, next) => {
  try {
    const { outcome } = req.body;
    const withdrawal = withdrawalService.settleWithdrawal(req.params.id, outcome);
    res.json(withdrawal);
  } catch (err) {
    const msg = err.message.toLowerCase();
    if (msg.includes('not found')) {
      return res.status(404).json({ error: err.message });
    }
    if (msg.includes('already')) {
      return res.status(409).json({ error: err.message });
    }
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/withdrawals?userId=<id>
 * List all withdrawals for a user. userId query param is required.
 */
router.get('/', async (req, res, next) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ error: 'userId query parameter is required.' });
    }
    const withdrawals = withdrawalService.getWithdrawalsByUser(userId);
    res.json(withdrawals);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
