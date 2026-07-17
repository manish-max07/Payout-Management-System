'use strict';

const { Router } = require('express');
const payoutService = require('../services/payoutService');

const router = Router();

/**
 * POST /api/payouts/advance/run
 * Trigger the advance payout batch job.
 * Finds every pending, un-advanced sale and pays out 10% of each earning.
 * Safe to call multiple times — duplicate processing is blocked at the DB level.
 */
router.post('/advance/run', async (req, res, next) => {
  try {
    const result = payoutService.runAdvancePayoutJob();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
