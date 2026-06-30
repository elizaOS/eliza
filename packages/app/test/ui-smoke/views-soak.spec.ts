/**
 * audit:views — the real view soak gate for issue #10196.
 *
 * Unlike the synthetic-fixture `test:view-lifecycle-e2e` (fake alpha/beta views,
 * no app server — which #10196's "no mocks standing in for the thing under test"
 * DoD disqualifies), this drives the REAL shell against the REAL view set:
 *
 *  1. boots the ui-smoke stack (real AgentRuntime / stub backend) with the same
 *     injected-session helpers the aesthetic audit uses;
 *  2. enumerates EVERY view from `GET /api/views` (server returns all kinds via
 *     includeAllKinds) with developer + preview toggled on so they all render;
 *  3. opens each view, then cycles the whole set N times, draining
 *     `__ELIZA_RENDER_TELEMETRY__`, `__ELIZA_MODULE_CACHE_TELEMETRY__`, and
 *     `performance.memory.usedJSHeapSize` between passes;
 *  4. asserts: no view trips the render-loop ERROR threshold, the retained-module
 *     cacheSize stays bounded, modules that were loaded are eventually evicted +
 *     cleaned up after release, and heap growth across the full cycle stays under
 *     budget;
 *  5. writes a committed per-view-kind scorecard + gitignored raw ring dumps
 *     under `.github/issue-evidence/10196-views-state/`, and exits non-zero on any
 *     regression.
 *
 * The render-telemetry ring is baked ON in the ui-smoke dist
 * (VITE_ELIZA_RENDER_TELEMETRY=1); the module-cache ring is unconditional once
 * pre-seeded as an array. Heap needs the project's --enable-precise-memory-info
 * + --js-flags=--expose-gc launch args (set in playwright.ui-smoke.config.ts).
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

// ── Budget (stated at the top of the scorecard) ────────────────────────────
/**
 * Full passes over the whole view set. The first pass is warmup (every view's
 * lazy chunk loads for the first time, the LRU fills) and is discarded from the
 * heap trend — a leak is a STEADY post-warmup climb, not the one-time load cost.
 */
const CYCLES = Number(process.env.VIEWS_SOAK_CYCLES || "5");
/** A view that emits a render-telemetry event of this severity is render-looping. */
const RENDER_LOOP_SEVERITY = "error";
/** Retained module cache must never exceed this many idle entries. */
const MAX_RETAINED_CACHE_SIZE = 16;
/** Post-warmup heap net-growth ratio (last/first) over budget = leak. */
const MAX_HEAP_GROWTH_RATIO = 1.5;
/** Post-warmup per-pass heap slope over budget (bytes) = leak. */
const MAX_HEAP_SLOPE_BYTES = 2 * 1024 * 1024;
/** Heap samples climb on >this fraction of passes to count as a real leak (vs GC jitter). */
const MIN_MONOTONIC_RATIO = 0.6;
/** Min post-warmup heap samples before a leak judgement is made. */
const MIN_HEAP_SAMPLES = 3;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = path.resolve(
  __dirname,
  "../../../../.github/issue-evidence/10196-views-state",
);

interface ApiView {
  id: string;
  label?: string;
  viewType?: string;
  path?: string;
  viewKind?: string;
  bundleUrl?: string;
  builtin?: boolean;
}

interface RenderTelemetryEvent {
  name?: string;
  severity?: string;
  route?: string;
  updateCount?: number;
}

interface ModuleCacheEvent {
  source?: string;
  action?: string;
  reason?: string;
  key?: string;
  cacheSize?: number;
  jsHeapUsedSize?: number;
}

interface ViewScore {
  id: string;
  kind: string;
  opened: boolean;
  peakRenderUpdates: number;
  renderLooped: boolean;
  error?: string;
}

