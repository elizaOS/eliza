import {
  type LinkedCalendarEventRecord,
  type LinkedCalendarOperation,
  type LinkedCalendarProviderPort,
  type LinkedCalendarProviderSnapshot,
  type LinkedCalendarSemanticEvent,
  type LinkedCalendarState,
  linkedCalendarSemanticText,
} from "@elizaos/contracts";

export {
  type LinkedCalendarCheckpointStore,
  type LinkedCalendarEventRecord,
  type LinkedCalendarLocalPort,
  type LinkedCalendarLocalSnapshot,
  type LinkedCalendarOperation,
  type LinkedCalendarProviderPort,
  type LinkedCalendarProviderSnapshot,
  type LinkedCalendarReconcileOutcome,
  LinkedCalendarReconciler,
  type LinkedCalendarSemanticEvent,
  type LinkedCalendarState,
} from "@elizaos/contracts";

/**
 * Durable two-way reconciliation for events explicitly linked between the
 * built-in Eliza calendar and one Google calendar. The checkpoint records the
 * last common semantic hash, both provider identities, and unsafe outcomes so
 * retries never guess whether a remote write committed.
 */

import { createHash, randomUUID } from "node:crypto";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type {
  GoogleCalendarEvent,
  IGoogleWorkspaceService,
} from "@elizaos/plugin-google-workspace";
import {
  executeRawSql,
  executeRawSqlTx,
  sqlJson,
  sqlQuote,
  sqlText,
  toNumber,
  toText,
  withCalendarTransaction,
} from "../internal/sql.js";

function parseState(value: unknown): LinkedCalendarState {
  const state = toText(value);
  if (
    [
      "clean",
      "dirty",
      "conflicted",
      "quarantined",
      "paused",
      "local_only",
    ].includes(state)
  ) {
    return state as LinkedCalendarState;
  }
  throw new Error(`[LinkedCalendarRepository] Invalid state: ${state}`);
}

function parseOperation(value: unknown): LinkedCalendarOperation | null {
  if (value === null || value === undefined || value === "") return null;
  const operation = toText(value);
  if (["create", "update", "delete"].includes(operation)) {
    return operation as LinkedCalendarOperation;
  }
  throw new Error(`[LinkedCalendarRepository] Invalid operation: ${operation}`);
}

