'use strict';

const seenToasts = new Set();
let bootToasts = true;
let selectedMint = null;
let displayEquity = null;
let walletGraph = null;
let lastTradeWon = null; // null unknown, true/false

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtUsd(n, d = 2) {
  const x = Number(n) || 0;
  return (x < 0 ? '-' : '') + '$' + Math.abs(x).toFixed(d);
}
function fmtPct(n) {
  const x = Number(n) || 0;
  return (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
}
function shortTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'America/New_York',
    });
  } catch { return ''; }
}
function elapsed(startedAt) {
  const t0 = startedAt ? Date.parse(startedAt) : NaN;
  if (Number.isNaN(t0)) return '00:00:00';
  const total = Math.max(0, Math.floor((Date.now() - t0) / 1000));
  const hh = String(Math.floor(total / 3600)).padStart(2, '0');
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return hh + ':' + mm + ':' + ss;
}
function normKill(rule) {
  return String(rule || '')
    .replace(/24h volume under \$40k \(\$\d+\)/gi, '24h volume under $40k')
    .replace(/already up >80% last hour \(\+?\d+%\)/gi, 'already up >80% last hour')
    .replace(/up >30% last 5m \(\+?\d+%\) — candle skip/gi, 'up >30% last 5m — candle skip');
}
function aggregateKills(killsByRule) {
  const out = {};
  for (const [raw, n] of Object.entries(killsByRule || {})) {
    const key = normKill(raw);
    if (/daily kill/i.test(key)) continue;
    out[key] = (out[key] || 0) + (Number(n) || 0);
  }
  return Object.entries(out).sort((a, b) => b[1] - a[1]);
}

function animateEquity(target) {
  const el = document.getElementById('equity');
  if (displayEquity == null) displayEquity = target;
  const start = displayEquity;
  const end = target;
  const t0 = performance.now();
  const dur = 700;
  function frame(t) {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    displayEquity = start + (end - start) * eased;
    el.textContent = fmtUsd(displayEquity);
    if (p < 1) requestAnimationFrame(frame);
    else displayEquity = end;
  }
  requestAnimationFrame(frame);
}

function pushToast(p) {
  if (!p || !p.id || seenToasts.has(p.id)) return;
  seenToasts.add(p.id);
  if (bootToasts) return;
  const el = document.createElement('div');
  const kind = (p.type || '').toLowerCase();
  const bad = /sell|sold|stop|loss|error/.test(kind);
  el.className = 'toast' + (bad ? ' bad' : '');
  el.innerHTML = '<div class="tt">' + esc(p.title || p.type) + '</div><div class="ts">' + esc(p.subtitle || '') + '</div>';
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4600);
}

function setMechMood(pnlUsd, lastWon) {
  const hero = document.getElementById('heroMech');
  const logo = document.getElementById('logoMech');
  hero.classList.remove('pulse-green', 'pulse-amber', 'pulse-red');
  logo.style.filter = '';
  if (pnlUsd > 0 || lastWon === true) {
    hero.classList.add('pulse-green');
    logo.style.filter = 'drop-shadow(0 0 10px rgba(0,255,136,.7))';
  } else if (lastWon === false || pnlUsd < 0) {
    // below deposits → amber if mild, red if last loss
    if (lastWon === false) {
      hero.classList.add('pulse-red');
      logo.style.filter = 'drop-shadow(0 0 10px rgba(255,59,74,.7))';
    } else {
      hero.classList.add('pulse-amber');
      logo.style.filter = 'drop-shadow(0 0 10px rgba(255,154,31,.65))';
    }
  }
}

function renderChart(hist, sol) {
  const svg = document.getElementById('chart');
  if (!hist || hist.length < 2) { svg.innerHTML = ''; return; }
  const ys = hist.map(h => h.equityUsd != null ? h.equityUsd : (h.equitySol || 0) * sol);
  const min = Math.min(...ys), max = Math.max(...ys), span = max - min || 1;
  const W = 520, H = 54, pad = 3;
  const pts = ys.map((y, i) => {
    const x = pad + (i / (ys.length - 1)) * (W - pad * 2);
    const yy = H - pad - ((y - min) / span) * (H - pad * 2);
    return x.toFixed(1) + ',' + yy.toFixed(1);
  }).join(' ');
  const up = ys[ys.length - 1] >= ys[0];
  const stroke = up ? '#00ff88' : '#ff3b4a';
  svg.innerHTML = '<polyline fill="none" stroke="' + stroke + '" stroke-width="1.8" points="' + pts + '"/>';
}

