/**
 * OAuth API Integration Tests
 *
 * Tests the OAuth API endpoints:
 * - GET /api/v1/oauth/providers
 * - POST /api/v1/oauth/connect
 * - GET /api/v1/oauth/connections
 * - GET /api/v1/oauth/connections/:id
 * - DELETE /api/v1/oauth/connections/:id
 * - GET /api/v1/oauth/connections/:id/token (removed, should 404)
 * - GET /api/v1/oauth/token/:platform (removed, should 404)
 *
 * Test Modes:
 * 1. API Tests (default): Tests API structure, auth, error handling
 * 2. Full Integration (with real credentials): Tests actual OAuth flows
 *
 * Requirements:
 * - DATABASE_URL: PostgreSQL connection string
 * - SECRETS_LOCAL_KEY: For encryption (or AWS KMS configured)
 * - Server running at TEST_BASE_URL (default: http://localhost:3000)
 *
 * Optional (for full integration):
 * - GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for Google OAuth
 * - A pre-connected Google account for token tests
 */

import { afterAll, beforeAll, it as bunIt, describe, expect } from "bun:test";
import { Client } from "pg";
import { createEncryptionService } from "@/lib/services/secrets/encryption";
import {
  cleanupTestData,
  createTestDataSet,
  type TestDataSet,
} from "../infrastructure/test-data-factory";

const TEST_DB_URL = process.env.DATABASE_URL || "";
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";
// Use a wider request timeout because these E2E tests run against a managed
// Next dev server that may restart or recompile routes between requests.
const TIMEOUT = 60000;

const encryptionService = createEncryptionService();
let secretsClient: Client | null = null;
const it = (name: string, fn: () => void | Promise<void>) => bunIt(name, fn, TIMEOUT);
const twitterOwnerConnectionId = (organizationId: string) => `twitter:${organizationId}:owner`;

