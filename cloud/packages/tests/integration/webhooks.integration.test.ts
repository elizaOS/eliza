/**
 * E2E Integration Tests for Webhook Handlers
 *
 * Tests Twilio and Blooio webhook endpoints.
 * Covers: inbound messages, signature verification, response handling.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as crypto from "crypto";
import { Client } from "pg";
import { v4 as uuidv4 } from "uuid";
import { createEncryptionService } from "@/lib/services/secrets/encryption";
import {
  cleanupTestData,
  createTestDataSet,
  type TestDataSet,
} from "../infrastructure/test-data-factory";

const TEST_DB_URL = process.env.DATABASE_URL || "";
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";
const TWILIO_AUTH_TOKEN = "test_token";
const BLOOIO_WEBHOOK_SECRET = "webhook_secret_123";
const TWILIO_SECRET_NAMES = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"];
const BLOOIO_SECRET_NAMES = ["BLOOIO_API_KEY", "BLOOIO_WEBHOOK_SECRET", "BLOOIO_FROM_NUMBER"];
const WEBHOOK_RATE_LIMIT_IP = "198.51.100.250";
const encryptionService = createEncryptionService();
const forwardOriginalFetchPreconnect: NonNullable<typeof originalFetch.preconnect> = (...args) => {
  if (typeof originalFetch.preconnect === "function") {
    originalFetch.preconnect(...args);
  }
};
let webhookRequestCounter = 0;

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

async function upsertSecret(
  client: Client,
  organizationId: string,
  userId: string,
  name: string,
  value: string,
): Promise<void> {
  const encrypted = await encryptionService.encrypt(value);

  await client.query(`DELETE FROM secrets WHERE organization_id = $1 AND name = $2`, [
    organizationId,
    name,
  ]);

  await client.query(
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

const originalFetch: typeof fetch = globalThis.fetch;

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function createTwilioSignature(url: string, body: URLSearchParams | string): string {
  const params = typeof body === "string" ? new URLSearchParams(body) : body;
  const sortedParams = Array.from(params.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}${value}`)
    .join("");

  return crypto
    .createHmac("sha1", TWILIO_AUTH_TOKEN)
    .update(url + sortedParams)
    .digest("base64");
}

function createBlooioSignature(rawBody: string, timestamp: number): string {
  const signature = crypto
    .createHmac("sha256", BLOOIO_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  return `t=${timestamp},v1=${signature}`;
}

function withWebhookIpHeaders(headers: Headers, ip?: string): void {
  webhookRequestCounter += 1;
  const requestIp = ip ?? `198.51.100.${(webhookRequestCounter % 200) + 1}`;

  if (!headers.has("x-forwarded-for")) {
    headers.set("x-forwarded-for", requestIp);
  }

  if (!headers.has("x-real-ip")) {
    headers.set("x-real-ip", requestIp);
  }
}

const signedWebhookFetch: typeof fetch = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit) => {
    const url = getRequestUrl(input);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();

    if (method !== "POST") {
      return originalFetch(input, init);
    }

    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const isWebhookRequest =
      url.includes("/api/webhooks/twilio/") || url.includes("/api/webhooks/blooio/");

    if (isWebhookRequest) {
      const fixedIp =
        headers.get("X-Test-Rate-Limit-IP") === "true" ? WEBHOOK_RATE_LIMIT_IP : undefined;
      headers.delete("X-Test-Rate-Limit-IP");
      withWebhookIpHeaders(headers, fixedIp);
    }

    if (headers.get("X-Test-Skip-Signature") === "true") {
      headers.delete("X-Test-Skip-Signature");
      return originalFetch(input, { ...init, headers });
    }

    if (url.includes("/api/webhooks/twilio/") && !headers.has("X-Twilio-Signature")) {
      const body = init?.body;
      if (body instanceof URLSearchParams || typeof body === "string") {
        headers.set("X-Twilio-Signature", createTwilioSignature(url, body));
      }
    }

    if (url.includes("/api/webhooks/blooio/") && !headers.has("X-Blooio-Signature")) {
      const body = init?.body;
      if (typeof body === "string") {
        headers.set(
          "X-Blooio-Signature",
          createBlooioSignature(body, Math.floor(Date.now() / 1000)),
        );
      }
    }

    return originalFetch(input, { ...init, headers });
  },
  { preconnect: forwardOriginalFetchPreconnect },
);

describe("Webhook Handlers E2E Tests", () => {
  let testData: TestDataSet;
  let client: Client;
  let agentId: string;
  let phoneNumberId: string;

  beforeAll(async () => {
    if (!TEST_DB_URL) {
      throw new Error("DATABASE_URL is required for integration tests");
    }

    testData = await createTestDataSet(TEST_DB_URL, {
      organizationName: "Webhook Test Org",
      creditBalance: 1000,
    });

    client = new Client({ connectionString: TEST_DB_URL });
    await client.connect();

    // Create test agent
    agentId = uuidv4();
    await client.query(`INSERT INTO agents (id, name, enabled) VALUES ($1, $2, true)`, [
      agentId,
      "Webhook Test Agent",
    ]);

    // Register phone number for agent
    const phoneResult = await client.query(
      `INSERT INTO agent_phone_numbers 
       (organization_id, agent_id, phone_number, provider, phone_type, is_active)
       VALUES ($1, $2, '+15551234567', 'twilio', 'sms', true)
       RETURNING id`,
      [testData.organization.id, agentId],
    );
    phoneNumberId = phoneResult.rows[0].id;

    await upsertSecret(
      client,
      testData.organization.id,
      testData.user.id,
      "TWILIO_ACCOUNT_SID",
      "ACtest123",
    );
    await upsertSecret(
      client,
      testData.organization.id,
      testData.user.id,
      "TWILIO_AUTH_TOKEN",
      TWILIO_AUTH_TOKEN,
    );
    await upsertSecret(
      client,
      testData.organization.id,
      testData.user.id,
      "TWILIO_PHONE_NUMBER",
      "+15551234567",
    );

    await upsertSecret(
      client,
      testData.organization.id,
      testData.user.id,
      "BLOOIO_API_KEY",
      "bloo_test_key",
    );
    await upsertSecret(
      client,
      testData.organization.id,
      testData.user.id,
      "BLOOIO_WEBHOOK_SECRET",
      BLOOIO_WEBHOOK_SECRET,
    );
  });

  afterAll(async () => {
    if (!client || !testData) {
      return;
    }

    await client.query(`DELETE FROM phone_message_log WHERE phone_number_id = $1`, [phoneNumberId]);
    await client.query(`DELETE FROM agent_phone_numbers WHERE id = $1`, [phoneNumberId]);
    await client.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
    await deleteSecrets(client, testData.organization.id, TWILIO_SECRET_NAMES);
    await deleteSecrets(client, testData.organization.id, BLOOIO_SECRET_NAMES);
    await client.end();
    await cleanupTestData(TEST_DB_URL, testData.organization.id);
  });

  describe("Twilio Webhook Handler", () => {
    const _twilioWebhookUrl = `${BASE_URL}/api/webhooks/twilio/${testData?.organization?.id}`;

    describe("POST /api/webhooks/twilio/[orgId]", () => {
      it("should handle incoming SMS message", async () => {
        const formData = new URLSearchParams();
        formData.append("MessageSid", "SM" + uuidv4().replace(/-/g, ""));
        formData.append("From", "+15559876543");
        formData.append("To", "+15551234567");
        formData.append("Body", "Hello, this is a test message!");
        formData.append("AccountSid", "ACtest123");
        formData.append("NumMedia", "0");

        const response = await signedWebhookFetch(
          `${BASE_URL}/api/webhooks/twilio/${testData.organization.id}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "X-Test-Rate-Limit-IP": "true",
            },
            body: formData,
          },
        );

        // Should return TwiML response
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain("<?xml");
        expect(text).toContain("<Response>");
      });

      it("should handle incoming MMS with media", async () => {
        const formData = new URLSearchParams();
        formData.append("MessageSid", "MM" + uuidv4().replace(/-/g, ""));
        formData.append("From", "+15559876543");
        formData.append("To", "+15551234567");
        formData.append("Body", "Check out this image!");
        formData.append("AccountSid", "ACtest123");
        formData.append("NumMedia", "1");
        formData.append("MediaUrl0", "https://example.com/image.jpg");
        formData.append("MediaContentType0", "image/jpeg");

        const response = await signedWebhookFetch(
          `${BASE_URL}/api/webhooks/twilio/${testData.organization.id}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: formData,
          },
        );

        expect(response.status).toBe(200);
      });

      it("should handle empty message body", async () => {
        const formData = new URLSearchParams();
        formData.append("MessageSid", "SM" + uuidv4().replace(/-/g, ""));
        formData.append("From", "+15559876543");
        formData.append("To", "+15551234567");
        formData.append("Body", "");
        formData.append("AccountSid", "ACtest123");
        formData.append("NumMedia", "0");

        const response = await signedWebhookFetch(
          `${BASE_URL}/api/webhooks/twilio/${testData.organization.id}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: formData,
          },
        );

        // Should still return 200 without processing.
        expect(response.status).toBe(200);
      });

      it("should return 400 for invalid organization ID", async () => {
        const formData = new URLSearchParams();
        formData.append("MessageSid", "SM123");
        formData.append("From", "+15559876543");
        formData.append("To", "+15551234567");
        formData.append("Body", "Test");

        const response = await signedWebhookFetch(
          `${BASE_URL}/api/webhooks/twilio/invalid-org-id`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: formData,
          },
        );

        // May return 400 or 500 depending on validation
        expect([400, 500]).toContain(response.status);
      });

      it("should include geographic information in metadata", async () => {
        const formData = new URLSearchParams();
        formData.append("MessageSid", "SM" + uuidv4().replace(/-/g, ""));
        formData.append("From", "+15559876543");
        formData.append("To", "+15551234567");
        formData.append("Body", "Location test");
        formData.append("AccountSid", "ACtest123");
        formData.append("NumMedia", "0");
        formData.append("FromCity", "San Francisco");
        formData.append("FromState", "CA");
        formData.append("FromCountry", "US");

        const response = await signedWebhookFetch(
          `${BASE_URL}/api/webhooks/twilio/${testData.organization.id}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: formData,
          },
        );

        expect(response.status).toBe(200);
      });
    });

    describe("GET /api/webhooks/twilio/[orgId] (Health Check)", () => {
      it("should return health status", async () => {
        const response = await signedWebhookFetch(
          `${BASE_URL}/api/webhooks/twilio/${testData.organization.id}`,
          {
            method: "GET",
          },
        );

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.status).toBe("ok");
        expect(data.service).toBe("twilio-webhook");
      });
    });
  });

  describe("Blooio Webhook Handler", () => {
    describe("POST /api/webhooks/blooio/[orgId]", () => {
      it("should handle incoming iMessage", async () => {
        const payload = {
          event: "message.received",
          message_id: "bloo_" + uuidv4(),
          sender: "+15559876543",
          text: "Hello from iMessage!",
          timestamp: Date.now(),
          protocol: "imessage",
          external_id: "ext_123",
          attachments: [],
        };

        const response = await signedWebhookFetch(
          `${BASE_URL}/api/webhooks/blooio/${testData.organization.id}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          },
        );

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.success).toBe(true);
      });

      it("should handle message with attachments", async () => {
        const payload = {
          event: "message.received",
          message_id: "bloo_" + uuidv4(),
          sender: "+15559876543",
          text: "Check this out!",
          timestamp: Date.now(),
          protocol: "imessage",
          attachments: [{ url: "https://example.com/image.jpg", name: "image.jpg" }],
        };

        const response = await signedWebhookFetch(
          `${BASE_URL}/api/webhooks/blooio/${testData.organization.id}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          },
        );

        expect(response.status).toBe(200);
      });

      it("should handle message.sent event", async () => {
        const payload = {
          event: "message.sent",
          message_id: "bloo_" + uuidv4(),
          sender: "+15551234567",
          recipient: "+15559876543",
          timestamp: Date.now(),
        };

        const response = await signedWebhookFetch(
          `${BASE_URL}/api/webhooks/blooio/${testData.organization.id}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          },
        );

        expect(response.status).toBe(200);
      });

      it("should handle message.delivered event", async () => {
        const payload = {
          event: "message.delivered",
          message_id: "bloo_" + uuidv4(),
          timestamp: Date.now(),
        };

        const response = await signedWebhookFetch(
          `${BASE_URL}/api/webhooks/blooio/${testData.organization.id}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          },
        );

        expect(response.status).toBe(200);
      });

      it("should handle message.failed event", async () => {
        const payload = {
          event: "message.failed",
          message_id: "bloo_" + uuidv4(),
          error: "Delivery failed",
          timestamp: Date.now(),
        };

        const response = await signedWebhookFetch(
          `${BASE_URL}/api/webhooks/blooio/${testData.organization.id}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          },
        );

        expect(response.status).toBe(200);
      });

      it("should handle message.read event", async () => {
        const payload = {
          event: "message.read",
          message_id: "bloo_" + uuidv4(),
          timestamp: Date.now(),
        };

        const response = await signedWebhookFetch(
          `${BASE_URL}/api/webhooks/blooio/${testData.organization.id}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          },
        );

        expect(response.status).toBe(200);
      });

      it("should reject invalid JSON payload", async () => {
        const response = await signedWebhookFetch(
          `${BASE_URL}/api/webhooks/blooio/${testData.organization.id}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: "{ invalid json }",
          },
        );

        expect(response.status).toBe(400);
      });

      it("should handle empty message", async () => {
        const payload = {
          event: "message.received",
          message_id: "bloo_" + uuidv4(),
          sender: "+15559876543",
          text: "",
          timestamp: Date.now(),
          protocol: "imessage",
          attachments: [],
        };

        const response = await signedWebhookFetch(
          `${BASE_URL}/api/webhooks/blooio/${testData.organization.id}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          },
        );

        // Should still return 200 without processing.
        expect(response.status).toBe(200);
      });
    });

    describe("GET /api/webhooks/blooio/[orgId] (Health Check)", () => {
      it("should return health status", async () => {
        const response = await signedWebhookFetch(
          `${BASE_URL}/api/webhooks/blooio/${testData.organization.id}`,
          {
            method: "GET",
          },
        );

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.status).toBe("ok");
        expect(data.service).toBe("blooio-webhook");
      });
    });
  });

  describe("Webhook Security", () => {
    it("should reject invalid Twilio signatures", async () => {
      const formData = new URLSearchParams();
      formData.append("MessageSid", "SM123");
      formData.append("From", "+15559876543");
      formData.append("To", "+15551234567");
      formData.append("Body", "Test with signature");
      formData.append("AccountSid", "ACtest123");
      formData.append("NumMedia", "0");

      // Send with invalid signature
      const response = await signedWebhookFetch(
        `${BASE_URL}/api/webhooks/twilio/${testData.organization.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Twilio-Signature": "invalid_signature",
          },
          body: formData,
        },
      );

      expect(response.status).toBe(401);
    });

    it("should reject invalid Blooio signatures", async () => {
      const payload = {
        event: "message.received",
        message_id: "bloo_123",
        sender: "+15559876543",
        text: "Test with signature",
        timestamp: Date.now(),
      };

      // Send with invalid signature
      const response = await signedWebhookFetch(
        `${BASE_URL}/api/webhooks/blooio/${testData.organization.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Blooio-Signature": "invalid_signature",
          },
          body: JSON.stringify(payload),
        },
      );

      expect(response.status).toBe(401);
    });
  });

  describe("Error Handling", () => {
    it("should handle non-existent organization gracefully", async () => {
      const nonExistentOrgId = uuidv4();
      const formData = new URLSearchParams();
      formData.append("MessageSid", "SM123");
      formData.append("From", "+15559876543");
      formData.append("To", "+15551234567");
      formData.append("Body", "Test");

      const response = await signedWebhookFetch(
        `${BASE_URL}/api/webhooks/twilio/${nonExistentOrgId}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: formData,
        },
      );

      // Should handle gracefully, not crash
      expect([200, 400, 404, 500]).toContain(response.status);
    });

    it("should handle database errors gracefully", async () => {
      // This test would require mocking the database to fail
      // For now, we verify the endpoint doesn't crash with valid input
      const payload = {
        event: "message.received",
        message_id: "bloo_" + uuidv4(),
        sender: "+15559876543",
        text: "Database error test",
        timestamp: Date.now(),
        protocol: "imessage",
      };

      const response = await signedWebhookFetch(
        `${BASE_URL}/api/webhooks/blooio/${testData.organization.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      );

      // Should not return 5xx for valid requests
      expect(response.status).toBeLessThan(500);
    });
  });

  describe("Performance", () => {
    it("should handle multiple concurrent webhook requests", async () => {
      const requests = [];
      for (let i = 0; i < 10; i++) {
        const formData = new URLSearchParams();
        formData.append("MessageSid", "SM" + uuidv4().replace(/-/g, ""));
        formData.append("From", "+15559876543");
        formData.append("To", "+15551234567");
        formData.append("Body", `Concurrent test message ${i}`);
        formData.append("AccountSid", "ACtest123");
        formData.append("NumMedia", "0");

        requests.push(
          signedWebhookFetch(`${BASE_URL}/api/webhooks/twilio/${testData.organization.id}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: formData,
          }),
        );
      }

      const responses = await Promise.all(requests);
      const statuses = responses.map((r) => r.status);

      // All requests should succeed
      expect(statuses.every((s) => s === 200)).toBe(true);
    });

    it("should respond within acceptable time", async () => {
      const formData = new URLSearchParams();
      formData.append("MessageSid", "SM" + uuidv4().replace(/-/g, ""));
      formData.append("From", "+15559876543");
      formData.append("To", "+15551234567");
      formData.append("Body", "Performance test");
      formData.append("AccountSid", "ACtest123");
      formData.append("NumMedia", "0");

      const startTime = Date.now();
      const response = await signedWebhookFetch(
        `${BASE_URL}/api/webhooks/twilio/${testData.organization.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: formData,
        },
      );
      const duration = Date.now() - startTime;

      expect(response.status).toBe(200);
      // Should respond within 5 seconds for webhook acknowledgment
      expect(duration).toBeLessThan(5000);
    });
  });

  describe("Edge Cases - Twilio", () => {
    it("should handle missing MessageSid", async () => {
      const formData = new URLSearchParams();
      formData.append("From", "+15559876543");
      formData.append("To", "+15551234567");
      formData.append("Body", "No MessageSid");

      const response = await signedWebhookFetch(
        `${BASE_URL}/api/webhooks/twilio/${testData.organization.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: formData,
        },
      );

      // Should handle gracefully
      expect([200, 400]).toContain(response.status);
    });

    it("should handle very long message body", async () => {
      const formData = new URLSearchParams();
      formData.append("MessageSid", "SM" + uuidv4().replace(/-/g, ""));
      formData.append("From", "+15559876543");
      formData.append("To", "+15551234567");
      formData.append("Body", "A".repeat(10000));
      formData.append("AccountSid", "ACtest123");
      formData.append("NumMedia", "0");

      const response = await signedWebhookFetch(
        `${BASE_URL}/api/webhooks/twilio/${testData.organization.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: formData,
        },
      );

      expect(response.status).toBe(200);
    });

    it("should handle unicode in message body", async () => {
      const formData = new URLSearchParams();
      formData.append("MessageSid", "SM" + uuidv4().replace(/-/g, ""));
      formData.append("From", "+15559876543");
      formData.append("To", "+15551234567");
      formData.append("Body", "Hello 世界! 🎉 ñ é ü");
      formData.append("AccountSid", "ACtest123");
      formData.append("NumMedia", "0");

      const response = await signedWebhookFetch(
        `${BASE_URL}/api/webhooks/twilio/${testData.organization.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: formData,
        },
      );

      expect(response.status).toBe(200);
    });

    it("should handle multiple media URLs", async () => {
      const formData = new URLSearchParams();
      formData.append("MessageSid", "MM" + uuidv4().replace(/-/g, ""));
      formData.append("From", "+15559876543");
      formData.append("To", "+15551234567");
      formData.append("Body", "Multiple media");
      formData.append("AccountSid", "ACtest123");
      formData.append("NumMedia", "3");
      formData.append("MediaUrl0", "https://example.com/image1.jpg");
      formData.append("MediaUrl1", "https://example.com/image2.jpg");
      formData.append("MediaUrl2", "https://example.com/image3.jpg");
      formData.append("MediaContentType0", "image/jpeg");
      formData.append("MediaContentType1", "image/jpeg");
      formData.append("MediaContentType2", "image/jpeg");

      const response = await signedWebhookFetch(
        `${BASE_URL}/api/webhooks/twilio/${testData.organization.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: formData,
        },
      );

      expect(response.status).toBe(200);
    });

    it("should handle status callback webhook", async () => {
      const formData = new URLSearchParams();
      formData.append("MessageSid", "SM" + uuidv4().replace(/-/g, ""));
      formData.append("MessageStatus", "delivered");
      formData.append("To", "+15551234567");
      formData.append("From", "+15559876543");
      formData.append("AccountSid", "ACtest123");

      const response = await signedWebhookFetch(
        `${BASE_URL}/api/webhooks/twilio/${testData.organization.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: formData,
        },
      );

      expect([200, 400]).toContain(response.status);
    });
  });

  describe("Edge Cases - Blooio", () => {
    it("should handle missing sender in message.received", async () => {
      const payload = {
        event: "message.received",
        message_id: "bloo_" + uuidv4(),
        text: "No sender",
        timestamp: Date.now(),
        protocol: "imessage",
      };

      const response = await signedWebhookFetch(
        `${BASE_URL}/api/webhooks/blooio/${testData.organization.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      );

      // Should handle gracefully
      expect([200, 400]).toContain(response.status);
    });

    it("should handle unknown event type", async () => {
      const payload = {
        event: "unknown.event",
        message_id: "bloo_" + uuidv4(),
        timestamp: Date.now(),
      };

      const response = await signedWebhookFetch(
        `${BASE_URL}/api/webhooks/blooio/${testData.organization.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      );

      expect(response.status).toBe(200);
    });

    it("should handle message with only attachments", async () => {
      const payload = {
        event: "message.received",
        message_id: "bloo_" + uuidv4(),
        sender: "+15559876543",
        text: "",
        timestamp: Date.now(),
        protocol: "imessage",
        attachments: [{ url: "https://example.com/document.pdf", name: "document.pdf" }],
      };

      const response = await signedWebhookFetch(
        `${BASE_URL}/api/webhooks/blooio/${testData.organization.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      );

      expect(response.status).toBe(200);
    });

    it("should handle group message", async () => {
      const payload = {
        event: "message.received",
        message_id: "bloo_" + uuidv4(),
        sender: "+15559876543",
        text: "Group message",
        timestamp: Date.now(),
        protocol: "imessage",
        group_id: "grp_123456",
        participants: ["+15559876543", "+15551111111"],
      };

      const response = await signedWebhookFetch(
        `${BASE_URL}/api/webhooks/blooio/${testData.organization.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      );

      expect(response.status).toBe(200);
    });

    it("should handle typing indicator event", async () => {
      const payload = {
        event: "typing.started",
        sender: "+15559876543",
        timestamp: Date.now(),
      };

      const response = await signedWebhookFetch(
        `${BASE_URL}/api/webhooks/blooio/${testData.organization.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      );

      expect(response.status).toBe(200);
    });

    it("should handle email-based iMessage sender", async () => {
      const payload = {
        event: "message.received",
        message_id: "bloo_" + uuidv4(),
        sender: "user@icloud.com",
        text: "iMessage from email",
        timestamp: Date.now(),
        protocol: "imessage",
      };

      const response = await signedWebhookFetch(
        `${BASE_URL}/api/webhooks/blooio/${testData.organization.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      );

      expect(response.status).toBe(200);
    });
  });

  describe("Signature Verification Edge Cases", () => {
    it("should handle missing signature header for Twilio", async () => {
      const formData = new URLSearchParams();
      formData.append("MessageSid", "SM" + uuidv4().replace(/-/g, ""));
      formData.append("From", "+15559876543");
      formData.append("To", "+15551234567");
      formData.append("Body", "No signature header");
      formData.append("AccountSid", "ACtest123");
      formData.append("NumMedia", "0");

      const response = await signedWebhookFetch(
        `${BASE_URL}/api/webhooks/twilio/${testData.organization.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Test-Skip-Signature": "true",
          },
          body: formData,
        },
      );

      expect(response.status).toBe(401);
    });

    it("should handle empty signature header for Twilio", async () => {
      const formData = new URLSearchParams();
      formData.append("MessageSid", "SM" + uuidv4().replace(/-/g, ""));
      formData.append("From", "+15559876543");
      formData.append("To", "+15551234567");
      formData.append("Body", "Empty signature");
      formData.append("AccountSid", "ACtest123");
      formData.append("NumMedia", "0");

      const response = await signedWebhookFetch(
        `${BASE_URL}/api/webhooks/twilio/${testData.organization.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Twilio-Signature": "",
          },
          body: formData,
        },
      );

      expect(response.status).toBe(401);
    });

    it("should handle malformed signature for Blooio", async () => {
      const payload = {
        event: "message.received",
        message_id: "bloo_" + uuidv4(),
        sender: "+15559876543",
        text: "Malformed signature test",
        timestamp: Date.now(),
      };

      const response = await signedWebhookFetch(
        `${BASE_URL}/api/webhooks/blooio/${testData.organization.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Blooio-Signature": "not-a-valid-signature",
            "X-Blooio-Timestamp": Math.floor(Date.now() / 1000).toString(),
          },
          body: JSON.stringify(payload),
        },
      );

      expect(response.status).toBe(401);
    });
  });

  describe("Rate Limiting Behavior", () => {
    it("should handle rapid sequential requests", async () => {
      const responses = [];

      for (let i = 0; i < 20; i++) {
        const formData = new URLSearchParams();
        formData.append("MessageSid", "SM" + uuidv4().replace(/-/g, ""));
        formData.append("From", "+15559876543");
        formData.append("To", "+15551234567");
        // Keep the request on the fast path to avoid exercising outbound Twilio retries.
        formData.append("Body", "");
        formData.append("AccountSid", "ACtest123");
        formData.append("NumMedia", "0");

        const response = await signedWebhookFetch(
          `${BASE_URL}/api/webhooks/twilio/${testData.organization.id}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: formData,
          },
        );

        responses.push(response.status);
      }

      // Should not crash or rate limit under reasonable load
      expect(responses.every((s) => s === 200 || s === 429)).toBe(true);
    });
  });

  describe("Idempotency", () => {
    it("should handle duplicate Twilio message SID", async () => {
      const messageSid = "SM" + uuidv4().replace(/-/g, "");

      const formData1 = new URLSearchParams();
      formData1.append("MessageSid", messageSid);
      formData1.append("From", "+15559876543");
      formData1.append("To", "+15551234567");
      formData1.append("Body", "First send");
      formData1.append("AccountSid", "ACtest123");
      formData1.append("NumMedia", "0");

      const formData2 = new URLSearchParams();
      formData2.append("MessageSid", messageSid);
      formData2.append("From", "+15559876543");
      formData2.append("To", "+15551234567");
      formData2.append("Body", "Duplicate send");
      formData2.append("AccountSid", "ACtest123");
      formData2.append("NumMedia", "0");

      const response1 = await signedWebhookFetch(
        `${BASE_URL}/api/webhooks/twilio/${testData.organization.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: formData1,
        },
      );

      const response2 = await signedWebhookFetch(
        `${BASE_URL}/api/webhooks/twilio/${testData.organization.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: formData2,
        },
      );

      // Both should succeed (webhook should be idempotent)
      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);
    });

    it("should handle duplicate Blooio message ID", async () => {
      const messageId = "bloo_" + uuidv4();

      const payload1 = {
        event: "message.received",
        message_id: messageId,
        sender: "+15559876543",
        text: "First delivery",
        timestamp: Date.now(),
      };

      const payload2 = {
        event: "message.received",
        message_id: messageId,
        sender: "+15559876543",
        text: "Duplicate delivery",
        timestamp: Date.now(),
      };

      const response1 = await signedWebhookFetch(
        `${BASE_URL}/api/webhooks/blooio/${testData.organization.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload1),
        },
      );

      const response2 = await signedWebhookFetch(
        `${BASE_URL}/api/webhooks/blooio/${testData.organization.id}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload2),
        },
      );

      // Both should succeed (webhook should be idempotent)
      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);
    });
  });
});
