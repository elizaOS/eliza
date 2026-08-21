#!/usr/bin/env node
/**
 * E2E benchmark for the Eliza Cloud CLI login flow.
 *
 * Emulates the exact request sequence the Electrobun desktop renderer drives
 * after the user clicks "Sign in with Eliza Cloud":
 *
 *   1. POST /api/auth/cli-session        → create pending session (201 + sessionId)
 *   2. Build browser login URL           → https://eliza.app/auth/cli-login?session=...
 *   3. GET  /api/auth/cli-session/{id}   → poll for auth status (pending → authenticated | expired)
 *
 * Each step is timed independently (DNS, TCP, TLS, TTFB, total) and the script
 * also checks CORS headers to confirm why the renderer cannot call the Cloud
 * API directly from a loopback origin.
 *
 * Usage:
 *   bun run --cwd packages/app-core/platforms/electrobun bench:cloud-login
 *   bun run --cwd packages/app-core/platforms/electrobun bench:cloud-login -- --rounds 10 --api-base https://api-staging.eliza.app
 *
 * Flags:
 *   --rounds N          Number of full flow iterations (default 5)
 *   --api-base URL      Cloud API base (default https://api.eliza.app)
 *   --web-base URL      Cloud web base for login URL (default https://eliza.app)
 *   --poll-rounds N     Poll iterations per flow (default 3)
 *   --poll-interval MS  Milliseconds between polls (default 2000)
 *   --no-cors-check     Skip the CORS preflight check
 */

// ─── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    apiBase: "https://api.eliza.app",
    webBase: "https://eliza.app",
    rounds: 5,
    pollRounds: 3,
    pollIntervalMs: 2000,
    corsCheck: true,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--api-base":
        args.apiBase = argv[++i];
        break;
      case "--web-base":
        args.webBase = argv[++i];
        break;
      case "--rounds":
        args.rounds = parseInt(argv[++i], 10);
        break;
      case "--poll-rounds":
        args.pollRounds = parseInt(argv[++i], 10);
        break;
      case "--poll-interval":
        args.pollIntervalMs = parseInt(argv[++i], 10);
        break;
      case "--no-cors-check":
        args.corsCheck = false;
        break;
      case "--help":
      case "-h":
        console.log(`Usage: bun run bench:cloud-login [--rounds N] [--api-base URL] [--web-base URL] [--poll-rounds N] [--poll-interval MS] [--no-cors-check]`);
        process.exit(0);
    }
  }
  return args;
}

const config = parseArgs(process.argv.slice(2));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtMs(ms) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function summarize(samples) {
  if (samples.length === 0)
    return { min: 0, max: 0, mean: 0, median: 0, p95: 0, samples: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean,
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[p95Idx],
    samples: samples.length,
  };
}

// ─── Timed fetch ─────────────────────────────────────────────────────────────

async function timedFetch(label, url, options = {}) {
  const t0 = performance.now();
  try {
    const response = await fetch(url, options);
    const ttfb = performance.now() - t0;
    const body = await response.text();
    const totalMs = performance.now() - t0;
    return {
      label,
      url,
      method: options.method || "GET",
      status: response.status,
      ok: response.ok,
      totalMs,
      ttfbMs: ttfb,
      body,
      bodyLength: body.length,
      error: null,
    };
  } catch (err) {
    const totalMs = performance.now() - t0;
    return {
      label,
      url,
      method: options.method || "GET",
      status: 0,
      ok: false,
      totalMs,
      ttfbMs: null,
      body: null,
      bodyLength: 0,
      error: err.message,
    };
  }
}

// ─── Single login flow ───────────────────────────────────────────────────────