function buildTerminal(s, lines, meta) {
  const rows = [];
  const acts = s.lastActions || {};
  for (const [a, v] of Object.entries(acts)) {
    rows.push({ cls: 'info', text: '> ' + a.toLowerCase() + ' ' + v });
  }
  for (const n of (s.notifications || []).slice(0, 12)) {
    const msg = n.msg || String(n);
    let cls = 'ok';
    if (/loss|stop|sell|fail|error/i.test(msg)) cls = 'bad';
    // try to make copier buy lines look like the brief
    let text = msg;
    const m = msg.match(/Copied \$(\S+)\s*•\s*\$([0-9.]+)/i);
    if (m) {
      // find matching position for SOL size
      const pos = (s.positions || []).find(p => p.ticker === m[1]);
      const solAmt = pos ? Number(pos.costSol).toFixed(4) : '?';
      text = 'copier bought $' + m[1] + ' ' + solAmt + ' SOL';
      cls = 'ok';
    }
    rows.push({ cls, text: '> ' + text, t: n.t });
  }
  for (const line of (lines || []).slice(-40).reverse()) {
    // "10:41 | PASS | Filter | $ASCEND | reason: ..."
    const parts = line.split('|').map(x => x.trim());
    if (parts.length >= 3) {
      const kind = (parts[1] || '').toUpperCase();
      const agent = (parts[2] || '').toLowerCase();
      const tick = parts[3] || '';
      const reason = (parts[4] || '').replace(/^reason:\s*/i, '');
      let cls = 'dim';
      if (kind === 'PASS' || kind === 'COPY' || kind === 'BUY') cls = 'ok';
      else if (kind === 'KILL' || kind === 'SELL' || kind === 'STOP') cls = 'bad';
      else if (kind === 'CHECK') cls = 'info';
      rows.push({ cls, text: '> ' + agent + ' ' + kind.toLowerCase() + ' ' + tick + (reason ? ' — ' + reason : '') });
    } else {
      rows.push({ cls: 'dim', text: '> ' + line });
    }
  }
  // dedupe consecutive identical
  const out = [];
  let prev = '';
  for (const r of rows) {
    if (r.text === prev) continue;
    prev = r.text;
    out.push(r);
    if (out.length >= 60) break;
  }
  const el = document.getElementById('term');
  el.innerHTML = out.map(r =>
    '<div><span class="prompt">&gt;</span> <span class="' + r.cls + '">' + esc(r.text.replace(/^>\s*/, '')) + '</span></div>'
  ).join('') || '<div class="dim">> awaiting events…</div>';
  // keep scrolled to top (newest first)
  el.scrollTop = 0;
}

