'use strict';

const { Router } = require('express');
const ledgerService = require('../services/ledgerService');

const router = Router();

/**
 * GET /api/users/:userId/balance
 * Returns the current ledger balance for a user.
 */
router.get('/:userId/balance', async (req, res, next) => {
  try {
    const { userId } = req.params;
    const balance = ledgerService.getBalance(userId);
    res.json({ userId, balance });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/users/:userId/ledger
 * Returns all ledger entries for a user, oldest first.
 */
router.get('/:userId/ledger', async (req, res, next) => {
  try {
    const { userId } = req.params;
    const entries = ledgerService.getLedgerForUser(userId);
    res.json({ userId, entries });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
