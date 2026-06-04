"use client";

// Mirror of eliza/packages/ui/src/hooks/useRenderGuard.ts. The cloud workspace
// is a separate package tree and cannot depend on @elizaos/ui, so this file is
// kept in lock-step manually. When changing one, change the other.
//
// Only the RenderTelemetryProfiler component lives here so Vite React Fast
// Refresh can hot-patch it. The telemetry primitives (constants, types,
// setRenderTelemetrySink, useRenderGuard) live in ./render-telemetry.helpers.

import {
  Profiler,
  type ProfilerOnRenderCallback,
  type ReactNode,
  useMemo,
  useRef,
} from "react";
import {
  emitRenderTelemetry,
  ERROR_THRESHOLD,
  INFO_THRESHOLD,
  isRenderTelemetryEnabled,
  nextRenderTelemetrySequence,
  currentRoute,
  type RenderTelemetrySeverity,
  WINDOW_MS,
} from "./render-telemetry.helpers";

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
          sequence: nextRenderTelemetrySequence(),
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
