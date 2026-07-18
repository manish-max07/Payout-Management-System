/**
 * app.js — Payout Management System
 * Two-panel dashboard: Admin Console + User Phone View
 *
 * Sections:
 *   1.  Config & API helper
 *   2.  Shared state
 *   3.  Utility / formatting
 *   4.  Notification banner
 *   5.  Connectivity check
 *   6.  Tab navigation (phone)
 *   7.  Render — Admin: Pending & All Sales tables
 *   8.  Render — User: Balance hero
 *   9.  Render — User: Sale cards
 *  10.  Render — User: Withdrawals list
 *  11.  Render — User: Activity timeline (ledger)
 *  12.  refreshAll()
 *  13.  Event handlers — Admin Console
 *  14.  Event handlers — User Phone
 *  15.  Page bootstrap
 */

'use strict';

/* ============================================================
   1. Config & API helper
   ============================================================ */

// API_BASE_URL is set by js/config.js (auto-generated from env var).
// Fallback keeps local dev working even if config.js wasn't generated.
const API_BASE = window.API_BASE_URL || 'http://localhost:3000/api';

/**
 * Fetch wrapper. Throws Error with the backend's { error } message on non-2xx.
 * @param {'GET'|'POST'|'PATCH'|'DELETE'} method
 * @param {string} path  — e.g. '/sales'
 * @param {object} [body]
 * @returns {Promise<any>}
 */
async function apiCall(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res  = await fetch(`${API_BASE}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ============================================================
   2. Shared state
   ============================================================ */

const state = {
  userId:      '',
  balance:     0,
  sales:       [],
  withdrawals: [],
  ledger:      [],
};

/* ============================================================
   3. Utility / formatting
   ============================================================ */

const fmt = {
  currency: (v) => {
    const n = Number(v);
    if (isNaN(n)) return '₹—';
    return '₹' + Math.abs(n).toFixed(2);
  },
  signed: (v) => {
    const n = Number(v);
    if (isNaN(n)) return '—';
    return (n >= 0 ? '+₹' : '−₹') + Math.abs(n).toFixed(2);
  },
  date: (s) => {
    if (!s) return '—';
    const d = new Date(s.endsWith('Z') ? s : s + 'Z');
    return d.toLocaleString(undefined, {
      day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit',
    });
  },
  shortId: (id) => id ? id.slice(0, 8) + '…' : '—',
  esc: (s) => String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;'),
};

function badge(text, cls) {
  return `<span class="badge badge-${cls || text}">${fmt.esc(text)}</span>`;
}

/* ============================================================
   4. Notification banner
   ============================================================ */

let _notifTimer = null;

function showNotif(msg, type = 'error') {
  const banner = document.getElementById('notif-banner');
  const msgEl  = document.getElementById('notif-msg');
  msgEl.textContent = msg;
  banner.classList.remove('hidden');
  if (type === 'success') banner.style.background = 'rgba(16,185,129,.92)';
  else                    banner.style.background = 'rgba(239,68,68,.92)';
  clearTimeout(_notifTimer);
  _notifTimer = setTimeout(hideNotif, 5500);
}

function hideNotif() {
  document.getElementById('notif-banner').classList.add('hidden');
}

document.getElementById('notif-close').addEventListener('click', hideNotif);

/* ============================================================
   5. Connectivity check
   ============================================================ */

async function checkConnectivity() {
  const dot   = document.getElementById('connectivity-dot');
  const label = document.getElementById('connectivity-label');
  dot.className = 'connectivity-dot checking';
  label.textContent = 'checking…';
  try {
    await apiCall('GET', '/health');
    dot.className = 'connectivity-dot connected';
    label.textContent = 'connected';
  } catch {
    dot.className = 'connectivity-dot disconnected';
    label.textContent = 'unreachable';
    showNotif('Cannot reach backend — is `node server.js` running on port 3000?');
  }
}

/* ============================================================
   6. Tab navigation (phone)
   ============================================================ */

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('tab-active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('tab-active'));
    btn.classList.add('tab-active');
    document.getElementById(btn.dataset.tab).classList.add('tab-active');
  });
});

/* ============================================================
   7. Render — Admin: Pending & All Sales tables
   ============================================================ */

function renderPendingTable() {
  const pending = state.sales.filter(s => s.status === 'pending');
  const countEl = document.getElementById('pending-count');
  countEl.textContent = `${pending.length} in queue`;

  const tbody = document.getElementById('pending-tbody');
  if (!pending.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-cell">No pending sales — all caught up ✓</td></tr>`;
    return;
  }

  tbody.innerHTML = pending.map(s => `
    <tr>
      <td>${fmt.esc(s.brand)}</td>
      <td>${fmt.currency(s.earning)}</td>
      <td>${s.advance_paid ? `<span class="check-yes">✓ ${fmt.currency(s.advance_amount)}</span>` : '<span class="check-no">—</span>'}</td>
      <td>${fmt.date(s.created_at)}</td>
      <td>
        <div class="action-btns">
          <button class="btn btn-success" onclick="handleReconcile('${s.id}','approved',this)">
            <span class="btn-text">Approve</span>
          </button>
          <button class="btn btn-danger" onclick="handleReconcile('${s.id}','rejected',this)">
            <span class="btn-text">Reject</span>
          </button>
        </div>
      </td>
    </tr>
  `).join('');
}

