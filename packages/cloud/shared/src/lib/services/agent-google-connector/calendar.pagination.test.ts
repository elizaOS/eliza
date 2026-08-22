/**
 * Exercises the real managed Calendar feed through its authenticated fetch
 * boundary, including token cycles and the accumulated event ceiling.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { logger } from "../../utils/logger";
import { fetchManagedGoogleCalendarFeed } from "./calendar";
import { AgentGoogleConnectorError, managedGoogleConnectorDeps } from "./shared";

const FEED_ARGS = {
  organizationId: "org-1",
  userId: "user-1",
  side: "owner" as const,
  calendarId: "primary",
  timeMin: "2026-01-01T00:00:00.000Z",
  timeMax: "2026-02-01T00:00:00.000Z",
  timeZone: "UTC",
};

const savedFetch = globalThis.fetch;
const savedGetToken =
  managedGoogleConnectorDeps.oauthService.getValidTokenByPlatformWithConnectionId;

function installFetchSequence(
  handler: (callIndex: number, input: Parameters<typeof fetch>[0]) => Response | Promise<Response>,
) {
  let callIndex = 0;
  globalThis.fetch = mock(async (input) => handler(callIndex++, input)) as typeof fetch;
}

function calendarEvent(index: number) {
  return {
    id: `event-${index}`,
    start: { dateTime: "2026-01-01T10:00:00.000Z" },
    end: { dateTime: "2026-01-01T11:00:00.000Z" },
  };
}

function page(nextPageToken?: string, items: unknown[] = []): Response {
  return new Response(JSON.stringify({ items, ...(nextPageToken ? { nextPageToken } : {}) }), {
    status: 200,
  });
}

beforeEach(() => {
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

describe("fetchManagedGoogleCalendarFeed pagination", () => {
  test("drains pages until the API stops returning a next cursor", async () => {
    const requestedUrls: string[] = [];
    installFetchSequence((i, input) => {
      requestedUrls.push(String(input));
      return i === 0 ? page("c1") : page();
    });
    const result = await fetchManagedGoogleCalendarFeed(FEED_ARGS);
    expect(result.events).toEqual([]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(new URL(requestedUrls[0]).searchParams.has("pageToken")).toBe(false);
    expect(new URL(requestedUrls[1]).searchParams.get("pageToken")).toBe("c1");
  });

  test("rejects a repeated page token instead of looping forever", async () => {
    installFetchSequence(() => page("stuck"));
    await expect(fetchManagedGoogleCalendarFeed(FEED_ARGS)).rejects.toBeInstanceOf(
      AgentGoogleConnectorError,
    );
    // Stopped after the repeat was detected on the second page, not a third.
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  test("follows provider cursors beyond the former fixed page ceiling", async () => {
    installFetchSequence((i) => (i === 1_000 ? page() : page(`token-${i + 1}`)));
    await expect(fetchManagedGoogleCalendarFeed(FEED_ARGS)).resolves.toMatchObject({
      events: [],
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1_001);
  });

  test("allows exactly 10,000 normalized events", async () => {
    const items = Array.from({ length: 2_500 }, (_, index) => calendarEvent(index));
    installFetchSequence((i) => page(i === 3 ? undefined : `token-${i + 1}`, items));
    const result = await fetchManagedGoogleCalendarFeed(FEED_ARGS);
    expect(result.events).toHaveLength(10_000);
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
  });

  test("rejects an event page before appending beyond the Worker response ceiling", async () => {
    const items = Array.from({ length: 10_001 }, (_, index) => calendarEvent(index));
    installFetchSequence(() => page(undefined, items));
    await expect(fetchManagedGoogleCalendarFeed(FEED_ARGS)).rejects.toThrow(
      "Google Calendar feed exceeded 10000 events",
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
