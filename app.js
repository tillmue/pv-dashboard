/* PV Zuhause: Web-App (PWA). Liest Live- und Verlaufsdaten aus Firestore, die der Sammler zu Hause schreibt.
   Ohne Firebase testbar mit ?demo=1 (erzeugt Beispieldaten im Browser). */
export const APP_VERSION = '2026-10-17 a';

const FBV = '10.14.1', FBBASE = 'https://www.gstatic.com/firebasejs/' + FBV + '/';
const DEMO = new URLSearchParams(location.search).has('demo');
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const nf = (x, d = 0) => (x ?? 0).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const hm = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

/* Leistung: unter 1 kW in W, darüber in kW */
function pw(w) {
  if (w == null) return ['–', ''];
  const a = Math.abs(w);
  return a < 1000 ? [nf(a), 'W'] : [nf(a / 1000, a < 10000 ? 2 : 1), 'kW'];
}
const kwh = wh => wh == null ? '–' : nf(wh / 1000, wh < 10000 ? 1 : 0);

/* Einstellungen pro Gerät */
const PREF_KEY = 'pv-prefs';
function prefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch (e) {}
  return { price: p.price ?? 0.35, feed: p.feed ?? 0.082, tab: p.tab || 'live' };
}
function setPref(k, v) {
  const p = prefs(); p[k] = v;
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) {}
}

const S = {
  tab: prefs().tab, live: null, day: null, dayDate: new Date(), month: null, monthDate: new Date(),
  user: null, profile: null, users: [], src: null
};

/* ---------------- Datenquelle: Firebase oder Demo ---------------- */
async function firebaseSource() {
  const [a, au, fs] = await Promise.all([
    import(FBBASE + 'firebase-app.js'), import(FBBASE + 'firebase-auth.js'), import(FBBASE + 'firebase-firestore.js')]);
  const FB = { ...a, ...au, ...fs };
  const app = FB.initializeApp(window.FIREBASE_CONFIG);
  const auth = FB.getAuth(app); auth.languageCode = 'de';
  const db = FB.getFirestore(app);
  let unsubs = [];
  const off = () => { unsubs.forEach(u => u()); unsubs = []; };
  return {
    onAuth: cb => FB.onAuthStateChanged(auth, cb),
    login: (e, p) => FB.signInWithEmailAndPassword(auth, e, p),
    reset: e => FB.sendPasswordResetEmail(auth, e),
    logout: () => { off(); return FB.signOut(auth); },
    async register(name, email, pass) {
      const cred = await FB.createUserWithEmailAndPassword(auth, email, pass);
      const em = email.trim().toLowerCase();
      const inv = await FB.getDoc(FB.doc(db, 'invites', em)).catch(() => null);
      const role = inv && inv.exists() ? inv.data().role : 'viewer';
      await FB.setDoc(FB.doc(db, 'users', cred.user.uid), {
        name, email: em, role, approved: role !== 'viewer', created: Date.now() });
    },
    onProfile(uid, cb) {
      unsubs.push(FB.onSnapshot(FB.doc(db, 'users', uid), s => cb(s.exists() ? s.data() : null), () => cb(null)));
    },
    onLive(cb) { unsubs.push(FB.onSnapshot(FB.doc(db, 'live', 'current'), s => cb(s.data() || null), e => console.warn(e))); },
    async getDay(k) { const s = await FB.getDoc(FB.doc(db, 'days', k)); return s.exists() ? s.data() : null; },
    onDay(k, cb) { const u = FB.onSnapshot(FB.doc(db, 'days', k), s => cb(s.exists() ? s.data() : null)); unsubs.push(u); return u; },
    async getMonth(k) { const s = await FB.getDoc(FB.doc(db, 'months', k)); return s.exists() ? s.data() : null; },
    onUsers(cb) { unsubs.push(FB.onSnapshot(FB.collection(db, 'users'), s => cb(s.docs.map(d => ({ id: d.id, ...d.data() }))))); },
    setUser: (id, data) => FB.updateDoc(FB.doc(db, 'users', id), data),
    delUser: id => FB.deleteDoc(FB.doc(db, 'users', id)),
    stop: off
  };
}

