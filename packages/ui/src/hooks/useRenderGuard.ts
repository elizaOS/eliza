// Mirrored at cloud/packages/ui/src/runtime/render-telemetry.tsx. The cloud
// workspace is a separate package tree and cannot depend on @elizaos/ui, so
// the two files are kept in lock-step manually. When changing one, change the
// other.

import { useEffect, useRef } from "react";

export const RENDER_TELEMETRY_EVENT = "eliza:render-telemetry";

// Thresholds describe a *runaway render loop*, not ordinary churn. Normal
// behaviour — startup data settling, typing, dragging, token streaming — easily
// produces a handful of commits per second, and React StrictMode double-invokes
// the mount effect in dev, so the previous 2/3 thresholds fired constantly on
// healthy components (e.g. FirstRunScreen during first-run). A real loop renders
// continuously, far faster than any interaction sustains, so only a rate well
// above one commit per frame is flagged.
const INFO_THRESHOLD = 60;
const ERROR_THRESHOLD = 120;
const WINDOW_MS = 1000;

type ImportMetaWithEnv = ImportMeta & {
  env?: Record<string, boolean | string | undefined>;
};

export type RenderTelemetrySeverity = "info" | "error";

export interface RenderTelemetryEvent {
  source: "useRenderGuard";
  name: string;
  severity: RenderTelemetrySeverity;
  renderCount: number;
  threshold: number;
  windowMs: number;
  timestamps: number[];
  at: number;
}

type RenderTelemetrySink = (event: RenderTelemetryEvent) => void;

let renderTelemetrySink: RenderTelemetrySink | null = null;

type RenderTelemetryGlobal = typeof globalThis & {
  __ELIZA_RENDER_TELEMETRY_DISABLED__?: boolean;
};

function readEnvValue(key: string): boolean | string | undefined {
  const meta = import.meta as ImportMetaWithEnv;
  if (key === "VITE_ELIZA_RENDER_TELEMETRY") {
    const explicit = meta.env?.VITE_ELIZA_RENDER_TELEMETRY;
    if (explicit !== undefined) return explicit;
  }
  const viteValue = meta.env?.[key];
  if (viteValue !== undefined) return viteValue;
  if (typeof process !== "undefined") {
    return process.env[key];
  }
  return undefined;
}

function isRenderTelemetryEnabled(): boolean {
  if (
    (globalThis as RenderTelemetryGlobal)
      .__ELIZA_RENDER_TELEMETRY_DISABLED__ === true
  ) {
    return false;
  }

  const explicit = readEnvValue("VITE_ELIZA_RENDER_TELEMETRY");
  if (explicit === false || explicit === "0" || explicit === "false") {
    return false;
  }
  if (explicit === true || explicit === "1" || explicit === "true") {
    return true;
  }

  const nodeEnv =
    typeof process !== "undefined" ? process.env.NODE_ENV : undefined;
  const meta = import.meta as ImportMetaWithEnv;
  const mode = meta.env?.MODE;

  return (
    meta.env?.DEV === true ||
    mode === "development" ||
    mode === "test" ||
    nodeEnv === "development" ||
    nodeEnv === "test"
  );
}

function formatRenderTelemetryMessage(event: RenderTelemetryEvent): string {
  return `[RenderTelemetry] "${event.name}" rendered ${event.renderCount} times within ${event.windowMs}ms`;
}

function emitRenderTelemetry(event: RenderTelemetryEvent): void {
  renderTelemetrySink?.(event);

  const globalObject = globalThis as typeof globalThis & {
    __ELIZA_RENDER_TELEMETRY__?: RenderTelemetryEvent[];
  };
  if (Array.isArray(globalObject.__ELIZA_RENDER_TELEMETRY__)) {
    globalObject.__ELIZA_RENDER_TELEMETRY__.push(event);
  }

  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function" &&
    typeof CustomEvent !== "undefined"
  ) {
    window.dispatchEvent(
      new CustomEvent(RENDER_TELEMETRY_EVENT, { detail: event }),
    );
  }

  const message = formatRenderTelemetryMessage(event);
  if (event.severity === "error") {
    console.error(message, event);
    return;
  }
  console.info(message, event);
}

export function setRenderTelemetrySink(sink: RenderTelemetrySink | null): void {
  renderTelemetrySink = sink;
}

/**
 * Development/test-only guard for runaway render loops.
 *
 * Tracks commit timestamps for the named component within a 1s sliding window
 * and emits structured telemetry only when the rate is high enough to indicate
 * a loop rather than ordinary churn: an `info` heads-up at `INFO_THRESHOLD`
 * commits/window, escalating to a single `console.error` at `ERROR_THRESHOLD`.
 * Thresholds sit well above normal startup churn, typing, dragging, and token
 * streaming to avoid false positives. Production builds skip all work.
 */
export function useRenderGuard(name: string): void {
  const timestamps = useRef<number[]>([]);
  const currentName = useRef(name);
  const lastSeverity = useRef<RenderTelemetrySeverity | null>(null);

  useEffect(() => {
    if (!isRenderTelemetryEnabled()) return;

    if (currentName.current !== name) {
      currentName.current = name;
      timestamps.current = [];
      lastSeverity.current = null;
    }

    const now = Date.now();
    const ts = timestamps.current;
    ts.push(now);

    while (ts.length > 0 && ts[0] < now - WINDOW_MS) {
      ts.shift();
    }

    if (ts.length < INFO_THRESHOLD) {
      lastSeverity.current = null;
      return;
    }

    const severity: RenderTelemetrySeverity =
      ts.length >= ERROR_THRESHOLD ? "error" : "info";
    if (lastSeverity.current === severity) return;
    if (lastSeverity.current === "error") return;

    lastSeverity.current = severity;
    emitRenderTelemetry({
      source: "useRenderGuard",
      name,
      severity,
      renderCount: ts.length,
      threshold: severity === "error" ? ERROR_THRESHOLD : INFO_THRESHOLD,
      windowMs: WINDOW_MS,
      timestamps: ts.slice(),
      at: now,
    });
  });
}
