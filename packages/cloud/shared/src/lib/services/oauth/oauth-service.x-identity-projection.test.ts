/**
 * Pins generic OAuth connection catalog projection: unverified X credentials
 * must not satisfy active/connected readiness. Uses the shared identity
 * projector plus the real recency/preference helpers. No provider calls.
 */
import { describe, expect, mock, test } from "bun:test";
import type { OAuthConnection } from "./types";
import { projectXCatalogIdentity } from "./x-identity";

mock.module("../../../db/client", () => ({
  dbRead: { select: () => ({ from: () => ({ where: async () => [] }) }) },
  dbWrite: {},
  db: {},
}));
mock.module("../../cache/client", () => ({
  cache: { get: async () => null, set: async () => undefined, del: async () => undefined },
}));
mock.module("../../runtime/cloud-bindings", () => ({
  getCloudAwareEnv: () => ({}),
}));
mock.module("../../utils/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));
mock.module("./connection-adapters", () => ({
  getAdapter: () => null,
  getAllAdapters: () => [],
}));
mock.module("./cache-version", () => ({
  getOAuthVersion: async () => 1,
  incrementOAuthVersion: async () => 1,
}));
mock.module("./provider-registry", () => ({
  getProvider: () => undefined,
  isProviderConfigured: () => false,
  OAUTH_PROVIDERS: {},
}));
mock.module("./providers", () => ({
  initiateOAuth2: async () => ({ authUrl: "https://example.test" }),
}));
mock.module("./token-cache", () => ({
  tokenCache: { invalidateAll: async () => undefined },
}));

const { getMostRecentActiveConnection, getPreferredActiveConnection } = await import(
  "./oauth-service"
);

function twitterConnection(
  identity: { userId?: unknown; username?: unknown },
  extras: Partial<Pick<OAuthConnection, "id" | "connectionRole" | "linkedAt">> = {},
): OAuthConnection {
  const projected = projectXCatalogIdentity(identity);
  return {
    id: extras.id ?? "twitter:org-1:owner",
    connectionRole: extras.connectionRole ?? "owner",
    platform: "twitter",
    platformUserId: projected.platformUserId,
    username: projected.username,
    displayName: projected.displayName,
    status: projected.status,
    scopes: [],
    linkedAt: extras.linkedAt ?? new Date("2024-01-01T00:00:00.000Z"),
    tokenExpired: false,
    source: "secrets",
  };
}

describe("X connection catalog projection", () => {
  test("unverified stored credentials do not satisfy active/connected readiness", () => {
    const unverified = twitterConnection({});
    expect(unverified.status).not.toBe("active");
    expect(getMostRecentActiveConnection([unverified])).toBeNull();
    expect(getPreferredActiveConnection([unverified])).toBeNull();
    expect(getPreferredActiveConnection([unverified], undefined, "owner")).toBeNull();
  });

  test("verified identity remains the active catalog connection", () => {
    const verified = twitterConnection({ userId: "111", username: "alice" });
    expect(verified.status).toBe("active");
    expect(getMostRecentActiveConnection([verified])?.id).toBe(verified.id);
    expect(getPreferredActiveConnection([verified], undefined, "owner")?.id).toBe(verified.id);
  });

  test("mixed catalog prefers verified active X identity over stored-but-unverified", () => {
    const unverified = twitterConnection(
      {},
      { id: "twitter:org-1:agent", connectionRole: "agent", linkedAt: new Date("2024-02-01") },
    );
    const verified = twitterConnection(
      { userId: "111", username: "alice" },
      { id: "twitter:org-1:owner", connectionRole: "owner", linkedAt: new Date("2024-01-01") },
    );
    expect(getMostRecentActiveConnection([unverified, verified])?.id).toBe(verified.id);
    expect(getPreferredActiveConnection([unverified, verified], undefined, "agent")).toBeNull();
    expect(getPreferredActiveConnection([unverified, verified], undefined, "owner")?.id).toBe(
      verified.id,
    );
  });
});