function renderPositions(s, meta) {
  const maxOpen = (meta && meta.maxOpen) || 5;
  const list = s.positions || [];
  document.getElementById('posHint').textContent = list.length + '/' + maxOpen;
  const box = document.getElementById('positions');
  if (!list.length) {
    box.innerHTML = '<div style="color:var(--muted);font-size:11px">no open positions</div>';
    return;
  }
  box.innerHTML = list.map(p => {
    const pnlU = Number(p.pnlUsd) || 0;
    const pnlP = Number(p.pnlPct) || 0;
    const sel = selectedMint === (p.id || p.mint) ? ' sel' : '';
    const x = p.exitView || {};   // r3 F6: the position's own stored stop + per-lane live config (server-side)
    return '<div class="pos' + sel + '" data-mint="' + esc(p.id || p.mint) + '">'
      + '<div class="top"><span class="tick">$' + esc(p.ticker) + '</span><span class="tag">OPEN</span></div>'
      + '<div class="grid3">'
      + '<div><div class="k">ENTRY</div>' + (Number(p.entryPriceUsd) || 0).toPrecision(4) + '</div>'
      + '<div><div class="k">MARK</div>' + (Number(p.markPriceUsd) || 0).toPrecision(4) + '</div>'
      + '<div><div class="k">PNL</div><span class="' + (pnlU >= 0 ? 'up' : 'dn') + '">'
      + (pnlU >= 0 ? '+' : '') + fmtUsd(pnlU) + ' (' + fmtPct(pnlP) + ')</span></div>'
      + '<div><div class="k">' + esc(x.stopLabel || 'STOP') + '</div>' + (x.stopPriceUsd ? Number(x.stopPriceUsd).toPrecision(4) : '—') + '</div>'
      + '<div><div class="k">' + esc(x.tpLabel || 'TP') + '</div>' + esc(x.tpText || '—') + '</div>'
      + '<div><div class="k">COST</div>' + fmtUsd(p.costUsd) + '</div>'
      + '</div></div>';
  }).join('');
  box.querySelectorAll('.pos').forEach(el => {
    el.addEventListener('click', () => {
      selectedMint = el.getAttribute('data-mint');
      renderPositions(s, meta);
      renderInspector(s, meta);
    });
  });
}

function renderInspector(s, meta) {
  const box = document.getElementById('inspector');
  const p = (s.positions || []).find(x => (x.id || x.mint) === selectedMint);
  if (!p) {
    box.innerHTML = '<h4>INSPECTOR</h4><div class="empty">select a position →</div>';
    return;
  }
  const x = p.exitView || {};   // r3 F6
  const holdM = x.maxHoldMs ? Math.round(x.maxHoldMs / 60000) + 'm' : '—';
  const laneTp = x.laneTpMarkPct != null ? ' · lane TP ' + (x.laneTpMarkPct >= 0 ? '+' : '') + (x.laneTpMarkPct * 100).toFixed(0) + '% (mark)' : '';
  const sig = p.entrySig ? 'https://solscan.io/tx/' + encodeURIComponent(p.entrySig) : '';
  const tok = p.mint ? 'https://solscan.io/token/' + encodeURIComponent(p.mint) : '';
  const opened = p.openedAt ? shortTime(p.openedAt) : '—';
  box.innerHTML = '<h4>INSPECTOR · $' + esc(p.ticker) + '</h4>'
    + '<div class="row"><span>status</span><span class="up">OPEN</span></div>'
    + '<div class="row"><span>cost</span><span>' + fmtUsd(p.costUsd) + ' / ' + Number(p.costSol || 0).toFixed(4) + ' SOL</span></div>'
    + '<div class="row"><span>entry</span><span>' + (Number(p.entryPriceUsd) || 0).toPrecision(4) + '</span></div>'
    + '<div class="row"><span>mark</span><span>' + (Number(p.markPriceUsd) || 0).toPrecision(4) + '</span></div>'
    + '<div class="row"><span>pnl</span><span class="' + ((p.pnlUsd || 0) >= 0 ? 'up' : 'dn') + '">'
    + fmtUsd(p.pnlUsd) + ' (' + fmtPct(p.pnlPct) + ')</span></div>'
    + '<div class="row"><span>' + esc((x.stopLabel || 'stop').toLowerCase()) + ' (' + esc(x.lane || '?') + ')</span><span>' + (x.stopPriceUsd ? Number(x.stopPriceUsd).toPrecision(4) : '—') + '</span></div>'
    + '<div class="row"><span>' + esc((x.tpLabel || 'take-profit').toLowerCase()) + '</span><span>' + esc((x.tpText || '—') + laneTp) + '</span></div>'
    + '<div class="row"><span>max hold</span><span>' + esc(holdM) + ' · wallet-sell exit</span></div>'
    + '<div class="row"><span>opened (ET)</span><span>' + opened + '</span></div>'
    + '<div class="row"><span>mint</span><span>' + esc(p.mint || '—') + '</span></div>'
    + '<div class="row"><span>action</span><span><button type="button" class="sell-one" data-id="' + esc(p.id || '') + '" style="background:#100e0a;color:#ffb347;border:1px solid rgba(255,154,31,.45);font-family:inherit;font-size:10px">SELL</button></span></div>';
}

