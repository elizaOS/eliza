/** The canonical reconciler's provider I/O over the existing owner-scoped host broker. */
import {
  type LinkedCalendarEventRecord,
  type LinkedCalendarProviderPort,
  type LinkedCalendarProviderSnapshot,
  type LinkedCalendarSemanticEvent,
  linkedCalendarSemanticText,
} from "@elizaos/contracts";
import { ElizaError } from "@elizaos/core";
import { isLinkedCalendarSemanticEvent } from "./managed-calendar-host.js";
import type { createManagedCalendarRead } from "./managed-calendar-read.js";

type Transport = NonNullable<ReturnType<typeof createManagedCalendarRead>>;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const WHOLE_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Cloud sync-v1 carries all-day bounds as whole dates with no timezone; the
// reconciler and the built-in calendar carry them as UTC-midnight instants.
// The date is sent as written, as googleEventInput does.
const providerEvent = (
  event: LinkedCalendarSemanticEvent,
): LinkedCalendarSemanticEvent =>
  event.isAllDay
    ? {
        ...event,
        startAt: event.startAt.split("T")[0],
        endAt: event.endAt.split("T")[0],
        timeZone: null,
      }
    : event;
const localEvent = (
  event: LinkedCalendarSemanticEvent,
): LinkedCalendarSemanticEvent =>
  event.isAllDay &&
  WHOLE_DATE.test(event.startAt) &&
  WHOLE_DATE.test(event.endAt)
    ? {
        ...event,
        startAt: `${event.startAt}T00:00:00.000Z`,
        endAt: `${event.endAt}T00:00:00.000Z`,
      }
    : event;

export class ManagedLinkedCalendarProviderPort
  implements LinkedCalendarProviderPort
{
  constructor(
    private readonly transport: Transport,
    private readonly deleteEnabled: boolean,
  ) {}

  private async call(
    record: LinkedCalendarEventRecord,
    command: Record<string, unknown>,
  ) {
    let caps: Awaited<ReturnType<Transport["writeCapabilities"]>>;
    try {
      caps = await this.transport.writeCapabilities(
        record.connectorAccountId,
        record.providerCalendarId,
      );
    } catch (cause) {
      throw Object.assign(
        new ElizaError(
          "The linked Calendar connection could not be verified before dispatch.",
          { code: "CALENDAR_SYNC_DESTINATION_UNAVAILABLE", cause },
        ),
        { outcome: "not_accepted" },
      );
    }
    const response = await this.transport.mutation({
      operation: "linked-sync",
      grantId: record.connectorAccountId,
      calendarId: record.providerCalendarId,
      accountId: caps.accountId,
      command,
    });
    if (object(response.calendarFailure)) {
      const failure = response.calendarFailure;
      if (
        failure.grantId !== record.connectorAccountId ||
        failure.calendarId !== record.providerCalendarId ||
        failure.accountId !== caps.accountId ||
        typeof failure.code !== "string" ||
        !/^CALENDAR_SYNC_[A-Z_]{1,80}$/.test(failure.code) ||
        !["not_accepted", "precondition_failed"].includes(
          String(failure.outcome),
        )
      )
        throw Error("Invalid linked Calendar refusal");
      throw Object.assign(
        new ElizaError(
          "The linked Calendar change was refused before acceptance.",
          { code: failure.code },
        ),
        { outcome: failure.outcome },
      );
    }
    if (
      response.version !== 1 ||
      response.calendarId !== record.providerCalendarId ||
      response.providerExactlyOnce !== false
    )
      throw Error(
        "The linked Calendar response does not match the selected protocol and calendar",
      );
    return response;
  }

  private snapshot(
    value: unknown,
    expectedEventId?: string | null,
  ): LinkedCalendarProviderSnapshot {
    if (
      !object(value) ||
      typeof value.eventId !== "string" ||
      !value.eventId ||
      (expectedEventId && value.eventId !== expectedEventId) ||
      typeof value.etag !== "string" ||
      !value.etag ||
      !object(value.event)
    )
      throw Error("Invalid linked Calendar snapshot identity");
    const event = value.event;
    if (!isLinkedCalendarSemanticEvent(event))
      throw Error("Invalid linked Calendar semantic snapshot");
    return {
      eventId: value.eventId,
      etag: value.etag,
      event: localEvent(event),
    };
  }

  // A local all-day row can still hold whole dates. Compare in the instant
  // form, but checkpoint the requested form so the next pass pulls the
  // instants instead of writing the event again.
  private written(
    written: LinkedCalendarProviderSnapshot,
    event: LinkedCalendarSemanticEvent,
  ): LinkedCalendarProviderSnapshot {
    if (
      linkedCalendarSemanticText(written.event) !==
      linkedCalendarSemanticText(localEvent(event))
    )
      throw Error("Linked Calendar result does not match the requested event");
    return { ...written, event };
  }

  async get(record: LinkedCalendarEventRecord) {
    const result = await this.call(record, {
      kind: "get",
      reference: record.providerEventId
        ? { eventId: record.providerEventId }
        : { idempotencyKey: record.idempotencyKey },
    });
    return result.event === null
      ? null
      : this.snapshot(result.event, record.providerEventId);
  }

  async create(
    record: LinkedCalendarEventRecord,
    event: LinkedCalendarSemanticEvent,
  ) {
    const result = await this.call(record, {
      kind: "create",
      idempotencyKey: record.idempotencyKey,
      event: providerEvent(event),
    });
    if (
      !object(result.event) ||
      result.event.visibility !== "private" ||
      result.event.remindersDisabled !== true
    )
      throw Error("Linked Calendar create privacy could not be confirmed");
    return this.written(this.snapshot(result.event), event);
  }

  async update(
    record: LinkedCalendarEventRecord,
    event: LinkedCalendarSemanticEvent,
  ) {
    if (!record.providerEventId || !record.providerEtag)
      throw Error("Exact linked Calendar revision required");
    const result = await this.call(record, {
      kind: "update",
      eventId: record.providerEventId,
      expectedEtag: record.providerEtag,
      event: providerEvent(event),
    });
    return this.written(
      this.snapshot(result.event, record.providerEventId),
      event,
    );
  }

  async delete(record: LinkedCalendarEventRecord) {
    if (!record.providerEventId) return;
    if (!this.deleteEnabled)
      throw Object.assign(
        new ElizaError("Managed Calendar deletion is unavailable.", {
          code: "CALENDAR_SYNC_DELETE_UNAVAILABLE",
        }),
        { outcome: "not_accepted" },
      );
    if (!record.providerEtag)
      throw Error("Exact linked Calendar revision required");
    const result = await this.call(record, {
      kind: "delete",
      eventId: record.providerEventId,
      expectedEtag: record.providerEtag,
    });
    if (result.deleted !== true)
      throw Error("Linked Calendar deletion was not confirmed");
  }
}
