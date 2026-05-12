// Mirrored at cloud/packages/ui/src/runtime/render-telemetry.tsx. The cloud
// workspace is a separate package tree and cannot depend on @elizaos/ui, so
// the two files are kept in lock-step manually. When changing one, change the
// other.

import { useEffect, useRef } from "react";

export const RENDER_TELEMETRY_EVENT = "eliza:render-telemetry";

const INFO_THRESHOLD = 2;
const ERROR_THRESHOLD = 3;
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

function readEnvValue(key: string): boolean | string | undefined {
  const meta = import.meta as ImportMetaWithEnv;
  const viteValue = meta.env?.[key];
  if (viteValue !== undefined) return viteValue;
  if (typeof process !== "undefined") {
    return process.env[key];
  }
  return undefined;
}

function isRenderTelemetryEnabled(): boolean {
  const explicit = readEnvValue("VITE_ELIZA_RENDER_TELEMETRY");
  if (explicit === "0" || explicit === "false") return false;

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
 * Development/test-only render-rate guard.
 *
 * Tracks render timestamps for the named component. It emits structured
 * telemetry and logs once when a component renders twice within the telemetry
 * window, then escalates to `console.error` if it reaches three renders within
 * that same window. Production builds skip all work.
 */
export function useRenderGuard(name: string): void {
  const timestamps = useRef<number[]>([]);
  const lastSeverity = useRef<RenderTelemetrySeverity | null>(null);
  const pendingTelemetry = useRef<RenderTelemetryEvent | null>(null);
  useEffect(() => {
    const event = pendingTelemetry.current;
    if (!event) return;
    pendingTelemetry.current = null;
    emitRenderTelemetry(event);
  });

  if (!isRenderTelemetryEnabled()) return;

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
  pendingTelemetry.current = {
    source: "useRenderGuard",
    name,
    severity,
    renderCount: ts.length,
    threshold: severity === "error" ? ERROR_THRESHOLD : INFO_THRESHOLD,
    windowMs: WINDOW_MS,
    timestamps: ts.slice(),
    at: now,
  };
}
