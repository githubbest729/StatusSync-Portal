/* StatusSync Portal — storage engine: IndexedDB + OPFS + cold archive + backup */
(function (global) {
  'use strict';

  const DB_NAME = 'StatusSyncDB_v2026';
  const DB_VERSION = 1;
  const DATA_STORES = [
    'projects', 'status_broadcasts', 'participants', 'deliverables_milestones',
    'blockers_issues', 'communication_log', 'archives_cold_storage', 'attachments', 'app_meta'
  ];
  const HOT_RETENTION_MONTHS = 6;
  const THREE_YEARS_DAYS = 365 * 3;

  let dbPromise = null;

  /* ---------------- helpers ---------------- */
  function uid(prefix) {
    const r = (global.crypto && crypto.randomUUID) ? crypto.randomUUID().slice(0, 13)
      : Math.random().toString(36).slice(2, 15);
    return (prefix || 'id') + '_' + r;
  }
  function nowISO() { return new Date().toISOString(); }
  function quarterKey(iso) {
    const d = new Date(iso);
    return d.getUTCFullYear() + '-Q' + (Math.floor(d.getUTCMonth() / 3) + 1);
  }
  function reqP(req) {
    return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  }
  function txDone(tx) {
    return new Promise((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error || new Error('Transaction aborted'));
    });
  }

  /* ---------------- open + schema ---------------- */
  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        const old = e.oldVersion;
        if (old < 1) {
          const projects = db.createObjectStore('projects', { keyPath: 'id' });
          projects.createIndex('ragStatus', 'ragStatus');
          projects.createIndex('clientName', 'clientName');
          projects.createIndex('updatedAt', 'updatedAt');

          const bc = db.createObjectStore('status_broadcasts', { keyPath: 'id' });
          bc.createIndex('projectId_timestamp', ['projectId', 'timestamp']);
          bc.createIndex('archivedQuarter', 'archivedQuarter');

          const pa = db.createObjectStore('participants', { keyPath: 'id' });
          pa.createIndex('projectId', 'projectId');
          pa.createIndex('role', 'role');
          pa.createIndex('raci', 'raci');

          const dm = db.createObjectStore('deliverables_milestones', { keyPath: 'id' });
          dm.createIndex('projectId_category', ['projectId', 'category']);
          dm.createIndex('status', 'status');

          const bl = db.createObjectStore('blockers_issues', { keyPath: 'id' });
          bl.createIndex('projectId_status', ['projectId', 'status']);
          bl.createIndex('severity', 'severity');

          const cl = db.createObjectStore('communication_log', { keyPath: 'id' });
          cl.createIndex('projectId_timestamp', ['projectId', 'timestamp']);

          db.createObjectStore('archives_cold_storage', { keyPath: 'quarterKey' });

          const at = db.createObjectStore('attachments', { keyPath: 'id' });
          at.createIndex('projectId', 'projectId');

          db.createObjectStore('app_meta', { keyPath: 'key' });
        }
        /* Future migrations: if (old < 2) { ... } */
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Database upgrade blocked by another tab'));
    });
    return dbPromise;
  }

  /* ---------------- CRUD ---------------- */
  async function put(store, value) {
    const db = await open();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    await txDone(tx);
    return value;
  }
  async function putMany(store, values) {
    const db = await open();
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    values.forEach((v) => os.put(v));
    await txDone(tx);
    return values.length;
  }
  async function get(store, key) {
    const db = await open();
    return reqP(db.transaction(store).objectStore(store).get(key));
  }
  async function del(store, key) {
    const db = await open();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    await txDone(tx);
  }
  async function getAll(store) {
    const db = await open();
    return reqP(db.transaction(store).objectStore(store).getAll());
  }
  async function count(store) {
    const db = await open();
    return reqP(db.transaction(store).objectStore(store).count());
  }
  async function getAllByIndex(store, indexName, query) {
    const db = await open();
    return reqP(db.transaction(store).objectStore(store).index(indexName).getAll(query));
  }
  async function clearStore(store) {
    const db = await open();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    await txDone(tx);
  }

  /* Cursor pagination over [projectId, timestamp] indexes using IDBKeyRange (newest first). */
  async function pageByProject(store, projectId, opts) {
    const o = Object.assign({ limit: 50, before: null, filter: null }, opts || {});
    const db = await open();
    const index = db.transaction(store).objectStore(store).index('projectId_timestamp');
    const lower = [projectId, ''];
    const range = o.before
      ? IDBKeyRange.bound(lower, [projectId, o.before], false, true)
      : IDBKeyRange.bound(lower, [projectId, '￿']);
    return new Promise((resolve, reject) => {
      const items = [];
      const req = index.openCursor(range, 'prev');
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve({ items, nextBefore: null });
        if (!o.filter || o.filter(cur.value)) items.push(cur.value);
        if (items.length >= o.limit) {
          return resolve({ items, nextBefore: cur.value.timestamp });
        }
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  /* Count records in a project's time window (used for 50k-entry feeds). */
  async function countByProject(store, projectId) {
    const db = await open();
    const index = db.transaction(store).objectStore(store).index('projectId_timestamp');
    return reqP(index.count(IDBKeyRange.bound([projectId, ''], [projectId, '￿'])));
  }

  async function getMeta(key, fallback) {
    const row = await get('app_meta', key);
    return row ? row.value : fallback;
  }
  async function setMeta(key, value) { return put('app_meta', { key, value }); }

  /* ---------------- Persistent storage + telemetry ---------------- */
  async function requestPersistence() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        if (navigator.storage.persisted && await navigator.storage.persisted()) return true;
        return await navigator.storage.persist();
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  async function storageTelemetry() {
    const out = {
      supported: !!(navigator.storage && navigator.storage.estimate),
      usageBytes: 0, quotaBytes: 0, persisted: false,
      totalRecords: 0, perStore: {}, yearsRemaining: null, usedPercent: 0,
      opfsSupported: !!(navigator.storage && navigator.storage.getDirectory)
    };
    try {
      if (out.supported) {
        const est = await navigator.storage.estimate();
        out.usageBytes = est.usage || 0;
        out.quotaBytes = est.quota || 0;
      }
      if (navigator.storage && navigator.storage.persisted) out.persisted = await navigator.storage.persisted();
    } catch (e) { /* ignore */ }
    for (const s of DATA_STORES) {
      if (s === 'app_meta') continue;
      const n = await count(s);
      out.perStore[s] = n;
      out.totalRecords += n;
    }
    out.usedPercent = out.quotaBytes ? (out.usageBytes / out.quotaBytes) * 100 : 0;

    // Capacity forecast from the oldest record's age.
    let oldest = Date.now();
    try {
      const db = await open();
      const idx = db.transaction('communication_log').objectStore('communication_log').index('projectId_timestamp');
      await new Promise((resolve) => {
        const r = idx.openCursor();
        const seen = {};
        r.onsuccess = () => {
          const c = r.result;
          if (!c) return resolve();
          const t = Date.parse(c.value.timestamp);
          if (t && t < oldest) oldest = t;
          // jump to next project to avoid a full scan
          const pid = c.key[0];
          if (seen[pid]) return resolve();
          seen[pid] = true;
          c.continue([pid, '￿']);
        };
        r.onerror = () => resolve();
      });
    } catch (e) { /* ignore */ }
    const days = Math.max(30, (Date.now() - oldest) / 86400000);
    const perDay = out.usageBytes / days;
    if (out.quotaBytes && perDay > 0) {
      const years = (out.quotaBytes - out.usageBytes) / (perDay * 365);
      out.yearsRemaining = Math.min(99, Math.max(0, years));
    }
    out.threeYearTargetBytes = out.usageBytes ? (out.usageBytes / days) * THREE_YEARS_DAYS : 0;
    return out;
  }

  /* ---------------- OPFS attachment manager with IndexedDB Blob fallback ---------------- */
  const OPFS = {
    async root() {
      if (!(navigator.storage && navigator.storage.getDirectory)) return null;
      try {
        const root = await navigator.storage.getDirectory();
        return await root.getDirectoryHandle('statussync-attachments', { create: true });
      } catch (e) { return null; }
    },
    safeName(name) { return String(name).replace(/[^\w.\-]+/g, '_').slice(0, 120); },
    async save(projectId, file) {
      const id = uid('att');
      const meta = {
        id, projectId, name: file.name, size: file.size, type: file.type || 'application/octet-stream',
        createdAt: nowISO(), storage: 'idb', path: null
      };
      const dir = await OPFS.root();
      if (dir) {
        try {
          const pdir = await dir.getDirectoryHandle(OPFS.safeName(projectId), { create: true });
          const fname = id + '_' + OPFS.safeName(file.name);
          const fh = await pdir.getFileHandle(fname, { create: true });
          const w = await fh.createWritable();
          await w.write(file);
          await w.close();
          meta.storage = 'opfs';
          meta.path = OPFS.safeName(projectId) + '/' + fname;
        } catch (e) { meta.storage = 'idb'; }
      }
      if (meta.storage === 'idb') meta.blob = file;
      await put('attachments', meta);
      return meta;
    },
    async read(meta) {
      if (meta.storage === 'opfs' && meta.path) {
        const dir = await OPFS.root();
        const parts = meta.path.split('/');
        const pdir = await dir.getDirectoryHandle(parts[0]);
        const fh = await pdir.getFileHandle(parts[1]);
        return fh.getFile();
      }
      return meta.blob || null;
    },
    async remove(meta) {
      if (meta.storage === 'opfs' && meta.path) {
        try {
          const dir = await OPFS.root();
          const parts = meta.path.split('/');
          const pdir = await dir.getDirectoryHandle(parts[0]);
          await pdir.removeEntry(parts[1]);
        } catch (e) { /* already gone */ }
      }
      await del('attachments', meta.id);
    },
    async list(projectId) {
      return getAllByIndex('attachments', 'projectId', projectId);
    },
    async totalBytes() {
      const all = await getAll('attachments');
      return all.reduce((s, a) => s + (a.size || 0), 0);
    }
  };

  /* ---------------- compression helpers ---------------- */
  function bytesToB64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(bin);
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function compress(text) {
    const enc = new TextEncoder().encode(text);
    if (typeof CompressionStream === 'undefined') return { encoding: 'plain', data: bytesToB64(enc) };
    const cs = new CompressionStream('gzip');
    const w = cs.writable.getWriter();
    w.write(enc); w.close();
    const buf = await new Response(cs.readable).arrayBuffer();
    return { encoding: 'gzip', data: bytesToB64(new Uint8Array(buf)) };
  }
  async function decompress(payload) {
    const bytes = b64ToBytes(payload.data);
    if (payload.encoding === 'plain') return new TextDecoder().decode(bytes);
    const ds = new DecompressionStream('gzip');
    const w = ds.writable.getWriter();
    w.write(bytes); w.close();
    return new TextDecoder().decode(await new Response(ds.readable).arrayBuffer());
  }

  /* ---------------- cold archive compactor ---------------- */
  async function compactArchives(opts) {
    const o = Object.assign({ months: HOT_RETENTION_MONTHS, dryRun: false }, opts || {});
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - o.months);
    const cutoffISO = cutoff.toISOString();
    const [broadcasts, logs] = await Promise.all([getAll('status_broadcasts'), getAll('communication_log')]);
    const oldB = broadcasts.filter((b) => b.timestamp < cutoffISO && !b.archivedQuarter);
    const oldL = logs.filter((l) => l.timestamp < cutoffISO);
    const groups = {};
    oldB.forEach((b) => { (groups[quarterKey(b.timestamp)] = groups[quarterKey(b.timestamp)] || { b: [], l: [] }).b.push(b); });
    oldL.forEach((l) => { (groups[quarterKey(l.timestamp)] = groups[quarterKey(l.timestamp)] || { b: [], l: [] }).l.push(l); });
    const summary = { quarters: [], recordsArchived: 0, bytesBefore: 0, bytesAfter: 0 };
    for (const qk of Object.keys(groups).sort()) {
      const g = groups[qk];
      const existing = await get('archives_cold_storage', qk);
      let prior = { broadcasts: [], communication_log: [] };
      if (existing) prior = JSON.parse(await decompress(existing.compressedPayload));
      const merged = {
        broadcasts: prior.broadcasts.concat(g.b),
        communication_log: prior.communication_log.concat(g.l)
      };
      const json = JSON.stringify(merged);
      const comp = await compress(json);
      const index = merged.broadcasts.map((b) => ({
        kind: 'broadcast', id: b.id, projectId: b.projectId, timestamp: b.timestamp,
        text: (b.reportRef + ' ' + b.executiveSummary).toLowerCase().slice(0, 400)
      })).concat(merged.communication_log.map((l) => ({
        kind: 'log', id: l.id, projectId: l.projectId, timestamp: l.timestamp,
        text: (l.channel + ' ' + l.subject + ' ' + (l.body || '')).toLowerCase().slice(0, 400)
      })));
      const rc = merged.broadcasts.length + merged.communication_log.length;
      summary.quarters.push({ quarterKey: qk, records: g.b.length + g.l.length });
      summary.recordsArchived += g.b.length + g.l.length;
      summary.bytesBefore += json.length;
      summary.bytesAfter += comp.data.length;
      if (!o.dryRun) {
        await put('archives_cold_storage', {
          quarterKey: qk, compressedPayload: comp, recordCount: rc, createdAt: nowISO(), searchIndex: index
        });
      }
    }
    if (!o.dryRun && summary.recordsArchived) {
      const db = await open();
      const tx = db.transaction(['status_broadcasts', 'communication_log'], 'readwrite');
      oldB.forEach((b) => tx.objectStore('status_broadcasts').delete(b.id));
      oldL.forEach((l) => tx.objectStore('communication_log').delete(l.id));
      await txDone(tx);
    }
    return summary;
  }

  async function searchArchives(text, projectId) {
    const q = String(text || '').toLowerCase().trim();
    const archives = await getAll('archives_cold_storage');
    const hits = [];
    archives.forEach((a) => {
      (a.searchIndex || []).forEach((e) => {
        if (projectId && e.projectId !== projectId) return;
        if (!q || e.text.indexOf(q) !== -1) hits.push(Object.assign({ quarterKey: a.quarterKey }, e));
      });
    });
    hits.sort((x, y) => (x.timestamp < y.timestamp ? 1 : -1));
    return hits;
  }

  async function loadArchivedRecord(quarterKeyValue, kind, id) {
    const a = await get('archives_cold_storage', quarterKeyValue);
    if (!a) return null;
    const data = JSON.parse(await decompress(a.compressedPayload));
    const list = kind === 'broadcast' ? data.broadcasts : data.communication_log;
    return list.find((r) => r.id === id) || null;
  }

  async function restoreQuarter(qk) {
    const a = await get('archives_cold_storage', qk);
    if (!a) return 0;
    const data = JSON.parse(await decompress(a.compressedPayload));
    data.broadcasts.forEach((b) => { b.archivedQuarter = null; });
    await putMany('status_broadcasts', data.broadcasts);
    await putMany('communication_log', data.communication_log);
    await del('archives_cold_storage', qk);
    return data.broadcasts.length + data.communication_log.length;
  }

  /* ---------------- backup / restore ---------------- */
  async function exportSnapshot() {
    const snap = {
      app: 'StatusSync Portal', schema: DB_NAME, version: DB_VERSION, exportedAt: nowISO(), stores: {}
    };
    for (const s of DATA_STORES) {
      let rows = await getAll(s);
      if (s === 'attachments') rows = rows.map((r) => { const c = Object.assign({}, r); delete c.blob; return c; });
      snap.stores[s] = rows;
    }
    return snap;
  }

  async function importSnapshot(snap, opts) {
    const o = Object.assign({ replace: false }, opts || {});
    if (!snap || snap.app !== 'StatusSync Portal' || !snap.stores) throw new Error('Not a StatusSync snapshot file');
    let total = 0;
    for (const s of DATA_STORES) {
      const rows = snap.stores[s];
      if (!Array.isArray(rows)) continue;
      if (o.replace) await clearStore(s);
      total += await putMany(s, rows);
    }
    await setMeta('seeded', true);
    return total;
  }

  /* ---------------- Dubai seed data ---------------- */
  const STAGES = [
    'Site Survey & BOM', 'FDS & Design Spec', 'Wonderware SCADA & HMI Config', 'PLC & OPC/Modbus Comms',
    'SQL Database & Historian Scripts', 'Procurement & Panel Assembly', 'QA & FAT/SAT Testing', 'Client Training & Handover'
  ];

  function daysAgo(n, hour) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    d.setUTCHours(hour == null ? 6 : hour, (n * 7) % 60, (n * 13) % 60, (n * 37) % 1000);
    return d.toISOString();
  }
  function daysAhead(n) { return daysAgo(-n, 8).slice(0, 10); }

  function seedProjects() {
    return [
      {
        id: 'prj_dewa', projectCode: 'AGAC-2026-014', name: 'DEWA Substation Wonderware System Platform Upgrade',
        clientName: 'Dubai Electricity and Water Authority (DEWA)', location: 'Al Quoz 132/11kV Substation, Dubai',
        ragStatus: 'Amber', pmName: 'Rashid Al Mansoori', leadScadaEngineer: 'SCADA Engineer — Al Gurg A&C',
        startDate: daysAgo(210).slice(0, 10), targetDate: daysAhead(75), qhseStatus: 'Verified',
        stages: [100, 100, 78, 64, 45, 30, 8, 0], updatedAt: daysAgo(2),
        telemetry: { hmiDone: 86, hmiTotal: 112, tagsTested: 2840, tagsTotal: 4200, opcHealthy: 17, opcTotal: 20, sqlVerified: 31, sqlTotal: 48, protocols: 'OPC UA, IEC 61850, Modbus TCP' }
      },
      {
        id: 'prj_hills', projectCode: 'AGAC-2026-022', name: 'Dubai Hills District Cooling SCADA & Modbus Telemetry',
        clientName: 'Empower District Cooling', location: 'Dubai Hills Estate Plant 3, Dubai',
        ragStatus: 'Green', pmName: 'Priya Nair', leadScadaEngineer: 'SCADA Engineer — Al Gurg A&C',
        startDate: daysAgo(150).slice(0, 10), targetDate: daysAhead(120), qhseStatus: 'Verified',
        stages: [100, 100, 92, 85, 70, 55, 25, 5], updatedAt: daysAgo(1),
        telemetry: { hmiDone: 58, hmiTotal: 64, tagsTested: 5120, tagsTotal: 6000, opcHealthy: 11, opcTotal: 11, sqlVerified: 22, sqlTotal: 30, protocols: 'Modbus TCP/RTU, OPC DA' }
      },
      {
        id: 'prj_jawtp', projectCode: 'AGAC-2026-031', name: 'Jebel Ali Industrial Water Treatment InTouch HMI & Historian Migration',
        clientName: 'Jafza Utilities Operations', location: 'Jebel Ali Free Zone South, Dubai',
        ragStatus: 'Red', pmName: 'Omar Haddad', leadScadaEngineer: 'SCADA Engineer — Al Gurg A&C',
        startDate: daysAgo(120).slice(0, 10), targetDate: daysAhead(40), qhseStatus: 'Review Pending',
        stages: [100, 90, 55, 35, 28, 15, 0, 0], updatedAt: daysAgo(4),
        telemetry: { hmiDone: 24, hmiTotal: 60, tagsTested: 980, tagsTotal: 3100, opcHealthy: 6, opcTotal: 14, sqlVerified: 9, sqlTotal: 36, protocols: 'OPC UA, Modbus RTU, Profinet' }
      }
    ].map((p) => {
      p.overallProgress = Math.round(p.stages.reduce((a, b) => a + b, 0) / p.stages.length);
      return p;
    });
  }

  function seedParticipants() {
    const rows = [];
    const add = (pid, name, org, role, raci, email, phone, ch, lastDays) => rows.push({
      id: uid('par'), projectId: pid, name, organization: org, role, raci, email, phone,
      whatsapp: phone, preferredChannel: ch, lastContacted: daysAgo(lastDays)
    });
    add('prj_dewa', 'Eng. Khalid Al Suwaidi', 'DEWA', 'Client', 'A', 'k.alsuwaidi@dewa.example', '+971 50 111 2201', 'Email Transmittal', 3);
    add('prj_dewa', 'Hessa Al Falasi', 'DEWA Digital Grid', 'Client', 'C', 'h.alfalasi@dewa.example', '+971 50 111 2202', 'Email Transmittal', 9);
    add('prj_dewa', 'Rashid Al Mansoori', 'Al Gurg Automation and Controls', 'Project Manager', 'A', 'r.almansoori@alguirg.example', '+971 55 300 4411', 'WhatsApp Update', 1);
    add('prj_dewa', 'Vikram Shetty', 'Al Gurg Automation and Controls', 'PLC Engineer', 'R', 'v.shetty@alguirg.example', '+971 55 300 4412', 'WhatsApp Update', 2);
    add('prj_dewa', 'Meera Joseph', 'Al Gurg Automation and Controls', 'Estimation', 'I', 'm.joseph@alguirg.example', '+971 55 300 4413', 'Email Transmittal', 20);
    add('prj_dewa', 'Tariq Anwar', 'Al Gurg Automation and Controls', 'Procurement', 'C', 't.anwar@alguirg.example', '+971 55 300 4414', 'Email Transmittal', 6);
    add('prj_dewa', 'Joanna Reyes', 'Al Gurg Automation and Controls', 'HSE Officer', 'I', 'j.reyes@alguirg.example', '+971 55 300 4415', 'Email Transmittal', 12);
    add('prj_dewa', 'Faisal Consulting Engineers', 'Parsons Gulf Consultants', 'Consultant', 'C', 'pgc.review@consult.example', '+971 4 555 8800', 'Email Transmittal', 8);

    add('prj_hills', 'Noura Al Hammadi', 'Empower', 'Client', 'A', 'n.alhammadi@empower.example', '+971 50 222 3301', 'Email Transmittal', 4);
    add('prj_hills', 'Sanjay Kulkarni', 'Empower Operations', 'Client', 'C', 's.kulkarni@empower.example', '+971 50 222 3302', 'WhatsApp Update', 2);
    add('prj_hills', 'Priya Nair', 'Al Gurg Automation and Controls', 'Project Manager', 'A', 'p.nair@alguirg.example', '+971 55 300 5511', 'WhatsApp Update', 1);
    add('prj_hills', 'Daniel Okafor', 'Al Gurg Automation and Controls', 'PLC Engineer', 'R', 'd.okafor@alguirg.example', '+971 55 300 5512', 'WhatsApp Update', 1);
    add('prj_hills', 'Lina Haddad', 'Al Gurg Automation and Controls', 'Procurement', 'C', 'l.haddad@alguirg.example', '+971 55 300 5513', 'Email Transmittal', 5);
    add('prj_hills', 'Hamdan Rashed', 'MEP Consult Dubai', 'Consultant', 'C', 'h.rashed@mepconsult.example', '+971 4 555 7700', 'Email Transmittal', 15);

    add('prj_jawtp', 'Eng. Saeed Bin Hamad', 'Jafza Utilities', 'Client', 'A', 's.binhamad@jafzautil.example', '+971 50 333 4401', 'Email Transmittal', 11);
    add('prj_jawtp', 'Aisha Rahman', 'Jafza Utilities Operations', 'Client', 'C', 'a.rahman@jafzautil.example', '+971 50 333 4402', 'WhatsApp Update', 5);
    add('prj_jawtp', 'Omar Haddad', 'Al Gurg Automation and Controls', 'Project Manager', 'A', 'o.haddad@alguirg.example', '+971 55 300 6611', 'WhatsApp Update', 1);
    add('prj_jawtp', 'Kevin Dsouza', 'Al Gurg Automation and Controls', 'PLC Engineer', 'R', 'k.dsouza@alguirg.example', '+971 55 300 6612', 'WhatsApp Update', 3);
    add('prj_jawtp', 'Fatima Zayed', 'Al Gurg Automation and Controls', 'Procurement', 'C', 'f.zayed@alguirg.example', '+971 55 300 6613', 'Email Transmittal', 7);
    add('prj_jawtp', 'Rob Jensen', 'Al Gurg Automation and Controls', 'HSE Officer', 'I', 'r.jensen@alguirg.example', '+971 55 300 6614', 'Email Transmittal', 18);
    return rows;
  }

  function seedDeliverables(projects) {
    const catalog = [
      ['Wonderware SCADA', 'System Platform galaxy, templates & derived objects', 2],
      ['Wonderware SCADA', 'Application scripts (startup, QuickScript .NET)', 3],
      ['HMI/Alarms/Trends', 'HMI graphic screens (P&ID overviews & faceplates)', 2],
      ['HMI/Alarms/Trends', 'Alarm matrix & priority groups (ISA-18.2)', 3],
      ['HMI/Alarms/Trends', 'Real-time and historical trend groups', 3],
      ['OPC/Modbus Comms', 'OPC UA / DA device drivers & topic config', 3],
      ['OPC/Modbus Comms', 'Modbus TCP/RTU register mapping & polling', 4],
      ['SQL/Historian', 'SQL Server schema & query optimisation scripts', 4],
      ['SQL/Historian', 'Historian tag retention & automated shift reports', 4],
      ['Site Survey/BOM', 'Site survey report & network topology', 1],
      ['Site Survey/BOM', 'Bill of Materials (panels, switches, licences)', 1],
      ['Procurement', 'Long-lead items delivery tracking', 5],
      ['FAT/SAT', 'FAT protocol & I/O loop-check sheets', 6],
      ['FAT/SAT', 'SAT protocol & performance run', 6],
      ['Documentation/Training', 'O&M manuals & as-built drawings', 7],
      ['Documentation/Training', 'End-user training sessions', 7],
      ['Legal/Paperwork', 'Site access permits & NOC paperwork', 0]
    ];
    const rows = [];
    projects.forEach((p) => {
      catalog.forEach((c, i) => {
        const stageProgress = p.stages[Math.min(c[2], 7)];
        const progress = Math.max(0, Math.min(100, stageProgress + ((i * 7) % 15) - 5));
        const status = progress >= 100 ? 'Complete' : progress > 0 ? 'In Progress' : 'Not Started';
        rows.push({
          id: uid('dlv'), projectId: p.id, category: c[0], title: c[1], progress: progress >= 100 ? 100 : progress,
          status, dueDate: daysAhead(10 + i * 4), clientSignOff: progress >= 100 && i % 3 !== 0,
          owner: i % 2 ? 'SCADA Engineer' : 'PLC Engineer'
        });
      });
    });
    return rows;
  }

  function seedBlockers() {
    const b = (pid, sev, title, sub, who, raised, target, status, hrs, aed, notes) => ({
      id: uid('blk'), projectId: pid, severity: sev, title, subsystem: sub, assignedTo: who,
      raisedDate: daysAgo(raised).slice(0, 10), targetResolutionDate: daysAhead(target), status,
      impactHours: hrs, expenditureImpactAED: aed, resolutionNotes: notes
    });
    return [
      b('prj_dewa', 'High', 'IEC 61850 GOOSE mapping file delayed by client protection team', 'PLC & IEC 61850', 'Rashid Al Mansoori', 9, 5, 'Escalated to PM', 56, 18500, 'PM chasing DEWA protection group; interim simulated signals in use.'),
      b('prj_dewa', 'Medium', 'Historian licence tag-count upgrade pending PO', 'Historian', 'Tariq Anwar', 14, 12, 'Open', 24, 6200, 'Quote approved internally, awaiting client PO.'),
      b('prj_dewa', 'Low', 'Alarm priority rationalisation comments outstanding', 'HMI/Alarms', 'SCADA Engineer', 20, 7, 'Open', 8, 1800, ''),
      b('prj_hills', 'Medium', 'Chiller PLC Modbus register map revision C missing', 'OPC/Modbus', 'Daniel Okafor', 6, 4, 'Open', 20, 4800, 'Vendor requested to reissue map.'),
      b('prj_hills', 'Low', 'Site access permit renewal for Plant 3', 'Site Access', 'Priya Nair', 3, 2, 'Open', 4, 600, ''),
      b('prj_jawtp', 'Critical', 'Legacy InTouch tag database export corrupt — migration of 3,100 tags blocked', 'InTouch Migration', 'Omar Haddad', 11, 3, 'Escalated to PM', 112, 42000, 'Vendor support case open; fallback manual rebuild plan costed.'),
      b('prj_jawtp', 'High', 'Profinet switch delivery slipped by 3 weeks', 'Procurement', 'Fatima Zayed', 16, 10, 'Open', 40, 12400, 'Alternative supplier quote requested.'),
      b('prj_jawtp', 'Medium', 'SQL Server licence not provisioned on historian VM', 'SQL/Historian', 'Kevin Dsouza', 7, 6, 'Open', 16, 3200, ''),
      b('prj_jawtp', 'Low', 'HMI colour standard clarification', 'HMI', 'SCADA Engineer', 25, -5, 'Resolved', 6, 900, 'Client confirmed ISA-101 greyscale scheme.')
    ];
  }

  function seedBroadcastsAndLogs(projects, participants) {
    const broadcasts = [];
    const logs = [];
    const types = ['Weekly', 'Weekly', 'Daily', 'Milestone', 'Weekly', 'Urgent'];
    const channels = ['Portal Broadcast', 'Email Transmittal', 'WhatsApp Update', 'MOM', 'RFI', 'Technical Clarification'];
    const subjects = {
      'Email Transmittal': 'Transmittal of updated HMI screen set',
      'WhatsApp Update': 'Quick site update from panel room',
      'MOM': 'Minutes of weekly progress meeting',
      'RFI': 'RFI on alarm priority rationalisation',
      'Technical Clarification': 'Clarification on OPC item naming convention',
      'Portal Broadcast': 'Weekly status broadcast issued'
    };
    projects.forEach((p, pi) => {
      const pp = participants.filter((x) => x.projectId === p.id);
      const t = p.telemetry;
      // weekly cadence reaching back ~9 months so the compactor has cold data to archive
      for (let w = 0, n = 0; w < 39; w++) {
        const age = w * 7 + 1 + pi;
        const ts = daysAgo(age, 5 + pi);
        const pct = Math.max(2, p.overallProgress - Math.round(w * (p.overallProgress / 44)));
        const type = w === 0 ? 'Weekly' : types[(w + pi) % types.length];
        broadcasts.push({
          id: uid('bc'), projectId: p.id,
          reportRef: p.projectCode + '/SR/' + String(2026) + '-W' + String(Math.max(1, 43 - w)).padStart(2, '0'),
          timestamp: ts, periodType: type,
          executiveSummary: p.name + ' is ' + pct + '% complete. ' + (type === 'Urgent' ? 'Escalation raised for a critical path item.' : 'Work is progressing per programme with no change to the target handover date.'),
          scadaProgress: 'HMI screens ' + Math.round(t.hmiDone * pct / p.overallProgress) + '/' + t.hmiTotal + ' complete; alarm and trend groups under review.',
          plcCommStatus: Math.min(t.opcTotal, Math.round(t.opcHealthy * pct / p.overallProgress)) + '/' + t.opcTotal + ' OPC/Modbus links healthy (' + t.protocols + ').',
          sqlDbStatus: Math.round(t.sqlVerified * pct / p.overallProgress) + '/' + t.sqlTotal + ' SQL queries and report scripts verified.',
          siteSurveyBomStatus: 'BOM rev ' + String.fromCharCode(65 + Math.min(5, Math.floor(w / 8))) + ' issued; procurement tracking active.',
          qaQhseNotes: 'QHSE Annexure-SCT-HR-001 checklist reviewed; no lost-time incidents.',
          sentToRoles: ['Client', 'Consultant', 'Project Manager'],
          acknowledgments: w > 0 ? pp.filter((x) => x.role === 'Client' || x.role === 'Consultant' || x.role === 'Project Manager').map((x) => ({ participantId: x.id, name: x.name, at: ts })) : [],
          archivedQuarter: null
        });
        // two log entries per week
        for (let k = 0; k < 2; k++, n++) {
          const ch = channels[(w + k + pi) % channels.length];
          const who = pp[(w + k) % pp.length];
          logs.push({
            id: uid('log'), projectId: p.id, participantId: who.id, channel: ch,
            subject: subjects[ch] + ' (' + p.projectCode + ')',
            body: ch === 'MOM' ? 'Attendees: client and Al Gurg A&C team. Actions: confirm FAT window, close open alarm comments.'
              : 'Communication with ' + who.name + ' regarding ' + p.name + '.',
            direction: k % 2 ? 'Inbound' : 'Outbound', attachmentsMeta: [],
            timestamp: daysAgo(age - k - 0.0 + (k ? 1 : 0), 7 + k), syncState: 'synced'
          });
        }
      }
    });
    return { broadcasts, logs };
  }

  async function seedIfEmpty() {
    if (await getMeta('seeded', false)) return false;
    if ((await count('projects')) > 0) { await setMeta('seeded', true); return false; }
    const projects = seedProjects();
    const participants = seedParticipants();
    const deliverables = seedDeliverables(projects);
    const blockers = seedBlockers();
    const bl = seedBroadcastsAndLogs(projects, participants);
    await putMany('projects', projects);
    await putMany('participants', participants);
    await putMany('deliverables_milestones', deliverables);
    await putMany('blockers_issues', blockers);
    await putMany('status_broadcasts', bl.broadcasts);
    await putMany('communication_log', bl.logs);
    await setMeta('seeded', true);
    return true;
  }

  global.SSDB = {
    DB_NAME, DB_VERSION, DATA_STORES, STAGES, HOT_RETENTION_MONTHS,
    uid, nowISO, quarterKey, open,
    put, putMany, get, del, getAll, count, getAllByIndex, clearStore,
    pageByProject, countByProject, getMeta, setMeta,
    requestPersistence, storageTelemetry, OPFS,
    compress, decompress, compactArchives, searchArchives, loadArchivedRecord, restoreQuarter,
    exportSnapshot, importSnapshot, seedIfEmpty
  };
})(typeof self !== 'undefined' ? self : window);
