#!/usr/bin/env node
/**
 * audit:views — real-app view-lifecycle soak (#10196 item 1).
 *
 * The landed `test:view-lifecycle-e2e` is a synthetic-fixture, no-app-server
 * harness, which #10196's "no mocks standing in for the thing under test" DoD
 * disqualifies. This is the real one: it drives the **actual running app**
 * (renderer + API/agent), enumerates **every registered view** via `/api/views`,
 * cycles each one through the **real `ViewRouter`** many times, and drains the
 * real `__ELIZA_RENDER_TELEMETRY__` + `__ELIZA_MODULE_CACHE_TELEMETRY__` rings and
 * `usedJSHeapSize`. It fails (non-zero) on a render-storm, an unbounded module
 * cache, or unbounded heap growth across the churn.
 *
 * Assumes the stack is already up (boot it with the dev server). Env:
 *   UI=http://127.0.0.1:2138  API=http://127.0.0.1:31337  ROUNDS=6  OUT=<dir>
 *
 * Run under Node on Windows (Playwright's CDP pipe is dead under Bun there).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const UI = process.env.UI || "http://127.0.0.1:2138";
const API = process.env.API || "http://127.0.0.1:31337";
const ROUNDS = Number(process.env.ROUNDS || 6);
const OUT =
  process.env.OUT ||
  join(process.cwd(), ".github", "issue-evidence", "10196-views-state");
mkdirSync(OUT, { recursive: true });

let fails = 0;
const checks = [];
function assert(cond, msg) {
  checks.push({ ok: !!cond, msg });
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) fails += 1;
}

// 1) Enumerate the real registered views.
const viewsRes = await fetch(`${API}/api/views`).then((r) => r.json());
const views = (viewsRes.views || []).filter((v) => v.path);
assert(
  views.length >= 10,
  `enumerated ${views.length} registered views via /api/views`,
);
const byKind = {};
for (const v of views) byKind[v.viewKind] = (byKind[v.viewKind] || 0) + 1;
console.log(`[soak] view kinds: ${JSON.stringify(byKind)}`);

// `--enable-precise-memory-info` makes `performance.memory.usedJSHeapSize`
// report real byte counts instead of the privacy-bucketed (quantized) value, and
// `--expose-gc` makes the `window.gc()` we call after each sweep actually run a
// collection — without both, the heap-growth assertion below is decorative.
const browser = await chromium.launch({
  timeout: 300000,
  args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"],
});
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
const page = await ctx.newPage();
// Pre-create the telemetry rings BEFORE the app boots, so its real
// ViewTelemetryProfiler / module caches push into them (cache-telemetry only
// records when the ring array already exists).
await page.addInitScript(() => {
  // The module-cache ring only records when its array already exists; the
  // view-runtime + render rings self-create, but pre-seed all three so nothing
  // emitted during early boot is lost.
  window.__ELIZA_RENDER_TELEMETRY__ = [];
  window.__ELIZA_MODULE_CACHE_TELEMETRY__ = [];
  window.__ELIZA_VIEW_RUNTIME_TELEMETRY__ = [];
});
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message)));

await page.goto(UI, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(9000);
// Dismiss the first-time-user welcome overlay if present so it doesn't trap nav.
await page
  .getByTestId("ftu-welcome-dismiss")
  .click({ timeout: 2500 })
  .catch(() => {});
await page.waitForTimeout(1500);

const heap = async () =>
  page.evaluate(() =>
    performance?.memory ? performance.memory.usedJSHeapSize : 0,
  );
const drain = async () =>
  page.evaluate(() => {
    const vr = window.__ELIZA_VIEW_RUNTIME_TELEMETRY__ || [];
    const mc = window.__ELIZA_MODULE_CACHE_TELEMETRY__ || [];
    const maxRender = vr.reduce((m, e) => Math.max(m, e.renderCount || 0), 0);
    return {
      viewRuntime: vr.length,
      shows: vr.filter((e) => e.reason === "show").length,
      viewEvicts: vr.filter((e) => e.reason === "evict").length,
      maxRenderCount: maxRender,
      module: mc.length,
      moduleEvicts: mc.filter((e) => e.action === "evict").length,
    };
  });

// Navigate to a view through the REAL app navigation channel — the same
// `eliza:navigate:view` CustomEvent the shell's WS handler + launcher dispatch
// (App.tsx handleNavigateView). Switches builtin tabs via setTab and plugin/
// remote views via DynamicViewLoader, driving the real ViewRouter mount/unmount.
async function navTo(view) {
  await page.evaluate(
    (d) =>
      window.dispatchEvent(
        new CustomEvent("eliza:navigate:view", {
          detail: { viewId: d.id, viewPath: d.path },
        }),
      ),
    { id: view.id, path: view.path },
  );
  await page.waitForTimeout(550);
}

const heapStart = await heap();
const beforeChurn = await drain();
console.log(
  `[soak] start heap=${(heapStart / 1e6).toFixed(1)}MB telemetry=${JSON.stringify(beforeChurn)}`,
);

// 2) Churn: cycle every view, ROUNDS times, forcing real mount/unmount + eviction.
const heapSamples = [heapStart];
let shots = 0;
for (let r = 0; r < ROUNDS; r++) {
  for (const v of views) {
    await navTo(v);
    // capture a few representative views once for evidence
    if (r === 0 && shots < 6 && ["system", "developer"].includes(v.viewKind)) {
      await page
        .screenshot({
          path: join(
            OUT,
            `view-${String(++shots).padStart(2, "0")}-${v.id}.png`,
          ),
        })
        .catch(() => {});
    }
  }
  // force GC if exposed, then sample heap after each full sweep
  await page.evaluate(() => window.gc?.()).catch(() => {});
  heapSamples.push(await heap());
}

const afterChurn = await drain();
const heapEnd = heapSamples[heapSamples.length - 1];
const cycles = ROUNDS * views.length;
console.log(
  `[soak] after ${cycles} view activations telemetry=${JSON.stringify(afterChurn)} heapEnd=${(heapEnd / 1e6).toFixed(1)}MB`,
);

// 3) Assertions — the real view lifecycle behaved under churn.
assert(
  afterChurn.shows > beforeChurn.shows,
  `view-runtime telemetry recorded real view mounts under churn (${beforeChurn.shows} -> ${afterChurn.shows} 'show' events)`,
);
// No per-view re-render storm: the worst view's committed render count stays
// well under a pathological bound across its whole soak lifetime.
assert(
  afterChurn.maxRenderCount > 0 && afterChurn.maxRenderCount < 400,
  `no per-view render storm: worst view renderCount = ${afterChurn.maxRenderCount} (0 < n < 400)`,
);
// Eviction happened: a backgrounded view's instance and/or its module is pruned
// under churn — proves the bounded caches prune rather than grow unbounded.
assert(
  afterChurn.viewEvicts > 0 || afterChurn.moduleEvicts > 0,
  `bounded caches evicted under churn (view-instance evicts=${afterChurn.viewEvicts}, module-cache evicts=${afterChurn.moduleEvicts}) — the LRU prunes`,
);
// heap must not grow unboundedly: end within 2.2x of the post-warm baseline.
// With precise-memory-info + real GC (see launch args) this ratio is measured on
// actual collected heap, so a leaking view that retains instances across the
// sweep trips it; 2.2x is a deliberately loose doubling-guard to stay non-flaky.
const heapWarm = heapSamples[1] || heapStart;
const heapRatio = heapEnd / Math.max(1, heapWarm);
assert(
  heapRatio < 2.2 || heapEnd === 0,
  `heap bounded across the soak: end ${(heapEnd / 1e6).toFixed(1)}MB / warm ${(heapWarm / 1e6).toFixed(1)}MB = ${heapRatio.toFixed(2)}x (< 2.2x; 0 = no perf.memory)`,
);
assert(
  pageErrors.length === 0,
  `no uncaught page errors during the soak (${JSON.stringify(pageErrors.slice(0, 3))})`,
);

await page.screenshot({ path: join(OUT, "soak-final.png") }).catch(() => {});
await browser.close();

const report = {
  benchmark: "audit:views real-app soak",
  ui: UI,
  api: API,
  views: views.length,
  viewKinds: byKind,
  rounds: ROUNDS,
  activations: cycles,
  telemetry: { before: beforeChurn, after: afterChurn },
  heap: {
    startBytes: heapStart,
    endBytes: heapEnd,
    samples: heapSamples,
    boundedRatio: heapEnd / Math.max(1, heapSamples[1] || heapStart),
  },
  checks,
  pass: fails === 0,
};
writeFileSync(
  join(OUT, "audit-views-soak.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  `\n${fails === 0 ? "PASS" : `FAIL (${fails})`} — audit:views soak over ${cycles} activations of ${views.length} real views → ${OUT}`,
);
process.exit(fails === 0 ? 0 : 1);
