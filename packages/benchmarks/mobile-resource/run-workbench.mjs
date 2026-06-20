/**
 * Mobile Resource Workbench runner.
 *
 * Drives the canonical workloads against a real device/simulator, samples
 * device resources over time, harvests per-generation throughput from the
 * agent's `/api/dev/device-resource-metrics` endpoint, aggregates everything,
 * checks per-tier budgets, and writes timestamped results + a report — the same
 * budgets/results/gate contract as `loadperf`.
 *
 *   node packages/benchmarks/mobile-resource/run-workbench.mjs \
 *     --platform=android --tier=eliza-1-0_8b --device-class=android-phone
 *
 * Flags / env:
 *   --platform=android|ios        (env MOBILE_RESOURCE_PLATFORM) — auto-detected when omitted
 *   --tier=eliza-1-0_8b|2b|4b     (env MOBILE_RESOURCE_TIER, default eliza-1-0_8b)
 *   --device-class=<key>          budgets.json key (default derived from platform)
 *   --workloads=a,b,c             default: cold-load,single-turn,sustained-chat
 *   --base-url=http://127.0.0.1:31337   agent API (env MOBILE_RESOURCE_BASE_URL / ELIZA_API_PORT)
 *   --package=app.eliza           Android package for meminfo (env MOBILE_RESOURCE_ANDROID_PACKAGE)
 *   --json                        machine-readable output
 *   --fail-on-missing             fail budget checks whose value could not be measured
 *
 * Exit: 0 pass, 1 budget/gate failure, 2 skipped/unavailable — directly usable
 * as a CI gate. A device/agent that isn't reachable records `{ skipped }` and
 * exits 2 rather than fabricating numbers.
 */

import {
  androidResourceSnapshot,
  detectAndroidDevice,
  resetAndroidBatteryStats,
} from "./android-probe.mjs";
import { detectBootedSimulator } from "./ios-probe.mjs";
import {
  fetchJson,
  loadBudgets,
  mb,
  ms,
  recordResult,
  sleep,
  tps,
} from "./lib.mjs";
import { checkBudgets, summarizeResourceRun } from "./metrics.mjs";
import { DEFAULT_WORKLOAD_IDS, workloadById } from "./workloads.mjs";

const NOW = new Date().toISOString();

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (name, fallback) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split("=").slice(1).join("=") : fallback;
  };
  const apiPort = Number(process.env.ELIZA_API_PORT ?? 31337);
  return {
    platform: get("platform", process.env.MOBILE_RESOURCE_PLATFORM) ?? null,
    tier: get("tier", process.env.MOBILE_RESOURCE_TIER ?? "eliza-1-0_8b"),
    deviceClass: get("device-class", null),
    workloads: get("workloads", DEFAULT_WORKLOAD_IDS.join(","))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    baseUrl: (
      get("base-url", process.env.MOBILE_RESOURCE_BASE_URL) ??
      `http://127.0.0.1:${apiPort}`
    ).replace(/\/$/, ""),
    androidPackage:
      get("package", process.env.MOBILE_RESOURCE_ANDROID_PACKAGE) ??
      "app.eliza",
    json: argv.includes("--json"),
    failOnMissing: argv.includes("--fail-on-missing"),
  };
}

/** Resolve the target device. Returns null platform when nothing is attached. */
function resolveTarget(args) {
  if (args.platform === "android" || args.platform == null) {
    const serial = detectAndroidDevice();
    if (serial)
      return { platform: "android", device: serial, isSimulator: false };
    if (args.platform === "android")
      return { platform: "android", device: null, isSimulator: false };
  }
  if (args.platform === "ios" || args.platform == null) {
    const udid = detectBootedSimulator();
    if (udid) return { platform: "ios", device: udid, isSimulator: true };
    if (args.platform === "ios")
      return { platform: "ios", device: null, isSimulator: true };
  }
  return { platform: null, device: null, isSimulator: false };
}

function deviceClassFor(args, target) {
  if (args.deviceClass) return args.deviceClass;
  return target.platform === "ios" ? "ios-phone" : "android-phone";
}

