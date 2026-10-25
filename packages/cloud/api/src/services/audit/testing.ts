/** In-memory audit sink used by tests that need to inspect emitted records. */

import type { AuditSink } from "./sink.js";
import type { AuditEvent } from "./types.js";

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
