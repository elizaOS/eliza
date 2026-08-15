// Pins the #19873 refresh-rotation integrity P1 fixes: (1) two isolates must
// not burn the same single-use refresh token — the lease loser waits for the
// winner's store write and never contacts X; (2) the rotated refresh token is
// persisted FIRST and awaited, so a failure among the sibling writes can
// never keep a new access token while losing the new refresh token (which
// permanently strands the account on the burned one). Deterministic — the
// oauth2 token client, secrets store, and shared cache are stubbed.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const secretStore: Record<string, string | null> = {};
let tokenRequests = 0;
let refreshResponse: () => Promise<{
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
}> = async () => ({
  access_token: "new-access",
  refresh_token: "new-refresh",
  scope: "tweet.read",
  expires_in: 7200,
});

mock.module("./oauth2-client", () => ({
  requestTwitterOAuth2Token: () => {
    tokenRequests += 1;
    return refreshResponse();
  },
  parseTwitterOAuth2Scope: (scope?: string) =>
    typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : [],
  getTwitterOAuth2ClientAuthMode: () => "public",
  hasTwitterOAuth2ClientId: () => true,
  requireTwitterOAuth2ClientId: () => "client-id",
  normalizeTwitterOAuth2AuthorizeUrl: (url: string) => url,
}));

const secretWriteOrder: string[] = [];
let failSecretNames = new Set<string>();

mock.module("../secrets", () => ({
  secretsService: {
    get: async (_org: string, name: string) => secretStore[name] ?? null,
    create: async (args: { name: string; value: string }) => {
      secretWriteOrder.push(args.name);
      if (failSecretNames.has(args.name)) throw new Error(`induced failure: ${args.name}`);
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

mock.module("./app-automation", () => ({ twitterAppAutomationService: {} }));

// In-memory shared-cache stub with real NX semantics so the lease contends.
const leaseStore = new Map<string, string>();
mock.module("../../cache/client", () => ({
  cache: {
    setIfNotExists: async (key: string, value: string, _ttlMs: number) => {
      if (leaseStore.has(key)) return false;
      leaseStore.set(key, value);
      return true;
    },
    del: async (key: string) => {
      leaseStore.delete(key);
    },
  },
}));

function seedExpiredOauth2(role: "owner" | "agent", refreshToken: string): void {
  const prefix = `TWITTER_${role.toUpperCase()}_`;
  secretStore[`${prefix}OAUTH2_ACCESS_TOKEN`] = "stale-access";
  secretStore[`${prefix}OAUTH2_REFRESH_TOKEN`] = refreshToken;
  secretStore[`${prefix}OAUTH2_SCOPE`] = "tweet.read";
  // Expired an hour ago → needsRefresh true.
  secretStore[`${prefix}OAUTH2_EXPIRES_AT`] = String(Math.floor(Date.now() / 1000) - 3600);
  secretStore[`${prefix}AUTH_MODE`] = "oauth2";
}

async function loadService() {
  const mod = await import("./index");
  return mod.twitterAutomationService;
}

describe("OAuth2 refresh rotation integrity (#19873)", () => {
  beforeEach(() => {
    for (const key of Object.keys(secretStore)) delete secretStore[key];
    leaseStore.clear();
    secretWriteOrder.length = 0;
    failSecretNames = new Set();
    tokenRequests = 0;
  });
  afterEach(() => {
    leaseStore.clear();
  });

  test("a held lease means the loser waits for the winner's write and never burns the token", async () => {
    seedExpiredOauth2("agent", "single-use-refresh");
    // Another isolate holds the lease already.
    leaseStore.set("x-oauth2-refresh:org-1:agent", "1");

    const service = await loadService();
    const loser = service.getBrokerCredentials("org-1", "user-1", "agent");

    // Simulate the winner's store write landing while the loser polls.
    setTimeout(() => {
      const prefix = "TWITTER_AGENT_";
      secretStore[`${prefix}OAUTH2_ACCESS_TOKEN`] = "winner-access";
      secretStore[`${prefix}OAUTH2_EXPIRES_AT`] = String(Math.floor(Date.now() / 1000) + 7200);
    }, 100);

    const result = await loser;
    expect(result?.authMode).toBe("oauth2");
    expect(result && "accessToken" in result ? result.accessToken : null).toBe("winner-access");
    // The loser never called X's token endpoint — the single-use token survives.
    expect(tokenRequests).toBe(0);
  }, 20_000);

  test("rotation persists the new refresh token even when a sibling write fails", async () => {
    seedExpiredOauth2("agent", "single-use-refresh");
    failSecretNames = new Set(["TWITTER_AGENT_OAUTH2_ACCESS_TOKEN"]);

    const service = await loadService();
    await expect(service.getBrokerCredentials("org-1", "user-1", "agent")).rejects.toThrow(
      /induced failure/,
    );

    // The irreplaceable value survived the partial failure: the stored refresh
    // token is the NEW one, so the next refresh self-heals instead of
    // replaying the burned token.
    expect(secretStore.TWITTER_AGENT_OAUTH2_REFRESH_TOKEN).toBe("new-refresh");
    expect(tokenRequests).toBe(1);
    // And the refresh-token write strictly preceded the failed access write.
    const refreshIdx = secretWriteOrder.indexOf("TWITTER_AGENT_OAUTH2_REFRESH_TOKEN");
    const accessIdx = secretWriteOrder.indexOf("TWITTER_AGENT_OAUTH2_ACCESS_TOKEN");
    expect(refreshIdx).toBeGreaterThanOrEqual(0);
    expect(accessIdx).toBeGreaterThan(refreshIdx);
  });
});
