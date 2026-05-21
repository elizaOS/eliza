import { appendFile } from "node:fs/promises";
import type { AuditEvent } from "./types.js";

export interface AuditSink {
  readonly name: string;
  emit(event: AuditEvent): Promise<void>;
}

export class InMemorySink implements AuditSink {
  readonly name = "memory";
  private readonly events: AuditEvent[] = [];
  async emit(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
  snapshot(): AuditEvent[] {
    return [...this.events];
  }
  clear(): void {
    this.events.length = 0;
  }
}

export class ConsoleSink implements AuditSink {
  readonly name = "console";
  async emit(event: AuditEvent): Promise<void> {
    // structured single-line JSON; downstream log shippers can parse.
    process.stdout.write(`[audit] ${JSON.stringify(event)}\n`);
  }
}

export class FileSink implements AuditSink {
  readonly name = "file";
  constructor(private readonly path: string) {}
  async emit(event: AuditEvent): Promise<void> {
    await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
  }
}

/**
 * Production HTTP sink. Stub — real implementation will POST to the SOC2
 * audit-log pipeline (likely a Steward-fronted append-only store).
 *
 * TODO(audit-sink): wire to real endpoint once defined. Until then this sink
 * intentionally throws so callers detect mis-configuration in dev.
 */
export class HttpSinkStub implements AuditSink {
  readonly name = "http";
  constructor(private readonly endpoint: string) {}
  async emit(_event: AuditEvent): Promise<void> {
    throw new Error(
      `HttpSinkStub: audit endpoint not yet implemented (${this.endpoint})`,
    );
  }
}