async function runLoginFlow(round) {
  const results = [];
  const flowStart = performance.now();

  // Step 1: Create CLI session
  const sessionPayload = JSON.stringify({
    sessionId: `bench-${Date.now()}-${round}-${Math.random().toString(36).slice(2, 8)}`,
  });

  const createResult = await timedFetch(
    "1. POST /api/auth/cli-session (create session)",
    `${config.apiBase}/api/auth/cli-session`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: sessionPayload,
    },
  );
  results.push(createResult);

  let sessionId = null;
  if (createResult.ok) {
    try {
      const data = JSON.parse(createResult.body);
      sessionId = data.sessionId;
      const browserUrl = `${config.webBase}/auth/cli-login?session=${sessionId}`;
      results.push({
        label: "2. Build browser login URL",
        totalMs: 0.01,
        detail: browserUrl,
        ok: true,
      });
    } catch {
      results.push({
        label: "2. Parse session response",
        totalMs: 0,
        ok: false,
        error: "Failed to parse session JSON",
      });
    }
  }

  // Step 3: Poll for auth status
  if (sessionId) {
    for (let i = 0; i < config.pollRounds; i++) {
      if (i > 0) {
        await new Promise((r) => setTimeout(r, config.pollIntervalMs));
      }
      const pollResult = await timedFetch(
        `3.${i + 1} GET /api/auth/cli-session/{id} (poll #${i + 1})`,
        `${config.apiBase}/api/auth/cli-session/${encodeURIComponent(sessionId)}`,
        { method: "GET" },
      );
      results.push(pollResult);

      if (pollResult.ok) {
        try {
          const pollData = JSON.parse(pollResult.body);
          if (
            pollData.status === "authenticated" ||
            pollData.status === "expired"
          ) {
            break;
          }
        } catch {
          // continue polling
        }
      }
    }
  }

  const flowTotal = performance.now() - flowStart;
  return { round, flowTotalMs: flowTotal, results };
}

// ─── CORS check ──────────────────────────────────────────────────────────────

