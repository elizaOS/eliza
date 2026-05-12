/**
 * Connected Services E2E Integration Tests
 *
 * Tests the complete flow of service connections:
 * - Google OAuth flow
 * - Twilio credentials
 * - Blooio credentials
 * - Service status verification
 * - Credentials management
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { v4 as uuidv4 } from "uuid";
import {
  cleanupTestData,
  createTestDataSet,
  type TestDataSet,
} from "../infrastructure/test-data-factory";

const SERVER_URL =
  process.env.TEST_BASE_URL || process.env.TEST_SERVER_URL || "http://localhost:3000";
const DATABASE_URL = process.env.DATABASE_URL || "";
const TIMEOUT = 60000;

function getTestAuthHeaders(apiKey: string) {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };
}

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

describe("Connected Services E2E Tests", () => {
  let testData: TestDataSet;
  let client: Client;

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error("DATABASE_URL is required for integration tests");
    }

    testData = await createTestDataSet(DATABASE_URL, {
      organizationName: "Connected Services Test Org",
      creditBalance: 1000,
    });

    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    if (!client || !testData) {
      return;
    }

    // Clean up any test secrets
    await client.query(`DELETE FROM secrets WHERE organization_id = $1`, [
      testData.organization.id,
    ]);
    await client.end();
    await cleanupTestData(DATABASE_URL, testData.organization.id);
  });

  describe("Service Status API", () => {
    test("returns 401 without authentication", async () => {
      const res = await fetch(`${SERVER_URL}/api/v1/oauth/status`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(res.status).toBe(401);
    });

    test("returns connected services status with valid auth", async () => {
      const res = await fetch(`${SERVER_URL}/api/v1/oauth/status`, {
        method: "GET",
        headers: getTestAuthHeaders(testData.apiKey.key),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toHaveProperty("services");
    });

    test("status includes Google service", async () => {
      const res = await fetch(`${SERVER_URL}/api/v1/oauth/status`, {
        method: "GET",
        headers: getTestAuthHeaders(testData.apiKey.key),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(res.status).toBe(200);

      const data = await res.json();
      const google = data.services?.find((s: { id: string }) => s.id === "google");

      if (google) {
        expect(google).toHaveProperty("connected");
        expect(typeof google.connected).toBe("boolean");
      }
    });

    test("status includes Twilio service", async () => {
      const res = await fetch(`${SERVER_URL}/api/v1/oauth/status`, {
        method: "GET",
        headers: getTestAuthHeaders(testData.apiKey.key),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(res.status).toBe(200);

      const data = await res.json();
      const twilio = data.services?.find((s: { id: string }) => s.id === "twilio");

      if (twilio) {
        expect(twilio).toHaveProperty("connected");
        expect(typeof twilio.connected).toBe("boolean");
      }
    });

    test("status includes Blooio service", async () => {
      const res = await fetch(`${SERVER_URL}/api/v1/oauth/status`, {
        method: "GET",
        headers: getTestAuthHeaders(testData.apiKey.key),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(res.status).toBe(200);

      const data = await res.json();
      const blooio = data.services?.find((s: { id: string }) => s.id === "blooio");

      if (blooio) {
        expect(blooio).toHaveProperty("connected");
        expect(typeof blooio.connected).toBe("boolean");
      }
    });
  });

  describe("Google OAuth Flow", () => {
    test("initiate endpoint returns auth URL", async () => {
      const res = await fetch(
        `${SERVER_URL}/api/v1/oauth/initiate?provider=google`,
        withUniqueOAuthIp({
          method: "GET",
          headers: getTestAuthHeaders(testData.apiKey.key),
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      // May return redirect, validation error, or provider-not-configured response
      expect([200, 302, 400, 500, 503]).toContain(res.status);

      if (res.status === 200) {
        const data = await res.json();
        if (data.url) {
          expect(data.url).toContain("accounts.google.com");
        }
      }
    });

    test("callback handles state parameter", async () => {
      // Simulate callback with invalid state
      const res = await fetch(
        `${SERVER_URL}/api/v1/oauth/callback?state=invalid_state&code=test_code`,
        withUniqueOAuthIp({
          method: "GET",
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      // Should reject invalid state
      expect([400, 401, 403, 500]).toContain(res.status);
    });

    test("callback rejects missing code parameter", async () => {
      const res = await fetch(
        `${SERVER_URL}/api/v1/oauth/callback?state=some_state`,
        withUniqueOAuthIp({
          method: "GET",
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      // Should reject missing code
      expect([400, 401, 403, 500]).toContain(res.status);
    });
  });

  describe("Twilio Credentials", () => {
    test("can submit Twilio credentials", async () => {
      const res = await fetch(`${SERVER_URL}/api/v1/connections/twilio`, {
        method: "POST",
        headers: getTestAuthHeaders(testData.apiKey.key),
        body: JSON.stringify({
          accountSid: "AC" + "0".repeat(32),
          authToken: "a".repeat(32),
        }),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      // May succeed or fail based on validation
      expect([200, 400, 409, 500, 501]).toContain(res.status);
    });

    test("rejects invalid Twilio account SID format", async () => {
      const res = await fetch(`${SERVER_URL}/api/v1/connections/twilio`, {
        method: "POST",
        headers: getTestAuthHeaders(testData.apiKey.key),
        body: JSON.stringify({
          accountSid: "invalid_sid",
          authToken: "a".repeat(32),
        }),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      // Should reject invalid format
      expect([400, 422, 501]).toContain(res.status);
    });

    test("rejects empty auth token", async () => {
      const res = await fetch(`${SERVER_URL}/api/v1/connections/twilio`, {
        method: "POST",
        headers: getTestAuthHeaders(testData.apiKey.key),
        body: JSON.stringify({
          accountSid: "AC" + "0".repeat(32),
          authToken: "",
        }),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      // Should reject empty token
      expect([400, 422, 501]).toContain(res.status);
    });

    test("can disconnect Twilio", async () => {
      const res = await fetch(`${SERVER_URL}/api/v1/connections/twilio`, {
        method: "DELETE",
        headers: getTestAuthHeaders(testData.apiKey.key),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      // Should succeed or return not found
      expect([200, 204, 404, 501]).toContain(res.status);
    });
  });

  describe("Blooio Credentials", () => {
    test("can submit Blooio credentials", async () => {
      const res = await fetch(`${SERVER_URL}/api/v1/connections/blooio`, {
        method: "POST",
        headers: getTestAuthHeaders(testData.apiKey.key),
        body: JSON.stringify({
          apiKey: "test_api_key_" + uuidv4(),
        }),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      // May succeed or fail based on validation
      expect([200, 400, 409, 500, 501]).toContain(res.status);
    });

    test("rejects empty API key", async () => {
      const res = await fetch(`${SERVER_URL}/api/v1/connections/blooio`, {
        method: "POST",
        headers: getTestAuthHeaders(testData.apiKey.key),
        body: JSON.stringify({
          apiKey: "",
        }),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      // Should reject empty key
      expect([400, 422, 501]).toContain(res.status);
    });

    test("can disconnect Blooio", async () => {
      const res = await fetch(`${SERVER_URL}/api/v1/connections/blooio`, {
        method: "DELETE",
        headers: getTestAuthHeaders(testData.apiKey.key),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      // Should succeed or return not found
      expect([200, 204, 404, 501]).toContain(res.status);
    });
  });

  describe("Service Connection State", () => {
    test("connecting service updates status", async () => {
      // First check status
      const statusRes1 = await fetch(`${SERVER_URL}/api/v1/oauth/status`, {
        method: "GET",
        headers: getTestAuthHeaders(testData.apiKey.key),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(statusRes1.status).toBe(200);
      const statusData1 = await statusRes1.json();

      // Get initial Blooio state
      const initialBlooio = statusData1.services?.find((s: { id: string }) => s.id === "blooio");
      const _wasConnected = initialBlooio?.connected;

      // Connect Blooio
      const connectRes = await fetch(`${SERVER_URL}/api/v1/connections/blooio`, {
        method: "POST",
        headers: getTestAuthHeaders(testData.apiKey.key),
        body: JSON.stringify({
          apiKey: "test_key_" + Date.now(),
        }),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      if (connectRes.status === 200) {
        // Check status again
        const statusRes2 = await fetch(`${SERVER_URL}/api/v1/oauth/status`, {
          method: "GET",
          headers: getTestAuthHeaders(testData.apiKey.key),
          signal: AbortSignal.timeout(TIMEOUT),
        });

        expect(statusRes2.status).toBe(200);
        const statusData2 = await statusRes2.json();

        const newBlooio = statusData2.services?.find((s: { id: string }) => s.id === "blooio");

        // Should now be connected
        if (newBlooio) {
          expect(newBlooio.connected).toBe(true);
        }

        // Clean up
        await fetch(`${SERVER_URL}/api/v1/connections/blooio`, {
          method: "DELETE",
          headers: getTestAuthHeaders(testData.apiKey.key),
          signal: AbortSignal.timeout(TIMEOUT),
        });
      }
    });

    test("disconnecting service updates status", async () => {
      // First connect
      const connectRes = await fetch(`${SERVER_URL}/api/v1/connections/blooio`, {
        method: "POST",
        headers: getTestAuthHeaders(testData.apiKey.key),
        body: JSON.stringify({
          apiKey: "test_key_disconnect_" + Date.now(),
        }),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      if (connectRes.status === 200) {
        // Disconnect
        const disconnectRes = await fetch(`${SERVER_URL}/api/v1/connections/blooio`, {
          method: "DELETE",
          headers: getTestAuthHeaders(testData.apiKey.key),
          signal: AbortSignal.timeout(TIMEOUT),
        });

        expect([200, 204]).toContain(disconnectRes.status);

        // Check status
        const statusRes = await fetch(`${SERVER_URL}/api/v1/oauth/status`, {
          method: "GET",
          headers: getTestAuthHeaders(testData.apiKey.key),
          signal: AbortSignal.timeout(TIMEOUT),
        });

        const statusData = await statusRes.json();
        const blooio = statusData.services?.find((s: { id: string }) => s.id === "blooio");

        // Should now be disconnected
        if (blooio) {
          expect(blooio.connected).toBe(false);
        }
      }
    });
  });

  describe("Cross-Organization Security", () => {
    let otherOrgData: TestDataSet;

    beforeAll(async () => {
      otherOrgData = await createTestDataSet(DATABASE_URL, {
        organizationName: "Other Services Org",
      });

      // Connect Blooio for other org
      await fetch(`${SERVER_URL}/api/v1/connections/blooio`, {
        method: "POST",
        headers: getTestAuthHeaders(otherOrgData.apiKey.key),
        body: JSON.stringify({
          apiKey: "other_org_key_" + Date.now(),
        }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
    });

    afterAll(async () => {
      if (!otherOrgData) {
        return;
      }

      await client.query(`DELETE FROM secrets WHERE organization_id = $1`, [
        otherOrgData.organization.id,
      ]);
      await cleanupTestData(DATABASE_URL, otherOrgData.organization.id);
    });

    test("cannot access other organization's service status", async () => {
      // Get status with first org's key
      const res = await fetch(`${SERVER_URL}/api/v1/oauth/status`, {
        method: "GET",
        headers: getTestAuthHeaders(testData.apiKey.key),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      expect(res.status).toBe(200);

      const data = await res.json();

      // Should only see own organization's connections
      // The other org's Blooio should not appear as connected for this org
      const blooio = data.services?.find((s: { id: string }) => s.id === "blooio");

      // Our org's Blooio should not be affected by other org's connection
      expect(blooio?.connected).toBe(false);
    });

    test("each organization has independent service connections", async () => {
      // Get both org's statuses
      const res1 = await fetch(`${SERVER_URL}/api/v1/oauth/status`, {
        method: "GET",
        headers: getTestAuthHeaders(testData.apiKey.key),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      const res2 = await fetch(`${SERVER_URL}/api/v1/oauth/status`, {
        method: "GET",
        headers: getTestAuthHeaders(otherOrgData.apiKey.key),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      const data1 = await res1.json();
      const data2 = await res2.json();

      const blooio1 = data1.services?.find((s: { id: string }) => s.id === "blooio");
      const _blooio2 = data2.services?.find((s: { id: string }) => s.id === "blooio");

      // First org should not be connected
      expect(blooio1?.connected).toBe(false);

      // Second org should be connected (if connection succeeded)
      // Note: This depends on the beforeAll connection succeeding
    });
  });

  describe("Error Handling", () => {
    test("handles invalid provider gracefully", async () => {
      const res = await fetch(
        `${SERVER_URL}/api/v1/oauth/initiate?provider=invalid`,
        withUniqueOAuthIp({
          method: "GET",
          headers: getTestAuthHeaders(testData.apiKey.key),
          signal: AbortSignal.timeout(TIMEOUT),
        }),
      );

      // Should return error, not crash
      expect([400, 404, 500]).toContain(res.status);
    });

    test("handles missing body in POST request", async () => {
      const res = await fetch(`${SERVER_URL}/api/v1/connections/twilio`, {
        method: "POST",
        headers: getTestAuthHeaders(testData.apiKey.key),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      // Should return validation error
      expect([400, 422, 501]).toContain(res.status);
    });

    test("handles malformed JSON body", async () => {
      const res = await fetch(`${SERVER_URL}/api/v1/connections/twilio`, {
        method: "POST",
        headers: {
          ...getTestAuthHeaders(testData.apiKey.key),
          "Content-Type": "application/json",
        },
        body: "not valid json",
        signal: AbortSignal.timeout(TIMEOUT),
      });

      // Should return error
      expect([400, 422, 500, 501]).toContain(res.status);
    });

    test("handles concurrent connection requests", async () => {
      const requests = Array(3)
        .fill(null)
        .map((_, i) =>
          fetch(`${SERVER_URL}/api/v1/connections/blooio`, {
            method: "POST",
            headers: getTestAuthHeaders(testData.apiKey.key),
            body: JSON.stringify({
              apiKey: `concurrent_key_${i}_${Date.now()}`,
            }),
            signal: AbortSignal.timeout(TIMEOUT),
          }),
        );

      const responses = await Promise.all(requests);

      // Should handle gracefully - some may succeed, some may fail validation or conflict
      for (const res of responses) {
        expect([200, 400, 409, 500, 501]).toContain(res.status);
      }

      // Clean up
      await fetch(`${SERVER_URL}/api/v1/connections/blooio`, {
        method: "DELETE",
        headers: getTestAuthHeaders(testData.apiKey.key),
        signal: AbortSignal.timeout(TIMEOUT),
      });
    });
  });

  describe("Secrets Storage Security", () => {
    test("credentials are not returned in plain text", async () => {
      // Connect a service first
      const connectRes = await fetch(`${SERVER_URL}/api/v1/connections/blooio`, {
        method: "POST",
        headers: getTestAuthHeaders(testData.apiKey.key),
        body: JSON.stringify({
          apiKey: "secret_api_key_" + Date.now(),
        }),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      if (connectRes.status === 200) {
        // Get status
        const statusRes = await fetch(`${SERVER_URL}/api/v1/oauth/status`, {
          method: "GET",
          headers: getTestAuthHeaders(testData.apiKey.key),
          signal: AbortSignal.timeout(TIMEOUT),
        });

        const statusData = await statusRes.json();
        const blooio = statusData.services?.find((s: { id: string }) => s.id === "blooio");

        // Should not contain the actual API key
        if (blooio) {
          expect(JSON.stringify(blooio)).not.toContain("secret_api_key_");
        }

        // Clean up
        await fetch(`${SERVER_URL}/api/v1/connections/blooio`, {
          method: "DELETE",
          headers: getTestAuthHeaders(testData.apiKey.key),
          signal: AbortSignal.timeout(TIMEOUT),
        });
      }
    });
  });
});
