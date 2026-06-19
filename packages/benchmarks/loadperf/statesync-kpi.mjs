/**
 * State-sync KPI.
 *
 * Connects N WebSocket clients and measures how consistently broadcasts reach
 * every client: inter-client arrival skew (p50/p95), desync events (a broadcast
 * that fails to reach all clients within a window), and reconnect time (close
 * client 0 and time how long it takes to reconnect).
 *
 * Target derivation (in priority order):
 *   1. LOADPERF_WS_URL                              explicit ws/wss URL
 *   2. LOADPERF_BASE_URL + LOADPERF_WS_PATH (/ws)   http->ws, https->wss
 * A ?token=LOADPERF_WS_TOKEN query param is appended when the env var is set.
 *
 *   LOADPERF_BASE_URL=http://127.0.0.1:31337 node ... statesync-kpi.mjs
 *   LOADPERF_WS_URL=ws://host/ws node ... statesync-kpi.mjs
 *
 * Env:
 *   LOADPERF_CLIENTS       client count (default 4)
 *   LOADPERF_WS_PATH       ws path appended to base url (default /ws)
 *   LOADPERF_WS_TOKEN      appended as ?token=… when set
 *   LOADPERF_OBSERVE_MS    broadcast observation window (default 14000)
 *
 * Uses the Node global WebSocket (Node 22+). Fail-safe: if the first client
 * cannot connect, records { skipped: true, error } and exits 2.
 *
 * Exit: 0 pass, 1 budget fail, 2 skipped/unavailable.
 */

import { recordResult, loadBudgets, sleep, ms } from "./lib.mjs";

const NOW = new Date().toISOString();
const JSON_ONLY = process.argv.includes("--json");

const CLIENT_COUNT = Math.max(2, Number(process.env.LOADPERF_CLIENTS ?? 4));
const OBSERVE_MS = Number(process.env.LOADPERF_OBSERVE_MS ?? 14_000);
const WS_PATH = process.env.LOADPERF_WS_PATH ?? "/ws";
const WS_TOKEN = process.env.LOADPERF_WS_TOKEN ?? null;
const CONNECT_TIMEOUT_MS = 8000;
const RECONNECT_TIMEOUT_MS = 15_000;

function resolveWsUrl() {
  let url = process.env.LOADPERF_WS_URL ?? null;
  if (!url) {
    const base = process.env.LOADPERF_BASE_URL;
    if (!base) {
      throw new Error("set LOADPERF_WS_URL or LOADPERF_BASE_URL to point at a server");
    }
    const ws = base.replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/$/, "");
    url = `${ws}${WS_PATH.startsWith("/") ? WS_PATH : `/${WS_PATH}`}`;
  }
  if (WS_TOKEN) url += `${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(WS_TOKEN)}`;
  return url;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Open a WebSocket and resolve once OPEN (or reject on error/timeout). */
function open(url, onMessage) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    const timer = setTimeout(() => {
      try {
        sock.close();
      } catch {
        // ignore
      }
      reject(new Error(`connect timeout after ${CONNECT_TIMEOUT_MS}ms`));
    }, CONNECT_TIMEOUT_MS);
    sock.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("websocket error"));
    });
    if (onMessage) sock.addEventListener("message", onMessage);
  });
}

