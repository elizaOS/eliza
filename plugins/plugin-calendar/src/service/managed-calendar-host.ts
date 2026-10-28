/** Existing managed Cloud Calendar write/readback adapter, composed with host-owned API admission.
 * No credential reads, auth/billing implementation, provider retry, transport or repository. */
import type {
  LifeOpsCalendarEvent,
  LinkedCalendarProviderSnapshot,
  LinkedCalendarSemanticEvent,
} from "@elizaos/contracts";
/** Validate the semantic event carried across the managed Calendar host boundary. */
export function isLinkedCalendarSemanticEvent(
  value: unknown,
): value is LinkedCalendarSemanticEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.title === "string" &&
    typeof event.description === "string" &&
    typeof event.location === "string" &&
    typeof event.startAt === "string" &&
    Number.isFinite(Date.parse(event.startAt)) &&
    typeof event.endAt === "string" &&
    Number.isFinite(Date.parse(event.endAt)) &&
    Date.parse(event.endAt) > Date.parse(event.startAt) &&
    (event.timeZone === null || typeof event.timeZone === "string") &&
    typeof event.isAllDay === "boolean" &&
    Array.isArray(event.attendees) &&
    event.attendees.every((attendee: unknown) => {
      if (!attendee || typeof attendee !== "object" || Array.isArray(attendee))
        return false;
      const item = attendee as Record<string, unknown>;
      return (
        typeof item.email === "string" &&
        (item.optional === undefined || typeof item.optional === "boolean")
      );
    }) &&
    (event.recurrence === undefined ||
      (Array.isArray(event.recurrence) &&
        event.recurrence.every((rule: unknown) => typeof rule === "string"))) &&
    (event.deleted === undefined || typeof event.deleted === "boolean")
  );
}

export type CalendarSyncSelection = {
  grantId: string;
  calendarId: string;
  accountId: string;
};
export type CalendarSyncRequest =
  | {
      kind: "capabilities";
      selection: Omit<CalendarSyncSelection, "accountId">;
    }
  | {
      kind: "get";
      selection: CalendarSyncSelection;
      reference: { eventId: string } | { idempotencyKey: string };
    }
  | {
      kind: "create";
      selection: CalendarSyncSelection;
      idempotencyKey: string;
      event: LinkedCalendarSemanticEvent;
    }
  | {
      kind: "update";
      selection: CalendarSyncSelection;
      eventId: string;
      expectedEtag: string;
      event: LinkedCalendarSemanticEvent;
    }
  | {
      kind: "delete";
      selection: CalendarSyncSelection;
      eventId: string;
      expectedEtag: string;
    };

