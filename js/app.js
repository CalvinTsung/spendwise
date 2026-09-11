/* ================================================================
 * SpendWise - Daily Expense Tracker
 * Features: expense logging, necessary vs discretionary split,
 *           monthly spending limit, remaining budget, Excel export.
 * Data: persisted in localStorage (this browser only).
 * ================================================================ */
'use strict';

/* ---------- Constants ---------- */
const $ = (sel) => document.querySelector(sel);

const STORE_KEY = 'daily-ledger.v1';
const NEED = 'necessary';
const WANT = 'optional';
const TYPE_LABEL = { [NEED]: 'Necessary', [WANT]: 'Discretionary' };
const CURRENCY = '$';

const CATEGORIES = {
  [NEED]: ['Groceries & Food', 'Housing / Rent', 'Utilities', 'Transport', 'Healthcare', 'Education', 'Insurance', 'Family & Home', 'Phone & Internet', 'Other'],
  [WANT]: ['Dining Out', 'Entertainment', 'Shopping', 'Drinks & Snacks', 'Travel', 'Games', 'Subscriptions', 'Fashion & Beauty', 'Coffee & Treats', 'Other'],
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* ---------- Helpers ---------- */
const pad2 = (n) => String(n).padStart(2, '0');

function monthKey(dateStr) { return dateStr.slice(0, 7); }                    // 'YYYY-MM'

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function moveMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
function monthLong(mk) {
  const [y, m] = mk.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}
function monthShort(mk) {
  const [y, m] = mk.split('-').map(Number);
  return `${MONTHS_SHORT[m - 1]} ${y}`;
}
function dayTitle(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}
function fmtMoney(n) {
  const sign = n < 0 ? '-' : '';
  return sign + CURRENCY + Math.round(Math.abs(n)).toLocaleString('en-US');
}
function parseMoney(str) {
  const v = parseFloat(str);
  if (Number.isNaN(v) || v <= 0) return null;
  return Math.round(v * 100) / 100;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ---------- Data layer ---------- */
const TOMB_MAX_MS = 400 * 24 * 3600 * 1000; // tombstones older than ~400 days are dropped

function normalizeDB(d) {
  const now = Date.now();
  if (!Array.isArray(d.expenses)) d.expenses = [];
  if (!d.budgets || typeof d.budgets !== 'object') d.budgets = {};
  if (!d.budgetMeta || typeof d.budgetMeta !== 'object') d.budgetMeta = {};
  if (!d.budgetRemoved || typeof d.budgetRemoved !== 'object') d.budgetRemoved = {};
  d.view = d.view || monthKey(todayStr());
  // Normalize every record to carry stable id / createdAt / updatedAt / deleted.
  const seen = new Set();
  d.expenses = d.expenses.filter((e) => {
    if (!e || !e.id || seen.has(e.id)) return false;   // drop broken / duplicated ids
    seen.add(e.id);
    if (!e.createdAt) e.createdAt = 0;
    if (!e.updatedAt) e.updatedAt = e.createdAt || now;
    if (!e.deleted) e.deleted = false;
    // Prune very old tombstones so the list does not grow forever.
    if (e.deleted && now - (e.updatedAt || now) > TOMB_MAX_MS) return false;
    return true;
  });
  // Legacy budgets without a change timestamp get meta = 0 (oldest wins in merges).
  Object.keys(d.budgets).forEach((mk) => {
    if (d.budgetMeta[mk] === undefined) d.budgetMeta[mk] = 0;
  });
  return d;
}

function loadDB() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return normalizeDB(JSON.parse(raw));
  } catch (e) { /* corrupted -> start fresh */ }
  return normalizeDB({ expenses: [], budgets: {}, budgetMeta: {}, budgetRemoved: {}, view: monthKey(todayStr()) });
}
function saveDB() {
  localStorage.setItem(STORE_KEY, JSON.stringify(db));
  if (window.SpendSync && !window.SpendSync._suppress) window.SpendSync.onLocalChange();
}
/* Records marked deleted are tombstones kept for cloud merge — treat them as invisible. */
function liveExpenses() {
  return db.expenses.filter((e) => !e.deleted);
}
function removeExpense(id) {
  const rec = db.expenses.find((e) => e.id === id);
  if (rec) {
    rec.deleted = true;   // keep a tombstone so the delete propagates to other devices
    rec.updatedAt = Date.now();
  }
}
function touchBudget(mk) {
  db.budgetMeta[mk] = Date.now();
}

