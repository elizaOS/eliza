/**
 * Google event revisions through the managed Calendar connector: reads pass
 * the event etag through, and PATCH/DELETE send the caller's etag as If-Match
 * so a stale revision is refused with 412 instead of overwritten.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { logger } from "../../utils/logger";
import {
  deleteManagedGoogleCalendarEvent,
  fetchManagedGoogleCalendarFeed,
  updateManagedGoogleCalendarEvent,
} from "./calendar";
import { AgentGoogleConnectorError, managedGoogleConnectorDeps } from "./shared";

const SCOPE = {
  organizationId: "org-1",
  userId: "user-1",
  side: "owner" as const,
  calendarId: "primary",
};
const ETAG = '"3181161784712000"';
const EVENT = {
  id: "event-1",
  etag: ETAG,
  summary: "Standup",
  start: { dateTime: "2026-11-06T10:00:00.000Z" },
  end: { dateTime: "2026-11-06T10:30:00.000Z" },
};

const savedFetch = globalThis.fetch;
const savedGetToken =
  managedGoogleConnectorDeps.oauthService.getValidTokenByPlatformWithConnectionId;
const requests: Array<{ url: string; init: RequestInit }> = [];
let respond: (url: string, init: RequestInit) => Response;

beforeEach(() => {
  requests.length = 0;
  managedGoogleConnectorDeps.oauthService.getValidTokenByPlatformWithConnectionId = (async () => ({
    token: { accessToken: "test-token" },
    connectionId: "conn-1",
  })) as typeof savedGetToken;
  globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  }) as unknown as typeof fetch;
  spyOn(logger, "error").mockImplementation(() => {});
  spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  managedGoogleConnectorDeps.oauthService.getValidTokenByPlatformWithConnectionId = savedGetToken;
  mock.restore();
});

const header = (index: number, name: string) =>
  new Headers(requests[index]?.init.headers).get(name);

const preconditionFailed = () =>
  new Response(
    JSON.stringify({
      error: { code: 412, message: "Precondition Failed", status: "FAILED_PRECONDITION" },
    }),
    { status: 412 },
  );

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AgentGoogleConnectorError) return error.status;
    throw error;
  }
  throw new Error("Expected a connector error");
}

describe("Google Calendar event revisions", () => {
  test("the feed asks Google for etags and passes them through unchanged", async () => {
    respond = () =>
      new Response(
        JSON.stringify({ items: [EVENT, { ...EVENT, id: "event-2", etag: undefined }] }),
      );
    const feed = await fetchManagedGoogleCalendarFeed({
      ...SCOPE,
      timeMin: "2026-11-01T00:00:00.000Z",
      timeMax: "2026-12-01T00:00:00.000Z",
      timeZone: "UTC",
    });
    expect(new URL(requests[0].url).searchParams.get("fields")).toContain("items(id,etag,");
    expect(feed.events.map((event) => event.etag)).toEqual([ETAG, null]);
    expect(feed.events.map((event) => event.metadata.etag)).toEqual([ETAG, null]);
  });

  test("PATCH sends If-Match and returns the new revision; without it no precondition is sent", async () => {
    const next = '"3181161784799999"';
    respond = () => new Response(JSON.stringify({ ...EVENT, etag: next, summary: "Moved" }));
    const { event } = await updateManagedGoogleCalendarEvent({
      ...SCOPE,
      eventId: "event-1",
      title: "Moved",
      ifMatch: ETAG,
    });
    expect(requests[0].init.method).toBe("PATCH");
    expect(header(0, "if-match")).toBe(ETAG);
    expect(header(0, "content-type")).toBe("application/json");
    expect(event.etag).toBe(next);
    await updateManagedGoogleCalendarEvent({ ...SCOPE, eventId: "event-1", title: "Moved" });
    expect(header(1, "if-match")).toBeNull();
  });

  test("a stale revision is a 412, never a 502 outage", async () => {
    respond = preconditionFailed;
    expect(
      await statusOf(
        updateManagedGoogleCalendarEvent({
          ...SCOPE,
          eventId: "event-1",
          title: "Moved",
          ifMatch: ETAG,
        }),
      ),
    ).toBe(412);
    expect(
      await statusOf(
        deleteManagedGoogleCalendarEvent({ ...SCOPE, eventId: "event-1", ifMatch: ETAG }),
      ),
    ).toBe(412);
    expect(requests[1].init.method).toBe("DELETE");
    expect(header(1, "if-match")).toBe(ETAG);
    respond = () => new Response("boom", { status: 500 });
    expect(await statusOf(deleteManagedGoogleCalendarEvent({ ...SCOPE, eventId: "event-1" }))).toBe(
      502,
    );
    expect(header(2, "if-match")).toBeNull();
  });
});
