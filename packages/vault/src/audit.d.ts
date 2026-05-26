import type { AuditRecord, VaultLogger } from "./types.js";
/**
 * Append-only JSONL audit log. One line per vault operation. Records
 * keys, never values.
 */
export declare class AuditLog {
    private readonly path;
    private readonly logger?;
    constructor(path: string, logger?: VaultLogger | undefined);
    record(entry: Omit<AuditRecord, "ts"> & {
        ts?: number;
    }): Promise<void>;
}
//# sourceMappingURL=audit.d.ts.map