let db = loadDB();

const getBudget = (mk) => (db.budgets[mk] !== undefined ? Number(db.budgets[mk]) : null);

function monthTotals(mk) {
  let needSum = 0, wantSum = 0;
  const list = [];
  for (const e of liveExpenses()) {
    if (monthKey(e.date) !== mk) continue;
    list.push(e);
    if (e.type === NEED) needSum += e.amount;
    else wantSum += e.amount;
  }
  return { needSum, wantSum, total: needSum + wantSum, list };
}

const realNow = monthKey(todayStr());

/* ---------- DOM nodes ---------- */
const els = {
  monthLabel: $('#monthLabel'),
  prevMonthBtn: $('#prevMonthBtn'),
  nextMonthBtn: $('#nextMonthBtn'),
  todayBtn: $('#todayBtn'),
  currentTag: $('#currentTag'),
  addBtn: $('#addBtn'),
  exportBtn: $('#exportBtn'),
  exportMenu: $('#exportMenu'),
  exportMonthBtn: $('#exportMonthBtn'),
  exportAllBtn: $('#exportAllBtn'),
  editBudgetBtn: $('#editBudgetBtn'),
  ringFg: $('#ringFg'),
  ringWrap: $('#ringWrap'),
  ringLabel: $('#ringLabel'),
  ringValue: $('#ringValue'),
  ringHint: $('#ringHint'),
  budgetTip: $('#budgetTip'),
  statSpent: $('#statSpent'),
  statNeed: $('#statNeed'),
  statWant: $('#statWant'),
  budgetTrackFill: $('#budgetTrackFill'),
  budgetTrackText: $('#budgetTrackText'),
  splitTotal: $('#splitTotal'),
  avgDay: $('#avgDay'),
  needCount: $('#needCount'),
  wantCount: $('#wantCount'),
  needAmt: $('#needAmt'),
  wantAmt: $('#wantAmt'),
  needBar: $('#needBar'),
  wantBar: $('#wantBar'),
  needPct: $('#needPct'),
  wantPct: $('#wantPct'),
  topCat: $('#topCat'),
  recordList: $('#recordList'),
  emptyState: $('#emptyState'),
  emptyTitle: $('#emptyTitle'),
  demoBtn: $('#demoBtn'),
  clearBtn: $('#clearBtn'),
  recSummary: $('#recSummary'),
  searchInput: $('#searchInput'),
  filterChips: $('#filterChips'),

  modalExpense: $('#modalExpense'),
  expenseTitle: $('#expenseTitle'),
  editingId: $('#editingId'),
  expDate: $('#expDate'),
  expAmount: $('#expAmount'),
  expCat: $('#expCat'),
  expNote: $('#expNote'),
  typeSeg: $('#typeSeg'),
  expenseForm: $('#expenseForm'),

  modalBudget: $('#modalBudget'),
  budgetTitle: $('#budgetTitle'),
  budgetMonthLabel: $('#budgetMonthLabel'),
  budgetInput: $('#budgetInput'),
  budgetHint: $('#budgetHint'),
  budgetForm: $('#budgetForm'),

  toast: $('#toast'),
};

/* ---------- Current viewed month ---------- */
function view() { return db.view || realNow; }
function setView(mk) { db.view = mk; saveDB(); }

/* ================================================================
 * Rendering
 * ================================================================ */
function render() {
  renderHeader();
  renderBudget();
  renderSplit();
  renderRecords();
}

function renderHeader() {
  els.monthLabel.textContent = monthLong(view());
  els.currentTag.classList.toggle('hidden', view() !== realNow);
}

function setRingValue(text) {
  els.ringValue.textContent = text;
  els.ringValue.classList.toggle('ring-long', text.length > 7);
  els.ringValue.classList.toggle('ring-xl', text.length > 12);
}

