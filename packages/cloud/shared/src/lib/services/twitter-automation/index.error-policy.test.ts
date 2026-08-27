/**
 * Pins TwitterAutomationService's fail-closed provider error policy with deterministic module
 * stubs. Internal API failures remain distinct from designed-empty results, and the harness
 * rejects any real network call.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Per-test behavior for the stubbed twitter-api-v2 client and oauth2 token endpoint.
const twitterApiBehavior: { me: () => Promise<unknown> } = {
  me: async () => ({ data: { username: "alice", id: "42" } }),
};
const oauth2Behavior: {
  requestToken: () => Promise<{
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    expires_in?: number;
  }>;
} = {
  requestToken: async () => ({ access_token: "access-tok", scope: "tweet.read tweet.write" }),
};
const secretStore: Record<string, string | null> = {};
const secretWriteOrder: string[] = [];
const warningLogs: Array<{ message: string; context?: Record<string, unknown> }> = [];
let failSecretNames = new Set<string>();

class MockTwitterApi {
  constructor(_config: unknown) {}
  v2 = { me: (..._args: unknown[]) => twitterApiBehavior.me() };
}

mock.module("twitter-api-v2", () => ({ TwitterApi: MockTwitterApi }));

mock.module("../../utils/logger", () => ({
  logger: {
    debug: () => {},
    error: () => {},
    info: () => {},
    warn: (message: string, context?: Record<string, unknown>) => {
      warningLogs.push({ message, context });
    },
  },
}));

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
    create: async (args: { name: string; value: string }) => {
      secretWriteOrder.push(args.name);
      if (failSecretNames.has(args.name)) throw new Error(`induced failure: ${args.name}`);
      if (secretStore[args.name] != null) {
        throw new Error(`Secret '${args.name}' already exists`);
      }
      secretStore[args.name] = args.value;
    },
    list: async () =>
      Object.entries(secretStore)
        .filter(([, value]) => value != null)
        .map(([name]) => ({ id: name, name })),
    rotate: async (id: string, _org: string, value: string) => {
      secretWriteOrder.push(id);
      if (failSecretNames.has(id)) throw new Error(`induced failure: ${id}`);
      secretStore[id] = value;
    },
    delete: async (id: string) => {
      delete secretStore[id];
    },
    deleteByName: async (_org: string, name: string) => {
      delete secretStore[name];
    },
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
    secretWriteOrder.length = 0;
    warningLogs.length = 0;
    failSecretNames = new Set();
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

    test("internal validation failure is disconnected with a safe classified error", async () => {
      secretStore.TWITTER_OWNER_OAUTH2_ACCESS_TOKEN = "stored-oauth2-token";
      twitterApiBehavior.me = async () => {
        throw Object.assign(new Error("upstream private diagnostic"), { code: 500 });
      };
      const service = await loadService();
      const status = await service.getConnectionStatus("org-1", "owner");
      expect(status.connected).toBe(false);
      expect(status.errorCode).toBe("provider_identity_verification_failed");
      expect(status.error).toBe("X identity could not be verified. Try reconnecting.");
      expect(JSON.stringify({ status, warningLogs })).not.toContain("private diagnostic");
    });

    test("HTTP 403 fails closed and preserves stored identity only as unverified metadata", async () => {
      secretStore.TWITTER_OWNER_OAUTH2_ACCESS_TOKEN = "stored-oauth2-token";
      secretStore.TWITTER_OWNER_USERNAME = "stored-handle";
      secretStore.TWITTER_OWNER_USER_ID = "stored-user";
      twitterApiBehavior.me = async () => {
        throw Object.assign(new Error("provider private detail"), { code: 403 });
      };
      const service = await loadService();
      const status = await service.getConnectionStatus("org-1", "owner");
      expect(status).toEqual({
        connected: false,
        storedIdentity: {
          verified: false,
          username: "stored-handle",
          userId: "stored-user",
        },
        errorCode: "provider_identity_verification_failed",
        error: "X identity could not be verified. Try reconnecting.",
      });
      expect(status.username).toBeUndefined();
      expect(status.userId).toBeUndefined();
      expect(JSON.stringify({ status, warningLogs })).not.toContain("provider private detail");
      expect(warningLogs).toContainEqual({
        message: "[TwitterAutomation] Provider identity verification failed",
        context: {
          organizationId: "org-1",
          connectionRole: "owner",
          errorCode: "provider_identity_verification_failed",
          status: 403,
        },
      });
    });

    test.each([
      ["missing id", { data: { username: "provider-handle" } }],
      ["empty id", { data: { id: "", username: "provider-handle" } }],
      ["blank id", { data: { id: "   ", username: "provider-handle" } }],
      ["non-string id", { data: { id: 42, username: "provider-handle" } }],
      ["missing username", { data: { id: "42" } }],
      ["empty username", { data: { id: "42", username: "" } }],
      ["blank username", { data: { id: "42", username: "   " } }],
      ["non-string username", { data: { id: "42", username: ["private-handle"] } }],
    ])("a 200 response with %s fails closed", async (_case, providerResponse) => {
      secretStore.TWITTER_OWNER_OAUTH2_ACCESS_TOKEN = "stored-oauth2-token";
      secretStore.TWITTER_OWNER_USERNAME = "stored-handle";
      secretStore.TWITTER_OWNER_USER_ID = "stored-user";
      twitterApiBehavior.me = async () => providerResponse;

      const service = await loadService();
      const status = await service.getConnectionStatus("org-1", "owner");

      expect(status).toEqual({
        connected: false,
        storedIdentity: {
          verified: false,
          username: "stored-handle",
          userId: "stored-user",
        },
        errorCode: "provider_identity_verification_failed",
        error: "X identity could not be verified. Try reconnecting.",
      });
      expect(status.username).toBeUndefined();
      expect(status.userId).toBeUndefined();
      expect(JSON.stringify({ status, warningLogs })).not.toContain("private-handle");
    });

    test("a valid token reports connected with no error", async () => {
      secretStore.TWITTER_OWNER_OAUTH2_ACCESS_TOKEN = "stored-oauth2-token";
      const service = await loadService();
      const status = await service.getConnectionStatus("org-1", "owner");
      expect(status.connected).toBe(true);
      expect(status.username).toBe("alice");
      expect(status.userId).toBe("42");
      expect(status.error).toBeUndefined();
    });

    test.each([
      ["an empty", ""],
      ["a blank", "   "],
      ["a null", null],
      ["a non-string", 42],
    ])("ignores %s optional avatar after verifying username and id", async (_case, avatarUrl) => {
      secretStore.TWITTER_OWNER_OAUTH2_ACCESS_TOKEN = "stored-oauth2-token";
      twitterApiBehavior.me = async () => ({
        data: {
          username: "alice",
          id: "42",
          profile_image_url: avatarUrl,
        },
      });

      const service = await loadService();
      const status = await service.getConnectionStatus("org-1", "owner");

      expect(status).toEqual({
        connected: true,
        username: "alice",
        userId: "42",
      });
    });

    test("normalizes a valid optional avatar after verifying username and id", async () => {
      secretStore.TWITTER_OWNER_OAUTH2_ACCESS_TOKEN = "stored-oauth2-token";
      twitterApiBehavior.me = async () => ({
        data: {
          username: "alice",
          id: "42",
          profile_image_url: "  https://cdn.example/avatar.png  ",
        },
      });

      const service = await loadService();
      const status = await service.getConnectionStatus("org-1", "owner");

      expect(status).toEqual({
        connected: true,
        username: "alice",
        userId: "42",
        avatarUrl: "https://cdn.example/avatar.png",
      });
    });
  });

  describe("getBrokerCredentials (OAuth2 refresh/rotate contract)", () => {
    test("vends the stored token with expires_at while it is still fresh, without refreshing", async () => {
      const freshExpiry = Math.floor(Date.now() / 1000) + 3600;
      secretStore.TWITTER_AGENT_OAUTH2_ACCESS_TOKEN = "fresh-tok";
      secretStore.TWITTER_AGENT_OAUTH2_REFRESH_TOKEN = "refresh-1";
      secretStore.TWITTER_AGENT_OAUTH2_EXPIRES_AT = String(freshExpiry);
      oauth2Behavior.requestToken = async () => {
        throw new Error("refresh must not run for a fresh token");
      };
      const service = await loadService();
      const result = await service.getBrokerCredentials("org-1", "user-1", "agent");
      expect(result).toEqual({
        authMode: "oauth2",
        accessToken: "fresh-tok",
        expiresAt: freshExpiry,
        scope: null,
        twitterUserId: null,
      });
    });

    test("an expired token is refreshed, the rotated secrets persist, and the fresh token is vended", async () => {
      secretStore.TWITTER_AGENT_OAUTH2_ACCESS_TOKEN = "stale-tok";
      secretStore.TWITTER_AGENT_OAUTH2_REFRESH_TOKEN = "refresh-1";
      secretStore.TWITTER_AGENT_OAUTH2_EXPIRES_AT = String(Math.floor(Date.now() / 1000) - 10);
      oauth2Behavior.requestToken = async () => ({
        access_token: "rotated-tok",
        refresh_token: "refresh-2",
        scope: "tweet.read dm.read dm.write",
        expires_in: 7200,
      });
      const service = await loadService();
      const before = Math.floor(Date.now() / 1000);
      const result = await service.getBrokerCredentials("org-1", "user-1", "agent");
      if (!result || result.authMode !== "oauth2") {
        throw new Error("expected an oauth2 broker credential");
      }
      expect(result.accessToken).toBe("rotated-tok");
      expect(result.expiresAt).toBeGreaterThanOrEqual(before + 7200);
      expect(secretStore.TWITTER_AGENT_OAUTH2_ACCESS_TOKEN).toBe("rotated-tok");
      expect(secretStore.TWITTER_AGENT_OAUTH2_REFRESH_TOKEN).toBe("refresh-2");
      expect(Number(secretStore.TWITTER_AGENT_OAUTH2_EXPIRES_AT)).toBe(result.expiresAt as number);
    });

    test("persists the rotated refresh token before starting fallible sibling writes", async () => {
      secretStore.TWITTER_AGENT_OAUTH2_ACCESS_TOKEN = "stale-tok";
      secretStore.TWITTER_AGENT_OAUTH2_REFRESH_TOKEN = "refresh-1";
      secretStore.TWITTER_AGENT_OAUTH2_EXPIRES_AT = String(Math.floor(Date.now() / 1000) - 10);
      failSecretNames = new Set(["TWITTER_AGENT_OAUTH2_ACCESS_TOKEN"]);
      oauth2Behavior.requestToken = async () => ({
        access_token: "rotated-tok",
        refresh_token: "refresh-2",
        scope: "tweet.read",
        expires_in: 7200,
      });
      const service = await loadService();
      await expect(service.getBrokerCredentials("org-1", "user-1", "agent")).rejects.toThrow(
        /induced failure/,
      );

      expect(secretStore.TWITTER_AGENT_OAUTH2_REFRESH_TOKEN).toBe("refresh-2");
      const refreshWrite = secretWriteOrder.indexOf("TWITTER_AGENT_OAUTH2_REFRESH_TOKEN");
      const accessWrite = secretWriteOrder.indexOf("TWITTER_AGENT_OAUTH2_ACCESS_TOKEN");
      expect(refreshWrite).toBeGreaterThanOrEqual(0);
      expect(accessWrite).toBeGreaterThan(refreshWrite);
    });

    test("a token with no recorded expiry (legacy) forces a refresh rather than vending blind", async () => {
      secretStore.TWITTER_AGENT_OAUTH2_ACCESS_TOKEN = "legacy-tok";
      secretStore.TWITTER_AGENT_OAUTH2_REFRESH_TOKEN = "refresh-1";
      oauth2Behavior.requestToken = async () => ({
        access_token: "rotated-tok",
        expires_in: 7200,
      });
      const service = await loadService();
      const result = await service.getBrokerCredentials("org-1", "user-1", "agent");
      if (!result || result.authMode !== "oauth2") {
        throw new Error("expected an oauth2 broker credential");
      }
      expect(result.accessToken).toBe("rotated-tok");
      // X did not rotate the refresh token, so the original one is retained.
      expect(secretStore.TWITTER_AGENT_OAUTH2_REFRESH_TOKEN).toBe("refresh-1");
    });

    test("a refresh failure propagates instead of vending a token known to be stale", async () => {
      secretStore.TWITTER_AGENT_OAUTH2_ACCESS_TOKEN = "stale-tok";
      secretStore.TWITTER_AGENT_OAUTH2_REFRESH_TOKEN = "refresh-1";
      secretStore.TWITTER_AGENT_OAUTH2_EXPIRES_AT = String(Math.floor(Date.now() / 1000) - 10);
      oauth2Behavior.requestToken = async () => {
        throw new Error("token endpoint returned 400 invalid_grant");
      };
      const service = await loadService();
      await expect(service.getBrokerCredentials("org-1", "user-1", "agent")).rejects.toThrow(
        /invalid_grant/,
      );
      // The stale token remains stored, never silently vended.
      expect(secretStore.TWITTER_AGENT_OAUTH2_ACCESS_TOKEN).toBe("stale-tok");
    });

    test("an expired token without a refresh token fails closed", async () => {
      secretStore.TWITTER_AGENT_OAUTH2_ACCESS_TOKEN = "stale-tok";
      secretStore.TWITTER_AGENT_OAUTH2_EXPIRES_AT = String(Math.floor(Date.now() / 1000) - 10);
      const service = await loadService();
      await expect(service.getBrokerCredentials("org-1", "user-1", "agent")).rejects.toThrow(
        /expired.*no refresh token/i,
      );
    });
  });

  describe("storeCredentials (OAuth2 reconnect contract)", () => {
    test("an explicit missing refresh token deletes the obsolete stored token", async () => {
      secretStore.TWITTER_AGENT_OAUTH2_REFRESH_TOKEN = "obsolete-refresh";
      const service = await loadService();
      await service.storeCredentials(
        "org-1",
        "user-1",
        {
          accessToken: "new-access",
          refreshToken: null,
          expiresAt: Math.floor(Date.now() / 1000) + 7200,
          authMode: "oauth2",
        },
        "agent",
      );

      expect(secretStore.TWITTER_AGENT_OAUTH2_ACCESS_TOKEN).toBe("new-access");
      expect(secretStore.TWITTER_AGENT_OAUTH2_REFRESH_TOKEN).toBeUndefined();
    });
  });
});
