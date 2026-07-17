'use strict';

const { Router } = require('express');
const saleService = require('../services/saleService');
const payoutService = require('../services/payoutService');

const router = Router();

/**
 * POST /api/sales
 * Create a new sale.
 * Body: { userId, brand, earning }
 */
router.post('/', async (req, res, next) => {
  try {
    const { userId, brand, earning } = req.body;
    const sale = saleService.createSale({ userId, brand, earning });
    res.status(201).json(sale);
  } catch (err) {
    // Validation errors thrown by the service → 400
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/sales
 * List all sales, or filter by user with ?userId=<id>.
 */
router.get('/', async (req, res, next) => {
  try {
    const { userId } = req.query;
    const sales = userId
      ? saleService.getSalesByUser(userId)
      : saleService.getAllSales();
    res.json(sales);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sales/:id
 * Fetch a single sale by id.
 */
router.get('/:id', async (req, res, next) => {
  try {
    const sale = saleService.getSaleById(req.params.id);
    if (!sale) {
      return res.status(404).json({ error: 'Sale not found' });
    }
    res.json(sale);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/sales/:id/reconcile
 * Approve or reject a sale and write the final adjustment ledger entry.
 * Body: { status: 'approved' | 'rejected' }
 */
router.post('/:id/reconcile', async (req, res, next) => {
  try {
    const { status } = req.body;
    const result = payoutService.reconcileSale(req.params.id, status);
    res.json(result);
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

module.exports = router;