function renderBudget() {
  const mk = view();
  const { needSum, wantSum, total, list } = monthTotals(mk);
  const budget = getBudget(mk);
  const [vy, vm] = mk.split('-').map(Number);
  const daysInMonth = new Date(vy, vm, 0).getDate();
  const dayNum = new Date().getDate();
  const daysPassed = mk === realNow ? Math.max(dayNum, 1) : daysInMonth;

  els.statSpent.textContent = fmtMoney(total);
  els.statNeed.textContent = fmtMoney(needSum);
  els.statWant.textContent = fmtMoney(wantSum);

  const R = 52;
  const CIRC = 2 * Math.PI * R;

  if (budget === null) {
    els.ringFg.style.strokeDasharray = `0 ${CIRC}`;
    els.ringFg.classList.remove('over', 'near');
    els.ringLabel.textContent = 'Left to spend';
    els.ringHint.textContent = 'No limit set';
    setRingValue('--');
    els.budgetTip.textContent = total > 0
      ? `Spent ${fmtMoney(total)} so far this month`
      : 'No expenses recorded this month yet';
    els.budgetTrackFill.style.width = '0%';
    els.budgetTrackFill.classList.remove('over', 'near');
    els.budgetTrackText.textContent = total > 0
      ? `Spent ${fmtMoney(total)} (${list.length} items) — set a limit to track your remaining budget`
      : 'Tap “Edit” above to set your monthly spending limit';
    return;
  }

  const remaining = budget - total;
  const ratio = budget > 0 ? total / budget : 1;
  const ringRatio = Math.min(ratio, 1);

  els.ringFg.style.strokeDasharray = `${(ringRatio * CIRC).toFixed(1)} ${CIRC.toFixed(1)}`;
  els.ringFg.classList.toggle('over', ratio >= 1);
  els.ringFg.classList.toggle('near', ratio >= 0.85 && ratio < 1);

  if (ratio >= 1) {
    els.ringLabel.textContent = 'Over budget';
    els.ringHint.textContent = `by ${fmtMoney(remaining)}`;
    setRingValue(fmtMoney(remaining));
    els.budgetTip.textContent = 'You have exceeded this month\u2019s spending limit!';
  } else {
    els.ringLabel.textContent = 'Left to spend';
    els.ringHint.textContent = `${(ratio * 100).toFixed(0)}% of limit used`;
    setRingValue(fmtMoney(remaining));
    els.budgetTip.textContent = total > 0
      ? `Spent ${fmtMoney(total)} of ${fmtMoney(budget)}`
      : `You have ${fmtMoney(budget)} to spend this month`;
  }

  const avg = total / Math.max(daysPassed, 1);
  els.budgetTrackFill.style.width = `${Math.min(ratio * 100, 100)}%`;
  els.budgetTrackFill.classList.toggle('over', ratio >= 1);
  els.budgetTrackFill.classList.toggle('near', ratio >= 0.85 && ratio < 1);
  els.budgetTrackText.textContent = `Limit ${fmtMoney(budget)}  ·  Spent ${fmtMoney(total)}  ·  ~${fmtMoney(avg)} / day`;
}

function renderSplit() {
  const { needSum, wantSum, total, list } = monthTotals(view());
  const mk = view();
  const now = new Date();
  const inMonth = mk === realNow;
  const dayNum = now.getDate();
  const [vy, vm] = mk.split('-').map(Number);
  const daysInViewMonth = new Date(vy, vm, 0).getDate();
  const elapsed = inMonth ? dayNum : daysInViewMonth;

  els.splitTotal.textContent = fmtMoney(total);
  els.avgDay.textContent = total > 0
    ? `~${fmtMoney(total / Math.max(elapsed, 1))} / day`
    : 'No spending yet';

  const needCount = list.filter((e) => e.type === NEED).length;
  const wantCount = list.length - needCount;
  els.needCount.textContent = `${needCount} item${needCount === 1 ? '' : 's'}`;
  els.wantCount.textContent = `${wantCount} item${wantCount === 1 ? '' : 's'}`;
  els.needAmt.textContent = fmtMoney(needSum);
  els.wantAmt.textContent = fmtMoney(wantSum);

  if (total === 0) {
    els.needBar.style.width = '0%';
    els.wantBar.style.width = '0%';
    els.needPct.textContent = '0% of total';
    els.wantPct.textContent = '0% of total';
    els.topCat.textContent = 'Record your first expense and your spending mix will appear here.';
    return;
  }
  const needPct = (needSum / total) * 100;
  const wantPct = 100 - needPct;
  els.needBar.style.width = `${needPct}%`;
  els.wantBar.style.width = `${wantPct}%`;
  els.needPct.textContent = `${needPct.toFixed(0)}% of total`;
  els.wantPct.textContent = `${wantPct.toFixed(0)}% of total`;

  const catSum = {};
  list.forEach((e) => {
    catSum[e.type + '|' + e.category] = (catSum[e.type + '|' + e.category] || 0) + e.amount;
  });
  const top = Object.entries(catSum).sort((a, b) => b[1] - a[1])[0];
  if (top) {
    const [key, amt] = top;
    const [t, cat] = key.split('|');
    const kind = t === NEED ? 'necessary' : 'discretionary';
    els.topCat.textContent = `Top category this month: ${cat} (${kind}) — ${fmtMoney(amt)}, ${((amt / total) * 100).toFixed(0)}% of total.`;
  }
}

