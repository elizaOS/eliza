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
import {
  finalizeSoakEvidence,
  waitForOnboardingClearance,
} from "./audit-views-soak-boundary.mjs";

const UI = process.env.UI || "http://127.0.0.1:2138";
const API = process.env.API || "http://127.0.0.1:31337";
const ROUNDS = Number(process.env.ROUNDS || 6);
const NAV_WAIT_MS = Number(process.env.NAV_WAIT_MS || 700);
const VIDEO = process.env.VIDEO !== "0";
const SETUP_FIRST_RUN = process.env.SETUP_FIRST_RUN !== "0";
const OUT =
  process.env.OUT || join(process.cwd(), "capture-output", "10196-views-state");
mkdirSync(OUT, { recursive: true });

let fails = 0;
const checks = [];
function assert(cond, msg) {
  checks.push({ ok: !!cond, msg });
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) fails += 1;
}

function writeJson(name, value) {
  writeFileSync(join(OUT, name), `${JSON.stringify(value, null, 2)}\n`);
}

function normalizePath(path) {
  if (!path || typeof path !== "string") return "/";
  const bare = path.split(/[?#]/, 1)[0] || "/";
  const withSlash = bare.startsWith("/") ? bare : `/${bare}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
}

function viewKind(view) {
  if (typeof view.viewKind === "string" && view.viewKind.length > 0) {
    return view.viewKind;
  }
  return view.bundleUrl ? "plugin" : "unspecified";
}

function candidateRuntimeIds(view) {
  const ids = new Set();
  if (view.id) ids.add(String(view.id));
  const path = normalizePath(view.path);
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 1) ids.add(parts[0]);
  if ((parts[0] === "apps" || parts[0] === "views") && parts[1]) {
    ids.add(`${parts[0]}:${parts[1]}`);
    ids.add(parts[1]);
  }
  return [...ids];
}

function eventRouteMatchesView(event, view) {
  return normalizePath(event?.route) === normalizePath(view.path);
}

function runtimeEventsForView(events, view) {
  const ids = new Set(candidateRuntimeIds(view));
  return events.filter(
    (event) =>
      ids.has(String(event.viewId)) || eventRouteMatchesView(event, view),
  );
}

function renderEventsForView(events, view) {
  const ids = new Set(candidateRuntimeIds(view));
  return events.filter(
    (event) =>
      ids.has(String(event.name)) || eventRouteMatchesView(event, view),
  );
}

function moduleEventsForView(events, view) {
  const ids = candidateRuntimeIds(view);
  const path = normalizePath(view.path);
  const bundleUrl = typeof view.bundleUrl === "string" ? view.bundleUrl : null;
  return events.filter((event) => {
    if (eventRouteMatchesView(event, view)) return true;
    const key = typeof event.key === "string" ? event.key : "";
    if (bundleUrl && key.startsWith(bundleUrl)) return true;
    if (key === path) return true;
    return ids.some((id) => key === id || key.includes(id));
  });
}

function maxNumber(values) {
  return values.reduce(
    (max, value) =>
      typeof value === "number" && Number.isFinite(value)
        ? Math.max(max, value)
        : max,
    0,
  );
}

function escapeCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");
}

function buildScorecard({
  views,
  raw,
  navRecords,
  heapSamples,
  videoArtifact,
  networkSummary,
}) {
  const rows = views.map((view) => {
    const runtime = runtimeEventsForView(raw.viewRuntime, view);
    const render = renderEventsForView(raw.render, view);
    const module = moduleEventsForView(raw.module, view);
    const nav = navRecords.get(view.id)?.activations ?? [];
    const reached = nav.filter((entry) => entry.reached).length;
    const firstRunBlocks = nav.filter((entry) => entry.firstRunBlocking).length;
    const renderErrors = render.filter((event) => event.severity === "error");
    const renderInfos = render.filter((event) => event.severity === "info");
    return {
      id: view.id,
      label: view.label ?? view.name ?? view.id,
      kind: viewKind(view),
      path: normalizePath(view.path),
      runtimeIds: candidateRuntimeIds(view).join(", "),
      activations: nav.length,
      reached,
      firstRunBlocks,
      showEvents: runtime.filter((event) => event.reason === "show").length,
      hideEvents: runtime.filter((event) => event.reason === "hide").length,
      viewEvicts: runtime.filter((event) => event.reason === "evict").length,
      maxRenderCount: maxNumber(runtime.map((event) => event.renderCount)),
      renderInfoEvents: renderInfos.length,
      renderErrorEvents: renderErrors.length,
      moduleLoads: module.filter((event) => event.action === "load").length,
      moduleEvicts: module.filter((event) => event.action === "evict").length,
      moduleCleanups: module.filter((event) => event.action === "cleanup")
        .length,
    };
  });

  const summary = {
    views: rows.length,
    reached: rows.filter((row) => row.reached > 0).length,
    firstRunBlocks: rows.reduce((sum, row) => sum + row.firstRunBlocks, 0),
    renderErrors: rows.reduce((sum, row) => sum + row.renderErrorEvents, 0),
    moduleEvicts: rows.reduce((sum, row) => sum + row.moduleEvicts, 0),
    moduleCleanups: rows.reduce((sum, row) => sum + row.moduleCleanups, 0),
  };

  const heapWarm = heapSamples[1] ?? heapSamples[0] ?? 0;
  const heapEnd = heapSamples.at(-1) ?? 0;
  const heapRatio = heapEnd / Math.max(1, heapWarm);
  const table = [
    "| view | kind | path | reached | first-run | runtime ids | show | max renders | render guard | evict | cleanup |",
    "|---|---:|---|---:|---:|---|---:|---:|---:|---:|---:|",
    ...rows
      .map((row) =>
        [
          row.label,
          row.kind,
          row.path,
          `${row.reached}/${row.activations}`,
          row.firstRunBlocks,
          row.runtimeIds,
          row.showEvents,
          row.maxRenderCount,
          row.renderErrorEvents > 0
            ? `${row.renderErrorEvents} error`
            : row.renderInfoEvents > 0
              ? `${row.renderInfoEvents} info`
              : "clean",
          row.viewEvicts + row.moduleEvicts,
          row.moduleCleanups,
        ]
          .map(escapeCell)
          .join(" | "),
      )
      .map((line) => `| ${line} |`),
  ].join("\n");

  const markdown = `# #10196 audit:views scorecard

Budget: every registered view path must be reached at least once; render guard
severity must stay below \`error\`; worst per-view runtime render count must stay
below 400; collected heap after churn must stay under 2.2x the warm baseline;
module/view caches must emit at least one real eviction during churn or forced
release.

## Summary

- Views reached: ${summary.reached}/${summary.views}
- Visible first-run chooser blocks: ${summary.firstRunBlocks}
- Render-guard errors: ${summary.renderErrors}
- Module/view evictions attributed in scorecard: ${summary.moduleEvicts}
- Module cleanups attributed in scorecard: ${summary.moduleCleanups}
- Network log classification: ${networkSummary.unexpectedCount} unexpected / ${networkSummary.total} total (${networkSummary.expectedAbortCount} navigation aborts, ${networkSummary.expectedOptionalRoute404Count} optional-route 404s, ${networkSummary.expectedProtectedRoute401Count} protected-route 401s)
- Heap series: ${heapSamples.map((sample) => `${(sample / 1e6).toFixed(1)}MB`).join(" -> ")} (${heapRatio.toFixed(2)}x)
- Raw artifacts: \`audit-views-render-telemetry.json\`, \`audit-views-runtime-telemetry.json\`, \`audit-views-module-cache-telemetry.json\`, \`audit-views-heap-series.json\`, \`audit-views-frontend-log.json\`, \`audit-views-network-log.json\`, \`audit-views-network-summary.json\`
- Video: ${videoArtifact ? `\`${videoArtifact}\`` : "N/A (VIDEO=0)"}

## Per-View Scorecard

${table}
`;

  return { rows, summary, markdown };
}

function classifyNetworkEntry(entry) {
  if (entry.kind === "requestfailed" && entry.failure === "net::ERR_ABORTED") {
    return {
      expected: true,
      reason: "navigation_churn_abort",
      note: "The soak intentionally switches routes quickly; in-flight fetches may be aborted by navigation/unmount cleanup.",
    };
  }

  const pathname = (() => {
    try {
      return new URL(entry.url).pathname;
    } catch {
      // error-policy:J3 an invalid URL remains unclassified and therefore
      // becomes an explicit unexpected-network failure below.
      return "";
    }
  })();
  const optionalMissingRoutes = new Set([
    "/api/connectors/google/accounts",
    "/api/database/status",
    "/api/lifeops/goals",
    "/api/lifeops/todos",
    "/api/meetings",
    "/api/transcripts",
  ]);
  if (
    entry.kind === "response" &&
    entry.status === 404 &&
    optionalMissingRoutes.has(pathname)
  ) {
    return {
      expected: true,
      reason: "optional_route_not_installed",
      note: "Optional local services/connectors are not installed in this audit stack; the UI handles the missing route.",
    };
  }

  const protectedRoutesWithoutSession = new Set([
    "/api/cloud/status",
    "/api/config",
  ]);
  if (
    entry.kind === "response" &&
    entry.status === 401 &&
    protectedRoutesWithoutSession.has(pathname)
  ) {
    return {
      expected: true,
      reason: "protected_route_without_session",
      note: "The tokenless Vite audit has no remote/cloud session, so protected reads correctly fail closed while local owner views remain exercisable.",
    };
  }

  return {
    expected: false,
    reason: "unexpected_network_failure",
    note: "Unclassified network failure; investigate before accepting audit evidence.",
  };
}

function summarizeNetworkLog(networkLog) {
  const classified = networkLog.map((entry) => ({
    ...entry,
    classification: classifyNetworkEntry(entry),
  }));
  const byReason = {};
  for (const entry of classified) {
    const reason = entry.classification.reason;
    byReason[reason] = (byReason[reason] ?? 0) + 1;
  }
  const unexpected = classified.filter(
    (entry) => !entry.classification.expected,
  );
  return {
    total: classified.length,
    expectedAbortCount: byReason.navigation_churn_abort ?? 0,
    expectedOptionalRoute404Count: byReason.optional_route_not_installed ?? 0,
    expectedProtectedRoute401Count:
      byReason.protected_route_without_session ?? 0,
    unexpectedCount: unexpected.length,
    byReason,
    unexpected,
    classified,
  };
}

let activeBrowser = null;
let activeContext = null;

async function cleanupAfterFailure() {
  if (activeContext) {
    try {
      await activeContext.close();
    } catch (error) {
      // error-policy:J6 the original soak failure remains authoritative; this
      // retry only prevents its browser child from surviving the process.
      console.warn(
        `[soak] context cleanup after failure also failed: ${error}`,
      );
    }
    activeContext = null;
  }
  if (activeBrowser) {
    try {
      await activeBrowser.close();
    } catch (error) {
      // error-policy:J6 the process is already failing and browser shutdown is
      // retried only to avoid leaking the Playwright child.
      console.warn(
        `[soak] browser cleanup after failure also failed: ${error}`,
      );
    }
    activeBrowser = null;
  }
}

async function isFirstRunBlocking(page) {
  return page
    .getByTestId("chat-first-run-backdrop")
    .isVisible({ timeout: 500 });
}

async function waitForRuntimeReady(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let lastHealth = { state: "not-requested" };

  while (Date.now() < deadline) {
    const [attempt] = await Promise.allSettled([
      fetch(`${API}/api/health`).then(async (response) => ({
        status: response.status,
        body: await response.json(),
      })),
    ]);
    if (attempt.status === "fulfilled") {
      lastHealth = attempt.value;
      if (
        attempt.value.status === 200 &&
        attempt.value.body.ready === true &&
        attempt.value.body.runtime === "ok"
      ) {
        return attempt.value.body;
      }
    } else {
      lastHealth = { state: "request-failed", reason: String(attempt.reason) };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(
    `runtime did not become ready before first-run setup: ${JSON.stringify(lastHealth)}`,
  );
}

async function completeFirstRunIfNeeded() {
  const status = await fetch(`${API}/api/first-run/status`).then((response) => {
    if (!response.ok) {
      throw new Error(`first-run status failed with HTTP ${response.status}`);
    }
    return response.json();
  });
  const required = status.complete !== true;
  const result = {
    enabled: SETUP_FIRST_RUN,
    required,
    completed: !required,
    method: required ? "api-minimal-local-profile" : "already-complete",
  };
  if (!required || !SETUP_FIRST_RUN) {
    return result;
  }

  const response = await fetch(`${API}/api/first-run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Eliza" }),
  });
  if (!response.ok) {
    throw new Error(`first-run setup failed with HTTP ${response.status}`);
  }
  const verified = await fetch(`${API}/api/first-run/status`).then((entry) =>
    entry.json(),
  );
  result.completed = verified.complete === true;
  return result;
}

