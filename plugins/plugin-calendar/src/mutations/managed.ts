/** Owner-scoped Cloud writes through the existing private host transport. */
import type { LifeOpsCalendarEvent } from "@elizaos/contracts";
import type { ApprovalPayload } from "@elizaos/plugin-assistant";
import { createManagedCalendarRead } from "../service/managed-calendar-read.js";
import {
  calendarMutationApprovalSha256,
  calendarMutationOperationKey,
} from "./ledger.js";
import {
  MANAGED_CALENDAR_DELETE_UNAVAILABLE,
  managedCalendarDeleteEnabled,
} from "./managed-gate.js";
import {
  CalendarMutationNotAcceptedError,
  type CalendarMutationPort,
  type CalendarMutationPreflight,
  CalendarMutationPreflightError,
} from "./types.js";

type Payload = Extract<
  ApprovalPayload,
  { action: "schedule_event" | "modify_event" | "cancel_event" }
>;
const scoped = (v: unknown): v is string =>
  typeof v === "string" && /^alpha-google:[a-f0-9]{64}$/.test(v);

const deleteUnavailable = () =>
  new CalendarMutationPreflightError(
    MANAGED_CALENDAR_DELETE_UNAVAILABLE,
    "Deleting events from the managed Google Calendar is not available on this device yet. Nothing was changed.",
    { retryable: false },
  );
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw Error("Invalid managed Calendar response");
  return v as Record<string, unknown>;
}
export function createManagedCalendarMutationPort(
  env: NodeJS.ProcessEnv,
  request: typeof fetch,
  agentId: string,
) {
  const transport = createManagedCalendarRead(env, request);
  if (!transport) return;
  const call = transport.mutation;
  const capabilities = transport.writeCapabilities;
  async function target(grantId: string, calendarId: string, eventId: string) {
    const raw = object(
      await call({ operation: "write-target", grantId, calendarId, eventId }),
    );
    const event = object(raw.event);
    if (
      event.grantId !== grantId ||
      event.calendarId !== calendarId ||
      event.side !== "owner" ||
      event.provider !== "google" ||
      (event.id !== eventId && event.externalId !== eventId) ||
      typeof event.externalId !== "string" ||
      typeof event.startAt !== "string" ||
      typeof event.endAt !== "string" ||
      !Array.isArray(event.attendees) ||
      !event.metadata
    )
      throw Error("Calendar target changed");
    return { ...event, agentId } as unknown as LifeOpsCalendarEvent;
  }
  const port: CalendarMutationPort = {
    async preflight(approval) {
      const p = approval.payload as Payload;
      if (
        !["schedule_event", "modify_event", "cancel_event"].includes(
          p.action,
        ) ||
        p.side !== "owner" ||
        !scoped(p.grantId)
      )
        throw new CalendarMutationPreflightError(
          "CALENDAR_MANAGED_SOURCE_REQUIRED",
          "Choose the exact owner Calendar",
        );
      if (p.action === "cancel_event" && !managedCalendarDeleteEnabled(env))
        throw deleteUnavailable();
      if (
        p.action !== "schedule_event" &&
        p.recurrenceScope &&
        p.recurrenceScope !== "instance"
      )
        throw new CalendarMutationPreflightError(
          "CALENDAR_MANAGED_SERIES_REVIEW_REQUIRED",
          "Review recurring-series changes in Calendar",
        );
      if (
        p.notifyAttendees === true ||
        (p.action === "schedule_event" && (p.sourceNote || p.travelBuffer)) ||
        (p.action === "cancel_event" &&
          p.cancellationMode === "decline_invitation")
      )
        throw new CalendarMutationPreflightError(
          "CALENDAR_MANAGED_EDITOR_REQUIRED",
          "Review these Calendar options in the editor",
        );
      const guests =
        p.action === "schedule_event"
          ? p.attendees
          : p.action === "modify_event"
            ? p.patch.attendees
            : [];
      if (guests?.some((a) => typeof a !== "string" && a.displayName))
        throw new CalendarMutationPreflightError(
          "CALENDAR_MANAGED_EDITOR_REQUIRED",
          "Review named attendees in the Calendar editor",
        );
      const caps = await capabilities(p.grantId, p.calendarId);
      const event =
        p.action === "schedule_event"
          ? null
          : await target(p.grantId, p.calendarId, p.eventId);
      const etag = event?.metadata.etag;
      if (
        event &&
        p.action !== "schedule_event" &&
        (!etag || etag !== p.expectedProviderVersion)
      )
        throw new CalendarMutationPreflightError(
          "CALENDAR_MANAGED_TARGET_CHANGED",
          "The Calendar event changed after review",
        );
      return {
        operation: p.action,
        provider: "google",
        sourceId: p.grantId,
        calendarId: p.calendarId,
        event,
        providerEventId: event?.externalId ?? null,
        providerVersion: typeof etag === "string" ? etag : null,
        idempotencyKey:
          p.action === "schedule_event"
            ? calendarMutationOperationKey(
                calendarMutationApprovalSha256(approval),
              )
            : null,
        recurrenceScope:
          p.action === "schedule_event" ? null : (p.recurrenceScope ?? null),
        cancellationMode:
          p.action === "cancel_event" ? (p.cancellationMode ?? null) : null,
        managedAccountId: caps.accountId,
      } as CalendarMutationPreflight;
    },
    async execute(approval, preflight) {
      const p = approval.payload as Payload;
      if (p.action === "cancel_event" && !managedCalendarDeleteEnabled(env))
        throw deleteUnavailable();
      // Nothing has been sent to the provider yet, so a failure here is a
      // definite non-acceptance rather than an unknown provider outcome.
      let caps: Awaited<ReturnType<typeof capabilities>>;
      try {
        caps = await capabilities(preflight.sourceId, preflight.calendarId);
      } catch (error) {
        throw new CalendarMutationNotAcceptedError(
          "CALENDAR_MANAGED_WRITE_UNAVAILABLE",
          "Calendar write access could not be verified. Nothing was changed.",
          undefined,
          error,
        );
      }
      if (caps.accountId !== preflight.managedAccountId)
        throw new CalendarMutationPreflightError(
          "CALENDAR_MANAGED_ACCOUNT_CHANGED",
          "Calendar account changed after review. Nothing was changed.",
          { retryable: false },
        );
      const raw = object(
        await call({
          operation: "write-execute",
          grantId: preflight.sourceId,
          calendarId: preflight.calendarId,
          accountId: caps.accountId,
          payload: p,
          preflight: {
            providerEventId: preflight.providerEventId,
            providerVersion: preflight.providerVersion,
            idempotencyKey: preflight.idempotencyKey,
          },
        }),
      );
      if (raw.calendarFailure) {
        const f = object(raw.calendarFailure);
        if (
          f.grantId !== preflight.sourceId ||
          f.calendarId !== preflight.calendarId ||
          f.accountId !== caps.accountId ||
          typeof f.code !== "string" ||
          !/^CALENDAR_SYNC_[A-Z_]{1,80}$/.test(f.code) ||
          !["not_accepted", "precondition_failed"].includes(String(f.outcome))
        )
          throw Error("Invalid Calendar rejection receipt");
        throw new CalendarMutationNotAcceptedError(
          f.code,
          "Calendar change was refused before acceptance.",
          { outcome: f.outcome },
        );
      }
      const e = object(raw.event);
      if (
        e.grantId !== preflight.sourceId ||
        e.calendarId !== preflight.calendarId ||
        e.provider !== "google" ||
        e.side !== "owner" ||
        typeof e.id !== "string" ||
        typeof e.externalId !== "string"
      )
        throw Error("Calendar mutation returned a mismatched receipt");
      const event = { ...e, agentId } as unknown as LifeOpsCalendarEvent;
      return {
        operation: p.action,
        provider: "google",
        sourceId: preflight.sourceId,
        calendarId: preflight.calendarId,
        eventId: event.id,
        providerEventId: event.externalId,
        providerVersion:
          typeof event.metadata.etag === "string" ? event.metadata.etag : null,
        readBackAvailable: true,
        accessLevel: "readable",
        eventSnapshot: event,
        recurrenceScope: preflight.recurrenceScope,
        cancellationMode: preflight.cancellationMode,
        acceptedAt: new Date().toISOString(),
      };
    },
  };
  return { port, capabilities, target, owns: scoped };
}