// r3 F1: auto-sweep from /api/meta.sweep (live config.js AUTO_SWEEP + state), unknown when the key is missing
function sweepLine(meta) {
  const w = meta && meta.sweep;
  if (!w || w.autoSweep == null) return '<div>· auto-sweep <span class="dn">unknown</span>' + (w && w.label ? ' — ' + esc(w.label.replace(/^auto-sweep: unknown /, '')) : '') + '</div>';
  let h = '<div>· auto-sweep <span class="ok">' + (w.autoSweep ? 'ON hourly' : 'OFF') + '</span>'
    + (w.autoSweep ? ' → ' + esc(w.destinationShort || 'destination unknown') + (w.destinationKnownTJ ? ' (your address)' : '') : ' — profits compound') + '</div>';
  if (w.baselineSol != null) h += '<div>· sweep baseline <b>' + Number(w.baselineSol).toFixed(6) + ' SOL</b>' + (w.baselineSetAt ? ' (pinned ' + esc(shortTime(w.baselineSetAt)) + ')' : '') + '</div>';
  if (w.lastSweep) h += '<div>· last sweep <b>' + Number(w.lastSweep.amountSol).toFixed(4) + ' SOL</b> ' + esc(w.lastSweep.t ? shortTime(w.lastSweep.t) : '?') + ' · ' + esc(w.lastSweep.status) + '</div>';
  return h;
}

function renderRules(meta, s) {
  const exits = (meta.exits || []).map(e => '<div>· <b>' + esc(e) + '</b></div>').join('');
  const rules = (meta.rules || []).map(r => '<div>· ' + esc(r) + '</div>').join('');
  const pk = meta.pubkey || '—';
  document.getElementById('rules').innerHTML =
    '<div><b>EXITS</b></div>' + exits
    + '<div style="margin-top:8px"><b>OPS</b></div>' + rules
    + '<div style="margin-top:8px"><b>BOOK</b></div>'
    + '<div>· wallet <span class="ok">' + esc(pk) + '</span></div>'
    + '<div>· mode <span class="' + (meta.live ? 'ok' : 'dn') + '">' + esc(meta.live ? 'LIVE' : 'NOT LIVE (halted)') + '</span></div>'
    + sweepLine(meta)
    + '<div>· kill floor <span class="ok">disabled</span></div>';
}

function renderAgents(s) {
  const box = document.getElementById('agents');
  box.innerHTML = ['Scout', 'Filter', 'Analyst', 'Copier', 'Risk'].map(a => {
    const act = (s.lastActions && s.lastActions[a]) || 'idle';
    const k = (s.killsByAgent && s.killsByAgent[a]) || 0;
    return '<div style="border:1px solid #1a1814;padding:4px 5px;background:#08080c">'
      + '<div style="color:var(--amber2);font-weight:700;letter-spacing:.08em">' + a.toUpperCase() + '</div>'
      + '<div style="color:var(--text);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + esc(act) + '">' + esc(act) + '</div>'
      + '<div style="color:var(--muted);margin-top:2px">' + k + ' kills</div></div>';
  }).join('');
}

function renderKills(s) {
  const rows = aggregateKills(s.killsByRule).slice(0, 10);
  document.getElementById('kills').innerHTML = rows.map(([r, n]) =>
    '<div class="kill-row"><span class="n">' + n + '</span><span>' + esc(r) + '</span></div>'
  ).join('') || '<div style="color:var(--muted);font-size:11px">none yet</div>';
}

