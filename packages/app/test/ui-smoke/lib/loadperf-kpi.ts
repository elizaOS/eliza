// Self-contained frontend web-vitals collector for the ui-smoke Playwright
// harness. The measurement approach mirrors
// packages/benchmarks/loadperf/frontend-kpi.mjs so this spec agrees with the
// standalone loadperf harness:
//   - LCP via PerformanceObserver("largest-contentful-paint")
//   - CLS via PerformanceObserver("layout-shift") (excluding hadRecentInput)
//   - FCP via the "first-contentful-paint" paint entry
//   - JS bytes via performance.getEntriesByType("resource").encodedBodySize
//     for entries whose initiatorType === "script"
//
// Observers are installed via addInitScript so they are wired before any
// navigation, capturing the very first paint's LCP/CLS (buffered: true).

import type { Page } from "@playwright/test";

export interface FrontendKpiSample {
  /** First Contentful Paint in ms, or null if no paint entry was recorded. */
  fcpMs: number | null;
  /** Largest Contentful Paint in ms, or null if no LCP candidate exists. */
  lcpMs: number | null;
  /** Cumulative Layout Shift (unitless), 0 when no shifts occurred. */
  cls: number;
  /** Total encoded bytes of script resources transferred. */
  jsTransferredBytes: number;
  /** Total number of resource entries fetched by the page. */
  requestCount: number;
}

// The page-side global the init script populates and readFrontendKpis() drains.
const KPI_GLOBAL = "__elizaLoadperfKpi__";

interface KpiCollectorState {
  lcpMs: number | null;
  cls: number;
}

declare global {
  interface Window {
    [KPI_GLOBAL]?: KpiCollectorState;
  }
}

/**
 * Wire the LCP/CLS PerformanceObservers before navigation so the first paint is
 * captured. Must be called before page.goto/openAppPath.
 */
export async function installWebVitalsObservers(page: Page): Promise<void> {
  await page.addInitScript((globalKey: string) => {
    const state: KpiCollectorState = { lcpMs: null, cls: 0 };
    (window as unknown as Record<string, KpiCollectorState>)[globalKey] = state;

    try {
      const lcpObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last) {
          state.lcpMs = last.startTime;
        }
      });
      lcpObserver.observe({
        type: "largest-contentful-paint",
        buffered: true,
      });
    } catch {
      // LCP unsupported in this engine; leave lcpMs null.
    }

    try {
      const clsObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & {
            value: number;
            hadRecentInput: boolean;
          };
          if (!shift.hadRecentInput) {
            state.cls += shift.value;
          }
        }
      });
      clsObserver.observe({ type: "layout-shift", buffered: true });
    } catch {
      // layout-shift unsupported; leave cls at 0.
    }
  }, KPI_GLOBAL);
}

/**
 * Drain the collected web-vitals and compute payload/request KPIs from the
 * page's resource timing buffer.
 */
export async function readFrontendKpis(page: Page): Promise<FrontendKpiSample> {
  return page.evaluate((globalKey: string): FrontendKpiSample => {
    const state = (window as unknown as Record<string, KpiCollectorState>)[
      globalKey
    ] ?? { lcpMs: null, cls: 0 };

    const paintEntries = performance.getEntriesByType("paint");
    const fcpEntry = paintEntries.find(
      (entry) => entry.name === "first-contentful-paint",
    );
    const fcpMs = fcpEntry ? fcpEntry.startTime : null;

    const resourceEntries = performance.getEntriesByType(
      "resource",
    ) as PerformanceResourceTiming[];
    let jsTransferredBytes = 0;
    for (const entry of resourceEntries) {
      if (entry.initiatorType === "script") {
        jsTransferredBytes += entry.encodedBodySize;
      }
    }

    return {
      fcpMs,
      lcpMs: state.lcpMs,
      cls: state.cls,
      jsTransferredBytes,
      requestCount: resourceEntries.length,
    };
  }, KPI_GLOBAL);
}

/** Human-readable one-line summary for the test reporter. */
export function formatKpiSample(sample: FrontendKpiSample): string {
  const fcp = sample.fcpMs === null ? "n/a" : `${Math.round(sample.fcpMs)}ms`;
  const lcp = sample.lcpMs === null ? "n/a" : `${Math.round(sample.lcpMs)}ms`;
  const jsMb = (sample.jsTransferredBytes / (1024 * 1024)).toFixed(2);
  return `FCP=${fcp} LCP=${lcp} CLS=${sample.cls.toFixed(4)} JS=${jsMb}MB requests=${sample.requestCount}`;
}