function parseRecord(row: Record<string, unknown>): LinkedCalendarEventRecord {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    localEventId: toText(row.local_event_id),
    connectorAccountId: toText(row.connector_account_id),
    providerCalendarId: toText(row.provider_calendar_id),
    providerEventId:
      row.provider_event_id === null || row.provider_event_id === undefined
        ? null
        : toText(row.provider_event_id),
    providerEtag:
      row.provider_etag === null || row.provider_etag === undefined
        ? null
        : toText(row.provider_etag),
    localRevision: toNumber(row.local_revision),
    lastCommonSemanticHash:
      row.last_common_semantic_hash === null ||
      row.last_common_semantic_hash === undefined
        ? null
        : toText(row.last_common_semantic_hash),
    state: parseState(row.state),
    pendingOperation: parseOperation(row.pending_operation),
    idempotencyKey: toText(row.idempotency_key),
    lastErrorCode:
      row.last_error_code === null || row.last_error_code === undefined
        ? null
        : toText(row.last_error_code),
    lastErrorMessage:
      row.last_error_message === null || row.last_error_message === undefined
        ? null
        : toText(row.last_error_message),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

export function linkedCalendarSemanticHash(
  event: LinkedCalendarSemanticEvent,
): string {
  return createHash("sha256")
    .update(linkedCalendarSemanticText(event))
    .digest("hex");
}

export class LinkedCalendarRepository {
  constructor(private readonly runtime: IAgentRuntime) {}

  async create(args: {
    agentId: string;
    localEventId: string;
    connectorAccountId: string;
    providerCalendarId: string;
    localRevision: number;
    now?: Date;
  }): Promise<LinkedCalendarEventRecord> {
    const now = (args.now ?? new Date()).toISOString();
    const id = randomUUID();
    const idempotencyKey = `linked-calendar:${args.agentId}:${args.localEventId}`;
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO app_calendar.linked_calendar_events (
        id, agent_id, local_event_id, connector_account_id, provider_calendar_id,
        provider_event_id, provider_etag, local_revision, last_common_semantic_hash,
        state, pending_operation, idempotency_key, created_at, updated_at
      ) VALUES (
        ${sqlQuote(id)}, ${sqlQuote(args.agentId)}, ${sqlQuote(args.localEventId)},
        ${sqlQuote(args.connectorAccountId)}, ${sqlQuote(args.providerCalendarId)},
        NULL, NULL, ${args.localRevision}, NULL, 'dirty', 'create',
        ${sqlQuote(idempotencyKey)}, ${sqlQuote(now)}, ${sqlQuote(now)}
      )
      ON CONFLICT (agent_id, local_event_id) DO UPDATE SET
        local_revision = GREATEST(app_calendar.linked_calendar_events.local_revision, EXCLUDED.local_revision),
        state = CASE WHEN app_calendar.linked_calendar_events.state IN ('paused', 'local_only') THEN 'dirty' ELSE app_calendar.linked_calendar_events.state END,
        pending_operation = CASE
          WHEN app_calendar.linked_calendar_events.state IN ('paused', 'local_only')
            THEN CASE WHEN app_calendar.linked_calendar_events.provider_event_id IS NULL THEN 'create' ELSE 'update' END
          ELSE app_calendar.linked_calendar_events.pending_operation
        END,
        updated_at = EXCLUDED.updated_at
      WHERE app_calendar.linked_calendar_events.connector_account_id = EXCLUDED.connector_account_id
        AND app_calendar.linked_calendar_events.provider_calendar_id = EXCLUDED.provider_calendar_id
      RETURNING *`,
    );
    if (!rows[0])
      throw new ElizaError(
        "An existing link cannot be silently moved to a different Google destination. Review the existing mapping before replacing its account or calendar.",
        {
          code: "LINKED_CALENDAR_DESTINATION_CONFLICT",
          context: {
            agentId: args.agentId,
            localEventId: args.localEventId,
          },
        },
      );
    const linked = parseRecord(rows[0]);
    if (
      linked.connectorAccountId !== args.connectorAccountId ||
      linked.providerCalendarId !== args.providerCalendarId
    ) {
      throw new Error(
        "[LinkedCalendarRepository] An existing link cannot be silently moved to a different Google destination",
      );
    }
    return linked;
  }

  /** Replaces a reviewed mapping while serializing with resume and dispatch admission. */
  async rebindWhilePaused(args: {
    linkId: string;
    expectedUpdatedAt: string;
    expectedLocalRevision: number;
    expectedControlRevision: number;
    connectorAccountId: string;
    providerCalendarId: string;
    operationKey: string;
  }): Promise<{
    previous: LinkedCalendarEventRecord;
    link: LinkedCalendarEventRecord;
    controlRevision: number;
    replayed: boolean;
  }> {
    return this.changeMappingWhilePaused({ ...args, operation: "rebind" });
  }

  async retainLocalWhilePaused(args: {
    linkId: string;
    expectedUpdatedAt: string;
    expectedLocalRevision: number;
    expectedControlRevision: number;
    operationKey: string;
  }): Promise<{
    previous: LinkedCalendarEventRecord;
    link: LinkedCalendarEventRecord;
    controlRevision: number;
    replayed: boolean;
  }> {
    return this.changeMappingWhilePaused({
      ...args,
      operation: "retain_local",
    });
  }

  private async changeMappingWhilePaused(
    args: {
      linkId: string;
      expectedUpdatedAt: string;
      expectedLocalRevision: number;
      expectedControlRevision: number;
      operationKey: string;
    } & (
      | { operation: "retain_local" }
      | {
          operation: "rebind";
          connectorAccountId: string;
          providerCalendarId: string;
        }
    ),
  ): Promise<{
    previous: LinkedCalendarEventRecord;
    link: LinkedCalendarEventRecord;
    controlRevision: number;
    replayed: boolean;
  }> {
    const invalid = () =>
      new ElizaError(
        "Refresh the paused calendar and review the exact mapping before replacing it",
        { code: "LINKED_CALENDAR_REBIND_CONFLICT" },
      );
    if (
      [
        args.linkId,
        args.expectedUpdatedAt,
        ...(args.operation === "rebind"
          ? [args.connectorAccountId, args.providerCalendarId]
          : []),
        args.operationKey,
      ].some((value) => !value.trim() || value.includes("\0")) ||
      !Number.isSafeInteger(args.expectedLocalRevision) ||
      args.expectedLocalRevision < 0 ||
      !Number.isSafeInteger(args.expectedControlRevision) ||
      args.expectedControlRevision < 0 ||
      args.expectedControlRevision >= 2_147_483_647
    )
      throw invalid();
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          args.operation,
          args.linkId,
          args.expectedUpdatedAt,
          args.expectedLocalRevision,
          args.expectedControlRevision,
          ...(args.operation === "rebind"
            ? [args.connectorAccountId, args.providerCalendarId]
            : []),
        ]),
      )
      .digest("hex");
    const object = (value: unknown): Record<string, unknown> => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw invalid();
      return value as Record<string, unknown>;
    };
    return withCalendarTransaction(this.runtime, async (tx) => {
      const controls = await executeRawSqlTx(
        tx,
        `SELECT * FROM app_calendar.linked_calendar_control
        WHERE agent_id = ${sqlQuote(this.runtime.agentId)} FOR UPDATE`,
      );
      const control = controls[0];
      if (!control) throw invalid();
      const receipts = await executeRawSqlTx(
        tx,
        `SELECT fingerprint, snapshot FROM app_calendar.linked_calendar_control_mutations
        WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND operation_key = ${sqlQuote(args.operationKey)}`,
      );
      if (receipts[0]) {
        if (receipts[0].fingerprint !== fingerprint) throw invalid();
        const snapshot = object(receipts[0].snapshot);
        if (
          snapshot.mappingOperation !== args.operation ||
          snapshot.revision !== control.revision ||
          typeof snapshot.revision !== "number"
        )
          throw invalid();
        return {
          previous: parseRecord(object(snapshot.mappingBefore)),
          link: parseRecord(object(snapshot.mappingAfter)),
          controlRevision: snapshot.revision,
          replayed: true,
        };
      }
      if (
        control.paused !== true ||
        control.dispatch_token !== null ||
        control.revision !== args.expectedControlRevision ||
        (args.operation === "rebind" &&
          (control.connector_account_id !== args.connectorAccountId ||
            control.provider_calendar_id !== args.providerCalendarId))
      )
        throw invalid();
      const rows = await executeRawSqlTx(
        tx,
        `SELECT * FROM app_calendar.linked_calendar_events
        WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND id = ${sqlQuote(args.linkId)} FOR UPDATE`,
      );
      if (!rows[0]) throw invalid();
      const previous = parseRecord(rows[0]);
      if (
        previous.updatedAt !== args.expectedUpdatedAt ||
        previous.localRevision !== args.expectedLocalRevision ||
        !["clean", "dirty", "paused", "local_only"].includes(previous.state) ||
        previous.pendingOperation === "delete" ||
        (args.operation === "rebind" &&
          previous.connectorAccountId === args.connectorAccountId &&
          previous.providerCalendarId === args.providerCalendarId)
      )
        throw invalid();
      const now = new Date().toISOString();
      const createKey = `linked-calendar:handoff:${createHash("sha256")
        .update(
          JSON.stringify([
            this.runtime.agentId,
            args.linkId,
            args.operationKey,
          ]),
        )
        .digest("hex")}`;
      const mappingUpdate =
        args.operation === "retain_local"
          ? "state = 'local_only', pending_operation = NULL, last_error_code = NULL, last_error_message = NULL"
          : `connector_account_id = ${sqlQuote(args.connectorAccountId)}, provider_calendar_id = ${sqlQuote(args.providerCalendarId)},
        provider_event_id = NULL, provider_etag = NULL, last_common_semantic_hash = NULL,
        state = 'dirty', pending_operation = 'create', idempotency_key = ${sqlQuote(createKey)},
        last_error_code = NULL, last_error_message = NULL`;
      const changed = await executeRawSqlTx(
        tx,
        `UPDATE app_calendar.linked_calendar_events SET ${mappingUpdate}, updated_at = ${sqlQuote(now)}
        WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND id = ${sqlQuote(args.linkId)} RETURNING *`,
      );
      if (!changed[0]) throw invalid();
      const updated = await executeRawSqlTx(
        tx,
        `UPDATE app_calendar.linked_calendar_control SET revision = revision + 1
        WHERE agent_id = ${sqlQuote(this.runtime.agentId)} RETURNING *`,
      );
      if (!updated[0] || typeof updated[0].revision !== "number")
        throw invalid();
      await executeRawSqlTx(
        tx,
        `INSERT INTO app_calendar.linked_calendar_control_mutations
        (id, agent_id, operation_key, fingerprint, snapshot, committed_at) VALUES (
        ${sqlQuote(randomUUID())}, ${sqlQuote(this.runtime.agentId)}, ${sqlQuote(args.operationKey)}, ${sqlQuote(fingerprint)},
        ${sqlJson({ ...updated[0], mappingOperation: args.operation, mappingBefore: rows[0], mappingAfter: changed[0] })}::jsonb, ${sqlQuote(now)})`,
      );
      return {
        previous,
        link: parseRecord(changed[0]),
        controlRevision: updated[0].revision,
        replayed: false,
      };
    });
  }

  async getByLocalEvent(
    agentId: string,
    localEventId: string,
  ): Promise<LinkedCalendarEventRecord | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_calendar.linked_calendar_events
       WHERE agent_id = ${sqlQuote(agentId)} AND local_event_id = ${sqlQuote(localEventId)} LIMIT 1`,
    );
    return rows[0] ? parseRecord(rows[0]) : null;
  }

  async getById(
    agentId: string,
    id: string,
  ): Promise<LinkedCalendarEventRecord | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_calendar.linked_calendar_events
       WHERE agent_id = ${sqlQuote(agentId)} AND id = ${sqlQuote(id)} LIMIT 1`,
    );
    return rows[0] ? parseRecord(rows[0]) : null;
  }

  async getByProviderEvent(args: {
    agentId: string;
    connectorAccountId: string;
    providerCalendarId: string;
    providerEventId: string;
  }): Promise<LinkedCalendarEventRecord | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_calendar.linked_calendar_events WHERE
       agent_id = ${sqlQuote(args.agentId)} AND
       connector_account_id = ${sqlQuote(args.connectorAccountId)} AND
       provider_calendar_id = ${sqlQuote(args.providerCalendarId)} AND
       provider_event_id = ${sqlQuote(args.providerEventId)} LIMIT 1`,
    );
    return rows[0] ? parseRecord(rows[0]) : null;
  }

  async listActionable(agentId: string): Promise<LinkedCalendarEventRecord[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_calendar.linked_calendar_events
       WHERE agent_id = ${sqlQuote(agentId)} AND state IN ('dirty', 'clean')
       ORDER BY updated_at, id`,
    );
    return rows.map(parseRecord);
  }

  async listForAgent(agentId: string): Promise<LinkedCalendarEventRecord[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_calendar.linked_calendar_events
       WHERE agent_id = ${sqlQuote(agentId)} ORDER BY created_at, id`,
    );
    return rows.map(parseRecord);
  }

  async markLocalDirty(args: {
    agentId: string;
    localEventId: string;
    localRevision: number;
    operation?: LinkedCalendarOperation;
    now?: Date;
  }): Promise<LinkedCalendarEventRecord | null> {
    const operation = args.operation ?? "update";
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_calendar.linked_calendar_events SET
        local_revision = GREATEST(local_revision, ${args.localRevision}),
        state = CASE WHEN state IN ('clean', 'dirty') THEN 'dirty' ELSE state END,
        pending_operation = CASE
          WHEN ${args.localRevision} < local_revision THEN pending_operation
          WHEN state IN ('clean', 'dirty') AND ${sqlQuote(operation)} = 'delete' THEN 'delete'
          WHEN state IN ('clean', 'dirty') AND provider_event_id IS NULL THEN 'create'
          WHEN state IN ('clean', 'dirty') THEN 'update'
          ELSE pending_operation
        END,
        updated_at = ${sqlQuote((args.now ?? new Date()).toISOString())}
       WHERE agent_id = ${sqlQuote(args.agentId)}
         AND local_event_id = ${sqlQuote(args.localEventId)}
       RETURNING *`,
    );
    return rows[0] ? parseRecord(rows[0]) : null;
  }

  async save(
    record: LinkedCalendarEventRecord,
    patch: Partial<
      Omit<
        LinkedCalendarEventRecord,
        "id" | "agentId" | "localEventId" | "createdAt"
      >
    >,
    now = new Date(),
  ): Promise<LinkedCalendarEventRecord> {
    const next = { ...record, ...patch, updatedAt: now.toISOString() };
    // Millisecond timestamps can collide; compare the checkpoint snapshot too.
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_calendar.linked_calendar_events SET
        connector_account_id = ${sqlQuote(next.connectorAccountId)},
        provider_calendar_id = ${sqlQuote(next.providerCalendarId)},
        provider_event_id = ${sqlText(next.providerEventId)},
        provider_etag = ${sqlText(next.providerEtag)},
        local_revision = ${next.localRevision},
        last_common_semantic_hash = ${sqlText(next.lastCommonSemanticHash)},
        state = ${sqlQuote(next.state)},
        pending_operation = ${sqlText(next.pendingOperation)},
        idempotency_key = ${sqlQuote(next.idempotencyKey)},
        last_error_code = ${sqlText(next.lastErrorCode)},
        last_error_message = ${sqlText(next.lastErrorMessage)},
        updated_at = ${sqlQuote(next.updatedAt)}
       WHERE id = ${sqlQuote(record.id)}
         AND updated_at = ${sqlQuote(record.updatedAt)}
         AND agent_id = ${sqlQuote(record.agentId)}
         AND local_event_id = ${sqlQuote(record.localEventId)}
         AND connector_account_id = ${sqlQuote(record.connectorAccountId)}
         AND provider_calendar_id = ${sqlQuote(record.providerCalendarId)}
         AND provider_event_id IS NOT DISTINCT FROM ${sqlText(record.providerEventId)}
         AND provider_etag IS NOT DISTINCT FROM ${sqlText(record.providerEtag)}
         AND local_revision = ${record.localRevision}
         AND last_common_semantic_hash IS NOT DISTINCT FROM ${sqlText(record.lastCommonSemanticHash)}
         AND state = ${sqlQuote(record.state)}
         AND pending_operation IS NOT DISTINCT FROM ${sqlText(record.pendingOperation)}
         AND idempotency_key = ${sqlQuote(record.idempotencyKey)}
         AND last_error_code IS NOT DISTINCT FROM ${sqlText(record.lastErrorCode)}
         AND last_error_message IS NOT DISTINCT FROM ${sqlText(record.lastErrorMessage)}
       RETURNING *`,
    );
    if (!rows[0])
      throw new Error(
        "[LinkedCalendarRepository] Concurrent checkpoint update rejected",
      );
    return parseRecord(rows[0]);
  }

  async pauseAccount(
    agentId: string,
    connectorAccountId: string,
    now = new Date(),
  ): Promise<number> {
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_calendar.linked_calendar_events SET state = 'paused', pending_operation = NULL,
       updated_at = ${sqlQuote(now.toISOString())}
       WHERE agent_id = ${sqlQuote(agentId)} AND connector_account_id = ${sqlQuote(connectorAccountId)} AND state <> 'local_only'
       RETURNING id`,
    );
    return rows.length;
  }

  async pause(
    record: LinkedCalendarEventRecord,
    now = new Date(),
  ): Promise<LinkedCalendarEventRecord> {
    return this.save(
      record,
      {
        state: record.state === "local_only" ? "local_only" : "paused",
        pendingOperation: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
      now,
    );
  }
}

/** Production provider port that reuses the account-scoped Google adapter. */
export class GoogleLinkedCalendarProviderPort
  implements LinkedCalendarProviderPort
{
  constructor(private readonly google: IGoogleWorkspaceService) {}

  async get(
    record: LinkedCalendarEventRecord,
  ): Promise<LinkedCalendarProviderSnapshot | null> {
    if (!record.providerEventId) {
      const recovered = await this.google.findEventByIdempotencyKey({
        accountId: record.connectorAccountId,
        calendarId: record.providerCalendarId,
        idempotencyKey: record.idempotencyKey,
      });
      return recovered ? linkedCalendarSnapshotFromGoogle(recovered) : null;
    }
    try {
      return linkedCalendarSnapshotFromGoogle(
        await this.google.getEvent({
          accountId: record.connectorAccountId,
          calendarId: record.providerCalendarId,
          eventId: record.providerEventId,
        }),
      );
    } catch (error) {
      const status = providerErrorStatus(error);
      // error-policy:J1 A provider 404/410 is an authoritative absent snapshot;
      // all transport and permission failures retain their error outcome.
      if (status === 404 || status === 410) return null;
      throw error;
    }
  }

  async create(
    record: LinkedCalendarEventRecord,
    event: LinkedCalendarSemanticEvent,
  ): Promise<LinkedCalendarProviderSnapshot> {
    return linkedCalendarSnapshotFromGoogle(
      await this.google.createEvent({
        accountId: record.connectorAccountId,
        calendarId: record.providerCalendarId,
        ...googleEventInput(event),
        idempotencyKey: record.idempotencyKey,
        sendUpdates: "none",
      }),
    );
  }

  async update(
    record: LinkedCalendarEventRecord,
    event: LinkedCalendarSemanticEvent,
  ): Promise<LinkedCalendarProviderSnapshot> {
    if (!record.providerEventId) {
      throw new Error("Linked Google event identity is missing for update");
    }
    return linkedCalendarSnapshotFromGoogle(
      await this.google.updateEvent({
        accountId: record.connectorAccountId,
        calendarId: record.providerCalendarId,
        eventId: record.providerEventId,
        ...googleEventInput(event),
        ...(record.providerEtag ? { expectedEtag: record.providerEtag } : {}),
        sendUpdates: "none",
      }),
    );
  }

  async delete(record: LinkedCalendarEventRecord): Promise<void> {
    if (!record.providerEventId) return;
    await this.google.deleteEvent({
      accountId: record.connectorAccountId,
      calendarId: record.providerCalendarId,
      eventId: record.providerEventId,
      ...(record.providerEtag ? { expectedEtag: record.providerEtag } : {}),
      sendUpdates: "none",
    });
  }
}

function googleEventInput(event: LinkedCalendarSemanticEvent) {
  return {
    title: event.title,
    description: event.description,
    location: event.location,
    start: event.isAllDay ? event.startAt.split("T")[0] : event.startAt,
    end: event.isAllDay ? event.endAt.split("T")[0] : event.endAt,
    ...(event.timeZone ? { timeZone: event.timeZone } : {}),
    attendees: event.attendees.map((attendee) => ({
      email: attendee.email,
      optional: attendee.optional === true,
    })),
    // The built-in Eliza calendar cannot hold recurrence, so an absent local
    // series must leave Google's RRULE untouched. Sending `[]` would make the
    // PATCH clear the provider series and delete every future occurrence.
    ...(event.recurrence?.length ? { recurrence: [...event.recurrence] } : {}),
  };
}

function providerErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    status?: unknown;
    response?: { status?: unknown };
  };
  const status = candidate.status ?? candidate.response?.status;
  return typeof status === "number" ? status : null;
}

/** Maps the stable Google DTO into the provider-neutral reconciliation shape. */
export function linkedCalendarSnapshotFromGoogle(
  event: GoogleCalendarEvent,
): LinkedCalendarProviderSnapshot {
  if (!event.start || !event.end) {
    throw new Error("Google event is missing its start or end time");
  }
  return {
    eventId: event.id,
    etag: typeof event.metadata?.etag === "string" ? event.metadata.etag : null,
    event: {
      title: event.title ?? "",
      description: event.description ?? "",
      location: event.location ?? "",
      startAt: event.start,
      endAt: event.end,
      timeZone: event.timeZone ?? null,
      isAllDay: event.isAllDay === true,
      attendees: (event.attendees ?? []).map((attendee) => ({
        email: attendee.email,
        optional: attendee.optional === true,
      })),
      ...(event.recurrence?.length
        ? { recurrence: [...event.recurrence] }
        : {}),
      deleted: event.status === "cancelled",
    },
  };
}