/* ================================================================
 * Expense record list
 * ================================================================ */
let curFilter = 'all';

function renderRecords() {
  const { list } = monthTotals(view());
  const kw = els.searchInput.value.trim().toLowerCase();

  let filtered = list;
  if (curFilter !== 'all') filtered = filtered.filter((e) => e.type === curFilter);
  if (kw) {
    filtered = filtered.filter((e) =>
      (e.category || '').toLowerCase().includes(kw) || (e.note || '').toLowerCase().includes(kw)
    );
  }
  filtered.sort((a, b) =>
    a.date === b.date ? (a.createdAt || 0) - (b.createdAt || 0) : a.date.localeCompare(b.date)
  );

  const shownSum = filtered.reduce((s, e) => s + e.amount, 0);
  els.recSummary.textContent = filtered.length > 0
    ? `${filtered.length} item${filtered.length === 1 ? '' : 's'}${filtered.length !== list.length ? ` of ${list.length}` : ''} · ${fmtMoney(shownSum)}`
    : '';

  const empty = els.emptyState;
  if (!filtered.length) {
    els.recordList.innerHTML = '';
    els.emptyTitle.textContent = list.length
      ? 'No matching records'
      : view() === realNow
        ? 'No expenses yet this month'
        : 'No expenses this month';
    els.demoBtn.classList.toggle('hidden', list.length > 0);
    empty.classList.remove('hidden');
    return;
  }

  els.demoBtn.classList.add('hidden');
  empty.classList.add('hidden');

  const groups = new Map();
  for (const e of filtered) {
    if (!groups.has(e.date)) groups.set(e.date, []);
    groups.get(e.date).push(e);
  }

  let html = '';
  for (const [date, rows] of groups) {
    const daySum = rows.reduce((s, e) => s + e.amount, 0);
    const wd = WEEKDAYS_SHORT[new Date(date + 'T00:00:00').getDay()];
    const isToday = date === todayStr();
    html += `<li class="rec-group">
      <div class="rec-day"><span>${dayTitle(date)} (${wd})${isToday ? ' · Today' : ''}</span>
      <span class="day-total">${fmtMoney(daySum)}</span></div>`;

    for (const e of rows) {
      const note = e.note ? `<div class="rec-note">${esc(e.note)}</div>` : '';
      html += `<li class="rec" data-id="${e.id}">
        <span class="rec-icon ${e.type}">${esc(e.category).slice(0, 2)}</span>
        <div class="rec-main">
          <div class="rec-title"><span class="rec-badge ${e.type}">${TYPE_LABEL[e.type]}</span><span>${esc(e.category)}</span></div>
          ${note}
        </div>
        <div class="rec-right">
          <span class="rec-amount ${e.type === NEED ? 'need-txt' : 'want-txt'}">${fmtMoney(e.amount)}</span>
          <button class="rec-edit" data-action="edit" title="Edit">Edit</button>
          <button class="rec-del" data-action="delete" title="Delete">&times;</button>
        </div>
      </li>`;
    }
    html += '</li>';
  }
  els.recordList.innerHTML = html;
}

function onRecordClick(ev) {
  const btn = ev.target.closest('[data-action]');
  if (!btn) return;
  const li = ev.target.closest('.rec');
  const id = li.dataset.id;
  const rec = db.expenses.find((e) => e.id === id);
  if (!rec) return;
  if (btn.dataset.action === 'delete') {
    const ok = confirm(`Delete this entry — ${TYPE_LABEL[rec.type]} · ${rec.category} ${fmtMoney(rec.amount)}?`);
    if (!ok) return;
    removeExpense(id);
    saveDB();
    render();
    toast('Entry deleted');
  } else if (btn.dataset.action === 'edit') {
    openExpenseModal(rec);
  }
}

