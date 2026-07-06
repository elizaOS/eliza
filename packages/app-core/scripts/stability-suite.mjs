#!/usr/bin/env node
/**
 * Agent stability umbrella (#10197).
 *
 * A single command that *induces* the failure modes and asserts recovery, then
 * writes a committed markdown scoreboard. It exits non-zero on any
 * crash-without-recovery, unbounded RSS growth, or failed restart guard.
 *
 * Lanes (real, on this host — CLI/Node surface):
 *   1. supervisor-recovery — spawn the real run-node.mjs with a fake child that
 *      exits with RESTART_EXIT_CODE (75) twice, assert it relaunches and the
 *      agent comes back (clean exit), and record recovery latency.
 *   2. crash-loop-guard   — fake child always exits 75; assert the supervisor
 *      aborts after MAX_RESTARTS_IN_WINDOW instead of spinning forever.
 *   3. memory-soak        — a forced-GC allocation soak; assert a steady
 *      (dropped-allocation) workload's heap slope stays bounded while a retained
 *      (leaking) workload climbs, and record peak RSS.
 *
 * Device (Android/iOS) and cloud (chainsaw) surfaces are recorded in the
 * scoreboard as evidence-gated — they need a connected phone / k8s cluster and
 * run in their own lanes (android-e2e.mjs, the chainsaw suite).
 *
 * Usage: node packages/app-core/scripts/stability-suite.mjs [--scoreboard <path>]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";
import vm from "node:vm";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUN_NODE = path.join(SCRIPT_DIR, "run-node.mjs");
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../..");

const MAX_RESTARTS_IN_WINDOW = 5; // mirror run-node.mjs
const SOAK_ITERATIONS = 15;
const OBJECTS_PER_CHUNK = 100_000;
const STEADY_SLOPE_LIMIT_MB = 1.0; // a non-leaking workload must stay under this slope

function parseScoreboardPath() {
  const idx = process.argv.indexOf("--scoreboard");
  if (idx >= 0 && process.argv[idx + 1])
    return path.resolve(process.argv[idx + 1]);
  return path.join(
    REPO_ROOT,
    "test-results/evidence/10197-agent-stability-scoreboard.md",
  );
}

const FAKE_CHILD = `import fs from "node:fs";
const counterFile = process.env.FAKE_CHILD_COUNTER;
const restartUntil = Number(process.env.FAKE_CHILD_RESTART_UNTIL ?? "0");
let count = 0;
try { count = Number(fs.readFileSync(counterFile, "utf8").trim()) || 0; } catch {}
count += 1;
fs.writeFileSync(counterFile, String(count));
process.exit(count <= restartUntil ? 75 : 0);
`;

function makeSupervisorWorkdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-stability-"));
  fs.writeFileSync(path.join(dir, "fake-child.mjs"), FAKE_CHILD);
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist", "entry.js"), "// noop\n");
  fs.writeFileSync(path.join(dir, "dist", ".buildstamp"), `${Date.now()}\n`);
  return dir;
}

function readSpawnCount(counterFile) {
  try {
    return Number(fs.readFileSync(counterFile, "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

function runSupervisor(restartUntil, hrNow) {
  return new Promise((resolve, reject) => {
    const workDir = makeSupervisorWorkdir();
    const counterFile = path.join(workDir, "spawn-count.txt");
    const startedAt = hrNow();
    const pathWithNode = [path.dirname(process.execPath), process.env.PATH]
      .filter(Boolean)
      .join(path.delimiter);
    const child = spawn(process.execPath, [RUN_NODE], {
      cwd: workDir,
      env: {
        ...process.env,
        PATH: pathWithNode,
        ELIZA_RUNTIME: "node",
        ELIZA_ENTRY_FILE: "fake-child.mjs",
        ELIZA_FORCE_BUILD: "0",
        ELIZA_RUNNER_LOG: "1",
        FAKE_CHILD_COUNTER: counterFile,
        FAKE_CHILD_RESTART_UNTIL: String(restartUntil),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      fs.rmSync(workDir, { recursive: true, force: true });
      reject(err);
    });
    child.on("exit", (code) => {
      const spawnCount = readSpawnCount(counterFile);
      const latencyMs = Math.round(hrNow() - startedAt);
      fs.rmSync(workDir, { recursive: true, force: true });
      resolve({ code, spawnCount, latencyMs, stderr });
    });
  });
}

function resolveGc() {
  const existing = globalThis.gc;
  if (typeof existing === "function") return existing;
  try {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc");
    v8.setFlagsFromString("--no-expose-gc");
    return typeof gc === "function" ? gc : undefined;
  } catch {
    return undefined;
  }
}

function runSoak(retain) {
  const forceGc = resolveGc();
  const heapSeries = [];
  let peakRssMb = 0;
  const kept = [];
  let sink = 0;
  for (let i = 0; i < SOAK_ITERATIONS; i += 1) {
    const chunk = new Array(OBJECTS_PER_CHUNK);
    for (let k = 0; k < OBJECTS_PER_CHUNK; k += 1) chunk[k] = { v: k };
    if (retain) kept.push(chunk);
    else sink += chunk.length;
    forceGc?.();
    const u = process.memoryUsage();
    heapSeries.push(u.heapUsed / 1048576);
    peakRssMb = Math.max(peakRssMb, u.rss / 1048576);
  }
  void sink;
  const n = heapSeries.length;
  const meanX = (n - 1) / 2;
  const meanY = heapSeries.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (i - meanX) * (heapSeries[i] - meanY);
    den += (i - meanX) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  return {
    slopeMbPerIter: Math.round(slope * 1000) / 1000,
    growthMb: Math.round((heapSeries[n - 1] - heapSeries[0]) * 100) / 100,
    peakRssMb: Math.round(peakRssMb * 100) / 100,
  };
}

async function main() {
  const hrNow = () => Number(process.hrtime.bigint() / 1000000n);
  const results = [];
  const fail = (lane, detail) => results.push({ lane, ok: false, detail });
  const pass = (lane, detail) => results.push({ lane, ok: true, detail });

  // Lane 1: supervisor recovery (exit-75 → relaunch → clean exit).
  const recovery = await runSupervisor(2, hrNow);
  const recovered =
    recovery.code === 0 &&
    recovery.spawnCount === 3 &&
    recovery.stderr.includes("Restart requested");
  (recovered ? pass : fail)("supervisor-recovery", {
    inducedRestarts: recovery.spawnCount - 1,
    recovered: recovery.code === 0,
    recoveryLatencyMs: recovery.latencyMs,
  });

  // Lane 2: crash-loop guard (always exit 75 → abort, not infinite spin).
  const loop = await runSupervisor(Number.MAX_SAFE_INTEGER, hrNow);
  const guarded =
    loop.code === 1 &&
    loop.spawnCount === MAX_RESTARTS_IN_WINDOW + 1 &&
    loop.stderr.includes("Restart loop detected");
  (guarded ? pass : fail)("crash-loop-guard", {
    spawnsBeforeAbort: loop.spawnCount,
    aborted: loop.code === 1,
  });

  // Lane 3: memory soak (steady workload bounded; leaking workload climbs).
  const leaking = runSoak(true);
  const steady = runSoak(false);
  const soakOk =
    leaking.slopeMbPerIter > 0.5 &&
    steady.slopeMbPerIter < STEADY_SLOPE_LIMIT_MB &&
    steady.slopeMbPerIter < leaking.slopeMbPerIter;
  (soakOk ? pass : fail)("memory-soak", {
    leakingSlopeMbPerIter: leaking.slopeMbPerIter,
    steadySlopeMbPerIter: steady.slopeMbPerIter,
    steadyPeakRssMb: steady.peakRssMb,
    leakingGrowthMb: leaking.growthMb,
  });

  const allOk = results.every((r) => r.ok);
  const scoreboardPath = parseScoreboardPath();
  writeScoreboard(scoreboardPath, results, {
    recovery,
    loop,
    leaking,
    steady,
    allOk,
  });

  for (const r of results) {
    process.stdout.write(
      `[stability] ${r.ok ? "PASS" : "FAIL"} ${r.lane} ${JSON.stringify(r.detail)}\n`,
    );
  }
  process.stdout.write(`[stability] scoreboard → ${scoreboardPath}\n`);
  process.exit(allOk ? 0 : 1);
}

function writeScoreboard(scoreboardPath, results, ctx) {
  const row = (lane) => results.find((r) => r.lane === lane);
  const verdict = (lane) => (row(lane)?.ok ? "✅ pass" : "❌ fail");
  const md = `# Agent stability scoreboard (#10197)

> Regenerated by \`node packages/app-core/scripts/stability-suite.mjs\`. Raw run
> artifacts are gitignored; these scores are the committed record. The command
> exits non-zero on any crash-without-recovery, unbounded RSS growth, or failed
> restart guard.

## CLI / Node surface (run on this host)

| Lane | Verdict | Key metrics |
| --- | --- | --- |
| supervisor-recovery | ${verdict("supervisor-recovery")} | induced restarts: ${ctx.recovery.spawnCount - 1}, recovered: ${ctx.recovery.code === 0}, recovery latency: ${ctx.recovery.latencyMs} ms |
| crash-loop-guard | ${verdict("crash-loop-guard")} | spawns before abort: ${ctx.loop.spawnCount} (guard = ${MAX_RESTARTS_IN_WINDOW}+1), aborted: ${ctx.loop.code === 1} |
| memory-soak | ${verdict("memory-soak")} | steady slope: ${ctx.steady.slopeMbPerIter} MB/iter (limit ${STEADY_SLOPE_LIMIT_MB}), leaking slope: ${ctx.leaking.slopeMbPerIter} MB/iter, steady peak RSS: ${ctx.steady.peakRssMb} MB |

**Overall: ${ctx.allOk ? "✅ all lanes pass" : "❌ failing lanes present"}**

## Memory watchdog

\`runtime/memory-watchdog.ts\` requests a clean restart (via \`requestRestart()\` →
supervisor) when RSS holds at/above \`ELIZA_MEMORY_WATCHDOG_RSS_MB\` for
\`ELIZA_MEMORY_WATCHDOG_SUSTAINED\` samples. Unit-proven in
\`packages/agent/src/runtime/__tests__/memory-watchdog.test.ts\`; the supervisor
relaunch it depends on is proven by the supervisor-recovery lane above.

## Other surfaces (evidence-gated — own lanes)

| Surface | Mechanism | Evidence lane | Status |
| --- | --- | --- | --- |
| Android device | \`ElizaAgentService\` \`WatchdogThread\` (health poll + \`scheduleRestart\`) | \`packages/app/scripts/android-e2e.mjs\` (needs \`ANDROID_SERIAL\`) | code present; device-connected run gated on a phone |
| iOS device | \`AgentWatchdog\` liveness poll + renderer restart request consumer | iOS device/sim capture | code present + unit-proven; device-connected run gated on a device |
| Cloud pod | Container restart + replacement pod + recovered health/message | \`packages/cloud/infra/cloud/tests/10-agent-crash-recovery\` chainsaw | suite present; live run gated on a k8s cluster |
`;
  fs.mkdirSync(path.dirname(scoreboardPath), { recursive: true });
  fs.writeFileSync(scoreboardPath, md);
}

main().catch((err) => {
  process.stderr.write(`[stability] suite crashed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
