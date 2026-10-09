/**
 * Transactional audit for privileged mutations: the durable `auth_events` row
 * is written inside the mutation's database transaction (a failure rolls the
 * mutation back), then the committed event fans out to the remaining sinks.
 */

import type { DbTransaction } from "@elizaos/cloud-shared/db/client";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AuditEvent, EmitInput } from "@/api-app/services/audit";
import { getAuditDispatcher } from "./audit-dispatcher-singleton";
import { auditEventsSink } from "./audit-events";

export interface TransactionalAudit {
  /** Persist the durable record on `tx`; throws roll the caller's mutation back. */
  write(tx: DbTransaction, input: EmitInput): Promise<AuditEvent>;
  /** After commit: deliver every written event to the non-transactional sinks. */
  publish(): Promise<void>;
}

export function createTransactionalAudit(): TransactionalAudit {
  const dispatcher = getAuditDispatcher();
  const written: AuditEvent[] = [];
  return {
    async write(tx, input) {
      const event = dispatcher.buildEvent(input);
      await auditEventsSink.emitInTransaction(tx, event);
      written.push(event);
      return event;
    },
    async publish() {
      for (const event of written.splice(0)) {
        try {
          await dispatcher.deliver(event, { exclude: auditEventsSink.name });
        } catch (error) {
          // error-policy:J7 the durable record already committed with the
          // mutation; secondary sinks are observability and are logged loudly.
          logger.error("[Audit] post-commit audit fan-out failed", {
            event_id: event.event_id,
            action: event.action,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
  };
}
