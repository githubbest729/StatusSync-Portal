/* StatusSync Portal — report builders: telemetry auto-fill, briefs, transmittal, CSV */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Dubai' });
  }
  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dubai' }) + ' GST';
  }
  function pct(n, d) { return d ? Math.round((n / d) * 100) : 0; }

  function docControlNumber(project, kind, seq) {
    const d = new Date();
    const ymd = d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
    return 'AGAC-' + (kind || 'SR') + '-' + project.projectCode.replace(/^AGAC-/, '') + '-' + ymd + '-' + String(seq || 1).padStart(3, '0');
  }

  /* Pulls the current engineering picture from project telemetry, deliverables and blockers. */
  function buildTelemetry(project, deliverables, blockers) {
    const t = project.telemetry || {};
    const open = blockers.filter((b) => b.status !== 'Resolved');
    const critical = open.filter((b) => b.severity === 'Critical' || b.severity === 'High');
    const hours = open.reduce((s, b) => s + (+b.impactHours || 0), 0);
    const aed = open.reduce((s, b) => s + (+b.expenditureImpactAED || 0), 0);
    const done = deliverables.filter((d) => d.status === 'Complete').length;
    const active = deliverables.filter((d) => d.status === 'In Progress').slice(0, 3).map((d) => d.title);
    const stages = project.stages || [];
    const stageNames = (global.SSDB && global.SSDB.STAGES) || [];
    let currentStage = stages.findIndex((p) => p < 100);
    if (currentStage < 0) currentStage = stages.length - 1;
    return {
      executiveSummary: project.name + ' is ' + project.overallProgress + '% complete (RAG: ' + project.ragStatus + '). Current stage: ' +
        (stageNames[currentStage] || 'n/a') + '. ' + done + '/' + deliverables.length + ' deliverables complete; ' + open.length +
        ' open blocker(s) (' + critical.length + ' high/critical). Target handover ' + fmtDate(project.targetDate) + '.',
      scadaProgress: 'Wonderware HMI screens ' + (t.hmiDone || 0) + '/' + (t.hmiTotal || 0) + ' (' + pct(t.hmiDone, t.hmiTotal) +
        '%). Active work: ' + (active.join('; ') || 'none') + '.',
      plcCommStatus: 'PLC I/O tags tested ' + (t.tagsTested || 0) + '/' + (t.tagsTotal || 0) + ' (' + pct(t.tagsTested, t.tagsTotal) +
        '%). OPC/Modbus links healthy ' + (t.opcHealthy || 0) + '/' + (t.opcTotal || 0) + ' via ' + (t.protocols || 'n/a') + '.',
      sqlDbStatus: 'SQL queries and Historian scripts verified ' + (t.sqlVerified || 0) + '/' + (t.sqlTotal || 0) + ' (' +
        pct(t.sqlVerified, t.sqlTotal) + '%).',
      siteSurveyBomStatus: 'Site survey and BOM: ' + (deliverables.filter((d) => /Site Survey|Procurement/.test(d.category) && d.status === 'Complete').length) +
        ' of ' + (deliverables.filter((d) => /Site Survey|Procurement/.test(d.category)).length) + ' items closed.',
      qaQhseNotes: 'QA/FAT/SAT progress ' + (stages[6] || 0) + '%. QHSE Annexure-SCT-HR-001: ' + project.qhseStatus + '. Open blocker impact: ' +
        hours + ' h / AED ' + aed.toLocaleString('en-US') + '.'
    };
  }

  function whatsappBrief(project, b) {
    return [
      '*StatusSync — ' + project.projectCode + '*',
      '_' + project.name + '_',
      '*' + b.periodType + ' update* · ' + fmtDate(b.timestamp) + ' · Ref ' + b.reportRef,
      '',
      '*Summary:* ' + b.executiveSummary,
      '*SCADA/HMI:* ' + b.scadaProgress,
      '*PLC/Comms:* ' + b.plcCommStatus,
      '*SQL/Historian:* ' + b.sqlDbStatus,
      '*Site/BOM:* ' + b.siteSurveyBomStatus,
      '*QA/QHSE:* ' + b.qaQhseNotes,
      '',
      'Al Gurg Automation and Controls · Dubai, U.A.E.'
    ].join('\n');
  }

  function plainTextBrief(project, b) {
    return whatsappBrief(project, b).replace(/\*/g, '').replace(/_/g, '');
  }

  function severityClass(sev) { return 'sev-' + String(sev).toLowerCase(); }

  /* Complete printable HTML transmittal (opens in a new window, prints to PDF). */
  function transmittalHTML(ctx) {
    const p = ctx.project, b = ctx.broadcast;
    const open = (ctx.blockers || []).filter((x) => x.status !== 'Resolved');
    const recipients = (ctx.participants || []).filter((x) => !b.sentToRoles || !b.sentToRoles.length || b.sentToRoles.indexOf(x.role) !== -1);
    const stages = (global.SSDB && global.SSDB.STAGES) || [];
    const docNo = ctx.docNo || docControlNumber(p, 'TR', 1);
    const stageRows = (p.stages || []).map((v, i) =>
      '<tr><td>' + (i + 1) + '</td><td>' + esc(stages[i] || '') + '</td><td><div class="bar"><span style="width:' + v + '%"></span></div></td><td class="num">' + v + '%</td></tr>').join('');
    const blockerRows = open.length ? open.map((x) =>
      '<tr><td><span class="sev ' + severityClass(x.severity) + '">' + esc(x.severity) + '</span></td><td>' + esc(x.title) + '</td><td>' + esc(x.assignedTo) +
      '</td><td>' + esc(x.status) + '</td><td class="num">' + (+x.impactHours || 0) + '</td><td class="num">' + (+x.expenditureImpactAED || 0).toLocaleString('en-US') + '</td></tr>').join('')
      : '<tr><td colspan="6">No open blockers.</td></tr>';
    const recipRows = recipients.map((r) => '<tr><td>' + esc(r.name) + '</td><td>' + esc(r.organization) + '</td><td>' + esc(r.role) + '</td><td>' + esc(r.raci) + '</td></tr>').join('');
    const qhse = [
      'Toolbox talk held and recorded before site activity',
      'PPE and site induction verified for all attendees',
      'Permit-to-work / site access permit valid',
      'Electrical isolation and LOTO confirmed for panel work',
      'Cyber hygiene: engineering laptops scanned, USB media controlled',
      'No lost-time incidents or near-misses unreported'
    ].map((t) => '<li><span class="box"></span>' + esc(t) + '</li>').join('');

    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' + esc(docNo) + ' — Project Status Transmittal</title>' +
      '<meta name="viewport" content="width=device-width, initial-scale=1"><style>' +
      '@page{size:A4;margin:14mm}*{box-sizing:border-box}body{font:12px/1.45 "Segoe UI",Arial,sans-serif;color:#111;margin:0;padding:18px;background:#fff}' +
      'header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #0B132B;padding-bottom:10px;margin-bottom:12px}' +
      'h1{font-size:18px;margin:0;color:#0B132B}h2{font-size:13px;margin:16px 0 6px;color:#0B132B;border-bottom:1px solid #ccd;padding-bottom:3px;text-transform:uppercase;letter-spacing:.04em}' +
      '.brand{font-weight:800;font-size:15px;color:#0B132B}.sub{color:#444}.meta{width:100%;border-collapse:collapse;margin-bottom:6px}' +
      '.meta td{border:1px solid #bbc;padding:4px 7px}.meta td:nth-child(odd){background:#eef2fa;font-weight:600;width:16%}' +
      'table.t{width:100%;border-collapse:collapse}table.t th,table.t td{border:1px solid #bbc;padding:4px 6px;text-align:left;vertical-align:top}' +
      'table.t th{background:#0B132B;color:#fff}.num{text-align:right;white-space:nowrap}.bar{background:#e3e8f2;height:9px;border-radius:5px;overflow:hidden;min-width:120px}' +
      '.bar span{display:block;height:100%;background:#0a8f7c}.sev{padding:1px 6px;border-radius:9px;font-weight:700;font-size:11px;border:1px solid #888}' +
      '.sev-critical{background:#ffd9d9;color:#8a0000}.sev-high{background:#ffe6cc;color:#8a4600}.sev-medium{background:#fff4c2;color:#6a5600}.sev-low{background:#dff5e3;color:#0b5a21}' +
      'ul.qhse{list-style:none;padding:0;margin:0;columns:2}ul.qhse li{margin:3px 0}.box{display:inline-block;width:11px;height:11px;border:1.5px solid #0B132B;margin-right:7px;vertical-align:-2px}' +
      '.sig{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:22px}.sig div{border-top:1px solid #111;padding-top:4px;min-height:44px}' +
      '.para{white-space:pre-wrap;margin:0 0 4px}footer{margin-top:18px;font-size:10px;color:#555;border-top:1px solid #ccd;padding-top:6px}' +
      '.noprint{margin-bottom:12px}@media print{.noprint{display:none}body{padding:0}}' +
      '</style></head><body>' +
      '<div class="noprint"><button onclick="window.print()" style="padding:8px 16px;font-weight:700">Print / Save as PDF</button></div>' +
      '<header><div><div class="brand">Al Gurg Automation and Controls</div><div class="sub">Dubai, U.A.E. · SCADA Project Status Transmittal</div></div>' +
      '<div style="text-align:right"><h1>Project Status Report</h1><div class="sub">Doc. Control No.: <strong>' + esc(docNo) + '</strong></div><div class="sub">Issued: ' + fmtDateTime(b.timestamp) + '</div></div></header>' +
      '<table class="meta"><tr><td>Project</td><td>' + esc(p.name) + '</td><td>Project Code</td><td>' + esc(p.projectCode) + '</td></tr>' +
      '<tr><td>Client</td><td>' + esc(p.clientName) + '</td><td>Location</td><td>' + esc(p.location) + '</td></tr>' +
      '<tr><td>Report Ref</td><td>' + esc(b.reportRef) + '</td><td>Report Type</td><td>' + esc(b.periodType) + '</td></tr>' +
      '<tr><td>Project Manager</td><td>' + esc(p.pmName) + '</td><td>Overall Status</td><td>' + p.overallProgress + '% · RAG ' + esc(p.ragStatus) + '</td></tr></table>' +
      '<h2>1. Executive Summary</h2><p class="para">' + esc(b.executiveSummary) + '</p>' +
      '<h2>2. Engineering Status</h2><table class="t"><tr><th style="width:22%">Area</th><th>Status</th></tr>' +
      '<tr><td>Wonderware SCADA / HMI</td><td>' + esc(b.scadaProgress) + '</td></tr>' +
      '<tr><td>PLC &amp; OPC/Modbus Comms</td><td>' + esc(b.plcCommStatus) + '</td></tr>' +
      '<tr><td>SQL Database &amp; Historian</td><td>' + esc(b.sqlDbStatus) + '</td></tr>' +
      '<tr><td>Site Survey / BOM / Procurement</td><td>' + esc(b.siteSurveyBomStatus) + '</td></tr>' +
      '<tr><td>QA / QHSE</td><td>' + esc(b.qaQhseNotes) + '</td></tr></table>' +
      '<h2>3. Lifecycle Progress</h2><table class="t"><tr><th>#</th><th>Stage</th><th>Progress</th><th>%</th></tr>' + stageRows + '</table>' +
      '<h2>4. Open Blockers &amp; Impact</h2><table class="t"><tr><th>Severity</th><th>Issue</th><th>Owner</th><th>Status</th><th>Hours</th><th>AED</th></tr>' + blockerRows + '</table>' +
      '<h2>5. Distribution</h2><table class="t"><tr><th>Name</th><th>Organisation</th><th>Role</th><th>RACI</th></tr>' + recipRows + '</table>' +
      '<h2>6. QHSE Checklist — Annexure-SCT-HR-001</h2><ul class="qhse">' + qhse + '</ul>' +
      '<div class="sig"><div>Prepared by<br><strong>SCADA Engineer</strong><br>Al Gurg Automation and Controls</div><div>Reviewed by<br><strong>' + esc(p.pmName) + '</strong><br>Project Manager</div><div>Client acknowledgement<br><strong>&nbsp;</strong><br>Name / Signature / Date</div></div>' +
      '<footer>' + esc(docNo) + ' · Generated by StatusSync Portal · Confidential — intended for project participants only.</footer>' +
      '</body></html>';
  }

  function csvCell(v) {
    const s = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCSV(rows, columns) {
    const cols = columns || (rows.length ? Object.keys(rows[0]) : []);
    return [cols.map(csvCell).join(',')].concat(rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))).join('\r\n');
  }
  function parseCSV(text) {
    const rows = [];
    let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c !== '\r') cur += c;
    }
    if (cur.length || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  global.SSReports = {
    esc, fmtDate, fmtDateTime, pct, docControlNumber, buildTelemetry,
    whatsappBrief, plainTextBrief, transmittalHTML, toCSV, parseCSV
  };
})(typeof self !== 'undefined' ? self : window);
