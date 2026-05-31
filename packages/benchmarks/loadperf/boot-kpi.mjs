/**
 * Boot KPI.
 *
 * Measures cold-start of the agent + dashboard API: spawn the dev-server
 * headless, poll GET /api/health until ready, and record wall-clock readyMs
 * plus peak RSS (sampled from /proc/<pid>/status VmRSS while booting).
 *
 * Default: spawn a fresh child and measure cold boot.
 *   node packages/benchmarks/loadperf/boot-kpi.mjs
 *
 * --attach: skip spawning and measure an already-running instance at
 * LOADPERF_BASE_URL (default http://127.0.0.1:<ELIZA_API_PORT>). Useful for a
 * warm-boot reading against a server someone else started.
 *   LOADPERF_BASE_URL=http://127.0.0.1:31337 node ... boot-kpi.mjs --attach
 *
 * Env:
 *   ELIZA_API_PORT      API port for the spawned/attached server (default 31337)
 *   LOADPERF_BASE_URL   base URL to probe (overrides host:port derivation)
 *   LOADPERF_BOOT_TIMEOUT_MS  ready timeout (default 120000)
 *
 * Fail-safe: if the agent cannot boot or never reports ready, records
 * { skipped: true, error } and exits 2 (so run-all can carry on).
 *
 * Exit: 0 pass, 1 budget fail, 2 skipped/unavailable.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  REPO_ROOT,
  waitForReady,
  recordResult,
  loadBudgets,
  sleep,
  ms,
  join,
} from "./lib.mjs";

const NOW = new Date().toISOString();
const ATTACH = process.argv.includes("--attach");
const JSON_ONLY = process.argv.includes("--json");

const API_PORT = Number(process.env.ELIZA_API_PORT ?? process.env.MILADY_API_PORT ?? 31337);
const BASE_URL = (process.env.LOADPERF_BASE_URL ?? `http://127.0.0.1:${API_PORT}`).replace(/\/$/, "");
const BOOT_TIMEOUT_MS = Number(process.env.LOADPERF_BOOT_TIMEOUT_MS ?? 120_000);

const DEV_SERVER = join("packages", "app-core", "src", "runtime", "dev-server.ts");

/** Read VmRSS (kB) for a pid from /proc; returns bytes or null. */
function readRssBytes(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

function checkBudgets(readyMs, peakRssBytes) {
  const b = loadBudgets().boot;
  const peakRssMb = peakRssBytes == null ? null : peakRssBytes / (1024 * 1024);
  const checks = [
    { name: "coldReadyMs", value: readyMs, budget: b.coldReadyMs, unit: "ms" },
  ];
  if (peakRssMb != null) {
    checks.push({ name: "peakRssMb", value: peakRssMb, budget: b.peakRssMb, unit: "MB" });
  }
  return checks.map((c) => ({ ...c, pass: c.value <= c.budget }));
}

async function measureAttached() {
  const { readyMs, health } = await waitForReady(BASE_URL, { timeoutMs: BOOT_TIMEOUT_MS });
  return { readyMs, peakRssBytes: null, health, mode: "attach" };
}

async function measureSpawned() {
  const startMs = Date.now();
  const child = spawn(
    process.execPath,
    ["--conditions=eliza-source", "--import", "tsx", DEV_SERVER],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ELIZA_HEADLESS: "1", ELIZA_API_PORT: String(API_PORT) },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );

  let stderrTail = "";
  child.stderr.on("data", (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });

  let peakRssBytes = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const rss = readRssBytes(child.pid);
      if (rss != null && rss > peakRssBytes) peakRssBytes = rss;
      await sleep(250);
    }
  })();

  const exited = new Promise((_, reject) => {
    child.once("exit", (code, signal) => {
      reject(new Error(`dev-server exited early (code=${code} signal=${signal})\n${stderrTail}`));
    });
    child.once("error", (err) => reject(err));
  });

  try {
    const ready = await Promise.race([
      waitForReady(BASE_URL, { timeoutMs: BOOT_TIMEOUT_MS, startMs }),
      exited,
    ]);
    // one last RSS sample at ready
    const rssAtReady = readRssBytes(child.pid);
    if (rssAtReady != null && rssAtReady > peakRssBytes) peakRssBytes = rssAtReady;
    return {
      readyMs: ready.readyMs,
      peakRssBytes: peakRssBytes || null,
      health: ready.health,
      mode: "spawn",
    };
  } finally {
    sampling = false;
    await sampler;
    child.kill("SIGTERM");
    // give it a moment, then SIGKILL if still alive
    await sleep(500);
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

async function main() {
  let measurement;
  try {
    measurement = ATTACH ? await measureAttached() : await measureSpawned();
  } catch (err) {
    const payload = { skipped: true, mode: ATTACH ? "attach" : "spawn", error: err?.message ?? String(err) };
    const { file } = recordResult("boot", payload, NOW);
    if (JSON_ONLY) console.log(JSON.stringify({ ...payload, file }, null, 2));
    else console.error(`[boot-kpi] skipped: ${payload.error}\nrecorded -> ${file}`);
    process.exit(2);
  }

  const { readyMs, peakRssBytes, health, mode } = measurement;
  const checks = checkBudgets(readyMs, peakRssBytes);
  const result = {
    summary: {
      mode,
      baseUrl: BASE_URL,
      readyMs,
      peakRssBytes,
      peakRssMb: peakRssBytes == null ? null : Number((peakRssBytes / (1024 * 1024)).toFixed(1)),
      healthReady: health?.ready ?? null,
    },
    checks,
    pass: checks.every((c) => c.pass),
  };

  const { file } = recordResult("boot", result, NOW);

  if (JSON_ONLY) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("\n=== Boot KPI ===");
    console.log(`mode:        ${mode}`);
    console.log(`base url:    ${BASE_URL}`);
    console.log(`ready:       ${ms(readyMs)}`);
    console.log(`peak RSS:    ${result.summary.peakRssMb == null ? "—" : `${result.summary.peakRssMb} MB`}`);
    console.log("\n-- budget checks --");
    for (const c of checks) {
      const v = c.unit === "MB" ? `${c.value.toFixed(1)} MB` : ms(c.value);
      const bud = c.unit === "MB" ? `${c.budget} MB` : ms(c.budget);
      console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}: ${v} / budget ${bud}`);
    }
    console.log(`\nresult: ${result.pass ? "PASS" : "FAIL"}   recorded -> ${file}\n`);
  }

  process.exit(result.pass ? 0 : 1);
}

main();
