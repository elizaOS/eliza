/**
 * Durable two-way reconciliation for events explicitly linked between the
 * built-in Eliza calendar and one Google calendar. The checkpoint records the
 * last common semantic hash, both provider identities, and unsafe outcomes so
 * retries never guess whether a remote write committed.
 */

import { createHash, randomUUID } from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import type {
  GoogleCalendarEvent,
  IGoogleWorkspaceService,
} from "@elizaos/plugin-google-workspace";
import {
  executeRawSql,
  sqlQuote,
  sqlText,
  toNumber,
  toText,
} from "../internal/sql.js";

export type LinkedCalendarState =
  | "clean"
  | "dirty"
  | "conflicted"
  | "quarantined"
  | "paused";

export type LinkedCalendarOperation = "create" | "update" | "delete";

export interface LinkedCalendarEventRecord {
  id: string;
  agentId: string;
  localEventId: string;
  connectorAccountId: string;
  providerCalendarId: string;
  providerEventId: string | null;
  providerEtag: string | null;
  localRevision: number;
  lastCommonSemanticHash: string | null;
  state: LinkedCalendarState;
  pendingOperation: LinkedCalendarOperation | null;
  idempotencyKey: string;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LinkedCalendarSemanticEvent {
  title: string;
  description: string;
  location: string;
  startAt: string;
  endAt: string;
  timeZone: string | null;
  attendees: ReadonlyArray<{ email: string; optional?: boolean }>;
  deleted?: boolean;
}

export interface LinkedCalendarLocalSnapshot {
  eventId: string;
  revision: number;
  event: LinkedCalendarSemanticEvent;
}

export interface LinkedCalendarProviderSnapshot {
  eventId: string;
  etag: string | null;
  event: LinkedCalendarSemanticEvent;
}

export interface LinkedCalendarProviderPort {
  get(
    record: LinkedCalendarEventRecord,
  ): Promise<LinkedCalendarProviderSnapshot | null>;
  create(
    record: LinkedCalendarEventRecord,
    event: LinkedCalendarSemanticEvent,
  ): Promise<LinkedCalendarProviderSnapshot>;
  update(
    record: LinkedCalendarEventRecord,
    event: LinkedCalendarSemanticEvent,
  ): Promise<LinkedCalendarProviderSnapshot>;
  delete(record: LinkedCalendarEventRecord): Promise<void>;
}

export interface LinkedCalendarLocalPort {
  get(eventId: string): Promise<LinkedCalendarLocalSnapshot | null>;
  applyProviderEvent(
    eventId: string,
    event: LinkedCalendarSemanticEvent,
    expectedRevision: number,
  ): Promise<LinkedCalendarLocalSnapshot>;
  delete(eventId: string, expectedRevision: number): Promise<void>;
}

export interface LinkedCalendarCheckpointStore {
  save(
    record: LinkedCalendarEventRecord,
    patch: Partial<
      Omit<
        LinkedCalendarEventRecord,
        "id" | "agentId" | "localEventId" | "createdAt"
      >
    >,
    now?: Date,
  ): Promise<LinkedCalendarEventRecord>;
}

function googleMutationFailure(error: unknown): {
  outcome: "not_accepted" | "precondition_failed";
  code: string;
  message: string;
} | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    outcome?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (
    candidate.outcome !== "not_accepted" &&
    candidate.outcome !== "precondition_failed"
  ) {
    return null;
  }
  return {
    outcome: candidate.outcome,
    code:
      typeof candidate.code === "string"
        ? candidate.code
        : "GOOGLE_CALENDAR_MUTATION_REJECTED",
    message:
      typeof candidate.message === "string"
        ? candidate.message
        : "Google Calendar rejected the mutation.",
  };
}