/* ================================================================
 * Expense modal
 * ================================================================ */
let expType = NEED;
let editingRec = null;

function openExpenseModal(rec) {
  editingRec = rec || null;
  els.expenseTitle.textContent = rec ? 'Edit Expense' : 'Add Expense';
  els.editingId.value = rec ? rec.id : '';
  els.expDate.value = rec ? rec.date : todayStr();
  els.expAmount.value = rec ? rec.amount : '';
  els.expNote.value = rec && rec.note ? rec.note : '';
  setExpType(rec ? rec.type : NEED);
  selectCat(rec ? rec.category : '');
  els.modalExpense.classList.remove('hidden');
  els.expAmount.focus();
}

function closeExpenseModal() {
  els.modalExpense.classList.add('hidden');
  editingRec = null;
  els.expenseForm.reset();
}

function setExpType(type) {
  expType = type;
  els.typeSeg.querySelectorAll('.seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.type === type)
  );
  const sel = els.expCat;
  const prev = sel.value;
  sel.innerHTML = CATEGORIES[type].map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if (CATEGORIES[type].includes(prev)) sel.value = prev;
}
function selectCat(name) {
  if (name && CATEGORIES[expType].includes(name)) els.expCat.value = name;
}

function handleExpenseSubmit(ev) {
  ev.preventDefault();
  const date = els.expDate.value;
  const amount = parseMoney(els.expAmount.value);
  const note = els.expNote.value.trim();
  if (!date) return toast('Please pick a date');
  if (amount === null) return toast('Please enter a valid amount (greater than 0)');
  if (!CATEGORIES[expType].includes(els.expCat.value)) return toast('Please choose a category');

  const payload = { date, type: expType, category: els.expCat.value, note, amount };

  if (editingRec) {
    const rec = db.expenses.find((e) => e.id === editingRec.id);
    if (rec) {
      Object.assign(rec, payload);
      rec.updatedAt = Date.now();
    }
    toast('Entry updated');
  } else {
    payload.id = uid();
    payload.createdAt = Date.now();
    payload.updatedAt = payload.createdAt;
    db.expenses.push(payload);
    toast('Saved — remaining budget updated');
  }
  saveDB();
  closeExpenseModal();

  const expenseMonth = monthKey(date);
  if (view() !== expenseMonth) setView(expenseMonth);

  render();
}

/* ================================================================
 * Budget modal
 * ================================================================ */
function openBudgetModal() {
  const mk = view();
  const { total } = monthTotals(mk);
  els.budgetMonthLabel.textContent = monthLong(mk);
  const cur = getBudget(mk);
  els.budgetInput.value = cur === null ? '' : cur;
  els.budgetHint.textContent = total > 0
    ? `You have already spent ${fmtMoney(total)} this month. If the limit you enter is lower, it will show as over budget.`
    : 'Limits are set per month. Once saved, your remaining budget is calculated automatically.';
  els.modalBudget.classList.remove('hidden');
  els.budgetInput.focus();
}

function handleBudgetSubmit(ev) {
  ev.preventDefault();
  const mk = view();
  const val = els.budgetInput.value;
  if (val === '' || val === null) {
    delete db.budgets[mk];
    delete db.budgetMeta[mk];
    db.budgetRemoved[mk] = Date.now();   // tombstone: deletion also syncs
    toast('Monthly limit removed');
  } else {
    const n = parseFloat(val);
    if (Number.isNaN(n) || n < 0) return toast('Please enter a valid budget');
    db.budgets[mk] = Math.round(n * 100) / 100;
    touchBudget(mk);
    toast(`Monthly limit set to ${fmtMoney(n)}`);
  }
  saveDB();
  els.modalBudget.classList.add('hidden');
  render();
}

/* ================================================================
 * Excel / CSV export
 * ================================================================ */
const XLSX_CDNS = [
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://cdn.sheetjs.com/xlsx-0.20.2/package/dist/xlsx.full.min.js',
];

function loadSheetJS() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let i = 0;
    const tryLoad = () => {
      if (i >= XLSX_CDNS.length) return reject(new Error('no-cdn'));
      const s = document.createElement('script');
      s.src = XLSX_CDNS[i++];
      s.onload = () => (window.XLSX ? resolve() : tryLoad());
      s.onerror = tryLoad;
      document.head.appendChild(s);
    };
    tryLoad();
  });
}

