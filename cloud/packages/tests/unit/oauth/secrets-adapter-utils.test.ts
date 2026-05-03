/**
 * Secrets Adapter Utils Unit Tests
 *
 * Tests utility functions used by secrets-based connection adapters (Twitter, Twilio, Blooio).
 */

import { describe, expect, it } from "bun:test";
import {
  createSecretsConnection,
  generateConnectionId,
  getEarliestSecretDate,
  ownsConnectionId,
  verifyConnectionId,
} from "@/lib/services/oauth/connection-adapters/secrets-adapter-utils";

describe("Secrets Adapter Utils", () => {
  describe("generateConnectionId", () => {
    it("should generate ID in format platform:organizationId", () => {
      const id = generateConnectionId("twitter", "org-123");
      expect(id).toBe("twitter:org-123");
    });

    it("should work with various platform names", () => {
      const platforms = ["twitter", "twilio", "blooio", "custom"];

      for (const platform of platforms) {
        const id = generateConnectionId(platform, "org-abc");
        expect(id).toBe(`${platform}:org-abc`);
      }
    });

    it("should work with UUIDs as organization IDs", () => {
      const orgId = "550e8400-e29b-41d4-a716-446655440000";
      const id = generateConnectionId("twitter", orgId);
      expect(id).toBe(`twitter:${orgId}`);
    });

    it("should handle special characters in organization ID", () => {
      const orgId = "org_with-special.chars";
      const id = generateConnectionId("twitter", orgId);
      expect(id).toBe(`twitter:${orgId}`);
    });

    it("should handle empty strings", () => {
      const id = generateConnectionId("", "org-123");
      expect(id).toBe(":org-123");

      const id2 = generateConnectionId("twitter", "");
      expect(id2).toBe("twitter:");
    });
  });

  describe("ownsConnectionId", () => {
    it("should return true when ID starts with platform prefix", () => {
      expect(ownsConnectionId("twitter", "twitter:org-123")).toBe(true);
      expect(ownsConnectionId("twilio", "twilio:org-456")).toBe(true);
      expect(ownsConnectionId("blooio", "blooio:org-789")).toBe(true);
    });

    it("should return false when ID does not match platform", () => {
      expect(ownsConnectionId("twitter", "twilio:org-123")).toBe(false);
      expect(ownsConnectionId("twilio", "twitter:org-456")).toBe(false);
      expect(ownsConnectionId("blooio", "google:org-789")).toBe(false);
    });

    it("should return false for UUID-style IDs (Google format)", () => {
      const uuidId = "550e8400-e29b-41d4-a716-446655440000";
      expect(ownsConnectionId("twitter", uuidId)).toBe(false);
      expect(ownsConnectionId("google", uuidId)).toBe(false);
    });

    it("should handle partial matches correctly", () => {
      // Should not match if platform is just a prefix
      expect(ownsConnectionId("twi", "twitter:org-123")).toBe(false);
      expect(ownsConnectionId("twitter", "twitter_variant:org-123")).toBe(false);
    });

    it("should handle edge cases", () => {
      expect(ownsConnectionId("twitter", "")).toBe(false);
      expect(ownsConnectionId("", "twitter:org-123")).toBe(false);
      expect(ownsConnectionId("twitter", "twitter:")).toBe(true); // Starts with twitter:
    });
  });

  describe("verifyConnectionId", () => {
    it("should not throw when connection ID matches expected format", () => {
      expect(() => {
        verifyConnectionId("twitter", "org-123", "twitter:org-123");
      }).not.toThrow();
    });

    it("should throw CONNECTION_NOT_FOUND when ID does not match", () => {
      expect(() => {
        verifyConnectionId("twitter", "org-123", "twitter:org-456");
      }).toThrow();

      try {
        verifyConnectionId("twitter", "org-123", "twitter:org-456");
      } catch (error) {
        expect((error as Error).message).toContain("twitter:org-456");
      }
    });

    it("should throw when platform does not match", () => {
      expect(() => {
        verifyConnectionId("twitter", "org-123", "twilio:org-123");
      }).toThrow();
    });

    it("should throw when organization ID does not match", () => {
      expect(() => {
        verifyConnectionId("twitter", "org-123", "twitter:org-different");
      }).toThrow();
    });

    it("should throw when connection ID is malformed", () => {
      expect(() => {
        verifyConnectionId("twitter", "org-123", "invalid-format");
      }).toThrow();
    });

    it("should throw when connection ID is a UUID (wrong format)", () => {
      expect(() => {
        verifyConnectionId("twitter", "org-123", "550e8400-e29b-41d4-a716-446655440000");
      }).toThrow();
    });
  });

  describe("getEarliestSecretDate", () => {
    it("should return earliest date from array", () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 3600000);
      const oneDayAgo = new Date(now.getTime() - 86400000);

      const secrets = [{ created_at: now }, { created_at: oneHourAgo }, { created_at: oneDayAgo }];

      const earliest = getEarliestSecretDate(secrets);
      expect(earliest.getTime()).toBe(oneDayAgo.getTime());
    });

    it("should return current date for empty array", () => {
      const before = Date.now();
      const earliest = getEarliestSecretDate([]);
      const after = Date.now();

      expect(earliest.getTime()).toBeGreaterThanOrEqual(before);
      expect(earliest.getTime()).toBeLessThanOrEqual(after);
    });

    it("should return the single date for array of one", () => {
      const date = new Date("2024-01-15T12:00:00Z");
      const secrets = [{ created_at: date }];

      const earliest = getEarliestSecretDate(secrets);
      expect(earliest.getTime()).toBe(date.getTime());
    });

    it("should handle dates as Date objects", () => {
      const date1 = new Date("2024-01-01");
      const date2 = new Date("2024-06-01");

      const secrets = [{ created_at: date1 }, { created_at: date2 }];
      const earliest = getEarliestSecretDate(secrets);

      expect(earliest.getTime()).toBe(date1.getTime());
    });

    it("should handle identical dates", () => {
      const date = new Date("2024-01-15");
      const secrets = [{ created_at: date }, { created_at: date }, { created_at: date }];

      const earliest = getEarliestSecretDate(secrets);
      expect(earliest.getTime()).toBe(date.getTime());
    });
  });

  describe("createSecretsConnection", () => {
    it("should create connection with required fields", () => {
      const linkedAt = new Date("2024-01-15T12:00:00Z");
      const conn = createSecretsConnection("twitter", "org-123", linkedAt);

      expect(conn.id).toBe("twitter:org-123");
      expect(conn.platform).toBe("twitter");
      expect(conn.platformUserId).toBe("unknown");
      expect(conn.status).toBe("active");
      expect(conn.scopes).toEqual([]);
      expect(conn.linkedAt).toBe(linkedAt);
      expect(conn.tokenExpired).toBe(false);
      expect(conn.source).toBe("secrets");
    });

    it("should allow overriding fields", () => {
      const linkedAt = new Date("2024-01-15T12:00:00Z");
      const conn = createSecretsConnection("twitter", "org-123", linkedAt, {
        platformUserId: "user-456",
        username: "testuser",
        displayName: "@testuser",
        email: "test@example.com",
      });

      expect(conn.platformUserId).toBe("user-456");
      expect(conn.username).toBe("testuser");
      expect(conn.displayName).toBe("@testuser");
      expect(conn.email).toBe("test@example.com");
    });

    it("should not allow overriding generated ID", () => {
      const linkedAt = new Date();
      // TypeScript now prevents passing `id` in overrides, but we can test
      // the runtime behavior by casting
      const conn = createSecretsConnection("twitter", "org-123", linkedAt, {
        // @ts-expect-error - Testing that id override is ignored at runtime
        id: "custom-id",
      });

      // The ID must always be generated from platform:orgId - never from overrides
      // This prevents connection ID tampering/confusion attacks
      expect(conn.id).toBe("twitter:org-123");
    });

    it("should work with all platform types", () => {
      const platforms = ["twitter", "twilio", "blooio"];
      const linkedAt = new Date();

      for (const platform of platforms) {
        const conn = createSecretsConnection(platform, "org-test", linkedAt);
        expect(conn.id).toBe(`${platform}:org-test`);
        expect(conn.platform).toBe(platform);
        expect(conn.source).toBe("secrets");
      }
    });

    it("should allow setting status in overrides", () => {
      const linkedAt = new Date();
      const conn = createSecretsConnection("twitter", "org-123", linkedAt, {
        status: "expired",
      });

      expect(conn.status).toBe("expired");
    });

    it("should allow setting scopes in overrides", () => {
      const linkedAt = new Date();
      const conn = createSecretsConnection("twitter", "org-123", linkedAt, {
        scopes: ["read", "write"],
      });

      expect(conn.scopes).toEqual(["read", "write"]);
    });

    it("should allow setting lastUsedAt in overrides", () => {
      const linkedAt = new Date("2024-01-01");
      const lastUsedAt = new Date("2024-06-15");
      const conn = createSecretsConnection("twitter", "org-123", linkedAt, {
        lastUsedAt,
      });

      expect(conn.lastUsedAt).toBe(lastUsedAt);
    });

    it("should not have lastUsedAt by default", () => {
      const linkedAt = new Date();
      const conn = createSecretsConnection("twitter", "org-123", linkedAt);

      expect(conn.lastUsedAt).toBeUndefined();
    });
  });
});