describe.skipIf(!TEST_DB_URL)("OAuth API E2E Tests", () => {
  let testData: TestDataSet;
  let client: Client;

  beforeAll(async () => {
    if (!TEST_DB_URL) {
      throw new Error("DATABASE_URL is required for integration tests");
    }

    testData = await createTestDataSet(TEST_DB_URL, {
      organizationName: "OAuth Test Org",
      creditBalance: 1000,
    });

    client = new Client({ connectionString: TEST_DB_URL });
    await client.connect();
    secretsClient = client;
  });

  afterAll(async () => {
    // Clean up platform credentials and secrets
    await client.query(`DELETE FROM platform_credentials WHERE organization_id = $1`, [
      testData.organization.id,
    ]);
    await client.query(`DELETE FROM secrets WHERE organization_id = $1`, [
      testData.organization.id,
    ]);
    await client.end();
    secretsClient = null;
    await cleanupTestData(TEST_DB_URL, testData.organization.id);
  });

  // ============================================================================
  // GET /api/v1/oauth/providers
  // ============================================================================
  describe("GET /api/v1/oauth/providers", () => {
    it("should list all available providers without auth (public endpoint)", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/providers`, {
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("providers");
      expect(Array.isArray(data.providers)).toBe(true);

      // Should include expected providers
      const providerIds = data.providers.map((p: { id: string }) => p.id);
      expect(providerIds).toContain("google");
      expect(providerIds).toContain("twitter");
      expect(providerIds).toContain("twilio");
      expect(providerIds).toContain("blooio");

      // Discord should NOT be included (excluded by design)
      expect(providerIds).not.toContain("discord");
    });

    it("should include configuration status for each provider", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/providers`);
      const data = await response.json();

      for (const provider of data.providers) {
        expect(provider).toHaveProperty("id");
        expect(provider).toHaveProperty("name");
        expect(provider).toHaveProperty("description");
        expect(provider).toHaveProperty("type");
        expect(provider).toHaveProperty("configured");
        expect(typeof provider.configured).toBe("boolean");
      }
    });

    it("should show Google as configured when env vars are set", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/providers`);
      const data = await response.json();

      const googleProvider = data.providers.find((p: { id: string }) => p.id === "google");

      // Google should be configured if GOOGLE_CLIENT_ID is set
      if (process.env.GOOGLE_CLIENT_ID) {
        expect(googleProvider.configured).toBe(true);
      }
    });

    it("should return correct OAuth types for each provider", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/providers`);
      const data = await response.json();

      const providerTypes: Record<string, string> = {
        google: "oauth2",
        twitter: "oauth1a",
        twilio: "api_key",
        blooio: "api_key",
      };

      for (const [id, expectedType] of Object.entries(providerTypes)) {
        const provider = data.providers.find((p: { id: string }) => p.id === id);
        expect(provider).toBeDefined();
        expect(provider.type).toBe(expectedType);
      }
    });

    it("should show API key providers (twilio, blooio) as always configured", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/providers`);
      const data = await response.json();

      const twilioProvider = data.providers.find((p: { id: string }) => p.id === "twilio");
      const blooioProvider = data.providers.find((p: { id: string }) => p.id === "blooio");

      // API key providers are always "configured" since users provide their own credentials
      expect(twilioProvider.configured).toBe(true);
      expect(blooioProvider.configured).toBe(true);
    });

    it("should include default scopes for OAuth2 providers", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/providers`);
      const data = await response.json();

      const googleProvider = data.providers.find((p: { id: string }) => p.id === "google");
      expect(googleProvider).toHaveProperty("defaultScopes");
      expect(Array.isArray(googleProvider.defaultScopes)).toBe(true);
      expect(googleProvider.defaultScopes.length).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // POST /api/v1/oauth/connect
  // ============================================================================
  describe("POST /api/v1/oauth/connect", () => {
    it("should return 401 without authentication", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "google" }),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(401);
    });

    it("should return 400 when platform is missing", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connect`, {
        method: "POST",
        headers: {
          "X-API-Key": testData.apiKey.key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("VALIDATION_ERROR");
    });

    it("should return 400 when platform is empty string", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connect`, {
        method: "POST",
        headers: {
          "X-API-Key": testData.apiKey.key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ platform: "" }),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(400);
    });

    it("should return error for unsupported platform", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connect`, {
        method: "POST",
        headers: {
          "X-API-Key": testData.apiKey.key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ platform: "unsupported_platform" }),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.code).toBe("PLATFORM_NOT_SUPPORTED");
      expect(data.reconnectRequired).toBe(false);
    });

    it("should return error for explicitly excluded platform (discord)", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connect`, {
        method: "POST",
        headers: {
          "X-API-Key": testData.apiKey.key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ platform: "discord" }),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.code).toBe("PLATFORM_NOT_SUPPORTED");
    });

    it("should return auth URL for Google when configured", async () => {
      if (!process.env.GOOGLE_CLIENT_ID) {
        console.log("Skipping: GOOGLE_CLIENT_ID not set");
        return;
      }

      const response = await fetch(`${BASE_URL}/api/v1/oauth/connect`, {
        method: "POST",
        headers: {
          "X-API-Key": testData.apiKey.key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          platform: "google",
          redirectUrl: "/dashboard/settings",
        }),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("authUrl");
      expect(data.authUrl).toContain("accounts.google.com");
      expect(data.authUrl).toContain("oauth2");
      expect(data).toHaveProperty("state");
      expect(typeof data.state).toBe("string");
      expect(data.state.length).toBeGreaterThan(0);
    });

    it("should include custom scopes in Google auth URL when provided", async () => {
      if (!process.env.GOOGLE_CLIENT_ID) {
        console.log("Skipping: GOOGLE_CLIENT_ID not set");
        return;
      }

      const customScopes = ["https://www.googleapis.com/auth/gmail.send"];
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connect`, {
        method: "POST",
        headers: {
          "X-API-Key": testData.apiKey.key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          platform: "google",
          scopes: customScopes,
        }),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.authUrl).toContain("scope=");
      expect(data.authUrl).toContain(encodeURIComponent(customScopes[0]));
    });

    it("should return requiresCredentials for API key platforms", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connect`, {
        method: "POST",
        headers: {
          "X-API-Key": testData.apiKey.key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ platform: "twilio" }),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.requiresCredentials).toBe(true);
      expect(data.authUrl).toContain("/api/v1/twilio/connect");
    });

    it("should return requiresCredentials for Blooio (API key)", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connect`, {
        method: "POST",
        headers: {
          "X-API-Key": testData.apiKey.key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ platform: "blooio" }),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.requiresCredentials).toBe(true);
      expect(data.authUrl).toContain("/api/v1/blooio/connect");
    });

    it("should handle very long platform names", async () => {
      const longPlatform = "a".repeat(1000);
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connect`, {
        method: "POST",
        headers: {
          "X-API-Key": testData.apiKey.key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ platform: longPlatform }),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.code).toBe("PLATFORM_NOT_SUPPORTED");
    });

    it("should handle platform with special characters", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connect`, {
        method: "POST",
        headers: {
          "X-API-Key": testData.apiKey.key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ platform: "google<script>alert(1)</script>" }),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.code).toBe("PLATFORM_NOT_SUPPORTED");
    });
  });

  // ============================================================================
  // GET /api/v1/oauth/connections
  // ============================================================================
  describe("GET /api/v1/oauth/connections", () => {
    it("should return 401 without authentication", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections`, {
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(401);
    });

    it("should return empty connections list initially", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("connections");
      expect(Array.isArray(data.connections)).toBe(true);
    });

    it("should filter by platform when specified", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections?platform=google`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("connections");

      // All returned connections should be Google
      for (const conn of data.connections) {
        expect(conn.platform).toBe("google");
      }
    });

    it("should handle invalid platform filter gracefully", async () => {
      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/connections?platform=invalid_platform`,
        {
          headers: {
            "X-API-Key": testData.apiKey.key,
          },
          signal: AbortSignal.timeout(TIMEOUT),
        },
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.connections).toEqual([]);
    });

    it("should return connections from platform_credentials (Google)", async () => {
      // Insert a mock Google connection
      const credId = crypto.randomUUID();
      await client.query(
        `INSERT INTO platform_credentials 
         (id, organization_id, platform, platform_user_id, platform_email, status, scopes, created_at, updated_at)
         VALUES ($1, $2, 'google', 'google-user-123', 'test@gmail.com', 'active', '["gmail.send"]', NOW(), NOW())`,
        [credId, testData.organization.id],
      );

      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections?platform=google`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.connections.length).toBeGreaterThan(0);

      const googleConn = data.connections.find((c: { id: string }) => c.id === credId);
      expect(googleConn).toBeDefined();
      expect(googleConn.platform).toBe("google");
      expect(googleConn.source).toBe("platform_credentials");

      // Cleanup
      await client.query(`DELETE FROM platform_credentials WHERE id = $1`, [credId]);
    });

    it("should return connections from secrets (Twitter)", async () => {
      // Insert mock Twitter secrets
      await createTestSecret(
        testData.organization.id,
        testData.user.id,
        "TWITTER_ACCESS_TOKEN",
        "test_access_token",
      );
      await createTestSecret(
        testData.organization.id,
        testData.user.id,
        "TWITTER_ACCESS_TOKEN_SECRET",
        "test_access_secret",
      );
      await createTestSecret(
        testData.organization.id,
        testData.user.id,
        "TWITTER_USERNAME",
        "testuser",
      );

      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections?platform=twitter`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.connections.length).toBeGreaterThan(0);

      const twitterConn = data.connections.find(
        (c: { platform: string }) => c.platform === "twitter",
      );
      expect(twitterConn).toBeDefined();
      expect(twitterConn.source).toBe("secrets");
      expect(twitterConn.id).toBe(twitterOwnerConnectionId(testData.organization.id));

      // Cleanup
      await client.query(
        `DELETE FROM secrets WHERE organization_id = $1 AND name LIKE 'TWITTER_%'`,
        [testData.organization.id],
      );
    });

    it("should return Twilio connections from secrets", async () => {
      await createTestSecret(
        testData.organization.id,
        testData.user.id,
        "TWILIO_ACCOUNT_SID",
        "ACtest123456",
      );
      await createTestSecret(
        testData.organization.id,
        testData.user.id,
        "TWILIO_AUTH_TOKEN",
        "test_auth_token",
      );

      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections?platform=twilio`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.connections.length).toBeGreaterThan(0);

      const twilioConn = data.connections.find(
        (c: { platform: string }) => c.platform === "twilio",
      );
      expect(twilioConn).toBeDefined();
      expect(twilioConn.source).toBe("secrets");
      expect(twilioConn.id).toBe(`twilio:${testData.organization.id}`);

      await client.query(
        `DELETE FROM secrets WHERE organization_id = $1 AND name LIKE 'TWILIO_%'`,
        [testData.organization.id],
      );
    });

    it("should return Blooio connections from secrets", async () => {
      await createTestSecret(
        testData.organization.id,
        testData.user.id,
        "BLOOIO_API_KEY",
        "test_blooio_key",
      );

      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections?platform=blooio`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.connections.length).toBeGreaterThan(0);

      const blooioConn = data.connections.find(
        (c: { platform: string }) => c.platform === "blooio",
      );
      expect(blooioConn).toBeDefined();
      expect(blooioConn.source).toBe("secrets");
      expect(blooioConn.id).toBe(`blooio:${testData.organization.id}`);

      await client.query(
        `DELETE FROM secrets WHERE organization_id = $1 AND name LIKE 'BLOOIO_%'`,
        [testData.organization.id],
      );
    });

    it("should return connections sorted by most recently used", async () => {
      const credId1 = crypto.randomUUID();
      const credId2 = crypto.randomUUID();
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 3600000);

      await client.query(
        `INSERT INTO platform_credentials 
         (id, organization_id, platform, platform_user_id, status, scopes, created_at, updated_at, last_used_at)
         VALUES ($1, $2, 'google', 'user-old', 'active', '[]', $3, $3, $3)`,
        [credId1, testData.organization.id, oneHourAgo],
      );
      await client.query(
        `INSERT INTO platform_credentials 
         (id, organization_id, platform, platform_user_id, status, scopes, created_at, updated_at, last_used_at)
         VALUES ($1, $2, 'google', 'user-recent', 'active', '[]', $3, $3, $3)`,
        [credId2, testData.organization.id, now],
      );

      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections?platform=google`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.connections.length).toBeGreaterThanOrEqual(2);

      // Most recent should be first
      const firstConn = data.connections[0];
      expect(firstConn.platformUserId).toBe("user-recent");

      await client.query(`DELETE FROM platform_credentials WHERE id IN ($1, $2)`, [
        credId1,
        credId2,
      ]);
    });

    it("should return connections with all expected fields", async () => {
      const credId = crypto.randomUUID();
      await client.query(
        `INSERT INTO platform_credentials 
         (id, organization_id, platform, platform_user_id, platform_email, platform_username, 
          platform_display_name, platform_avatar_url, status, scopes, 
          linked_at, last_used_at, token_expires_at, created_at, updated_at)
         VALUES ($1, $2, 'google', 'user-123', 'test@gmail.com', 'testuser', 
                 'Test User', 'https://example.com/avatar.jpg', 'active', '["gmail.send"]',
                 NOW(), NOW(), NOW() + INTERVAL '1 hour', NOW(), NOW())`,
        [credId, testData.organization.id],
      );

      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections/${credId}`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      const conn = data.connection;

      expect(conn.id).toBe(credId);
      expect(conn.platform).toBe("google");
      expect(conn.platformUserId).toBe("user-123");
      expect(conn.email).toBe("test@gmail.com");
      expect(conn.username).toBe("testuser");
      expect(conn.displayName).toBe("Test User");
      expect(conn.avatarUrl).toBe("https://example.com/avatar.jpg");
      expect(conn.status).toBe("active");
      expect(conn.scopes).toContain("gmail.send");
      expect(conn.linkedAt).toBeDefined();
      expect(conn.lastUsedAt).toBeDefined();
      expect(conn.source).toBe("platform_credentials");

      await client.query(`DELETE FROM platform_credentials WHERE id = $1`, [credId]);
    });

    it("should include tokenExpired field correctly", async () => {
      const credId = crypto.randomUUID();
      const expiredTime = new Date(Date.now() - 3600000); // 1 hour ago

      await client.query(
        `INSERT INTO platform_credentials 
         (id, organization_id, platform, platform_user_id, status, scopes, 
          token_expires_at, created_at, updated_at)
         VALUES ($1, $2, 'google', 'user-expired', 'active', '[]', $3, NOW(), NOW())`,
        [credId, testData.organization.id, expiredTime],
      );

      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections/${credId}`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.connection.tokenExpired).toBe(true);

      await client.query(`DELETE FROM platform_credentials WHERE id = $1`, [credId]);
    });
  });

  // ============================================================================
  // GET /api/v1/oauth/connections/:id
  // ============================================================================
  describe("GET /api/v1/oauth/connections/:id", () => {
    it("should return 401 without authentication", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections/some-id`, {
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(401);
    });

    it("should return 404 for non-existent connection", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections/${crypto.randomUUID()}`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.code).toBe("CONNECTION_NOT_FOUND");
    });

    it("should return 404 for malformed UUID connection ID", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections/not-a-valid-uuid`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(404);
    });

    it("should return 404 for empty connection ID", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections/`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      // Should either be 404 or redirect to connections list
      expect([200, 404, 308]).toContain(response.status);
    });

    it("should return connection details for valid ID", async () => {
      // Insert a mock Google connection
      const credId = crypto.randomUUID();
      await client.query(
        `INSERT INTO platform_credentials 
         (id, organization_id, platform, platform_user_id, platform_email, status, scopes, created_at, updated_at)
         VALUES ($1, $2, 'google', 'google-user-456', 'test2@gmail.com', 'active', '[]', NOW(), NOW())`,
        [credId, testData.organization.id],
      );

      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections/${credId}`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("connection");
      expect(data.connection.id).toBe(credId);
      expect(data.connection.platform).toBe("google");
      expect(data.connection.email).toBe("test2@gmail.com");

      // Cleanup
      await client.query(`DELETE FROM platform_credentials WHERE id = $1`, [credId]);
    });

    it("should return connection for secrets-based adapter (Twitter)", async () => {
      await createTestSecret(
        testData.organization.id,
        testData.user.id,
        "TWITTER_ACCESS_TOKEN",
        "test_token",
      );
      await createTestSecret(
        testData.organization.id,
        testData.user.id,
        "TWITTER_USERNAME",
        "testuser",
      );

      const connectionId = twitterOwnerConnectionId(testData.organization.id);
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections/${connectionId}`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.connection.id).toBe(connectionId);
      expect(data.connection.platform).toBe("twitter");
      expect(data.connection.username).toBe("testuser");

      await client.query(
        `DELETE FROM secrets WHERE organization_id = $1 AND name LIKE 'TWITTER_%'`,
        [testData.organization.id],
      );
    });

    it("should not return connection from another organization", async () => {
      // Create another organization's connection
      const otherOrg = await createTestDataSet(TEST_DB_URL, {
        organizationName: "Other Org",
        creditBalance: 100,
      });

      const credId = crypto.randomUUID();
      await client.query(
        `INSERT INTO platform_credentials 
         (id, organization_id, platform, platform_user_id, status, scopes, created_at, updated_at)
         VALUES ($1, $2, 'google', 'other-user', 'active', '[]', NOW(), NOW())`,
        [credId, otherOrg.organization.id],
      );

      // Try to access with our API key
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections/${credId}`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(404);

      // Cleanup
      await client.query(`DELETE FROM platform_credentials WHERE id = $1`, [credId]);
      await cleanupTestData(TEST_DB_URL, otherOrg.organization.id);
    });
  });

  // ============================================================================
  // DELETE /api/v1/oauth/connections/:id
  // ============================================================================
  describe("DELETE /api/v1/oauth/connections/:id", () => {
    it("should return 401 without authentication", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections/some-id`, {
        method: "DELETE",
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(401);
    });

    it("should return 404 for non-existent connection", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections/${crypto.randomUUID()}`, {
        method: "DELETE",
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(404);
    });

    it("should revoke Google connection and mark as revoked", async () => {
      // Insert a mock Google connection
      const credId = crypto.randomUUID();
      await client.query(
        `INSERT INTO platform_credentials 
         (id, organization_id, platform, platform_user_id, status, scopes, created_at, updated_at)
         VALUES ($1, $2, 'google', 'google-user-789', 'active', '[]', NOW(), NOW())`,
        [credId, testData.organization.id],
      );

      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections/${credId}`, {
        method: "DELETE",
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify status changed to revoked
      const result = await client.query(
        `SELECT status, revoked_at FROM platform_credentials WHERE id = $1`,
        [credId],
      );
      expect(result.rows[0].status).toBe("revoked");
      expect(result.rows[0].revoked_at).toBeDefined();

      // Cleanup
      await client.query(`DELETE FROM platform_credentials WHERE id = $1`, [credId]);
    });

    it("should delete Twitter secrets when revoking", async () => {
      // Insert mock Twitter secrets
      await createTestSecret(
        testData.organization.id,
        testData.user.id,
        "TWITTER_ACCESS_TOKEN",
        "test_token_to_delete",
      );
      await createTestSecret(
        testData.organization.id,
        testData.user.id,
        "TWITTER_ACCESS_TOKEN_SECRET",
        "test_secret_to_delete",
      );

      const connectionId = twitterOwnerConnectionId(testData.organization.id);
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections/${connectionId}`, {
        method: "DELETE",
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(200);

      // Verify secrets were deleted
      const result = await client.query(
        `SELECT COUNT(*) FROM secrets WHERE organization_id = $1 AND name LIKE 'TWITTER_%'`,
        [testData.organization.id],
      );
      expect(parseInt(result.rows[0].count)).toBe(0);
    });

    it("should delete Twilio secrets when revoking", async () => {
      await createTestSecret(
        testData.organization.id,
        testData.user.id,
        "TWILIO_ACCOUNT_SID",
        "ACtest_to_delete",
      );
      await createTestSecret(
        testData.organization.id,
        testData.user.id,
        "TWILIO_AUTH_TOKEN",
        "token_to_delete",
      );
      await createTestSecret(
        testData.organization.id,
        testData.user.id,
        "TWILIO_PHONE_NUMBER",
        "+15551234567",
      );

      const connectionId = `twilio:${testData.organization.id}`;
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections/${connectionId}`, {
        method: "DELETE",
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(200);

      const result = await client.query(
        `SELECT COUNT(*) FROM secrets WHERE organization_id = $1 AND name LIKE 'TWILIO_%'`,
        [testData.organization.id],
      );
      expect(parseInt(result.rows[0].count)).toBe(0);
    });

    it("should delete Blooio secrets when revoking", async () => {
      await createTestSecret(
        testData.organization.id,
        testData.user.id,
        "BLOOIO_API_KEY",
        "api_key_to_delete",
      );
      await createTestSecret(
        testData.organization.id,
        testData.user.id,
        "BLOOIO_WEBHOOK_SECRET",
        "webhook_secret",
      );

      const connectionId = `blooio:${testData.organization.id}`;
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections/${connectionId}`, {
        method: "DELETE",
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(200);

      const result = await client.query(
        `SELECT COUNT(*) FROM secrets WHERE organization_id = $1 AND name LIKE 'BLOOIO_%'`,
        [testData.organization.id],
      );
      expect(parseInt(result.rows[0].count)).toBe(0);
    });

    it("should not allow revoking another organization's connection", async () => {
      const otherOrg = await createTestDataSet(TEST_DB_URL, {
        organizationName: "Other Org Delete Test",
        creditBalance: 100,
      });

      const credId = crypto.randomUUID();
      await client.query(
        `INSERT INTO platform_credentials 
         (id, organization_id, platform, platform_user_id, status, scopes, created_at, updated_at)
         VALUES ($1, $2, 'google', 'other-user', 'active', '[]', NOW(), NOW())`,
        [credId, otherOrg.organization.id],
      );

      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections/${credId}`, {
        method: "DELETE",
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(404);

      // Verify connection was not deleted
      const result = await client.query(`SELECT status FROM platform_credentials WHERE id = $1`, [
        credId,
      ]);
      expect(result.rows[0].status).toBe("active");

      // Cleanup
      await client.query(`DELETE FROM platform_credentials WHERE id = $1`, [credId]);
      await cleanupTestData(TEST_DB_URL, otherOrg.organization.id);
    });
  });

  // ============================================================================
  // GET /api/v1/oauth/connections/:id/token
  // ============================================================================
  describe("GET /api/v1/oauth/connections/:id/token", () => {
    it("should return 401 without authentication", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections/some-id/token`, {
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(401);
    });

    it("should return 404 for authenticated requests to removed route", async () => {
      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/connections/${crypto.randomUUID()}/token`,
        {
          headers: {
            "X-API-Key": testData.apiKey.key,
          },
          signal: AbortSignal.timeout(TIMEOUT),
        },
      );

      expect(response.status).toBe(404);
      expect((await response.json()) as { error: string }).toEqual({ error: "Not Found" });
    });

    it("should return 404 even when a secrets-backed connection exists", async () => {
      const connectionId = twitterOwnerConnectionId(testData.organization.id);
      await createTestSecret(
        testData.organization.id,
        testData.user.id,
        "TWITTER_ACCESS_TOKEN",
        "oauth1_access_token",
      );
      await createTestSecret(
        testData.organization.id,
        testData.user.id,
        "TWITTER_ACCESS_TOKEN_SECRET",
        "oauth1_access_secret",
      );

      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections/${connectionId}/token`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(404);
      expect((await response.json()) as { error: string }).toEqual({ error: "Not Found" });
      await client.query(
        `DELETE FROM secrets WHERE organization_id = $1 AND name LIKE 'TWITTER_%'`,
        [testData.organization.id],
      );
    });

    it("should return 404 even when a platform credential exists", async () => {
      const credId = crypto.randomUUID();
      await client.query(
        `INSERT INTO platform_credentials
         (id, organization_id, platform, platform_user_id, status, scopes, created_at, updated_at)
         VALUES ($1, $2, 'google', 'active-user', 'active', '[]', NOW(), NOW())`,
        [credId, testData.organization.id],
      );

      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections/${credId}/token`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(404);
      expect((await response.json()) as { error: string }).toEqual({ error: "Not Found" });

      await client.query(`DELETE FROM platform_credentials WHERE id = $1`, [credId]);
    });

    it("should return 404 for malformed connection IDs", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections/not-a-valid-uuid/token`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(404);
      expect((await response.json()) as { error: string }).toEqual({ error: "Not Found" });
    });
  });

  // ============================================================================
  // GET /api/v1/oauth/token/:platform
  // ============================================================================
  describe("GET /api/v1/oauth/token/:platform", () => {
    it("should return 401 without authentication", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/token/google`, {
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(401);
    });

    it("should return 404 for supported platforms", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/token/google`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(404);
      expect((await response.json()) as { error: string }).toEqual({ error: "Not Found" });
    });

    it("should return 404 for unsupported platforms", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/token/unsupported`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(404);
      expect((await response.json()) as { error: string }).toEqual({ error: "Not Found" });
    });

    it("should return 404 for mixed-case platform names", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/token/GOOGLE`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(404);
      expect((await response.json()) as { error: string }).toEqual({ error: "Not Found" });
    });
  });

  // ============================================================================
  // Error Handling Tests
  // ============================================================================
  describe("Error Handling", () => {
    it("should return removed-route payload for authenticated token requests", async () => {
      const connectionId = twitterOwnerConnectionId(testData.organization.id);
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections/${connectionId}/token`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(404);
      expect((await response.json()) as { error: string }).toEqual({ error: "Not Found" });
    });

    it("should handle invalid JSON in request body", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connect`, {
        method: "POST",
        headers: {
          "X-API-Key": testData.apiKey.key,
          "Content-Type": "application/json",
        },
        body: "{ invalid json }",
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(400);
    });

    it("should handle empty request body", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connect`, {
        method: "POST",
        headers: {
          "X-API-Key": testData.apiKey.key,
          "Content-Type": "application/json",
        },
        body: "",
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(400);
    });

    it("should return proper error structure for removed token routes", async () => {
      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/connections/${crypto.randomUUID()}/token`,
        {
          headers: {
            "X-API-Key": testData.apiKey.key,
          },
          signal: AbortSignal.timeout(TIMEOUT),
        },
      );

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data).toEqual({ error: "Not Found" });
    });

    it("should return 404 payload for all invalid connection formats", async () => {
      const invalidIds = ["invalid", "12345", "null", "undefined"];

      for (const invalidId of invalidIds) {
        const response = await fetch(`${BASE_URL}/api/v1/oauth/connections/${invalidId}/token`, {
          headers: {
            "X-API-Key": testData.apiKey.key,
          },
          signal: AbortSignal.timeout(TIMEOUT),
        });

        expect(response.status).toBe(404);
        expect((await response.json()) as { error: string }).toEqual({ error: "Not Found" });
      }
    });
  });

  // ============================================================================
  // Concurrent Request Tests
  // ============================================================================
  describe("Concurrent Requests", () => {
    it("should handle concurrent requests to removed token endpoint", async () => {
      const requests = Array(5)
        .fill(null)
        .map(() =>
          fetch(`${BASE_URL}/api/v1/oauth/connections/${crypto.randomUUID()}/token`, {
            headers: {
              "X-API-Key": testData.apiKey.key,
            },
            signal: AbortSignal.timeout(TIMEOUT),
          }),
        );

      const results = await Promise.all(requests);

      for (const response of results) {
        expect(response.status).toBe(404);
        expect((await response.json()) as { error: string }).toEqual({ error: "Not Found" });
      }
    });

    it("should handle concurrent connection list requests", async () => {
      const requests = Array(5)
        .fill(null)
        .map(() =>
          fetch(`${BASE_URL}/api/v1/oauth/connections`, {
            headers: {
              "X-API-Key": testData.apiKey.key,
            },
            signal: AbortSignal.timeout(TIMEOUT),
          }).then((r) => r.json()),
        );

      const results = await Promise.all(requests);

      // All should succeed and return arrays
      for (const result of results) {
        expect(Array.isArray(result.connections)).toBe(true);
      }
    });
  });

  // ============================================================================
  // Connection Status Tests
  // ============================================================================
  describe("Connection Status Handling", () => {
    it("should handle all connection statuses correctly", async () => {
      const statuses = ["pending", "active", "expired", "revoked", "error"];
      const credIds: string[] = [];

      for (const status of statuses) {
        const credId = crypto.randomUUID();
        credIds.push(credId);
        await client.query(
          `INSERT INTO platform_credentials 
           (id, organization_id, platform, platform_user_id, status, scopes, created_at, updated_at)
           VALUES ($1, $2, 'google', $3, $4, '[]', NOW(), NOW())`,
          [credId, testData.organization.id, `user-${status}`, status],
        );
      }

      // List connections should return all statuses
      const listResponse = await fetch(`${BASE_URL}/api/v1/oauth/connections?platform=google`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });
      expect(listResponse.status).toBe(200);
      const listData = await listResponse.json();

      for (const status of statuses) {
        const conn = listData.connections.find(
          (c: { platformUserId: string }) => c.platformUserId === `user-${status}`,
        );
        expect(conn).toBeDefined();
        expect(conn.status).toBe(status);
      }

      // Cleanup
      await client.query(`DELETE FROM platform_credentials WHERE id = ANY($1)`, [credIds]);
    });

    it("should keep token-by-platform route disabled even with active connections", async () => {
      const activeCredId = crypto.randomUUID();
      const revokedCredId = crypto.randomUUID();

      await client.query(
        `INSERT INTO platform_credentials 
         (id, organization_id, platform, platform_user_id, status, scopes, created_at, updated_at)
         VALUES ($1, $2, 'google', 'active-user', 'active', '[]', NOW(), NOW())`,
        [activeCredId, testData.organization.id],
      );
      await client.query(
        `INSERT INTO platform_credentials 
         (id, organization_id, platform, platform_user_id, status, scopes, created_at, updated_at)
         VALUES ($1, $2, 'google', 'revoked-user', 'revoked', '[]', NOW(), NOW())`,
        [revokedCredId, testData.organization.id],
      );

      const response = await fetch(`${BASE_URL}/api/v1/oauth/token/google`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(404);
      expect((await response.json()) as { error: string }).toEqual({ error: "Not Found" });

      await client.query(`DELETE FROM platform_credentials WHERE id IN ($1, $2)`, [
        activeCredId,
        revokedCredId,
      ]);
    });
  });

  // ============================================================================
  // Security Tests
  // ============================================================================
  describe("Security", () => {
    it("should not leak tokens in error messages", async () => {
      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/connections/${crypto.randomUUID()}/token`,
        {
          headers: {
            "X-API-Key": testData.apiKey.key,
          },
          signal: AbortSignal.timeout(TIMEOUT),
        },
      );

      const data = await response.json();
      const messageStr = JSON.stringify(data);

      // Should not contain any token-like strings
      expect(messageStr).not.toMatch(/[A-Za-z0-9]{32,}/);
      expect(messageStr).not.toContain("Bearer");
    });

    it("should not allow path traversal in connection ID", async () => {
      const maliciousIds = [
        "../../../etc/passwd",
        "..%2F..%2F..%2Fetc%2Fpasswd",
        "....//....//etc/passwd",
      ];

      for (const id of maliciousIds) {
        const response = await fetch(
          `${BASE_URL}/api/v1/oauth/connections/${encodeURIComponent(id)}/token`,
          {
            headers: {
              "X-API-Key": testData.apiKey.key,
            },
            signal: AbortSignal.timeout(TIMEOUT),
          },
        );

        expect(response.status).toBe(404);
      }
    });

    it("should require proper authentication", async () => {
      const endpoints = [
        { method: "POST", path: "/api/v1/oauth/connect" },
        { method: "GET", path: "/api/v1/oauth/connections" },
        { method: "GET", path: "/api/v1/oauth/connections/test-id" },
        { method: "DELETE", path: "/api/v1/oauth/connections/test-id" },
        { method: "GET", path: "/api/v1/oauth/connections/test-id/token" },
        { method: "GET", path: "/api/v1/oauth/token/google" },
      ];

      for (const { method, path } of endpoints) {
        const response = await fetch(`${BASE_URL}${path}`, {
          method,
          headers: { "Content-Type": "application/json" },
          body: method === "POST" ? JSON.stringify({ platform: "google" }) : undefined,
          signal: AbortSignal.timeout(TIMEOUT),
        });

        expect(response.status).toBe(401);
      }
    });

    it("should not allow invalid API keys", async () => {
      const invalidKeys = ["invalid_key", "ek_test_invalid", "", "Bearer invalid"];

      for (const key of invalidKeys) {
        const response = await fetch(`${BASE_URL}/api/v1/oauth/connections`, {
          headers: {
            Authorization: `Bearer ${key}`,
          },
          signal: AbortSignal.timeout(TIMEOUT),
        });

        expect(response.status).toBe(401);
      }
    });
  });
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a secret using the real secretsService (properly encrypted)
 */
async function createTestSecret(
  organizationId: string,
  userId: string,
  name: string,
  value: string,
): Promise<void> {
  if (!secretsClient) {
    throw new Error("Test database client is not initialized");
  }

  const encrypted = await encryptionService.encrypt(value);

  await secretsClient.query(`DELETE FROM secrets WHERE organization_id = $1 AND name = $2`, [
    organizationId,
    name,
  ]);

  await secretsClient.query(
    `INSERT INTO secrets
      (organization_id, scope, name, encrypted_value, encryption_key_id, encrypted_dek, nonce, auth_tag, created_by)
     VALUES
      ($1, 'organization', $2, $3, $4, $5, $6, $7, $8)`,
    [
      organizationId,
      name,
      encrypted.encryptedValue,
      encrypted.keyId,
      encrypted.encryptedDek,
      encrypted.nonce,
      encrypted.authTag,
      userId,
    ],
  );
}
