// Pins the fail-closed error policy of TwitterAutomationService: an internal platform/API failure
// propagates or surfaces as a distinct error field, and is never conflated with a designed-empty
// ("not connected", "identity absent") result. Deterministic — twitter-api-v2, the oauth2 token
// client, and the secrets store are stubbed via mock.module; no real network.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

interface MeResult {
  data: { username: string; id: string; profile_image_url?: string };
}

// Per-test behavior for the stubbed twitter-api-v2 client and oauth2 token endpoint.
const twitterApiBehavior: { me: () => Promise<MeResult> } = {
  me: async () => ({ data: { username: "alice", id: "42" } }),
};
const oauth2Behavior: {
  requestToken: () => Promise<{ access_token?: string; refresh_token?: string; scope?: string }>;
} = {
  requestToken: async () => ({ access_token: "access-tok", scope: "tweet.read tweet.write" }),
};
const secretStore: Record<string, string | null> = {};

class MockTwitterApi {
  constructor(_config: unknown) {}
  v2 = { me: (..._args: unknown[]) => twitterApiBehavior.me() };
}

mock.module("twitter-api-v2", () => ({ TwitterApi: MockTwitterApi }));

mock.module("./oauth2-client", () => ({
  requestTwitterOAuth2Token: () => oauth2Behavior.requestToken(),
  parseTwitterOAuth2Scope: (scope?: string) =>
    typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : [],
  getTwitterOAuth2ClientAuthMode: () => "public",
  hasTwitterOAuth2ClientId: () => true,
  requireTwitterOAuth2ClientId: () => "client-id",
  normalizeTwitterOAuth2AuthorizeUrl: (url: string) => url,
}));

mock.module("../secrets", () => ({
  secretsService: {
    get: async (_org: string, name: string) => secretStore[name] ?? null,
  },
}));

// index.ts re-exports the heavy app-automation service (ai/db/credits) on load — stub it so the
// module under test imports without standing up unrelated infrastructure.
mock.module("./app-automation", () => ({ twitterAppAutomationService: {} }));

const originalFetch = globalThis.fetch;

async function loadService() {
  const mod = await import("./index");
  return mod.twitterAutomationService;
}

describe("TwitterAutomationService error policy", () => {
  beforeEach(() => {
    for (const key of Object.keys(secretStore)) delete secretStore[key];
    twitterApiBehavior.me = async () => ({ data: { username: "alice", id: "42" } });
    oauth2Behavior.requestToken = async () => ({
      access_token: "access-tok",
      scope: "tweet.read tweet.write",
    });
    // Any real network hit is a bug: this suite must be fully deterministic.
    globalThis.fetch = (async () => {
      throw new Error("unexpected network call in error-policy test");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("exchangeOAuth2Token", () => {
    test("propagates a failed token exchange instead of swallowing it", async () => {
      oauth2Behavior.requestToken = async () => {
        throw new Error("token endpoint returned 400 invalid_grant");
      };
      const service = await loadService();
      await expect(service.exchangeOAuth2Token("code", "verifier", "https://cb")).rejects.toThrow(
        /invalid_grant/,
      );
    });

    test("fails closed when the token response omits an access token", async () => {
      oauth2Behavior.requestToken = async () => ({ scope: "tweet.read" });
      const service = await loadService();
      await expect(service.exchangeOAuth2Token("code", "verifier", "https://cb")).rejects.toThrow(
        /did not include an access token/,
      );
    });

    test("surfaces a failed identity lookup as a distinct field, not a fabricated identity", async () => {
      twitterApiBehavior.me = async () => {
        throw Object.assign(new Error("profile forbidden"), { code: 403 });
      };
      const service = await loadService();
      const result = await service.exchangeOAuth2Token("code", "verifier", "https://cb");

      // Primary op succeeded → token flows through; secondary lookup failure is reported, not faked.
      expect(result.accessToken).toBe("access-tok");
      expect(result.screenName).toBeUndefined();
      expect(result.userId).toBeUndefined();
      expect(typeof result.identityLookupError).toBe("string");
      expect(result.identityLookupError).toContain("forbidden");
    });

    test("a successful identity lookup leaves no lingering error signal", async () => {
      const service = await loadService();
      const result = await service.exchangeOAuth2Token("code", "verifier", "https://cb");
      expect(result.screenName).toBe("alice");
      expect(result.userId).toBe("42");
      expect(result.identityLookupError).toBeUndefined();
    });
  });

  describe("getConnectionStatus", () => {
    test("designed-empty (no stored credentials) is disconnected with NO error field", async () => {
      const service = await loadService();
      const status = await service.getConnectionStatus("org-1", "owner");
      expect(status.connected).toBe(false);
      expect(status.error).toBeUndefined();
    });

    test("internal validation failure is disconnected WITH an error field — distinct from empty", async () => {
      secretStore.TWITTER_OWNER_OAUTH2_ACCESS_TOKEN = "stored-oauth2-token";
      twitterApiBehavior.me = async () => {
        throw Object.assign(new Error("upstream 500 boom"), { code: 500 });
      };
      const service = await loadService();
      const status = await service.getConnectionStatus("org-1", "owner");
      expect(status.connected).toBe(false);
      expect(typeof status.error).toBe("string");
      expect(status.error).toContain("reconnecting");
    });

    test("the OAuth2 403 quirk stays connected but still carries an explicit error, never silent", async () => {
      secretStore.TWITTER_OWNER_OAUTH2_ACCESS_TOKEN = "stored-oauth2-token";
      twitterApiBehavior.me = async () => {
        throw Object.assign(new Error("profile forbidden"), { code: 403 });
      };
      const service = await loadService();
      const status = await service.getConnectionStatus("org-1", "owner");
      expect(status.connected).toBe(true);
      expect(typeof status.error).toBe("string");
      expect(status.error).toContain("OAuth2 credentials are stored");
    });

    test("a valid token reports connected with no error", async () => {
      secretStore.TWITTER_OWNER_OAUTH2_ACCESS_TOKEN = "stored-oauth2-token";
      const service = await loadService();
      const status = await service.getConnectionStatus("org-1", "owner");
      expect(status.connected).toBe(true);
      expect(status.username).toBe("alice");
      expect(status.error).toBeUndefined();
    });
  });
});
