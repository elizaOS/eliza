// fetchManagedGoogleCalendarFeed drains pages with `do { ... } while
// (pageToken)`. Before this fix that loop had no termination guard beyond the
// token going empty -- a Google response (or misbehaving proxy) that repeats
// or never stops minting a nextPageToken looped forever. Pins: normal
// termination is unaffected, a repeated token throws instead of looping, and
// a provider that never repeats but never stops still terminates at the page
// cap. Deterministic: the real exported function runs through the real
// googleFetch fail-closed wrapper, with the OAuth token layer stubbed and
// global fetch mocked, mirroring calendar.error-policy.test.ts.
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

function installFetchSequence(handler: (callIndex: number) => Response | Promise<Response>) {
  let callIndex = 0;
  globalThis.fetch = mock(async () => handler(callIndex++)) as typeof fetch;
}

function page(nextPageToken?: string): Response {
  return new Response(JSON.stringify({ items: [], ...(nextPageToken ? { nextPageToken } : {}) }), {
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
    installFetchSequence((i) => (i === 0 ? page("c1") : page()));
    const result = await fetchManagedGoogleCalendarFeed(FEED_ARGS);
    expect(result.events).toEqual([]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  test("rejects a repeated page token instead of looping forever", async () => {
    installFetchSequence(() => page("stuck"));
    await expect(fetchManagedGoogleCalendarFeed(FEED_ARGS)).rejects.toBeInstanceOf(
      AgentGoogleConnectorError,
    );
    // Stopped after the repeat was detected on the second page, not a third.
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  test("bounds pagination against a provider that never repeats but never stops", async () => {
    let callCount = 0;
    installFetchSequence(() => {
      callCount += 1;
      return page(`token-${callCount}`);
    });
    await expect(fetchManagedGoogleCalendarFeed(FEED_ARGS)).rejects.toBeInstanceOf(
      AgentGoogleConnectorError,
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(1_000);
  });
});
