import type { AuditEvent } from "./types.js";
export interface AuditSink {
    readonly name: string;
    emit(event: AuditEvent): Promise<void>;
}
export declare class InMemorySink implements AuditSink {
    readonly name = "memory";
    private readonly events;
    emit(event: AuditEvent): Promise<void>;
    snapshot(): AuditEvent[];
    clear(): void;
}
export declare class ConsoleSink implements AuditSink {
    readonly name = "console";
    emit(event: AuditEvent): Promise<void>;
}
export declare class FileSink implements AuditSink {
    private readonly path;
    readonly name = "file";
    constructor(path: string);
    emit(event: AuditEvent): Promise<void>;
}
/**
 * Production HTTP sink. Stub — real implementation will POST to the SOC2
 * audit-log pipeline (likely a Steward-fronted append-only store).
 *
 * TODO(audit-sink): wire to real endpoint once defined. Until then this sink
 * intentionally throws so callers detect mis-configuration in dev.
 */
export declare class HttpSinkStub implements AuditSink {
    private readonly endpoint;
    readonly name = "http";
    constructor(endpoint: string);
    emit(_event: AuditEvent): Promise<void>;
}
//# sourceMappingURL=sink.d.ts.map