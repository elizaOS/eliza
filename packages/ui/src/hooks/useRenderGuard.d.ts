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
}
type RenderTelemetrySink = (event: RenderTelemetryEvent) => void;
export declare function setRenderTelemetrySink(
  sink: RenderTelemetrySink | null,
): void;
/**
 * Development/test-only render-rate guard.
 *
 * Tracks render timestamps for the named component. It emits structured
 * telemetry and logs once when a component renders twice within the telemetry
 * window, then escalates to `console.error` if it reaches three renders within
 * that same window. Production builds skip all work.
 */
export declare function useRenderGuard(name: string): void;
//# sourceMappingURL=useRenderGuard.d.ts.map
