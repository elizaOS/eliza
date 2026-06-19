/**
 * Process-global `AuditDispatcher` instance for cloud-api.
 *
 * Initialised lazily on first access (and explicitly during `createApp()`
 * via `initAuditDispatcher`). Tests can swap the dispatcher by calling
 * `setAuditDispatcher` with a custom instance.
 */

import {
  AuditDispatcher,
  type AuditSink,
  ConsoleSink,
} from "@elizaos/security/audit";
import { logger } from "@/lib/utils/logger";
import { auditEventsSink } from "./audit-events";

let dispatcher: AuditDispatcher | null = null;

function buildDefaultSinks(): AuditSink[] {
  const sinks: AuditSink[] = [auditEventsSink];
  if (process.env.AUDIT_CONSOLE_SINK === "true") {
    sinks.push(new ConsoleSink());
  }
  return sinks;
}

export function initAuditDispatcher(sinks?: AuditSink[]): AuditDispatcher {
  dispatcher = new AuditDispatcher({
    sinks: sinks ?? buildDefaultSinks(),
    onSinkError: (err, event) => {
      logger.error("[AuditDispatcher] sink failed", {
        sink: err.sink,
        event_id: event.event_id,
        action: event.action,
        error: err.error.message,
      });
    },
  });
  return dispatcher;
}

export function getAuditDispatcher(): AuditDispatcher {
  if (!dispatcher) {
    dispatcher = initAuditDispatcher();
  }
  return dispatcher;
}

export function setAuditDispatcher(next: AuditDispatcher): void {
  dispatcher = next;
}
