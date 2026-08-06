/**
 * Core Web Vitals + custom chat performance metrics.
 *
 * Observed metrics are forwarded to an analytics sink (no-op by default;
 * swap in your analytics provider via `setMetricSink`).
 */

export interface PerformanceMetric {
  name: string;
  value: number;
  rating?: "good" | "needs-improvement" | "poor";
  /** Additional context (e.g. conversationId, messageCount) */
  meta?: Record<string, unknown>;
}

type MetricSink = (metric: PerformanceMetric) => void;

let sink: MetricSink = () => {};

/** Register a custom analytics sink (e.g. PostHog, Datadog, console). */
export function setMetricSink(fn: MetricSink): void {
  sink = fn;
}

function report(metric: PerformanceMetric): void {
  if (process.env.NODE_ENV === "development") {
    // eslint-disable-next-line no-console
    console.debug("[perf]", metric.name, metric.value.toFixed(1), metric.rating ?? "");
  }
  sink(metric);
}

// ─── Core Web Vitals ────────────────────────────────────────────────────────

function rateVital(name: string, value: number): PerformanceMetric["rating"] {
  const thresholds: Record<string, [number, number]> = {
    LCP: [2500, 4000],
    FID: [100, 300],
    CLS: [0.1, 0.25],
    INP: [200, 500],
    TTFB: [800, 1800],
    FCP: [1800, 3000],
  };
  const [good, poor] = thresholds[name] ?? [0, Infinity];
  if (value <= good) return "good";
  if (value <= poor) return "needs-improvement";
  return "poor";
}

export function observeWebVitals(): void {
  if (typeof window === "undefined" || !("PerformanceObserver" in window)) return;

  // LCP
  try {
    const lcpObs = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1] as PerformancePaintTiming;
      const value = last.startTime;
      report({ name: "LCP", value, rating: rateVital("LCP", value) });
    });
    lcpObs.observe({ type: "largest-contentful-paint", buffered: true });
  } catch {}

  // FID / INP
  try {
    const fidObs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const e = entry as PerformanceEventTiming;
        const value = e.processingStart - e.startTime;
        report({ name: "FID", value, rating: rateVital("FID", value) });
      }
    });
    fidObs.observe({ type: "first-input", buffered: true });
  } catch {}

  // CLS
  try {
    let clsValue = 0;
    let clsSessionGap = 0;
    let clsSessionValue = 0;
    const clsObs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const e = entry as LayoutShift;
        if (!e.hadRecentInput) {
          const now = e.startTime;
          if (now - clsSessionGap > 1000 || clsValue === 0) {
            clsSessionValue = e.value;
          } else {
            clsSessionValue += e.value;
          }
          clsSessionGap = now;
          clsValue = Math.max(clsValue, clsSessionValue);
          report({ name: "CLS", value: clsValue, rating: rateVital("CLS", clsValue) });
        }
      }
    });
    clsObs.observe({ type: "layout-shift", buffered: true });
  } catch {}

  // TTFB
  try {
    const navObs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const nav = entry as PerformanceNavigationTiming;
        const value = nav.responseStart - nav.requestStart;
        report({ name: "TTFB", value, rating: rateVital("TTFB", value) });
      }
    });
    navObs.observe({ type: "navigation", buffered: true });
  } catch {}
}

// ─── Custom Chat Metrics ─────────────────────────────────────────────────────

/** Call when the chat input becomes interactive. */
export function markTimeToInteractive(): void {
  if (typeof performance === "undefined") return;
  const value = performance.now();
  report({ name: "time_to_interactive", value });
}

/** Call when the first message bubble finishes rendering. */
export function markFirstMessageRender(): void {
  if (typeof performance === "undefined") return;
  const value = performance.now();
  report({ name: "first_message_render", value });
}

/**
 * Measures streaming token latency: time from when the server sends the
 * first chunk to when it appears in the DOM.
 *
 * Usage:
 *   const end = startStreamingLatencyMeasurement();
 *   // … after DOM update …
 *   end();
 */
export function startStreamingLatencyMeasurement(): () => void {
  const start = performance.now();
  return () => {
    const value = performance.now() - start;
    report({ name: "streaming_token_latency_ms", value });
  };
}

/** Monitor scroll FPS during user scrolling. Returns a cleanup fn. */
export function monitorScrollFps(element: HTMLElement): () => void {
  let frameCount = 0;
  let lastTime = performance.now();
  let rafId: number;
  let scrolling = false;

  const onScroll = () => { scrolling = true; };

  const loop = () => {
    rafId = requestAnimationFrame(loop);
    if (!scrolling) return;
    frameCount++;
    const now = performance.now();
    if (now - lastTime >= 1000) {
      const fps = (frameCount / (now - lastTime)) * 1000;
      report({ name: "scroll_fps", value: fps, rating: fps >= 55 ? "good" : fps >= 30 ? "needs-improvement" : "poor" });
      frameCount = 0;
      lastTime = now;
      scrolling = false;
    }
  };

  element.addEventListener("scroll", onScroll, { passive: true });
  rafId = requestAnimationFrame(loop);

  return () => {
    cancelAnimationFrame(rafId);
    element.removeEventListener("scroll", onScroll);
  };
}