function demoSource() {
  /* Glatte Tageskurve: PV-Glocke, Hausgrundlast mit Spitzen, Batterie puffert */
  function sim(dateKey, upto) {
    const seed = dateKey.split('-').reduce((a, b) => a * 31 + +b, 7);
    const rnd = i => { const x = Math.sin(seed + i * 12.9898) * 43758.5453; return x - Math.floor(x); };
    const peak = 2600 + rnd(1) * 1300, pts = []; let soc = 30 + rnd(2) * 20;
    const T = { pv: 0, grid_in: 0, grid_out: 0, bat_in: 0, bat_out: 0 };
    for (let m = 0; m <= upto; m += 5) {
      const h = m / 60, sun = Math.max(0, Math.sin((h - 7.3) / 11 * Math.PI));
      const pv = Math.round(peak * sun ** 1.6 * (0.8 + 0.2 * rnd(m)));
      const house = Math.round(220 + 180 * rnd(m + 1) + (h > 11.5 && h < 13 ? 1400 : 0) + (h > 18 && h < 20.5 ? 900 : 0));
      let bat = 0, net = house - pv;
      if (net < 0 && soc < 100) { bat = Math.max(net, -2000); soc = Math.min(100, soc - bat * 5 / 60 / 9020 * 100); }
      else if (net > 0 && soc > 10) { bat = Math.min(net, 2000); soc = Math.max(10, soc - bat * 5 / 60 / 9020 * 100); }
      const grid = Math.round(net - bat);
      pts.push({ m, pv, house, bat, grid, soc: Math.round(soc) });
      const e = 5 / 60;
      T.pv += pv * e; T.grid_in += Math.max(0, grid) * e; T.grid_out += Math.max(0, -grid) * e;
      T.bat_in += Math.max(0, -bat) * e; T.bat_out += Math.max(0, bat) * e;
    }
    for (const k in T) T[k] = Math.round(T[k]);
    T.house = T.pv + T.grid_in - T.grid_out + T.bat_out - T.bat_in;
    return { date: dateKey, points: pts, totals: T, start: { m: 0 } };
  }
  const nowM = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  const profile = { name: 'Till', email: 'demo@example.org', role: 'admin', approved: true };
  return {
    onAuth: cb => setTimeout(() => cb({ uid: 'demo', email: profile.email }), 50),
    login: async () => {}, reset: async () => {}, logout: async () => location.reload(), register: async () => {},
    onProfile: (uid, cb) => cb(profile),
    onLive(cb) {
      const tick = () => {
        const d = sim(dayKey(new Date()), nowM()), p = d.points[d.points.length - 1];
        cb({ pv_w: p.pv, bat_w: p.bat, grid_w: p.grid, house_w: p.house, soc: p.soc, bat_temp: 24.5, bat_health: 93,
             ts: Math.floor(Date.now() / 1000), today: d.totals, today_since: 0, meter_ok: true, pv_total_kwh: 27612 });
      };
      tick(); setInterval(tick, 15000);
    },
    async getDay(k) { return k > dayKey(new Date()) ? null : sim(k, k === dayKey(new Date()) ? nowM() : 1435); },
    onDay(k, cb) { this.getDay(k).then(cb); return () => {}; },
    async getMonth(k) {
      const [y, mo] = k.split('-').map(Number), days = {}, last = new Date(y, mo, 0).getDate(), today = new Date();
      for (let d = 1; d <= last; d++) {
        const dk = `${k}-${pad(d)}`; if (dk > dayKey(today)) break;
        days[pad(d)] = sim(dk, dk === dayKey(today) ? nowM() : 1435).totals;
      }
      return { days };
    },
    onUsers: cb => cb([{ id: 'demo', ...profile }, { id: 'u2', name: 'Mama', email: 'mama@example.org', role: 'viewer', approved: false, created: Date.now() }]),
    setUser: async () => {}, delUser: async () => {}, stop() {}
  };
}

/* ---------------- Kennzahlen ---------------- */
function kpis(t) {
  if (!t || t.house == null) return null;
  const self = Math.max(0, t.house - t.grid_in);            // selbst gedeckt (PV + Batterie)
  const autark = t.house > 0 ? self / t.house : null;        // Anteil des Verbrauchs ohne Netz
  const own = t.pv > 0 ? Math.max(0, t.pv - t.grid_out) / t.pv : null; // Anteil der Erzeugung selbst genutzt
  const p = prefs();
  const value = self / 1000 * p.price + t.grid_out / 1000 * p.feed;
  return { self, autark, own, value };
}
const pct = x => x == null ? '–' : nf(x * 100);
const eur = x => x == null ? '–' : x.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

/* ---------------- Ansichten ---------------- */
function render() {
  const app = $('#app');
  if (!S.user) { $('#tabs').classList.add('hidden'); app.innerHTML = authView(); bindAuth(); return; }
  if (!S.profile) { $('#tabs').classList.add('hidden'); app.innerHTML = `<div class="loading">Profil wird geladen …</div>`; return; }
  if (S.profile.approved !== true) { $('#tabs').classList.add('hidden'); app.innerHTML = pendingView(); bindPending(); return; }
  $('#tabs').classList.remove('hidden');
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  const views = { live: liveView, day: dayView, month: monthView, more: moreView };
  app.innerHTML = (views[S.tab] || liveView)();
  if (S.tab === 'day') drawDayCharts();
  if (S.tab === 'month') drawMonthChart();
  bindView();
}

function tile(color, label, val, note) {
  const [v, u] = val;
  return `<div class="card tile"><div class="lab"><span class="dot" style="background:var(${color})"></span>${label}</div>
    <div class="val">${v}<small>${u}</small></div><div class="note">${note}</div></div>`;
}