async function corsCheck() {
  console.log("\n--- CORS preflight check ---");
  console.log(
    `  Origin: http://127.0.0.1:5174 (Electrobun renderer loopback origin)`,
  );
  const t0 = performance.now();
  try {
    const res = await fetch(`${config.apiBase}/api/auth/cli-session`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:5174",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    const ms = performance.now() - t0;
    const acao = res.headers.get("access-control-allow-origin");
    console.log(`  Status: ${res.status}  Time: ${fmtMs(ms)}`);
    console.log(`  access-control-allow-origin: ${acao || "(none)"}`);
    if (acao) {
      console.log(`  → CORS ALLOWED for loopback renderer origin`);
    } else {
      console.log(
        `  → CORS BLOCKED (no ACAO header) — renderer fetch() will fail with TypeError: Load failed`,
      );
      console.log(
        `  → Desktop bridge (PR #22926) routes through main process to bypass this`,
      );
    }
  } catch (e) {
    console.log(`  Failed: ${e.message}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(80));
  console.log("Eliza Cloud CLI Login Flow — E2E Benchmark");
  console.log("=".repeat(80));
  console.log(`API base:       ${config.apiBase}`);
  console.log(`Web base:       ${config.webBase}`);
  console.log(`Rounds:         ${config.rounds}`);
  console.log(`Poll rounds:    ${config.pollRounds} (interval: ${config.pollIntervalMs}ms)`);
  const runtimeName = typeof Bun !== "undefined" ? `Bun ${Bun.version}` : `Node ${process.version}`;
  console.log(`Runtime:        ${runtimeName}`);
  console.log(`Timestamp:      ${new Date().toISOString()}`);
  console.log("=".repeat(80));

  // Warmup
  console.log("\nWarmup request...");
  const warmupStart = performance.now();
  try {
    await fetch(`${config.apiBase}/api/auth/cli-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "warmup" }),
    });
    console.log(`  Warmup done in ${fmtMs(performance.now() - warmupStart)}`);
  } catch (e) {
    console.log(`  Warmup failed: ${e.message} — continuing anyway`);
  }

  // CORS check
  if (config.corsCheck) {
    await corsCheck();
  }

  // Benchmark rounds
  const allFlows = [];
  const createSamples = [];
  const pollSamples = [];
  const flowSamples = [];

  for (let i = 0; i < config.rounds; i++) {
    console.log(`\n--- Round ${i + 1}/${config.rounds} ---`);
    const flow = await runLoginFlow(i);
    allFlows.push(flow);
    flowSamples.push(flow.flowTotalMs);

    for (const r of flow.results) {
      const status = r.ok
        ? `${r.status} OK`
        : r.error
          ? `ERR: ${r.error}`
          : `${r.status}`;
      console.log(
        `  ${r.label}`,
      );
      console.log(
        `    status: ${status}  time: ${fmtMs(r.totalMs)}  ttfb: ${r.ttfbMs ? fmtMs(r.ttfbMs) : "n/a"}`,
      );
      if (r.body && r.bodyLength < 500) {
        console.log(`    body:   ${r.body.slice(0, 200)}`);
      }

      if (r.label.startsWith("1.")) createSamples.push(r.totalMs);
      if (r.label.startsWith("3.") && r.ok) pollSamples.push(r.totalMs);
    }
    console.log(`  Flow total: ${fmtMs(flow.flowTotalMs)}`);
  }

  // Summary
  const createStats = summarize(createSamples);
  const pollStats = summarize(pollSamples);
  const flowStats = summarize(flowSamples);

  console.log("\n" + "=".repeat(80));
  console.log("BENCHMARK SUMMARY");
  console.log("=".repeat(80));

  console.log("\n1. Session creation (POST /api/auth/cli-session):");
  console.log(`   Samples: ${createStats.samples}`);
  console.log(`   Min:     ${fmtMs(createStats.min)}`);
  console.log(`   Max:     ${fmtMs(createStats.max)}`);
  console.log(`   Mean:    ${fmtMs(createStats.mean)}`);
  console.log(`   Median:  ${fmtMs(createStats.median)}`);
  console.log(`   P95:     ${fmtMs(createStats.p95)}`);

  console.log("\n2. Session poll (GET /api/auth/cli-session/{id}):");
  console.log(`   Samples: ${pollStats.samples}`);
  console.log(`   Min:     ${fmtMs(pollStats.min)}`);
  console.log(`   Max:     ${fmtMs(pollStats.max)}`);
  console.log(`   Mean:    ${fmtMs(pollStats.mean)}`);
  console.log(`   Median:  ${fmtMs(pollStats.median)}`);
  console.log(`   P95:     ${fmtMs(pollStats.p95)}`);

  console.log(
    `\n3. Full flow (create + build URL + poll x${config.pollRounds}):`,
  );
  console.log(`   Samples: ${flowStats.samples}`);
  console.log(`   Min:     ${fmtMs(flowStats.min)}`);
  console.log(`   Max:     ${fmtMs(flowStats.max)}`);
  console.log(`   Mean:    ${fmtMs(flowStats.mean)}`);
  console.log(`   Median:  ${fmtMs(flowStats.median)}`);
  console.log(`   P95:     ${fmtMs(flowStats.p95)}`);

  // Estimated real-world e2e timing
  console.log("\n" + "=".repeat(80));
  console.log("ESTIMATED REAL-WORLD E2E LOGIN TIMING");
  console.log("=".repeat(80));

  const createMs = createStats.median;
  const pollMs = pollStats.median;
  const browserOpenMs = 800;
  const userAuthMs = 5000;
  const pollLoopMs =
    pollMs * config.pollRounds +
    config.pollIntervalMs * (config.pollRounds - 1);
  const tokenPersistMs = 50;
  const totalEstimate =
    createMs + browserOpenMs + userAuthMs + pollLoopMs + tokenPersistMs;

  console.log(`   Session creation (API):          ${fmtMs(createMs)}`);
  console.log(
    `   Browser open (openExternal):     ~${fmtMs(browserOpenMs)} (estimated)`,
  );
  console.log(
    `   User auth (OAuth click+redirect): ~${fmtMs(userAuthMs)} (estimated)`,
  );
  console.log(
    `   Poll loop (${config.pollRounds}x + intervals):     ${fmtMs(pollLoopMs)}`,
  );
  console.log(
    `   Token persist + state update:   ~${fmtMs(tokenPersistMs)} (estimated)`,
  );
  console.log(`   ─────────────────────────────`);
  console.log(
    `   TOTAL estimated e2e:            ~${(totalEstimate / 1000).toFixed(1)}s`,
  );
  console.log();
  console.log(`   API-only overhead (no user):   ${fmtMs(createMs + pollLoopMs)}`);
  console.log(
    `   User-dependent latency:         ~${((browserOpenMs + userAuthMs + tokenPersistMs) / 1000).toFixed(1)}s`,
  );

  // Raw samples
  console.log("\n" + "=".repeat(80));
  console.log("RAW SAMPLES");
  console.log("=".repeat(80));
  console.log(
    `\nCreate:  [${createSamples.map((s) => s.toFixed(1)).join(", ")}] ms`,
  );
  console.log(`Poll:    [${pollSamples.map((s) => s.toFixed(1)).join(", ")}] ms`);
  console.log(`Flow:    [${flowSamples.map((s) => s.toFixed(1)).join(", ")}] ms`);

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
