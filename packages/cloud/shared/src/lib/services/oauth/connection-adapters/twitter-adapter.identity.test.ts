/**
 * Pins Twitter connection-adapter catalog readiness: stored X tokens without a
 * complete provider identity are recoverable but must not project as active.
 * Deterministic secrets doubles only; no real provider call or env mutation.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const ORG_ID = "org-1";
const linkedAt = new Date("2024-01-02T00:00:00.000Z");

let platformSecrets: Array<{ name: string; created_at: Date }> = [];
const secretValues: Record<string, string | null> = {};

mock.module("../../../utils/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
mock.module("../../secrets", () => ({
  secretsService: {
    get: async () => null,
    delete: async () => undefined,
  },
}));
mock.module("../provider-registry", () => ({
  OAUTH_PROVIDERS: {
    twitter: {
      secretPatterns: {
        accessToken: "TWITTER_ACCESS_TOKEN",
        accessTokenSecret: "TWITTER_ACCESS_TOKEN_SECRET",
        username: "TWITTER_USERNAME",
        userId: "TWITTER_USER_ID",
      },
    },
  },
}));
mock.module("./secrets-adapter-utils", () => ({
  fetchPlatformSecrets: async () => platformSecrets,
  getOptionalSecretValue: async (_org: string, name: string) => secretValues[name] ?? null,
  getSecretValue: async (_org: string, name: string) => secretValues[name] ?? null,
  getEarliestSecretDate: (records: Array<{ created_at: Date }>) =>
    records[0]?.created_at ?? linkedAt,
  updateSecretAccessTime: async () => undefined,
  deletePlatformSecrets: async () => 0,
}));

const { twitterAdapter } = await import("./twitter-adapter");

function resetSecrets() {
  platformSecrets = [];
  for (const key of Object.keys(secretValues)) delete secretValues[key];
}

function addSecret(name: string, value: string) {
  platformSecrets.push({ name, created_at: linkedAt });
  secretValues[name] = value;
}

describe("twitterAdapter listConnections identity contract", () => {
  beforeEach(() => {
    resetSecrets();
  });

  test("complete stored identity is catalogued as active", async () => {
    addSecret("TWITTER_OWNER_OAUTH2_ACCESS_TOKEN", "oauth2-token");
    addSecret("TWITTER_OWNER_USERNAME", "alice");
    addSecret("TWITTER_OWNER_USER_ID", "111");

    const connections = await twitterAdapter.listConnections(ORG_ID);
    expect(connections).toHaveLength(1);
    expect(connections[0]?.status).toBe("active");
    expect(connections[0]?.platformUserId).toBe("111");
    expect(connections[0]?.username).toBe("alice");
    expect(connections[0]?.displayName).toBe("@alice");
  });

  test("stored token without identity is listed but not active and not unknown", async () => {
    addSecret("TWITTER_OWNER_OAUTH2_ACCESS_TOKEN", "oauth2-token");

    const connections = await twitterAdapter.listConnections(ORG_ID);
    expect(connections).toHaveLength(1);
    expect(connections[0]?.status).toBe("error");
    expect(connections[0]?.status).not.toBe("active");
    expect(connections[0]?.platformUserId).toBe("");
    expect(connections[0]?.platformUserId).not.toBe("unknown");
    expect(connections[0]?.username).toBeUndefined();
    expect(connections[0]?.displayName).toBeUndefined();
  });

  test.each([
    { username: "alice", userId: null },
    { username: null, userId: "111" },
    { username: "", userId: "111" },
    { username: "alice", userId: "" },
    { username: "   ", userId: "111" },
    { username: "alice", userId: "   " },
  ])("incomplete identity %j is not catalogued as active", async (identity) => {
    addSecret("TWITTER_OWNER_OAUTH2_ACCESS_TOKEN", "oauth2-token");
    if (identity.username != null) addSecret("TWITTER_OWNER_USERNAME", identity.username);
    if (identity.userId != null) addSecret("TWITTER_OWNER_USER_ID", identity.userId);

    const connections = await twitterAdapter.listConnections(ORG_ID);
    expect(connections).toHaveLength(1);
    expect(connections[0]?.status).not.toBe("active");
    expect(connections[0]?.platformUserId).not.toBe("unknown");
  });

  test("legacy owner secrets without identity are not active", async () => {
    addSecret("TWITTER_OAUTH_ACCESS_TOKEN", "legacy-token");

    const connections = await twitterAdapter.listConnections(ORG_ID);
    expect(connections).toHaveLength(1);
    expect(connections[0]?.id).toBe("twitter:org-1:owner");
    expect(connections[0]?.status).not.toBe("active");
    expect(connections[0]?.platformUserId).not.toBe("unknown");
  });

  test("getToken still returns stored OAuth2 credentials when identity is unverified", async () => {
    addSecret("TWITTER_OWNER_OAUTH2_ACCESS_TOKEN", "oauth2-token");
    addSecret("TWITTER_OWNER_OAUTH2_SCOPE", "tweet.read users.read");

    const token = await twitterAdapter.getToken(ORG_ID, "twitter:org-1:owner");
    expect(token.accessToken).toBe("oauth2-token");
    expect(token.scopes).toEqual(["tweet.read", "users.read"]);
  });
});