function liveView() {
  const L = S.live;
  if (!L) return `<header><div><h1>Jetzt</h1></div></header><div class="loading">Warte auf Daten vom Sammler …</div>`;
  const age = Date.now() / 1000 - L.ts;
  const bat = L.bat_w ?? 0, grid = L.grid_w;
  const batNote = Math.abs(bat) < 30 ? 'Ruhe' : bat < 0 ? 'lädt' : 'entlädt';
  const gridNote = (grid == null ? 'Zähler fehlt' : Math.abs(grid) < 30 ? 'ausgeglichen' : grid < 0 ? 'Einspeisung' : 'Bezug') + (L.grid_est ? ', geschätzt' : '');
  const t = L.today || {}, k = kpis(t);
  let warn = '';
  if (age > 120) warn += `<div class="banner warn">⚠️ <span>Der Sammler hat sich seit ${age > 5400 ? nf(age / 3600) + ' Stunden' : nf(age / 60) + ' Minuten'} nicht gemeldet. Die Werte sind nicht aktuell.</span></div>`;
  else if (L.meter_ok === false && L.grid_w == null) warn += `<div class="banner warn">⚠️ <span>Der Netzzähler liefert gerade keine Werte. Netz und Hausverbrauch fehlen.</span></div>`;
  const since = L.today_since > 15 ? `<div class="banner info">ℹ️ <span>Netz, Batterie und Verbrauch werden heute erst ab ${hm(L.today_since)} Uhr gezählt.</span></div>` : '';
  return `
  <header><div><h1>Jetzt</h1><div class="sub">Stand ${new Date(L.ts * 1000).toLocaleTimeString('de-DE')}</div></div>
    <button class="icon-btn" data-act="refresh" aria-label="Aktualisieren">↻</button></header>
  ${warn}
  <div class="grid2">
    ${tile('--pv', 'Sonne', pw(L.pv_w), L.pv_w > 0 ? 'Erzeugung' : 'keine Erzeugung')}
    ${tile('--house', 'Haus', pw(L.house_w), 'Verbrauch' + (L.grid_est ? ', geschätzt' : ''))}
    <div class="card tile"><div class="lab"><span class="dot" style="background:var(--bat)"></span>Batterie</div>
      <div class="val">${nf(L.soc)}<small>%</small></div>
      <div class="note">${batNote}${Math.abs(bat) >= 30 ? ' mit ' + pw(bat).join(' ') : ''}</div>
      <div class="socbar"><i style="width:${Math.max(0, Math.min(100, L.soc || 0))}%"></i></div></div>
    ${tile('--net', 'Netz', pw(grid), gridNote)}
  </div>
  <p class="summary">${summary(L)}</p>
  <h2>Heute</h2>
  ${since}
  <div class="grid3">
    ${kpiTile('Erzeugt', kwh(t.pv), 'kWh')}
    ${kpiTile('Verbraucht', kwh(t.house), 'kWh')}
    ${kpiTile('Autarkie', pct(k && k.autark), '%')}
    ${kpiTile('Eingespeist', kwh(t.grid_out), 'kWh')}
    ${kpiTile('Bezogen', kwh(t.grid_in), 'kWh')}
    ${kpiTile('Wert', k ? nf(k.value, 2) : '–', '€')}
  </div>
  <p class="foot">Batterie ${L.bat_temp != null ? nf(L.bat_temp, 1) + ' °C · ' : ''}Kapazität ${nf(L.bat_health)} % · Gesamtertrag ${nf(L.pv_total_kwh)} kWh</p>`;
}
const kpiTile = (label, v, u) => `<div class="card tile kpi"><div class="lab">${label}</div><div class="val">${v}<small>${u}</small></div></div>`;

function summary(L) {
  const pv = L.pv_w || 0, house = L.house_w, grid = L.grid_w, bat = L.bat_w || 0;
  if (house == null) return pv > 0 ? `Die Anlage erzeugt gerade ${pw(pv).join(' ')}.` : 'Die Anlage erzeugt gerade keinen Strom.';
  const parts = [];
  if (pv > 30) {
    const share = Math.min(1, pv / Math.max(1, house));
    parts.push(share >= 0.99 ? 'Die Sonne deckt den ganzen Verbrauch.' : `Die Sonne deckt ${nf(share * 100)} % des Verbrauchs.`);
  } else parts.push('Keine Sonne.');
  if (bat < -30) parts.push(`${pw(-bat).join(' ')} fließen in die Batterie.`);
  else if (bat > 30) parts.push(`Die Batterie liefert ${pw(bat).join(' ')}.`);
  if (grid != null && grid < -30) parts.push(`${pw(-grid).join(' ')} gehen ins Netz.`);
  else if (grid != null && grid > 30) parts.push(`${pw(grid).join(' ')} kommen aus dem Netz.`);
  return parts.join(' ');
}

