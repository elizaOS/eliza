import { describe, expect, test } from "bun:test";
import {
  CalendarSyncError,
  type CalendarSyncOwner,
  ManagedCalendarSyncProvider,
} from "./calendar-sync-provider";

const owner: CalendarSyncOwner = {
  organizationId: "org",
  userId: "owner",
  grantId: "google-grant",
  accountId: "google-user",
};
const event = {
  title: "Private QA",
  description: "Details",
  location: "",
  startAt: "2026-10-16T18:00:00Z",
  endAt: "2026-10-16T19:00:00Z",
  timeZone: "UTC",
  isAllDay: false,
  attendees: [],
};
function fixture() {
  const events = new Map<string, Record<string, any>>(),
    calls: Array<{ method: string; url: string; headers: Headers }> = [];
  let writes = 0,
    patches = 0,
    loss = false,
    readOnly = false,
    inaccessible = false,
    revokeAfterWrite = false,
    tokenLoads = 0,
    summaryOverride = "",
    accountId = "google-user",
    switchAfterWrite = false,
    echoOrganizer = false;
  const current = async () => ({
    connectionId: owner.grantId,
    accountId,
    accountEmail: "owner@example.invalid",
    capabilities: ["google.calendar.read", ...(readOnly ? [] : ["google.calendar.write"])],
  });
  const provider = new ManagedCalendarSyncProvider({
    current,
    async grant() {
      tokenLoads++;
      return {
        ...(await current()),
        token: "synthetic-token",
      };
    },
    request: async (input, init = {}) => {
      const url = new URL(String(input)),
        method = init.method || "GET",
        headers = new Headers(init.headers);
      calls.push({ method, url: String(url), headers });
      expect(url.origin).toBe("https://www.googleapis.com");
      expect(headers.get("authorization")).toBe("Bearer synthetic-token");
      expect(init.redirect).toBe("error");
      if (url.pathname.includes("/calendarList/"))
        return inaccessible
          ? Response.json({}, { status: 404 })
          : Response.json({
              id: "primary",
              summary: "Personal",
              summaryOverride,
              primary: true,
              accessRole: "owner",
            });
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!),
        stored = events.get(id);
      if (method === "GET")
        return inaccessible || !stored ? Response.json({}, { status: 404 }) : Response.json(stored);
      if (method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(url.searchParams.get("sendUpdates")).toBe("none");
        expect(body.visibility).toBe("private");
        expect(body.reminders).toEqual({ useDefault: false });
        if (events.has(body.id)) return Response.json({}, { status: 409 });
        writes++;
        events.set(body.id, {
          ...body,
          ...(echoOrganizer && body.attendees.length
            ? {
                attendees: [
                  {
                    email: "owner@example.invalid",
                    organizer: true,
                    self: true,
                    responseStatus: "accepted",
                  },
                  ...body.attendees,
                ],
              }
            : {}),
          etag: '"1"',
        });
        if (revokeAfterWrite) readOnly = true;
        if (switchAfterWrite) accountId = "another-google-user";
        if (loss) throw Error("Response lost after create");
        return Response.json(events.get(body.id), { status: 201 });
      }
      if (!stored) return Response.json({}, { status: 404 });
      if (headers.get("if-match") !== stored.etag) return Response.json({}, { status: 412 });
      if (method === "PUT") {
        patches++;
        const next = { ...stored, ...JSON.parse(String(init.body)), etag: '"2"' };
        events.set(id, next);
        return Response.json(next);
      }
      if (method === "DELETE") {
        events.delete(id);
        return new Response(null, { status: 204 });
      }
      throw Error("Unexpected method");
    },
  });
  return {
    tokenLoads: () => tokenLoads,
    rename: (value: string) => {
      summaryOverride = value;
    },
    echoOrganizer: () => {
      echoOrganizer = true;
    },
    switchAccountAfterWrite: () => {
      switchAfterWrite = true;
    },
    provider,
    events,
    calls,
    writes: () => writes,
    patches: () => patches,
    lose: () => {
      loss = true;
    },
    revoke: () => {
      readOnly = true;
    },
    revokeAfter: () => {
      revokeAfterWrite = true;
    },
    hideCalendar: () => {
      inaccessible = true;
    },
  };
}
describe("managed Calendar conditional provider", () => {
  test("stable create IDs recover an accepted lost response without a duplicate insert", async () => {
    const f = fixture();
    f.lose();
    await expect(f.provider.create(owner, "primary", "operation-1", event)).rejects.toMatchObject({
      outcome: "unknown",
    });
    expect(f.tokenLoads()).toBe(1);
    const recovered = await f.provider.get(owner, "primary", { idempotencyKey: "operation-1" });
    expect(recovered?.event.title).toBe(event.title);
    expect((await f.provider.create(owner, "primary", "operation-1", event)).eventId).toBe(
      recovered!.eventId,
    );
    expect(f.writes()).toBe(1);
  });
  test("a changed event is never silently reused as the successful create of old content", async () => {
    const f = fixture(),
      first = await f.provider.create(owner, "primary", "operation-1", event);
    f.events.get(first.eventId)!.summary = "Newer Google edit";
    f.events.get(first.eventId)!.etag = '"2"';
    await expect(f.provider.create(owner, "primary", "operation-1", event)).rejects.toMatchObject({
      code: "CALENDAR_SYNC_CREATE_CHANGED",
      outcome: "unknown",
    });
    await expect(
      f.provider.create(owner, "primary", "operation-1", { ...event, title: "Other content" }),
    ).rejects.toMatchObject({
      code: "CALENDAR_SYNC_CREATE_CHANGED",
      outcome: "precondition_failed",
    });
    expect(f.writes()).toBe(1);
  });
  test("Google's own organizer attendee echo does not turn an applied create into a failure", async () => {
    const f = fixture(),
      guests = { ...event, attendees: [{ email: "guest@example.invalid", optional: false }] };
    f.echoOrganizer();
    const created = await f.provider.create(owner, "primary", "organizer-echo", guests);
    expect(created.event.attendees.map((a) => a.email)).toContain("owner@example.invalid");
    expect((await f.provider.create(owner, "primary", "organizer-echo", guests)).eventId).toBe(
      created.eventId,
    );
    expect(f.writes()).toBe(1);
  });
  test("updates and deletes require the exact current provider revision", async () => {
    const f = fixture(),
      first = await f.provider.create(owner, "primary", "operation-1", event);
    f.events.get(first.eventId)!.etag = '"newer"';
    await expect(
      f.provider.update(owner, "primary", first.eventId, first.etag!, { ...event, title: "Stale" }),
    ).rejects.toMatchObject({ outcome: "precondition_failed" });
    expect(f.patches()).toBe(0);
    await expect(
      f.provider.delete(owner, "primary", first.eventId, first.etag!),
    ).rejects.toMatchObject({ outcome: "precondition_failed" });
    expect(f.events.size).toBe(1);
    const updated = await f.provider.update(owner, "primary", first.eventId, '"newer"', {
      ...event,
      title: "Reviewed edit",
    });
    expect(updated.event.title).toBe("Reviewed edit");
    await f.provider.delete(owner, "primary", first.eventId, updated.etag!);
    expect(f.events.size).toBe(0);
  });
  test("loss of Calendar access is not interpreted as an event deletion", async () => {
    const f = fixture();
    f.hideCalendar();
    await expect(f.provider.get(owner, "primary", { eventId: "missing" })).rejects.toMatchObject({
      code: "CALENDAR_SYNC_CALENDAR_UNAVAILABLE",
    });
  });
  test("a revoked write grant refuses before provider access and a mid-write revocation stays uncertain", async () => {
    const f = fixture();
    f.revoke();
    await expect(f.provider.create(owner, "primary", "key", event)).rejects.toBeInstanceOf(
      CalendarSyncError,
    );
    expect(f.calls).toHaveLength(0);
    const second = fixture();
    second.revokeAfter();
    await expect(second.provider.create(owner, "primary", "key", event)).rejects.toMatchObject({
      code: "CALENDAR_SYNC_GRANT_CHANGED",
      outcome: "unknown",
    });
    expect(second.writes()).toBe(1);
  });
  test("conditional updates preserve unedited guest and provider metadata", async () => {
    const f = fixture(),
      initial = { ...event, attendees: [{ email: "guest@example.invalid", optional: false }] };
    const first = await f.provider.create(owner, "primary", "metadata", initial),
      raw = f.events.get(first.eventId)!;
    raw.attendees[0] = {
      ...raw.attendees[0],
      responseStatus: "accepted",
      comment: "Guest response",
      displayName: "Guest",
      additionalGuests: 2,
    };
    raw.end.timeZone = "Asia/Tokyo";
    raw.conferenceData = {
      conferenceId: "retained-conference",
      entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/retained-link" }],
    };
    raw.eventLabelId = "existing-label";
    raw.visibility = "public";
    raw.reminders = { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] };
    raw.attachments = [{ fileUrl: "https://example.invalid/file", title: "Retained attachment" }];
    const guests = structuredClone(raw.attendees),
      extra = structuredClone(raw.attachments);
    const saved = await f.provider.update(owner, "primary", first.eventId, first.etag!, {
      ...initial,
      title: "Updated title",
    });
    expect(saved.event.title).toBe("Updated title");
    expect(f.events.get(first.eventId)!.attendees).toEqual(guests);
    expect(f.events.get(first.eventId)!.attachments).toEqual(extra);
    expect(f.events.get(first.eventId)!.end.timeZone).toBe("Asia/Tokyo");
    expect(f.events.get(first.eventId)!.conferenceData).toEqual(raw.conferenceData);
    expect(f.events.get(first.eventId)!.eventLabelId).toBe("existing-label");
    const write = f.calls.find((call) => call.method === "PUT");
    if (!write) throw Error("Expected a conditional provider update");
    const request = new URL(write.url);
    expect(request.searchParams.get("conferenceDataVersion")).toBe("1");
    expect(request.searchParams.get("supportsAttachments")).toBe("true");
    expect(request.searchParams.get("eventLabelVersion")).toBe("1");
    expect(saved.visibility).toBe("public");
    expect(saved.remindersDisabled).toBe(false);
    await f.provider.update(owner, "primary", first.eventId, saved.etag!, {
      ...initial,
      title: "Updated title",
      attendees: [
        { email: "guest@example.invalid", optional: true },
        { email: "new@example.invalid", optional: false },
      ],
    });
    expect(f.events.get(first.eventId)!.attendees[0]).toMatchObject({
      ...guests[0],
      optional: true,
    });
    expect(
      f.calls.filter((call) => call.method === "PUT").every((call) => call.headers.get("if-match")),
    ).toBe(true);
    const before = f.patches();
    f.events.get(first.eventId)!.attendeesOmitted = true;
    await expect(
      f.provider.update(owner, "primary", first.eventId, '"2"', { ...initial, title: "Refused" }),
    ).rejects.toMatchObject({
      code: "CALENDAR_SYNC_INCOMPLETE_ATTENDEES",
      outcome: "not_accepted",
    });
    expect(f.patches()).toBe(before);
    f.events.get(first.eventId)!.attendeesOmitted = false;
    f.events.get(first.eventId)!.unmodeledMetadata = "X".repeat(200000);
    await expect(
      f.provider.update(owner, "primary", first.eventId, '"2"', {
        ...initial,
        description: "Y".repeat(64000),
      }),
    ).rejects.toMatchObject({
      status: 413,
      code: "CALENDAR_SYNC_TOO_LARGE",
      outcome: "not_accepted",
    });
    expect(f.patches()).toBe(before);
  });
  test("wildcard preconditions, malformed dates, and conflicting references make no request", async () => {
    const f = fixture();
    await expect(f.provider.update(owner, "primary", "id", "*", event)).rejects.toMatchObject({
      outcome: "not_accepted",
    });
    await expect(
      f.provider.create(owner, "primary", "key", { ...event, endAt: event.startAt }),
    ).rejects.toMatchObject({ outcome: "not_accepted" });
    await expect(
      f.provider.create(owner, "primary", "key", {
        ...event,
        startAt: "2026-10-16T18:00:00",
        endAt: "2026-10-16T19:00:00",
      }),
    ).rejects.toMatchObject({ outcome: "not_accepted" });
    await expect(
      f.provider.create(owner, "primary", "key", {
        ...event,
        isAllDay: true,
        timeZone: null,
        startAt: "2026-02-30",
        endAt: "2026-03-04",
      }),
    ).rejects.toMatchObject({ outcome: "not_accepted" });
    await expect(
      f.provider.get(owner, "primary", { eventId: "id", idempotencyKey: "key" }),
    ).rejects.toMatchObject({ outcome: "not_accepted" });
    await expect(
      f.provider.create({ ...owner, accountId: undefined }, "primary", "key", event),
    ).rejects.toMatchObject({ outcome: "not_accepted" });
    await expect(
      f.provider.create({ ...owner, accountId: "different-google-user" }, "primary", "key", event),
    ).rejects.toMatchObject({ code: "CALENDAR_SYNC_PERMISSION", outcome: "not_accepted" });
    expect(f.calls).toHaveLength(0);
  });
  test("all-day dates and recurrence survive the provider contract", async () => {
    const capabilities = await fixture().provider.capabilities(owner, "primary");
    expect(capabilities.accountEmail).toBe("owner@example.invalid");
    expect(capabilities.calendarLabel).toBe("Personal");
    const renamed = fixture();
    renamed.rename("  My calendar  ");
    expect((await renamed.provider.capabilities(owner, "primary")).calendarLabel).toBe(
      "My calendar",
    );
    renamed.rename("  ");
    expect((await renamed.provider.capabilities(owner, "primary")).calendarLabel).toBe("Personal");
    const f = fixture(),
      saved = await f.provider.create(owner, "primary", "all-day", {
        ...event,
        isAllDay: true,
        timeZone: null,
        startAt: "2026-10-16",
        endAt: "2026-10-17",
        recurrence: ["RRULE:FREQ=DAILY"],
      });
    expect(saved.event.isAllDay).toBe(true);
    expect(saved.event.startAt).toBe("2026-10-16");
    expect(saved.event.recurrence).toEqual(["RRULE:FREQ=DAILY"]);
  });
  test("a Google identity change under the same grant stays uncertain after dispatch", async () => {
    const f = fixture();
    f.switchAccountAfterWrite();
    await expect(f.provider.create(owner, "primary", "key", event)).rejects.toMatchObject({
      outcome: "unknown",
      code: "CALENDAR_SYNC_GRANT_CHANGED",
    });
    expect(f.writes()).toBe(1);
    expect(f.tokenLoads()).toBe(1);
  });
  test("private-create receipts prove privacy and disabled reminders rather than repeating defaults", async () => {
    const f = fixture(),
      saved = await f.provider.create(owner, "primary", "key", event);
    expect(saved.visibility).toBe("private");
    expect(saved.remindersDisabled).toBe(true);
    expect(f.tokenLoads()).toBe(1);
    f.events.get(saved.eventId)!.visibility = "public";
    await expect(f.provider.create(owner, "primary", "key", event)).rejects.toMatchObject({
      code: "CALENDAR_SYNC_CREATE_CHANGED",
      outcome: "unknown",
    });
    expect(f.writes()).toBe(1);
  });
});
