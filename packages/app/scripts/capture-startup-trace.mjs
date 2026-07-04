#!/usr/bin/env node
/**
 * Device boot / startup trace capture harness (issue #9565).
 *
 * Loads the renderer in headless Chromium, waits for the cold-start checkpoints
 * emitted by `@elizaos/ui/state/startup-telemetry` (mirrored onto
 * `window.__ELIZA_STARTUP_TRACE__`), and prints + saves the per-phase timeline.
 * This is the desktop/web path of the boot-trace matrix; the SAME renderer
 * trace is produced inside the Electrobun WebView and the Capacitor WebView, so
 * pointing `--url` at the Electrobun dev renderer or a device-tunnelled WebView
 * captures those paths too.
 *
 * Usage:
 *   node scripts/capture-startup-trace.mjs [--url <renderer-url>] [--runs N]
 *        [--out <file.json>] [--wait-ready] [--timeout <ms>] [--headed]
 *
 *   --url         renderer URL (default http://localhost:$ELIZA_UI_PORT|2138)
 *   --runs        cold + (N-1) warm reloads (default 1)
 *   --wait-ready  also wait for `coordinator:ready` (needs a reachable backend);
 *                 default waits for `startup-shell:first-paint` OR
 *                 `startup-shell:mounted` (renderer-only) — first-paint is
 *                 delay-gated (STARTUP_SPLASH_DELAY_MS) and never fires on a
 *                 boot faster than the gate, so the unconditional mount mark
 *                 keeps the harness reachable
 *   --out         write JSON artifact (default: print only)
 *   --timeout     per-run wait budget in ms (default 60000)
 *   --headed      run a visible browser (debugging)
 *
 * The trace is provider-independent: the first-paint checkpoint does not need a
 * model key or a running agent, so it is safe to run in CI behind a dev server.
 */

import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

function parseArgs(argv) {
  const args = {
    url:
      process.env.ELIZA_STARTUP_TRACE_URL ||
      `http://localhost:${process.env.ELIZA_UI_PORT || "2138"}`,
    runs: 1,
    waitReady: false,
    out: null,
    timeout: 60_000,
    headed: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i];
    else if (a === "--runs") args.runs = Number(argv[++i]);
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--timeout") args.timeout = Number(argv[++i]);
    else if (a === "--wait-ready") args.waitReady = true;
    else if (a === "--headed") args.headed = true;
  }
  return args;
}

const READY_MARK = "coordinator:ready";
const FIRST_PAINT_MARK = "startup-shell:first-paint";
const MOUNTED_MARK = "startup-shell:mounted";

/** Read window.__ELIZA_STARTUP_TRACE__ inside the page. */
function readTrace() {
  const trace = window.__ELIZA_STARTUP_TRACE__;
  if (!trace) return null;
  const perfMarks =
    typeof performance !== "undefined"
      ? performance
          .getEntriesByType("mark")
          .filter((e) => e.name.startsWith("eliza.startup:"))
          .map((e) => ({ name: e.name, startTime: e.startTime }))
      : [];
  return { trace, perfMarks };
}

function deltas(marks) {
  const rows = [];
  let prev = marks[0]?.at ?? 0;
  const t0 = marks[0]?.at ?? 0;
  for (const m of marks) {
    rows.push({
      name: m.name,
      atMs: Math.round(m.at - t0),
      deltaMs: Math.round(m.at - prev),
      detail: m.detail,
    });
    prev = m.at;
  }
  return rows;
}

async function captureRun(page, { url, waitGoals, timeout }, runIndex) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });

  await page
    .waitForFunction(
      (goals) => {
        const trace = window.__ELIZA_STARTUP_TRACE__;
        return Boolean(trace?.marks?.some((m) => goals.includes(m.name)));
      },
      waitGoals,
      { timeout },
    )
    .catch(() => {
      // Capture whatever exists even if the goal mark never arrived (e.g. no
      // backend for coordinator:ready) — partial traces are still useful.
    });

  const captured = await page.evaluate(readTrace);
  if (!captured?.trace) {
    return { run: runIndex, error: "no __ELIZA_STARTUP_TRACE__ on window" };
  }
  return {
    run: runIndex,
    traceId: captured.trace.traceId,
    timeOrigin: captured.trace.timeOrigin,
    timeline: deltas(captured.trace.marks),
    perfMarkCount: captured.perfMarks.length,
  };
}

function printRun(run) {
  if (run.error) {
    console.log(`\n[run ${run.run}] ERROR: ${run.error}`);
    return;
  }
  console.log(`\n[run ${run.run}] traceId=${run.traceId}`);
  console.log(
    "  checkpoint".padEnd(36),
    "at(ms)".padStart(8),
    "Δ(ms)".padStart(8),
  );
  for (const row of run.timeline) {
    console.log(
      `  ${row.name}`.padEnd(36),
      String(row.atMs).padStart(8),
      String(row.deltaMs).padStart(8),
    );
  }
}

async function main() {
  const args = parseArgs(process.argv);
  // Renderer-only default: first-paint is gated behind STARTUP_SPLASH_DELAY_MS
  // and never fires on boots faster than the gate, so the unconditional
  // startup-shell:mounted mark also satisfies the wait. --wait-ready still
  // requires coordinator:ready alone.
  const waitGoals = args.waitReady
    ? [READY_MARK]
    : [FIRST_PAINT_MARK, MOUNTED_MARK];
  console.log(
    `Capturing startup trace: url=${args.url} runs=${args.runs} waitFor=${waitGoals.join("|")}`,
  );

  const browser = await chromium.launch({ headless: !args.headed });
  const results = [];
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    for (let i = 0; i < args.runs; i += 1) {
      // First run is cold (fresh context state already); subsequent reloads are
      // warm (module/asset caches primed).
      const run = await captureRun(
        page,
        { url: args.url, waitGoals, timeout: args.timeout },
        i,
      );
      run.kind = i === 0 ? "cold" : "warm";
      results.push(run);
      printRun(run);
    }
    await context.close();
  } finally {
    await browser.close();
  }

  if (args.out) {
    const artifact = {
      url: args.url,
      waitGoal: waitGoals.join("|"),
      capturedAtIso: new Date().toISOString(),
      runs: results,
    };
    writeFileSync(args.out, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(`\nWrote ${args.out}`);
  }

  const anyOk = results.some((r) => !r.error);
  process.exit(anyOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
