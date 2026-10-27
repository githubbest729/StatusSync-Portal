/* StatusSync Portal — application controller */
(function () {
  'use strict';

  const { esc, fmtDate, fmtDateTime } = SSReports;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const ROLE_GROUPS = [
    { label: 'Client', roles: ['Client'] },
    { label: 'Consultant', roles: ['Consultant'] },
    { label: 'Project Manager', roles: ['Project Manager'] },
    { label: 'Internal Control Team', roles: ['SCADA Engineer', 'PLC Engineer', 'HSE Officer'] },
    { label: 'Estimation', roles: ['Estimation'] },
    { label: 'Procurement', roles: ['Procurement'] }
  ];
  const ALL_ROLES = ['Client', 'Consultant', 'Project Manager', 'SCADA Engineer', 'PLC Engineer', 'Estimation', 'Procurement', 'HSE Officer'];
  const CHANNELS = ['Portal Broadcast', 'Email Transmittal', 'WhatsApp Update', 'MOM', 'RFI', 'Technical Clarification'];
  const CATEGORIES = ['Wonderware SCADA', 'HMI/Alarms/Trends', 'OPC/Modbus Comms', 'SQL/Historian', 'Site Survey/BOM', 'Procurement', 'FAT/SAT', 'Documentation/Training', 'Legal/Paperwork'];
  const STATUSES = ['Not Started', 'In Progress', 'Blocked', 'Complete'];
  const RACI_NAMES = { R: 'Responsible', A: 'Accountable', C: 'Consulted', I: 'Informed' };
  const OVERDUE_DAYS = 7;

  const state = {
    projectId: null, projects: [], participants: [], persona: 'engineer',
    histBefore: null, commBefore: null, deferredInstall: null, reg: null, waiting: null,
    clicks: 0, nudged: false, seq: 1
  };

  /* ---------------- small utilities ---------------- */
  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  const curProject = () => state.projects.find((p) => p.id === state.projectId);
  const projRange = (pid) => IDBKeyRange.bound([pid, ''], [pid, '￿']);
  const daysSince = (iso) => (iso ? Math.floor((Date.now() - Date.parse(iso)) / 86400000) : null);
  function fmtBytes(n) {
    if (!n) return '0 MB';
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    return (n / 1048576).toFixed(n < 10485760 ? 2 : 1) + ' MB';
  }
  function isoWeek(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil(((t - y0) / 86400000 + 1) / 7);
  }
  function toast(msg, opts) {
    const o = opts || {};
    const host = $('#toasts');
    const t = document.createElement('div');
    t.className = 'toast' + (o.err ? ' err' : '');
    t.setAttribute('role', o.err ? 'alert' : 'status');
    t.textContent = msg;
    if (o.action) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn small primary'; b.style.marginLeft = '10px';
      b.textContent = o.action.label;
      b.addEventListener('click', () => { o.action.fn(); t.remove(); });
      t.appendChild(b);
    }
    host.appendChild(t);
    setTimeout(() => t.remove(), o.ms || 5000);
  }
  /* ---------------- helpers: announce, loading skeleton, empty states, status mapping ---------------- */
  function announce(msg) {
    const r = $('#liveRegion');
    if (!r) return;
    r.textContent = '';
    setTimeout(() => { r.textContent = msg; }, 40);
  }
  let loadTimer = null;
  function setLoading(on, autoMs) {
    const m = $('#main');
    if (!m) return;
    clearTimeout(loadTimer);
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (on && !reduce) {
      m.dataset.loading = '1';
      if (autoMs) loadTimer = setTimeout(() => { delete m.dataset.loading; }, autoMs);
    } else {
      delete m.dataset.loading;
    }
  }
  const SVG_ATTR = ' viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const EMPTY_SVG = {
    search: '<svg' + SVG_ATTR + '><circle cx="28" cy="28" r="14"/><path d="M38.5 38.5L52 52"/><path d="M22 28h12" opacity=".6"/></svg>',
    inbox: '<svg' + SVG_ATTR + '><path d="M10 34l8-18h28l8 18v14a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4z"/><path d="M10 34h14a8 8 0 0 0 16 0h14"/></svg>',
    shield: '<svg' + SVG_ATTR + '><path d="M32 8l20 8v14c0 14-9 22-20 26C21 52 12 44 12 30V16z"/><path d="M22 32l8 8 13-14"/></svg>'
  };
  function emptyState(o) {
    return '<div class="empty" role="status">' + (EMPTY_SVG[o.icon] || EMPTY_SVG.inbox) + '<b>' + esc(o.title) + '</b><p>' + esc(o.text) + '</p>' +
      (o.btn ? '<button type="button" class="btn small primary' + (o.engineer ? ' engineer-only' : '') + '" data-empty-act="' + o.act + '">' + esc(o.btn) + '</button>' : '') + '</div>';
  }
  const emptyLi = (o) => '<li style="border:0;background:none;padding:0">' + emptyState(o) + '</li>';

  const STATE_FILL = { 'st-complete': 'var(--c-complete)', 'st-progress': 'var(--c-progress)', 'st-delayed': 'var(--c-delayed)', 'st-pending': 'var(--c-pending)' };
  function stageStatus(v, p, i, firstActive) {
    if (v >= 100) return { cls: 'st-complete', label: 'Complete' };
    if (v > 10) {
      if (p.ragStatus === 'Red' && i === firstActive) return { cls: 'st-delayed', label: 'Delayed' };
      return { cls: 'st-progress', label: 'In Progress' };
    }
    return { cls: 'st-pending', label: 'Scheduled' };
  }
  function meterHTML(v, label, cls) {
    return '<div class="meter ' + cls + '" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + v + '" aria-label="' + esc(label) + '" style="--progress:' + v + '%;--fill:' + STATE_FILL[cls] + '"></div>';
  }
  function rangeHTML(v, label, cls, id, extra) {
    return '<input type="range" class="track ' + cls + (extra ? ' ' + extra : '') + '"' + (id ? ' id="' + id + '"' : '') + ' min="0" max="100" step="1" value="' + v + '" aria-label="' + esc(label) + '" style="--progress:' + v + '%;--fill:' + STATE_FILL[cls] + '">';
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
      return ok;
    }
  }
  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  async function saveFile(blob, suggestedName, types) {
    if (window.showSaveFilePicker) {
      try {
        const h = await window.showSaveFilePicker({ suggestedName, types: types || [] });
        const w = await h.createWritable();
        await w.write(blob); await w.close();
        return 'picker';
      } catch (e) { if (e && e.name === 'AbortError') return 'cancel'; }
    }
    downloadBlob(blob, suggestedName);
    return 'download';
  }
  async function safe(fn, label) {
    try { return await fn(); } catch (e) {
      console.error(label || 'error', e);
      toast((label ? label + ': ' : '') + (e && e.message ? e.message : 'Unexpected error'), { err: true });
    }
  }

  /* ---------------- generic form dialog ---------------- */
  function fieldHTML(f, val) {
    const id = 'f_' + f.name;
    const v = val == null ? (f.default == null ? '' : f.default) : val;
    const req = f.required ? ' required' : '';
    if (f.type === 'checkbox') {
      return '<label class="check"><input type="checkbox" id="' + id + '" name="' + f.name + '"' + (v ? ' checked' : '') + '> ' + esc(f.label) + '</label>';
    }
    let ctl;
    if (f.type === 'select') {
      ctl = '<select id="' + id + '" name="' + f.name + '"' + req + '>' + f.options.map((o) => {
        const ov = typeof o === 'object' ? o.value : o, ol = typeof o === 'object' ? o.label : o;
        return '<option value="' + esc(ov) + '"' + (String(ov) === String(v) ? ' selected' : '') + '>' + esc(ol) + '</option>';
      }).join('') + '</select>';
    } else if (f.type === 'textarea') {
      ctl = '<textarea id="' + id + '" name="' + f.name + '" rows="' + (f.rows || 3) + '"' + req + '>' + esc(v) + '</textarea>';
    } else {
      ctl = '<input id="' + id + '" name="' + f.name + '" type="' + (f.type || 'text') + '" value="' + esc(v) + '"' + req +
        (f.min != null ? ' min="' + f.min + '"' : '') + (f.max != null ? ' max="' + f.max + '"' : '') + (f.type === 'number' ? ' step="any"' : '') + '>';
    }
    return '<label for="' + id + '">' + esc(f.label) + ctl + '</label>';
  }

  function openForm(opts) {
    return new Promise((resolve) => {
      const dlg = $('#formDialog'), form = $('#dialogForm');
      const fields = opts.fields || [];
      $('#formTitle').textContent = opts.title;
      $('#formOk').textContent = opts.okLabel || 'Save';
      $('#formOk').hidden = !!opts.noSubmit;
      $('#formCancel').textContent = opts.cancelLabel || 'Cancel';
      $('#formFields').innerHTML = (opts.bodyHTML || '') + fields.map((f) => fieldHTML(f, (opts.values || {})[f.name])).join('');
      let done = false;
      function finish(val) {
        if (done) return;
        done = true;
        form.removeEventListener('submit', onSubmit);
        $('#formCancel').removeEventListener('click', onCancel);
        dlg.removeEventListener('close', onClose);
        if (dlg.open) dlg.close();
        resolve(val);
      }
      function onSubmit(e) {
        e.preventDefault();
        if (!form.reportValidity()) return;
        const out = {};
        fields.forEach((f) => {
          const el = form.querySelector('[name="' + f.name + '"]');
          out[f.name] = f.type === 'checkbox' ? el.checked : f.type === 'number' ? Number(el.value || 0) : el.value;
        });
        finish(opts.noSubmit ? null : out);
      }
      function onCancel() { finish(null); }
      function onClose() { finish(null); }
      form.addEventListener('submit', onSubmit);
      $('#formCancel').addEventListener('click', onCancel);
      dlg.addEventListener('close', onClose);
      dlg.showModal();
      const first = form.querySelector('input,select,textarea');
      if (first) first.focus();
    });
  }
  const confirmDialog = (title, message, okLabel) =>
    openForm({ title, bodyHTML: '<p>' + esc(message) + '</p>', okLabel: okLabel || 'Confirm' }).then((r) => r !== null);

  /* ---------------- data helpers ---------------- */
  async function loadProjects() {
    state.projects = (await SSDB.getAll('projects')).sort((a, b) => (a.projectCode < b.projectCode ? -1 : 1));
  }
  async function loadParticipants() {
    state.participants = state.projectId ? await SSDB.getAllByIndex('participants', 'projectId', state.projectId) : [];
  }
  const loadDeliverables = (pid) => SSDB.getAllByIndex('deliverables_milestones', 'projectId_category', projRange(pid));
  const loadBlockers = (pid) => SSDB.getAllByIndex('blockers_issues', 'projectId_status', projRange(pid));

  function recomputeOverall(p) {
    p.overallProgress = Math.round(p.stages.reduce((a, b) => a + b, 0) / p.stages.length);
  }
  async function saveProject(p) {
    p.updatedAt = SSDB.nowISO();
    recomputeOverall(p);
    await SSDB.put('projects', p);
    const i = state.projects.findIndex((x) => x.id === p.id);
    if (i >= 0) state.projects[i] = p; else state.projects.push(p);
  }
  async function updateBadge() {
    let open = [];
    try { open = (await SSDB.getAll('blockers_issues')).filter((b) => b.status !== 'Resolved'); } catch (e) { open = []; }
    const mine = open.filter((b) => b.projectId === state.projectId).length;
    const pill = $('#badgePill');
    pill.innerHTML = mine + ' Open (' + open.length + '<span class="pf">&nbsp;Portfolio</span>)';
    pill.className = 'pill' + (mine ? ' warn' : ' ok');
    pill.setAttribute('aria-label', mine + ' open blockers on this project, ' + open.length + ' across the portfolio. Open the Blockers board.');
    try {
      if (navigator.setAppBadge) { if (open.length > 0) await navigator.setAppBadge(open.length); else await navigator.clearAppBadge(); }
    } catch (e) { /* ignore */ }
  }

  /* ---------------- persona, tabs, theme ---------------- */
  function setPersona(p) {
    state.persona = p;
    document.body.dataset.persona = p;
    $$('.persona .seg').forEach((b) => {
      const on = b.dataset.persona === p;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    const mb = $('#modeBar');
    if (mb) mb.hidden = p !== 'client';
    announce(p === 'client' ? 'Client and stakeholder view. Read-only telemetry.' : 'SCADA Engineer command mode.');
    if (p === 'client' && activeTab() === 'vault') showTab('dashboard');
    renderAll();
  }
  const activeTab = () => ($('.tabs [aria-selected="true"]') || {}).dataset ? $('.tabs [aria-selected="true"]').dataset.tab : 'dashboard';
  function showTab(name, focus) {
    $$('.tabs [role="tab"]').forEach((t) => {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    });
    $$('main > section').forEach((s) => { s.hidden = s.id !== 'panel-' + name; });
    setLoading(true, 140);
    if (name === 'vault') safe(renderVault, 'Storage vault');
  }
  function effectiveTheme(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  function applyTheme(pref) {
    if (['auto', 'light', 'dark'].indexOf(pref) === -1) pref = 'auto';
    const t = effectiveTheme(pref);
    document.documentElement.dataset.theme = t;
    document.documentElement.dataset.themePref = pref;
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', t === 'light' ? '#F8FAFC' : '#0B132B'));
    const btn = $('#themeBtn');
    if (btn) btn.textContent = 'Theme: ' + (pref === 'auto' ? 'Auto' : pref === 'light' ? 'Light' : 'Dark');
    lsSet('ss_theme', pref);
  }

  /* ---------------- dashboard ---------------- */
  function kpi(label, value, note, cls) {
    return '<div class="kpi ' + (cls || '') + '"><div class="label">' + esc(label) + '</div><div class="value">' + value + '</div><div class="note">' + note + '</div></div>';
  }
  const pctOf = (n, d) => (d ? Math.round((n / d) * 100) : 0);

  async function renderDashboard() {
    const p = curProject();
    if (!p) return;
    const [blockers, bcPage] = await Promise.all([loadBlockers(p.id), SSDB.pageByProject('status_broadcasts', p.id, { limit: 4 })]);
    const t = p.telemetry || {};
    const open = blockers.filter((b) => b.status !== 'Resolved');
    const hours = open.reduce((s, b) => s + (+b.impactHours || 0), 0);
    const aed = open.reduce((s, b) => s + (+b.expenditureImpactAED || 0), 0);
    const health = Math.round((pctOf(t.opcHealthy, t.opcTotal) + pctOf(t.tagsTested, t.tagsTotal) + pctOf(t.hmiDone, t.hmiTotal)) / 3);
    let ackRate = 0;
    if (bcPage.items.length) {
      const rates = bcPage.items.map((b) => {
        const recips = state.participants.filter((x) => (b.sentToRoles || []).indexOf(x.role) !== -1);
        return recips.length ? Math.min(1, (b.acknowledgments || []).length / recips.length) : 0;
      });
      ackRate = Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 100);
    }
    $('#projTitle').textContent = p.name;
    $('#projMeta').innerHTML = esc(p.projectCode) + ' · ' + esc(p.clientName) + ' · ' + esc(p.location) + ' · PM ' + esc(p.pmName) +
      ' · Target ' + fmtDate(p.targetDate) + ' · RAG <b class="rag-' + esc(p.ragStatus) + '">' + esc(p.ragStatus) + '</b>';
    const qOk = p.qhseStatus === 'Verified';
    $('#kpiGrid').innerHTML =
      kpi('Overall completion', p.overallProgress + '%', meterHTML(p.overallProgress, 'Overall completion', p.ragStatus === 'Green' ? 'st-complete' : 'st-delayed') + 'RAG ' + esc(p.ragStatus), p.ragStatus === 'Green' ? 'ok' : p.ragStatus === 'Amber' ? 'warn' : 'bad') +
      kpi('Wonderware / PLC health', health + '%', 'HMI ' + pctOf(t.hmiDone, t.hmiTotal) + '% · I/O ' + pctOf(t.tagsTested, t.tagsTotal) + '% · Links ' + (t.opcHealthy || 0) + '/' + (t.opcTotal || 0), health >= 80 ? 'ok' : health >= 55 ? 'warn' : 'bad') +
      kpi('Open blockers', open.length, hours + ' h · AED ' + aed.toLocaleString('en-US') + ' impact', open.some((b) => b.severity === 'Critical') ? 'bad' : open.length ? 'warn' : 'ok') +
      kpi('Acknowledgment rate', ackRate + '%', 'Last ' + bcPage.items.length + ' broadcasts', ackRate >= 75 ? 'ok' : 'warn') +
      kpi('QHSE compliance', '<span class="badge ' + (qOk ? 'ok' : 'warn') + '">' + (qOk ? 'Verified' : esc(p.qhseStatus)) + '</span>', 'Annexure-SCT-HR-001', qOk ? 'ok' : 'warn');

    const ro = state.persona === 'client';
    const names = SSDB.STAGES;
    const firstActive = p.stages.findIndex((v) => v > 10 && v < 100);
    $('#pipeline').innerHTML = p.stages.map((v, i) => {
      const st = stageStatus(v, p, i, firstActive);
      return '<li class="stage ' + st.cls + '" data-i="' + i + '"><header><span class="num">' + (i + 1) + '</span><span>' + esc(names[i]) + '</span><span class="badge">' + st.label + '</span></header>' +
        (ro ? meterHTML(v, names[i] + ' progress', st.cls) : rangeHTML(v, names[i] + ' progress', st.cls, 'stage-' + i)) +
        '<div class="stage-foot"><b class="val">' + v + '%</b>' +
        (ro ? '' : '<button type="button" class="btn small" data-act="complete">Mark complete</button><button type="button" class="btn small ghost" data-act="reset">Reset</button>') +
        '</div></li>';
    }).join('');

    $('#telemetryGrid').innerHTML = [
      ['HMI screens', (t.hmiDone || 0) + ' / ' + (t.hmiTotal || 0), pctOf(t.hmiDone, t.hmiTotal) + '% complete'],
      ['PLC I/O tags tested', (t.tagsTested || 0) + ' / ' + (t.tagsTotal || 0), pctOf(t.tagsTested, t.tagsTotal) + '% tested'],
      ['OPC / Modbus links healthy', (t.opcHealthy || 0) + ' / ' + (t.opcTotal || 0), pctOf(t.opcHealthy, t.opcTotal) + '% healthy'],
      ['SQL queries verified', (t.sqlVerified || 0) + ' / ' + (t.sqlTotal || 0), pctOf(t.sqlVerified, t.sqlTotal) + '% verified'],
      ['Protocols in scope', esc(t.protocols || '—'), 'Last update ' + fmtDate(p.updatedAt)]
    ].map((r) => '<div class="tele"><span>' + esc(r[0]) + '</span><b>' + (r[0] === 'Protocols in scope' ? r[1] : esc(r[1])) + '</b><span>' + esc(r[2]) + '</span></div>').join('');
  }

  async function onStageChange(i, value) {
    const p = curProject();
    p.stages[i] = Math.max(0, Math.min(100, value));
    await saveProject(p);
    await renderDashboard();
    await renderDeliverablesIfVisible();
  }
  const renderDeliverablesIfVisible = async () => { if (activeTab() === 'deliverables') await renderDeliverables(); };

  async function editProject(isNew) {
    const p = isNew ? null : curProject();
    const v = p || { ragStatus: 'Green', qhseStatus: 'Verified', leadScadaEngineer: 'SCADA Engineer — Al Gurg A&C' };
    const res = await openForm({
      title: isNew ? 'New project' : 'Edit project',
      values: v,
      fields: [
        { name: 'name', label: 'Project name', required: true },
        { name: 'projectCode', label: 'Project code', required: true, default: 'AGAC-' + new Date().getFullYear() + '-' },
        { name: 'clientName', label: 'Client', required: true },
        { name: 'location', label: 'Location', required: true, default: 'Dubai, U.A.E.' },
        { name: 'ragStatus', label: 'RAG status', type: 'select', options: ['Green', 'Amber', 'Red'] },
        { name: 'pmName', label: 'Project Manager', required: true },
        { name: 'leadScadaEngineer', label: 'Lead SCADA Engineer' },
        { name: 'startDate', label: 'Start date', type: 'date', required: true, default: new Date().toISOString().slice(0, 10) },
        { name: 'targetDate', label: 'Target date', type: 'date', required: true },
        { name: 'qhseStatus', label: 'QHSE (Annexure-SCT-HR-001)', type: 'select', options: ['Verified', 'Review Pending', 'Non-Compliant'] }
      ]
    });
    if (!res) return;
    const proj = p || { id: SSDB.uid('prj'), stages: [0, 0, 0, 0, 0, 0, 0, 0], telemetry: { hmiDone: 0, hmiTotal: 0, tagsTested: 0, tagsTotal: 0, opcHealthy: 0, opcTotal: 0, sqlVerified: 0, sqlTotal: 0, protocols: 'OPC UA, Modbus TCP' } };
    Object.assign(proj, res);
    await saveProject(proj);
    if (isNew) { state.projectId = proj.id; lsSet('ss_project', proj.id); }
    populateProjectSelect();
    await selectProject(state.projectId);
    toast(isNew ? 'Project created' : 'Project updated');
  }

  async function editTelemetry() {
    const p = curProject(); const t = p.telemetry || {};
    const res = await openForm({
      title: 'Update engineering telemetry', values: t,
      fields: [
        { name: 'hmiDone', label: 'HMI screens completed', type: 'number', min: 0 }, { name: 'hmiTotal', label: 'HMI screens total', type: 'number', min: 0 },
        { name: 'tagsTested', label: 'PLC I/O tags tested', type: 'number', min: 0 }, { name: 'tagsTotal', label: 'PLC I/O tags total', type: 'number', min: 0 },
        { name: 'opcHealthy', label: 'OPC/Modbus links healthy', type: 'number', min: 0 }, { name: 'opcTotal', label: 'OPC/Modbus links total', type: 'number', min: 0 },
        { name: 'sqlVerified', label: 'SQL queries verified', type: 'number', min: 0 }, { name: 'sqlTotal', label: 'SQL queries total', type: 'number', min: 0 },
        { name: 'protocols', label: 'Protocols in scope' }
      ]
    });
    if (!res) return;
    p.telemetry = Object.assign({}, t, res);
    await saveProject(p);
    await renderDashboard();
    toast('Telemetry updated');
  }

  /* ---------------- broadcast composer ---------------- */
  function renderRoleChips() {
    $('#cmpRoles').innerHTML = ROLE_GROUPS.map((g, i) =>
      '<label class="check"><input type="checkbox" name="grp" value="' + i + '"' + (i < 3 ? ' checked' : '') + '> ' + esc(g.label) + '</label>').join('');
  }
  async function resetComposer() {
    const p = curProject(); if (!p) return;
    const n = await SSDB.countByProject('status_broadcasts', p.id);
    state.seq = n + 1;
    const now = new Date();
    $('#cmpType').value = 'Weekly';
    $('#cmpRef').value = p.projectCode + '/SR/' + now.getFullYear() + '-W' + String(isoWeek(now)).padStart(2, '0') + (n ? '-' + String(state.seq).padStart(3, '0') : '');
    $('#cmpDoc').value = SSReports.docControlNumber(p, 'TR', state.seq);
    ['#cmpSummary', '#cmpScada', '#cmpPlc', '#cmpSql', '#cmpBom', '#cmpQa'].forEach((s) => { $(s).value = ''; });
    $('#composerMsg').textContent = '';
  }
  function selectedRoles() {
    const out = [];
    $$('#cmpRoles input:checked').forEach((c) => ROLE_GROUPS[+c.value].roles.forEach((r) => out.push(r)));
    return out;
  }
  function gatherBroadcast() {
    const p = curProject();
    return {
      id: SSDB.uid('bc'), projectId: p.id, reportRef: $('#cmpRef').value.trim(), docNo: $('#cmpDoc').value,
      timestamp: SSDB.nowISO(), periodType: $('#cmpType').value,
      executiveSummary: $('#cmpSummary').value.trim(), scadaProgress: $('#cmpScada').value.trim(),
      plcCommStatus: $('#cmpPlc').value.trim(), sqlDbStatus: $('#cmpSql').value.trim(),
      siteSurveyBomStatus: $('#cmpBom').value.trim(), qaQhseNotes: $('#cmpQa').value.trim(),
      sentToRoles: selectedRoles(), acknowledgments: [], archivedQuarter: null
    };
  }
  async function autoFill() {
    const p = curProject();
    const [d, b] = await Promise.all([loadDeliverables(p.id), loadBlockers(p.id)]);
    const t = SSReports.buildTelemetry(p, d, b);
    $('#cmpSummary').value = t.executiveSummary; $('#cmpScada').value = t.scadaProgress; $('#cmpPlc').value = t.plcCommStatus;
    $('#cmpSql').value = t.sqlDbStatus; $('#cmpBom').value = t.siteSurveyBomStatus; $('#cmpQa').value = t.qaQhseNotes;
    $('#composerMsg').textContent = 'Telemetry pulled from HMI, I/O, OPC/Modbus, SQL and blocker data. Review before sending.';
  }
  function requireSummary() {
    if (!$('#cmpSummary').value.trim()) {
      toast('Add an executive summary (or use auto-fill) first', { err: true });
      $('#cmpSummary').focus();
      return false;
    }
    return true;
  }

  async function addOutbox(id) {
    const list = await SSDB.getMeta('outbox', []);
    list.push(id);
    await SSDB.setMeta('outbox', list);
  }
  async function flushQueued() {
    const ids = await SSDB.getMeta('outbox', []);
    if (!ids.length) return 0;
    let n = 0;
    for (const id of ids) {
      const e = await SSDB.get('communication_log', id);
      if (e && e.syncState === 'queued') { e.syncState = 'synced'; e.syncedAt = SSDB.nowISO(); await SSDB.put('communication_log', e); n++; }
    }
    await SSDB.setMeta('outbox', []);
    return n;
  }

  async function saveBroadcast(queued) {
    if (!requireSummary()) return null;
    const p = curProject();
    const b = gatherBroadcast();
    if (!b.reportRef) { toast('Report reference is required', { err: true }); return null; }
    await SSDB.put('status_broadcasts', b);
    const entry = {
      id: SSDB.uid('log'), projectId: p.id, participantId: null, channel: 'Portal Broadcast',
      subject: b.periodType + ' status broadcast ' + b.reportRef, body: b.executiveSummary, direction: 'Outbound',
      attachmentsMeta: [], timestamp: b.timestamp, syncState: queued ? 'queued' : 'synced'
    };
    await SSDB.put('communication_log', entry);
    const touched = state.participants.filter((x) => b.sentToRoles.indexOf(x.role) !== -1);
    touched.forEach((x) => { x.lastContacted = b.timestamp; });
    if (touched.length) await SSDB.putMany('participants', touched);
    p.updatedAt = b.timestamp; await SSDB.put('projects', p);
    if (queued) {
      await addOutbox(entry.id);
      const reg = state.reg || (navigator.serviceWorker && await navigator.serviceWorker.getRegistration());
      let registered = false;
      try { if (reg && reg.sync) { await reg.sync.register('sync-status-broadcasts'); registered = true; } } catch (e) { registered = false; }
      if (!registered && navigator.onLine) { await flushQueued(); toast('Broadcast dispatched'); }
      else toast(navigator.onLine ? 'Queued — background sync will dispatch it' : 'Offline — queued and will dispatch when you reconnect');
    } else {
      toast('Saved to portal feed');
    }
    await resetComposer();
    await Promise.all([renderHistory(true), renderComm(true), renderRaci(), renderDashboard(), refreshQuarterOptions()]);
    return b;
  }

  async function copyWhatsApp() {
    if (!requireSummary()) return;
    const b = gatherBroadcast();
    toast((await copyText(SSReports.whatsappBrief(curProject(), b))) ? 'Brief copied — paste into WhatsApp or Teams' : 'Copy failed', { err: false });
  }
  async function shareBroadcast() {
    if (!requireSummary()) return;
    const p = curProject(); const b = gatherBroadcast();
    const text = SSReports.plainTextBrief(p, b);
    if (navigator.share) {
      try { await navigator.share({ title: 'StatusSync — ' + p.projectCode + ' ' + b.periodType + ' update', text }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    toast((await copyText(text)) ? 'Sharing is not available here — brief copied instead' : 'Share and copy are unavailable', { err: false });
  }
  async function printTransmittal(b) {
    const p = curProject();
    const [blockers] = await Promise.all([loadBlockers(p.id)]);
    const html = SSReports.transmittalHTML({ project: p, broadcast: b, blockers, participants: state.participants, docNo: b.docNo });
    const w = window.open('', '_blank');
    if (w) { w.document.open(); w.document.write(html); w.document.close(); setTimeout(() => { try { w.focus(); } catch (e) { /* ignore */ } }, 200); }
    else { downloadBlob(new Blob([html], { type: 'text/html' }), (b.docNo || 'transmittal') + '.html'); toast('Pop-up blocked — transmittal downloaded; open it and print to PDF'); }
  }

  /* ---------------- broadcast history ---------------- */
  async function refreshQuarterOptions() {
    const p = curProject(); if (!p) return;
    const db = await SSDB.open();
    const keys = await new Promise((res, rej) => {
      const r = db.transaction('status_broadcasts').objectStore('status_broadcasts').index('projectId_timestamp').getAllKeys(projRange(p.id));
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const set = {};
    keys.forEach((k) => { set[SSDB.quarterKey(k[1])] = true; });
    (await SSDB.getAll('archives_cold_storage')).forEach((a) => { set[a.quarterKey] = true; });
    const sel = $('#histQuarter'); const cur = sel.value;
    sel.innerHTML = '<option value="">All quarters</option>' + Object.keys(set).sort().reverse().map((q) => '<option>' + esc(q) + '</option>').join('');
    sel.value = cur;
  }

  function broadcastItemHTML(b) {
    const recips = state.participants.filter((x) => (b.sentToRoles || []).indexOf(x.role) !== -1);
    const acked = (b.acknowledgments || []).map((a) => a.participantId);
    const confirmed = recips.filter((r) => acked.indexOf(r.id) !== -1).length;
    const cells = [
      ['HMI', 'SCADA / HMI', b.scadaProgress, '#7DB1FF'],
      ['I/O', 'PLC / Comms', b.plcCommStatus, '#00F5D4'],
      ['SQL', 'SQL / Historian', b.sqlDbStatus, '#A78BFA'],
      ['BOM', 'Site / BOM', b.siteSurveyBomStatus, '#F59E0B'],
      ['QA', 'QA / QHSE', b.qaQhseNotes, '#10B981']
    ];
    return '<li data-id="' + esc(b.id) + '"><div class="ttl"><span>' + esc(b.reportRef) + '</span><span class="badge ' + (b.periodType === 'Urgent' ? 'bad' : '') + '">' + esc(b.periodType) + '</span><span class="ts">' + fmtDateTime(b.timestamp) + '</span></div>' +
      '<p>' + esc(b.executiveSummary) + '</p>' +
      '<div class="bento">' + cells.map((c) => '<div class="cell" style="--cc:' + c[3] + '"><b><i>' + c[0] + '</i>' + c[1] + '</b><span>' + esc(c[2] || '—') + '</span></div>').join('') + '</div>' +
      '<div class="signoff" role="group" aria-label="Acknowledgments for ' + esc(b.reportRef) + '"><div class="sh"><span>Stakeholder Sign-Off &amp; Acknowledgment</span><span class="so-count">(' + confirmed + '/' + recips.length + ' Confirmed)</span></div>' +
      (recips.length ? recips.map((r) =>
        '<label class="check"><input type="checkbox" class="ack" data-pid="' + esc(r.id) + '"' + (acked.indexOf(r.id) !== -1 ? ' checked' : '') + '> ' + esc(r.name) + '</label>').join('') : '<span class="muted">No recipients matched.</span>') + '</div>' +
      '<div class="row-actions"><button type="button" class="btn small" data-act="print">Transmittal / PDF</button><button type="button" class="btn small" data-act="wa">Copy brief</button></div></li>';
  }

  async function renderHistory(reset) {
    const p = curProject(); if (!p) return;
    const list = $('#historyList');
    if (reset) { state.histBefore = null; list.innerHTML = ''; }
    const q = $('#histSearch').value.trim().toLowerCase(), qt = $('#histQuarter').value;
    const filter = (b) => (!qt || SSDB.quarterKey(b.timestamp) === qt) &&
      (!q || (b.reportRef + ' ' + b.executiveSummary + ' ' + b.scadaProgress + ' ' + b.plcCommStatus + ' ' + b.sqlDbStatus).toLowerCase().indexOf(q) !== -1);
    const { items, nextBefore } = await SSDB.pageByProject('status_broadcasts', p.id, { limit: 15, before: state.histBefore, filter });
    state.histBefore = nextBefore;
    list.insertAdjacentHTML('beforeend', items.map(broadcastItemHTML).join(''));
    if (reset && !items.length && !$('#histArchive').checked) {
      const filtered = !!(q || qt);
      list.innerHTML = emptyLi({ icon: filtered ? 'search' : 'inbox', title: filtered ? 'No broadcasts match' : 'No broadcasts yet',
        text: filtered ? 'Nothing matches the current search or quarter.' : 'Compose your first status broadcast to start the project history.',
        btn: filtered ? 'Reset filters' : 'Compose broadcast', act: filtered ? 'reset-hist' : 'compose', engineer: !filtered });
    }
    $('#histMore').hidden = !nextBefore;
    if (reset && $('#histArchive').checked) {
      let hits = await SSDB.searchArchives(q, p.id);
      if (qt) hits = hits.filter((h) => h.quarterKey === qt);
      hits.filter((h) => h.kind === 'broadcast').slice(0, 40).forEach((h) => {
        list.insertAdjacentHTML('beforeend', '<li data-arch="' + esc(h.quarterKey) + '|' + esc(h.kind) + '|' + esc(h.id) + '"><div class="ttl"><span>Cold archive · ' + esc(h.quarterKey) + '</span><span class="ts">' + fmtDateTime(h.timestamp) + '</span></div><p class="muted">' + esc(h.text) + '</p><div class="row-actions"><button type="button" class="btn small" data-act="viewarch">View archived record</button></div></li>');
      });
    }
  }

  async function viewArchived(spec) {
    const [qk, kind, id] = spec.split('|');
    const rec = await SSDB.loadArchivedRecord(qk, kind, id);
    if (!rec) { toast('Archived record not found', { err: true }); return; }
    const html = kind === 'broadcast'
      ? '<p><b>' + esc(rec.reportRef) + '</b> · ' + esc(rec.periodType) + ' · ' + fmtDateTime(rec.timestamp) + '</p><p>' + esc(rec.executiveSummary) + '</p><p class="muted">' + esc(rec.scadaProgress) + '<br>' + esc(rec.plcCommStatus) + '<br>' + esc(rec.sqlDbStatus) + '</p>'
      : '<p><b>' + esc(rec.subject) + '</b> · ' + esc(rec.channel) + ' · ' + fmtDateTime(rec.timestamp) + '</p><p>' + esc(rec.body) + '</p>';
    await openForm({ title: 'Archived record · ' + qk, bodyHTML: html, noSubmit: true, cancelLabel: 'Close' });
  }

  async function toggleAck(broadcastId, participantId, on) {
    const b = await SSDB.get('status_broadcasts', broadcastId);
    if (!b) return;
    const part = state.participants.find((x) => x.id === participantId);
    b.acknowledgments = (b.acknowledgments || []).filter((a) => a.participantId !== participantId);
    if (on) b.acknowledgments.push({ participantId, name: part ? part.name : '', at: SSDB.nowISO() });
    await SSDB.put('status_broadcasts', b);
    await renderDashboard();
  }

  /* ---------------- RACI ---------------- */
  async function renderRaci() {
    const p = curProject(); if (!p) return;
    await loadParticipants();
    const roleSel = $('#raciRole');
    if (roleSel.options.length <= 1) roleSel.innerHTML = '<option value="">All roles</option>' + ALL_ROLES.map((r) => '<option>' + esc(r) + '</option>').join('');
    const rf = $('#raciFilter').value, ro = roleSel.value;
    const page = await SSDB.pageByProject('status_broadcasts', p.id, { limit: 80 });
    const lastByRole = {};
    page.items.forEach((b) => (b.sentToRoles || []).forEach((r) => { if (!lastByRole[r]) lastByRole[r] = b.timestamp; }));
    const rows = state.participants.filter((x) => (!rf || x.raci === rf) && (!ro || x.role === ro));
    $('#raciTable tbody').innerHTML = rows.map((x) => {
      const last = lastByRole[x.role] || null;
      const d = last ? daysSince(last) : null;
      const overdue = d === null || d > OVERDUE_DAYS;
      const wa = String(x.whatsapp || x.phone || '').replace(/\D/g, '');
      return '<tr class="' + (overdue ? 'overdue' : '') + '" data-id="' + esc(x.id) + '"><td><b>' + esc(x.name) + '</b><br><a href="mailto:' + esc(x.email) + '">' + esc(x.email) + '</a></td><td>' + esc(x.organization) + '</td><td>' + esc(x.role) + '</td>' +
        '<td><span class="badge" title="' + esc(RACI_NAMES[x.raci] || '') + '">' + esc(x.raci) + '</span></td><td>' + esc(x.preferredChannel) + '</td><td>' + (x.lastContacted ? fmtDate(x.lastContacted) : '—') + '</td>' +
        '<td>' + (d === null ? 'Never' : d + ' d') + (overdue ? ' · <b>Overdue</b>' : '') + '</td>' +
        '<td class="engineer-only"><div class="row-actions wrap">' +
        '<button type="button" class="btn small" data-act="log">Log comms</button>' +
        (wa ? '<a class="btn small" target="_blank" rel="noopener" href="https://wa.me/' + wa + '">WhatsApp</a>' : '') +
        '<button type="button" class="btn small" data-act="edit">Edit</button><button type="button" class="btn small danger" data-act="del">Remove</button></div></td></tr>';
    }).join('') || '<tr><td colspan="8">' + emptyState({ icon: 'search', title: (rf || ro) ? 'No participants match' : 'No participants yet',
      text: (rf || ro) ? 'No one on this project has that RACI letter and role together.' : 'Add the client, consultant, PM and internal team to track who needs status updates.',
      btn: (rf || ro) ? 'Reset filters' : 'Add participant', act: (rf || ro) ? 'reset-raci' : 'add-participant', engineer: !(rf || ro) }) + '</td></tr>';
  }

  async function editParticipant(existing, prefill) {
    const v = Object.assign({ role: 'Client', raci: 'I', preferredChannel: 'Email Transmittal' }, existing || {}, prefill || {});
    const res = await openForm({
      title: existing ? 'Edit participant' : 'Add participant', values: v,
      fields: [
        { name: 'name', label: 'Name', required: true }, { name: 'organization', label: 'Organisation', required: true },
        { name: 'role', label: 'Role', type: 'select', options: ALL_ROLES },
        { name: 'raci', label: 'RACI', type: 'select', options: [{ value: 'R', label: 'R — Responsible' }, { value: 'A', label: 'A — Accountable' }, { value: 'C', label: 'C — Consulted' }, { value: 'I', label: 'I — Informed' }] },
        { name: 'email', label: 'Email', type: 'email' }, { name: 'phone', label: 'Phone / WhatsApp', type: 'tel' },
        { name: 'preferredChannel', label: 'Preferred channel', type: 'select', options: CHANNELS }
      ]
    });
    if (!res) return;
    const row = Object.assign(existing || { id: SSDB.uid('par'), projectId: state.projectId, lastContacted: null, whatsapp: '' }, res);
    row.whatsapp = row.phone;
    await SSDB.put('participants', row);
    await Promise.all([renderRaci(), renderDashboard()]);
    toast(existing ? 'Participant updated' : 'Participant added');
  }
  async function pickContact() {
    if (navigator.contacts && navigator.contacts.select) {
      try {
        const r = await navigator.contacts.select(['name', 'email', 'tel'], { multiple: false });
        if (r && r.length) { await editParticipant(null, { name: (r[0].name || [])[0] || '', email: (r[0].email || [])[0] || '', phone: (r[0].tel || [])[0] || '' }); return; }
        return;
      } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    toast('Contact Picker is not available on this device — enter the details manually');
    await editParticipant(null, null);
  }
  async function logCommunication(part) {
    const res = await openForm({
      title: 'Log communication' + (part ? ' · ' + part.name : ''),
      values: { channel: part && part.preferredChannel && part.preferredChannel !== 'Portal Broadcast' ? part.preferredChannel : 'MOM', direction: 'Outbound' },
      fields: [
        { name: 'channel', label: 'Type', type: 'select', options: CHANNELS },
        { name: 'direction', label: 'Direction', type: 'select', options: ['Outbound', 'Inbound'] },
        { name: 'subject', label: 'Subject', required: true },
        { name: 'body', label: 'Details (RFI, clarification, site access permit, MOM actions…)', type: 'textarea', rows: 4 }
      ]
    });
    if (!res) return;
    const ts = SSDB.nowISO();
    await SSDB.put('communication_log', Object.assign({ id: SSDB.uid('log'), projectId: state.projectId, participantId: part ? part.id : null, attachmentsMeta: [], timestamp: ts, syncState: 'synced' }, res));
    if (part) { part.lastContacted = ts; await SSDB.put('participants', part); }
    await Promise.all([renderComm(true), renderRaci()]);
    toast('Communication logged');
  }

  async function renderComm(reset) {
    const p = curProject(); if (!p) return;
    const list = $('#commList');
    if (reset) { state.commBefore = null; list.innerHTML = ''; }
    const { items, nextBefore } = await SSDB.pageByProject('communication_log', p.id, { limit: 20, before: state.commBefore });
    state.commBefore = nextBefore;
    list.insertAdjacentHTML('beforeend', items.map((e) => {
      const who = state.participants.find((x) => x.id === e.participantId);
      return '<li><div class="ttl"><span>' + esc(e.subject) + '</span><span class="badge">' + esc(e.channel) + '</span>' +
        (e.syncState === 'queued' ? '<span class="badge warn">Queued</span>' : '') + '<span class="ts">' + fmtDateTime(e.timestamp) + ' · ' + esc(e.direction) + (who ? ' · ' + esc(who.name) : '') + '</span></div>' +
        (e.body ? '<p>' + esc(e.body) + '</p>' : '') +
        ((e.attachmentsMeta || []).length ? '<p class="muted">Attachments: ' + e.attachmentsMeta.map((a) => esc(a.name)).join(', ') + '</p>' : '') + '</li>';
    }).join(''));
    if (reset && !items.length) list.innerHTML = emptyLi({ icon: 'inbox', title: 'No communication logged yet', text: 'RFIs, MOMs, clarifications and broadcasts will appear here.' });
    $('#commMore').hidden = !nextBefore;
  }

  /* ---------------- deliverables ---------------- */
  async function renderDeliverables() {
    const p = curProject(); if (!p) return;
    const catSel = $('#delCategory');
    if (catSel.options.length <= 1) catSel.innerHTML = '<option value="">All categories</option>' + CATEGORIES.map((c) => '<option>' + esc(c) + '</option>').join('');
    const cf = catSel.value, sf = $('#delStatus').value;
    const all = (await loadDeliverables(p.id)).filter((d) => (!cf || d.category === cf) && (!sf || d.status === sf));
    const ro = state.persona === 'client';
    const groups = {};
    all.forEach((d) => { (groups[d.category] = groups[d.category] || []).push(d); });
    const STC = { 'Complete': ['st-complete', 'ok'], 'In Progress': ['st-progress', 'info'], 'Blocked': ['st-delayed', 'warn'], 'Not Started': ['st-pending', ''] };
    const html = CATEGORIES.filter((c) => groups[c]).map((c) =>
      '<div class="del-group"><h3>' + esc(c) + '</h3>' + groups[c].map((d) => {
        const sc = STC[d.status] || STC['Not Started'];
        return '<div class="del-row ' + sc[0] + '" data-id="' + esc(d.id) + '"><div class="t"><b>' + esc(d.title) + '</b><span>Owner ' + esc(d.owner) + ' · Due ' + fmtDate(d.dueDate) + '</span></div>' +
          (ro ? '<span class="badge ' + sc[1] + '">' + esc(d.status) + '</span>'
            : '<select class="d-status" aria-label="Status for ' + esc(d.title) + '">' + STATUSES.map((s) => '<option' + (s === d.status ? ' selected' : '') + '>' + s + '</option>').join('') + '</select>') +
          '<div class="pv">' + (ro ? meterHTML(d.progress, d.title + ' progress', sc[0]) : rangeHTML(d.progress, d.title + ' progress', sc[0], null, 'd-prog')) + '<b class="val d-val">' + d.progress + '%</b></div>' +
          '<label class="check"><input type="checkbox" class="d-sign"' + (d.clientSignOff ? ' checked' : '') + '> Client sign-off</label>' +
          '<div class="row-actions engineer-only"><button type="button" class="btn small" data-act="edit">Edit</button><button type="button" class="btn small danger" data-act="del">Delete</button></div></div>';
      }).join('') + '</div>').join('');
    const filtered = !!(cf || sf);
    $('#deliverableList').innerHTML = html || emptyState({ icon: 'search', title: filtered ? 'No deliverables match' : 'No deliverables yet',
      text: filtered ? 'No checklist item fits this category and status.' : 'Add Wonderware, HMI, comms, SQL, BOM, FAT/SAT and training items to track.',
      btn: filtered ? 'Reset filters' : 'Add deliverable', act: filtered ? 'reset-del' : 'add-deliverable', engineer: !filtered });
  }
  async function updateDeliverable(id, patch) {
    const d = await SSDB.get('deliverables_milestones', id);
    if (!d) return null;
    Object.assign(d, patch);
    if (patch.progress != null) {
      if (d.progress >= 100) d.status = 'Complete';
      else if (d.progress > 0 && (d.status === 'Not Started' || d.status === 'Complete')) d.status = 'In Progress';
      else if (d.progress === 0 && d.status !== 'Blocked') d.status = 'Not Started';
    }
    if (patch.status === 'Complete') d.progress = 100;
    await SSDB.put('deliverables_milestones', d);
    return d;
  }
  async function editDeliverable(existing) {
    const res = await openForm({
      title: existing ? 'Edit deliverable' : 'Add deliverable',
      values: existing || { category: CATEGORIES[0], status: 'Not Started', progress: 0, owner: 'SCADA Engineer' },
      fields: [
        { name: 'category', label: 'Category', type: 'select', options: CATEGORIES },
        { name: 'title', label: 'Deliverable / checklist item', required: true },
        { name: 'status', label: 'Status', type: 'select', options: STATUSES },
        { name: 'progress', label: 'Progress %', type: 'number', min: 0, max: 100 },
        { name: 'owner', label: 'Owner' },
        { name: 'dueDate', label: 'Due date', type: 'date', required: true, default: new Date().toISOString().slice(0, 10) },
        { name: 'clientSignOff', label: 'Client signed off', type: 'checkbox' }
      ]
    });
    if (!res) return;
    const row = Object.assign(existing || { id: SSDB.uid('dlv'), projectId: state.projectId }, res);
    row.progress = Math.max(0, Math.min(100, row.progress));
    if (row.status === 'Complete') row.progress = 100;
    await SSDB.put('deliverables_milestones', row);
    await renderDeliverables();
    toast('Deliverable saved');
  }
  async function exportDeliverables() {
    const p = curProject();
    const rows = await loadDeliverables(p.id);
    const csv = SSReports.toCSV(rows, ['category', 'title', 'status', 'progress', 'dueDate', 'owner', 'clientSignOff']);
    await saveFile(new Blob([csv], { type: 'text/csv' }), p.projectCode + '-deliverables.csv', [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }]);
    toast('Deliverables exported');
  }

  /* ---------------- blockers ---------------- */
  async function renderBlockers() {
    const p = curProject(); if (!p) return;
    const all = await loadBlockers(p.id);
    const ro = state.persona === 'client';
    const open = all.filter((b) => b.status !== 'Resolved');
    const hrs = open.reduce((s, b) => s + (+b.impactHours || 0), 0);
    const aed = open.reduce((s, b) => s + (+b.expenditureImpactAED || 0), 0);
    const resolvedAed = all.filter((b) => b.status === 'Resolved').reduce((s, b) => s + (+b.expenditureImpactAED || 0), 0);
    $('#blockerKpis').innerHTML =
      kpi('Open blockers', open.length, open.filter((b) => b.severity === 'Critical' || b.severity === 'High').length + ' critical / high', open.length ? 'warn' : 'ok') +
      kpi('Working-hours impact', hrs + ' h', 'Open items only', hrs > 80 ? 'bad' : hrs ? 'warn' : 'ok') +
      kpi('Expenditure variance', 'AED ' + aed.toLocaleString('en-US'), 'Open exposure', aed > 30000 ? 'bad' : aed ? 'warn' : 'ok') +
      kpi('Absorbed (resolved)', 'AED ' + resolvedAed.toLocaleString('en-US'), 'Closed items', 'ok');
    const cols = ['Open', 'Escalated to PM', 'Resolved'];
    const sevOrder = { Critical: 0, High: 1, Medium: 2, Low: 3 };
    const emptyCol = {
      'Open': { icon: 'shield', title: 'No open blockers', text: 'Nothing is waiting on the team right now.', btn: 'Log blocker', act: 'add-blocker', engineer: true },
      'Escalated to PM': { icon: 'inbox', title: 'No escalations', text: 'Escalate a blocker to the PM when it threatens the critical path.' },
      'Resolved': { icon: 'inbox', title: 'Nothing resolved yet', text: 'Closed blockers and the cost they absorbed appear here.' }
    };
    const card = (b) => '<div class="bcard sev-' + esc(b.severity) + '" data-id="' + esc(b.id) + '"><h3>' + esc(b.title) + '</h3>' +
      '<div class="meta"><span class="badge ' + (b.severity === 'Critical' ? 'bad' : b.severity === 'High' ? 'warn' : '') + '">' + esc(b.severity) + '</span> ' + esc(b.subsystem) + ' · Owner ' + esc(b.assignedTo) + '</div>' +
      '<div class="meta">Raised ' + fmtDate(b.raisedDate) + ' · Target ' + fmtDate(b.targetResolutionDate) + '</div>' +
      '<div class="meta"><b>' + (+b.impactHours || 0) + ' h</b> · <b>AED ' + (+b.expenditureImpactAED || 0).toLocaleString('en-US') + '</b></div>' +
      (b.resolutionNotes ? '<p style="margin:6px 0 0;font-size:.85rem">' + esc(b.resolutionNotes).replace(/\n/g, '<br>') + '</p>' : '') +
      (ro ? '' : '<div class="row-actions">' +
        (b.status === 'Open' ? '<button type="button" class="btn small primary" data-act="escalate">Escalate to PM →</button>' : '') +
        (b.status !== 'Resolved' ? '<button type="button" class="btn small" data-act="resolve">Mark Resolved ✓</button>' : '<button type="button" class="btn small" data-act="reopen">Reopen</button>') +
        '<button type="button" class="btn small" data-act="note">Log mitigation</button><button type="button" class="btn small" data-act="edit">Edit</button><button type="button" class="btn small danger" data-act="del">Delete</button></div>') + '</div>';
    $('#blockerBoard').innerHTML = cols.map((st) => {
      const items = all.filter((b) => b.status === st).sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
      return '<div class="col" data-status="' + st + '"><h2>' + st + ' <span class="badge">' + items.length + '</span></h2>' + (items.map(card).join('') || emptyState(emptyCol[st])) + '</div>';
    }).join('');
  }
  async function editBlocker(existing) {
    const res = await openForm({
      title: existing ? 'Edit blocker' : 'Log PM blocker',
      values: existing || { severity: 'Medium', status: 'Open', assignedTo: curProject().pmName, subsystem: 'SCADA', impactHours: 0, expenditureImpactAED: 0 },
      fields: [
        { name: 'title', label: 'Blocker', required: true },
        { name: 'severity', label: 'Severity', type: 'select', options: ['Critical', 'High', 'Medium', 'Low'] },
        { name: 'subsystem', label: 'Subsystem', required: true },
        { name: 'assignedTo', label: 'Assigned to', required: true },
        { name: 'status', label: 'Status', type: 'select', options: ['Open', 'Escalated to PM', 'Resolved'] },
        { name: 'targetResolutionDate', label: 'Target resolution', type: 'date', required: true, default: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10) },
        { name: 'impactHours', label: 'Working hours impact (h)', type: 'number', min: 0 },
        { name: 'expenditureImpactAED', label: 'Expenditure impact (AED)', type: 'number', min: 0 },
        { name: 'resolutionNotes', label: 'Mitigation / resolution notes', type: 'textarea' }
      ]
    });
    if (!res) return;
    const row = Object.assign(existing || { id: SSDB.uid('blk'), projectId: state.projectId, raisedDate: new Date().toISOString().slice(0, 10) }, res);
    await SSDB.put('blockers_issues', row);
    await Promise.all([renderBlockers(), renderDashboard(), updateBadge()]);
    toast('Blocker saved');
  }
  async function blockerAction(id, act) {
    const b = await SSDB.get('blockers_issues', id);
    if (!b) return;
    if (act === 'edit') return editBlocker(b);
    if (act === 'del') {
      if (!(await confirmDialog('Delete blocker', 'Delete "' + b.title + '" permanently?', 'Delete'))) return;
      await SSDB.del('blockers_issues', id);
    } else if (act === 'escalate') {
      b.status = 'Escalated to PM';
      b.resolutionNotes = (b.resolutionNotes ? b.resolutionNotes + '\n' : '') + fmtDate(SSDB.nowISO()) + ': escalated to ' + curProject().pmName + '.';
      await SSDB.put('blockers_issues', b);
      toast('Escalated to ' + curProject().pmName);
    } else if (act === 'resolve') {
      const r = await openForm({ title: 'Resolve blocker', values: { note: '' }, fields: [{ name: 'note', label: 'Resolution notes', type: 'textarea', required: true }], okLabel: 'Mark resolved' });
      if (!r) return;
      b.status = 'Resolved'; b.resolutionNotes = (b.resolutionNotes ? b.resolutionNotes + '\n' : '') + fmtDate(SSDB.nowISO()) + ': ' + r.note;
      await SSDB.put('blockers_issues', b);
    } else if (act === 'reopen') {
      b.status = 'Open'; await SSDB.put('blockers_issues', b);
    } else if (act === 'note') {
      const r = await openForm({ title: 'Log mitigation action', fields: [{ name: 'note', label: 'Mitigation action', type: 'textarea', required: true }] });
      if (!r) return;
      b.resolutionNotes = (b.resolutionNotes ? b.resolutionNotes + '\n' : '') + fmtDate(SSDB.nowISO()) + ': ' + r.note;
      await SSDB.put('blockers_issues', b);
    }
    await Promise.all([renderBlockers(), renderDashboard(), updateBadge()]);
  }

  /* ---------------- storage vault ---------------- */
  async function renderVault() {
    const t = await SSDB.storageTelemetry();
    const pct = Math.min(100, t.usedPercent);
    $('#gaugeFill').style.width = Math.max(1, pct) + '%';
    $('#miniFill').style.width = Math.max(1, pct) + '%';
    $('#miniText').textContent = fmtBytes(t.usageBytes) + ' of ' + (t.quotaBytes ? fmtBytes(t.quotaBytes) : 'unknown');
    const years = t.yearsRemaining == null ? 'n/a' : (t.yearsRemaining >= 50 ? '50+ years' : t.yearsRemaining.toFixed(1) + ' years');
    const proj3 = t.threeYearTargetBytes ? fmtBytes(t.threeYearTargetBytes) + (t.quotaBytes ? ' (' + ((t.threeYearTargetBytes / t.quotaBytes) * 100).toFixed(2) + '% of quota)' : '') : 'n/a';
    const attBytes = await SSDB.OPFS.totalBytes();
    $('#storageStats').innerHTML =
      '<dt>Used</dt><dd>' + fmtBytes(t.usageBytes) + '</dd><dt>Total quota</dt><dd>' + (t.quotaBytes ? fmtBytes(t.quotaBytes) : 'n/a') + '</dd>' +
      '<dt>Persistence</dt><dd><span class="badge ' + (t.persisted ? 'ok' : 'warn') + '">' + (t.persisted ? 'Granted' : 'Best-Effort') + '</span></dd>' +
      '<dt>Total records</dt><dd>' + t.totalRecords.toLocaleString('en-US') + '</dd>' +
      '<dt>Capacity remaining</dt><dd>' + years + '</dd><dt>Projected 3-year size</dt><dd>' + proj3 + '</dd>' +
      '<dt>Attachments</dt><dd>' + fmtBytes(attBytes) + ' (' + (t.opfsSupported ? 'OPFS' : 'IndexedDB fallback') + ')</dd>' +
      '<dt>Broadcasts / log entries</dt><dd>' + (t.perStore.status_broadcasts || 0) + ' / ' + (t.perStore.communication_log || 0) + '</dd>';
    await Promise.all([renderAttachments(), renderArchives(), renderPwaBoard()]);
  }
  async function miniGauge() {
    const t = await SSDB.storageTelemetry().catch(() => null);
    if (!t) return;
    $('#miniFill').style.width = Math.max(1, Math.min(100, t.usedPercent)) + '%';
    $('#miniText').textContent = fmtBytes(t.usageBytes) + ' of ' + (t.quotaBytes ? fmtBytes(t.quotaBytes) : 'unknown') + ' · ' + (t.persisted ? 'Persistent' : 'Best-Effort');
  }
  async function renderAttachments() {
    const p = curProject(); if (!p) return;
    const list = await SSDB.OPFS.list(p.id);
    $('#attachList').innerHTML = list.length ? list.map((a) =>
      '<li data-id="' + esc(a.id) + '"><span><b>' + esc(a.name) + '</b><br><small class="muted">' + fmtBytes(a.size) + ' · ' + esc(a.storage.toUpperCase()) + ' · ' + fmtDate(a.createdAt) + '</small></span>' +
      '<span class="row-actions"><button type="button" class="btn small" data-act="dl">Download</button><button type="button" class="btn small danger" data-act="rm">Delete</button></span></li>').join('')
      : '<li class="muted">No attachments for this project.</li>';
  }
  async function addAttachments(files) {
    const p = curProject();
    let n = 0;
    for (const f of files) { await SSDB.OPFS.save(p.id, f); n++; }
    toast(n + ' file(s) stored on this device');
    await renderVault();
  }
  async function renderArchives() {
    const arch = (await SSDB.getAll('archives_cold_storage')).sort((a, b) => (a.quarterKey < b.quarterKey ? 1 : -1));
    $('#archiveList').innerHTML = arch.length ? arch.map((a) =>
      '<li data-q="' + esc(a.quarterKey) + '"><span><b>' + esc(a.quarterKey) + '</b> · ' + a.recordCount + ' records<br><small class="muted">Compressed ' + fmtDate(a.createdAt) + ' · ' + esc(a.compressedPayload.encoding) + ' · ' + fmtBytes(a.compressedPayload.data.length) + '</small></span>' +
      '<button type="button" class="btn small" data-act="restore">Restore to live feed</button></li>').join('')
      : '<li class="muted">No quarters archived yet.</li>';
  }
  async function compact(dry) {
    const s = await SSDB.compactArchives({ dryRun: dry });
    const msg = !s.recordsArchived ? 'Nothing older than ' + SSDB.HOT_RETENTION_MONTHS + ' months to archive.'
      : (dry ? 'Would archive ' : 'Archived ') + s.recordsArchived + ' records into ' + s.quarters.length + ' quarter(s) (' + s.quarters.map((q) => q.quarterKey).join(', ') + '); ' +
        fmtBytes(s.bytesBefore) + ' raw → ' + fmtBytes(s.bytesAfter) + ' stored.';
    $('#compactMsg').textContent = msg;
    if (!dry) {
      toast(s.recordsArchived ? 'Cold archive updated' : 'Nothing to archive');
      await Promise.all([renderVault(), renderHistory(true), renderComm(true), refreshQuarterOptions()]);
    }
  }
  async function exportSnapshot() {
    const snap = await SSDB.exportSnapshot();
    const name = 'statussync-snapshot-' + new Date().toISOString().slice(0, 10) + '.json';
    const how = await saveFile(new Blob([JSON.stringify(snap)], { type: 'application/json' }), name, [{ description: 'StatusSync snapshot', accept: { 'application/json': ['.json'] } }]);
    if (how !== 'cancel') $('#backupMsg').textContent = 'Snapshot saved: ' + name + ' (' + Object.values(snap.stores).reduce((s, r) => s + r.length, 0).toLocaleString('en-US') + ' records).';
  }
  async function importSnapshotFile(file, replace) {
    let snap;
    try { snap = JSON.parse(await file.text()); } catch (e) { toast('That file is not valid JSON', { err: true }); return; }
    const n = await SSDB.importSnapshot(snap, { replace });
    await loadProjects();
    if (!state.projects.find((p) => p.id === state.projectId)) state.projectId = state.projects[0] && state.projects[0].id;
    populateProjectSelect();
    await selectProject(state.projectId);
    $('#backupMsg').textContent = 'Imported ' + n.toLocaleString('en-US') + ' records' + (replace ? ' (replaced existing data)' : ' (merged)') + '.';
    toast('Snapshot imported');
  }
  async function pickAndImport() {
    const replace = $('#importReplace').checked;
    if (window.showOpenFilePicker) {
      try {
        const [h] = await window.showOpenFilePicker({ types: [{ description: 'StatusSync snapshot', accept: { 'application/json': ['.json'] } }] });
        await importSnapshotFile(await h.getFile(), replace);
        return;
      } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    $('#importInput').click();
  }

  /* ---------------- PWA diagnostics ---------------- */
  async function renderPwaBoard() {
    const t = await SSDB.storageTelemetry();
    const reg = state.reg || (navigator.serviceWorker ? await navigator.serviceWorker.getRegistration() : null);
    const swState = !('serviceWorker' in navigator) ? 'Unsupported' : reg ? (reg.waiting ? 'Update waiting' : reg.active ? 'Active (' + reg.active.state + ')' : reg.installing ? 'Installing' : 'Registered') : 'Not registered';
    const staticRoute = typeof InstallEvent !== 'undefined' && InstallEvent.prototype && 'addRoutes' in InstallEvent.prototype;
    const display = window.matchMedia('(display-mode: window-controls-overlay)').matches ? 'Window Controls Overlay'
      : window.matchMedia('(display-mode: standalone)').matches || navigator.standalone ? 'Standalone' : 'Browser tab';
    const yes = (b) => (b ? 'Supported' : 'Unavailable');
    const tiles = [
      ['Service Worker', swState, swState.indexOf('Active') === 0],
      ['Static Routing API', staticRoute ? 'Supported' : 'Not in this browser (normal fetch path)', staticRoute],
      ['Persistent storage', t.persisted ? 'Granted' : 'Best-Effort', t.persisted],
      ['Badging API', yes('setAppBadge' in navigator), 'setAppBadge' in navigator],
      ['Network', navigator.onLine ? 'Online' : 'Offline', navigator.onLine],
      ['Display mode', display, true],
      ['Background Sync', yes('serviceWorker' in navigator && 'SyncManager' in window), 'SyncManager' in window],
      ['Periodic Sync', yes('PeriodicSyncManager' in window), 'PeriodicSyncManager' in window],
      ['Push / Notifications', ('Notification' in window ? 'Permission: ' + Notification.permission : 'Unavailable'), 'Notification' in window && Notification.permission === 'granted'],
      ['OPFS', yes(t.opfsSupported), t.opfsSupported],
      ['File System Access', yes(!!window.showSaveFilePicker), !!window.showSaveFilePicker],
      ['File handlers', yes('launchQueue' in window), 'launchQueue' in window],
      ['Web Share', yes(!!navigator.share), !!navigator.share],
      ['Contact Picker', yes(!!(navigator.contacts && navigator.contacts.select)), !!(navigator.contacts && navigator.contacts.select)],
      ['Compression Streams', yes(typeof CompressionStream !== 'undefined'), typeof CompressionStream !== 'undefined']
    ];
    $('#pwaBoard').innerHTML = tiles.map((x) => '<div class="tele"><span>' + esc(x[0]) + '</span><b>' + esc(x[1]) + '</b><span><span class="badge ' + (x[2] ? 'ok' : 'warn') + '">' + (x[2] ? 'OK' : 'Limited') + '</span></span></div>').join('') +
      '<div class="tele"><span>Notifications &amp; sync</span><div class="row-actions wrap"><button type="button" class="btn small" id="notifyBtn">Enable notifications</button><button type="button" class="btn small" id="periodicBtn">Enable periodic check</button></div></div>';
  }
  async function enableNotifications() {
    if (!('Notification' in window)) { toast('Notifications are not supported here', { err: true }); return; }
    const r = await Notification.requestPermission();
    toast('Notification permission: ' + r);
    renderPwaBoard();
  }
  async function enablePeriodic() {
    try {
      const reg = state.reg || await navigator.serviceWorker.ready;
      if (!reg.periodicSync) { toast('Periodic Background Sync is not available in this browser'); return; }
      await reg.periodicSync.register('periodic-status-check', { minInterval: 12 * 3600 * 1000 });
      toast('Periodic status check registered');
    } catch (e) { toast('Periodic sync needs the installed app and permission', { err: true }); }
  }

  /* ---------------- project selection ---------------- */
  function populateProjectSelect() {
    $('#projectSelect').innerHTML = state.projects.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.projectCode + ' — ' + p.name) + '</option>').join('');
    $('#projectSelect').value = state.projectId;
  }
  async function selectProject(id) {
    setLoading(true);
    const t0 = Date.now();
    try {
      if (id) state.projectId = id;
      lsSet('ss_project', state.projectId);
      $('#projectSelect').value = state.projectId;
      await loadParticipants();
      await resetComposer();
      await renderAll();
      const p = curProject();
      if (p) announce('Showing ' + p.projectCode + ', ' + p.name);
    } finally {
      setTimeout(() => setLoading(false), Math.max(0, 220 - (Date.now() - t0)));
    }
  }
  async function renderAll() {
    await safe(async () => {
      await loadParticipants();
      await Promise.all([renderDashboard(), refreshQuarterOptions()]);
      await Promise.all([renderHistory(true), renderRaci(), renderComm(true), renderDeliverables(), renderBlockers()]);
      await updateBadge();
      miniGauge();
      if (activeTab() === 'vault') renderVault();
    }, 'Render');
  }

  /* ---------------- share target / protocol / file handlers ---------------- */
  async function handleShare(params) {
    let title = params.get('title') || '', text = params.get('text') || '', url = params.get('url') || '';
    const files = [];
    const key = params.get('shareKey');
    if (key && 'caches' in window) {
      try {
        const c = await caches.open('STATUSSYNC_SHARE');
        const meta = await c.match('./__share/' + key + '/meta');
        if (meta) {
          const m = await meta.json();
          title = m.title || title; text = m.text || text; url = m.url || url;
          for (let i = 0; i < (m.count || 0); i++) {
            const r = await c.match('./__share/' + key + '/file/' + i);
            if (r) files.push(new File([await r.blob()], decodeURIComponent(r.headers.get('X-Filename') || 'shared-file'), { type: r.headers.get('Content-Type') || 'application/octet-stream' }));
          }
        }
        const keys = await c.keys();
        await Promise.all(keys.filter((k) => k.url.indexOf('/__share/' + key + '/') !== -1).map((k) => c.delete(k)));
      } catch (e) { /* ignore */ }
    }
    if (!title && !text && !url && !files.length) return;
    const res = await openForm({
      title: 'Add shared content to communication log',
      values: { channel: 'Technical Clarification', subject: title || (text || url || 'Shared item').slice(0, 80), body: [text, url].filter(Boolean).join('\n') },
      bodyHTML: files.length ? '<p class="muted">' + files.length + ' file(s) will be stored as attachments: ' + files.map((f) => esc(f.name)).join(', ') + '</p>' : '',
      fields: [
        { name: 'channel', label: 'Type', type: 'select', options: CHANNELS },
        { name: 'subject', label: 'Subject', required: true },
        { name: 'body', label: 'Details', type: 'textarea', rows: 4 }
      ]
    });
    if (!res) return;
    const metas = [];
    for (const f of files) { const m = await SSDB.OPFS.save(state.projectId, f); metas.push({ id: m.id, name: m.name, size: m.size }); }
    await SSDB.put('communication_log', Object.assign({ id: SSDB.uid('log'), projectId: state.projectId, participantId: null, direction: 'Inbound', attachmentsMeta: metas, timestamp: SSDB.nowISO(), syncState: 'synced' }, res));
    await renderComm(true);
    showTab('raci');
    toast('Shared content logged');
  }
  async function handleProtocol(raw) {
    const m = String(raw || '').replace(/^web\+statussync:\/*/i, '').replace(/^web%2Bstatussync%3A%2F*/i, '');
    const parts = decodeURIComponent(m).split('/').filter(Boolean);
    if (parts[0] === 'project' && parts[1]) {
      const p = state.projects.find((x) => x.projectCode.toLowerCase() === parts[1].toLowerCase());
      if (p) { await selectProject(p.id); toast('Opened ' + p.projectCode); }
      else toast('No project with code ' + parts[1], { err: true });
      if (parts[2] && $('#tab-' + parts[2])) showTab(parts[2]);
    }
  }
  async function handleLaunchFile(handle) {
    const file = await handle.getFile();
    if (/\.json$/i.test(file.name)) {
      let snap = null;
      try { snap = JSON.parse(await file.text()); } catch (e) { snap = null; }
      if (snap && snap.app === 'StatusSync Portal') {
        if (await confirmDialog('Import snapshot', 'Merge "' + file.name + '" into this device\'s data?', 'Import')) {
          const n = await SSDB.importSnapshot(snap, { replace: false });
          await loadProjects(); populateProjectSelect(); await selectProject(state.projectId);
          toast('Imported ' + n.toLocaleString('en-US') + ' records');
        }
        return;
      }
    }
    const text = (await file.text()).slice(0, 4000);
    await SSDB.put('communication_log', { id: SSDB.uid('log'), projectId: state.projectId, participantId: null, channel: 'Technical Clarification', subject: 'Imported file: ' + file.name, body: text, direction: 'Inbound', attachmentsMeta: [], timestamp: SSDB.nowISO(), syncState: 'synced' });
    await renderComm(true); showTab('raci'); toast('File content logged to communication log');
  }

  async function processUrlActions() {
    const params = new URLSearchParams(location.search);
    const action = params.get('action');
    if (action === 'broadcast') { showTab('broadcast'); setTimeout(() => $('#cmpSummary') && $('#cmpSummary').focus(), 50); }
    else if (action === 'blocker') { showTab('blockers'); if (state.persona === 'engineer') editBlocker(null); }
    else if (action === 'client') { setPersona('client'); showTab('dashboard'); }
    else if (action === 'export') {
      showTab('broadcast');
      const { items } = await SSDB.pageByProject('status_broadcasts', state.projectId, { limit: 1 });
      if (items[0]) printTransmittal(items[0]); else toast('No broadcast yet — compose one first');
    }
    if (params.get('share')) await handleShare(params);
    if (params.get('protocol')) await handleProtocol(params.get('protocol'));
    if (action || params.get('share') || params.get('protocol')) { try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ } }
  }

  /* ---------------- service worker + install ---------------- */
  function showUpdate(worker) {
    state.waiting = worker;
    $('#updateBanner').hidden = false;
  }
  async function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      state.reg = reg;
      if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdate(nw); });
      });
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloading) return; reloading = true; location.reload(); });
      navigator.serviceWorker.addEventListener('message', async (e) => {
        const d = e.data || {};
        if (d.type === 'SYNC_COMPLETE') { toast(d.count + ' queued broadcast(s) dispatched'); renderComm(true); }
        if (d.type === 'PERIODIC_CHECK') updateBadge();
        if (d.type === 'ACK_NOTIFICATION') toast('Notification acknowledged');
      });
    } catch (e) { console.warn('SW registration failed', e); }
  }

  function isStandalone() {
    try {
      return window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: window-controls-overlay)').matches || navigator.standalone === true;
    } catch (e) { return false; }
  }
  function detectPlatform() {
    const ua = navigator.userAgent || '';
    if (/iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
    if (/android/i.test(ua)) return 'android';
    return 'desktop';
  }
  function openInstallGuide() {
    const d = $('#installDialog');
    if (!d) return;
    const cur = detectPlatform();
    $$('#installDialog [data-platform]').forEach((li) => li.classList.toggle('current', li.dataset.platform === cur));
    d.showModal();
  }
  function bindInstall() {
    const btn = $('#installBtn');
    btn.hidden = isStandalone();
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.deferredInstall = e; });
    window.addEventListener('appinstalled', () => { state.deferredInstall = null; btn.hidden = true; toast('StatusSync installed'); });
    btn.addEventListener('click', promptInstall);
    if (detectPlatform() === 'ios' && !isStandalone() && !lsGet('ss_ios_hint', '')) {
      setTimeout(() => {
        toast('Install on iPhone or iPad: tap Share, then Add to Home Screen.', { ms: 10000, action: { label: 'Show steps', fn: openInstallGuide } });
        lsSet('ss_ios_hint', '1');
      }, 4000);
    }
  }
  async function promptInstall() {
    const e = state.deferredInstall;
    if (!e) { openInstallGuide(); return; }
    e.prompt();
    try { await e.userChoice; } catch (err) { /* ignore */ }
    state.deferredInstall = null;
  }
  function onEmptyAction(e) {
    const b = e.target.closest('[data-empty-act]');
    if (!b) return;
    const a = b.dataset.emptyAct;
    safe(async () => {
      if (a === 'reset-hist') { $('#histSearch').value = ''; $('#histQuarter').value = ''; $('#histArchive').checked = false; await renderHistory(true); }
      else if (a === 'reset-raci') { $('#raciFilter').value = ''; $('#raciRole').value = ''; await renderRaci(); }
      else if (a === 'reset-del') { $('#delCategory').value = ''; $('#delStatus').value = ''; await renderDeliverables(); }
      else if (a === 'add-blocker') await editBlocker(null);
      else if (a === 'add-deliverable') await editDeliverable(null);
      else if (a === 'add-participant') await editParticipant(null, null);
      else if (a === 'compose') { showTab('broadcast'); setTimeout(() => { const f = $('#cmpSummary'); if (f) f.focus(); }, 60); }
    });
  }

  function engagementNudge() {
    state.clicks++;
    if (state.clicks >= 6 && !state.nudged && state.deferredInstall) {
      state.nudged = true;
      toast('Install StatusSync for offline use and a home-screen icon.', { ms: 9000, action: { label: 'Install', fn: promptInstall } });
    }
  }

  /* ---------------- event wiring ---------------- */
  function bind() {
    document.addEventListener('click', engagementNudge);
    $$('.persona .seg').forEach((b) => b.addEventListener('click', () => setPersona(b.dataset.persona)));
    $('#projectSelect').addEventListener('change', (e) => selectProject(e.target.value));
    $('#themeBtn').addEventListener('click', () => {
      const order = ['auto', 'light', 'dark'];
      const cur = document.documentElement.dataset.themePref || 'auto';
      applyTheme(order[(order.indexOf(cur) + 1) % order.length]);
    });
    try {
      window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (lsGet('ss_theme', 'auto') === 'auto') applyTheme('auto'); });
    } catch (e) { /* older browsers */ }
    $('#badgePill').addEventListener('click', () => showTab('blockers'));
    $('#modeSwitchBtn').addEventListener('click', () => setPersona('engineer'));
    $('#modeDismissBtn').addEventListener('click', () => { $('#modeBar').hidden = true; });
    const guide = $('#guide');
    guide.open = lsGet('ss_guide', 'open') !== 'closed';
    guide.addEventListener('toggle', () => lsSet('ss_guide', guide.open ? 'open' : 'closed'));
    document.addEventListener('click', onEmptyAction);

    const tabs = $$('.tabs [role="tab"]');
    tabs.forEach((t) => {
      t.addEventListener('click', () => showTab(t.dataset.tab));
      t.addEventListener('keydown', (e) => {
        const vis = tabs.filter((x) => x.offsetParent !== null);
        const i = vis.indexOf(t);
        let n = null;
        if (e.key === 'ArrowRight') n = vis[(i + 1) % vis.length];
        else if (e.key === 'ArrowLeft') n = vis[(i - 1 + vis.length) % vis.length];
        else if (e.key === 'Home') n = vis[0];
        else if (e.key === 'End') n = vis[vis.length - 1];
        if (n) { e.preventDefault(); showTab(n.dataset.tab, true); }
      });
    });

    $('#updateBtn').addEventListener('click', () => { if (state.waiting) state.waiting.postMessage({ type: 'SKIP_WAITING' }); });
    $('#updateDismiss').addEventListener('click', () => { $('#updateBanner').hidden = true; });

    // dashboard
    $('#newProjectBtn').addEventListener('click', () => safe(() => editProject(true)));
    $('#editProjectBtn').addEventListener('click', () => safe(() => editProject(false)));
    $('#editTelemetryBtn').addEventListener('click', () => safe(editTelemetry));
    const pipe = $('#pipeline');
    pipe.addEventListener('input', (e) => {
      if (e.target.type !== 'range') return;
      const li = e.target.closest('.stage');
      li.querySelector('.val').textContent = e.target.value + '%';
      e.target.style.setProperty('--progress', e.target.value + '%');
    });
    pipe.addEventListener('change', (e) => { if (e.target.type === 'range') safe(() => onStageChange(+e.target.closest('.stage').dataset.i, +e.target.value)); });
    pipe.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const i = +b.closest('.stage').dataset.i;
      safe(() => onStageChange(i, b.dataset.act === 'complete' ? 100 : 0));
    });

    // composer
    $('#composerForm').addEventListener('submit', (e) => { e.preventDefault(); safe(() => saveBroadcast(false), 'Save broadcast'); });
    $('#autoFillBtn').addEventListener('click', () => safe(autoFill, 'Auto-fill'));
    $('#copyWaBtn').addEventListener('click', () => safe(copyWhatsApp));
    $('#shareBtn').addEventListener('click', () => safe(shareBroadcast));
    $('#printBtn').addEventListener('click', () => { if (requireSummary()) safe(() => printTransmittal(gatherBroadcast())); });
    $('#queueBtn').addEventListener('click', () => safe(() => saveBroadcast(true), 'Queue broadcast'));

    // history
    let hs; $('#histSearch').addEventListener('input', () => { clearTimeout(hs); hs = setTimeout(() => safe(() => renderHistory(true)), 220); });
    $('#histQuarter').addEventListener('change', () => safe(() => renderHistory(true)));
    $('#histArchive').addEventListener('change', () => safe(() => renderHistory(true)));
    $('#histMore').addEventListener('click', () => safe(() => renderHistory(false)));
    $('#historyList').addEventListener('change', (e) => {
      if (!e.target.classList.contains('ack')) return;
      const li = e.target.closest('li');
      const boxes = $$('.ack', li);
      const counter = li.querySelector('.so-count');
      if (counter) counter.textContent = '(' + boxes.filter((c) => c.checked).length + '/' + boxes.length + ' Confirmed)';
      safe(() => toggleAck(li.dataset.id, e.target.dataset.pid, e.target.checked));
    });
    $('#historyList').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const li = b.closest('li');
      if (b.dataset.act === 'viewarch') return safe(() => viewArchived(li.dataset.arch));
      safe(async () => {
        const rec = await SSDB.get('status_broadcasts', li.dataset.id);
        if (!rec) return;
        if (b.dataset.act === 'print') await printTransmittal(rec);
        else toast((await copyText(SSReports.whatsappBrief(curProject(), rec))) ? 'Brief copied' : 'Copy failed');
      });
    });

    // RACI
    $('#raciFilter').addEventListener('change', () => safe(renderRaci));
    $('#raciRole').addEventListener('change', () => safe(renderRaci));
    $('#addParticipantBtn').addEventListener('click', () => safe(() => editParticipant(null, null)));
    $('#pickContactBtn').addEventListener('click', () => safe(pickContact));
    $('#raciTable').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const part = state.participants.find((x) => x.id === b.closest('tr').dataset.id);
      if (!part) return;
      if (b.dataset.act === 'log') safe(() => logCommunication(part));
      else if (b.dataset.act === 'edit') safe(() => editParticipant(part, null));
      else if (b.dataset.act === 'del') safe(async () => {
        if (!(await confirmDialog('Remove participant', 'Remove ' + part.name + ' from this project?', 'Remove'))) return;
        await SSDB.del('participants', part.id); await Promise.all([renderRaci(), renderDashboard()]);
      });
    });
    $('#commMore').addEventListener('click', () => safe(() => renderComm(false)));

    // deliverables
    $('#addDeliverableBtn').addEventListener('click', () => safe(() => editDeliverable(null)));
    $('#exportDeliverablesBtn').addEventListener('click', () => safe(exportDeliverables));
    $('#delCategory').addEventListener('change', () => safe(renderDeliverables));
    $('#delStatus').addEventListener('change', () => safe(renderDeliverables));
    const dl = $('#deliverableList');
    dl.addEventListener('input', (e) => {
      if (!e.target.classList.contains('d-prog')) return;
      e.target.closest('.del-row').querySelector('.d-val').textContent = e.target.value + '%';
      e.target.style.setProperty('--progress', e.target.value + '%');
    });
    dl.addEventListener('change', (e) => {
      const row = e.target.closest('.del-row'); if (!row) return;
      const id = row.dataset.id;
      if (e.target.classList.contains('d-prog')) safe(async () => { await updateDeliverable(id, { progress: +e.target.value }); await renderDeliverables(); });
      else if (e.target.classList.contains('d-status')) safe(async () => { await updateDeliverable(id, { status: e.target.value }); await renderDeliverables(); });
      else if (e.target.classList.contains('d-sign')) safe(() => updateDeliverable(id, { clientSignOff: e.target.checked }));
    });
    dl.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const id = b.closest('.del-row').dataset.id;
      safe(async () => {
        const d = await SSDB.get('deliverables_milestones', id);
        if (b.dataset.act === 'edit') return editDeliverable(d);
        if (!(await confirmDialog('Delete deliverable', 'Delete "' + d.title + '"?', 'Delete'))) return;
        await SSDB.del('deliverables_milestones', id); await renderDeliverables();
      });
    });

    // blockers
    $('#addBlockerBtn').addEventListener('click', () => safe(() => editBlocker(null)));
    $('#blockerBoard').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      safe(() => blockerAction(b.closest('.bcard').dataset.id, b.dataset.act));
    });

    // vault
    $('#refreshStorageBtn').addEventListener('click', () => safe(renderVault));
    $('#persistBtn').addEventListener('click', () => safe(async () => {
      const ok = await SSDB.requestPersistence();
      toast(ok ? 'Persistent storage granted' : 'Browser kept storage as best-effort. Installing the app often helps.');
      await renderVault();
    }));
    $('#attachInput').addEventListener('change', (e) => { const f = Array.from(e.target.files); e.target.value = ''; if (f.length) safe(() => addAttachments(f), 'Attachments'); });
    $('#attachList').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const id = b.closest('li').dataset.id;
      safe(async () => {
        const meta = await SSDB.get('attachments', id);
        if (!meta) return;
        if (b.dataset.act === 'dl') { const f = await SSDB.OPFS.read(meta); if (f) downloadBlob(f, meta.name); }
        else if (await confirmDialog('Delete attachment', 'Delete "' + meta.name + '" from this device?', 'Delete')) { await SSDB.OPFS.remove(meta); await renderVault(); }
      });
    });
    $('#compactPreviewBtn').addEventListener('click', () => safe(() => compact(true), 'Archive preview'));
    $('#compactBtn').addEventListener('click', () => safe(async () => {
      if (await confirmDialog('Compact cold archive', 'Move broadcasts and communication entries older than ' + SSDB.HOT_RETENTION_MONTHS + ' months into compressed quarterly archives? They stay searchable and can be restored.', 'Compact')) await compact(false);
    }, 'Archive'));
    $('#archSearchBtn').addEventListener('click', () => safe(async () => {
      const hits = await SSDB.searchArchives($('#archSearch').value, state.projectId);
      $('#archiveList').innerHTML = hits.length ? hits.slice(0, 60).map((h) =>
        '<li data-arch="' + esc(h.quarterKey) + '|' + esc(h.kind) + '|' + esc(h.id) + '"><span><b>' + esc(h.quarterKey) + '</b> · ' + esc(h.kind) + ' · ' + fmtDate(h.timestamp) + '<br><small class="muted">' + esc(h.text.slice(0, 120)) + '</small></span><button type="button" class="btn small" data-act="viewarch">View</button></li>').join('')
        : '<li class="muted">No archived matches.</li>';
    }));
    $('#archiveList').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const li = b.closest('li');
      if (b.dataset.act === 'viewarch') return safe(() => viewArchived(li.dataset.arch));
      if (b.dataset.act === 'restore') safe(async () => {
        const n = await SSDB.restoreQuarter(li.dataset.q);
        toast('Restored ' + n + ' records to the live feed');
        await Promise.all([renderVault(), renderHistory(true), renderComm(true), refreshQuarterOptions()]);
      });
    });
    $('#exportBtn').addEventListener('click', () => safe(exportSnapshot, 'Export'));
    $('#importBtn').addEventListener('click', () => safe(pickAndImport));
    $('#importInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) safe(() => importSnapshotFile(f, $('#importReplace').checked), 'Import'); });
    $('#pwaBoard').addEventListener('click', (e) => {
      if (e.target.id === 'notifyBtn') safe(enableNotifications);
      if (e.target.id === 'periodicBtn') safe(enablePeriodic);
    });

    // network
    const net = (say) => {
      const on = navigator.onLine;
      $('#netPill').textContent = on ? 'Online' : 'Offline';
      $('#netPill').className = 'pill ' + (on ? 'ok' : 'bad');
      if (say) announce(on ? 'Back online.' : 'You are offline. Changes are saved on this device.');
    };
    window.addEventListener('online', () => { net(true); safe(async () => { const n = await flushQueued(); if (n) { toast(n + ' queued broadcast(s) dispatched'); await renderComm(true); } }); if (activeTab() === 'vault') renderPwaBoard(); });
    window.addEventListener('offline', () => { net(true); if (activeTab() === 'vault') renderPwaBoard(); });
    net();

    const clock = () => { $('#tbClock').textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dubai' }) + ' GST'; };
    clock(); setInterval(clock, 30000);

    if ('launchQueue' in window) {
      window.launchQueue.setConsumer(async (params) => {
        for (const h of (params.files || [])) await safe(() => handleLaunchFile(h), 'Open file');
      });
    }
  }

  /* ---------------- boot ---------------- */
  async function init() {
    setLoading(true);
    applyTheme(lsGet('ss_theme', 'auto'));
    renderRoleChips();
    bind();
    registerSW();
    bindInstall();
    await safe(async () => {
      await SSDB.open();
      const seeded = await SSDB.seedIfEmpty();
      const upgraded = seeded ? false : await SSDB.upgradeSeedV2();
      SSDB.requestPersistence();
      await loadProjects();
      state.projectId = lsGet('ss_project', '');
      if (!state.projects.find((p) => p.id === state.projectId)) state.projectId = state.projects[0] && state.projects[0].id;
      populateProjectSelect();
      await selectProject(state.projectId);
      if (seeded) toast('Loaded 3 sample Dubai projects — edit or replace them with your own.', { ms: 7000 });
      else if (upgraded) toast('Sample projects updated with every role and blocker column. Nothing was deleted.', { ms: 7000 });
      await processUrlActions();
    }, 'Startup');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
