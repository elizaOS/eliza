import { type ReactNode } from "react";
export declare const RENDER_TELEMETRY_EVENT = "eliza:render-telemetry";
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
export declare function setRenderTelemetrySink(
  sink: RenderTelemetrySink | null,
): void;
export declare function useRenderGuard(name: string): void;
export declare function RenderTelemetryProfiler({
  children,
  id,
}: {
  children: ReactNode;
  id?: string;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=render-telemetry.d.ts.map