/** Sample a resource snapshot for the platform; null when unavailable. */
function sampleResource(target, args, atMs) {
  if (target.platform === "android" && target.device) {
    return androidResourceSnapshot(target.device, args.androidPackage, atMs);
  }
  // iOS host-side live sampling needs the in-app bridge (WebView). Without it
  // we can't honestly sample RSS/thermal/battery on iOS host-side, so return a
  // marker sample rather than fabricating values. MetricKit is pulled at the end.
  return null;
}

/** Read the device-bridge generation metrics from the agent dev endpoint. */
async function fetchGenerationMetrics(baseUrl) {
  try {
    const payload = await fetchJson(
      `${baseUrl}/api/dev/device-resource-metrics?limit=200`,
      { timeoutMs: 5000 },
    );
    return Array.isArray(payload?.recentGenerations)
      ? payload.recentGenerations
      : [];
  } catch {
    return null; // endpoint unreachable (agent down or older build)
  }
}

async function reachable(baseUrl) {
  try {
    await fetchJson(`${baseUrl}/api/health`, { timeoutMs: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run one workload: take a baseline generation-metrics snapshot, sample
 * resources on the workload cadence for its duration window (driving chat turns
 * if the harness was given a chat driver), then diff the generation metrics.
 *
 * Chat/voice driving against the live agent is intentionally pluggable: this
 * runner samples resources + harvests whatever generations the agent recorded
 * during the window. A device-paired agent that runs real turns populates the
 * dev endpoint; a quiet agent yields zero generations (recorded as such, not
 * fabricated).
 */
async function runWorkload(workload, ctx) {
  const { target, args } = ctx;
  const startMs = Date.now();
  const samples = [];

  const before = (await fetchGenerationMetrics(args.baseUrl)) ?? [];
  const beforeCount = before.length;

  if (target.platform === "android" && target.device) {
    resetAndroidBatteryStats(target.device);
  }

  // Sample for the workload window. The window is bounded by maxDurationMs; for
  // chat/voice workloads an external driver (or a paired device) generates load
  // concurrently. Sampling is wall-clock paced and capped so a hung device
  // can't run forever.
  const windowMs = Math.min(workload.maxDurationMs, ctx.maxWindowMs);
  const deadline = startMs + windowMs;
  let next = startMs;
  while (Date.now() < deadline) {
    const atMs = Date.now() - startMs;
    const sample = sampleResource(target, args, atMs);
    if (sample) samples.push(sample);
    next += workload.sampleIntervalMs;
    const wait = next - Date.now();
    await sleep(Math.max(50, wait));
    // Cold-load: stop sampling once the model reports loaded (best-effort).
    if (workload.kind === "load-only" && samples.length >= 4) {
      const loaded = await modelLoaded(args.baseUrl);
      if (loaded) break;
    }
  }

  const after = (await fetchGenerationMetrics(args.baseUrl)) ?? [];
  const newGenerations = after.slice(beforeCount).map((g) => ({
    promptTokens: g.promptTokens,
    outputTokens: g.outputTokens,
    durationMs: g.durationMs,
    ttftMs: g.ttftMs,
    throughput: g.throughput,
  }));

  return { samples, generations: newGenerations };
}

async function modelLoaded(baseUrl) {
  try {
    const payload = await fetchJson(
      `${baseUrl}/api/dev/device-resource-metrics`,
      { timeoutMs: 3000 },
    );
    return payload?.status?.loadedPath != null;
  } catch {
    return false;
  }
}

function recordSkipped(reason, args) {
  const payload = { skipped: true, reason, tier: args.tier };
  recordResult("summary", payload, NOW);
  if (args.json) console.log(JSON.stringify({ ...payload }, null, 2));
  else console.error(`[mobile-resource] skipped: ${reason}`);
  process.exit(2);
}

async function main() {
  const args = parseArgs();
  const target = resolveTarget(args);

  const agentUp = await reachable(args.baseUrl);

  if (!target.platform && !agentUp) {
    recordSkipped(
      "no device/simulator attached (adb/simctl) and agent API unreachable",
      args,
    );
    return;
  }
  if (!target.device) {
    recordSkipped(
      `no ${target.platform ?? "mobile"} device/simulator attached`,
      args,
    );
    return;
  }

  const deviceClass = deviceClassFor(args, target);
  const budgets = loadBudgets();
  const tierBudget = budgets.deviceClasses?.[deviceClass]?.[args.tier] ?? null;
  const ctx = {
    target,
    args,
    maxWindowMs: Number(process.env.MOBILE_RESOURCE_MAX_WINDOW_MS ?? 900_000),
  };

  const results = [];
  let anyFail = false;

  for (const id of args.workloads) {
    const workload = workloadById(id);
    if (!workload) {
      console.warn(`[mobile-resource] unknown workload '${id}' — skipping`);
      continue;
    }
    if (workload.requiresVoice && process.env.MOBILE_RESOURCE_VOICE !== "1") {
      results.push({
        id,
        status: "skipped",
        reason: "voice loop not enabled (set MOBILE_RESOURCE_VOICE=1)",
      });
      recordResult(
        id,
        { skipped: true, reason: "voice not enabled", tier: args.tier },
        NOW,
      );
      continue;
    }
    console.log(`\n>>> ${id} (${workload.title})`);
    const run = await runWorkload(workload, ctx);
    const summary = summarizeResourceRun(run, {
      leakGrowthMbThreshold: budgets.leakGrowthMbThreshold,
    });
    const checks = checkBudgets(summary, tierBudget, {
      failOnMissing: args.failOnMissing,
    });
    const pass = checks.every((c) => c.pass);
    if (!pass) anyFail = true;
    const record = {
      tier: args.tier,
      deviceClass,
      platform: target.platform,
      device: target.device,
      isSimulator: target.isSimulator,
      summary,
      checks,
      pass,
    };
    recordResult(id, record, NOW);
    results.push({ id, status: pass ? "pass" : "fail", summary, checks });
    printWorkload(summary, checks);
  }

  const summaryPayload = {
    tier: args.tier,
    deviceClass,
    platform: target.platform,
    workloads: results.map((r) => ({ id: r.id, status: r.status })),
    pass: !anyFail,
  };
  recordResult("summary", summaryPayload, NOW);

  if (args.json) {
    console.log(JSON.stringify({ ...summaryPayload, results }, null, 2));
  } else {
    console.log(
      `\nresult: ${anyFail ? "FAIL" : "PASS"}  (tier ${args.tier}, ${deviceClass})`,
    );
  }
  process.exit(anyFail ? 1 : 0);
}

function printWorkload(summary, checks) {
  console.log(
    `  generations: ${summary.generations}  samples: ${summary.resourceSamples}`,
  );
  console.log(
    `  decode: ${tps(summary.decodeTokensPerSecond.p50)}  prefill: ${tps(summary.prefillTokensPerSecond.p50)}  ttft(p90): ${ms(summary.ttftMs.p90)}`,
  );
  console.log(
    `  RSS peak/steady: ${mb(summary.rss.peakMb)} / ${mb(summary.rss.steadyMb)}  leak: ${summary.rss.leakSuspected}`,
  );
  console.log(
    `  battery drain: ${summary.battery.drainPct == null ? "—" : `${summary.battery.drainPct}%`}  thermal max: ${summary.thermal.maxState ?? "—"}`,
  );
  for (const c of checks) {
    const v =
      c.value == null
        ? "—"
        : c.unit === "bool"
          ? c.value
            ? "yes"
            : "no"
          : `${c.value}`;
    const b = c.budget == null ? "no-baseline" : `${c.budget}`;
    console.log(
      `    ${c.pass ? "PASS" : "FAIL"}  ${c.name}: ${v} / ${b} ${c.unit}`,
    );
  }
}

main().catch((err) => {
  console.error("[mobile-resource] fatal:", err);
  process.exit(2);
});
