// Pins the fail-closed contract of the managed Google Calendar connector: a
// genuinely-empty Google response (2xx with no `items`) yields an empty feed,
// while every internal failure (Google 4xx/5xx, transport error, partial event
// payload) throws an AgentGoogleConnectorError so the route boundary surfaces a
// 4xx/5xx instead of masking a broken pipeline as "no events" / "deleted".
// Deterministic: the real exported functions run through the real googleFetch
// fail-closed wrapper, with the OAuth token layer stubbed and global fetch
// mocked (no source edit was needed — this file locks the current behavior).
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { logger } from "../../utils/logger";
import {
  createManagedGoogleCalendarEvent,
  deleteManagedGoogleCalendarEvent,
  fetchManagedGoogleCalendarFeed,
  listManagedGoogleCalendars,
} from "./calendar";
import { AgentGoogleConnectorError, managedGoogleConnectorDeps } from "./shared";

const BASE_ARGS = {
  organizationId: "org-1",
  userId: "user-1",
  side: "owner" as const,
  calendarId: "primary",
};

const FEED_ARGS = {
  ...BASE_ARGS,
  timeMin: "2026-01-01T00:00:00.000Z",
  timeMax: "2026-02-01T00:00:00.000Z",
  timeZone: "UTC",
};

const VALID_EVENT = {
  id: "evt-1",
  status: "confirmed",
  summary: "Standup",
  start: { dateTime: "2026-01-05T09:00:00.000Z" },
  end: { dateTime: "2026-01-05T09:30:00.000Z" },
};

const savedFetch = globalThis.fetch;
const savedGetToken =
  managedGoogleConnectorDeps.oauthService.getValidTokenByPlatformWithConnectionId;

function installFetch(handler: () => Response | Promise<Response>) {
  globalThis.fetch = mock(async () => handler()) as typeof fetch;
}

beforeEach(() => {
  // Stub only the token lookup so the real googleFetch fail-closed path runs
  // against a mocked upstream; this is not the code under test.
  managedGoogleConnectorDeps.oauthService.getValidTokenByPlatformWithConnectionId = (async () => ({
    token: { accessToken: "test-token" },
    connectionId: "conn-1",
  })) as typeof savedGetToken;
  spyOn(logger, "error").mockImplementation(() => {});
  spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  managedGoogleConnectorDeps.oauthService.getValidTokenByPlatformWithConnectionId = savedGetToken;
  mock.restore();
});

describe("designed-empty responses stay distinct from failure", () => {
  test("feed: 200 with no items -> empty events, not a throw", async () => {
    installFetch(() => new Response(JSON.stringify({}), { status: 200 }));
    const result = await fetchManagedGoogleCalendarFeed(FEED_ARGS);
    expect(result.events).toEqual([]);
    expect(result.calendarId).toBe("primary");
  });

  test("feed: 200 with items -> normalized events (success branch is real)", async () => {
    installFetch(() => new Response(JSON.stringify({ items: [VALID_EVENT] }), { status: 200 }));
    const result = await fetchManagedGoogleCalendarFeed(FEED_ARGS);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.externalId).toBe("evt-1");
  });

  test("calendar list: 200 with no items -> empty list, not a throw", async () => {
    installFetch(() => new Response(JSON.stringify({}), { status: 200 }));
    const result = await listManagedGoogleCalendars(BASE_ARGS);
    expect(result).toEqual([]);
  });
});

describe("internal failure propagates (never read as empty / deleted)", () => {
  test("feed: Google 500 throws AgentGoogleConnectorError, not empty events", async () => {
    installFetch(
      () => new Response(JSON.stringify({ error: { message: "backend error" } }), { status: 500 }),
    );
    await expect(fetchManagedGoogleCalendarFeed(FEED_ARGS)).rejects.toBeInstanceOf(
      AgentGoogleConnectorError,
    );
  });

  test("feed: transport error propagates (not swallowed to [])", async () => {
    installFetch(() => {
      throw new Error("ECONNRESET");
    });
    await expect(fetchManagedGoogleCalendarFeed(FEED_ARGS)).rejects.toThrow(/ECONNRESET/);
  });

  test("calendar list: Google 403 throws, not an empty list", async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "insufficientPermissions" } }), {
          status: 403,
        }),
    );
    await expect(listManagedGoogleCalendars(BASE_ARGS)).rejects.toBeInstanceOf(
      AgentGoogleConnectorError,
    );
  });

  test("create: 200 but partial payload (no id) throws 502, not a fake event", async () => {
    installFetch(() => new Response(JSON.stringify({ summary: "Untitled" }), { status: 200 }));
    let caught: unknown;
    await createManagedGoogleCalendarEvent({
      ...BASE_ARGS,
      title: "Sync",
      startAt: "2026-01-05T09:00:00.000Z",
      endAt: "2026-01-05T09:30:00.000Z",
      timeZone: "UTC",
    }).catch((error) => {
      caught = error;
    });
    expect(caught).toBeInstanceOf(AgentGoogleConnectorError);
    expect((caught as AgentGoogleConnectorError).status).toBe(502);
  });

  test("create: 200 valid payload -> event (success branch is real)", async () => {
    installFetch(() => new Response(JSON.stringify(VALID_EVENT), { status: 200 }));
    const result = await createManagedGoogleCalendarEvent({
      ...BASE_ARGS,
      title: "Sync",
      startAt: "2026-01-05T09:00:00.000Z",
      endAt: "2026-01-05T09:30:00.000Z",
      timeZone: "UTC",
    });
    expect(result.event.externalId).toBe("evt-1");
  });

  test("delete: Google 500 throws (never fabricates { ok: true })", async () => {
    installFetch(() => new Response("boom", { status: 500 }));
    await expect(
      deleteManagedGoogleCalendarEvent({ ...BASE_ARGS, eventId: "evt-1" }),
    ).rejects.toBeInstanceOf(AgentGoogleConnectorError);
  });

  test("delete: 204 -> { ok: true } (success branch is real)", async () => {
    installFetch(() => new Response(null, { status: 204 }));
    const result = await deleteManagedGoogleCalendarEvent({ ...BASE_ARGS, eventId: "evt-1" });
    expect(result).toEqual({ ok: true });
  });
});
