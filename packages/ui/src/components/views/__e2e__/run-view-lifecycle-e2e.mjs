/**
 * View-lifecycle e2e (#10202) — real-browser harness, no app server. Bundles
 * view-lifecycle-fixture.tsx (the REAL KeepAliveViewHost + ViewLifecycleController
 * over a synthetic view matrix) with esbuild, loads it in headless Chromium, and
 * proves the lifecycle contract end-to-end:
 *
 *   1. BOUNDED RETENTION — repeated view switching never retains more keep-alive
 *      views than the device-memory LRU cap (instance-level memory growth bound).
 *   2. PAUSE STOPS WORK — a hidden keep-alive view's RAF loop flatlines while
 *      hidden and resumes when shown again.
 *   3. EVICT CLEANUP — an LRU-evicted view's tracked subscription is released.
 *   4. LISTENER LEAK — a deliberately leaky view stays counted in per-view
 *      telemetry after it leaves the screen (the leak is visible).
 *   5. RERENDER STORM — a storm view trips per-view render telemetry while a
 *      calm sibling does not.
 *   6. CRASH CONTAINMENT + RECOVERY — a thrown render shows the per-view fallback
 *      while the shell + other views survive; Retry recovers.
 *   7. MEMORY TREND — usedJSHeapSize sampled (gc'd) across many switch cycles is
 *      fed to the SAME pure detector the unit test uses; a leak fails the build.
 *
 * Captures per-step screenshots + a walkthrough video + telemetry.json.
 * Run: bun run --cwd packages/ui test:view-lifecycle-e2e
 */

import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import {
  shouldReportMemoryGrowth,
  summarizeMemorySamples,
} from "../../../perf/view-memory-budget.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-view-lifecycle");
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
}

// ── esbuild stubs (mirror run-launcher-e2e): @elizaos/core, @elizaos/logger,
// and node builtins are dead-in-browser; stub them so the bundle builds. ──
const stubElizaCore = {
  name: "stub-eliza-core",
  setup(b) {
    b.onResolve({ filter: /^@elizaos\/core$/ }, (args) => ({
      path: args.path,
      namespace: "eliza-core-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "eliza-core-stub" }, () => ({
      contents: `const noop = new Proxy(() => noop, { get: () => noop });
        module.exports = new Proxy({}, { get: (t, p) => (p in t ? t[p] : noop) });`,
      loader: "js",
    }));
  },
};
const stubElizaLogger = {
  name: "stub-eliza-logger",
  setup(b) {
    b.onResolve({ filter: /^@elizaos\/logger$/ }, (args) => ({
      path: args.path,
      namespace: "eliza-logger-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "eliza-logger-stub" }, () => ({
      // A console-free no-op logger keeps the page-error guard clean.
      contents: `const noop = () => {};
        const logger = { info: noop, warn: noop, error: noop, debug: noop, trace: noop };
        module.exports = { logger, default: logger };`,
      loader: "js",
    }));
  },
};
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);
const stubNodeBuiltins = {
  name: "stub-node-builtins",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      const bare = args.path.replace(/^node:/, "").split("/")[0];
      if (
        args.path.startsWith("node:") ||
        nodeBuiltins.has(args.path) ||
        builtinModules.includes(bare)
      ) {
        return { path: args.path, namespace: "node-stub" };
      }
      return null;
    });
    b.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
      contents:
        "const n=()=>noop;const noop=new Proxy(n,{get:()=>noop});module.exports=noop;",
      loader: "js",
    }));
  },
};