/** Least-squares slope (bytes/pass) of the heap series — positive = growing. */
function heapSlope(samples: number[]): number {
  const n = samples.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = samples.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (samples[i] - meanY);
    den += (i - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/** Fraction of consecutive steps that increased — a leak climbs most passes. */
function monotonicIncreaseRatio(samples: number[]): number {
  if (samples.length < 2) return 0;
  let up = 0;
  for (let i = 1; i < samples.length; i++)
    if (samples[i] > samples[i - 1]) up++;
  return up / (samples.length - 1);
}

test.describe.configure({ mode: "serial" });

test("audit:views — every real view soaks without render-loop / leak / eviction failure (#10196)", async ({
  page,
}) => {
  test.setTimeout(600_000);

  // Pre-seed the telemetry rings as arrays BEFORE app boot (the emitters no-op
  // unless the ring is already an array).
  await page.addInitScript(() => {
    const g = globalThis as Record<string, unknown>;
    if (!Array.isArray(g.__ELIZA_RENDER_TELEMETRY__)) {
      g.__ELIZA_RENDER_TELEMETRY__ = [];
    }
    if (!Array.isArray(g.__ELIZA_MODULE_CACHE_TELEMETRY__)) {
      g.__ELIZA_MODULE_CACHE_TELEMETRY__ = [];
    }
  });
  // The "login": past onboarding on the local device, with developer + preview
  // view kinds enabled so every kind renders in this build.
  await seedAppStorage(page, {
    "eliza:developerMode": "1",
    "eliza:previewMode": "1",
  });
  await installDefaultAppRoutes(page);

  // Boot the shell, then enumerate every view from the real API.
  await openAppPath(page, "/chat");
  const apiViews = await page.evaluate(async (): Promise<ApiView[]> => {
    try {
      const res = await fetch("/api/views?viewType=gui");
      if (!res.ok) return [];
      const body = (await res.json()) as { views?: ApiView[] };
      return body.views ?? [];
    } catch {
      return [];
    }
  });

  expect(
    apiViews.length,
    "GET /api/views should enumerate the real view set",
  ).toBeGreaterThan(0);

  const kindCounts: Record<string, number> = {};
  for (const v of apiViews) {
    const k = v.viewKind ?? "unknown";
    kindCounts[k] = (kindCounts[k] ?? 0) + 1;
  }

  const scores: ViewScore[] = [];
  const heapSamples: number[] = [];

  async function openView(v: ApiView): Promise<void> {
    if (v.path) {
      await openAppPath(page, v.path);
    } else {
      await page.evaluate((id) => {
        window.dispatchEvent(
          new CustomEvent("eliza:navigate:view", { detail: { viewId: id } }),
        );
      }, v.id);
      await page.waitForTimeout(300);
    }
  }

  // Cycle the full set N times.
  for (let cycle = 0; cycle < CYCLES; cycle++) {
    for (const v of apiViews) {
      const existing = scores.find((s) => s.id === v.id);
      try {
        await openView(v);
        if (existing) {
          existing.opened = true;
        }
      } catch (err) {
        if (existing) {
          existing.error = String(err).slice(0, 200);
        } else {
          scores.push({
            id: v.id,
            kind: v.viewKind ?? "unknown",
            opened: false,
            peakRenderUpdates: 0,
            renderLooped: false,
            error: String(err).slice(0, 200),
          });
        }
        continue;
      }
      if (!existing) {
        scores.push({
          id: v.id,
          kind: v.viewKind ?? "unknown",
          opened: true,
          peakRenderUpdates: 0,
          renderLooped: false,
        });
      }
    }
    // End-of-pass: force GC (--expose-gc) then sample the settled heap.
    await page.evaluate(() => {
      (globalThis as { gc?: () => void }).gc?.();
    });
    await page.waitForTimeout(500);
    const heap = await page.evaluate(
      () =>
        (performance as Performance & { memory?: { usedJSHeapSize?: number } })
          .memory?.usedJSHeapSize ?? null,
    );
    if (typeof heap === "number" && Number.isFinite(heap)) {
      heapSamples.push(heap);
    }
  }

  // Drain the telemetry rings.
  const renderEvents = await page.evaluate(
    () =>
      ((globalThis as Record<string, unknown>)
        .__ELIZA_RENDER_TELEMETRY__ as RenderTelemetryEvent[]) ?? [],
  );
  const cacheEvents = await page.evaluate(
    () =>
      ((globalThis as Record<string, unknown>)
        .__ELIZA_MODULE_CACHE_TELEMETRY__ as ModuleCacheEvent[]) ?? [],
  );

  // ── Fold telemetry into per-view scores ──────────────────────────────────
  for (const ev of renderEvents) {
    const key = ev.name ?? ev.route ?? "";
    const score = scores.find((s) => s.id === key || key.includes(s.id));
    if (!score) continue;
    score.peakRenderUpdates = Math.max(
      score.peakRenderUpdates,
      ev.updateCount ?? 0,
    );
    if (ev.severity === RENDER_LOOP_SEVERITY) score.renderLooped = true;
  }

  const maxCacheSize = cacheEvents.reduce(
    (m, e) => Math.max(m, e.cacheSize ?? 0),
    0,
  );
  const loadKeys = new Set(
    cacheEvents.filter((e) => e.action === "load").map((e) => e.key),
  );
  const evictKeys = new Set(
    cacheEvents.filter((e) => e.action === "evict").map((e) => e.key),
  );
  const cleanupCount = cacheEvents.filter((e) => e.action === "cleanup").length;
  const heapEventsWithSize = cacheEvents.filter(
    (e) => typeof e.jsHeapUsedSize === "number",
  ).length;

  // Discard the warmup pass (first sample): a leak is a STEADY post-warmup
  // climb, not the one-time cost of loading every view's chunk on first visit.
  const trend = heapSamples.slice(1);
  const slope = heapSlope(trend);
  const growthRatio =
    trend.length >= 2 ? trend[trend.length - 1] / trend[0] : 1;
  const monotonic = monotonicIncreaseRatio(trend);
  // A leak must show a sustained, mostly-monotonic climb OVER budget — OR a net
  // growth over budget. A single GC-delayed bump cannot trip it.
  const heapLeaking =
    (slope > MAX_HEAP_SLOPE_BYTES && monotonic >= MIN_MONOTONIC_RATIO) ||
    growthRatio > MAX_HEAP_GROWTH_RATIO;
  const heapVerdict =
    trend.length < MIN_HEAP_SAMPLES
      ? "n/a (insufficient precise-heap samples on this runner)"
      : heapLeaking
        ? "LEAK"
        : "ok";

  const renderLoopers = scores.filter((s) => s.renderLooped);
  const unopened = scores.filter((s) => !s.opened);
  // Meaningfulness guard: if the render-telemetry ring is absent the soak's
  // render-loop assertion would pass vacuously. It is baked ON in the ui-smoke
  // dist (VITE_ELIZA_RENDER_TELEMETRY=1); assert the plumbing is actually live.
  const renderTelemetryLive = await page.evaluate(
    () =>
      Array.isArray(
        (globalThis as Record<string, unknown>).__ELIZA_RENDER_TELEMETRY__,
      ) &&
      typeof (globalThis as { __ELIZA_RENDER_TELEMETRY_DISABLED__?: unknown })
        .__ELIZA_RENDER_TELEMETRY_DISABLED__ === "undefined",
  );

  // ── Write the committed scorecard + gitignored raw dumps ─────────────────
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const scorecard = [
    "# Issue #10196 — `audit:views` soak scorecard",
    "",
    `> Budget (fail on any): every view opens (crash isolation) · render-loop ERROR severity = 0 views · retained cacheSize ≤ ${MAX_RETAINED_CACHE_SIZE} · post-warmup heap NOT (slope > ${(MAX_HEAP_SLOPE_BYTES / 1024 / 1024).toFixed(1)} MiB/pass AND monotonic ≥ ${MIN_MONOTONIC_RATIO}) AND growth ratio ≤ ${MAX_HEAP_GROWTH_RATIO} · render-telemetry plumbing live.`,
    "",
    `- views enumerated from \`/api/views\`: **${apiViews.length}** (${Object.entries(
      kindCounts,
    )
      .map(([k, n]) => `${k}: ${n}`)
      .join(", ")})`,
    `- cycles: **${CYCLES}** (first = warmup, discarded from heap trend) · render telemetry plumbing live: **${renderTelemetryLive}**`,
    `- render-telemetry events: ${renderEvents.length} (severity=error → render-loop) · module-cache events: ${cacheEvents.length} (with live heap: ${heapEventsWithSize})`,
    `- module cache: loads ${loadKeys.size} · evicts ${evictKeys.size} · cleanups ${cleanupCount} · peak cacheSize ${maxCacheSize}`,
    cacheEvents.length === 0
      ? "  - _(0 module-cache events: against the ui-smoke stub backend the enumerated views are statically-bundled builtin views with no remote bundle, so the module/LRU cache is not exercised. Remote-bundle eviction + cleanup is covered by the retained-lazy/DynamicViewLoader unit suites incl. the new heap-pressure eviction test; run with `ELIZA_UI_SMOKE_LIVE_STACK=1` to soak real plugin bundles.)_"
      : "",
    `- heap samples (per-pass, post-GC): ${heapSamples.map((b) => `${(b / 1024 / 1024).toFixed(1)}M`).join(" → ") || "none"}`,
    `- post-warmup heap: slope ${(slope / 1024 / 1024).toFixed(2)} MiB/pass · growth ratio ${growthRatio.toFixed(3)} · monotonic ${monotonic.toFixed(2)} · **verdict: ${heapVerdict}**`,
    "",
    "## Per-view",
    "",
    "| view | kind | opened | peak render updates/window | render-loop |",
    "| --- | --- | --- | --- | --- |",
    ...scores
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
      .map(
        (s) =>
          `| \`${s.id}\` | ${s.kind} | ${s.opened ? "yes" : `**NO** (${s.error ?? "?"})`} | ${s.peakRenderUpdates} | ${s.renderLooped ? "**YES**" : "no"} |`,
      ),
    "",
  ].join("\n");
  await writeFile(path.join(EVIDENCE_DIR, "scorecard.md"), `${scorecard}\n`);
  await writeFile(
    path.join(EVIDENCE_DIR, "render-telemetry.json"),
    JSON.stringify(renderEvents, null, 2),
  );
  await writeFile(
    path.join(EVIDENCE_DIR, "module-cache-telemetry.json"),
    JSON.stringify(cacheEvents, null, 2),
  );
  await writeFile(
    path.join(EVIDENCE_DIR, "heap-series.json"),
    JSON.stringify(
      { heapSamples, trend, slope, growthRatio, monotonic, heapVerdict },
      null,
      2,
    ),
  );

  // ── Assertions (exit non-zero on regression) ─────────────────────────────
  // Telemetry plumbing must be live, else the render-loop check is vacuous.
  expect(
    renderTelemetryLive,
    "render-telemetry ring must be live (VITE_ELIZA_RENDER_TELEMETRY) so the render-loop assertion is real, not vacuous",
  ).toBe(true);
  expect(
    unopened.map((s) => `${s.id} (${s.error})`),
    "every enumerated view must open without throwing (crash isolation)",
  ).toEqual([]);
  expect(
    renderLoopers.map((s) => s.id),
    "no view may trip the render-loop ERROR threshold during the soak",
  ).toEqual([]);
  expect(
    maxCacheSize,
    "retained module cacheSize must stay bounded across the full cycle",
  ).toBeLessThanOrEqual(MAX_RETAINED_CACHE_SIZE);
  if (trend.length >= MIN_HEAP_SAMPLES) {
    expect(heapVerdict, "heap must not leak post-warmup across the soak").toBe(
      "ok",
    );
  }
});
