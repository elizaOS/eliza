"use client";

// Mirror of eliza/packages/ui/src/hooks/useRenderGuard.ts. The cloud workspace
// is a separate package tree and cannot depend on @elizaos/ui, so this file is
// kept in lock-step manually. When changing one, change the other.

import {
  Profiler,
  type ProfilerOnRenderCallback,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
} from "react";

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
  sequence: number;
  route?: string;
  stack?: string;
  previousStack?: string;
}

export interface ProfilerRenderTelemetryEvent {
  source: "ReactProfiler";
  name: string;
  severity: RenderTelemetrySeverity;
  phase: "mount" | "update" | "nested-update";
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
  updateCount: number;
  threshold: number;
  windowMs: number;
  at: number;
  sequence: number;
  route?: string;
}

export type AnyRenderTelemetryEvent =
  | RenderTelemetryEvent
  | ProfilerRenderTelemetryEvent;

type RenderTelemetrySink = (event: AnyRenderTelemetryEvent) => void;

let renderTelemetrySink: RenderTelemetrySink | null = null;
let renderTelemetrySequence = 0;

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

function currentRoute(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return `${window.location.pathname}${window.location.search}`;
}

function captureRenderStack(): string | undefined {
  try {
    const stack = new Error().stack;
    if (!stack) return undefined;
    return stack
      .split("\n")
      .slice(2, 12)
      .map((line) => line.trim())
      .join("\n");
  } catch {
    return undefined;
  }
}

function formatRenderTelemetryMessage(event: AnyRenderTelemetryEvent): string {
  if (event.source === "ReactProfiler") {
    return `[RenderTelemetry] "${event.name}" committed ${event.updateCount} profiler updates within ${event.windowMs}ms`;
  }
  return `[RenderTelemetry] "${event.name}" rendered ${event.renderCount} times within ${event.windowMs}ms`;
}

function emitRenderTelemetry(event: AnyRenderTelemetryEvent): void {
  renderTelemetrySink?.(event);

  const globalObject = globalThis as typeof globalThis & {
    __ELIZA_RENDER_TELEMETRY__?: AnyRenderTelemetryEvent[];
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

export function useRenderGuard(name: string): void {
  const timestamps = useRef<number[]>([]);
  const renderStack = useRef<string | undefined>(undefined);
  const previousRenderStack = useRef<string | undefined>(undefined);
  const currentName = useRef(name);
  const lastSeverity = useRef<RenderTelemetrySeverity | null>(null);

  previousRenderStack.current = renderStack.current;
  renderStack.current = captureRenderStack();

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
      sequence: ++renderTelemetrySequence,
      route: currentRoute(),
      stack: renderStack.current,
      previousStack: previousRenderStack.current,
    });
  });
}

export function RenderTelemetryProfiler({
  children,
  id = "App",
}: {
  children: ReactNode;
  id?: string;
}) {
  const commits = useRef<number[]>([]);
  const lastSeverity = useRef<RenderTelemetrySeverity | null>(null);

  const onRender = useMemo<ProfilerOnRenderCallback>(
    () =>
      (
        profilerId,
        phase,
        actualDuration,
        baseDuration,
        startTime,
        commitTime,
      ) => {
        if (!isRenderTelemetryEnabled()) return;

        const now = Date.now();
        const ts = commits.current;
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
          source: "ReactProfiler",
          name: profilerId,
          severity,
          phase,
          actualDuration,
          baseDuration,
          startTime,
          commitTime,
          updateCount: ts.length,
          threshold: severity === "error" ? ERROR_THRESHOLD : INFO_THRESHOLD,
          windowMs: WINDOW_MS,
          at: now,
          sequence: ++renderTelemetrySequence,
          route: currentRoute(),
        });
      },
    [],
  );

  if (!isRenderTelemetryEnabled()) {
    return <>{children}</>;
  }

  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}
