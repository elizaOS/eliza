/**
 * Audit sink implementations for in-memory tests, structured logs, files, and HTTP collectors.
 */

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

export interface HttpSinkOptions {
  endpoint: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

/**
 * Production HTTP sink. Posts one validated audit event per request to the
 * configured append-only audit endpoint.
 */
export class HttpSink implements AuditSink {
  readonly name = "http";
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;

  constructor(endpointOrOptions: string | HttpSinkOptions) {
    const options =
      typeof endpointOrOptions === "string"
        ? { endpoint: endpointOrOptions }
        : endpointOrOptions;
    this.endpoint = options.endpoint;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.headers = options.headers ?? {};
  }

  async emit(event: AuditEvent): Promise<void> {
    if (!this.fetchImpl) {
      throw new Error("HttpSink requires a fetch implementation");
    }
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify(event),
    });
    if (!response.ok) {
      throw new Error(
        `HttpSink failed: ${response.status} ${response.statusText}`.trim(),
      );
    }
  }
}