function buildRows(expenses) {
  return expenses
    .slice()
    .sort((a, b) =>
      a.date === b.date ? (a.createdAt || 0) - (b.createdAt || 0) : a.date.localeCompare(b.date)
    )
    .map((e) => [e.date, TYPE_LABEL[e.type], e.category, e.note || '', e.amount]);
}

function sumOf(rows) { return rows.reduce((s, r) => s + Number(r[4] || 0), 0); }

function buildSummaryAOA() {
  const months = new Set([...Object.keys(db.budgets), ...liveExpenses().map((e) => monthKey(e.date))]);
  const aoa = [['Month', 'Limit', 'Necessary', 'Discretionary', 'Total', 'Left to spend', 'Status']];
  [...months].sort().forEach((mk) => {
    const { needSum, wantSum, total } = monthTotals(mk);
    const budget = getBudget(mk);
    const rem = budget === null ? null : budget - total;
    aoa.push([
      mk,
      budget === null ? '' : budget,
      Math.round(needSum * 100) / 100,
      Math.round(wantSum * 100) / 100,
      Math.round(total * 100) / 100,
      rem === null ? '' : Math.round(rem * 100) / 100,
      rem === null ? 'No limit set' : rem >= 0 ? 'Within limit' : `Over by ${fmtMoney(rem)}`,
    ]);
  });
  return aoa;
}

function applyColWidths(ws, widths) {
  ws['!cols'] = widths.map((wch) => ({ wch }));
}