/* ----- wallet network graph ----- */
function initGraph(data) {
  const canvas = document.getElementById('net');
  const ctx = canvas.getContext('2d');
  const wallets = (data && data.wallets) || [];
  const clusters = {
    elite: { color: '#00ff88', label: 'elite ≥70% WR', cx: 0.28, cy: 0.42 },
    good: { color: '#ff9a1f', label: 'good ≥55% WR', cx: 0.62, cy: 0.38 },
    watch: { color: '#7a7468', label: 'watch <55%', cx: 0.45, cy: 0.72 },
    paused: { color: '#ff3b4a', label: 'paused', cx: 0.78, cy: 0.70 },
  };
  const nodes = wallets.map((w, i) => {
    const c = clusters[w.cluster] || clusters.watch;
    const ang = (i * 2.399) + (w.cluster.charCodeAt(0) || 0);
    const rad = 0.08 + (Math.min(w.trades || 1, 80) / 80) * 0.16;
    return {
      ...w,
      color: c.color,
      tx: c.cx + Math.cos(ang) * rad * (0.7 + (i % 5) * 0.08),
      ty: c.cy + Math.sin(ang) * rad * (0.9 + (i % 3) * 0.05),
      x: Math.random(), y: Math.random(),
      vx: 0, vy: 0,
      r: 1.6 + Math.min(3.2, (w.winRate || 0) * 3),
    };
  });
  // edges: connect nearby same-cluster nodes sparsely
  const edges = [];
  const byC = {};
  nodes.forEach((n, i) => { (byC[n.cluster] ||= []).push(i); });
  for (const idxs of Object.values(byC)) {
    for (let i = 0; i < idxs.length; i++) {
      const a = idxs[i];
      const b = idxs[(i + 3) % idxs.length];
      const c = idxs[(i + 7) % idxs.length];
      if (a !== b) edges.push([a, b]);
      if (a !== c && i % 2 === 0) edges.push([a, c]);
    }
  }
  walletGraph = { canvas, ctx, nodes, edges, clusters, t: 0, data };
  document.getElementById('legend').innerHTML = Object.entries(clusters).map(([k, c]) => {
    const n = nodes.filter(x => x.cluster === k).length;
    return '<span><i style="background:' + c.color + '"></i>' + c.label + ' · ' + n + '</span>';
  }).join('');
  document.getElementById('funnelHint').textContent = nodes.length + ' wallets';
  resizeGraph();
}

function resizeGraph() {
  if (!walletGraph) return;
  const { canvas } = walletGraph;
  const parent = canvas.parentElement;
  const w = parent.clientWidth - 4;
  const h = Math.max(150, Math.floor(parent.clientHeight * 0.55));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  walletGraph.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  walletGraph.w = w; walletGraph.h = h;
}

