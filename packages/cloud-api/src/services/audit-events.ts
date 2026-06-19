/**
 * AuditSink implementation that persists `AuditEvent`s emitted by
 * `@elizaos/security/audit` to the `auth_events` table.
 *
 * Registered with the global `AuditDispatcher` from `bootstrap-app.ts`.
 * One sink failing must never block the others, so we intentionally do not
 * re-throw structured logging here — failures bubble up to the dispatcher's
 * `onSinkError` handler, which logs and continues.
 */

import type { AuditEvent, AuditSink } from "@elizaos/security/audit";
import { dbWrite } from "@/db/client";
import { authEvents } from "@/db/schemas/auth-events";
import { logger } from "@/lib/utils/logger";

export class AuditEventsSink implements AuditSink {
  readonly name = "auth_events_pg";

  async emit(event: AuditEvent): Promise<void> {
    try {
      await dbWrite.insert(authEvents).values({
        event_id: event.event_id,
        ts: new Date(event.ts),
        actor_type: event.actor.type,
        actor_id: event.actor.id,
        action: event.action,
        result: event.result,
        resource_type: event.resource?.type ?? null,
        resource_id: event.resource?.id ?? null,
        ip: event.ip ?? null,
        ua: event.user_agent ?? null,
        request_id: event.request_id ?? null,
        org_id: event.org_id ?? null,
        metadata: event.metadata ?? null,
      });
    } catch (err) {
      // Surface to dispatcher onSinkError; also log so the failure is visible
      // even if the dispatcher swallows it.
      logger.error("[AuditEventsSink] Failed to persist audit event", {
        event_id: event.event_id,
        action: event.action,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

export const auditEventsSink = new AuditEventsSink();