describe("Connection ID Format Compatibility", () => {
  it("should distinguish secrets-based IDs from platform_credentials IDs", () => {
    const secretsId = "twitter:550e8400-e29b-41d4-a716-446655440000";
    const platformCredentialsId = "550e8400-e29b-41d4-a716-446655440000";

    // Secrets adapters should own colon-prefixed IDs
    expect(ownsConnectionId("twitter", secretsId)).toBe(true);
    expect(ownsConnectionId("google", secretsId)).toBe(false);

    // Secrets adapters should NOT own UUID-style IDs
    expect(ownsConnectionId("twitter", platformCredentialsId)).toBe(false);
    expect(ownsConnectionId("google", platformCredentialsId)).toBe(false);
  });

  it("should handle various organization ID formats", () => {
    const orgIdFormats = [
      "simple-id",
      "550e8400-e29b-41d4-a716-446655440000",
      "org_with_underscore",
      "ORG-UPPERCASE",
      "123456789",
    ];

    for (const orgId of orgIdFormats) {
      const connectionId = generateConnectionId("twitter", orgId);
      expect(ownsConnectionId("twitter", connectionId)).toBe(true);
      expect(() => {
        verifyConnectionId("twitter", orgId, connectionId);
      }).not.toThrow();
    }
  });
});