function parseState(value: unknown): LinkedCalendarState {
  const state = toText(value);
  if (
    ["clean", "dirty", "conflicted", "quarantined", "paused"].includes(state)
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
    providerEventId: row.provider_event_id
      ? toText(row.provider_event_id)
      : null,
    providerEtag: row.provider_etag ? toText(row.provider_etag) : null,
    localRevision: toNumber(row.local_revision),
    lastCommonSemanticHash: row.last_common_semantic_hash
      ? toText(row.last_common_semantic_hash)
      : null,
    state: parseState(row.state),
    pendingOperation: parseOperation(row.pending_operation),
    idempotencyKey: toText(row.idempotency_key),
    lastErrorCode: row.last_error_code ? toText(row.last_error_code) : null,
    lastErrorMessage: row.last_error_message
      ? toText(row.last_error_message)
      : null,
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

export function linkedCalendarSemanticHash(
  event: LinkedCalendarSemanticEvent,
): string {
  const normalized = {
    title: event.title.trim(),
    description: event.description.trim(),
    location: event.location.trim(),
    startAt: event.startAt,
    endAt: event.endAt,
    timeZone: event.timeZone,
    attendees: [...event.attendees]
      .map((attendee) => ({
        email: attendee.email.trim().toLowerCase(),
        optional: attendee.optional === true,
      }))
      .sort((left, right) => left.email.localeCompare(right.email)),
    deleted: event.deleted === true,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
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
        state = CASE WHEN app_calendar.linked_calendar_events.state = 'paused' THEN 'dirty' ELSE app_calendar.linked_calendar_events.state END,
        pending_operation = CASE
          WHEN app_calendar.linked_calendar_events.state = 'paused'
            THEN CASE WHEN app_calendar.linked_calendar_events.provider_event_id IS NULL THEN 'create' ELSE 'update' END
          ELSE app_calendar.linked_calendar_events.pending_operation
        END,
        updated_at = EXCLUDED.updated_at
      RETURNING *`,
    );
    if (!rows[0])
      throw new Error(
        "[LinkedCalendarRepository] Link creation returned no row",
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
       WHERE id = ${sqlQuote(record.id)} AND updated_at = ${sqlQuote(record.updatedAt)}
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
       WHERE agent_id = ${sqlQuote(agentId)} AND connector_account_id = ${sqlQuote(connectorAccountId)}
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
        state: "paused",
        pendingOperation: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
      now,
    );
  }
}

export type LinkedCalendarReconcileOutcome =
  | "clean"
  | "dirty"
  | "pushed"
  | "pulled"
  | "conflicted"
  | "quarantined"
  | "paused";

export class LinkedCalendarReconciler {
  constructor(
    private readonly repository: LinkedCalendarCheckpointStore,
    private readonly local: LinkedCalendarLocalPort,
    private readonly provider: LinkedCalendarProviderPort,
  ) {}

  async reconcile(
    record: LinkedCalendarEventRecord,
  ): Promise<LinkedCalendarReconcileOutcome> {
    if (record.state === "paused") return "paused";
    if (record.state === "conflicted") return "conflicted";
    if (record.state === "quarantined") return "quarantined";

    const local = await this.local.get(record.localEventId);
    if (!local) {
      if (record.pendingOperation === "delete") {
        const provider = await this.provider.get(record);
        try {
          if (provider) await this.provider.delete(record);
        } catch (error) {
          const mutationFailure = googleMutationFailure(error);
          if (mutationFailure?.outcome === "not_accepted") {
            await this.repository.save(record, {
              state: "dirty",
              pendingOperation: "delete",
              lastErrorCode: mutationFailure.code,
              lastErrorMessage: mutationFailure.message,
            });
            return "dirty";
          }
          if (mutationFailure?.outcome === "precondition_failed") {
            await this.repository.save(record, {
              state: "conflicted",
              pendingOperation: null,
              lastErrorCode: mutationFailure.code,
              lastErrorMessage: mutationFailure.message,
            });
            return "conflicted";
          }
          return this.quarantine(
            record,
            "LINKED_CALENDAR_UNKNOWN_PROVIDER_OUTCOME",
            error instanceof Error ? error.message : String(error),
          );
        }
        await this.repository.save(record, {
          state: "paused",
          pendingOperation: null,
          providerEtag: null,
          lastErrorCode: "LINKED_CALENDAR_LOCAL_EVENT_DELETED",
          lastErrorMessage:
            "The Eliza event was deleted and the linked Google event was removed.",
        });
        return "pushed";
      }
      return this.quarantine(
        record,
        "LINKED_LOCAL_EVENT_MISSING",
        "The linked Eliza event no longer exists.",
      );
    }
    const provider = await this.provider.get(record);
    const localHash = linkedCalendarSemanticHash(local.event);
    const providerHash = provider
      ? linkedCalendarSemanticHash(provider.event)
      : null;
    const localChanged = record.lastCommonSemanticHash !== localHash;
    const providerChanged =
      providerHash !== null && record.lastCommonSemanticHash !== providerHash;

    if (
      provider &&
      localChanged &&
      providerChanged &&
      localHash !== providerHash
    ) {
      await this.repository.save(record, {
        state: "conflicted",
        pendingOperation: null,
        lastErrorCode: "LINKED_CALENDAR_CONCURRENT_EDIT",
        lastErrorMessage:
          "Eliza and Google changed since their last common version.",
      });
      return "conflicted";
    }

    if (provider && providerChanged && !localChanged) {
      if (provider.event.deleted) {
        try {
          await this.local.delete(local.eventId, local.revision);
        } catch (error) {
          return this.quarantine(
            record,
            "LINKED_CALENDAR_LOCAL_DELETE_CAS_REJECTED",
            error instanceof Error ? error.message : String(error),
          );
        }
        await this.repository.save(record, {
          state: "paused",
          pendingOperation: null,
          providerEventId: provider.eventId,
          providerEtag: provider.etag,
          lastCommonSemanticHash: linkedCalendarSemanticHash(provider.event),
          lastErrorCode: "LINKED_CALENDAR_PROVIDER_EVENT_DELETED",
          lastErrorMessage:
            "Google deleted the linked event; the Eliza event was removed and the retained link was paused.",
        });
        return "pulled";
      }
      let applied: LinkedCalendarLocalSnapshot;
      try {
        applied = await this.local.applyProviderEvent(
          local.eventId,
          provider.event,
          local.revision,
        );
      } catch (error) {
        return this.quarantine(
          record,
          "LINKED_CALENDAR_LOCAL_CAS_REJECTED",
          error instanceof Error ? error.message : String(error),
        );
      }
      await this.repository.save(record, {
        localRevision: applied.revision,
        providerEventId: provider.eventId,
        providerEtag: provider.etag,
        lastCommonSemanticHash: providerHash,
        state: "clean",
        pendingOperation: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
      return "pulled";
    }

    if (!provider && record.providerEventId && !localChanged) {
      try {
        await this.local.delete(local.eventId, local.revision);
      } catch (error) {
        return this.quarantine(
          record,
          "LINKED_CALENDAR_LOCAL_DELETE_CAS_REJECTED",
          error instanceof Error ? error.message : String(error),
        );
      }
      await this.repository.save(record, {
        state: "paused",
        pendingOperation: null,
        providerEtag: null,
        lastErrorCode: "LINKED_CALENDAR_PROVIDER_EVENT_DELETED",
        lastErrorMessage:
          "Google deleted the linked event; the Eliza event was removed and the retained link was paused.",
      });
      return "pulled";
    }

    if (!provider || localChanged) {
      return this.push(record, local, provider);
    }

    if (
      record.state !== "clean" ||
      record.localRevision !== local.revision ||
      record.providerEtag !== provider.etag
    ) {
      await this.repository.save(record, {
        localRevision: local.revision,
        providerEventId: provider.eventId,
        providerEtag: provider.etag,
        lastCommonSemanticHash: localHash,
        state: "clean",
        pendingOperation: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
    }
    return "clean";
  }

  async resolveConflict(
    record: LinkedCalendarEventRecord,
    strategy: "keep_eliza" | "keep_google",
  ): Promise<LinkedCalendarReconcileOutcome> {
    if (record.state !== "conflicted") return this.reconcile(record);
    const local = await this.local.get(record.localEventId);
    if (!local) {
      return this.quarantine(
        record,
        "LINKED_LOCAL_EVENT_MISSING",
        "The linked Eliza event no longer exists.",
      );
    }
    const provider = await this.provider.get(record);
    if (!provider) {
      return this.quarantine(
        record,
        "LINKED_PROVIDER_EVENT_MISSING",
        "The linked Google event no longer exists.",
      );
    }
    if (strategy === "keep_google") {
      let applied: LinkedCalendarLocalSnapshot;
      try {
        applied = await this.local.applyProviderEvent(
          local.eventId,
          provider.event,
          local.revision,
        );
      } catch (error) {
        return this.quarantine(
          record,
          "LINKED_CALENDAR_LOCAL_CAS_REJECTED",
          error instanceof Error ? error.message : String(error),
        );
      }
      await this.repository.save(record, {
        localRevision: applied.revision,
        providerEventId: provider.eventId,
        providerEtag: provider.etag,
        lastCommonSemanticHash: linkedCalendarSemanticHash(provider.event),
        state: "clean",
        pendingOperation: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
      return "pulled";
    }
    const dirty = await this.repository.save(record, {
      state: "dirty",
      pendingOperation: "update",
      lastCommonSemanticHash: linkedCalendarSemanticHash(provider.event),
      lastErrorCode: null,
      lastErrorMessage: null,
    });
    return this.reconcile(dirty);
  }

  private async push(
    record: LinkedCalendarEventRecord,
    local: LinkedCalendarLocalSnapshot,
    provider: LinkedCalendarProviderSnapshot | null,
  ): Promise<LinkedCalendarReconcileOutcome> {
    const operation: LinkedCalendarOperation = local.event.deleted
      ? "delete"
      : provider
        ? "update"
        : "create";
    let pending = record;
    if (record.pendingOperation !== operation || record.state !== "dirty") {
      pending = await this.repository.save(record, {
        state: "dirty",
        pendingOperation: operation,
        localRevision: local.revision,
      });
    }
    try {
      if (operation === "delete") {
        if (provider) await this.provider.delete(pending);
        await this.repository.save(pending, {
          providerEventId: provider?.eventId ?? pending.providerEventId,
          providerEtag: null,
          lastCommonSemanticHash: linkedCalendarSemanticHash(local.event),
          state: "clean",
          pendingOperation: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        });
      } else {
        const written =
          operation === "create"
            ? await this.provider.create(pending, local.event)
            : await this.provider.update(pending, local.event);
        await this.repository.save(pending, {
          providerEventId: written.eventId,
          providerEtag: written.etag,
          localRevision: local.revision,
          lastCommonSemanticHash: linkedCalendarSemanticHash(written.event),
          state: "clean",
          pendingOperation: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        });
      }
      return "pushed";
    } catch (error) {
      const mutationFailure = googleMutationFailure(error);
      if (mutationFailure) {
        const state: LinkedCalendarState =
          mutationFailure.outcome === "precondition_failed"
            ? "conflicted"
            : "dirty";
        await this.repository.save(pending, {
          state,
          pendingOperation: state === "dirty" ? operation : null,
          lastErrorCode: mutationFailure.code,
          lastErrorMessage: mutationFailure.message,
        });
        return state === "conflicted" ? "conflicted" : "dirty";
      }
      return this.quarantine(
        pending,
        "LINKED_CALENDAR_UNKNOWN_PROVIDER_OUTCOME",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async quarantine(
    record: LinkedCalendarEventRecord,
    code: string,
    message: string,
  ): Promise<"quarantined"> {
    await this.repository.save(record, {
      state: "quarantined",
      lastErrorCode: code,
      lastErrorMessage: message,
    });
    return "quarantined";
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
    if (!record.providerEventId) return null;
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
    start: event.startAt,
    end: event.endAt,
    ...(event.timeZone ? { timeZone: event.timeZone } : {}),
    attendees: event.attendees.map((attendee) => ({
      email: attendee.email,
      optional: attendee.optional === true,
    })),
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
      attendees: (event.attendees ?? []).map((attendee) => ({
        email: attendee.email,
      })),
      deleted: event.status === "cancelled",
    },
  };
}
