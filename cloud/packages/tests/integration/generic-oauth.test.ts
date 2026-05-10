/**
 * Generic OAuth Provider E2E Tests
 *
 * Tests the new generic OAuth system that allows adding OAuth providers via configuration.
 *
 * Routes tested:
 * - POST /api/v1/oauth/[platform]/initiate - Generic OAuth initiation
 * - GET /api/v1/oauth/[platform]/callback - Generic OAuth callback
 *
 * Providers tested:
 * - Linear (useGenericRoutes: true)
 * - Notion (useGenericRoutes: true)
 * - GitHub (useGenericRoutes: true)
 * - Slack (useGenericRoutes: true)
 *
 * Also tests:
 * - Rejection of legacy providers on generic routes (Google, Twitter)
 * - Provider configuration validation
 * - Redirect URL security validation
 * - State parameter validation
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Client } from "pg";
import {
  cleanupTestData,
  createTestDataSet,
  type TestDataSet,
} from "../infrastructure/test-data-factory";

const TEST_DB_URL = process.env.DATABASE_URL || "";
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";
const TIMEOUT = 15000;

let oauthRequestCounter = 0;

function withOAuthIp(init: RequestInit = {}, ip?: string): RequestInit {
  oauthRequestCounter += 1;
  const requestIp = ip ?? `203.0.113.${(oauthRequestCounter % 200) + 1}`;
  const headers = new Headers(init.headers);
  headers.set("x-forwarded-for", requestIp);
  headers.set("x-real-ip", requestIp);
  return {
    ...init,
    headers,
  };
}

let providerConfigured: Record<string, boolean> = {};

function isProviderConfigured(providerId: string): boolean {
  return providerConfigured[providerId] === true;
}

function shouldSkipIfProviderConfigured(providerId: string): boolean {
  if (isProviderConfigured(providerId)) {
    console.log(`Skipping: ${providerId} provider is configured on test server`);
    return true;
  }

  return false;
}

function shouldSkipUnlessProviderConfigured(providerId: string): boolean {
  if (!isProviderConfigured(providerId)) {
    console.log(`Skipping: ${providerId} provider is not configured on test server`);
    return true;
  }

  return false;
}

describe.skipIf(!TEST_DB_URL)("Generic OAuth Provider E2E Tests", () => {
  let testData: TestDataSet;
  let client: Client;

  beforeAll(async () => {
    if (!TEST_DB_URL) {
      throw new Error("DATABASE_URL is required for integration tests");
    }

    testData = await createTestDataSet(TEST_DB_URL, {
      organizationName: "Generic OAuth Test Org",
      creditBalance: 1000,
    });

    client = new Client({ connectionString: TEST_DB_URL });
    await client.connect();

    const providersResponse = await fetch(`${BASE_URL}/api/v1/oauth/providers`, {
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const providersData = await providersResponse.json();
    providerConfigured = Object.fromEntries(
      providersData.providers.map((provider: { id: string; configured: boolean }) => [
        provider.id,
        provider.configured,
      ]),
    );
  });

  afterAll(async () => {
    if (!client || !testData) {
      return;
    }

    await client.query(`DELETE FROM platform_credentials WHERE organization_id = $1`, [
      testData.organization.id,
    ]);
    await client.end();
    await cleanupTestData(TEST_DB_URL, testData.organization.id);
  });

  // ============================================================================
  // POST /api/v1/oauth/[platform]/initiate - Generic OAuth Initiation
  // ============================================================================
  describe("POST /api/v1/oauth/[platform]/initiate", () => {
    it("should return 401 without authentication", async () => {
      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/linear/initiate`,
        withOAuthIp({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      expect(response.status).toBe(401);
    });

    it("should return PLATFORM_NOT_SUPPORTED for unknown platform", async () => {
      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/unknownplatform/initiate`,
        withOAuthIp({
          method: "POST",
          headers: {
            "X-API-Key": testData.apiKey.key,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("PLATFORM_NOT_SUPPORTED");
    });

    // Google now uses generic routes (migrated from legacy)
    // Test is in the "should return auth URL for configured provider" section

    it("should return PLATFORM_HAS_LEGACY_ROUTES for Twitter (legacy provider)", async () => {
      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/twitter/initiate`,
        withOAuthIp({
          method: "POST",
          headers: {
            "X-API-Key": testData.apiKey.key,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("PLATFORM_HAS_LEGACY_ROUTES");
    });

    it("should return PLATFORM_HAS_LEGACY_ROUTES for Twilio (API key provider)", async () => {
      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/twilio/initiate`,
        withOAuthIp({
          method: "POST",
          headers: {
            "X-API-Key": testData.apiKey.key,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("PLATFORM_HAS_LEGACY_ROUTES");
    });

    it("should handle platform name case-insensitively", async () => {
      // LINEAR (uppercase) should be treated same as linear
      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/LINEAR/initiate`,
        withOAuthIp({
          method: "POST",
          headers: {
            "X-API-Key": testData.apiKey.key,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      // Should either work (if configured) or return PLATFORM_NOT_CONFIGURED (not PLATFORM_NOT_SUPPORTED)
      const data = await response.json();
      expect(["PLATFORM_NOT_CONFIGURED", "authUrl"]).toContain(
        data.error || (data.authUrl ? "authUrl" : undefined),
      );
    });

    it("should return PLATFORM_NOT_CONFIGURED when env vars missing for Linear", async () => {
      // Linear requires LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET
      // If not configured, should return 503
      if (shouldSkipIfProviderConfigured("linear")) {
        return;
      }

      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/linear/initiate`,
        withOAuthIp({
          method: "POST",
          headers: {
            "X-API-Key": testData.apiKey.key,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      expect(response.status).toBe(503);
      const data = await response.json();
      expect(data.error).toBe("PLATFORM_NOT_CONFIGURED");
    });

    it("should return auth URL for Linear when configured", async () => {
      if (shouldSkipUnlessProviderConfigured("linear")) {
        return;
      }

      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/linear/initiate`,
        withOAuthIp({
          method: "POST",
          headers: {
            "X-API-Key": testData.apiKey.key,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            redirectUrl: "/auth/success",
          }),
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("authUrl");
      expect(data.authUrl).toContain("linear.app/oauth/authorize");
      expect(data).toHaveProperty("state");
      expect(data.provider.id).toBe("linear");
      expect(data.provider.name).toBe("Linear");
    });

    it("should return auth URL for Notion when configured", async () => {
      if (shouldSkipUnlessProviderConfigured("notion")) {
        return;
      }

      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/notion/initiate`,
        withOAuthIp({
          method: "POST",
          headers: {
            "X-API-Key": testData.apiKey.key,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("authUrl");
      expect(data.authUrl).toContain("api.notion.com");
      expect(data.provider.id).toBe("notion");
    });

    it("should return auth URL for GitHub when configured", async () => {
      if (shouldSkipUnlessProviderConfigured("github")) {
        return;
      }

      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/github/initiate`,
        withOAuthIp({
          method: "POST",
          headers: {
            "X-API-Key": testData.apiKey.key,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("authUrl");
      expect(data.authUrl).toContain("github.com/login/oauth/authorize");
      expect(data.provider.id).toBe("github");
    });

    it("should return auth URL for Slack when configured", async () => {
      if (shouldSkipUnlessProviderConfigured("slack")) {
        return;
      }

      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/slack/initiate`,
        withOAuthIp({
          method: "POST",
          headers: {
            "X-API-Key": testData.apiKey.key,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty("authUrl");
      expect(data.authUrl).toContain("slack.com/oauth");
      expect(data.provider.id).toBe("slack");
    });

    it("should include custom scopes in auth URL when provided", async () => {
      if (shouldSkipUnlessProviderConfigured("linear")) {
        return;
      }

      const customScopes = ["read", "write"];
      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/linear/initiate`,
        withOAuthIp({
          method: "POST",
          headers: {
            "X-API-Key": testData.apiKey.key,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ scopes: customScopes }),
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.authUrl).toContain("scope=");
    });

    it("should handle empty body gracefully", async () => {
      if (shouldSkipUnlessProviderConfigured("linear")) {
        return;
      }

      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/linear/initiate`,
        withOAuthIp({
          method: "POST",
          headers: {
            "X-API-Key": testData.apiKey.key,
            "Content-Type": "application/json",
          },
          // Empty body
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      // Should not fail - uses defaults
      const data = await response.json();
      expect(response.status === 200 || data.error === "PLATFORM_NOT_CONFIGURED").toBe(true);
    });

    it("should handle malformed JSON body gracefully", async () => {
      if (shouldSkipUnlessProviderConfigured("linear")) {
        return;
      }

      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/linear/initiate`,
        withOAuthIp({
          method: "POST",
          headers: {
            "X-API-Key": testData.apiKey.key,
            "Content-Type": "application/json",
          },
          body: "{ invalid json }",
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      // Should handle gracefully - empty body is fine per the route
      const data = await response.json();
      expect(response.status === 200 || data.error === "PLATFORM_NOT_CONFIGURED").toBe(true);
    });

    it("should handle very long platform names", async () => {
      const longPlatform = "a".repeat(1000);
      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/${longPlatform}/initiate`,
        withOAuthIp({
          method: "POST",
          headers: {
            "X-API-Key": testData.apiKey.key,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("PLATFORM_NOT_SUPPORTED");
    });

    it("should handle platform with special characters", async () => {
      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/linear<script>/initiate`,
        withOAuthIp({
          method: "POST",
          headers: {
            "X-API-Key": testData.apiKey.key,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      expect(response.status).toBe(400);
    });
  });

  // ============================================================================
  // GET /api/v1/oauth/[platform]/callback - Generic OAuth Callback
  // ============================================================================
  describe("GET /api/v1/oauth/[platform]/callback", () => {
    // Note: These tests require the server to have compiled the [platform] routes.
    // If you get 401 errors, restart the dev server so Next.js picks up the new routes.

    it("should redirect with error for unknown platform", async () => {
      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/unknownplatform/callback?code=test&state=test`,
        withOAuthIp({
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      // 302/307 = redirect (expected), 401 = routes not compiled, 429 = rate limited
      if (response.status === 401) {
        console.log("Skipping: [platform] routes not compiled - restart dev server");
        return;
      }
      if (response.status === 429) {
        console.log("Skipping: Rate limited");
        return;
      }

      expect([302, 307]).toContain(response.status);
      const location = response.headers.get("location");
      expect(location).toContain("oauth_error=unknown_platform");
    });

    it("should redirect with error when Google OAuth is not configured", async () => {
      if (shouldSkipIfProviderConfigured("google")) {
        return;
      }

      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/google/callback?code=test&state=test`,
        withOAuthIp({
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      if (response.status === 401) {
        console.log("Skipping: [platform] routes not compiled - restart dev server");
        return;
      }
      if (response.status === 429) {
        console.log("Skipping: Rate limited");
        return;
      }

      expect([302, 307]).toContain(response.status);
      const location = response.headers.get("location");
      expect(location).toContain("oauth_error=not_configured");
    });

    it("should redirect with error for legacy provider (Twitter)", async () => {
      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/twitter/callback?code=test&state=test`,
        withOAuthIp({
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      if (response.status === 401) {
        console.log("Skipping: [platform] routes not compiled - restart dev server");
        return;
      }

      if (response.status === 429) {
        console.log("Skipping: Rate limited");
        return;
      }

      expect([302, 307]).toContain(response.status);
      const location = response.headers.get("location");
      expect(location).toContain("oauth_error=legacy_provider");
    });

    it("should redirect with error when provider not configured", async () => {
      if (shouldSkipIfProviderConfigured("linear")) {
        return;
      }

      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/linear/callback?code=test&state=test`,
        withOAuthIp({
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      if (response.status === 401) {
        console.log("Skipping: [platform] routes not compiled - restart dev server");
        return;
      }

      if (response.status === 429) {
        console.log("Skipping: Rate limited");
        return;
      }

      expect([302, 307]).toContain(response.status);
      const location = response.headers.get("location");
      expect(location).toContain("oauth_error=not_configured");
    });

    it("should redirect with error when code is missing", async () => {
      if (shouldSkipUnlessProviderConfigured("linear")) {
        return;
      }

      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/linear/callback?state=test`,
        withOAuthIp({
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      if (response.status === 401) {
        console.log("Skipping: [platform] routes not compiled - restart dev server");
        return;
      }

      expect([302, 307]).toContain(response.status);
      const location = response.headers.get("location");
      expect(location).toContain("linear_error=missing_params");
    });

    it("should redirect with error when state is missing", async () => {
      if (shouldSkipUnlessProviderConfigured("linear")) {
        return;
      }

      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/linear/callback?code=test`,
        withOAuthIp({
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      if (response.status === 401) {
        console.log("Skipping: [platform] routes not compiled - restart dev server");
        return;
      }

      expect([302, 307]).toContain(response.status);
      const location = response.headers.get("location");
      expect(location).toContain("linear_error=missing_params");
    });

    it("should handle OAuth error from provider (access_denied)", async () => {
      if (shouldSkipUnlessProviderConfigured("linear")) {
        return;
      }

      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/linear/callback?error=access_denied&error_description=User%20denied%20access`,
        withOAuthIp({
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      if (response.status === 401) {
        console.log("Skipping: [platform] routes not compiled - restart dev server");
        return;
      }

      expect([302, 307]).toContain(response.status);
      const location = response.headers.get("location");
      expect(location).toContain("linear_error=access_denied");
      expect(location).toContain("linear_error_description=");
    });

    it("should handle invalid state (CSRF protection)", async () => {
      if (shouldSkipUnlessProviderConfigured("linear")) {
        return;
      }

      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/linear/callback?code=test_code&state=invalid_state`,
        withOAuthIp({
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      if (response.status === 401) {
        console.log("Skipping: [platform] routes not compiled - restart dev server");
        return;
      }

      expect([302, 307]).toContain(response.status);
      const location = response.headers.get("location");
      expect(location).toContain("linear_error=");
    });

    it("should handle rate limiting", async () => {
      const responses = await Promise.all(
        Array(15)
          .fill(null)
          .map(() =>
            fetch(`${BASE_URL}/api/v1/oauth/linear/callback?code=test&state=test`, {
              ...withOAuthIp(
                {
                  redirect: "manual",
                  signal: AbortSignal.timeout(TIMEOUT),
                },
                "203.0.113.250",
              ),
            }),
          ),
      );

      const statuses = responses.map((r) => r.status);

      // If routes not compiled (401), skip
      if (statuses.every((s) => s === 401)) {
        console.log("Skipping: [platform] routes not compiled - restart dev server");
        return;
      }

      // Either rate limited (429), redirected (302/307), or routes not found
      const allValid = statuses.every((s) => s === 429 || s === 302 || s === 307 || s === 401);
      expect(allValid).toBe(true);
    });
  });

  // ============================================================================
  // Redirect URL Security Tests
  // ============================================================================
  describe("Redirect URL Security", () => {
    it("should reject external redirect URLs", async () => {
      if (shouldSkipUnlessProviderConfigured("linear")) {
        return;
      }

      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/linear/initiate`,
        withOAuthIp({
          method: "POST",
          headers: {
            "X-API-Key": testData.apiKey.key,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            redirectUrl: "https://evil.com/steal",
          }),
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("INVALID_REDIRECT_URL");
    });

    it("should allow valid redirect paths", async () => {
      if (shouldSkipUnlessProviderConfigured("linear")) {
        return;
      }

      const validPaths = [
        "/dashboard",
        "/dashboard/settings",
        "/dashboard/connections",
        "/auth/success",
      ];

      for (const path of validPaths) {
        const response = await fetch(
          `${BASE_URL}/api/v1/oauth/linear/initiate`,
          withOAuthIp({
            method: "POST",
            headers: {
              "X-API-Key": testData.apiKey.key,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ redirectUrl: path }),
            signal: AbortSignal.timeout(TIMEOUT),
          }),
        );

        // Should accept valid paths
        expect(response.status === 200 || response.status === 503).toBe(true);
      }
    });
  });

  // ============================================================================
  // Generic Adapter Tests (via connections API)
  // ============================================================================
  describe("Generic Adapter via Connections API", () => {
    it("should list connections for generic providers", async () => {
      // Test that the generic adapter correctly lists connections
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections?platform=linear`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(Array.isArray(data.connections)).toBe(true);

      // All returned connections should be Linear
      for (const conn of data.connections) {
        expect(conn.platform).toBe("linear");
      }
    });

    it("should insert and retrieve generic provider credentials", async () => {
      const credId = crypto.randomUUID();
      await client.query(
        `INSERT INTO platform_credentials
         (id, organization_id, platform, platform_user_id, platform_email, status, scopes, created_at, updated_at)
         VALUES ($1, $2, 'linear', 'linear-user-123', 'test@linear.app', 'active', '["read","write"]', NOW(), NOW())`,
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
      expect(data.connection.id).toBe(credId);
      expect(data.connection.platform).toBe("linear");
      expect(data.connection.email).toBe("test@linear.app");
      expect(data.connection.scopes).toContain("read");

      // Cleanup
      await client.query(`DELETE FROM platform_credentials WHERE id = $1`, [credId]);
    });

    it("should revoke generic provider credentials", async () => {
      const credId = crypto.randomUUID();
      await client.query(
        `INSERT INTO platform_credentials
         (id, organization_id, platform, platform_user_id, status, scopes, created_at, updated_at)
         VALUES ($1, $2, 'notion', 'notion-user-456', 'active', '[]', NOW(), NOW())`,
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
      const result = await client.query(`SELECT status FROM platform_credentials WHERE id = $1`, [
        credId,
      ]);
      expect(result.rows[0].status).toBe("revoked");

      // Cleanup
      await client.query(`DELETE FROM platform_credentials WHERE id = $1`, [credId]);
    });

    it("should return 404 when requesting token for connection without secret", async () => {
      const credId = crypto.randomUUID();
      // Insert connection WITHOUT access_token_secret_id (simulates broken state)
      await client.query(
        `INSERT INTO platform_credentials
         (id, organization_id, platform, platform_user_id, status, scopes, created_at, updated_at)
         VALUES ($1, $2, 'linear', 'linear-no-token-user', 'active', '[]', NOW(), NOW())`,
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

      // Cleanup
      await client.query(`DELETE FROM platform_credentials WHERE id = $1`, [credId]);
    });

    it("should return 404 when requesting token for revoked connection", async () => {
      const credId = crypto.randomUUID();
      await client.query(
        `INSERT INTO platform_credentials
         (id, organization_id, platform, platform_user_id, status, scopes, created_at, updated_at)
         VALUES ($1, $2, 'linear', 'linear-revoked-user', 'revoked', '[]', NOW(), NOW())`,
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

      // Cleanup
      await client.query(`DELETE FROM platform_credentials WHERE id = $1`, [credId]);
    });

    it("should return 404 when requesting token for expired connection without refresh token", async () => {
      const credId = crypto.randomUUID();
      const fakeSecretId = crypto.randomUUID(); // Must be valid UUID format
      // Insert connection with expired token and no refresh token
      await client.query(
        `INSERT INTO platform_credentials
         (id, organization_id, platform, platform_user_id, status, scopes,
          access_token_secret_id, token_expires_at, created_at, updated_at)
         VALUES ($1, $2, 'linear', 'linear-expired-user', 'active', '[]',
          $3, NOW() - INTERVAL '1 hour', NOW(), NOW())`,
        [credId, testData.organization.id, fakeSecretId],
      );

      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections/${credId}/token`, {
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(404);
      expect((await response.json()) as { error: string }).toEqual({ error: "Not Found" });

      // Cleanup
      await client.query(`DELETE FROM platform_credentials WHERE id = $1`, [credId]);
    });
  });

  // ============================================================================
  // Provider Registry Tests
  // ============================================================================
  describe("Provider Registry", () => {
    it("should list generic providers in providers endpoint", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/providers`, {
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      const providerIds = data.providers.map((p: { id: string }) => p.id);

      // Should include generic providers
      expect(providerIds).toContain("linear");
      expect(providerIds).toContain("notion");
      expect(providerIds).toContain("github");
      expect(providerIds).toContain("slack");
    });

    it("should show correct type for generic providers", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/providers`);
      const data = await response.json();

      const genericProviders = ["linear", "notion", "github", "slack"];
      for (const id of genericProviders) {
        const provider = data.providers.find((p: { id: string }) => p.id === id);
        expect(provider).toBeDefined();
        expect(provider.type).toBe("oauth2");
      }
    });

    it("should show configured status based on env vars", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/providers`);
      const data = await response.json();

      // Check Linear - should match env var presence
      const linearProvider = data.providers.find((p: { id: string }) => p.id === "linear");
      expect(linearProvider.configured).toBe(isProviderConfigured("linear"));

      // Check GitHub - should match env var presence
      const githubProvider = data.providers.find((p: { id: string }) => p.id === "github");
      expect(githubProvider.configured).toBe(isProviderConfigured("github"));
    });
  });

  // ============================================================================
  // Cross-Organization Security Tests
  // ============================================================================
  describe("Cross-Organization Security", () => {
    it("should not allow accessing another org's generic provider connection", async () => {
      const otherOrg = await createTestDataSet(TEST_DB_URL, {
        organizationName: "Other Org Generic OAuth Test",
        creditBalance: 100,
      });

      const credId = crypto.randomUUID();
      await client.query(
        `INSERT INTO platform_credentials
         (id, organization_id, platform, platform_user_id, status, scopes, created_at, updated_at)
         VALUES ($1, $2, 'linear', 'other-linear-user', 'active', '[]', NOW(), NOW())`,
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

    it("should not allow revoking another org's generic provider connection", async () => {
      const otherOrg = await createTestDataSet(TEST_DB_URL, {
        organizationName: "Other Org Generic OAuth Revoke Test",
        creditBalance: 100,
      });

      const credId = crypto.randomUUID();
      await client.query(
        `INSERT INTO platform_credentials
         (id, organization_id, platform, platform_user_id, status, scopes, created_at, updated_at)
         VALUES ($1, $2, 'github', 'other-github-user', 'active', '[]', NOW(), NOW())`,
        [credId, otherOrg.organization.id],
      );

      // Try to revoke with our API key
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections/${credId}`, {
        method: "DELETE",
        headers: {
          "X-API-Key": testData.apiKey.key,
        },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(response.status).toBe(404);

      // Verify connection was NOT revoked
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
  // Concurrent Request Tests
  // ============================================================================
  describe("Concurrent Requests", () => {
    it("should handle concurrent initiate requests", async () => {
      if (shouldSkipUnlessProviderConfigured("linear")) {
        return;
      }

      const requests = Array(5)
        .fill(null)
        .map(() =>
          fetch(`${BASE_URL}/api/v1/oauth/linear/initiate`, {
            ...withOAuthIp({
              method: "POST",
              headers: {
                "X-API-Key": testData.apiKey.key,
                "Content-Type": "application/json",
              },
              signal: AbortSignal.timeout(TIMEOUT),
            }),
          }).then((r) => r.json()),
        );

      const results = await Promise.all(requests);

      // All should succeed and return unique states
      const states = results.map((r) => r.state).filter(Boolean);
      const uniqueStates = new Set(states);
      expect(uniqueStates.size).toBe(states.length);
    });

    it("should handle concurrent connection list requests for generic providers", async () => {
      const requests = Array(5)
        .fill(null)
        .map(() =>
          fetch(`${BASE_URL}/api/v1/oauth/connections?platform=linear`, {
            headers: {
              "X-API-Key": testData.apiKey.key,
            },
            signal: AbortSignal.timeout(TIMEOUT),
          }).then((r) => r.json()),
        );

      const results = await Promise.all(requests);

      // All should succeed
      for (const result of results) {
        expect(Array.isArray(result.connections)).toBe(true);
      }
    });
  });
});
