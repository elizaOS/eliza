export type IntegrationBoundary = "cloud" | "wallet" | "marketplace" | "mcp";
export type IntegrationOutcome = "success" | "failure";
export interface IntegrationObservabilityEvent {
    schema: "integration_boundary_v1";
    boundary: IntegrationBoundary;
    operation: string;
    outcome: IntegrationOutcome;
    durationMs: number;
    timeoutMs?: number;
    statusCode?: number;
    errorKind?: string;
}
interface IntegrationLogger {
    info: (message: string) => void;
    warn: (message: string) => void;
}
interface IntegrationSpanMeta {
    boundary: IntegrationBoundary;
    operation: string;
    timeoutMs?: number;
}
interface IntegrationSpanSuccessArgs {
    statusCode?: number;
}
interface IntegrationSpanFailureArgs {
    statusCode?: number;
    error?: unknown;
    errorKind?: string;
}
interface CreateSpanOptions {
    now?: () => number;
    sink?: IntegrationLogger;
}
export interface IntegrationTelemetrySpan {
    success: (args?: IntegrationSpanSuccessArgs) => void;
    failure: (args?: IntegrationSpanFailureArgs) => void;
}
export declare function createIntegrationTelemetrySpan(meta: IntegrationSpanMeta, options?: CreateSpanOptions): IntegrationTelemetrySpan;
export {};
//# sourceMappingURL=integration-observability.d.ts.map