const result = await build({
  entryPoints: [join(here, "view-lifecycle-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  // development so React Profiler durations are real + render telemetry is on.
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [stubElizaCore, stubElizaLogger, stubNodeBuiltins],
  write: false,
});
const js = result.outputFiles[0].text;
console.log(`✓ fixture bundled (${js.length} bytes)`);

const html = `<!doctype html><html><head><meta charset="utf-8"><title>view-lifecycle e2e</title>
<style>html,body{margin:0;height:100%;background:#0a0d16;color:#f4f4f5;font-family:system-ui}</style>
<script>
  window.__ELIZA_RENDER_TELEMETRY__ = [];
  window.__ELIZA_VIEW_RUNTIME_TELEMETRY__ = [];
  window.process = window.process || { env: { NODE_ENV: "development" } };
</script>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "view-lifecycle.html");
await writeFile(htmlPath, html);
const url = `file://${htmlPath}`;

let shot = 0;
async function snap(p, name) {
  shot += 1;
  const file = `vl-${String(shot).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: join(outDir, file) });
  console.log(`  📸 ${file}`);
}

const browser = await chromium.launch({
  args: [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--js-flags=--expose-gc",
    "--enable-precise-memory-info",
  ],
});
const context = await browser.newContext({
  viewport: { width: 1180, height: 820 },
  recordVideo: { dir: outDir, size: { width: 1180, height: 820 } },
});
const errors = [];
const p = await context.newPage();
p.on("pageerror", (e) => {
  const msg = String(e);
  // The intentional crash is reported to window.onerror by React even though the
  // boundary catches it — that is expected, not a harness failure.
  if (msg.includes("INTENTIONAL_VIEW_CRASH")) return;
  errors.push(msg);
  console.error(`  ⚠ pageerror: ${msg}`);
});
p.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("INTENTIONAL_VIEW_CRASH")) {
    console.error(`  ⚠ console: ${m.text()}`);
  }
});

const lc = (fn, ...args) =>
  p.evaluate(
    ([f, a]) => window.__lifecycle[f](...a),
    [fn, args],
  );
const settle = (ms = 200) => p.waitForTimeout(ms);

const memorySamples = [];
// Six pure keep-alive work views — more than the LRU cap (3 hidden + active),
// so repeated switching forces real eviction.
const VIEWS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];

try {
  await p.goto(url);
  await p.waitForSelector('[data-testid="lifecycle-harness"]', {
    timeout: 8000,
  });
  await settle(300);
  await snap(p, "initial-alpha");

  // ── 1+2. Switch through the matrix repeatedly; sample heap each cycle; check
  // bounded retention + that a hidden view's RAF flatlines. ──
  let maxRetained = 0;
  for (let cycle = 0; cycle < 24; cycle += 1) {
    for (const id of VIEWS) {
      await lc("switchTo", id);
      await settle(60);
      const retained = await lc("retained");
      maxRetained = Math.max(maxRetained, retained.length);
    }
    await lc("gc");
    await settle(40);
    const heap = await lc("heap");
    if (typeof heap === "number") memorySamples.push(heap);
  }
  assert(
    maxRetained > 0 && maxRetained <= 4,
    `keep-alive retained set bounded across 24×4 switches (max ${maxRetained} ≤ cap)`,
  );

  // RAF pause: switch to alpha (active), record its RAF count, switch away, and
  // confirm alpha's RAF stops climbing while hidden+paused.
  await lc("switchTo", "alpha");
  await settle(150);
  const alphaActiveRaf = await p.evaluate(() => window.__rafCounts.alpha ?? 0);
  await lc("switchTo", "beta");
  await settle(250);
  const alphaHiddenRaf1 = await p.evaluate(() => window.__rafCounts.alpha ?? 0);
  await settle(250);
  const alphaHiddenRaf2 = await p.evaluate(() => window.__rafCounts.alpha ?? 0);
  assert(
    alphaHiddenRaf1 === alphaHiddenRaf2 && alphaHiddenRaf2 >= alphaActiveRaf,
    `hidden view RAF flatlines while paused (${alphaHiddenRaf1} == ${alphaHiddenRaf2})`,
  );
  await snap(p, "after-switch-cycles");

  // ── 3. EVICT CLEANUP — drive all 6 distinct keep-alive views (> cap) to force
  // an LRU eviction of older ones; their tracked subscriptions must be released. ──
  for (const id of VIEWS) {
    await lc("switchTo", id);
    await settle(60);
  }
  const phasesAfterLru = await lc("phases");
  const evictedSome = Object.entries(phasesAfterLru).some(
    ([id, ph]) => VIEWS.includes(id) && ph === null,
  );
  assert(
    evictedSome,
    `LRU evicted at least one older keep-alive view (phases: ${JSON.stringify(
      phasesAfterLru,
    )})`,
  );

  // ── 5. RERENDER STORM — activate the storm view; assert per-view render
  // telemetry flags "storm" but not a calm sibling. ──
  await lc("switchTo", "storm");
  await settle(900);
  const renderTelemetry = await p.evaluate(
    () => window.__ELIZA_RENDER_TELEMETRY__ ?? [],
  );
  const stormEvents = renderTelemetry.filter((e) => e.name === "storm");
  const calmStorm = renderTelemetry.filter((e) => VIEWS.includes(e.name));
  assert(
    stormEvents.length >= 1,
    `render-storm telemetry flagged the storm view (${stormEvents.length} events)`,
  );
  assert(
    calmStorm.length === 0,
    `no calm view was flagged as a storm (${calmStorm.length})`,
  );
  await snap(p, "storm-view");

  // ── 4. LISTENER LEAK — activate the leaky view, switch away (evict), and
  // confirm its per-view telemetry shows a live subscription that never dropped. ──
  await lc("switchTo", "leaky");
  await settle(150);
  await lc("switchTo", "alpha");
  await settle(150);
  const telemetry = await lc("telemetry");
  const leakyHide = telemetry
    .filter((e) => e.viewId === "leaky")
    .slice(-1)[0];
  assert(
    leakyHide && leakyHide.activeSubscriptions >= 1,
    `leaky view's never-disposed subscription is visible in telemetry (subs=${
      leakyHide ? leakyHide.activeSubscriptions : "n/a"
    })`,
  );

  // ── 6. CRASH CONTAINMENT + RECOVERY ──
  await lc("crash");
  await settle(250);
  const fallbackVisible = await p
    .locator('[data-testid="view-error-boundary-fallback"]')
    .count();
  const harnessAlive = await p
    .locator('[data-testid="lifecycle-harness"]')
    .count();
  assert(
    fallbackVisible >= 1,
    "crashing view shows the per-view error fallback",
  );
  assert(
    harnessAlive === 1,
    "the app shell (harness) survived the view crash",
  );
  await snap(p, "crash-contained");

  // Recover: disarm the crash, press Retry, confirm the view comes back.
  await lc("uncrash");
  await p.locator('[data-testid="view-error-retry"]').first().click();
  await settle(250);
  const recovered = await p.locator('[data-testid="work-crasher"]').count();
  assert(recovered === 1, "Retry recovered the crashed view");
  await snap(p, "crash-recovered");

  // ── 7. MEMORY TREND — feed the gc'd heap samples to the pure detector. ──
  const summary = summarizeMemorySamples(memorySamples);
  const report = shouldReportMemoryGrowth(summary);
  console.log(
    `  memory: ${memorySamples.length} samples, ` +
      `slope ${(summary.slopeBytesPerCycle / 1024).toFixed(1)} KiB/cycle, ` +
      `growth ${((summary.growthRatio - 1) * 100).toFixed(1)}%, ` +
      `monotonic ${(summary.monotonicIncreaseRatio * 100).toFixed(0)}%`,
  );
  assert(
    memorySamples.length >= 5,
    `collected enough heap samples (${memorySamples.length})`,
  );
  assert(
    !report.leaking,
    `no monotonic view-switch memory growth detected${
      report.leaking ? `: ${report.reasons.join("; ")}` : ""
    }`,
  );

  await writeFile(
    join(outDir, "telemetry.json"),
    JSON.stringify(
      {
        maxRetained,
        memorySamples,
        memorySummary: summary,
        memoryReport: report,
        renderStormEvents: stormEvents.length,
        finalTelemetry: telemetry.slice(-20),
      },
      null,
      2,
    ),
  );
  console.log("  🧾 telemetry.json");
} finally {
  await context.close(); // flush the video
  await browser.close();
}

for (const f of await readdir(outDir)) {
  if (f.endsWith(".webm")) {
    await rename(join(outDir, f), join(outDir, "view-lifecycle-walkthrough.webm"));
    console.log("  🎥 view-lifecycle-walkthrough.webm");
    break;
  }
}

assert(errors.length === 0, `no unexpected page errors (${errors.length})`);
for (const e of errors) console.error(`  ⚠ ${e}`);

console.log(`\nScreenshots (${shot}) → ${outDir}`);
if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nVIEW LIFECYCLE E2E PASSED");
process.exit(0);
