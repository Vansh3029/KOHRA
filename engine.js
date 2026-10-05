/*
 * KOHRA engine - scenario engine, degradation middleware, decision logger, AAR.
 * Pure logic, no I/O. Runs on the Node server (authoritative) and, for the
 * standalone build, inside the browser. UMD: module.exports or window.Kohra.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Kohra = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ constants
  const ROLES = {
    coy:   { label: 'Company Commander',  short: 'Coy Cdr',     orders: ['move', 'fire', 'hold'] },
    air:   { label: 'Air Liaison Officer', short: 'Air Liaison', orders: ['strike', 'recce'] },
    cyber: { label: 'Cyber Officer',       short: 'Cyber',       orders: ['cscan', 'isolate', 'restore'] },
    ew:    { label: 'EW Officer',          short: 'EW',          orders: ['escan', 'hop'] },
  };
  const ROLE_IDS = Object.keys(ROLES);
  const CHANNELS = {
    radio:    { label: 'Radio net' },
    datalink: { label: 'UAV datalink' },
    cybernet: { label: 'Cyber ops net' },
    spectrum: { label: 'Spectrum watch' },
    teamnet:  { label: 'Team net' },
  };
  const CH_IDS = Object.keys(CHANNELS);
  const RATIONALE = [
    'Confirmed by two or more sources',
    'Single report, acting on it',
    'Following HQ intent',
    'Verifying before committing',
    'Time pressure',
    'Reducing risk to own forces',
    'Other',
  ];
  const BLAST = 6;          // fire / strike radius (map units)
  const FIRE_RANGE = 30;    // direct support range of a ground unit
  const STRIKE_FLIGHT = 20; // seconds from tasking received to effect
  const FIRE_PREP = 8;
  const RECCE_FLIGHT = 15;

  // Degradation presets: scale a "contested" baseline.
  const CONTESTED = {
    radio:    { delay: 14, jitter: 0.6, dropout: 0.35, conflict: 0.25, corrupt: 0.05 },
    datalink: { delay: 10, jitter: 0.5, dropout: 0.30, conflict: 0.30, corrupt: 0.10 },
    cybernet: { delay: 8,  jitter: 0.4, dropout: 0.20, conflict: 0.15, corrupt: 0 },
    spectrum: { delay: 6,  jitter: 0.4, dropout: 0.20, conflict: 0.10, corrupt: 0 },
    teamnet:  { delay: 12, jitter: 0.6, dropout: 0.30, conflict: 0.10, corrupt: 0 },
  };
  const PRESETS = { clear: 0, light: 0.35, moderate: 0.7, contested: 1 };
  function presetParams(name) {
    const k = PRESETS[name] == null ? 0.7 : PRESETS[name];
    const out = {};
    CH_IDS.forEach(function (c) {
      const b = CONTESTED[c];
      out[c] = { delay: round1(b.delay * k), jitter: b.jitter, dropout: round2(b.dropout * k), conflict: round2(b.conflict * k), corrupt: round2(b.corrupt * k) };
    });
    return out;
  }

  // ------------------------------------------------------------------ scenario
  const SCENARIO = {
    id: 'ridge-crossing',
    name: 'Op Ridge Crossing',
    brief: 'An enemy armoured column is moving on the bridge from the north. Hold the bridge and destroy the column before it crosses. Your feeds will not all be reliable.',
    duration: 480,
    map: {
      w: 100, h: 60,
      river: { y: 29, h: 4 },
      bridge: { x: 50, y: 31 },
      features: [
        { k: 'ridge', x: 28, y: 10, rx: 12, ry: 5 },
        { k: 'ridge', x: 82, y: 14, rx: 9, ry: 4 },
        { k: 'wood', x: 62, y: 12, rx: 7, ry: 4 },
        { k: 'wood', x: 14, y: 46, rx: 8, ry: 5 },
        { k: 'wood', x: 88, y: 50, rx: 6, ry: 5 },
        { k: 'village', x: 72, y: 47 },
      ],
      labels: [
        { t: 'Ridge North', x: 28, y: 6.5 },
        { t: 'Ridge East', x: 82, y: 10.5 },
        { t: 'Kala', x: 72, y: 52 },
        { t: 'River', x: 8, y: 31.5, water: true },
        { t: 'Bridge', x: 54, y: 27.5 },
      ],
    },
    units: [
      { id: 'A', name: '1 Platoon', x: 30, y: 47, speed: 0.4 },
      { id: 'B', name: 'Mech Platoon', x: 50, y: 50, speed: 0.4 },
      { id: 'C', name: 'Recce Section', x: 72, y: 43, speed: 0.5 },
    ],
    contacts: [
      { id: 'E1', name: 'armour column', path: [[70, 4], [50, 30]], from: 30, to: 390 },
      { id: 'E2', name: 'observation post', pos: [28, 12] },
      { id: 'E3', name: 'artillery battery', pos: [80, 15], appearAt: 120 },
    ],
    sources: [
      { id: 'recce', label: 'Recce', ch: 'radio', kind: 'contacts', cids: ['E1', 'E2'], every: 30, offset: 8, noise: 1.5, to: ['coy', 'air'] },
      { id: 'uav', label: 'UAV', ch: 'datalink', kind: 'contacts', cids: ['E1', 'E2', 'E3'], every: 40, offset: 14, noise: 1.0, to: ['coy', 'air'] },
      { id: 'cyber', label: 'Cyber cell', ch: 'cybernet', kind: 'cyberstatus', every: 45, offset: 20, to: ['cyber', 'coy'] },
      { id: 'ew', label: 'EW cell', ch: 'spectrum', kind: 'ewstatus', every: 45, offset: 25, to: ['ew', 'coy'] },
    ],
    hq: [
      { at: 2,   text: 'HQ: Hold the bridge. Armour expected from the north-east. Destroy it before it crosses.' },
      { at: 200, text: 'HQ: Column expected at the bridge around T+06:30. Confirm positions before committing fires.' },
      { at: 340, text: 'HQ: Report your intentions. Bridge must not fall.' },
    ],
    timeline: [
      { at: 60,  type: 'jam',       ch: 'radio',    dur: 120, strength: 0.9, note: 'Enemy jamming begins on the radio net' },
      { at: 150, type: 'intrusion',                                          note: 'Enemy gains access to the UAV datalink' },
      { at: 210, type: 'spoof',     ch: 'datalink', dur: 90,                  note: 'UAV datalink positions are being spoofed' },
      { at: 300, type: 'jam',       ch: 'datalink', dur: 50,  strength: 0.8, note: 'Enemy jamming begins on the UAV datalink' },
    ],
  };

  // Scripted "demo trainee" plan; positions resolve from what the role believes.
  const DEMO_PLAN = [
    { at: 38,  role: 'air',   type: 'recce',  target: 'E1', rationale: 'Verifying before committing', note: 'Asking for a UAV look at the column before tasking anything.' },
    { at: 55,  role: 'coy',   chat: 'Recce and UAV both show the column heading for the bridge. Holding fires until it is closer.' },
    { at: 100, role: 'ew',    type: 'hop',    rationale: 'Time pressure', note: 'Radio is full of noise. Hopping frequency.' },
    { at: 130, role: 'coy',   type: 'move',   unit: 'B', pos: [50, 37], rationale: 'Following HQ intent', note: 'Mech platoon covers the bridge from the south.' },
    { at: 222, role: 'air',   type: 'strike', target: 'E1', rationale: 'Single report, acting on it', note: 'Latest UAV fix is fresh. Tasking CAS now.' },
    { at: 232, role: 'cyber', type: 'isolate', rationale: 'Reducing risk to own forces', note: 'Datalink looks wrong. Isolating it.' },
    { at: 285, role: 'air',   type: 'recce',  target: 'E1', rationale: 'Verifying before committing', note: 'Strike result unclear. Requesting a fresh look.' },
    { at: 320, role: 'cyber', type: 'restore', rationale: 'Following HQ intent', note: 'Datalink needed for the final engagement.' },
    { at: 338, role: 'coy',   type: 'fire',   unit: 'B', target: 'E1', rationale: 'Confirmed by two or more sources', note: 'Recce and UAV agree on the column position.' },
  ];

  // ------------------------------------------------------------------ helpers
  function round1(v) { return Math.round(v * 10) / 10; }
  function round2(v) { return Math.round(v * 100) / 100; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gridRef(p) {
    const col = String.fromCharCode(65 + clamp(Math.floor(p[0] / 10), 0, 9));
    const row = clamp(Math.floor(p[1] / 10), 0, 5) + 1;
    return col + row;
  }
  function fmtT(t) {
    t = Math.max(0, Math.floor(t));
    const m = Math.floor(t / 60), s = t % 60;
    return 'T+' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // ------------------------------------------------------------------ engine
  function createEngine(opts) {
    opts = opts || {};
    const scenario = opts.scenario || SCENARIO;
    const players = {};        // role -> [names]; survives reset
    let S;

    function init(seed, preset, keep) {
      keep = keep || {};
      S = {
        seed: seed,
        rng: mulberry32(seed),
        t: 0, running: false, speed: keep.speed || 1, ended: false, endReason: '', outcome: 'incomplete',
        scripted: keep.scripted !== false, demo: false,
        preset: preset, params: presetParams(preset),
        effects: [], mitigations: [], isolation: null, intrusion: null,
        units: {}, contacts: {},
        queue: [], execQ: [],
        next: {}, tlDone: {}, hqDone: {}, demoDone: {},
        mid: 0, did: 0, eid: 0,
        inbox: {}, dlog: [], decisions: [], events: [], series: {}, lastSample: -999, chat: 0,
      };
      scenario.units.forEach(function (u) { S.units[u.id] = { id: u.id, name: u.name, x: u.x, y: u.y, tx: null, ty: null, speed: u.speed, alive: true }; });
      scenario.contacts.forEach(function (c) {
        const p0 = c.path ? c.path[0] : c.pos;
        S.contacts[c.id] = { id: c.id, name: c.name, x: p0[0], y: p0[1], alive: true, path: c.path || null, from: c.from, to: c.to, appearAt: c.appearAt || 0 };
      });
      scenario.sources.forEach(function (s) { S.next[s.id] = s.offset; });
      ROLE_IDS.forEach(function (r) { S.inbox[r] = []; S.series[r] = []; });
      logEvent('Exercise prepared: ' + scenario.name + ' (' + preset + ' degradation, seed ' + seed + ')', 'info');
    }

    function logEvent(text, kind) { S.events.push({ id: ++S.eid, t: round1(S.t), text: text, kind: kind || 'info' }); }

    // ---------------------------------------------------- degradation middleware
    function effective(ch) {
      const b = S.params[ch];
      const d = { delay: b.delay, jitter: b.jitter, dropout: b.dropout, conflict: b.conflict, corrupt: b.corrupt, spoof: false, jammed: false };
      S.effects.forEach(function (e) {
        if (e.ch !== ch || S.t < e.start || S.t >= e.end) return;
        if (e.kind === 'jam') {
          let k = e.strength;
          if (S.mitigations.some(function (m) { return m.ch === ch && S.t < m.until; })) k *= 0.35;
          d.dropout = Math.max(d.dropout, 0.9 * k);
          d.delay += 18 * k;
          d.jitter = Math.max(d.jitter, 0.5);
          d.jammed = true;
        } else if (e.kind === 'outage') { d.dropout = 1; d.jammed = true; }
        else if (e.kind === 'spoof') { d.spoof = true; }
      });
      if (S.isolation && S.t < S.isolation.until && ch === 'datalink') { d.dropout = 1; }
      return d;
    }
    function sampleDelay(e) {
      if (e.delay <= 0) return 0;
      return Math.max(0, e.delay * (1 + (S.rng() * 2 - 1) * e.jitter));
    }
    function jitterPos(p, mag) {
      const a = S.rng() * Math.PI * 2, r = S.rng() * mag;
      return [p[0] + Math.cos(a) * r, p[1] + Math.sin(a) * r];
    }

    // Route one truth message to one recipient through the channel degradation.
    function route(msg, role) {
      const e = effective(msg.ch);
      const entry = { id: 'L' + (S.dlog.length + 1), role: role, ch: msg.ch, msgId: msg.id, sentAt: round1(msg.sentAt), outcome: 'pending', delay: 0, recvAt: null, flags: [] };
      S.dlog.push(entry);
      if (S.rng() < e.dropout) { entry.outcome = 'dropped'; return; }
      const delay = sampleDelay(e);
      entry.delay = round1(delay);
      let m = msg;
      const hasPos = msg.data && msg.data.pos && msg.data.kind === 'contact';
      if (hasPos && e.spoof) {
        m = clone(msg); m.data.pos = [m.data.pos[0] + 16, m.data.pos[1] + 12]; entry.flags.push('spoofed');
      } else if (hasPos && e.corrupt > 0 && S.rng() < e.corrupt) {
        m = clone(msg); m.data.pos = jitterPos(m.data.pos, 10); entry.flags.push('corrupted');
      }
      S.queue.push({ at: S.t + delay, role: role, msg: m, entry: entry, flags: entry.flags.slice() });
      if (S.rng() < e.conflict) {
        const v = clone(msg);
        v.id = msg.id + 'x'; v.src = 'Unconfirmed source';
        if (hasPos) {
          const a = S.rng() * Math.PI * 2, r = 10 + S.rng() * 8;
          v.data.pos = [clamp(msg.data.pos[0] + Math.cos(a) * r, 2, 98), clamp(msg.data.pos[1] + Math.sin(a) * r, 2, 58)];
          v.text = cap(scenarioContactName(msg.data.cid) || 'contact') + ' in ' + gridRef(v.data.pos) + '.';
        } else if (msg.data && msg.data.kind === 'status') {
          v.data.ok = !msg.data.ok;
          v.text = msg.data.ok ? 'Signs of interference on the net.' : 'All nets look normal.';
        } else { return; }
        const e2 = { id: 'L' + (S.dlog.length + 1), role: role, ch: msg.ch, msgId: v.id, sentAt: round1(msg.sentAt), outcome: 'pending', delay: round1(delay + S.rng() * 10), recvAt: null, flags: ['conflicting'] };
        S.dlog.push(e2);
        S.queue.push({ at: S.t + e2.delay, role: role, msg: v, entry: e2, flags: ['conflicting'] });
      }
    }
    function scenarioContactName(cid) { const c = S.contacts[cid]; return c ? c.name : null; }

    function emit(spec) {
      const msg = { id: 'M' + (++S.mid), ch: spec.ch, src: spec.src, sentAt: S.t, text: spec.text, data: spec.data || {} };
      (spec.to || []).forEach(function (r) {
        if (spec.local) deliverNow(r, msg, spec.ch, []);
        else route(msg, r);
      });
      return msg;
    }
    function deliverNow(role, msg, ch, flags) {
      const rec = clone(msg);
      rec.recvAt = S.t; rec._meta = { flags: flags || [] };
      S.inbox[role].push(rec);
      afterDeliver(role, rec);
    }
    function afterDeliver(role, rec) {
      const d = rec.data || {};
      if (d.did) {
        const dec = S.decisions.find(function (x) { return x.id === d.did; });
        if (dec && dec.ackedAt == null) dec.ackedAt = round1(S.t);
        if (dec && d.kind === 'bda' && dec.bdaAt == null) dec.bdaAt = round1(S.t);
      }
      if (d.kind === 'chat' && d.share && d.share.pos) {
        S.inbox[role].push({ id: rec.id + 's', ch: rec.ch, src: 'Relayed by ' + (d.fromShort || 'team'), sentAt: d.share.sentAt, recvAt: S.t, text: '', hidden: true,
          data: { kind: 'contact', cid: d.share.cid, pos: d.share.pos }, _meta: { flags: ['relay'] } });
      }
    }

    // ---------------------------------------------------- beliefs / knowledge
    function beliefs(role) {
      const map = {};
      S.inbox[role].forEach(function (m) {
        if (!(m.data && m.data.pos && m.data.cid)) return;
        const k = m.src + '|' + m.data.cid;
        if (!map[k] || m.sentAt > map[k].sentAt) map[k] = { cid: m.data.cid, src: m.src, pos: m.data.pos, sentAt: m.sentAt, recvAt: m.recvAt };
      });
      return Object.keys(map).map(function (k) { return map[k]; });
    }
    function latestBelief(role, cid) {
      let best = null;
      beliefs(role).forEach(function (b) { if (b.cid === cid && (!best || b.sentAt > best.sentAt)) best = b; });
      return best;
    }
    function knowledge(role, pos, cid) {
      const reps = [];
      S.inbox[role].forEach(function (m) {
        if (!(m.data && m.data.pos && m.data.kind === 'contact')) return;
        if (cid && m.data.cid !== cid) return;
        if (S.t - m.sentAt > 120) return;
        reps.push(m);
      });
      let sup = 0, con = 0, freshest = null, recentSup = 0, recentCon = 0;
      reps.forEach(function (m) {
        const age = S.t - m.sentAt, w = Math.exp(-age / 60), d = dist(m.data.pos, pos);
        if (d <= 8) { sup += w; if (age < 60) recentSup++; }
        else if (d > 12) { con += w; if (age < 60) recentCon++; }
        if (freshest == null || age < freshest) freshest = age;
      });
      let conf = sup / (sup + con + 0.4);
      if (freshest == null || freshest > 90) conf *= 0.6;
      let truthPos = null;
      if (cid && S.contacts[cid]) truthPos = [S.contacts[cid].x, S.contacts[cid].y];
      else {
        let bd = 1e9;
        Object.keys(S.contacts).forEach(function (k) { const c = S.contacts[k]; if (!c.alive) return; const d = dist([c.x, c.y], pos); if (d < bd) { bd = d; truthPos = [c.x, c.y]; } });
      }
      return {
        reports: reps.length,
        freshestAge: freshest == null ? null : round1(freshest),
        contradictory: recentSup > 0 && recentCon > 0,
        confidence: round2(conf),
        believedPos: pos.map(round1),
        truthPos: truthPos ? truthPos.map(round1) : null,
        beliefError: truthPos ? round1(dist(pos, truthPos)) : null,
      };
    }

    // ---------------------------------------------------- orders
    function describe(d) {
      const a = d.args;
      switch (d.type) {
        case 'move': return 'Move ' + unitName(a.unit) + ' to ' + gridRef(a.pos);
        case 'hold': return 'Hold ' + unitName(a.unit) + ' in place';
        case 'fire': return unitName(a.unit) + ' fire at ' + gridRef(a.pos) + (a.cid ? ' (reported ' + a.cid + ')' : '');
        case 'strike': return 'Air strike on ' + gridRef(a.pos) + (a.cid ? ' (reported ' + a.cid + ')' : '');
        case 'recce': return 'UAV recce of ' + gridRef(a.pos) + (a.cid ? ' (looking for ' + a.cid + ')' : '');
        case 'cscan': return 'Scan networks for intrusion';
        case 'isolate': return 'Isolate the UAV datalink';
        case 'restore': return 'Restore the UAV datalink';
        case 'escan': return 'Scan the spectrum';
        case 'hop': return 'Frequency hop on the radio net';
      }
      return d.type;
    }
    function unitName(id) { const u = S.units[id]; return u ? u.name : 'unit'; }

    function order(role, ord, rationale) {
      if (!ROLES[role]) return { ok: false, error: 'Unknown role.' };
      if (S.ended) return { ok: false, error: 'The exercise has ended.' };
      if (!S.running) return { ok: false, error: 'The exercise is paused.' };
      if (!ord || ROLES[role].orders.indexOf(ord.type) < 0) return { ok: false, error: 'That order is not available to your role.' };
      rationale = rationale || {};
      if (RATIONALE.indexOf(rationale.tag) < 0) return { ok: false, error: 'Choose a rationale before sending.' };
      const a = { unit: ord.unit || null, pos: null, cid: ord.cid || null };
      const needsPos = ['move', 'fire', 'strike', 'recce'].indexOf(ord.type) >= 0;
      if (needsPos) {
        if (!Array.isArray(ord.pos) || ord.pos.length !== 2 || !isFinite(ord.pos[0]) || !isFinite(ord.pos[1])) return { ok: false, error: 'Pick a target on the map first.' };
        a.pos = [clamp(+ord.pos[0], 0, scenario.map.w), clamp(+ord.pos[1], 0, scenario.map.h)];
      }
      if (['move', 'fire', 'hold'].indexOf(ord.type) >= 0 && !S.units[a.unit]) return { ok: false, error: 'Choose a unit.' };
      if (a.unit && !S.units[a.unit].alive) return { ok: false, error: S.units[a.unit].name + ' is no longer operational.' };
      if (a.cid && !S.contacts[a.cid]) a.cid = null;
      const d = {
        id: 'D' + (++S.did), t: round1(S.t), role: role, type: ord.type, args: a, text: '',
        rationale: { tag: rationale.tag, note: String(rationale.note || '').slice(0, 200) },
        knowledge: null, status: 'sent', transit: 0, execAt: null, outcome: null, score: null, label: null, ackedAt: null, bdaAt: null, auto: !!ord.auto,
      };
      d.text = describe(d);
      if (needsPos && (ord.type === 'fire' || ord.type === 'strike' || ord.type === 'recce')) d.knowledge = knowledge(role, a.pos, a.cid);
      else if (needsPos) d.knowledge = knowledge(role, a.pos, null);
      S.decisions.push(d);
      const chOut = role === 'coy' ? 'radio' : role === 'air' ? 'datalink' : null;
      if (chOut) {
        const e = effective(chOut);
        if (S.rng() < e.dropout) { d.status = 'lost'; d.outcome = { kind: 'lost', detail: 'The order never reached its destination.' }; finish(d); logEvent(ROLES[role].short + ' order lost in transit: ' + d.text, 'loss'); return { ok: true, id: d.id }; }
        const delay = sampleDelay(e);
        const proc = d.type === 'strike' ? STRIKE_FLIGHT : d.type === 'fire' ? FIRE_PREP : d.type === 'recce' ? RECCE_FLIGHT : 0;
        d.transit = round1(delay);
        d.execAt = S.t + delay + proc;
        S.execQ.push({ at: d.execAt, d: d, transitEnd: S.t + delay });
      } else {
        d.execAt = S.t; d.transit = 0;
        execute(d);
      }
      return { ok: true, id: d.id };
    }

    function ackTo(d, text, kind, ch) {
      emit({ ch: ch, src: kind === 'bda' ? 'BDA' : 'Unit ack', text: text, data: { kind: kind, did: d.id }, to: [d.role] });
    }
    function resolveFire(d, pos, srcId) {
      const killed = [], hitOwn = [];
      Object.keys(S.contacts).forEach(function (k) {
        const c = S.contacts[k];
        if (c.alive && (!c.appearAt || S.t >= c.appearAt) && dist([c.x, c.y], pos) <= BLAST) { c.alive = false; killed.push(k); }
      });
      Object.keys(S.units).forEach(function (k) {
        const u = S.units[k];
        if (u.alive && k !== srcId && dist([u.x, u.y], pos) <= BLAST) { u.alive = false; u.tx = u.ty = null; hitOwn.push(k); }
      });
      let kind = 'miss';
      if (hitOwn.length) kind = 'fratricide';
      else if (d.args.cid && killed.indexOf(d.args.cid) >= 0) kind = 'hit';
      else if (killed.length) kind = 'hit_other';
      const gr = gridRef(pos);
      let detail;
      if (kind === 'fratricide') detail = 'Friendly forces hit in ' + gr + ': ' + hitOwn.map(unitName).join(', ') + (killed.length ? '; enemy also destroyed' : '');
      else if (kind === 'hit') detail = 'Target destroyed in ' + gr;
      else if (kind === 'hit_other') detail = killed.map(scenarioContactName).join(', ') + ' destroyed in ' + gr + ' (not the reported target)';
      else detail = 'No enemy in ' + gr + ' at time of impact';
      d.outcome = { kind: kind, detail: detail, killed: killed, hitOwn: hitOwn, pos: pos.map(round1) };
      killed.forEach(function (k) { logEvent(scenarioContactName(k) + ' (' + k + ') destroyed in ' + gr, 'good'); });
      if (hitOwn.length) logEvent('FRATRICIDE in ' + gr + ': ' + hitOwn.map(unitName).join(', '), 'bad');
      return kind;
    }
    function reportText(kind, d, pos) {
      const gr = gridRef(pos);
      if (kind === 'fratricide') return 'ALERT: friendly casualties in ' + gr + ' after our fire.';
      if (kind === 'hit') return 'BDA: target destroyed in ' + gr + '.';
      if (kind === 'hit_other') return 'BDA: a different enemy element was destroyed in ' + gr + '. Reported target not hit.';
      return 'BDA: no enemy seen in ' + gr + '.';
    }

    function execute(d) {
      d.status = 'executed';
      const a = d.args;
      switch (d.type) {
        case 'move': {
          const u = S.units[a.unit];
          if (!u.alive) { d.outcome = { kind: 'void', detail: u.name + ' was already out of action.' }; break; }
          u.tx = a.pos[0]; u.ty = a.pos[1];
          d.outcome = { kind: 'executed', detail: u.name + ' moving to ' + gridRef(a.pos) };
          ackTo(d, u.name + ': moving to ' + gridRef(a.pos) + '.', 'ack', 'radio');
          break;
        }
        case 'hold': {
          const u = S.units[a.unit]; u.tx = u.ty = null;
          d.outcome = { kind: 'executed', detail: u.name + ' holding' };
          ackTo(d, u.name + ': holding position.', 'ack', 'radio');
          break;
        }
        case 'fire': {
          const u = S.units[a.unit];
          if (!u.alive) { d.outcome = { kind: 'void', detail: u.name + ' was already out of action.' }; break; }
          if (dist([u.x, u.y], a.pos) > FIRE_RANGE) {
            d.outcome = { kind: 'out_of_range', detail: u.name + ' could not reach ' + gridRef(a.pos) };
            ackTo(d, u.name + ': target out of range, no fire.', 'ack', 'radio');
            break;
          }
          const k = resolveFire(d, a.pos, a.unit);
          ackTo(d, k === 'fratricide' ? reportText(k, d, a.pos) : u.name + ': fired on ' + gridRef(a.pos) + '. ' + reportText(k, d, a.pos), 'bda', 'radio');
          break;
        }
        case 'strike': {
          const k = resolveFire(d, a.pos, null);
          ackTo(d, k === 'fratricide' ? reportText(k, d, a.pos) : 'CAS: strike complete on ' + gridRef(a.pos) + '. ' + reportText(k, d, a.pos), 'bda', 'datalink');
          break;
        }
        case 'recce': {
          let n = 0;
          Object.keys(S.contacts).forEach(function (k) {
            const c = S.contacts[k];
            if (!c.alive || (c.appearAt && S.t < c.appearAt) || dist([c.x, c.y], a.pos) > 15) return;
            n++;
            const p = jitterPos([c.x, c.y], 0.6);
            emit({ ch: 'datalink', src: 'UAV recce', text: 'UAV recce: ' + c.name + ' in ' + gridRef(p), data: { kind: 'contact', cid: k, pos: p, did: d.id }, to: [d.role] });
          });
          if (!n) emit({ ch: 'datalink', src: 'UAV recce', text: 'UAV recce: no contacts near ' + gridRef(a.pos) + '.', data: { kind: 'bda', did: d.id }, to: [d.role] });
          d.outcome = { kind: 'executed', detail: n ? n + ' contact(s) observed near ' + gridRef(a.pos) : 'Nothing found near ' + gridRef(a.pos) };
          break;
        }
        case 'cscan': {
          const bad = S.intrusion && !S.intrusion.cleared;
          emit({ ch: 'cybernet', src: 'Scan result', text: bad ? 'Scan: unauthorised access found on the UAV datalink.' : 'Scan: no intrusion found.', data: { kind: 'status', ok: !bad }, to: [d.role], local: true });
          d.outcome = { kind: 'executed', detail: bad ? 'Intrusion found' : 'Clean' };
          break;
        }
        case 'isolate': {
          S.isolation = { until: S.t + 45 };
          const bad = S.intrusion && !S.intrusion.cleared;
          if (bad) { S.intrusion.cleared = true; S.effects = S.effects.filter(function (e) { return e.kind !== 'spoof'; }); }
          d.outcome = bad ? { kind: 'contained', detail: 'Intrusion contained; datalink dark for 45 s' } : { kind: 'unneeded', detail: 'No intrusion present; datalink dark for 45 s' };
          emit({ ch: 'cybernet', src: 'Cyber ops', text: 'Datalink isolated for 45 s.', data: { kind: 'status', ok: true }, to: [d.role], local: true });
          logEvent(bad ? 'Datalink isolated, intrusion contained' : 'Datalink isolated with no intrusion present', bad ? 'good' : 'info');
          break;
        }
        case 'restore': {
          S.isolation = null;
          d.outcome = { kind: 'executed', detail: 'Datalink restored' };
          emit({ ch: 'cybernet', src: 'Cyber ops', text: 'Datalink restored.', data: { kind: 'status', ok: true }, to: [d.role], local: true });
          break;
        }
        case 'escan': {
          const jam = ['radio', 'datalink'].filter(function (c) { return effective(c).jammed; });
          emit({ ch: 'spectrum', src: 'Scan result', text: jam.length ? 'Scan: jamming on ' + jam.map(function (c) { return CHANNELS[c].label; }).join(' and ') + '.' : 'Scan: spectrum clear.', data: { kind: 'status', ok: !jam.length }, to: [d.role], local: true });
          d.outcome = { kind: 'executed', detail: jam.length ? 'Jamming found' : 'Clear' };
          break;
        }
        case 'hop': {
          const jam = effective('radio').jammed;
          S.mitigations.push({ ch: 'radio', until: S.t + 60 });
          d.outcome = jam ? { kind: 'effective', detail: 'Hop reduces jamming on the radio net for 60 s' } : { kind: 'unneeded', detail: 'No jamming present; hop is wasted' };
          emit({ ch: 'spectrum', src: 'EW ops', text: 'Frequency hop on the radio net, good for 60 s.', data: { kind: 'status', ok: true }, to: [d.role], local: true });
          break;
        }
      }
      finish(d);
    }

    function finish(d) {
      const k = d.knowledge, o = d.outcome || { kind: 'void' };
      let q = 70, label = 'Routine';
      switch (d.type) {
        case 'fire':
        case 'strike': {
          const c = k ? k.confidence : 0.3;
          const oScore = { hit: 1, hit_other: 0.8, miss: 0.5, out_of_range: 0.4, lost: 0.45, void: 0.5, fratricide: 0 }[o.kind];
          q = 100 * (0.6 * (oScore == null ? 0.5 : oScore) + 0.4 * c);
          if (o.kind === 'fratricide') label = c < 0.5 ? 'Fratricide on weak information' : 'Fratricide despite good information';
          else if (o.kind === 'hit') label = c >= 0.5 ? 'Sound decision' : 'Right result, thin information';
          else if (o.kind === 'hit_other') label = 'Hit the wrong element';
          else if (o.kind === 'lost') label = 'Order lost in transit';
          else if (o.kind === 'out_of_range') label = 'Unit could not reach the target';
          else label = c >= 0.5 ? 'Good information, target had moved' : 'Acted on weak information';
          break;
        }
        case 'recce': {
          const c = k ? k.confidence : 0.3;
          q = o.kind === 'lost' ? 45 : 100 * (0.45 + 0.55 * (1 - c));
          label = o.kind === 'lost' ? 'Order lost in transit' : c < 0.5 ? 'Verified under doubt' : 'Verification was not needed';
          break;
        }
        case 'isolate': q = o.kind === 'contained' ? 92 : 40; label = o.kind === 'contained' ? 'Contained the intrusion' : 'Isolated with no intrusion'; break;
        case 'hop': q = o.kind === 'effective' ? 90 : 45; label = o.kind === 'effective' ? 'Mitigated jamming' : 'Hop was not needed'; break;
        case 'move': case 'hold': if (o.kind === 'lost') { q = 40; label = 'Order lost in transit'; } break;
        default: break;
      }
      d.score = Math.round(clamp(q, 0, 100));
      d.label = label;
    }

    // ---------------------------------------------------- injected effects
    function addEffect(e) { e.id = 'F' + (S.effects.length + 1); S.effects.push(e); return e; }
    function inject(spec) {
      const ch = CH_IDS.indexOf(spec.ch) >= 0 ? spec.ch : 'radio';
      const dur = clamp(+spec.dur || 60, 5, 300);
      switch (spec.kind) {
        case 'jam': addEffect({ kind: 'jam', ch: ch, start: S.t, end: S.t + dur, strength: clamp(+spec.strength || 0.9, 0.1, 1), src: 'instructor' }); logEvent('Instructor: jamming on ' + CHANNELS[ch].label + ' for ' + dur + ' s', 'degrade'); break;
        case 'outage': addEffect({ kind: 'outage', ch: ch, start: S.t, end: S.t + dur, src: 'instructor' }); logEvent('Instructor: ' + CHANNELS[ch].label + ' cut for ' + dur + ' s', 'degrade'); break;
        case 'spoof': addEffect({ kind: 'spoof', ch: 'datalink', start: S.t, end: S.t + dur, src: 'instructor' }); logEvent('Instructor: UAV datalink positions spoofed for ' + dur + ' s', 'degrade'); break;
        case 'intrusion': S.intrusion = { start: S.t, detected: false, detectAt: S.t + 15, cleared: false }; logEvent('Instructor: enemy gains access to the UAV datalink', 'degrade'); break;
        case 'clear': S.effects = []; S.intrusion = null; S.isolation = null; logEvent('Instructor: all active effects cleared', 'info'); break;
        default: return { ok: false, error: 'Unknown event.' };
      }
      return { ok: true };
    }

    // ---------------------------------------------------- simulation step
    function step(h) {
      if (S.ended) { S.running = false; return; }
      S.t += h;
      // scripted timeline
      if (S.scripted) {
        scenario.timeline.forEach(function (ev, i) {
          if (S.t >= ev.at && !S.tlDone[i]) {
            S.tlDone[i] = true;
            if (ev.type === 'jam') { addEffect({ kind: 'jam', ch: ev.ch, start: S.t, end: S.t + ev.dur, strength: ev.strength, src: 'script' }); logEvent(ev.note, 'degrade'); }
            else if (ev.type === 'intrusion') { S.intrusion = { start: S.t, detected: false, detectAt: S.t + 15, cleared: false }; logEvent(ev.note, 'degrade'); }
            else if (ev.type === 'spoof') {
              if (S.intrusion && !S.intrusion.cleared) { addEffect({ kind: 'spoof', ch: 'datalink', start: S.t, end: S.t + ev.dur, src: 'script' }); logEvent(ev.note, 'degrade'); }
              else logEvent('Spoofing attempt on the UAV datalink was blocked', 'good');
            }
          }
        });
      }
      if (S.intrusion && !S.intrusion.detected && S.t >= S.intrusion.detectAt) S.intrusion.detected = true;
      // HQ traffic
      scenario.hq.forEach(function (h2, i) {
        if (S.t >= h2.at && !S.hqDone[i]) { S.hqDone[i] = true; emit({ ch: 'radio', src: 'HQ', text: h2.text, data: { kind: 'hq' }, to: ROLE_IDS }); }
      });
      // contacts and units
      Object.keys(S.contacts).forEach(function (k) {
        const c = S.contacts[k];
        if (!c.alive || !c.path) return;
        const f = clamp((S.t - c.from) / (c.to - c.from), 0, 1);
        c.x = c.path[0][0] + (c.path[1][0] - c.path[0][0]) * f;
        c.y = c.path[0][1] + (c.path[1][1] - c.path[0][1]) * f;
      });
      Object.keys(S.units).forEach(function (k) {
        const u = S.units[k];
        if (!u.alive || u.tx == null) return;
        const dx = u.tx - u.x, dy = u.ty - u.y, d = Math.hypot(dx, dy), s = u.speed * h;
        if (d <= s) { u.x = u.tx; u.y = u.ty; u.tx = u.ty = null; } else { u.x += dx / d * s; u.y += dy / d * s; }
      });
      // sources
      scenario.sources.forEach(function (src) {
        while (S.t >= S.next[src.id]) {
          S.next[src.id] += src.every;
          emitSource(src);
        }
      });
      // order executions
      if (S.execQ.length) {
        const due = S.execQ.filter(function (x) { return x.at <= S.t; });
        if (due.length) {
          S.execQ = S.execQ.filter(function (x) { return x.at > S.t; });
          due.sort(function (a, b) { return a.at - b.at; }).forEach(function (x) { execute(x.d); });
        }
      }
      // deliveries
      if (S.queue.length) {
        const due = S.queue.filter(function (x) { return x.at <= S.t; });
        if (due.length) {
          S.queue = S.queue.filter(function (x) { return x.at > S.t; });
          due.sort(function (a, b) { return a.at - b.at; }).forEach(function (x) {
            x.entry.outcome = 'delivered'; x.entry.recvAt = round1(S.t);
            const rec = clone(x.msg); rec.recvAt = S.t; rec._meta = { flags: x.flags };
            S.inbox[x.role].push(rec);
            afterDeliver(x.role, rec);
          });
        }
      }
      // demo trainee
      if (S.demo) runDemo();
      // belief error sampling
      if (S.t - S.lastSample >= 5) {
        S.lastSample = S.t;
        const e1 = S.contacts.E1;
        ROLE_IDS.forEach(function (r) {
          const b = latestBelief(r, 'E1');
          S.series[r].push({ t: round1(S.t), err: (e1 && e1.alive && b) ? round1(dist(b.pos, [e1.x, e1.y])) : null });
        });
      }
      // end conditions
      const e1 = S.contacts.E1, br = scenario.map.bridge;
      if (!e1.alive) endExercise('Success: the armoured column was destroyed before it reached the bridge.', 'success');
      else if (dist([e1.x, e1.y], [br.x, br.y - 1]) <= 3) endExercise('Failure: the armoured column reached the bridge.', 'failure');
      else if (S.t >= scenario.duration) endExercise('Time limit reached with the column still active.', 'incomplete');
    }
    function endExercise(reason, outcome) { S.ended = true; S.running = false; S.endReason = reason; S.outcome = outcome; logEvent(reason, outcome === 'success' ? 'good' : 'bad'); }

    function emitSource(src) {
      if (src.kind === 'contacts') {
        src.cids.forEach(function (cid) {
          const c = S.contacts[cid];
          if (!c || !c.alive || (c.appearAt && S.t < c.appearAt)) return;
          const p = jitterPos([c.x, c.y], src.noise);
          const moving = c.path && S.t > c.from && S.t < c.to;
          emit({ ch: src.ch, src: src.label, text: src.label + ': ' + c.name + ' in ' + gridRef(p) + (moving ? ', moving' : ', static'), data: { kind: 'contact', cid: cid, pos: p }, to: src.to });
        });
      } else if (src.kind === 'cyberstatus') {
        const bad = S.intrusion && S.intrusion.detected && !S.intrusion.cleared;
        emit({ ch: src.ch, src: src.label, text: bad ? 'Cyber cell: anomalous traffic on the UAV datalink. Integrity suspect.' : 'Cyber cell: networks nominal.', data: { kind: 'status', ok: !bad }, to: src.to });
      } else if (src.kind === 'ewstatus') {
        const jam = ['radio', 'datalink'].filter(function (c) { return effective(c).jammed; });
        emit({ ch: src.ch, src: src.label, text: jam.length ? 'EW cell: noise floor high on ' + jam.map(function (c) { return CHANNELS[c].label; }).join(' and ') + '. Probable jamming.' : 'EW cell: spectrum clear.', data: { kind: 'status', ok: !jam.length }, to: src.to });
      }
    }

    // demo bot ------------------------------------------------------------
    function runDemo() {
      DEMO_PLAN.forEach(function (p, i) {
        if (S.t < p.at || S.demoDone[i]) return;
        S.demoDone[i] = true;
        if (p.chat) { chat(p.role, p.chat, null); return; }
        const ord = { type: p.type, unit: p.unit || null, auto: true };
        if (p.target) {
          const b = latestBelief(p.role, p.target) || latestBelief('coy', p.target) || latestBelief('air', p.target);
          if (b) { ord.pos = b.pos.slice(); ord.cid = p.target; }
        }
        if (p.pos) ord.pos = p.pos;
        if (['move', 'fire', 'strike', 'recce'].indexOf(p.type) >= 0 && !ord.pos) return;
        order(p.role, ord, { tag: p.rationale, note: p.note });
      });
    }

    // ---------------------------------------------------- team chat
    function chat(role, text, share) {
      text = String(text || '').trim().slice(0, 240);
      if (!ROLES[role] || !text) return { ok: false };
      const data = { kind: 'chat', fromShort: ROLES[role].short };
      if (share && share.pos && isFinite(share.pos[0]) && isFinite(share.pos[1])) data.share = { cid: share.cid || null, pos: [+share.pos[0], +share.pos[1]], sentAt: +share.sentAt || S.t };
      const msg = { id: 'M' + (++S.mid), ch: 'teamnet', src: ROLES[role].short, sentAt: S.t, text: text, data: data };
      const own = clone(msg); own.recvAt = S.t; own._meta = { flags: [] }; own.mine = true;
      S.inbox[role].push(own);
      ROLE_IDS.forEach(function (r) { if (r !== role) route(msg, r); });
      S.chat++;
      return { ok: true };
    }

    // ---------------------------------------------------- views
    function playerRoster() {
      const o = {};
      ROLE_IDS.forEach(function (r) { o[r] = (players[r] || []).slice(); });
      return o;
    }
    function sceneInfo() {
      return { id: scenario.id, name: scenario.name, brief: scenario.brief, duration: scenario.duration, map: scenario.map,
        roles: ROLES, channels: CHANNELS, rationale: RATIONALE, blast: BLAST, fireRange: FIRE_RANGE, units: scenario.units.map(function (u) { return { id: u.id, name: u.name }; }) };
    }
    function viewFor(role) {
      const msgs = S.inbox[role].filter(function (m) { return !m.hidden; }).slice(-70).map(function (m) {
        return { id: m.id, ch: m.ch, src: m.src, sentAt: round1(m.sentAt), recvAt: round1(m.recvAt), text: m.text, data: m.data && m.data.pos ? { cid: m.data.cid, pos: m.data.pos, kind: m.data.kind } : { kind: m.data && m.data.kind }, mine: !!m.mine };
      });
      const lastHeard = {};
      S.inbox[role].forEach(function (m) { if (!m.mine) lastHeard[m.ch] = m.recvAt; });
      const chans = CH_IDS.map(function (c) { return { ch: c, lastHeard: lastHeard[c] == null ? null : round1(lastHeard[c]) }; });
      const orders = S.decisions.filter(function (d) { return d.role === role; }).slice(-6).map(function (d) {
        return { id: d.id, t: d.t, text: d.text, ackedAt: d.ackedAt, bdaAt: d.bdaAt, rationale: d.rationale.tag };
      });
      const sc = ROLES[role].orders.indexOf('hop') >= 0 ? { hop: S.mitigations.some(function (m) { return S.t < m.until; }) } : {};
      return {
        kind: 'trainee', role: role, t: round1(S.t), running: S.running, ended: S.ended, endReason: S.endReason, speed: S.speed,
        units: Object.keys(S.units).map(function (k) { const u = S.units[k]; return { id: u.id, name: u.name, x: round1(u.x), y: round1(u.y), tx: u.tx, ty: u.ty, alive: u.alive }; }),
        contacts: beliefs(role).map(function (b) { return { cid: b.cid, src: b.src, pos: [round1(b.pos[0]), round1(b.pos[1])], sentAt: round1(b.sentAt), recvAt: round1(b.recvAt) }; }),
        messages: msgs, channels: chans, orders: orders, status: sc, roster: playerRoster(),
        isolated: role === 'cyber' ? !!(S.isolation && S.t < S.isolation.until) : undefined,
      };
    }
    function stats() {
      const per = {}, byCh = {};
      ROLE_IDS.forEach(function (r) { per[r] = { delivered: 0, dropped: 0 }; });
      CH_IDS.forEach(function (c) { byCh[c] = { attempts: 0, delivered: 0, dropped: 0, delayed: 0, sumDelay: 0, conflicting: 0, spoofed: 0, corrupted: 0 }; });
      S.dlog.forEach(function (l) {
        const c = byCh[l.ch];
        if (l.flags.indexOf('conflicting') < 0) {
          c.attempts++;
          if (l.outcome === 'dropped') { c.dropped++; per[l.role].dropped++; }
          else if (l.outcome === 'delivered') { c.delivered++; per[l.role].delivered++; c.sumDelay += l.delay; if (l.delay >= 8) c.delayed++; }
        } else { c.conflicting++; }
        if (l.flags.indexOf('spoofed') >= 0) c.spoofed++;
        if (l.flags.indexOf('corrupted') >= 0) c.corrupted++;
      });
      CH_IDS.forEach(function (c) { const x = byCh[c]; x.avgDelay = x.delivered ? round1(x.sumDelay / x.delivered) : 0; delete x.sumDelay; });
      return { perRole: per, byChannel: byCh };
    }
    function activeEffects() {
      return S.effects.filter(function (e) { return S.t >= e.start && S.t < e.end; }).map(function (e) { return { id: e.id, kind: e.kind, ch: e.ch, left: round1(e.end - S.t), src: e.src }; })
        .concat(S.isolation && S.t < S.isolation.until ? [{ id: 'iso', kind: 'isolation', ch: 'datalink', left: round1(S.isolation.until - S.t), src: 'cyber' }] : [])
        .concat(S.mitigations.filter(function (m) { return S.t < m.until; }).map(function (m) { return { id: 'mit' + m.until, kind: 'hop', ch: m.ch, left: round1(m.until - S.t), src: 'ew' }; }));
    }
    function instructorView() {
      const beliefsE1 = {};
      ROLE_IDS.forEach(function (r) { const b = latestBelief(r, 'E1'); if (b) beliefsE1[r] = { pos: b.pos.map(round1), age: round1(S.t - b.sentAt), src: b.src }; });
      const st = stats();
      const eff = {};
      CH_IDS.forEach(function (c) { const e = effective(c); eff[c] = { delay: round1(e.delay), dropout: round2(e.dropout), conflict: round2(e.conflict), jammed: e.jammed, spoof: e.spoof }; });
      return {
        kind: 'instructor', t: round1(S.t), running: S.running, ended: S.ended, endReason: S.endReason, outcome: S.outcome, speed: S.speed, scripted: S.scripted, demo: S.demo,
        preset: S.preset, params: S.params, effective: eff, effects: activeEffects(), seed: S.seed,
        intrusion: S.intrusion ? { detected: S.intrusion.detected, cleared: S.intrusion.cleared } : null,
        units: Object.keys(S.units).map(function (k) { const u = S.units[k]; return { id: u.id, name: u.name, x: round1(u.x), y: round1(u.y), tx: u.tx, ty: u.ty, alive: u.alive }; }),
        contacts: Object.keys(S.contacts).map(function (k) { const c = S.contacts[k]; return { id: c.id, name: c.name, x: round1(c.x), y: round1(c.y), alive: c.alive, hidden: !!(c.appearAt && S.t < c.appearAt) }; }),
        beliefsE1: beliefsE1, stats: st, roster: playerRoster(),
        upcoming: S.scripted ? scenario.timeline.map(function (e, i) { return { at: e.at, note: e.note, done: !!S.tlDone[i] }; }) : [],
        decisions: S.decisions.slice(-14).map(slimDecision), events: S.events.slice(-20),
      };
    }
    function slimDecision(d) {
      return { id: d.id, t: d.t, role: d.role, text: d.text, rationale: d.rationale, status: d.status, outcome: d.outcome, score: d.score, label: d.label, transit: d.transit, auto: d.auto };
    }

    // ---------------------------------------------------- AAR
    function aar() {
      const st = stats();
      const dec = S.decisions.map(function (d) { return JSON.parse(JSON.stringify(d)); });
      const perRole = {};
      ROLE_IDS.forEach(function (r) {
        const mine = dec.filter(function (d) { return d.role === r; });
        const scored = mine.filter(function (d) { return d.score != null; });
        perRole[r] = {
          label: ROLES[r].label, decisions: mine.length,
          avgScore: scored.length ? Math.round(scored.reduce(function (a, d) { return a + d.score; }, 0) / scored.length) : null,
          lost: mine.filter(function (d) { return d.status === 'lost'; }).length,
          delivered: st.perRole[r].delivered, dropped: st.perRole[r].dropped,
          players: (players[r] || []).slice(),
        };
      });
      const scoredAll = dec.filter(function (d) { return d.score != null; });
      const delivered = Object.keys(st.byChannel).reduce(function (a, c) { return a + st.byChannel[c].delivered; }, 0);
      const attempts = Object.keys(st.byChannel).reduce(function (a, c) { return a + st.byChannel[c].attempts; }, 0);
      return {
        meta: { scenario: scenario.name, seed: S.seed, preset: S.preset, scripted: S.scripted, duration: round1(S.t), limit: scenario.duration, ended: S.ended, demo: S.demo },
        team: {
          outcome: S.outcome, reason: S.endReason || 'Exercise in progress',
          avgScore: scoredAll.length ? Math.round(scoredAll.reduce(function (a, d) { return a + d.score; }, 0) / scoredAll.length) : null,
          decisions: dec.length, fratricide: dec.filter(function (d) { return d.outcome && d.outcome.kind === 'fratricide'; }).length,
          ordersLost: dec.filter(function (d) { return d.status === 'lost'; }).length,
          commsDelivered: attempts ? Math.round(100 * delivered / attempts) : null,
          teamMessages: S.chat,
        },
        perRole: perRole, channels: st.byChannel, decisions: dec, events: S.events.slice(), series: clone(S.series),
        ratio: { delivered: delivered, attempts: attempts },
      };
    }

    // ---------------------------------------------------- public API
    init(opts.seed == null ? 4 : opts.seed, opts.preset || 'moderate');
    return {
      scenario: scenario,
      scene: sceneInfo,
      state: function () { return S; },
      advance: function (dtReal) {
        if (!S.running) return;
        let dt = dtReal * S.speed;
        while (dt > 1e-9 && !S.ended) { const h = Math.min(0.25, dt); step(h); dt -= h; }
      },
      start: function () { if (!S.ended) { S.running = true; if (S.t === 0) logEvent('Exercise started', 'info'); } },
      pause: function () { S.running = false; },
      setSpeed: function (v) { S.speed = clamp(+v || 1, 0.5, 12); },
      setScripted: function (v) { S.scripted = !!v; },
      setDemo: function (v) { S.demo = !!v; if (v) { S.running = true; } },
      setPreset: function (name) { if (PRESETS[name] == null) return; S.preset = name; S.params = presetParams(name); logEvent('Degradation preset: ' + name, 'degrade'); },
      setParam: function (ch, key, val) {
        if (!S.params[ch] || ['delay', 'dropout', 'conflict', 'corrupt'].indexOf(key) < 0) return;
        const max = key === 'delay' ? 90 : 1;
        S.params[ch][key] = round2(clamp(+val || 0, 0, max)); S.preset = 'custom';
      },
      reset: function (seed) {
        const keep = { speed: S.speed, scripted: S.scripted };
        init(seed == null ? S.seed : seed, S.preset === 'custom' ? 'moderate' : S.preset, keep);
      },
      addPlayer: function (role, name) { if (!ROLES[role]) return; players[role] = players[role] || []; if (name && players[role].indexOf(name) < 0) players[role].push(name); },
      removePlayer: function (role, name) { if (players[role]) players[role] = players[role].filter(function (n) { return n !== name; }); },
      order: order, chat: chat, inject: inject,
      viewFor: viewFor, instructorView: instructorView, aar: aar,
    };
  }

  // ------------------------------------------------------------------ room
  // Transport-agnostic session manager. A client is { id, send(obj) }.
  function createRoom(code, opts) {
    const eng = createEngine(opts);
    const clients = new Map();
    let acc = 0, bcAcc = 0;
    const room = { code: code, eng: eng, clients: clients };

    function sendTo(c, obj) { try { c.send(obj); } catch (e) { /* closed */ } }
    function viewOf(c) { return c.role === 'instructor' ? eng.instructorView() : c.role ? eng.viewFor(c.role) : null; }
    function pushView(c) { const v = viewOf(c); if (v) sendTo(c, { t: 'view', view: v }); }
    room.broadcast = function () { clients.forEach(pushView); };
    room.count = function () { const o = { instructor: 0 }; ROLE_IDS.forEach(function (r) { o[r] = 0; }); clients.forEach(function (c) { if (c.role) o[c.role]++; }); return o; };

    room.leave = function (c) {
      if (c.role && c.role !== 'instructor') eng.removePlayer(c.role, c.name);
      clients.delete(c.id);
    };
    room.handle = function (c, m) {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'join') {
        const role = m.role === 'instructor' ? 'instructor' : (ROLES[m.role] ? m.role : null);
        if (!role) return sendTo(c, { t: 'error', text: 'Unknown role.' });
        if (c.role && c.role !== 'instructor') eng.removePlayer(c.role, c.name);
        c.role = role; c.name = String(m.name || 'Player').slice(0, 24);
        clients.set(c.id, c);
        if (role !== 'instructor') eng.addPlayer(role, c.name);
        sendTo(c, { t: 'joined', role: role, scene: eng.scene(), rationale: RATIONALE });
        pushView(c);
        room.broadcast();
        return;
      }
      if (!c.role) return;
      const isInstr = c.role === 'instructor';
      switch (m.t) {
        case 'order': {
          if (isInstr) return;
          const r = eng.order(c.role, m.order, m.rationale);
          sendTo(c, { t: 'orderResult', ok: r.ok, error: r.error, id: r.id });
          break;
        }
        case 'chat': if (!isInstr) eng.chat(c.role, m.text, m.share); break;
        case 'ctl': {
          if (!isInstr) return;
          switch (m.action) {
            case 'start': eng.start(); break;
            case 'pause': eng.pause(); break;
            case 'reset': eng.reset(m.seed); break;
            case 'speed': eng.setSpeed(m.value); break;
            case 'preset': eng.setPreset(m.value); break;
            case 'param': eng.setParam(m.ch, m.key, m.value); break;
            case 'scripted': eng.setScripted(m.value); break;
            case 'demo': eng.reset(); eng.setSpeed(m.speed || 6); eng.setDemo(true); eng.start(); break;
          }
          break;
        }
        case 'inject': if (isInstr) eng.inject(m); break;
        case 'getAar': sendTo(c, { t: 'aar', report: eng.aar() }); return;
        default: return;
      }
      room.broadcast();
    };
    // host calls this on a timer (every 250 ms of real time)
    room.step = function (dtReal) {
      eng.advance(dtReal);
      bcAcc += dtReal;
      if (bcAcc >= 0.5) { bcAcc = 0; room.broadcast(); }
    };
    return room;
  }

  return { createEngine: createEngine, createRoom: createRoom, SCENARIO: SCENARIO, ROLES: ROLES, CHANNELS: CHANNELS, PRESETS: PRESETS, RATIONALE: RATIONALE, fmtT: fmtT, gridRef: gridRef, dist: dist, BLAST: BLAST };
});
