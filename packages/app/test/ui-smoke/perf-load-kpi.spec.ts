import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import {
  type FrontendKpiSample,
  formatKpiSample,
  installWebVitalsObservers,
  readFrontendKpis,
} from "./lib/loadperf-kpi";

// Soft, non-flaky budgets. These intentionally have generous headroom so the
// spec doubles as a measurement rather than a brittle gate. The thresholds
// match the loadperf harness (packages/benchmarks/loadperf/frontend-kpi.mjs).
const FCP_BUDGET_MS = 4000;
const LCP_BUDGET_MS = 6000;
const JS_BUDGET_BYTES = 6 * 1024 * 1024;

// The chat shell renders a stable, well-known ready signal that the existing
// ui-smoke specs (ui-smoke.spec.ts, live-agent-chat.spec.ts) rely on. We reuse
// it as the "app is interactive" marker so KPI sampling happens after a real
// first meaningful render rather than on a blank page.
const READY_SELECTOR = '[data-testid="chat-composer-textarea"]';

test.describe("frontend load KPIs", () => {
  test.beforeEach(async ({ page }) => {
    // Same seeding convention as ui-smoke.spec.ts: default local server +
    // the default mocked app routes.
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
    // Observers must be wired before navigation so the first paint's LCP/CLS
    // entries are captured (PerformanceObserver buffered: true).
    await installWebVitalsObservers(page);
  });

  test("chat shell meets web-vitals and payload budgets", async ({ page }) => {
    await openAppPath(page, "/chat");
    await expect(page.locator(READY_SELECTOR)).toBeVisible({
      timeout: 60_000,
    });
    // Let late resources finish and LCP/CLS settle before sampling.
    await page.waitForLoadState("networkidle");

    const sample: FrontendKpiSample = await readFrontendKpis(page);

    // Surface the raw numbers through the reporter so the spec is a usable
    // measurement, not just a pass/fail gate.
    const summary = formatKpiSample(sample);
    test.info().annotations.push({
      type: "loadperf-kpi",
      description: summary,
    });
    // Intentional KPI output for the e2e reporter (console is permitted in tests).
    console.log(`[perf-load-kpi] ${summary}`);

    // FCP must be measurable once the app has rendered.
    expect(
      sample.fcpMs,
      "First Contentful Paint must be measurable",
    ).not.toBeNull();
    if (sample.fcpMs !== null) {
      expect(
        sample.fcpMs,
        `FCP ${Math.round(sample.fcpMs)}ms exceeds budget ${FCP_BUDGET_MS}ms`,
      ).toBeLessThan(FCP_BUDGET_MS);
    }

    // LCP can legitimately be null on a view with no qualifying element; only
    // assert the budget when an LCP entry was actually recorded.
    if (sample.lcpMs !== null) {
      expect(
        sample.lcpMs,
        `LCP ${Math.round(sample.lcpMs)}ms exceeds budget ${LCP_BUDGET_MS}ms`,
      ).toBeLessThan(LCP_BUDGET_MS);
    }

    const jsMb = (sample.jsTransferredBytes / (1024 * 1024)).toFixed(2);
    expect(
      sample.jsTransferredBytes,
      `JS payload ${jsMb}MB exceeds budget ${JS_BUDGET_BYTES / (1024 * 1024)}MB`,
    ).toBeLessThan(JS_BUDGET_BYTES);

    // A rendered app must have loaded at least one resource; this guards
    // against measuring a blank/failed page that would trivially "pass".
    expect(sample.requestCount).toBeGreaterThan(0);
  });
});
