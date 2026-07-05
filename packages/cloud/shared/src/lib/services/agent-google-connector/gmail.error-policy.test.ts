/**
 * Error-policy pin (#13415) for the managed Gmail connector service. gmail.ts
 * routes every Google API call through `googleFetch`, which already fails closed
 * (throws `AgentGoogleConnectorError` on any token/HTTP/transport failure). This
 * test pins that a failed platform call PROPAGATES as a throw rather than reading
 * as "no messages", while a legitimately-empty Gmail list (200 OK, no matches)
 * stays a distinct, non-error empty result.
 *
 * The `./shared` seam is mocked so only `googleFetch` and
 * `getManagedGoogleConnectorStatus` are controlled; `fail`/`AgentGoogleConnectorError`
 * and the real normalization logic in gmail.ts are exercised for real. global
 * fetch is stubbed to throw so a hit to the network (rather than the mocked seam)
 * would surface as a test failure.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import * as realShared from "./shared";

type FetchArgs = { url: string; options?: RequestInit };

let fetchImpl: (args: FetchArgs) => Promise<Response>;
let statusImpl: () => Promise<unknown>;

mock.module("./shared", () => ({
  ...realShared,
  googleFetch: (args: FetchArgs) => fetchImpl(args),
  getManagedGoogleConnectorStatus: () => statusImpl(),
}));

const { fetchManagedGoogleGmailTriage } = await import("./gmail");

const ORG = "org-1";
const USER = "user-1";
const SIDE = "owner" as const;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const READY_STATUS = {
  identity: { email: "me@example.com" },
  grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  statusImpl = async () => READY_STATUS;
  // The service must never reach the real network; the ./shared seam is mocked.
  globalThis.fetch = (() => {
    throw new Error("network access is not allowed in this test");
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("gmail.ts error-policy — fail-closed vs designed-empty", () => {
  test("designed-empty: an empty Gmail list returns [] messages, not an error", async () => {
    fetchImpl = async ({ url }) => {
      // Only the list endpoint is hit when there are no messages to expand.
      expect(url).toContain("/messages?");
      return jsonResponse({});
    };

    const result = await fetchManagedGoogleGmailTriage({
      organizationId: ORG,
      userId: USER,
      side: SIDE,
      maxResults: 10,
    });

    expect(result.messages).toEqual([]);
    expect(typeof result.syncedAt).toBe("string");
  });

  test("populated list normalizes messages (empty is distinct from populated)", async () => {
    fetchImpl = async ({ url }) => {
      if (url.includes("/messages/")) {
        return jsonResponse({
          id: "m1",
          threadId: "t1",
          labelIds: ["INBOX", "UNREAD"],
          internalDate: "1700000000000",
          payload: {
            headers: [
              { name: "Subject", value: "Hello" },
              { name: "From", value: "Alice <alice@example.com>" },
              { name: "To", value: "me@example.com" },
            ],
          },
        });
      }
      return jsonResponse({ messages: [{ id: "m1", threadId: "t1" }] });
    };

    const result = await fetchManagedGoogleGmailTriage({
      organizationId: ORG,
      userId: USER,
      side: SIDE,
      maxResults: 10,
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.subject).toBe("Hello");
  });

  test("internal failure on the LIST call propagates (never fabricates empty)", async () => {
    fetchImpl = async () => {
      // Mirrors googleFetch's real behavior: a failed Google call throws.
      realShared.fail(502, "Google API error: 500");
    };

    await expect(
      fetchManagedGoogleGmailTriage({
        organizationId: ORG,
        userId: USER,
        side: SIDE,
        maxResults: 10,
      }),
    ).rejects.toThrow(/Google API error/);
  });

  test("internal failure on a per-message DETAIL fetch propagates (batch not silently dropped)", async () => {
    fetchImpl = async ({ url }) => {
      if (url.includes("/messages/")) {
        realShared.fail(502, "Google API error: 429");
      }
      return jsonResponse({ messages: [{ id: "m1", threadId: "t1" }] });
    };

    await expect(
      fetchManagedGoogleGmailTriage({
        organizationId: ORG,
        userId: USER,
        side: SIDE,
        maxResults: 10,
      }),
    ).rejects.toThrow(/Google API error/);
  });

  test("a connector-status failure propagates rather than yielding an empty inbox", async () => {
    statusImpl = async () => {
      realShared.fail(409, "needs_reauth");
    };
    fetchImpl = async () => {
      throw new Error("googleFetch should not be reached when status fails");
    };

    await expect(
      fetchManagedGoogleGmailTriage({
        organizationId: ORG,
        userId: USER,
        side: SIDE,
        maxResults: 10,
      }),
    ).rejects.toThrow(/needs_reauth/);
  });
});