async function main() {
  let wsUrl;
  try {
    wsUrl = resolveWsUrl();
  } catch (err) {
    return skip(err);
  }
  if (typeof WebSocket === "undefined") {
    return skip(new Error("global WebSocket unavailable (need Node 22+)"));
  }

  /** Per-message arrival timestamps keyed by a content signature. */
  const arrivals = new Map(); // sig -> { times: number[], clients: Set<number> }
  const sockets = [];

  const makeHandler = (clientIdx) => (ev) => {
    const now = performance.now();
    const data = typeof ev.data === "string" ? ev.data : "<binary>";
    const sig = `${data.length}:${data.slice(0, 64)}`;
    let rec = arrivals.get(sig);
    if (!rec) {
      rec = { times: [], clients: new Set(), firstAt: now };
      arrivals.set(sig, rec);
    }
    rec.times.push(now);
    rec.clients.add(clientIdx);
  };

  try {
    for (let i = 0; i < CLIENT_COUNT; i++) {
      const sock = await open(wsUrl, makeHandler(i));
      sockets.push(sock);
    }
  } catch (err) {
    for (const s of sockets) {
      try {
        s.close();
      } catch {
        // ignore
      }
    }
    return skip(new Error(`client connect failed: ${err?.message ?? String(err)}`));
  }

  await sleep(OBSERVE_MS);

  // Skew = max-min arrival across clients for broadcasts that reached >1 client.
  const skews = [];
  let desyncEvents = 0;
  let broadcastsObserved = 0;
  for (const rec of arrivals.values()) {
    if (rec.clients.size < 2) continue; // direct/handshake messages, not broadcasts
    broadcastsObserved++;
    const skew = Math.max(...rec.times) - Math.min(...rec.times);
    skews.push(skew);
    // A broadcast that reached some — but not all — clients is a desync.
    if (rec.clients.size < CLIENT_COUNT) desyncEvents++;
  }
  skews.sort((a, b) => a - b);
  const skewP50 = quantile(skews, 0.5);
  const skewP95 = quantile(skews, 0.95);

  // Reconnect: close client 0, time until a fresh socket reaches OPEN.
  let reconnectMs = null;
  try {
    sockets[0].close();
  } catch {
    // ignore
  }
  const reconnectStart = performance.now();
  try {
    const reopened = await Promise.race([
      open(wsUrl, makeHandler(0)),
      sleep(RECONNECT_TIMEOUT_MS).then(() => {
        throw new Error("reconnect timeout");
      }),
    ]);
    reconnectMs = performance.now() - reconnectStart;
    sockets[0] = reopened;
  } catch {
    reconnectMs = null; // could not reconnect in window
  }

  for (const s of sockets) {
    try {
      s.close();
    } catch {
      // ignore
    }
  }

  const b = loadBudgets().statesync;
  const checks = [
    { name: "broadcastP95Ms", value: skewP95, budget: b.broadcastP95Ms, unit: "ms" },
    { name: "reconnectMs", value: reconnectMs, budget: b.reconnectMs, unit: "ms" },
    { name: "maxDesyncEvents", value: desyncEvents, budget: b.maxDesyncEvents, unit: "count" },
  ].map((c) => ({ ...c, pass: c.value != null && c.value <= c.budget }));

  const result = {
    summary: {
      wsUrl,
      clients: CLIENT_COUNT,
      observeMs: OBSERVE_MS,
      broadcastsObserved,
      skewP50Ms: skewP50,
      skewP95Ms: skewP95,
      desyncEvents,
      reconnectMs,
    },
    checks,
    pass: checks.every((c) => c.pass),
  };

  const { file } = recordResult("statesync", result, NOW);

  if (JSON_ONLY) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("\n=== State-sync KPI ===");
    console.log(`ws url:        ${wsUrl}`);
    console.log(`clients:       ${CLIENT_COUNT}`);
    console.log(`broadcasts:    ${broadcastsObserved} (over ${ms(OBSERVE_MS)})`);
    console.log(`skew p50/p95:  ${ms(skewP50)} / ${ms(skewP95)}`);
    console.log(`desync events: ${desyncEvents}`);
    console.log(`reconnect:     ${ms(reconnectMs)}`);
    console.log("\n-- budget checks --");
    for (const c of checks) {
      const fmt = (v) => (v == null ? "—" : c.unit === "ms" ? ms(v) : String(v));
      console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}: ${fmt(c.value)} / budget ${fmt(c.budget)}`);
    }
    console.log(`\nresult: ${result.pass ? "PASS" : "FAIL"}   recorded -> ${file}\n`);
  }
  process.exit(result.pass ? 0 : 1);
}

function skip(err) {
  const payload = { skipped: true, error: err?.message ?? String(err) };
  const { file } = recordResult("statesync", payload, NOW);
  if (JSON_ONLY) console.log(JSON.stringify({ ...payload, file }, null, 2));
  else console.error(`[statesync-kpi] skipped: ${payload.error}\nrecorded -> ${file}`);
  process.exit(2);
}

main();
