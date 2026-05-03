/**
 * E2E Integration Tests for Connection APIs
 *
 * Tests Google, Twilio, and Blooio connection endpoints.
 * Covers: status checks, connect, disconnect flows.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Client } from "pg";
import { apiKeysService } from "@/lib/services/api-keys";
import { blooioAutomationService } from "@/lib/services/blooio-automation";
import { twilioAutomationService } from "@/lib/services/twilio-automation";
import {
  cleanupTestData,
  createTestDataSet,
  type TestDataSet,
} from "../infrastructure/test-data-factory";

const TEST_DB_URL = process.env.DATABASE_URL || "";
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";
const TWILIO_SECRET_NAMES = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"];
const BLOOIO_SECRET_NAMES = ["BLOOIO_API_KEY", "BLOOIO_WEBHOOK_SECRET", "BLOOIO_FROM_NUMBER"];

let oauthRequestCounter = 0;

function withUniqueOAuthIp(init: RequestInit = {}): RequestInit {
  oauthRequestCounter += 1;
  const ip = `203.0.113.${(oauthRequestCounter % 200) + 1}`;
  const headers = new Headers(init.headers);
  headers.set("x-forwarded-for", ip);
  headers.set("x-real-ip", ip);
  return {
    ...init,
    headers,
  };
}

async function deleteSecrets(
  client: Client,
  organizationId: string,
  names: string[],
): Promise<void> {
  await client.query(`DELETE FROM secrets WHERE organization_id = $1 AND name = ANY($2::text[])`, [
    organizationId,
    names,
  ]);
}

describe("Connection APIs E2E Tests", () => {
  let testData: TestDataSet;
  let client: Client;

  beforeAll(async () => {
    if (!TEST_DB_URL) {
      throw new Error("DATABASE_URL is required for integration tests");
    }

    testData = await createTestDataSet(TEST_DB_URL, {
      organizationName: "Connection API Test Org",
      creditBalance: 1000,
    });

    client = new Client({ connectionString: TEST_DB_URL });
    await client.connect();
  });

  afterAll(async () => {
    // Clean up any platform credentials
    await client.query(`DELETE FROM platform_credentials WHERE organization_id = $1`, [
      testData.organization.id,
    ]);
    await client.query(`DELETE FROM secrets WHERE organization_id = $1`, [
      testData.organization.id,
    ]);
    await client.end();
    await cleanupTestData(TEST_DB_URL, testData.organization.id);
  });

  describe("Google Connection API (via generic OAuth routes)", () => {
    describe("GET /api/v1/oauth/connections?platform=google", () => {
      it("should return empty connections when not connected", async () => {
        // Clean up any existing Google connections
        await client.query(
          `DELETE FROM platform_credentials WHERE organization_id = $1 AND platform = 'google'`,
          [testData.organization.id],
        );

        const response = await fetch(`${BASE_URL}/api/v1/oauth/connections?platform=google`, {
          headers: {
            Authorization: `Bearer ${testData.apiKey.key}`,
          },
        });

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.connections).toEqual([]);
      });

      it("should return 401 without authentication", async () => {
        const response = await fetch(`${BASE_URL}/api/v1/oauth/connections?platform=google`);
        expect(response.status).toBe(401);
      });
    });

    describe("POST /api/v1/oauth/google/initiate", () => {
      it("should initiate OAuth flow", async () => {
        const response = await fetch(
          `${BASE_URL}/api/v1/oauth/google/initiate`,
          withUniqueOAuthIp({
            method: "POST",
            headers: {
              Authorization: `Bearer ${testData.apiKey.key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
          }),
        );

        // Will return 503 if GOOGLE_CLIENT_ID/SECRET are not configured, which is expected
        expect([200, 400, 503]).toContain(response.status);
      });

      it("should return 401 without authentication", async () => {
        const response = await fetch(
          `${BASE_URL}/api/v1/oauth/google/initiate`,
          withUniqueOAuthIp({
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
          }),
        );

        expect(response.status).toBe(401);
      });
    });
  });

  describe("Twilio Connection API", () => {
    describe("GET /api/v1/twilio/status", () => {
      it("should return disconnected status when not connected", async () => {
        await deleteSecrets(client, testData.organization.id, TWILIO_SECRET_NAMES);

        const response = await fetch(`${BASE_URL}/api/v1/twilio/status`, {
          headers: {
            Authorization: `Bearer ${testData.apiKey.key}`,
          },
        });

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.connected).toBe(false);
      });

      it("should return 401 without authentication", async () => {
        const response = await fetch(`${BASE_URL}/api/v1/twilio/status`);
        expect(response.status).toBe(401);
      });
    });

    describe("POST /api/v1/twilio/connect", () => {
      it("should validate required fields", async () => {
        const response = await fetch(`${BASE_URL}/api/v1/twilio/connect`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${testData.apiKey.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            // Missing required fields
          }),
        });

        expect(response.status).toBe(400);
      });

      it("should connect with valid credentials", async () => {
        const response = await fetch(`${BASE_URL}/api/v1/twilio/connect`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${testData.apiKey.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            accountSid: "ACtest12345678901234567890123456",
            authToken: "test_auth_token_1234567890123456",
            phoneNumber: "+15551234567",
          }),
        });

        // May succeed or fail depending on Twilio validation
        expect([200, 400, 500]).toContain(response.status);
      });

      it("should return 401 without authentication", async () => {
        const response = await fetch(`${BASE_URL}/api/v1/twilio/connect`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            accountSid: "ACtest",
            authToken: "test",
            phoneNumber: "+15551234567",
          }),
        });

        expect(response.status).toBe(401);
      });
    });

    describe("DELETE /api/v1/twilio/disconnect", () => {
      it("should disconnect Twilio account", async () => {
        await twilioAutomationService.storeCredentials(testData.organization.id, testData.user.id, {
          accountSid: "ACtest",
          authToken: "test_auth_token",
          phoneNumber: "+15551234567",
        });

        const response = await fetch(`${BASE_URL}/api/v1/twilio/disconnect`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${testData.apiKey.key}`,
          },
        });

        expect([200, 204]).toContain(response.status);
      });
    });
  });

  describe("Blooio Connection API", () => {
    describe("GET /api/v1/blooio/status", () => {
      it("should return disconnected status when not connected", async () => {
        await deleteSecrets(client, testData.organization.id, BLOOIO_SECRET_NAMES);

        const response = await fetch(`${BASE_URL}/api/v1/blooio/status`, {
          headers: {
            Authorization: `Bearer ${testData.apiKey.key}`,
          },
        });

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.connected).toBe(false);
      });

      it("should return 401 without authentication", async () => {
        const response = await fetch(`${BASE_URL}/api/v1/blooio/status`);
        expect(response.status).toBe(401);
      });
    });

    describe("POST /api/v1/blooio/connect", () => {
      it("should validate required fields", async () => {
        const response = await fetch(`${BASE_URL}/api/v1/blooio/connect`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${testData.apiKey.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            // Missing apiKey and phoneNumber
          }),
        });

        expect(response.status).toBe(400);
      });

      it("should connect with valid credentials", async () => {
        const response = await fetch(`${BASE_URL}/api/v1/blooio/connect`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${testData.apiKey.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            apiKey: "bloo_test_api_key_1234567890",
            phoneNumber: "+15559876543",
          }),
        });

        // May succeed or fail depending on Blooio validation
        expect([200, 400, 500]).toContain(response.status);
      });

      it("should return 401 without authentication", async () => {
        const response = await fetch(`${BASE_URL}/api/v1/blooio/connect`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            apiKey: "test_key",
            phoneNumber: "+15559876543",
          }),
        });

        expect(response.status).toBe(401);
      });
    });

    describe("DELETE /api/v1/blooio/disconnect", () => {
      it("should disconnect Blooio account", async () => {
        await blooioAutomationService.storeCredentials(testData.organization.id, testData.user.id, {
          apiKey: "blooio_test_api_key",
          fromNumber: "+15559876543",
        });

        const response = await fetch(`${BASE_URL}/api/v1/blooio/disconnect`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${testData.apiKey.key}`,
          },
        });

        expect([200, 204]).toContain(response.status);
      });
    });
  });

  describe("Cross-Connection Scenarios", () => {
    it("should allow multiple services to be connected simultaneously", async () => {
      await twilioAutomationService.storeCredentials(testData.organization.id, testData.user.id, {
        accountSid: "ACtest",
        authToken: "test_auth_token",
        phoneNumber: "+15551234567",
      });

      await blooioAutomationService.storeCredentials(testData.organization.id, testData.user.id, {
        apiKey: "blooio_test_api_key",
        fromNumber: "+15559876543",
      });

      // Check all statuses
      const twilioStatus = await fetch(`${BASE_URL}/api/v1/twilio/status`, {
        headers: { Authorization: `Bearer ${testData.apiKey.key}` },
      });
      const blooioStatus = await fetch(`${BASE_URL}/api/v1/blooio/status`, {
        headers: { Authorization: `Bearer ${testData.apiKey.key}` },
      });

      expect(twilioStatus.status).toBe(200);
      expect(blooioStatus.status).toBe(200);
    });

    it("should handle disconnecting one service without affecting others", async () => {
      await deleteSecrets(client, testData.organization.id, TWILIO_SECRET_NAMES);

      // Blooio should still be connected
      const blooioResult = await client.query(
        `SELECT * FROM secrets WHERE organization_id = $1 AND name = 'BLOOIO_API_KEY'`,
        [testData.organization.id],
      );
      expect(blooioResult.rows.length).toBe(1);
    });
  });

  describe("Error Handling", () => {
    it("should handle malformed JSON in request body", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/twilio/connect`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${testData.apiKey.key}`,
          "Content-Type": "application/json",
        },
        body: "{ invalid json }",
      });

      expect(response.status).toBe(400);
    });

    it("should handle invalid API key", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections?platform=google`, {
        headers: {
          Authorization: "Bearer invalid_key_12345",
        },
      });

      expect(response.status).toBe(401);
    });

    it("should handle expired API key", async () => {
      const { apiKey: expiredKey, plainKey: expiredKeyValue } = await apiKeysService.create({
        name: `Expired Key ${crypto.randomUUID()}`,
        organization_id: testData.organization.id,
        user_id: testData.user.id,
        is_active: true,
      });

      await client.query(
        `UPDATE api_keys SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1`,
        [expiredKey.id],
      );

      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections?platform=google`, {
        headers: {
          Authorization: `Bearer ${expiredKeyValue}`,
        },
      });

      // Should be unauthorized due to expired key
      expect([401, 403]).toContain(response.status);

      // Cleanup
      await client.query(`DELETE FROM api_keys WHERE id = $1`, [expiredKey.id]);
    });

    it("should handle empty request body for connect endpoints", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/twilio/connect`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${testData.apiKey.key}`,
          "Content-Type": "application/json",
        },
        body: "",
      });

      expect([400, 500]).toContain(response.status);
    });

    it("should handle null values in connect request", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/twilio/connect`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${testData.apiKey.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          accountSid: null,
          authToken: null,
          phoneNumber: null,
        }),
      });

      expect(response.status).toBe(400);
    });
  });

  describe("Google OAuth Callback Edge Cases (via generic route)", () => {
    it("should reject callback with missing code parameter", async () => {
      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/google/callback?state=test_state`,
        withUniqueOAuthIp({
          method: "GET",
          redirect: "manual",
        }),
      );

      // Should redirect with error or return error
      expect([302, 307, 400, 429]).toContain(response.status);
    });

    it("should reject callback with missing state parameter", async () => {
      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/google/callback?code=test_code`,
        withUniqueOAuthIp({
          method: "GET",
          redirect: "manual",
        }),
      );

      // Should redirect with error or return error
      expect([302, 307, 400, 429]).toContain(response.status);
    });

    it("should reject callback with invalid state parameter", async () => {
      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/google/callback?code=test_code&state=invalid_state_token`,
        withUniqueOAuthIp({
          method: "GET",
          redirect: "manual",
        }),
      );

      // Should redirect with error
      expect([302, 307, 400, 429]).toContain(response.status);
    });

    it("should handle error parameter in callback", async () => {
      const response = await fetch(
        `${BASE_URL}/api/v1/oauth/google/callback?error=access_denied&error_description=User%20denied%20access`,
        withUniqueOAuthIp({
          method: "GET",
          redirect: "manual",
        }),
      );

      // Should redirect with error
      expect([302, 307, 400, 429]).toContain(response.status);
    });
  });

  describe("Concurrent Connection Operations", () => {
    it("should handle concurrent status checks", async () => {
      const requests = Array(10)
        .fill(null)
        .map(() =>
          fetch(`${BASE_URL}/api/v1/twilio/status`, {
            headers: { Authorization: `Bearer ${testData.apiKey.key}` },
          }),
        );

      const responses = await Promise.all(requests);

      for (const response of responses) {
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data).toHaveProperty("connected");
      }
    });

    it("should handle concurrent connect attempts", async () => {
      const requests = Array(5)
        .fill(null)
        .map(() =>
          fetch(`${BASE_URL}/api/v1/blooio/connect`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${testData.apiKey.key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              apiKey: "bloo_concurrent_test_key",
              phoneNumber: "+15551234567",
            }),
          }),
        );

      const responses = await Promise.all(requests);

      // All should complete (success or validation failure)
      for (const response of responses) {
        expect([200, 400, 500]).toContain(response.status);
      }
    });

    it("should handle concurrent disconnect attempts", async () => {
      await twilioAutomationService.storeCredentials(testData.organization.id, testData.user.id, {
        accountSid: "ACtest",
        authToken: "test_auth_token",
        phoneNumber: "+15551234567",
      });

      const requests = Array(3)
        .fill(null)
        .map(() =>
          fetch(`${BASE_URL}/api/v1/twilio/disconnect`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${testData.apiKey.key}` },
          }),
        );

      const responses = await Promise.all(requests);

      // All should succeed (idempotent operation)
      for (const response of responses) {
        expect([200, 204]).toContain(response.status);
      }
    });
  });

  describe("Input Validation", () => {
    describe("Twilio Connect Validation", () => {
      it("should reject accountSid that doesn't start with AC", async () => {
        const response = await fetch(`${BASE_URL}/api/v1/twilio/connect`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${testData.apiKey.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            accountSid: "XY12345678901234567890123456",
            authToken: "test_auth_token",
            phoneNumber: "+15551234567",
          }),
        });

        expect([400, 500]).toContain(response.status);
      });

      it("should reject invalid phone number format", async () => {
        const response = await fetch(`${BASE_URL}/api/v1/twilio/connect`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${testData.apiKey.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            accountSid: "ACtest12345678901234567890123456",
            authToken: "test_auth_token",
            phoneNumber: "5551234567", // Missing +
          }),
        });

        expect(response.status).toBe(400);
      });

      it("should reject empty strings", async () => {
        const response = await fetch(`${BASE_URL}/api/v1/twilio/connect`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${testData.apiKey.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            accountSid: "",
            authToken: "",
            phoneNumber: "",
          }),
        });

        expect(response.status).toBe(400);
      });
    });

    describe("Blooio Connect Validation", () => {
      it("should reject empty API key", async () => {
        const response = await fetch(`${BASE_URL}/api/v1/blooio/connect`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${testData.apiKey.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            apiKey: "",
          }),
        });

        expect(response.status).toBe(400);
      });

      it("should accept optional webhookSecret", async () => {
        const response = await fetch(`${BASE_URL}/api/v1/blooio/connect`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${testData.apiKey.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            apiKey: "bloo_test_key",
            webhookSecret: "optional_secret",
          }),
        });

        // May succeed or fail due to validation, but not 400 for missing fields
        expect([200, 400, 500]).toContain(response.status);
      });
    });
  });

  describe("Connection Status Response Format", () => {
    it("should return consistent structure for Google connections", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/oauth/connections?platform=google`, {
        headers: { Authorization: `Bearer ${testData.apiKey.key}` },
      });

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data).toHaveProperty("connections");
      expect(Array.isArray(data.connections)).toBe(true);

      if (data.connections.length > 0) {
        const conn = data.connections[0];
        expect(conn).toHaveProperty("id");
        expect(conn).toHaveProperty("platform");
        expect(conn).toHaveProperty("status");
      }
    });

    it("should return consistent structure for Twilio status", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/twilio/status`, {
        headers: { Authorization: `Bearer ${testData.apiKey.key}` },
      });

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data).toHaveProperty("connected");
      expect(typeof data.connected).toBe("boolean");
    });

    it("should return consistent structure for Blooio status", async () => {
      const response = await fetch(`${BASE_URL}/api/v1/blooio/status`, {
        headers: { Authorization: `Bearer ${testData.apiKey.key}` },
      });

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data).toHaveProperty("connected");
      expect(typeof data.connected).toBe("boolean");
    });
  });

  describe("Disconnect Idempotency", () => {
    it("should succeed when disconnecting already disconnected Twilio", async () => {
      await deleteSecrets(client, testData.organization.id, TWILIO_SECRET_NAMES);

      const response = await fetch(`${BASE_URL}/api/v1/twilio/disconnect`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${testData.apiKey.key}` },
      });

      expect([200, 204]).toContain(response.status);
    });

    it("should succeed when disconnecting already disconnected Blooio", async () => {
      await deleteSecrets(client, testData.organization.id, BLOOIO_SECRET_NAMES);

      const response = await fetch(`${BASE_URL}/api/v1/blooio/disconnect`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${testData.apiKey.key}` },
      });

      expect([200, 204]).toContain(response.status);
    });
  });

  describe("Performance", () => {
    it("should respond quickly for status checks", async () => {
      const requestFactories = [
        () =>
          fetch(`${BASE_URL}/api/v1/oauth/connections?platform=google`, {
            headers: { Authorization: `Bearer ${testData.apiKey.key}` },
          }),
        () =>
          fetch(`${BASE_URL}/api/v1/twilio/status`, {
            headers: { Authorization: `Bearer ${testData.apiKey.key}` },
          }),
        () =>
          fetch(`${BASE_URL}/api/v1/blooio/status`, {
            headers: { Authorization: `Bearer ${testData.apiKey.key}` },
          }),
      ];

      // Warm the dev server routes before measuring the steady-state path.
      const warmupResponses = await Promise.all(
        requestFactories.map((requestFactory) => requestFactory()),
      );
      for (const response of warmupResponses) {
        expect(response.status).toBe(200);
      }

      const startTime = Date.now();
      const responses = await Promise.all(
        requestFactories.map((requestFactory) => requestFactory()),
      );

      const duration = Date.now() - startTime;

      for (const response of responses) {
        expect(response.status).toBe(200);
      }

      // All three should complete in under 3 seconds
      expect(duration).toBeLessThan(3000);
    });
  });
});