export interface ManagedCalendarHostApi {
  googleCalendarSync(
    input: CalendarSyncRequest,
    signal: AbortSignal,
  ): Promise<unknown>;
  googleCalendarFeed(
    grantId: string,
    calendarId: string,
    range: { timeMin: string; timeMax: string; timeZone: string },
    signal: AbortSignal,
  ): Promise<{
    syncedAt: string;
    events: ReadonlyArray<
      Pick<
        LifeOpsCalendarEvent,
        | "externalId"
        | "title"
        | "description"
        | "location"
        | "isAllDay"
        | "startAt"
        | "endAt"
        | "metadata"
      > & {
        attendees: readonly { email?: string | null; optional?: boolean }[];
      }
    >;
  }>;
}
/** Compatibility shape for explicit Cloud sync-v1 HTTP refusal, never a generic retry signal. */
type CloudProtocolError = {
  name?: string;
  code?: string;
  status?: number;
  data?: unknown;
};
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw Error("Invalid Calendar operation");
  return v as Record<string, unknown>;
};
/** Only an explicit rejection of the mutation request itself may cross as retryable. */
export class CalendarAgentWriteRefused extends Error {
  readonly refusal: {
    code: string;
    outcome: "not_accepted" | "precondition_failed";
    grantId: string;
    calendarId: string;
    accountId: string;
  };
  constructor(refusal: CalendarAgentWriteRefused["refusal"]) {
    super("Calendar change was refused before acceptance.");
    this.refusal = refusal;
  }
}
export async function calendarAgentWrite(
  client: ManagedCalendarHostApi,
  grantId: string,
  scope: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
  sourceNamespace = "google",
) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(sourceNamespace))
    throw Error("Invalid Calendar source namespace");
  const source = `${sourceNamespace}:${scope}`;
  const allowed =
    input.operation === "write-capabilities"
      ? ["operation", "grantId", "calendarId"]
      : input.operation === "write-target"
        ? ["operation", "grantId", "calendarId", "eventId"]
        : input.operation === "linked-sync"
          ? ["operation", "grantId", "calendarId", "accountId", "command"]
          : [
              "operation",
              "grantId",
              "calendarId",
              "accountId",
              "payload",
              "preflight",
            ];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw Error("Unsupported Calendar operation field");
  if (
    input.grantId !== source ||
    typeof input.calendarId !== "string" ||
    !input.calendarId
  )
    throw Error("Calendar source changed");
  const calendarId = input.calendarId;
  const selection = { grantId, calendarId };
  const caps = record(
    await client.googleCalendarSync(
      { kind: "capabilities", selection },
      signal,
    ),
  );
  if (
    caps.version !== 1 ||
    caps.calendarId !== input.calendarId ||
    typeof caps.accountId !== "string" ||
    caps.read !== true ||
    caps.write !== true ||
    caps.idempotentCreate !== true ||
    caps.conditionalWrites !== true ||
    caps.providerExactlyOnce !== false
  )
    throw Error("Calendar write access is unavailable");
  if (input.operation === "write-capabilities")
    return { ...caps, grantId: source };
  const accountId = caps.accountId;
  const selected = { ...selection, accountId };
  const write = async (command: CalendarSyncRequest) => {
    try {
      return await client.googleCalendarSync(command, signal);
    } catch (error) {
      const failure = error as CloudProtocolError | null;
      if (
        failure?.name === "CloudProtocolError" &&
        failure.code === "http" &&
        [400, 403, 409, 412, 413, 429].includes(failure.status || 0)
      ) {
        const data = failure.data as Record<string, unknown> | undefined;
        if (
          data &&
          typeof data.code === "string" &&
          /^CALENDAR_SYNC_[A-Z_]{1,80}$/.test(data.code) &&
          (data.outcome === "not_accepted" ||
            data.outcome === "precondition_failed")
        )
          throw new CalendarAgentWriteRefused({
            code: data.code,
            outcome: data.outcome,
            grantId: source,
            calendarId,
            accountId,
          });
      }
      throw error;
    }
  };
  if (input.operation === "linked-sync") {
    if (input.accountId !== caps.accountId)
      throw Error("Calendar account changed");
    const command = record(input.command);
    const fields =
      command.kind === "get"
        ? ["kind", "reference"]
        : command.kind === "create"
          ? ["kind", "idempotencyKey", "event"]
          : command.kind === "update"
            ? ["kind", "eventId", "expectedEtag", "event"]
            : command.kind === "delete"
              ? ["kind", "eventId", "expectedEtag"]
              : [];
    if (
      !fields.length ||
      Object.keys(command).some((key) => !fields.includes(key))
    )
      throw Error("Unsupported linked Calendar command");
    const exact = (value: unknown): value is string =>
      typeof value === "string" && value.length > 0;
    let bound: CalendarSyncRequest;
    if (command.kind === "get") {
      const reference = record(command.reference);
      const keys = Object.keys(reference);
      if (
        keys.length !== 1 ||
        !["eventId", "idempotencyKey"].includes(keys[0]) ||
        !exact(reference[keys[0]])
      )
        throw Error("Exact linked Calendar reference required");
      return client.googleCalendarSync(
        {
          kind: "get",
          selection: selected,
          reference: reference as
            | { eventId: string }
            | { idempotencyKey: string },
        },
        signal,
      );
    }
    if (command.kind === "create") {
      if (!isLinkedCalendarSemanticEvent(command.event))
        throw Error("Invalid linked Calendar semantic event");
      if (!exact(command.idempotencyKey))
        throw Error("Stable linked Calendar operation key required");
      bound = {
        kind: "create",
        selection: selected,
        idempotencyKey: command.idempotencyKey,
        event: command.event,
      };
    } else {
      if (!exact(command.eventId) || !exact(command.expectedEtag))
        throw Error("Exact linked Calendar revision required");
      if (command.kind === "update") {
        if (!isLinkedCalendarSemanticEvent(command.event))
          throw Error("Invalid linked Calendar semantic event");
        bound = {
          kind: "update",
          selection: selected,
          eventId: command.eventId,
          expectedEtag: command.expectedEtag,
          event: command.event,
        };
      } else {
        bound = {
          kind: "delete",
          selection: selected,
          eventId: command.eventId,
          expectedEtag: command.expectedEtag,
        };
      }
    }
    return write(bound);
  }
  const external = (id: unknown) => {
    if (
      typeof id !== "string" ||
      !id ||
      id.length > 1024 ||
      /[\s\p{Cc}]/u.test(id)
    )
      throw Error("Calendar target changed");
    if (id.startsWith(sourceNamespace + ":")) {
      if (!id.startsWith(source + ":") || !id.slice(source.length + 1))
        throw Error("Calendar source changed");
      return id.slice(source.length + 1);
    }
    return id;
  };
  const get = async (eventId: string) =>
    record(
      await client.googleCalendarSync(
        { kind: "get", selection: selected, reference: { eventId } },
        signal,
      ),
    );
  async function materialize(snapshot: LinkedCalendarProviderSnapshot) {
    const semantic = snapshot.event;
    if (
      typeof snapshot.eventId !== "string" ||
      typeof snapshot.etag !== "string" ||
      !snapshot.etag
    )
      throw Error("Calendar revision is missing");
    const start = Date.parse(semantic.startAt),
      end = Date.parse(semantic.endAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      throw Error("Calendar times are invalid");
    const feed = await client.googleCalendarFeed(
      grantId,
      calendarId,
      {
        timeMin: new Date(start - 1000).toISOString(),
        timeMax: new Date(end + 1000).toISOString(),
        timeZone: semantic.timeZone || "UTC",
      },
      signal,
    );
    const event = feed.events.find(
      (row) => row.externalId === snapshot.eventId,
    );
    const attendees = (
      value: readonly { email?: string | null; optional?: boolean }[],
    ) =>
      JSON.stringify(
        value
          .map((a) => ({
            email: (a.email ?? "").toLowerCase(),
            optional: a.optional === true,
          }))
          .sort((a, b) => a.email.localeCompare(b.email)),
      );
    if (
      !event ||
      (event.metadata.etag !== undefined &&
        event.metadata.etag !== null &&
        event.metadata.etag !== snapshot.etag) ||
      event.title !== semantic.title ||
      event.description !== semantic.description ||
      event.location !== semantic.location ||
      event.isAllDay !== semantic.isAllDay ||
      Date.parse(event.startAt) !== Date.parse(semantic.startAt) ||
      Date.parse(event.endAt) !== Date.parse(semantic.endAt) ||
      attendees(event.attendees) !== attendees(semantic.attendees)
    )
      throw Error("The exact Calendar revision could not be read back");
    return {
      ...event,
      metadata: { ...event.metadata, etag: snapshot.etag },
      ...(semantic.recurrence ? { recurrence: semantic.recurrence } : {}),
      id: `${source}:${event.externalId}`,
      agentId: "",
      provider: "google",
      side: "owner",
      grantId: source,
      connectorAccountId: source,
      syncedAt: feed.syncedAt,
      updatedAt:
        typeof event.metadata.updated === "string"
          ? event.metadata.updated
          : feed.syncedAt,
    };
  }
  if (input.operation === "write-target") {
    const data = await get(external(input.eventId));
    if (data.event === null) throw Error("Calendar event is unavailable");
    return {
      event: await materialize(
        record(data.event) as unknown as LinkedCalendarProviderSnapshot,
      ),
    };
  }
  if (input.operation !== "write-execute" || input.accountId !== caps.accountId)
    throw Error("Calendar account changed");
  const payload = record(input.payload),
    preflight = record(input.preflight);
  if (
    payload.grantId !== source ||
    payload.calendarId !== input.calendarId ||
    payload.side !== "owner" ||
    payload.notifyAttendees === true ||
    payload.sourceNote ||
    payload.travelBuffer
  )
    throw Error("Review this Calendar change in the Calendar editor");
  if (payload.recurrenceScope && payload.recurrenceScope !== "instance")
    throw Error("Review the entire recurring series in Calendar");
  let prior: (LinkedCalendarProviderSnapshot & { etag: string }) | null = null;
  if (payload.action !== "schedule_event") {
    const id = external(payload.eventId);
    if (
      id !== preflight.providerEventId ||
      typeof preflight.providerVersion !== "string" ||
      preflight.providerVersion !== payload.expectedProviderVersion
    )
      throw Error("Calendar revision changed");
    const data = await get(id);
    if (data.event === null) throw Error("Calendar target disappeared");
    prior = record(data.event) as unknown as LinkedCalendarProviderSnapshot & {
      etag: string;
    };
    if (prior.etag !== preflight.providerVersion)
      throw Error("Calendar revision changed");
  }
  if (payload.action === "cancel_event") {
    if (
      !prior ||
      !["organizer_cancel", "remove_private_copy"].includes(
        String(payload.cancellationMode),
      )
    )
      throw Error("This cancellation needs Calendar review");
    const event = await materialize(prior);
    const result = record(
      await write({
        kind: "delete",
        selection: selected,
        eventId: prior.eventId,
        expectedEtag: prior.etag,
      }),
    );
    if (result.deleted !== true)
      throw Error("Calendar deletion was not confirmed");
    if ((await get(prior.eventId)).event !== null)
      throw Error("Calendar event is still present");
    return { event };
  }
  const old = prior?.event ?? null,
    patch = (
      payload.action === "schedule_event" ? payload : record(payload.patch)
    ) as Partial<LinkedCalendarSemanticEvent> & {
      allDay?: { startDate: string; endDateExclusive: string } | null;
      startsAtMs?: number;
      endsAtMs?: number;
    };
  const allDay = patch.allDay ?? null;
  const changed = <K extends keyof LinkedCalendarSemanticEvent>(
    key: K,
    fallback: LinkedCalendarSemanticEvent[K] | undefined,
  ) =>
    patch[key] === null || patch[key] === undefined ? fallback : patch[key];
  const attendees = changed("attendees", old?.attendees ?? []);
  if (!Array.isArray(attendees)) throw Error("Invalid attendees");
  if (attendees.some((a) => typeof a !== "string" && a.displayName))
    throw Error("Named attendees require Calendar editor review");
  const event = {
    title: changed("title", old?.title),
    description: changed("description", old?.description ?? ""),
    location: changed("location", old?.location ?? ""),
    startAt: allDay
      ? allDay.startDate
      : patch.startsAtMs != null
        ? new Date(patch.startsAtMs).toISOString()
        : old?.startAt,
    endAt: allDay
      ? allDay.endDateExclusive
      : patch.endsAtMs != null
        ? new Date(patch.endsAtMs).toISOString()
        : old?.endAt,
    isAllDay: allDay
      ? true
      : patch.startsAtMs != null || patch.endsAtMs != null
        ? false
        : (old?.isAllDay ?? false),
    timeZone: allDay ? null : changed("timeZone", old?.timeZone ?? "UTC"),
    attendees: attendees.map((a) =>
      typeof a === "string"
        ? { email: a, optional: false }
        : { email: a.email, optional: a.optional === true },
    ),
    recurrence: changed("recurrence", old?.recurrence ?? []),
  } as LinkedCalendarSemanticEvent;
  let command: CalendarSyncRequest;
  if (payload.action === "schedule_event") {
    if (
      typeof preflight.idempotencyKey !== "string" ||
      !preflight.idempotencyKey
    )
      throw Error("Stable Calendar operation key required");
    command = {
      kind: "create",
      selection: selected,
      idempotencyKey: preflight.idempotencyKey,
      event,
    };
  } else if (payload.action === "modify_event" && prior)
    command = {
      kind: "update",
      selection: selected,
      eventId: prior.eventId,
      expectedEtag: prior.etag,
      event,
    };
  else throw Error("Unsupported Calendar change");
  const result = record(await write(command)),
    snapshot = record(result.event),
    written = record(snapshot.event);
  const list = (value: unknown) => (Array.isArray(value) ? value : []);
  const guests = (value: unknown) =>
    JSON.stringify(
      list(value)
        .map((a) => ({
          email: String(a.email).toLowerCase(),
          optional: a.optional === true,
        }))
        .sort((a, b) => a.email.localeCompare(b.email)),
    );
  if (
    ["title", "description", "location", "isAllDay", "timeZone"].some(
      (key) => written[key] !== event[key as keyof typeof event],
    ) ||
    Date.parse(String(written.startAt)) !== Date.parse(event.startAt) ||
    Date.parse(String(written.endAt)) !== Date.parse(event.endAt) ||
    guests(written.attendees) !== guests(event.attendees) ||
    JSON.stringify(list(written.recurrence).sort()) !==
      JSON.stringify(list(event.recurrence).sort())
  )
    throw Error("Calendar result does not match the approved change");
  return {
    event: await materialize(
      snapshot as unknown as LinkedCalendarProviderSnapshot,
    ),
  };
}