/* ---------- Tag ---------- */
function dayView() {
  const d = S.dayDate, isToday = dayKey(d) === dayKey(new Date());
  const label = isToday ? 'Heute' : d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
  const D = S.day, t = D && D.totals, k = kpis(t);
  const body = !D ? `<div class="card loading">Für diesen Tag gibt es keine Daten.</div>` : `
    <div class="card"><div class="lab sub">Leistung</div>
      <div class="chart" id="c-power"></div>
      <div class="legend"><span><i style="background:var(--pv)"></i>Sonne</span><span><i style="background:var(--house)"></i>Haus</span><span><i style="background:var(--net)"></i>Netz (unter 0 = Einspeisung)</span></div>
    </div>
    <div class="card" style="margin-top:12px"><div class="lab sub">Batterie-Ladestand</div><div class="chart" id="c-soc"></div></div>
    <h2>Summen</h2>
    ${D.start && D.start.m > 15 ? `<div class="banner info">ℹ️ <span>Netz, Batterie und Verbrauch erst ab ${hm(D.start.m)} Uhr gezählt.</span></div>` : ''}
    <div class="grid3">
      ${kpiTile('Erzeugt', kwh(t && t.pv), 'kWh')}
      ${kpiTile('Verbraucht', kwh(t && t.house), 'kWh')}
      ${kpiTile('Autarkie', pct(k && k.autark), '%')}
      ${kpiTile('Eigenverbrauch', pct(k && k.own), '%')}
      ${kpiTile('Eingespeist', kwh(t && t.grid_out), 'kWh')}
      ${kpiTile('Bezogen', kwh(t && t.grid_in), 'kWh')}
      ${kpiTile('In Batterie', kwh(t && t.bat_in), 'kWh')}
      ${kpiTile('Aus Batterie', kwh(t && t.bat_out), 'kWh')}
      ${kpiTile('Wert', k ? nf(k.value, 2) : '–', '€')}
    </div>
    <details><summary>Als Tabelle anzeigen</summary>${dayTable(D)}</details>`;
  return `<header><div><h1>Tag</h1></div></header>
    <div class="daynav"><button data-act="day-1" aria-label="Vorheriger Tag">‹</button><b>${label}</b>
      <button data-act="day+1" aria-label="Nächster Tag" ${isToday ? 'disabled' : ''}>›</button></div>${body}`;
}

function dayTable(D) {
  const rows = (D.points || []).filter(p => p.m % 60 === 0 || p.m % 60 < 5).map(p =>
    `<tr><td>${hm(p.m - p.m % 60)}</td><td>${nf(p.pv)}</td><td>${p.house == null ? '–' : nf(p.house)}</td><td>${p.grid == null ? '–' : nf(p.grid)}</td><td>${nf(p.soc)}</td></tr>`).join('');
  return `<table class="data"><tr><th>Uhrzeit</th><th>Sonne W</th><th>Haus W</th><th>Netz W</th><th>Akku %</th></tr>${rows}</table>`;
}