function tickGraph() {
  if (!walletGraph) return;
  const { ctx, nodes, edges, clusters, w, h } = walletGraph;
  if (!w || !h) return;
  walletGraph.t += 1;
  // spring toward cluster targets
  for (const n of nodes) {
    const dx = n.tx - n.x, dy = n.ty - n.y;
    n.vx = (n.vx + dx * 0.04) * 0.86;
    n.vy = (n.vy + dy * 0.04) * 0.86;
    n.x += n.vx; n.y += n.vy;
  }
  ctx.clearRect(0, 0, w, h);
  // faint grid
  ctx.strokeStyle = 'rgba(255,154,31,0.05)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    const x = (i / 5) * w;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  // edges
  ctx.lineWidth = 0.6;
  for (const [ia, ib] of edges) {
    const a = nodes[ia], b = nodes[ib];
    ctx.strokeStyle = a.color.replace(')', ',0.18)').replace('rgb', 'rgba').includes('rgba')
      ? a.color + '22'
      : a.color + '22';
    // simpler:
    ctx.strokeStyle = a.cluster === 'elite' ? 'rgba(0,255,136,0.12)'
      : a.cluster === 'good' ? 'rgba(255,154,31,0.10)'
      : a.cluster === 'paused' ? 'rgba(255,59,74,0.12)'
      : 'rgba(122,116,104,0.10)';
    ctx.beginPath();
    ctx.moveTo(a.x * w, a.y * h);
    ctx.lineTo(b.x * w, b.y * h);
    ctx.stroke();
  }
  // cluster centers glow
  for (const c of Object.values(clusters)) {
    const g = ctx.createRadialGradient(c.cx * w, c.cy * h, 2, c.cx * w, c.cy * h, 48);
    g.addColorStop(0, c.color + '33');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(c.cx * w, c.cy * h, 48, 0, Math.PI * 2); ctx.fill();
  }
  // nodes
  for (const n of nodes) {
    const x = n.x * w, y = n.y * h;
    ctx.beginPath();
    ctx.fillStyle = n.color;
    ctx.globalAlpha = 0.85;
    ctx.arc(x, y, n.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  // particle sparks
  const t = walletGraph.t;
  for (let i = 0; i < 12; i++) {
    const px = ((t * 0.7 + i * 97) % w);
    const py = ((t * 0.35 + i * 53) % h);
    ctx.fillStyle = i % 2 ? 'rgba(0,255,136,0.35)' : 'rgba(255,154,31,0.3)';
    ctx.fillRect(px, py, 1.5, 1.5);
  }
  requestAnimationFrame(tickGraph);
}

async function load() {
  let s, dec, meta, wallets, pnlApi;
  try {
    [s, dec, meta, wallets] = await Promise.all([
      fetch('/api/state').then(r => r.json()),
      fetch('/api/decisions').then(r => r.json()).catch(() => ({ lines: [] })),
      fetch('/api/meta').then(r => r.json()).catch(() => ({})),
      fetch('/api/wallets').then(r => r.json()).catch(() => ({ wallets: [] })),
    ]);
    pnlApi = await fetch('/api/pnl').then(r => r.json()).catch(() => null);
  } catch {
    document.getElementById('equity').textContent = 'offline';
    return;
  }

  const sol = Number(s.solPriceUsd) || 100;
  const eqSol = Number(s.equitySol) || 0;
  const eqUsd = s.equityUsd != null ? Number(s.equityUsd) : eqSol * sol;
  const wlOk = s.winLossOk === true && s.wins != null && s.losses != null;
  const win = wlOk ? Number(s.wins) : null;
  const loss = wlOk ? Number(s.losses) : null;
  const winPct = wlOk && (win + loss) ? Math.round(100 * win / (win + loss)) : null;
  // dashlive: on-chain wallet balance only (state.realBalanceSol via /api/state live-only view)
  const freeSol = Number(s.realBalanceSol) || 0;
  const reserveSol = Number(s.reserveSol) || 0;
  const netSol = Number(s.netSol) || 0;
  const breaker = s.breakerState || {};
  const breakerLabel = [breaker.buysPaused && 'buysPaused', breaker.halfTickets && 'halfTickets', breaker.riskSurgeOff && 'riskSurgeOff', breaker.hardFloor && 'hardFloor'].filter(Boolean).join(',') || 'ok';

  // last trade outcome from closedTrades or notifications
  const closed = s.closedTrades || [];
  if (closed.length) {
    lastTradeWon = (Number(closed[0].pnlUsd) || 0) >= 0;
  } else if ((s.notifications || []).length) {
    const msg = s.notifications[0].msg || '';
    if (/loss|stop/i.test(msg)) lastTradeWon = false;
    else if (/copied|win|profit/i.test(msg)) lastTradeWon = true;
  }

  // walletheadline 10-28 / dashlive: LIVE WALLET BALANCE (= on-chain SOL + live positions at mark), always green, pinned.
  {
    const wb = document.getElementById('walletBal');
    if (wb) wb.innerHTML = fmtUsd(eqUsd) + '<span class="wallet-sol">' + eqSol.toFixed(4) + ' SOL</span>';
  }
  // pnlheadline 10-28: headline = real-time TRADING P&L (closed + open, after fees); deposits/withdrawals excluded.
  // Color by win rate: red < 25%, green > 65%, else yellow (TJ 10:52 AM ET).
  const eqEl = document.getElementById('equity');
  const pnlEl = document.getElementById('pnl');
  // r2: P&L = live equity − books baseline (net funding; sweeps = profit taken). No ledger → 'P&L: baseline pending'.
  const wlTxt = (a) => (a && a.winLossOk ? a.wins + '–' + a.losses : 'W/L pending');
  if (pnlApi && !pnlApi.pnlPending && pnlApi.tradingPnlSol != null) {
    const tp = Number(pnlApi.tradingPnlSol);
    const tpUsd = Number(pnlApi.tradingPnlUsd);
    const wr = pnlApi.winRate;
    eqEl.classList.remove('down', 'c-yellow', 'c-red', 'c-green');
    eqEl.classList.add('c-' + (pnlApi.color || 'yellow'));
    eqEl.textContent = (tpUsd >= 0 ? '+' : '') + fmtUsd(tpUsd);
    eqEl.style.fontSize = '30px';
    pnlEl.className = 'pnl c-' + (pnlApi.color || 'yellow');
    pnlEl.innerHTML = (tp >= 0 ? '+' : '') + tp.toFixed(4) + ' SOL trading P&amp;L · WIN '
      + (wr == null ? '—' : Math.round(wr * 100) + '%') + ' (' + wlTxt(pnlApi) + ')';
    document.getElementById('eqHint').textContent = 'trading P&L · vs books baseline · sweeps = profit taken';
    document.getElementById('pnlSub').innerHTML =
      'realized <b>' + (pnlApi.realizedSol >= 0 ? '+' : '') + Number(pnlApi.realizedSol).toFixed(4) + '</b> · open <b>'
      + (pnlApi.openSol >= 0 ? '+' : '') + Number(pnlApi.openSol).toFixed(4) + '</b> SOL · today '
      + (pnlApi.todayWins == null ? '—' : pnlApi.todayWins + '–' + pnlApi.todayLosses) + '<br>'
      + 'baseline <b>' + Number(pnlApi.baselineSol).toFixed(6) + ' SOL</b> = deposits ' + Number(pnlApi.depositsSol).toFixed(6)
      + ' − withdrawals/sweeps to you ' + Number(pnlApi.withdrawalsSol).toFixed(6) + ' (profit taken, not losses)<br>'
      + '<span style="opacity:.7">source: ' + esc(pnlApi.baselineSource) + (pnlApi.baselineMatchesState ? ' · = state.baselineSol' : ' · ≠ state.baselineSol ' + esc(pnlApi.stateBaselineSol)) + '</span>';
  } else {
    eqEl.classList.remove('down', 'c-yellow', 'c-red', 'c-green');
    eqEl.classList.add('c-yellow');
    const pl = (pnlApi && pnlApi.pendingLabel) || 'P&L: baseline pending';   // r3 F3/F4: sweep in flight / unexplained inflow
    eqEl.textContent = pl;
    eqEl.style.fontSize = '22px';
    pnlEl.className = 'pnl c-yellow';
    pnlEl.textContent = pl + ' · W/L ' + wlTxt(pnlApi);
    document.getElementById('eqHint').textContent = pnlApi && pnlApi.pendingKind === 'sweep_in_flight' ? 'waiting for the balance to show the sweep'
      : pnlApi && pnlApi.pendingKind === 'unexplained_inflow' ? 'balance rose with no trade or deposit row' : 'books ledger not available';
    document.getElementById('pnlSub').textContent = pnlApi ? ('reason: ' + (pnlApi.pendingReason || 'unknown')) : 'reason: /api/pnl unavailable';
  }
  document.getElementById('mult').textContent = 'on-chain ' + freeSol.toFixed(4) + ' SOL';
  document.getElementById('eqMeta').innerHTML =
    '<b>' + eqSol.toFixed(4) + ' SOL</b> live equity · <b>' + freeSol.toFixed(4) + ' SOL</b> on-chain · reserve <b>' + reserveSol.toFixed(4) + '</b> · net <b>' + netSol.toFixed(4) + '</b> · breaker <b>' + breakerLabel + '</b><br>'
    + 'deposits/withdrawals are not P&amp;L · live trades only';
  document.getElementById('stats').innerHTML =
    '<div class="stat"><div class="n">' + (s.copiedCount || 0) + '</div><div class="l">COPIED</div></div>'
    + '<div class="stat"><div class="n">' + (winPct == null ? '—' : winPct + '%') + '</div><div class="l">WIN</div></div>'
    + '<div class="stat"><div class="n">' + (wlOk ? win + '–' + loss : '—') + '</div><div class="l">W–L</div></div>'
    + '<div class="stat"><div class="n">' + (s.positions || []).length + '/' + (meta.maxOpen || 5) + '</div><div class="l">OPEN</div></div>';

  document.getElementById('clock').textContent = elapsed(s.startedAt);
  // dashlive: anything not live reads NOT LIVE (halted)
  const isLive = s.live === true && meta.live !== false;
  const mb = document.getElementById('modeBadge'), lb = document.getElementById('liveBadge');
  mb.textContent = isLive ? 'LIVE' : 'NOT LIVE (halted)';
  lb.textContent = isLive ? '● LIVE' : '● NOT LIVE (halted)';
  lb.classList.toggle('halted', !isLive); mb.classList.toggle('halted', !isLive);
  document.getElementById('footRight').textContent =
    'signals ' + (s.signalsTotal || 0) + ' · wallets ' + ((wallets && wallets.count) || 0);

  // tape
  const items = (s.ticker || []).map(t => {
    const ch = Number(t.change1h) || 0;
    return '<span><b style="color:#f2ead8">$' + esc(t.symbol) + '</b> <span class="' + (ch >= 0 ? 'up' : 'dn') + '">'
      + (ch >= 0 ? '+' : '') + ch.toFixed(1) + '%</span></span>';
  });
  document.getElementById('tape').innerHTML = (items.concat(items).join(' · ') || 'scanning pump.fun + dexscreener…');

  renderChart(s.equityHistory, sol);
  setMechMood(pnlApi && pnlApi.tradingPnlSol != null ? Number(pnlApi.tradingPnlSol) : 0, lastTradeWon);
  renderPositions(s, meta);
  renderInspector(s, meta);
  renderRules(meta, s);
  renderAgents(s);
  renderKills(s);
  buildTerminal(s, dec.lines, meta);

  for (const p of (s.popups || []).slice(0, 10).reverse()) pushToast(p);
  bootToasts = false;

  if (!walletGraph && wallets && wallets.wallets) {
    initGraph(wallets);
    requestAnimationFrame(tickGraph);
  } else if (walletGraph && wallets) {
    document.getElementById('funnelHint').textContent = (wallets.count || 0) + ' wallets';
  }
}

window.addEventListener('resize', resizeGraph);
load();
setInterval(load, 3000);

// t136u/t132u dashboard chips
(function () {
  const prev = window.__mechAfterState;
  window.__mechAfterState = function (s) {
    try { if (typeof prev === 'function') prev(s); } catch (_) {}
    try {
      let el = document.getElementById('mech-extra-flags');
      if (!el) {
        el = document.createElement('div');
        el.id = 'mech-extra-flags';
        el.style.cssText = 'font:12px monospace;opacity:.85;margin:6px 0;display:flex;gap:8px;flex-wrap:wrap';
        const host = document.querySelector('header') || document.body;
        host.appendChild(el);
      }
      const bits = [];
      if (s.dailyLossPaused) bits.push('<span style="color:#f66">DAILY LOSS PAUSE</span>');
      if (s.jitoStats) bits.push('<span style="color:#9c6">Jito land ' + (s.jitoStats.landed||0) + '/' + (s.jitoStats.sent||0) + '</span>');
      el.innerHTML = bits.join(' · ') || '';
    } catch (_) {}
  };
  const _fetch = window.fetch;
  // hook existing poll: if app assigns s globally
  setInterval(async () => {
    try {
      const s = await fetch('/api/state').then(r => r.json());
      if (window.__mechAfterState) window.__mechAfterState(s);
    } catch (_) {}
  }, 8000);
})();

(function () {
  const box = document.getElementById("adReport");
  if (!box) return;
  async function paint() {
    try {
      const report = await fetch("/api/ads/report").then((r) => r.json());
      if (!report || report.enabled !== true) {
        box.textContent = "Ad reporting is off. It stays off until the AdMob report keys are set on this PC.";
        return;
      }
      if (report.error) {
        box.textContent = "Ad report: " + report.error;
        return;
      }
      box.textContent = "Last 7 days: " + report.impressions + " impressions, " + report.clicks + " clicks, $" + report.earnings;
    } catch (err) {
      box.textContent = "Ad reporting is off.";
    }
  }
  paint();
  setInterval(paint, 60000);
})();
