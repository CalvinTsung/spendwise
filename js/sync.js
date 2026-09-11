/* ================================================================
 * SpendWise - Cloud sync (multi-device)
 *
 * Local-first design:
 *   - Every edit is written to localStorage instantly (works offline).
 *   - When online the app reconciles with CloudBase: it reads the
 *     "device documents" of all devices that share the same sync code,
 *     merges them record-by-record (updatedAt / tombstone based), then
 *     pushes the merged snapshot back into this device's own document.
 *
 * Console prerequisites (done once by the owner):
 *   1. Enable "Anonymous sign-in"  -> 身份认证 / 登录方式
 *   2. Create collection <COLLECTION> with permission
 *      "All users can read, only creator can write / 所有用户可读，仅创建者可写".
 *   3. Add your site domain (localhost for dev) to Web安全域名.
 * ================================================================ */
(function () {
  'use strict';

  var ENV_ID = 'calvinfirstaicloud-d1csdb95e5a6f';
  var COLLECTION = 'sw_ledgers';
  var PREFS_KEY = 'spendwise.sync.v1';
  var SDK_CDNS = [
    'https://static.cloudbase.net/cloudbase-js-sdk/1.7.2/cloudbase.full.js',
    'https://cdn.jsdelivr.net/npm/@cloudbase/js-sdk@1.7.2/dist/cloudbase.full.js',
    'https://unpkg.com/@cloudbase/js-sdk@1.7.2/dist/cloudbase.full.js',
  ];
  var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

  function $(id) { return document.getElementById(id); }

  /* -------------------- preferences (per browser) -------------------- */
  function loadPrefs() {
    try {
      var raw = localStorage.getItem(PREFS_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && typeof p === 'object') return {
          key: p.key || null,
          device: p.device || genId(),
          lastSyncAt: p.lastSyncAt || null,
        };
      }
    } catch (e) { /* ignore */ }
    return { key: null, device: genId(), lastSyncAt: null };
  }
  function savePrefs() { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); }
  function genId() {
    return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function genCode() {
    var s = '';
    for (var i = 0; i < 8; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return s;
  }
  function cleanCode(v) {
    return String(v || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  }

  var prefs = loadPrefs();

  /* -------------------- runtime state -------------------- */
  var appInst = null;
  var authInst = null;
  var sdkPromise = null;
  var busy = false;
  var syncTimer = null;
  var pollTimer = null;
  var lastPhase = 'idle';   // idle | syncing | synced | pending | error

  /* -------------------- CloudBase plumbing -------------------- */
  function ensureSDK() {
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise(function (resolve, reject) {
      if (window.cloudbase || window.tcb) return resolve();
      var i = 0;
      var tryLoad = function () {
        if (i >= SDK_CDNS.length) return reject(new Error('SDK_UNREACHABLE'));
        var s = document.createElement('script');
        s.src = SDK_CDNS[i++];
        s.async = true;
        s.onload = function () {
          if (window.cloudbase || window.tcb) resolve();
          else tryLoad();
        };
        s.onerror = tryLoad;
        document.head.appendChild(s);
      };
      tryLoad();
    });
    return sdkPromise;
  }

  async function getCloud() {
    await ensureSDK();
    var cloud = window.cloudbase || window.tcb;
    if (!appInst) appInst = cloud.init({ env: ENV_ID });
    if (!authInst) {
      try { authInst = appInst.auth({ persistence: 'local' }); }
      catch (e) { authInst = appInst.auth(); }
    }
    // One persistent anonymous account per browser.
    var logged = false;
    try {
      var st = typeof authInst.getLoginState === 'function' ? await authInst.getLoginState() : null;
      logged = !!(st && (st.uid || st.user || st.userInfo || st.isAnonymousAuth || st.loginType));
    } catch (e) { /* not signed in yet */ }
    if (!logged) {
      if (typeof authInst.signInAnonymously === 'function') await authInst.signInAnonymously();
      else if (typeof authInst.anonymousAuthProvider === 'function') await authInst.anonymousAuthProvider().signIn();
      else throw new Error('SDK_MISMATCH');
    }
    return appInst;
  }

  function errKind(e) {
    var m = String((e && (e.message || e.msg)) || e).toLowerCase();
    if (/login|anonymous|not enabled|auth/i.test(m)) return 'login';
    if (/collection|not exist|database/i.test(m)) return 'collection';
    if (/network|fetch|timeout|offline|internet|connection|socket/i.test(m)) return 'offline';
    if (/security|domain|来源|referer/i.test(m)) return 'domain';
    return 'unknown';
  }

  /* -------------------- payload helpers -------------------- */
  function payloadFromLocal() {
    return {
      expenses: db.expenses || [],
      budgets: db.budgets || {},
      budgetMeta: db.budgetMeta || {},
      budgetRemoved: db.budgetRemoved || {},
    };
  }

  function recKey(r) {
    return r.id + '|' + (r.updatedAt || 0) + '|' + (r.deleted ? 1 : 0) +
      '|' + r.date + '|' + (r.type || '') + '|' + (r.category || '') +
      '|' + (r.note || '') + '|' + (r.amount || 0);
  }
  function canonPayload(P) {
    var ex = (P.expenses || []).slice()
      .sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; })
      .map(recKey).join(';');
    var bu = Object.keys(P.budgets || {}).sort().map(function (k) { return k + '=' + P.budgets[k]; }).join(';');
    var me = Object.keys(P.budgetMeta || {}).sort().map(function (k) { return k + '=' + (P.budgetMeta[k] || 0); }).join(';');
    var re = Object.keys(P.budgetRemoved || {}).sort().map(function (k) { return k + '=' + (P.budgetRemoved[k] || 0); }).join(';');
    return ex + '||' + bu + '||' + me + '||' + re;
  }

  function newerRec(a, b) {
    if (!a) return b;
    if (!b) return a;
    var ta = a.updatedAt || 0, tb = b.updatedAt || 0;
    if (ta !== tb) return ta > tb ? a : b;
    var ca = a.createdAt || 0, cb = b.createdAt || 0;
    if (ca !== cb) return ca > cb ? a : b;
    return recKey(a) >= recKey(b) ? a : b;
  }

  /* Merge device snapshots into one. Callers order inputs so the result is
   * deterministic across devices (doc ts asc, device id asc). */
  function mergePayloads(list) {
    var recs = Object.create(null);
    var budgets = Object.create(null);   // mk -> { ts, value }
    var removed = Object.create(null);   // mk -> max removal timestamp
    list.forEach(function (P) {
      (P.expenses || []).forEach(function (r) {
        recs[r.id] = newerRec(recs[r.id], r);
      });
      var bu = P.budgets || {}, me = P.budgetMeta || {}, rm = P.budgetRemoved || {};
      Object.keys(bu).forEach(function (mk) {
        var cur = budgets[mk];
        var ts = me[mk] || 0;
        if (!cur || cur.ts < ts || (cur.ts === ts && Number(cur.value) < Number(bu[mk]))) {
          budgets[mk] = { ts: ts, value: bu[mk] };
        }
      });
      Object.keys(rm).forEach(function (mk) {
        if ((removed[mk] || 0) < (rm[mk] || 0)) removed[mk] = rm[mk] || 0;
      });
    });

    var allMk = new Set(Object.keys(budgets));
    list.forEach(function (P) {
      Object.keys(P.budgetMeta || {}).forEach(function (k) { allMk.add(k); });
      Object.keys(P.budgetRemoved || {}).forEach(function (k) { allMk.add(k); });
    });

    var expenses = Object.keys(recs).map(function (id) { return recs[id]; });
    var outBudgets = {}, outMeta = {}, outRemoved = {};
    allMk.forEach(function (mk) {
      var rmTs = removed[mk] || 0;
      var b = budgets[mk];
      if (b && b.ts >= rmTs) { outBudgets[mk] = b.value; outMeta[mk] = b.ts; }
      else if (rmTs > 0) outRemoved[mk] = rmTs;
    });
    return { expenses: expenses, budgets: outBudgets, budgetMeta: outMeta, budgetRemoved: outRemoved };
  }

  function applyPayload(P) {
    S._suppress = true;
    try {
      db.expenses = P.expenses;
      db.budgets = P.budgets;
      db.budgetMeta = P.budgetMeta;
      db.budgetRemoved = P.budgetRemoved;
      saveDB();
    } finally { S._suppress = false; }
  }

  /* -------------------- cloud read / write -------------------- */
  async function fetchRemoteDocs(app) {
    var res = await app.database().collection(COLLECTION)
      .where({ syncKey: prefs.key })
      .limit(100)
      .get();
    var arr = (res && res.data) || [];
    return arr.filter(function (d) { return d && d.payload && d.syncKey === prefs.key; });
  }

  async function pushOwnDoc(app, P) {
    var ref = app.database().collection(COLLECTION).doc(prefs.device);
    var body = { syncKey: prefs.key, device: prefs.device, payload: P, ts: Date.now() };
    try { await ref.set(body); }
    catch (e) { await ref.set({ data: body }); }   // older SDK signature
  }

  /* -------------------- one reconciliation round -------------------- */
  async function syncNow(opts) {
    opts = opts || {};
    if (!prefs.key || busy) return;
    if (!navigator.onLine) {
      setPhase('pending', 'Offline — changes will sync when you are back online.');
      return;
    }
    busy = true;
    setPhase('syncing', 'Syncing…');
    try {
      var app = await getCloud();
      var remote = await fetchRemoteDocs(app);
      var local = payloadFromLocal();
      var inputs = remote
        .slice().sort(function (a, b) {
          return ((a.ts || 0) - (b.ts || 0)) || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0);
        })
        .map(function (d) { return d.payload; });

      var merged = inputs.length ? mergePayloads(inputs.concat([local])) : local;

      var localChanged = canonPayload(merged) !== canonPayload(local);
      if (localChanged) applyPayload(merged);

      var ownDoc = null;
      for (var i = 0; i < remote.length; i++) if (remote[i].device === prefs.device) { ownDoc = remote[i]; break; }
      var ownOutdated = !ownDoc || canonPayload(ownDoc.payload) !== canonPayload(merged);
      if (ownOutdated) await pushOwnDoc(app, merged);

      prefs.lastSyncAt = Date.now();
      savePrefs();
      if (localChanged && typeof render === 'function') render();
      setPhase('synced', '');
      return true;
    } catch (e) {
      var kind = errKind(e);
      var msg;
      if (kind === 'login') msg = 'Anonymous sign-in is not enabled yet. Follow step 1 in the setup guide.';
      else if (kind === 'collection') msg = 'Cloud collection “' + COLLECTION + '” is missing. Follow step 2 in the setup guide.';
      else if (kind === 'domain') msg = 'This page is running on a domain that is not allowed yet. Follow step 3 in the setup guide.';
      else if (kind === 'offline') { setPhase('pending', 'Offline — changes will sync when you are back online.'); return false; }
      else msg = 'Sync failed. Check your network and the setup guide, then press Turn on sync again.';
      setPhase('error', msg);
      return false;
    } finally { busy = false; }
  }

  function scheduleSync(delay) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { syncNow(); }, delay == null ? 1500 : delay);
  }
  function onLocalChange() {
    if (!prefs.key) return;
    setPhase('pending', 'Waiting…');
    scheduleSync();
  }

  /* -------------------- status UI -------------------- */
  function fmtTime(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
  }
  function setPhase(phase, msg) {
    lastPhase = phase;
    refreshUI(msg);
  }

  function refreshUI(msg) {
    var connected = !!prefs.key;
    var label = $('syncLabel'), dot = $('syncDot'), note = $('footNote');
    if (label && dot) {
      if (!connected) {
        label.textContent = 'Cloud sync: off';
        dot.className = 'sync-dot off';
        if (note) note.textContent = 'All data stays on this device until you turn on cloud sync.';
      } else {
        var txt = 'Cloud sync on', cls = 'on';
        if (lastPhase === 'syncing') { txt = 'Syncing…'; cls = 'busy'; }
        else if (lastPhase === 'pending') { txt = 'Sync pending'; cls = 'warn'; }
        else if (lastPhase === 'error') { txt = 'Sync needs attention'; cls = 'err'; }
        label.textContent = txt;
        dot.className = 'sync-dot ' + cls;
        if (note) note.textContent = 'Open this page on your other devices, tap Cloud sync and enter the same code ' + prefs.key + '.';
      }
    }

    // Modal state: connected vs not connected
    var offEls = ['cloudField', 'genCodeBtn', 'connectSyncBtn'];
    var onEls = ['syncStateArea', 'disconnectSyncBtn'];
    offEls.forEach(function (id) { var el = $(id); if (el) el.classList.toggle('hidden', connected); });
    onEls.forEach(function (id) { var el = $(id); if (el) el.classList.toggle('hidden', !connected); });

    var line = $('syncStatusLine');
    if (line) {
      if (!connected) line.textContent = 'Off';
      else if (lastPhase === 'syncing') line.textContent = 'Syncing…';
      else if (lastPhase === 'pending') line.textContent = 'Waiting for network';
      else if (lastPhase === 'error') line.textContent = 'Error';
      else line.textContent = 'In sync';
    }
    var cv = $('syncCodeView');
    if (cv) cv.textContent = connected ? prefs.key : '—';
    var lv = $('syncLastView');
    if (lv) lv.textContent = connected ? fmtTime(prefs.lastSyncAt) : '—';

    var ex = $('syncExplain');
    if (ex) {
      ex.className = 'sync-explain';
      ex.textContent = '';
      if (!connected) {
        ex.textContent = 'Use the same sync code on every device that should share this ledger. Generate a code on your first device, then enter it on the others.';
      } else if (msg) {
        if (lastPhase === 'error' || lastPhase === 'pending') {
          ex.textContent = msg;
          if (lastPhase === 'error') ex.classList.add('err');
        }
      }
    }
  }

  /* -------------------- user actions -------------------- */
  function openModal() {
    var m = $('modalSync');
    if (!m) return;
    m.classList.remove('hidden');
    refreshUI();
    var inp = $('cloudCodeInput');
    if (!prefs.key && inp) { inp.focus(); }
  }
  function closeModal() { var m = $('modalSync'); if (m) m.classList.add('hidden'); }

  function connect() {
    var code = cleanCode($('cloudCodeInput').value);
    var ex = $('syncExplain');
    if (code.length < 4) {
      ex.className = 'sync-explain err';
      ex.textContent = 'Please enter (or generate) a sync code with at least 4 characters.';
      return;
    }
    prefs.key = code;
    savePrefs();
    refreshUI();
    toast('Turning on cloud sync with code ' + code + '…');
    syncNow().then(function (ok) {
      // Keep the dialog open so the user sees the result / setup hints.
      $('modalSync').classList.remove('hidden');
    });
  }

  function disconnect() {
    if (!prefs.key) return;
    if (!confirm('Turn off cloud sync on this device? Data already in the cloud stays there, and this device keeps its local copy. You can reconnect with the same code anytime.')) return;
    prefs.key = null;
    savePrefs();
    lastPhase = 'idle';
    refreshUI();
    toast('Cloud sync turned off — data kept on this device');
  }

  function copyCode() {
    if (!prefs.key) return;
    var ok = function () { toast('Sync code copied'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(prefs.key).then(ok).catch(function () { fallbackCopy(prefs.key); ok(); });
    } else { fallbackCopy(prefs.key); ok(); }
  }
  function fallbackCopy(txt) {
    var ta = document.createElement('textarea');
    ta.value = txt;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }

  /* -------------------- init -------------------- */
  function init() {
    var open = $('syncBtn');
    if (open) open.addEventListener('click', openModal);
    var m = $('modalSync');
    if (m) {
      m.addEventListener('click', function (ev) {
        if (ev.target.closest('[data-close="modalSync"]')) closeModal();
      });
      m.addEventListener('mousedown', function (ev) {
        if (ev.target === m) closeModal();
      });
    }
    if ($('genCodeBtn')) $('genCodeBtn').addEventListener('click', function () {
      $('cloudCodeInput').value = genCode();
      var ex = $('syncExplain');
      ex.className = 'sync-explain';
      ex.textContent = 'A new random code was generated. Press “Turn on sync”, then enter the same code on your other devices.';
    });
    if ($('connectSyncBtn')) $('connectSyncBtn').addEventListener('click', connect);
    if ($('disconnectSyncBtn')) $('disconnectSyncBtn').addEventListener('click', disconnect);
    if ($('syncCopyBtn')) $('syncCopyBtn').addEventListener('click', copyCode);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && prefs.key) syncNow();
    });
    window.addEventListener('online', function () { if (prefs.key) { refreshUI(); scheduleSync(400); } });
    window.addEventListener('offline', function () { if (prefs.key) setPhase('pending', 'Offline — changes will sync when you are back online.'); });

    refreshUI();

    if (prefs.key) setTimeout(function () { syncNow(); }, 1200);
    clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      if (prefs.key && document.visibilityState === 'visible' && !busy) syncNow();
    }, 25000);
  }

  var S = {
    _suppress: false,
    init: init,
    onLocalChange: onLocalChange,
    syncNow: syncNow,
    _merge: mergePayloads,
    _canon: canonPayload,
    _genCode: genCode,
  };
  window.SpendSync = S;
})();
