/**
 * Fail-closed token exchange in requestTwitterOAuth2Token (#13415).
 *
 * This is the OAuth2 leg the connector uses to mint and refresh Twitter access
 * tokens; a swallowed failure here would let a broken refresh read as a valid
 * (empty) token and silently drop the connection. These tests pin that an
 * internal failure — non-OK provider status, transport rejection, empty/malformed
 * success body, or missing client credentials — PROPAGATES as a throw, and stays
 * distinguishable from a legitimately-parsed token response.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { requestTwitterOAuth2Token, requireTwitterOAuth2ClientId } from "./oauth2-client";

const originalFetch = globalThis.fetch;
const originalClientId = process.env.TWITTER_CLIENT_ID;
const originalClientSecret = process.env.TWITTER_CLIENT_SECRET;

beforeAll(() => {
  process.env.TWITTER_CLIENT_ID = "test-client-id";
  delete process.env.TWITTER_CLIENT_SECRET;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalClientId === undefined) delete process.env.TWITTER_CLIENT_ID;
  else process.env.TWITTER_CLIENT_ID = originalClientId;
  if (originalClientSecret === undefined) delete process.env.TWITTER_CLIENT_SECRET;
  else process.env.TWITTER_CLIENT_SECRET = originalClientSecret;
});

function stubFetch(impl: () => Promise<Response> | Response): void {
  globalThis.fetch = (async () => impl()) as typeof fetch;
}

describe("requestTwitterOAuth2Token — fail-closed token exchange", () => {
  test("valid token response parses and is returned verbatim (designed success)", async () => {
    process.env.TWITTER_CLIENT_ID = "test-client-id";
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            access_token: "acc_123",
            refresh_token: "ref_456",
            scope: "tweet.read tweet.write",
            expires_in: 7200,
            token_type: "bearer",
          }),
          { status: 200 },
        ),
    );
    const token = await requestTwitterOAuth2Token({ grant_type: "refresh_token" });
    expect(token.access_token).toBe("acc_123");
    expect(token.refresh_token).toBe("ref_456");
  });

  test("non-OK status with JSON error body throws with provider detail (failure surfaces)", async () => {
    process.env.TWITTER_CLIENT_ID = "test-client-id";
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "refresh token revoked" }),
          { status: 400 },
        ),
    );
    await expect(requestTwitterOAuth2Token({ grant_type: "refresh_token" })).rejects.toThrow(
      /invalid_grant: refresh token revoked/,
    );
  });

  test("non-OK status with EMPTY body still throws (status-based, distinct from a token)", async () => {
    process.env.TWITTER_CLIENT_ID = "test-client-id";
    stubFetch(() => new Response("", { status: 503 }));
    await expect(requestTwitterOAuth2Token({ grant_type: "refresh_token" })).rejects.toThrow(
      /failed with status 503/,
    );
  });

  test("OK status with empty body throws instead of fabricating an empty token", async () => {
    process.env.TWITTER_CLIENT_ID = "test-client-id";
    stubFetch(() => new Response("", { status: 200 }));
    await expect(requestTwitterOAuth2Token({ grant_type: "refresh_token" })).rejects.toThrow(
      /empty response body/,
    );
  });

  test("OK status with malformed JSON throws instead of returning a partial token", async () => {
    process.env.TWITTER_CLIENT_ID = "test-client-id";
    stubFetch(() => new Response("{not json", { status: 200 }));
    await expect(requestTwitterOAuth2Token({ grant_type: "refresh_token" })).rejects.toThrow(
      /Failed to parse JSON/,
    );
  });

  test("transport rejection propagates (network failure is not swallowed)", async () => {
    process.env.TWITTER_CLIENT_ID = "test-client-id";
    stubFetch(() => {
      throw new Error("ECONNRESET");
    });
    await expect(requestTwitterOAuth2Token({ grant_type: "refresh_token" })).rejects.toThrow(
      /ECONNRESET/,
    );
  });

  test("missing client id throws before any fetch (fail closed on misconfiguration)", async () => {
    delete process.env.TWITTER_CLIENT_ID;
    let fetched = false;
    stubFetch(() => {
      fetched = true;
      return new Response("{}", { status: 200 });
    });
    await expect(requestTwitterOAuth2Token({ grant_type: "refresh_token" })).rejects.toThrow(
      /client ID is not configured/,
    );
    expect(fetched).toBe(false);
  });

  test("requireTwitterOAuth2ClientId throws when unconfigured", () => {
    delete process.env.TWITTER_CLIENT_ID;
    expect(() => requireTwitterOAuth2ClientId()).toThrow(/client ID is not configured/);
  });
});