function exportExcel(scope) {
  toast('Preparing Excel file…');
  loadSheetJS()
    .then(() => {
      const today = todayStr().replace(/-/g, '');
      const mk = view();
      const ss = monthShort(mk).replace(/\s+/g, ' ');

      let detail, fileName, sheetName;
      if (scope === 'month') {
        detail = buildRows(monthTotals(mk).list);
        fileName = `expenses_${mk}.xlsx`;
        sheetName = `${ss} Expenses`;
      } else {
        detail = buildRows(liveExpenses());
        fileName = `expenses_all_${today}.xlsx`;
        sheetName = 'Expenses';
      }
      const detailTotal = sumOf(detail);

      const wb = XLSX.utils.book_new();
      const detailAoa = [
        ['Date', 'Type', 'Category', 'Note', 'Amount'],
        ...detail,
        ['TOTAL', '', '', `${detail.length} item${detail.length === 1 ? '' : 's'}`, detailTotal],
      ];
      const wsDetail = XLSX.utils.aoa_to_sheet(detailAoa);
      applyColWidths(wsDetail, [12, 14, 18, 34, 12]);
      XLSX.utils.book_append_sheet(wb, wsDetail, sheetName);

      const summaryAoa = buildSummaryAOA();
      const wsSum = XLSX.utils.aoa_to_sheet(summaryAoa);
      applyColWidths(wsSum, [10, 12, 12, 14, 12, 14, 16]);
      XLSX.utils.book_append_sheet(wb, wsSum, 'Monthly Summary');

      XLSX.writeFile(wb, fileName);
      toast(`Exported "${fileName}"`);
    })
    .catch(() => {
      const rows = scope === 'month'
        ? buildRows(monthTotals(view()).list)
        : buildRows(liveExpenses());
      const total = sumOf(rows);
      const lines = [['Date', 'Type', 'Category', 'Note', 'Amount'].join(',')];
      rows.forEach((r) => lines.push(r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')));
      lines.push(`"TOTAL","","","${rows.length} item${rows.length === 1 ? '' : 's'}",${total}`);
      const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = scope === 'month'
        ? `expenses_${view()}.csv`
        : `expenses_all_${todayStr().replace(/-/g, '')}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Excel library could not be loaded (likely offline) — a CSV file was downloaded instead. It opens in Excel too.');
    });
}

/* ================================================================
 * Sample data / clear
 * ================================================================ */
function loadDemoData() {
  if (liveExpenses().length && !confirm('You already have data. Sample entries will be merged in — continue?')) return;

  const mk = realNow;
  db.budgets[mk] = 20000;

  const d = (offset) => {
    const now = new Date();
    const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
  };
  const demos = [
    [d(9), NEED, 'Housing / Rent', 'Monthly rent', 8500],
    [d(8), NEED, 'Groceries & Food', 'Breakfast & coffee', 95],
    [d(7), NEED, 'Transport', 'Metro top-up', 300],
    [d(6), WANT, 'Dining Out', 'Dinner with friends', 680],
    [d(5), NEED, 'Family & Home', 'Grocery run', 1240],
    [d(4), WANT, 'Drinks & Snacks', 'Boba tea', 120],
    [d(3), WANT, 'Entertainment', 'Two movie tickets', 640],
    [d(2), WANT, 'Games', 'Steam game', 465],
    [d(1), NEED, 'Healthcare', 'Clinic registration', 200],
    [d(0), NEED, 'Groceries & Food', 'Lunch bento box', 135],
  ];
  demos.forEach(([date, type, category, note, amount]) => {
    const t = Date.now();
    db.expenses.push({ id: uid(), date, type, category, note, amount, createdAt: t, updatedAt: t });
  });

  setView(mk);
  saveDB();
  render();
  toast('Sample data loaded — you can clear it anytime');
}

function clearAll() {
  if (!confirm('Delete ALL expenses and budget settings? This cannot be undone.')) return;
  const t = Date.now();
  // Tombstone every record and every budget so the erase also syncs to other devices.
  db.expenses = liveExpenses().map((e) => Object.assign({}, e, { deleted: true, updatedAt: t }));
  const knownMk = new Set([...Object.keys(db.budgets), ...Object.keys(db.budgetMeta), ...Object.keys(db.budgetRemoved)]);
  const removedMk = {};
  knownMk.forEach((mk) => { removedMk[mk] = t; });
  db.budgetRemoved = removedMk;
  db.budgets = {};
  db.budgetMeta = {};
  db.view = realNow;
  saveDB();
  render();
  toast('All data cleared');
}

/* ================================================================
 * Toast
 * ================================================================ */
let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 3200);
}

/* ================================================================
 * Modal helpers / events
 * ================================================================ */
document.querySelectorAll('[data-close]').forEach((b) =>
  b.addEventListener('click', () => document.getElementById(b.dataset.close).classList.add('hidden'))
);
document.querySelectorAll('.modal').forEach((m) =>
  m.addEventListener('mousedown', (ev) => { if (ev.target === m) m.classList.add('hidden'); })
);

function bindEvents() {
  els.prevMonthBtn.addEventListener('click', () => { setView(moveMonth(view(), -1)); render(); });
  els.nextMonthBtn.addEventListener('click', () => { setView(moveMonth(view(), 1)); render(); });
  els.monthLabel.addEventListener('click', () => { setView(realNow); render(); });
  els.todayBtn.addEventListener('click', () => { setView(realNow); render(); });

  els.addBtn.addEventListener('click', () => openExpenseModal(null));
  els.expenseForm.addEventListener('submit', handleExpenseSubmit);
  els.typeSeg.addEventListener('click', (ev) => {
    const b = ev.target.closest('.seg-btn');
    if (b) setExpType(b.dataset.type);
  });

  els.editBudgetBtn.addEventListener('click', openBudgetModal);
  els.budgetForm.addEventListener('submit', handleBudgetSubmit);

  els.exportBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    els.exportMenu.classList.toggle('hidden');
  });
  document.addEventListener('click', () => els.exportMenu.classList.add('hidden'));
  els.exportMenu.addEventListener('click', (ev) => ev.stopPropagation());
  els.exportMonthBtn.addEventListener('click', () => { els.exportMenu.classList.add('hidden'); exportExcel('month'); });
  els.exportAllBtn.addEventListener('click', () => { els.exportMenu.classList.add('hidden'); exportExcel('all'); });

  els.recordList.addEventListener('click', onRecordClick);
  els.filterChips.addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (!chip) return;
    els.filterChips.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    curFilter = chip.dataset.filter;
    renderRecords();
  });
  els.searchInput.addEventListener('input', () => renderRecords());

  els.demoBtn.addEventListener('click', loadDemoData);
  els.clearBtn.addEventListener('click', clearAll);

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      els.modalExpense.classList.add('hidden');
      els.modalBudget.classList.add('hidden');
      els.exportMenu.classList.add('hidden');
    }
  });
}

/* ---------- Boot ---------- */
bindEvents();
render();
if (window.SpendSync) window.SpendSync.init();
