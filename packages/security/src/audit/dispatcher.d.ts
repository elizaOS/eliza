import { type AuditAction } from "./actions.js";
import type { AuditSink } from "./sink.js";
import { type AuditActor, type AuditEvent, type AuditResource, type AuditResult } from "./types.js";
export declare function redactMetadata(action: AuditAction, metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined;
export interface EmitInput {
    actor: AuditActor;
    action: string;
    result: AuditResult;
    resource?: AuditResource | null;
    ip?: string;
    user_agent?: string;
    request_id?: string;
    org_id?: string;
    metadata?: Record<string, unknown>;
}
export interface SinkError {
    sink: string;
    error: Error;
}
export interface AuditDispatcherOptions {
    sinks: AuditSink[];
    onSinkError?: (err: SinkError, event: AuditEvent) => void;
}
export declare class AuditDispatcher {
    private readonly sinks;
    private readonly onSinkError;
    constructor(opts: AuditDispatcherOptions);
    addSink(sink: AuditSink): void;
    /**
     * Build, validate, redact, and fan out an event. One sink failing does NOT
     * prevent the others from receiving the event; failures are surfaced via
     * `onSinkError`.
     */
    emit(input: EmitInput): Promise<AuditEvent>;
}
//# sourceMappingURL=dispatcher.d.ts.map