async function main() {
  // 1) Enumerate the real registered views.
  const viewsRes = await fetch(`${API}/api/views`).then((r) => r.json());
  const views = (viewsRes.views || []).filter((v) => v.path);
  assert(
    views.length >= 10,
    `enumerated ${views.length} registered views via /api/views`,
  );
  const byKind = {};
  for (const v of views) byKind[viewKind(v)] = (byKind[viewKind(v)] || 0) + 1;
  console.log(`[soak] view kinds: ${JSON.stringify(byKind)}`);
  await waitForRuntimeReady();
  const firstRunSetup = await completeFirstRunIfNeeded();

  // `--enable-precise-memory-info` makes `performance.memory.usedJSHeapSize`
  // report real byte counts instead of the privacy-bucketed (quantized) value, and
  // `--expose-gc` makes the `window.gc()` we call after each sweep actually run a
  // collection — without both, the heap-growth assertion below is decorative.
  const browser = await chromium.launch({
    timeout: 300000,
    args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"],
  });
  activeBrowser = browser;
  const contextOptions = {
    viewport: { width: 1440, height: 900 },
  };
  if (VIDEO) {
    contextOptions.recordVideo = {
      dir: OUT,
      size: { width: 1440, height: 900 },
    };
  }
  const ctx = await browser.newContext(contextOptions);
  activeContext = ctx;
  const page = await ctx.newPage();
  const video = page.video();
  // Pre-create the telemetry rings BEFORE the app boots, so its real
  // ViewTelemetryProfiler / module caches push into them (cache-telemetry only
  // records when the ring array already exists).
  await page.addInitScript(() => {
    // The browser-side startup snapshot is the second half of first-run
    // completion. API persistence alone leaves a fresh CI profile in the
    // onboarding transition even though the server reports complete.
    localStorage.setItem("eliza:first-run-complete", "1");
    localStorage.setItem("eliza:setup:step", "activate");
    localStorage.setItem("eliza:ui-shell-mode", "native");
    localStorage.setItem("eliza:chat:voiceMuted", "true");
    // The module-cache ring only records when its array already exists; the
    // view-runtime + render rings self-create, but pre-seed all three so nothing
    // emitted during early boot is lost.
    window.__ELIZA_RENDER_TELEMETRY__ = [];
    window.__ELIZA_MODULE_CACHE_TELEMETRY__ = [];
    window.__ELIZA_VIEW_RUNTIME_TELEMETRY__ = [];
  });
  const pageErrors = [];
  const consoleLog = [];
  const networkLog = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message)));
  page.on("console", (msg) => {
    consoleLog.push({
      type: msg.type(),
      text: msg.text(),
      location: msg.location(),
    });
  });
  page.on("requestfailed", (request) => {
    networkLog.push({
      kind: "requestfailed",
      method: request.method(),
      url: request.url(),
      failure: request.failure()?.errorText ?? null,
    });
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    networkLog.push({
      kind: "response",
      status: response.status(),
      url: response.url(),
    });
  });

  await page.goto(UI, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  await waitForOnboardingClearance(page);
  await page.waitForTimeout(3000);

  const heap = async () =>
    page.evaluate(() =>
      performance?.memory ? performance.memory.usedJSHeapSize : 0,
    );
  const snapshotTelemetry = async () =>
    page.evaluate(() => {
      const render = window.__ELIZA_RENDER_TELEMETRY__ || [];
      const viewRuntime = window.__ELIZA_VIEW_RUNTIME_TELEMETRY__ || [];
      const module = window.__ELIZA_MODULE_CACHE_TELEMETRY__ || [];
      const maxRender = viewRuntime.reduce(
        (m, e) => Math.max(m, e.renderCount || 0),
        0,
      );
      return {
        raw: { render, viewRuntime, module },
        summary: {
          render: render.length,
          renderErrors: render.filter((e) => e.severity === "error").length,
          viewRuntime: viewRuntime.length,
          shows: viewRuntime.filter((e) => e.reason === "show").length,
          viewEvicts: viewRuntime.filter((e) => e.reason === "evict").length,
          maxRenderCount: maxRender,
          module: module.length,
          moduleEvicts: module.filter((e) => e.action === "evict").length,
          moduleCleanups: module.filter((e) => e.action === "cleanup").length,
        },
      };
    });

  // Navigate to a view through the REAL app navigation channel — the same
  // `eliza:navigate:view` CustomEvent the shell's WS handler + launcher dispatch
  // (App.tsx handleNavigateView). Switches builtin tabs via setTab and plugin/
  // remote views via DynamicViewLoader, driving the real ViewRouter mount/unmount.
  async function dispatchShellNavigation(view) {
    await page.evaluate(
      (detail) =>
        window.dispatchEvent(
          new CustomEvent("eliza:navigate:view", { detail }),
        ),
      { viewId: view.id, viewPath: view.path },
    );
  }

  async function navTo(view) {
    const targetPath = normalizePath(view.path);
    const beforePath = await page.evaluate(() => window.location.pathname);
    await dispatchShellNavigation(view);
    await page.waitForFunction(
      (target) => {
        const path = window.location.pathname;
        const normalized = path.length > 1 ? path.replace(/\/+$/, "") : path;
        return normalized === target;
      },
      targetPath,
      { timeout: Math.max(1000, NAV_WAIT_MS * 3) },
    );
    await page.waitForTimeout(NAV_WAIT_MS);
    const afterPath = await page.evaluate(() => window.location.pathname);
    const firstRunBlocking = await isFirstRunBlocking(page);
    return {
      id: view.id,
      label: view.label ?? view.name ?? view.id,
      targetPath,
      beforePath: normalizePath(beforePath),
      afterPath: normalizePath(afterPath),
      reached: normalizePath(afterPath) === targetPath,
      firstRunBlocking,
    };
  }

  const heapStart = await heap();
  const beforeSnapshot = await snapshotTelemetry();
  const beforeChurn = beforeSnapshot.summary;
  console.log(
    `[soak] start heap=${(heapStart / 1e6).toFixed(1)}MB telemetry=${JSON.stringify(beforeChurn)}`,
  );

  // 2) Churn: cycle every view, ROUNDS times, forcing real mount/unmount + eviction.
  const heapSamples = [heapStart];
  const navRecords = new Map(
    views.map((view) => [view.id, { view, activations: [] }]),
  );
  let shots = 0;
  for (let r = 0; r < ROUNDS; r++) {
    for (const v of views) {
      const navRecord = await navTo(v);
      navRecords.get(v.id)?.activations.push({
        round: r + 1,
        ...navRecord,
      });
      // capture a few representative views once for evidence
      if (
        r === 0 &&
        shots < 6 &&
        ["system", "developer"].includes(viewKind(v))
      ) {
        await page.screenshot({
          path: join(
            OUT,
            `view-${String(++shots).padStart(2, "0")}-${v.id}.png`,
          ),
        });
      }
    }
    // force GC if exposed, then sample heap after each full sweep
    await page.evaluate(() => window.gc?.());
    heapSamples.push(await heap());
  }

  const afterChurnSnapshot = await snapshotTelemetry();
  const afterChurn = afterChurnSnapshot.summary;
  const heapEnd = heapSamples[heapSamples.length - 1];
  const cycles = ROUNDS * views.length;
  console.log(
    `[soak] after ${cycles} view activations telemetry=${JSON.stringify(afterChurn)} heapEnd=${(heapEnd / 1e6).toFixed(1)}MB`,
  );

  // Leave the final active view through the same shell-owned navigation channel
  // used by the churn. Raw History calls execute under that view's realm and are
  // intentionally denied by the surface-realm broker.
  await dispatchShellNavigation({ id: "chat", path: "/chat" });
  await page.waitForTimeout(NAV_WAIT_MS);
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent("eliza:heap-pressure"));
    document.dispatchEvent(new Event("eliza:app-pause"));
    window.dispatchEvent(new Event("eliza:app-pause"));
  });
  await page.waitForTimeout(Math.max(1000, NAV_WAIT_MS));

  const afterReleaseSnapshot = await snapshotTelemetry();
  const afterRelease = afterReleaseSnapshot.summary;

  // 3) Assertions — the real view lifecycle behaved under churn.
  const reachedViews = [...navRecords.values()].filter((record) =>
    record.activations.some((activation) => activation.reached),
  ).length;
  const firstRunBlockedActivations = [...navRecords.values()].reduce(
    (sum, record) =>
      sum +
      record.activations.filter((activation) => activation.firstRunBlocking)
        .length,
    0,
  );
  assert(
    reachedViews === views.length,
    `navigation reached every registered view path (${reachedViews}/${views.length})`,
  );
  assert(
    firstRunSetup.completed && firstRunBlockedActivations === 0,
    `first-run overlay did not block captured views (setup=${JSON.stringify(firstRunSetup)}, blocked activations=${firstRunBlockedActivations})`,
  );
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
    afterRelease.viewEvicts > 0 || afterRelease.moduleEvicts > 0,
    `bounded caches evicted under churn/release (view-instance evicts=${afterRelease.viewEvicts}, module-cache evicts=${afterRelease.moduleEvicts}, cleanups=${afterRelease.moduleCleanups}) — the LRU prunes`,
  );
  assert(
    afterRelease.moduleCleanups > 0 || afterRelease.moduleEvicts > 0,
    `eviction telemetry includes release cleanup or evict events after APP_PAUSE/heap-pressure (${afterChurn.moduleEvicts}/${afterChurn.moduleCleanups} -> ${afterRelease.moduleEvicts}/${afterRelease.moduleCleanups})`,
  );
  assert(
    afterRelease.renderErrors === beforeChurn.renderErrors,
    `no new render-loop guard errors during view churn (${beforeChurn.renderErrors} -> ${afterRelease.renderErrors})`,
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

  // Closing the context owns page teardown and video finalization as one
  // operation. Closing the page first can deadlock Playwright's ffmpeg recorder
  // after a long capture, leaving an unattended nightly green-but-running until
  // the workflow timeout kills it.
  const videoArtifact = await finalizeSoakEvidence({
    page,
    context: ctx,
    video,
    videoRequired: VIDEO,
    outDir: OUT,
    onContextClosed: () => {
      activeContext = null;
    },
  });
  await browser.close();
  activeBrowser = null;

  const networkSummary = summarizeNetworkLog(networkLog);
  assert(
    networkSummary.unexpectedCount === 0,
    `no unexpected network failures during the soak (${networkSummary.unexpectedCount} unexpected / ${networkSummary.total} total; expected navigation aborts=${networkSummary.expectedAbortCount}, expected optional-route 404s=${networkSummary.expectedOptionalRoute404Count}, expected protected-route 401s=${networkSummary.expectedProtectedRoute401Count})`,
  );

  const finalRaw = afterReleaseSnapshot.raw;
  writeJson("audit-views-render-telemetry.json", finalRaw.render);
  writeJson("audit-views-runtime-telemetry.json", finalRaw.viewRuntime);
  writeJson("audit-views-module-cache-telemetry.json", finalRaw.module);
  writeJson("audit-views-heap-series.json", {
    samples: heapSamples,
    startBytes: heapStart,
    endBytes: heapEnd,
    boundedRatio: heapEnd / Math.max(1, heapSamples[1] || heapStart),
  });
  writeJson("audit-views-navigation.json", [...navRecords.values()]);
  writeJson("audit-views-frontend-log.json", {
    console: consoleLog,
    pageErrors,
  });
  writeJson("audit-views-network-log.json", networkLog);
  writeJson("audit-views-network-summary.json", networkSummary);
  const scorecard = buildScorecard({
    views,
    raw: finalRaw,
    navRecords,
    heapSamples,
    videoArtifact,
    networkSummary,
  });
  writeJson("audit-views-scorecard.json", scorecard.rows);
  writeFileSync(join(OUT, "audit-views-scorecard.md"), scorecard.markdown);

  const report = {
    benchmark: "audit:views real-app soak",
    ui: UI,
    api: API,
    views: views.length,
    viewKinds: byKind,
    rounds: ROUNDS,
    activations: cycles,
    firstRunSetup,
    telemetry: {
      before: beforeChurn,
      afterChurn,
      afterRelease,
      scorecard: scorecard.summary,
    },
    heap: {
      startBytes: heapStart,
      endBytes: heapEnd,
      samples: heapSamples,
      boundedRatio: heapEnd / Math.max(1, heapSamples[1] || heapStart),
    },
    artifacts: {
      scorecard: join(OUT, "audit-views-scorecard.md"),
      renderTelemetry: join(OUT, "audit-views-render-telemetry.json"),
      runtimeTelemetry: join(OUT, "audit-views-runtime-telemetry.json"),
      moduleCacheTelemetry: join(
        OUT,
        "audit-views-module-cache-telemetry.json",
      ),
      heapSeries: join(OUT, "audit-views-heap-series.json"),
      navigation: join(OUT, "audit-views-navigation.json"),
      frontendLog: join(OUT, "audit-views-frontend-log.json"),
      networkLog: join(OUT, "audit-views-network-log.json"),
      networkSummary: join(OUT, "audit-views-network-summary.json"),
      video: videoArtifact ? join(OUT, videoArtifact) : null,
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
  if (fails > 0) {
    throw new Error(`audit:views soak failed ${fails} required checks`);
  }
}

// error-policy:J1 the process boundary translates any required-check or
// evidence-finalization failure into cleanup, diagnostics, and a non-zero exit.
await main().catch(async (error) => {
  await cleanupAfterFailure();
  console.error(
    `[soak] fatal: ${error instanceof Error ? error.stack : error}`,
  );
  process.exitCode = 1;
});
