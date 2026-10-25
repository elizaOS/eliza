import { expect, test } from "bun:test";
import { CalendarSyncError } from "./calendar-sync-provider";
import { createCalendarSyncRoutes } from "./calendar-sync-routes";

const grant = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  let allowed = true;
  const event = {
    title: "QA",
    description: "",
    location: "",
    startAt: "2026-10-16T18:00:00Z",
    endAt: "2026-10-16T19:00:00Z",
    timeZone: "UTC",
    isAllDay: false,
    attendees: [],
  };
  const provider = {
    async capabilities(...args: unknown[]) {
      calls.push({ op: "capabilities", args });
      return {
        version: 1,
        calendarId: "primary",
        accountId: "google-user",
        read: true,
        write: true,
        idempotentCreate: true,
        conditionalWrites: true,
        providerExactlyOnce: false,
      };
    },
    async get(...args: unknown[]) {
      calls.push({ op: "get", args });
      return null;
    },
    async create(...args: unknown[]) {
      calls.push({ op: "create", args });
      return {
        eventId: "accepted",
        etag: '"1"',
        event,
        visibility: "private" as const,
        remindersDisabled: true,
      };
    },
    async update(...args: unknown[]) {
      calls.push({ op: "update", args });
      throw new CalendarSyncError(
        412,
        "CALENDAR_SYNC_PRECONDITION",
        "precondition_failed",
        "The event changed.",
      );
    },
    async delete(...args: unknown[]) {
      calls.push({ op: "delete", args });
      return { deleted: true as const };
    },
  };
  const app = createCalendarSyncRoutes({
    provider,
    async authenticate() {
      if (!allowed)
        throw new CalendarSyncError(
          403,
          "OWNER_REQUIRED",
          "not_accepted",
          "Owner access required.",
        );
      return { organizationId: "owner-org", userId: "owner-user" };
    },
  });
  const json = (value: unknown) => ({
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  return {
    app,
    calls,
    json,
    deny: () => {
      allowed = false;
    },
  };
}
test("Calendar routes pin authenticated owner fields and reject an injected agent or owner", async () => {
  const f = fixture();
  const result = await f.app.request("/event", {
    method: "POST",
    ...f.json({
      grantId: grant,
      accountId: "google-user",
      calendarId: "primary",
      idempotencyKey: "operation-1",
      event: { title: "QA" },
    }),
  });
  expect(result.status).toBe(201);
  expect(f.calls[0].args[0]).toMatchObject({
    organizationId: "owner-org",
    userId: "owner-user",
    grantId: grant,
    accountId: "google-user",
  });
  expect(JSON.stringify(await result.json())).not.toContain("token");
  for (const extra of [
    { side: "agent" },
    { userId: "other" },
    { organizationId: "other" },
    { url: "https://elsewhere.invalid" },
  ])
    expect(
      (
        await f.app.request("/event", {
          method: "POST",
          ...f.json({
            grantId: grant,
            accountId: "google-user",
            calendarId: "primary",
            idempotencyKey: "operation-2",
            event: {},
            ...extra,
          }),
        })
      ).status,
    ).toBe(400);
  expect(f.calls).toHaveLength(1);
});
test("authentication, missing fields, duplicate query and payload size fail before the provider", async () => {
  const f = fixture();
  f.deny();
  expect((await f.app.request("/event", { method: "POST", ...f.json({}) })).status).toBe(403);
  expect(f.calls).toHaveLength(0);
  const valid = fixture();
  for (const body of [
    { grantId: grant, accountId: "google-user", calendarId: "primary", idempotencyKey: "key" },
    { grantId: "bad", calendarId: "primary", idempotencyKey: "key", event: {} },
  ])
    expect(
      (await valid.app.request("/event", { method: "POST", ...valid.json(body) })).status,
    ).toBe(400);
  expect(
    (
      await valid.app.request(
        "/event?grantId=" +
          grant +
          "&grantId=" +
          grant +
          "&calendarId=primary&accountId=google-user&eventId=id",
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await valid.app.request("/event", {
        method: "POST",
        ...valid.json({
          grantId: grant,
          accountId: "google-user",
          calendarId: "primary",
          idempotencyKey: "key",
          event: { description: "x".repeat(256 * 1024) },
        }),
      })
    ).status,
  ).toBe(413);
  expect(valid.calls).toHaveLength(0);
});
test("conditional conflicts remain explicit and delete requires its own exact precondition", async () => {
  const f = fixture(),
    result = await f.app.request("/event", {
      method: "PATCH",
      ...f.json({
        grantId: grant,
        accountId: "google-user",
        calendarId: "primary",
        eventId: "id",
        expectedEtag: '"old"',
        event: {},
      }),
    });
  expect(result.status).toBe(412);
  expect(await result.json()).toMatchObject({ outcome: "precondition_failed" });
  expect(
    (
      await f.app.request(
        "/event?grantId=" + grant + "&calendarId=primary&accountId=google-user&eventId=id",
        {
          method: "DELETE",
        },
      )
    ).status,
  ).toBe(400);
  const deleted = await f.app.request(
    "/event?" +
      new URLSearchParams({
        grantId: grant,
        accountId: "google-user",
        calendarId: "primary",
        eventId: "id",
        expectedEtag: '"current"',
      }),
    { method: "DELETE" },
  );
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toMatchObject({ deleted: true, providerExactlyOnce: false });
});

test("DELETE accepts a zero-byte transport body but refuses any actual body", async () => {
  const url =
    "/event?" +
    new URLSearchParams({
      grantId: grant,
      accountId: "google-user",
      calendarId: "primary",
      eventId: "id",
      expectedEtag: '"current"',
    });
  const empty = fixture();
  const accepted = await empty.app.request(url, { method: "DELETE", body: "" });
  expect(accepted.status).toBe(200);
  expect(empty.calls.filter((c) => c.op === "delete")).toHaveLength(1);
  for (const body of [" ", "{}"]) {
    const f = fixture();
    expect((await f.app.request(url, { method: "DELETE", body })).status).toBe(400);
    expect(f.calls).toHaveLength(0);
  }
});
