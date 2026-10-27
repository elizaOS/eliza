/** The canonical reconciler's provider I/O over the existing owner-scoped host broker. */
import {
  type LinkedCalendarEventRecord,
  type LinkedCalendarProviderPort,
  type LinkedCalendarProviderSnapshot,
  type LinkedCalendarSemanticEvent,
  linkedCalendarSemanticText,
} from "@elizaos/contracts";
import { ElizaError } from "@elizaos/core";
import type { createManagedCalendarRead } from "./managed-calendar-read.js";

type Transport = NonNullable<ReturnType<typeof createManagedCalendarRead>>;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

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
    if (
      ["title", "description", "location", "startAt", "endAt"].some(
        (key) => typeof event[key] !== "string",
      ) ||
      !Number.isFinite(Date.parse(String(event.startAt))) ||
      !Number.isFinite(Date.parse(String(event.endAt))) ||
      Date.parse(String(event.endAt)) <= Date.parse(String(event.startAt)) ||
      typeof event.isAllDay !== "boolean" ||
      (event.timeZone !== null && typeof event.timeZone !== "string") ||
      !Array.isArray(event.attendees) ||
      event.attendees.some(
        (attendee) =>
          !object(attendee) ||
          typeof attendee.email !== "string" ||
          (attendee.optional !== undefined &&
            typeof attendee.optional !== "boolean"),
      ) ||
      (event.recurrence !== undefined &&
        (!Array.isArray(event.recurrence) ||
          event.recurrence.some((rule) => typeof rule !== "string")))
    )
      throw Error("Invalid linked Calendar semantic snapshot");
    return value as unknown as LinkedCalendarProviderSnapshot;
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
      event,
    });
    if (
      !object(result.event) ||
      result.event.visibility !== "private" ||
      result.event.remindersDisabled !== true
    )
      throw Error("Linked Calendar create privacy could not be confirmed");
    const written = this.snapshot(result.event);
    if (
      linkedCalendarSemanticText(written.event) !==
      linkedCalendarSemanticText(event)
    )
      throw Error("Linked Calendar result does not match the requested event");
    return written;
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
      event,
    });
    const written = this.snapshot(result.event, record.providerEventId);
    if (
      linkedCalendarSemanticText(written.event) !==
      linkedCalendarSemanticText(event)
    )
      throw Error("Linked Calendar result does not match the requested event");
    return written;
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
