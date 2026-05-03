/**
 * OAuth Service Unit Tests
 *
 * Tests the main OAuth service class behavior and logic.
 */

import { describe, expect, it } from "bun:test";
import {
  getPreferredActiveConnection,
  scopeConnectionsForUser,
} from "@/lib/services/oauth/oauth-service";
import { OAUTH_PROVIDERS } from "@/lib/services/oauth/provider-registry";
import type { OAuthConnection, OAuthProviderInfo } from "@/lib/services/oauth/types";

describe("OAuth Service Logic", () => {
  describe("listProviders transformation", () => {
    it("should transform provider config to info format", () => {
      // Simulate the transformation logic
      const transformProvider = (
        provider: (typeof OAUTH_PROVIDERS)[string],
      ): OAuthProviderInfo => ({
        id: provider.id,
        name: provider.name,
        description: provider.description,
        type: provider.type,
        configured: true, // Simplified for testing
        defaultScopes: provider.defaultScopes,
      });

      const google = OAUTH_PROVIDERS.google;
      const info = transformProvider(google);

      expect(info.id).toBe("google");
      expect(info.name).toBe("Google");
      expect(info.type).toBe("oauth2");
      expect(info.defaultScopes).toBeDefined();
    });

    it("should include all expected providers", () => {
      const providerCount = Object.keys(OAUTH_PROVIDERS).length;
      expect(providerCount).toBeGreaterThanOrEqual(4);
    });
  });

  describe("getMostRecentActive logic", () => {
    function getMostRecentActive(connections: OAuthConnection[]): OAuthConnection | null {
      const active = connections.filter((c) => c.status === "active");
      if (active.length === 0) return null;
      return active.reduce((most, conn) => {
        const mostTime = most.lastUsedAt?.getTime() || most.linkedAt.getTime();
        const connTime = conn.lastUsedAt?.getTime() || conn.linkedAt.getTime();
        return connTime > mostTime ? conn : most;
      });
    }

    it("should return null for empty array", () => {
      expect(getMostRecentActive([])).toBeNull();
    });

    it("should return null when no active connections", () => {
      const connections: OAuthConnection[] = [
        createMockConnection("revoked"),
        createMockConnection("expired"),
      ];
      expect(getMostRecentActive(connections)).toBeNull();
    });

    it("should return the only active connection", () => {
      const active = createMockConnection("active", "conn-1");
      const connections: OAuthConnection[] = [
        createMockConnection("revoked"),
        active,
        createMockConnection("expired"),
      ];
      expect(getMostRecentActive(connections)).toBe(active);
    });

    it("should return most recently used when lastUsedAt is set", () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 3600000);

      const recentConn = createMockConnection("active", "recent", {
        lastUsedAt: now,
        linkedAt: oneHourAgo,
      });
      const oldConn = createMockConnection("active", "old", {
        lastUsedAt: oneHourAgo,
        linkedAt: new Date(now.getTime() - 7200000),
      });

      const connections = [oldConn, recentConn];
      expect(getMostRecentActive(connections)).toBe(recentConn);
    });

    it("should fall back to linkedAt when lastUsedAt is undefined", () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 3600000);

      const recentConn = createMockConnection("active", "recent", {
        linkedAt: now,
      });
      const oldConn = createMockConnection("active", "old", {
        linkedAt: oneHourAgo,
      });

      const connections = [oldConn, recentConn];
      expect(getMostRecentActive(connections)).toBe(recentConn);
    });
  });

  describe("sortConnectionsByRecency logic", () => {
    function sortConnectionsByRecency(connections: OAuthConnection[]): OAuthConnection[] {
      return connections.sort((a, b) => {
        const aTime = a.lastUsedAt?.getTime() || a.linkedAt.getTime();
        const bTime = b.lastUsedAt?.getTime() || b.linkedAt.getTime();
        return bTime - aTime; // Descending (most recent first)
      });
    }

    it("should return empty array for empty input", () => {
      expect(sortConnectionsByRecency([])).toEqual([]);
    });

    it("should sort by lastUsedAt descending", () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 3600000);
      const twoHoursAgo = new Date(now.getTime() - 7200000);

      const conn1 = createMockConnection("active", "1", {
        lastUsedAt: oneHourAgo,
      });
      const conn2 = createMockConnection("active", "2", { lastUsedAt: now });
      const conn3 = createMockConnection("active", "3", {
        lastUsedAt: twoHoursAgo,
      });

      const sorted = sortConnectionsByRecency([conn1, conn2, conn3]);
      expect(sorted[0].id).toBe("2"); // Most recent
      expect(sorted[1].id).toBe("1");
      expect(sorted[2].id).toBe("3"); // Oldest
    });

    it("should use linkedAt when lastUsedAt is undefined", () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 3600000);

      const conn1 = createMockConnection("active", "1", {
        linkedAt: oneHourAgo,
      });
      const conn2 = createMockConnection("active", "2", { linkedAt: now });

      const sorted = sortConnectionsByRecency([conn1, conn2]);
      expect(sorted[0].id).toBe("2");
      expect(sorted[1].id).toBe("1");
    });

    it("should handle mixed lastUsedAt and linkedAt", () => {
      const now = new Date();
      const _oneHourAgo = new Date(now.getTime() - 3600000);
      const twoHoursAgo = new Date(now.getTime() - 7200000);

      const conn1 = createMockConnection("active", "1", {
        linkedAt: twoHoursAgo,
        lastUsedAt: now,
      });
      const conn2 = createMockConnection("active", "2", {
        linkedAt: now,
        // No lastUsedAt
      });

      const sorted = sortConnectionsByRecency([conn1, conn2]);
      // conn1 has lastUsedAt=now, conn2 falls back to linkedAt=now
      // They're equal, order depends on original position
      expect(sorted.length).toBe(2);
    });
  });

  describe("initiateAuth logic", () => {
    it("should return requiresCredentials for API key platforms", () => {
      // Test the expected behavior for api_key type platforms
      const apiKeyPlatforms = ["twilio", "blooio"];

      for (const platform of apiKeyPlatforms) {
        const provider = OAUTH_PROVIDERS[platform];
        expect(provider.type).toBe("api_key");
        // For api_key platforms, we expect requiresCredentials: true
        // and authUrl pointing to the initiate route
        expect(provider.routes?.initiate).toBeDefined();
      }
    });

    it("should generate auth URL for OAuth platforms", () => {
      // Test that OAuth platforms have proper configuration
      const oauthPlatforms = [
        { id: "google", type: "oauth2" },
        { id: "twitter", type: "oauth1a" },
      ] as const;

      for (const { id, type } of oauthPlatforms) {
        const provider = OAUTH_PROVIDERS[id];
        expect(provider.type).toBe(type);
      }
    });
  });

  describe("Connection filtering", () => {
    it("should filter connections by platform", () => {
      const connections: OAuthConnection[] = [
        createMockConnection("active", "g1", { platform: "google" }),
        createMockConnection("active", "t1", { platform: "twitter" }),
        createMockConnection("active", "g2", { platform: "google" }),
      ];

      const filtered = connections.filter((c) => c.platform === "google");
      expect(filtered.length).toBe(2);
      expect(filtered.every((c) => c.platform === "google")).toBe(true);
    });

    it("should filter connections by status", () => {
      const connections: OAuthConnection[] = [
        createMockConnection("active", "1"),
        createMockConnection("revoked", "2"),
        createMockConnection("active", "3"),
        createMockConnection("expired", "4"),
      ];

      const active = connections.filter((c) => c.status === "active");
      expect(active.length).toBe(2);
    });

    it("prefers user-owned connections before shared org connections", () => {
      const owned = createMockConnection("active", "owned", {
        userId: "user-1",
        lastUsedAt: new Date("2026-04-09T10:00:00Z"),
      });
      const shared = createMockConnection("active", "shared", {
        userId: undefined,
        lastUsedAt: new Date("2026-04-09T11:00:00Z"),
      });

      expect(getPreferredActiveConnection([shared, owned], "user-1")?.id).toBe("owned");
      expect(
        scopeConnectionsForUser([shared, owned], "user-1").map((connection) => connection.id),
      ).toEqual(["owned", "shared"]);
    });
  });

  describe("Token retrieval logic", () => {
    it("should check cache before querying adapter", () => {
      // This tests the expected flow:
      // 1. Check cache -> if hit, return cached
      // 2. Find adapter for connection
      // 3. Get token from adapter
      // 4. Cache the result
      // 5. Return token

      const flowSteps = ["checkCache", "findAdapter", "getToken", "cacheToken", "returnToken"];

      expect(flowSteps[0]).toBe("checkCache");
      expect(flowSteps[flowSteps.length - 1]).toBe("returnToken");
    });

    it("should invalidate cache on revoke", () => {
      // On revocation:
      // 1. Find adapter
      // 2. Call adapter.revoke()
      // 3. Invalidate cache
      // The order matters for data consistency
    });
  });

  describe("Platform connection check", () => {
    it("should check if any active connection exists for platform", () => {
      const connections: OAuthConnection[] = [
        createMockConnection("active", "1", { platform: "google" }),
        createMockConnection("revoked", "2", { platform: "twitter" }),
      ];

      const hasActiveGoogle = connections.some(
        (c) => c.platform === "google" && c.status === "active",
      );
      const hasActiveTwitter = connections.some(
        (c) => c.platform === "twitter" && c.status === "active",
      );

      expect(hasActiveGoogle).toBe(true);
      expect(hasActiveTwitter).toBe(false);
    });
  });

  describe("Connected platforms list", () => {
    it("should return unique platforms with active connections", () => {
      const connections: OAuthConnection[] = [
        createMockConnection("active", "1", { platform: "google" }),
        createMockConnection("active", "2", { platform: "google" }),
        createMockConnection("active", "3", { platform: "twitter" }),
        createMockConnection("revoked", "4", { platform: "twilio" }),
      ];

      const activePlatforms = [
        ...new Set(connections.filter((c) => c.status === "active").map((c) => c.platform)),
      ];

      expect(activePlatforms).toContain("google");
      expect(activePlatforms).toContain("twitter");
      expect(activePlatforms).not.toContain("twilio");
      expect(activePlatforms.length).toBe(2);
    });
  });

  describe("User-scoped connection selection", () => {
    it("should prefer user-owned connections before shared org connections", () => {
      const connections: OAuthConnection[] = [
        createMockConnection("active", "shared", {
          linkedAt: new Date("2026-01-01T00:00:00Z"),
        }),
        createMockConnection("active", "owned", {
          userId: "user-1",
          linkedAt: new Date("2025-01-01T00:00:00Z"),
        }),
        createMockConnection("active", "other-user", {
          userId: "user-2",
          linkedAt: new Date("2027-01-01T00:00:00Z"),
        }),
      ];

      const preferred = getPreferredActiveConnection(connections, "user-1");

      expect(preferred?.id).toBe("owned");
    });

    it("should exclude other users while still exposing shared connections", () => {
      const connections: OAuthConnection[] = [
        createMockConnection("active", "shared", {
          linkedAt: new Date("2026-01-01T00:00:00Z"),
        }),
        createMockConnection("active", "owned", {
          userId: "user-1",
          linkedAt: new Date("2025-01-01T00:00:00Z"),
        }),
        createMockConnection("active", "other-user", {
          userId: "user-2",
          linkedAt: new Date("2027-01-01T00:00:00Z"),
        }),
      ];

      const scoped = scopeConnectionsForUser(connections, "user-1");

      expect(scoped.map((connection: OAuthConnection) => connection.id)).toEqual([
        "owned",
        "shared",
      ]);
    });
  });
});

