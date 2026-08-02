/**
 * AuditSink implementation that persists `AuditEvent`s emitted by
 * the cloud audit dispatcher to the `auth_events` table.
 *
 * Registered with the global `AuditDispatcher` from `bootstrap-app.ts`.
 * Persistence errors bubble to the dispatcher, which completes fan-out and
 * rejects because this is a required compliance sink.
 */

import type { AuditEvent, AuditSink } from "@/api-app/services/audit";
import { dbWrite } from "@/db/client";
import { authEvents } from "@/db/schemas/auth-events";

export class AuditEventsSink implements AuditSink {
  readonly name = "auth_events_pg";
  readonly required = true;

  async emit(event: AuditEvent): Promise<void> {
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
  }
}

export const auditEventsSink = new AuditEventsSink();