function renderAllSalesTable() {
  const tbody = document.getElementById('all-sales-tbody');
  if (!state.sales.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-cell">No sales yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = state.sales.map(s => `
    <tr>
      <td>${fmt.esc(s.brand)}</td>
      <td>${fmt.currency(s.earning)}</td>
      <td>${badge(s.status)}</td>
      <td>${s.advance_paid ? `<span class="check-yes">✓ ${fmt.currency(s.advance_amount)}</span>` : '<span class="check-no">—</span>'}</td>
      <td>${fmt.date(s.created_at)}</td>
    </tr>
  `).join('');
}

/* ============================================================
   8. Render — User: Balance hero
   ============================================================ */

function renderBalance() {
  const amountEl = document.getElementById('balance-amount');
  const withdrawBtn = document.getElementById('btn-withdraw');

  const b = state.balance;
  amountEl.textContent = fmt.currency(b);
  amountEl.className = 'balance-amount ' + (b > 0 ? 'positive' : 'zero');

  if (b > 0) {
    withdrawBtn.textContent = `Withdraw ${fmt.currency(b)}`;
    withdrawBtn.disabled = false;
  } else {
    withdrawBtn.textContent = 'Withdraw ₹0.00';
    withdrawBtn.disabled = true;
  }
}

/* ============================================================
   9. Render — User: Sale cards
   ============================================================ */

function renderSaleCards() {
  const container = document.getElementById('user-sale-cards');
  if (!state.sales.length) {
    container.innerHTML = `<p class="phone-empty">No sales yet.</p>`;
    return;
  }
  container.innerHTML = state.sales.map(s => `
    <div class="sale-card">
      <div class="sale-card-left">
        <div class="sale-card-brand">${fmt.esc(s.brand)}</div>
        <div class="sale-card-earning">₹${Number(s.earning).toFixed(2)} earning</div>
      </div>
      ${badge(s.status)}
    </div>
  `).join('');
}

/* ============================================================
   10. Render — User: Withdrawals list
   ============================================================ */

function renderWithdrawals() {
  const container = document.getElementById('withdrawal-list');
  if (!state.withdrawals.length) {
    container.innerHTML = `<p class="phone-empty">No withdrawals yet.</p>`;
    return;
  }

  container.innerHTML = state.withdrawals.map(w => {
    const simButtons = w.status === 'PENDING' ? `
      <div class="simulate-btns">
        <span class="simulate-label">Simulate:</span>
        <button class="btn-sim sim-complete" onclick="handleSettle('${w.id}','COMPLETED',this)">Complete</button>
        <button class="btn-sim sim-fail"     onclick="handleSettle('${w.id}','FAILED',this)">Fail</button>
        <button class="btn-sim sim-cancel"   onclick="handleSettle('${w.id}','CANCELLED',this)">Cancel</button>
        <button class="btn-sim sim-reject"   onclick="handleSettle('${w.id}','REJECTED',this)">Reject</button>
      </div>` : '';

    return `
      <div class="withdrawal-item">
        <div class="withdrawal-item-top">
          <span class="withdrawal-amount">${fmt.currency(w.amount)}</span>
          ${badge(w.status)}
        </div>
        <div class="withdrawal-date">
          Initiated ${fmt.date(w.created_at)}
          ${w.settled_at ? ` · Settled ${fmt.date(w.settled_at)}` : ''}
        </div>
        ${simButtons}
      </div>
    `;
  }).join('');
}

/* ============================================================
   11. Render — User: Activity timeline (ledger)
   ============================================================ */

function renderActivity() {
  const container = document.getElementById('activity-timeline');
  if (!state.ledger.length) {
    container.innerHTML = `<p class="phone-empty">No activity yet.</p>`;
    return;
  }

  // Ledger comes oldest-first; reverse for newest-first display
  const entries = [...state.ledger].reverse();
  container.innerHTML = entries.map(e => {
    const n = Number(e.amount);
    const amtClass  = n >= 0 ? 'amount-positive' : 'amount-negative';
    const amtStr    = n >= 0 ? `+₹${n.toFixed(2)}` : `−₹${Math.abs(n).toFixed(2)}`;
    return `
      <div class="activity-item">
        <div class="activity-dot dot-${e.type}"></div>
        <div class="activity-body">
          <div class="activity-note" title="${fmt.esc(e.note || '')}">${fmt.esc(e.note || e.type)}</div>
          <div class="activity-date">${fmt.date(e.created_at)}</div>
        </div>
        <div class="activity-amount ${amtClass}">${amtStr}</div>
      </div>
    `;
  }).join('');
}

/* ============================================================
   12. refreshAll()
   Fetches everything for current user and re-renders both panels.
   ============================================================ */

async function refreshAll() {
  const userId = state.userId;
  if (!userId) return;

  try {
    const [balData, ledgerData, salesData, withdrawalData] = await Promise.all([
      apiCall('GET', `/users/${encodeURIComponent(userId)}/balance`),
      apiCall('GET', `/users/${encodeURIComponent(userId)}/ledger`),
      apiCall('GET', `/sales?userId=${encodeURIComponent(userId)}`),
      apiCall('GET', `/withdrawals?userId=${encodeURIComponent(userId)}`),
    ]);

    state.balance     = balData.balance ?? 0;
    state.ledger      = ledgerData.entries ?? [];
    state.sales       = salesData ?? [];
    state.withdrawals = withdrawalData ?? [];
  } catch (err) {
    showNotif(err.message);
    return;
  }

  // Re-render all panels
  renderBalance();
  renderPendingTable();
  renderAllSalesTable();
  renderSaleCards();
  renderWithdrawals();
  renderActivity();
}

/* ============================================================
   13. Event handlers — Admin Console
   ============================================================ */

/** Set a button into loading/disabled state, return a restore function */
function setLoading(btn, loadingText) {
  const orig = btn.querySelector('.btn-text')?.textContent ?? btn.textContent;
  btn.disabled = true;
  btn.classList.add('loading');
  if (btn.querySelector('.btn-text')) btn.querySelector('.btn-text').textContent = loadingText;
  else btn.textContent = loadingText;
  return () => {
    btn.disabled = false;
    btn.classList.remove('loading');
    if (btn.querySelector('.btn-text')) btn.querySelector('.btn-text').textContent = orig;
    else btn.textContent = orig;
  };
}

// Create sale
document.getElementById('btn-create-sale').addEventListener('click', async function () {
  const restore = setLoading(this, 'Creating…');
  const userId  = state.userId;
  const brand   = document.getElementById('sale-brand').value.trim();
  const earning = parseFloat(document.getElementById('sale-earning').value);
  const resultEl = document.getElementById('create-sale-result');

  try {
    const sale = await apiCall('POST', '/sales', { userId, brand, earning });
    resultEl.textContent = `✓ Sale created — ${sale.brand}, ₹${Number(sale.earning).toFixed(2)}`;
    resultEl.className = 'inline-result';
    hideNotif();
    await refreshAll();
  } catch (err) {
    resultEl.textContent = `✗ ${err.message}`;
    resultEl.className = 'inline-result error';
    showNotif(err.message);
  } finally {
    restore();
  }
});

// Run advance payout job
document.getElementById('btn-run-advance').addEventListener('click', async function () {
  const restore  = setLoading(this, 'Running…');
  const resultEl = document.getElementById('advance-job-result');

  try {
    const data = await apiCall('POST', '/payouts/advance/run');
    resultEl.textContent =
      `✓ Processed ${data.processedCount} sale${data.processedCount !== 1 ? 's' : ''} — ` +
      `₹${Number(data.totalAdvancePaid).toFixed(2)} advance paid`;
    resultEl.className = 'inline-result';
    hideNotif();
    await refreshAll();
  } catch (err) {
    resultEl.textContent = `✗ ${err.message}`;
    resultEl.className = 'inline-result error';
    showNotif(err.message);
  } finally {
    restore();
  }
});

// Reconcile (called from inline table buttons — must be on window)
window.handleReconcile = async function (saleId, status, btn) {
  const restore = setLoading(btn, status === 'approved' ? 'Approving…' : 'Rejecting…');
  // Also disable the sibling button to prevent double-action
  const sibling = btn.parentElement.querySelector(`.btn-${status === 'approved' ? 'danger' : 'success'}`);
  if (sibling) sibling.disabled = true;

  try {
    await apiCall('POST', `/sales/${saleId}/reconcile`, { status });
    hideNotif();
    await refreshAll();
  } catch (err) {
    showNotif(err.message);
    restore();
    if (sibling) sibling.disabled = false;
  }
  // No restore on success — the row disappears from the pending table
};

// Refresh sales button
document.getElementById('btn-refresh-sales').addEventListener('click', () => refreshAll());

/* ============================================================
   14. Event handlers — User Phone
   ============================================================ */

// Withdraw button
document.getElementById('btn-withdraw').addEventListener('click', async function () {
  const restore = setLoading(this, 'Initiating…');
  try {
    await apiCall('POST', '/withdrawals', { userId: state.userId });
    hideNotif();
    // Switch to withdrawals tab
    document.querySelector('[data-tab="tab-withdrawals"]').click();
    await refreshAll();
  } catch (err) {
    showNotif(err.message);
  } finally {
    restore();
  }
});

// Settle withdrawal (called from inline sim buttons — must be on window)
window.handleSettle = async function (withdrawalId, outcome, btn) {
  const labels = { COMPLETED:'Completing…', FAILED:'Failing…', CANCELLED:'Cancelling…', REJECTED:'Rejecting…' };
  btn.disabled = true;
  btn.textContent = labels[outcome] || '…';
  // Disable all sibling sim buttons for this withdrawal
  const parent = btn.closest('.withdrawal-item');
  parent.querySelectorAll('.btn-sim').forEach(b => b.disabled = true);

  try {
    await apiCall('PATCH', `/withdrawals/${withdrawalId}/settle`, { outcome });
    hideNotif();
    await refreshAll();
  } catch (err) {
    showNotif(err.message);
    // Re-enable on error
    parent.querySelectorAll('.btn-sim').forEach(b => b.disabled = false);
    btn.textContent = outcome.charAt(0) + outcome.slice(1).toLowerCase();
  }
};

// Refresh-all button in phone header
document.getElementById('btn-refresh-all').addEventListener('click', () => refreshAll());

/* ============================================================
   15. Page bootstrap
   ============================================================ */

// Shared user ID input drives everything
const userIdInput = document.getElementById('shared-user-id');

function onUserIdChange() {
  const val = userIdInput.value.trim();
  if (val && val !== state.userId) {
    state.userId = val;
    refreshAll();
  }
}

userIdInput.addEventListener('change', onUserIdChange);
userIdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') onUserIdChange(); });

document.addEventListener('DOMContentLoaded', async () => {
  state.userId = userIdInput.value.trim();
  await checkConnectivity();
  if (state.userId) await refreshAll();
});