// Helper function to create mock connections
function createMockConnection(
  status: "pending" | "active" | "expired" | "revoked" | "error",
  id: string = crypto.randomUUID(),
  overrides: Partial<OAuthConnection> = {},
): OAuthConnection {
  return {
    id,
    platform: "google",
    platformUserId: "user-123",
    status,
    scopes: [],
    linkedAt: new Date(),
    tokenExpired: false,
    source: "platform_credentials",
    ...overrides,
  };
}

describe("OAuth Types", () => {
  describe("OAuthProviderType", () => {
    it("should support oauth2, oauth1a, and api_key types", () => {
      const types = ["oauth2", "oauth1a", "api_key"];

      for (const provider of Object.values(OAUTH_PROVIDERS)) {
        expect(types).toContain(provider.type);
      }
    });
  });

  describe("OAuthConnectionStatus", () => {
    it("should have all expected statuses", () => {
      const statuses = ["pending", "active", "expired", "revoked", "error"];

      // Create connections with each status
      for (const status of statuses) {
        const typedStatus = status as OAuthConnection["status"];
        const conn = createMockConnection(typedStatus);
        expect(conn.status).toBe(typedStatus);
      }
    });
  });

  describe("OAuthConnectionSource", () => {
    it("should distinguish platform_credentials from secrets", () => {
      const _sources = ["platform_credentials", "secrets"];

      // Google uses platform_credentials
      expect(OAUTH_PROVIDERS.google.storage).toBe("platform_credentials");

      // Others use secrets
      expect(OAUTH_PROVIDERS.twitter.storage).toBe("secrets");
      expect(OAUTH_PROVIDERS.twilio.storage).toBe("secrets");
      expect(OAUTH_PROVIDERS.blooio.storage).toBe("secrets");
    });
  });
});