/* Linienchart mit Fadenkreuz. series: [{key, color, label, area}] */
function lineChart(el, pts, series, opt) {
  if (!el) return;
  const W = el.clientWidth || 340, H = opt.h || 200, L = 42, R = 8, T = 10, B = 22;
  const xs = m => L + (m / 1440) * (W - L - R);
  let lo = opt.min ?? 0, hi = opt.max ?? 0;
  if (opt.max == null) for (const p of pts) for (const s of series) { const v = p[s.key]; if (v != null) { hi = Math.max(hi, v); lo = Math.min(lo, v); } }
  if (opt.max == null) { const step = niceStep((hi - lo) / 4); hi = Math.ceil(hi / step) * step || step; lo = Math.floor(lo / step) * step; }
  const ys = v => T + (hi - v) / (hi - lo || 1) * (H - T - B);
  const step = opt.ticks || niceStep((hi - lo) / 4);
  let g = '';
  for (let v = lo; v <= hi + 1e-9; v += step) {
    g += `<line x1="${L}" x2="${W - R}" y1="${ys(v)}" y2="${ys(v)}" stroke="var(${v === 0 ? '--line' : '--grid'})" stroke-width="1"/>`;
    g += `<text x="${L - 6}" y="${ys(v) + 4}" text-anchor="end">${opt.fmt ? opt.fmt(v) : nf(v)}</text>`;
  }
  for (let h = 0; h <= 24; h += 6) g += `<text x="${xs(h * 60)}" y="${H - 4}" text-anchor="${h === 0 ? 'start' : h === 24 ? 'end' : 'middle'}">${pad(h)}:00</text>`;
  let marks = '';
  for (const s of series) {
    const seg = pts.filter(p => p[s.key] != null);
    if (!seg.length) continue;
    const d = seg.map((p, i) => `${i ? 'L' : 'M'}${xs(p.m).toFixed(1)},${ys(p[s.key]).toFixed(1)}`).join('');
    if (s.area) marks += `<path d="${d}L${xs(seg[seg.length - 1].m)},${ys(0)}L${xs(seg[0].m)},${ys(0)}Z" fill="var(${s.color})" opacity=".16"/>`;
    marks += `<path d="${d}" fill="none" stroke="var(${s.color})" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(opt.aria)}">${g}${marks}
    <line class="xh" y1="${T}" y2="${H - B}" stroke="var(--ink3)" stroke-width="1" visibility="hidden"/>
    <g class="xd"></g><rect x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent"/></svg><div class="tip"></div>`;
  const svg = el.querySelector('svg'), tip = el.querySelector('.tip'), xh = svg.querySelector('.xh'), xd = svg.querySelector('.xd');
  const move = ev => {
    const r = svg.getBoundingClientRect(), x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
    const m = (x * W / r.width - L) / (W - L - R) * 1440;
    let best = null; for (const p of pts) if (!best || Math.abs(p.m - m) < Math.abs(best.m - m)) best = p;
    if (!best) return;
    const px = xs(best.m);
    xh.setAttribute('x1', px); xh.setAttribute('x2', px); xh.setAttribute('visibility', 'visible');
    xd.innerHTML = series.filter(s => best[s.key] != null).map(s => `<circle cx="${px}" cy="${ys(best[s.key])}" r="4.5" fill="var(${s.color})" stroke="var(--card)" stroke-width="2"/>`).join('');
    tip.innerHTML = `<b>${hm(best.m)} Uhr</b>` + series.map(s => `<div class="row"><span class="dot" style="background:var(${s.color})"></span><span>${s.label}</span><span>${best[s.key] == null ? '–' : opt.tipFmt(best[s.key], s.key)}</span></div>`).join('');
    tip.style.display = 'block';
    const sx = px * r.width / W, tw = tip.offsetWidth;
    tip.style.left = Math.max(0, Math.min(r.width - tw, sx + (sx > r.width / 2 ? -tw - 12 : 12))) + 'px';
  };
  const leave = () => { tip.style.display = 'none'; xh.setAttribute('visibility', 'hidden'); xd.innerHTML = ''; };
  svg.addEventListener('pointermove', move); svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', leave);
}
function niceStep(raw) {
  if (raw <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(raw)), n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function drawDayCharts() {
  const D = S.day; if (!D) return;
  const pts = D.points || [];
  const fmtW = v => Math.abs(v) >= 1000 ? nf(v / 1000, v % 1000 ? 1 : 0) + ' kW' : nf(v) + ' W';
  lineChart($('#c-power'), pts, [
    { key: 'pv', color: '--pv', label: 'Sonne', area: true },
    { key: 'house', color: '--house', label: 'Haus' },
    { key: 'grid', color: '--net', label: 'Netz' }
  ], { h: 220, aria: 'Leistungsverlauf des Tages', fmt: fmtW, tipFmt: (v, k) => k !== 'grid' ? pw(v).join(' ') : Math.abs(v) < 30 ? '0 W' : pw(v).join(' ') + (v < 0 ? ' raus' : ' rein') });
  lineChart($('#c-soc'), pts, [{ key: 'soc', color: '--bat', label: 'Ladestand', area: true }],
    { h: 120, min: 0, max: 100, ticks: 50, aria: 'Batterie-Ladestand des Tages', fmt: v => v + ' %', tipFmt: v => nf(v) + ' %' });
}

/* ---------- Monat ---------- */
function monthView() {
  const d = S.monthDate, isNow = monthKey(d) === monthKey(new Date());
  const label = d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  const days = (S.month && S.month.days) || {};
  const T = { pv: 0, house: 0, grid_in: 0, grid_out: 0, bat_in: 0, bat_out: 0 };
  for (const t of Object.values(days)) for (const k in T) T[k] += t[k] || 0;
  const k = kpis(T), has = Object.keys(days).length > 0;
  return `<header><div><h1>Monat</h1></div></header>
    <div class="daynav"><button data-act="mon-1" aria-label="Vorheriger Monat">‹</button><b>${label}</b>
      <button data-act="mon+1" aria-label="Nächster Monat" ${isNow ? 'disabled' : ''}>›</button></div>
    ${!has ? `<div class="card loading">Für diesen Monat gibt es keine Daten.</div>` : `
    <div class="card"><div class="lab sub">Pro Tag in kWh</div><div class="chart" id="c-month"></div>
      <div class="legend"><span><i style="background:var(--pv)"></i>Erzeugt</span><span><i style="background:var(--house)"></i>Verbraucht</span></div></div>
    <h2>Summen</h2>
    <div class="grid3">
      ${kpiTile('Erzeugt', kwh(T.pv), 'kWh')}
      ${kpiTile('Verbraucht', kwh(T.house), 'kWh')}
      ${kpiTile('Autarkie', pct(k && k.autark), '%')}
      ${kpiTile('Eingespeist', kwh(T.grid_out), 'kWh')}
      ${kpiTile('Bezogen', kwh(T.grid_in), 'kWh')}
      ${kpiTile('Wert', k ? nf(k.value, 0) : '–', '€')}
    </div>
    <details><summary>Als Tabelle anzeigen</summary><table class="data"><tr><th>Tag</th><th>Erzeugt</th><th>Verbraucht</th><th>Einsp.</th><th>Bezug</th></tr>
      ${Object.keys(days).sort().map(dd => { const t = days[dd]; return `<tr><td>${+dd}.</td><td>${kwh(t.pv)}</td><td>${kwh(t.house)}</td><td>${kwh(t.grid_out)}</td><td>${kwh(t.grid_in)}</td></tr>`; }).join('')}
    </table></details>`}`;
}

function drawMonthChart() {
  const el = $('#c-month'); if (!el || !S.month) return;
  const d = S.monthDate, n = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(), days = S.month.days || {};
  const W = el.clientWidth || 340, H = 200, L = 34, R = 4, T = 10, B = 22;
  let hi = 0; for (const t of Object.values(days)) hi = Math.max(hi, t.pv || 0, t.house || 0);
  const step = niceStep(hi / 1000 / 4) * 1000; hi = Math.ceil(hi / step) * step || step;
  const cw = (W - L - R) / n, bw = Math.max(2, (cw - 4) / 2), ys = v => T + (hi - v) / hi * (H - T - B);
  let g = '';
  for (let v = 0; v <= hi + 1; v += step) g += `<line x1="${L}" x2="${W - R}" y1="${ys(v)}" y2="${ys(v)}" stroke="var(${v ? '--grid' : '--line'})"/><text x="${L - 6}" y="${ys(v) + 4}" text-anchor="end">${nf(v / 1000)}</text>`;
  g += `<text x="${L - 6}" y="${T - 0}" text-anchor="end" dy="-2"></text>`;
  /* Balken mit 4px runder Oberkante, unten an der Basis bündig */
  const bar = (x, v, c) => {
    if (!v) return ''; const y = ys(v), h = ys(0) - y, r = Math.min(3, bw / 2, h);
    return `<path d="M${x},${ys(0)}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${ys(0)}Z" fill="var(${c})"/>`;
  };
  let marks = '';
  for (let i = 1; i <= n; i++) {
    const t = days[pad(i)], x = L + (i - 1) * cw + 1;
    if (t) marks += bar(x, t.pv, '--pv') + bar(x + bw + 2, t.house, '--house');
    if (i === 1 || i % 5 === 0) g += `<text x="${x + cw / 2}" y="${H - 4}" text-anchor="middle">${i}</text>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Erzeugung und Verbrauch pro Tag in kWh">${g}${marks}
    <rect class="hl" y="${T}" height="${H - T - B}" width="${cw}" fill="var(--ink3)" opacity="0" /><rect x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent"/></svg><div class="tip"></div>`;
  const svg = el.querySelector('svg'), tip = el.querySelector('.tip'), hl = svg.querySelector('.hl');
  svg.addEventListener('pointermove', show); svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', () => { tip.style.display = 'none'; hl.setAttribute('opacity', 0); });
  function show(ev) {
    const r = svg.getBoundingClientRect(), x = (ev.clientX - r.left) * W / r.width;
    const i = Math.floor((x - L) / cw) + 1, t = days[pad(i)];
    if (i < 1 || i > n || !t) { tip.style.display = 'none'; hl.setAttribute('opacity', 0); return; }
    hl.setAttribute('x', L + (i - 1) * cw); hl.setAttribute('opacity', .08);
    tip.innerHTML = `<b>${i}. ${d.toLocaleDateString('de-DE', { month: 'long' })}</b>
      <div class="row"><span class="dot" style="background:var(--pv)"></span><span>Erzeugt</span><span>${kwh(t.pv)} kWh</span></div>
      <div class="row"><span class="dot" style="background:var(--house)"></span><span>Verbraucht</span><span>${kwh(t.house)} kWh</span></div>
      <div class="row"><span></span><span>Autarkie</span><span>${pct(kpis(t) && kpis(t).autark)} %</span></div>`;
    tip.style.display = 'block';
    const sx = (L + (i - 0.5) * cw) * r.width / W, tw = tip.offsetWidth;
    tip.style.left = Math.max(0, Math.min(r.width - tw, sx + (sx > r.width / 2 ? -tw - 12 : 12))) + 'px';
  }
}

/* ---------- Profil, Einstellungen, Freigaben ---------- */
function moreView() {
  const p = prefs(), isAdmin = S.profile.role === 'admin';
  const pending = S.users.filter(u => !u.approved), members = S.users.filter(u => u.approved);
  const uRow = u => `<div class="item"><div><b>${esc(u.name || u.email)}</b><div class="sub">${esc(u.email)}</div></div>
    <div style="display:flex;gap:8px;align-items:center">${u.approved
      ? `<span class="pill">${u.role === 'admin' ? 'Admin' : 'Freigegeben'}</span>${u.id !== S.user.uid ? `<button class="btn small danger" data-act="revoke" data-id="${u.id}">Sperren</button>` : ''}`
      : `<button class="btn small" data-act="approve" data-id="${u.id}">Freigeben</button><button class="btn small danger" data-act="remove" data-id="${u.id}">Ablehnen</button>`}</div></div>`;
  return `<header><div><h1>Profil</h1><div class="sub">${esc(S.profile.name)} · ${esc(S.profile.email)}</div></div></header>
    <h2>Preise für die Berechnung</h2>
    <div class="card">
      <label class="f" for="price" style="margin-top:0">Strompreis Bezug (€ pro kWh)</label>
      <input class="f" id="price" type="number" inputmode="decimal" step="0.01" value="${p.price}">
      <label class="f" for="feed">Einspeisevergütung (€ pro kWh)</label>
      <input class="f" id="feed" type="number" inputmode="decimal" step="0.001" value="${p.feed}">
      <div class="sub" style="margin-top:10px">"Wert" = selbst genutzter Strom × Strompreis + Einspeisung × Vergütung. Gilt nur auf diesem Gerät.</div>
    </div>
    ${isAdmin ? `<h2>Zugänge</h2>
      ${pending.length ? `<div class="card list" style="margin-bottom:12px"><div class="sub">Warten auf Freigabe</div>${pending.map(uRow).join('')}</div>` : ''}
      <div class="card list">${members.map(uRow).join('') || '<div class="sub">Keine</div>'}</div>
      <div class="sub" style="margin-top:8px">Neue Personen öffnen die App, registrieren sich und erscheinen hier zur Freigabe.</div>` : ''}
    <button class="btn ghost" data-act="logout" style="margin-top:28px">Abmelden</button>
    <p class="foot">Version ${APP_VERSION}${DEMO ? ' · Demo' : ''}</p>`;
}

function authView(mode = S.authMode || 'login') {
  return `<div class="auth"><h1>PV Zuhause</h1><div class="sub">${mode === 'login' ? 'Anmelden, um die Anlage zu sehen.' : 'Konto anlegen. Danach gibt Till dich frei.'}</div>
    <form id="auth">
      ${mode === 'register' ? `<label class="f" for="name">Name</label><input class="f" id="name" autocomplete="name" required>` : ''}
      <label class="f" for="email">E-Mail</label><input class="f" id="email" type="email" autocomplete="email" required>
      <label class="f" for="pass">Passwort</label><input class="f" id="pass" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" minlength="8" required>
      <div class="err" id="err"></div>
      <button class="btn" type="submit">${mode === 'login' ? 'Anmelden' : 'Registrieren'}</button>
    </form>
    <button class="btn ghost" data-act="mode">${mode === 'login' ? 'Noch kein Konto? Registrieren' : 'Schon ein Konto? Anmelden'}</button>
    ${mode === 'login' ? '<button class="btn ghost" data-act="reset">Passwort vergessen</button>' : ''}
    <p class="foot">Tipp: In Safari über Teilen › Zum Home-Bildschirm wird daraus eine App.</p></div>`;
}
const AUTH_ERR = {
  'auth/invalid-credential': 'E-Mail oder Passwort stimmt nicht.', 'auth/wrong-password': 'E-Mail oder Passwort stimmt nicht.',
  'auth/user-not-found': 'E-Mail oder Passwort stimmt nicht.', 'auth/email-already-in-use': 'Für diese E-Mail gibt es schon ein Konto.',
  'auth/weak-password': 'Das Passwort braucht mindestens 8 Zeichen.', 'auth/invalid-email': 'Die E-Mail-Adresse ist ungültig.',
  'auth/too-many-requests': 'Zu viele Versuche. Bitte kurz warten.', 'auth/network-request-failed': 'Keine Verbindung.'
};
function bindAuth() {
  const err = m => { $('#err').textContent = m; };
  $('#auth').addEventListener('submit', async e => {
    e.preventDefault(); err('');
    const email = $('#email').value.trim(), pass = $('#pass').value;
    try {
      if (S.authMode === 'register') await S.src.register($('#name').value.trim(), email, pass);
      else await S.src.login(email, pass);
    } catch (x) { err(AUTH_ERR[x.code] || 'Das hat nicht geklappt.'); console.warn(x); }
  });
  document.querySelector('[data-act="mode"]').onclick = () => { S.authMode = S.authMode === 'register' ? 'login' : 'register'; render(); };
  const r = document.querySelector('[data-act="reset"]');
  if (r) r.onclick = async () => {
    const email = $('#email').value.trim(); if (!email) return err('Bitte zuerst die E-Mail eintragen.');
    try { await S.src.reset(email); err(''); $('#err').style.color = 'var(--ok)'; $('#err').textContent = 'Mail zum Zurücksetzen ist unterwegs.'; }
    catch (x) { err(AUTH_ERR[x.code] || 'Das hat nicht geklappt.'); }
  };
}
function pendingView() {
  return `<div class="auth"><h1>Fast geschafft</h1><p class="sub" style="font-size:16px;line-height:1.6">Dein Konto ist angelegt. Till muss dich noch freigeben, danach erscheinen die Daten hier automatisch.</p>
    <button class="btn ghost" data-act="logout">Abmelden</button></div>`;
}
function bindPending() { document.querySelector('[data-act="logout"]').onclick = () => S.src.logout(); }

function bindView() {
  const on = (sel, fn) => document.querySelectorAll(sel).forEach(b => b.addEventListener('click', fn));
  on('[data-act="refresh"]', () => location.reload());
  on('[data-act="day-1"]', () => shiftDay(-1)); on('[data-act="day+1"]', () => shiftDay(1));
  on('[data-act="mon-1"]', () => shiftMonth(-1)); on('[data-act="mon+1"]', () => shiftMonth(1));
  on('[data-act="logout"]', () => S.src.logout());
  on('[data-act="approve"]', e => S.src.setUser(e.target.dataset.id, { approved: true }));
  on('[data-act="revoke"]', e => { if (confirm('Zugang wirklich sperren?')) S.src.setUser(e.target.dataset.id, { approved: false }); });
  on('[data-act="remove"]', e => { if (confirm('Anfrage ablehnen und entfernen?')) S.src.delUser(e.target.dataset.id); });
  const num = (id, k) => { const el = $('#' + id); if (el) el.addEventListener('change', () => { const v = parseFloat(el.value.replace(',', '.')); if (v >= 0) setPref(k, v); }); };
  num('price', 'price'); num('feed', 'feed');
}

/* ---------- Laden ---------- */
let dayUnsub = null;
async function loadDay() {
  if (dayUnsub) { dayUnsub(); dayUnsub = null; }
  const k = dayKey(S.dayDate);
  S.day = undefined;
  if (k === dayKey(new Date())) dayUnsub = S.src.onDay(k, d => { S.day = d; if (S.tab === 'day') render(); });
  else { S.day = await S.src.getDay(k).catch(() => null); if (S.tab === 'day') render(); }
}
function shiftDay(n) { const d = new Date(S.dayDate); d.setDate(d.getDate() + n); if (dayKey(d) > dayKey(new Date())) return; S.dayDate = d; loadDay(); render(); }
async function loadMonth() { S.month = await S.src.getMonth(monthKey(S.monthDate)).catch(() => null); if (S.tab === 'month') render(); }
function shiftMonth(n) { const d = new Date(S.monthDate.getFullYear(), S.monthDate.getMonth() + n, 1); if (monthKey(d) > monthKey(new Date())) return; S.monthDate = d; S.month = null; loadMonth(); render(); }

function setTab(t) {
  S.tab = t; setPref('tab', t);
  if (t === 'day') { if (S.day === undefined || S.day === null) loadDay(); }
  if (t === 'month') loadMonth();
  render(); window.scrollTo(0, 0);
}

async function start() {
  try { S.src = DEMO ? demoSource() : await firebaseSource(); }
  catch (e) { $('#app').innerHTML = `<div class="auth"><h1>PV Zuhause</h1><p class="err">Verbindung zur Datenbank fehlgeschlagen. Bitte später erneut öffnen.</p></div>`; console.error(e); return; }
  document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  S.src.onAuth(user => {
    S.src.stop && !user && S.src.stop();
    S.user = user; S.profile = null; S.live = null;
    if (!user) return render();
    render();
    S.src.onProfile(user.uid, prof => {
      const was = S.profile && S.profile.approved;
      S.profile = prof || { approved: false, name: '', email: user.email, role: 'viewer' };
      if (S.profile.approved && !was) {
        S.src.onLive(l => { S.live = l; if (S.tab === 'live') render(); });
        if (S.profile.role === 'admin') S.src.onUsers(u => { S.users = u.sort((a, b) => (a.created || 0) - (b.created || 0)); if (S.tab === 'more') render(); });
        loadDay(); if (S.tab === 'month') loadMonth();
      }
      render();
    });
  });
  let rw = innerWidth;
  addEventListener('resize', () => { if (Math.abs(innerWidth - rw) > 20) { rw = innerWidth; if (S.tab === 'day' || S.tab === 'month') render(); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.tab === 'live') render(); });
  setInterval(() => { if (S.tab === 'live' && S.live && !document.hidden) render(); }, 30000);
  if ('serviceWorker' in navigator && !DEMO) navigator.serviceWorker.register('sw.js').catch(() => {});
}
start();
