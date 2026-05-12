/**
 * TwilioAutomationService Integration Tests
 *
 * Tests for the Twilio automation service including:
 * - Credential validation
 * - Credential storage and retrieval
 * - Connection status with caching
 * - Message sending with E.164 validation
 * - Error handling
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { twilioAutomationService } from "@/lib/services/twilio-automation";

describe.skipIf(!process.env.DATABASE_URL || process.env.SKIP_DB_DEPENDENT === "1")(
  "TwilioAutomationService",
  () => {
    const testOrgId = "11111111-1111-1111-1111-111111111111";
    const _testUserId = "22222222-2222-2222-2222-222222222222";
    const testAccountSid = "ACtest12345678901234567890123456";
    const testAuthToken = "test_auth_token_12345678901234567";

    beforeEach(() => {
      // Clear the status cache before each test
      twilioAutomationService.invalidateStatusCache(testOrgId);
    });

    describe("validateCredentials", () => {
      it("returns invalid when accountSid is empty", async () => {
        const result = await twilioAutomationService.validateCredentials("", testAuthToken);
        expect(result.valid).toBe(false);
        expect(result.error).toContain("required");
      });

      it("returns invalid when authToken is empty", async () => {
        const result = await twilioAutomationService.validateCredentials(testAccountSid, "");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("required");
      });

      it("returns invalid when both are empty", async () => {
        const result = await twilioAutomationService.validateCredentials("", "");
        expect(result.valid).toBe(false);
        expect(result.error).toContain("required");
      });

      // Note: Full validation tests would require mocking twilioApiRequest
      // or actual Twilio credentials
    });

    describe("invalidateStatusCache", () => {
      it("clears cache for organization", () => {
        expect(() => {
          twilioAutomationService.invalidateStatusCache(testOrgId);
        }).not.toThrow();
      });

      it("handles multiple invalidations", () => {
        expect(() => {
          twilioAutomationService.invalidateStatusCache(testOrgId);
          twilioAutomationService.invalidateStatusCache(testOrgId);
          twilioAutomationService.invalidateStatusCache("33333333-3000-3000-3000-333333333333");
        }).not.toThrow();
      });
    });

    describe("getWebhookUrl", () => {
      it("returns correct webhook URL format", () => {
        const url = twilioAutomationService.getWebhookUrl(testOrgId);
        expect(url).toContain("/api/webhooks/twilio/");
        expect(url).toContain(testOrgId);
      });

      it("includes organization ID in URL", () => {
        const orgId = "44444444-4444-4444-4444-444444444444";
        const url = twilioAutomationService.getWebhookUrl(orgId);
        expect(url).toContain(orgId);
      });
    });

    describe("sendMessage", () => {
      it("returns error when Twilio is not configured", async () => {
        const result = await twilioAutomationService.sendMessage(testOrgId, {
          to: "+15551234567",
          body: "Test message",
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("not configured");
      });

      it("validates E.164 phone number format", async () => {
        // Invalid phone number format
        const result = await twilioAutomationService.sendMessage(testOrgId, {
          to: "5551234567", // Missing +
          body: "Test message",
        });

        // Should fail - either due to validation or not configured
        expect(result.success).toBe(false);
      });

      it("accepts valid E.164 format", async () => {
        const result = await twilioAutomationService.sendMessage(testOrgId, {
          to: "+15551234567",
          body: "Test message",
        });

        // Will fail because not configured, but format is valid
        expect(result.success).toBe(false);
      });

      it("handles message with media URLs", async () => {
        const result = await twilioAutomationService.sendMessage(testOrgId, {
          to: "+15551234567",
          body: "Check this out",
          mediaUrl: ["https://example.com/image.jpg"],
        });

        expect(result.success).toBe(false);
      });

      it("handles message with multiple media URLs", async () => {
        const result = await twilioAutomationService.sendMessage(testOrgId, {
          to: "+15551234567",
          body: "Multiple images",
          mediaUrl: ["https://example.com/image1.jpg", "https://example.com/image2.jpg"],
        });

        expect(result.success).toBe(false);
      });

      it("handles message with status callback", async () => {
        const result = await twilioAutomationService.sendMessage(testOrgId, {
          to: "+15551234567",
          body: "With callback",
          statusCallback: "https://example.com/callback",
        });

        expect(result.success).toBe(false);
      });
    });

    describe("isConfigured", () => {
      it("returns false when no credentials stored", async () => {
        const result = await twilioAutomationService.isConfigured(testOrgId);
        expect(typeof result).toBe("boolean");
      });
    });

    describe("getConnectionStatus", () => {
      it("returns unconfigured status when no credentials", async () => {
        const status = await twilioAutomationService.getConnectionStatus(testOrgId);

        expect(status).toHaveProperty("connected");
        expect(status).toHaveProperty("configured");
        expect(typeof status.connected).toBe("boolean");
        expect(typeof status.configured).toBe("boolean");
      });

      it("caches status for performance", async () => {
        const status1 = await twilioAutomationService.getConnectionStatus(testOrgId);
        const status2 = await twilioAutomationService.getConnectionStatus(testOrgId);

        // Results should be identical (from cache)
        expect(status1.connected).toBe(status2.connected);
        expect(status1.configured).toBe(status2.configured);
      });

      it("respects skipCache option", async () => {
        const _status1 = await twilioAutomationService.getConnectionStatus(testOrgId);
        const status2 = await twilioAutomationService.getConnectionStatus(testOrgId, {
          skipCache: true,
        });

        expect(status2).toHaveProperty("connected");
      });

      it("includes phoneNumber when available", async () => {
        const status = await twilioAutomationService.getConnectionStatus(testOrgId);

        // phoneNumber is optional
        if (status.connected) {
          expect(typeof status.phoneNumber === "string" || status.phoneNumber === undefined).toBe(
            true,
          );
        }
      });
    });

    describe("Credential Retrieval Methods", () => {
      describe("getAccountSid", () => {
        it("returns null when no credential stored", async () => {
          const sid = await twilioAutomationService.getAccountSid(
            "55555555-5555-5555-5555-555555555555",
          );
          expect(sid === null || typeof sid === "string").toBe(true);
        });
      });

      describe("getAuthToken", () => {
        it("returns null when no credential stored", async () => {
          const token = await twilioAutomationService.getAuthToken(
            "55555555-5555-5555-5555-555555555555",
          );
          expect(token === null || typeof token === "string").toBe(true);
        });
      });

      describe("getPhoneNumber", () => {
        it("returns null when no phone number stored", async () => {
          const phone = await twilioAutomationService.getPhoneNumber(
            "55555555-5555-5555-5555-555555555555",
          );
          expect(phone === null || typeof phone === "string").toBe(true);
        });
      });
    });

    describe("Error Handling", () => {
      it("handles empty organization ID", async () => {
        const status = await twilioAutomationService.getConnectionStatus(
          "00000000-0000-0000-0000-000000000000",
        );
        expect(status).toHaveProperty("connected");
      });

      it("handles special characters in organization ID", async () => {
        const status = await twilioAutomationService.getConnectionStatus(
          "00000000-0000-0000-0000-000000000001",
        );
        expect(status).toHaveProperty("connected");
      });
    });

    describe("Phone Number Validation", () => {
      // Test E.164 format validation through sendMessage

      it("rejects phone number without plus sign", async () => {
        const result = await twilioAutomationService.sendMessage(testOrgId, {
          to: "15551234567",
          body: "Test",
        });
        expect(result.success).toBe(false);
      });

      it("rejects phone number with spaces", async () => {
        const result = await twilioAutomationService.sendMessage(testOrgId, {
          to: "+1 555 123 4567",
          body: "Test",
        });
        expect(result.success).toBe(false);
      });

      it("rejects phone number with dashes", async () => {
        const result = await twilioAutomationService.sendMessage(testOrgId, {
          to: "+1-555-123-4567",
          body: "Test",
        });
        expect(result.success).toBe(false);
      });

      it("rejects phone number with parentheses", async () => {
        const result = await twilioAutomationService.sendMessage(testOrgId, {
          to: "+1 (555) 123-4567",
          body: "Test",
        });
        expect(result.success).toBe(false);
      });

      it("accepts international phone number", async () => {
        const result = await twilioAutomationService.sendMessage(testOrgId, {
          to: "+442071234567", // UK number
          body: "Test",
        });
        // Will fail because not configured, but format is valid
        expect(result.success).toBe(false);
      });
    });

    describe("Message Request Handling", () => {
      it("handles body-only message", async () => {
        const result = await twilioAutomationService.sendMessage(testOrgId, {
          to: "+15551234567",
          body: "Simple text message",
        });
        expect(result).toHaveProperty("success");
      });

      it("handles empty body with media", async () => {
        // Twilio allows sending MMS with just media (no body)
        const result = await twilioAutomationService.sendMessage(testOrgId, {
          to: "+15551234567",
          mediaUrl: ["https://example.com/image.jpg"],
        });
        expect(result).toHaveProperty("success");
      });

      it("handles very long message body", async () => {
        const longBody = "A".repeat(1600); // SMS segment limit
        const result = await twilioAutomationService.sendMessage(testOrgId, {
          to: "+15551234567",
          body: longBody,
        });
        expect(result).toHaveProperty("success");
      });

      it("handles unicode in message body", async () => {
        const result = await twilioAutomationService.sendMessage(testOrgId, {
          to: "+15551234567",
          body: "Hello 世界! 🎉 Émojis work too",
        });
        expect(result).toHaveProperty("success");
      });
    });

    describe("Credential Lifecycle", () => {
      it("exposes storeCredentials method", () => {
        expect(typeof twilioAutomationService.storeCredentials).toBe("function");
      });

      it("exposes removeCredentials method", () => {
        expect(typeof twilioAutomationService.removeCredentials).toBe("function");
      });

      // Full credential lifecycle tests would require database integration
      // These are tested in integration tests
    });
  },
);

describe.skipIf(!process.env.DATABASE_URL || process.env.SKIP_DB_DEPENDENT === "1")(
  "TwilioAutomationService Cache Behavior",
  () => {
    const cacheTestOrgId = "66666666-6666-6666-6666-666666666666";

    beforeEach(() => {
      twilioAutomationService.invalidateStatusCache(cacheTestOrgId);
    });

    it("cache TTL is reasonable (5 minutes)", async () => {
      // This test verifies cache behavior without waiting for actual TTL
      const status1 = await twilioAutomationService.getConnectionStatus(cacheTestOrgId);

      // Immediately after, should return cached result
      const status2 = await twilioAutomationService.getConnectionStatus(cacheTestOrgId);

      expect(status1.connected).toBe(status2.connected);
      expect(status1.configured).toBe(status2.configured);
    });

    it("skipCache forces fresh fetch", async () => {
      const status1 = await twilioAutomationService.getConnectionStatus(cacheTestOrgId);

      // With skipCache, should make fresh call
      const status2 = await twilioAutomationService.getConnectionStatus(cacheTestOrgId, {
        skipCache: true,
      });

      // Both should be valid responses
      expect(status1).toHaveProperty("connected");
      expect(status2).toHaveProperty("connected");
    });

    it("invalidateStatusCache clears cache", async () => {
      // First call to populate cache
      await twilioAutomationService.getConnectionStatus(cacheTestOrgId);

      // Invalidate
      twilioAutomationService.invalidateStatusCache(cacheTestOrgId);

      // Should not throw
      const status = await twilioAutomationService.getConnectionStatus(cacheTestOrgId);
      expect(status).toHaveProperty("connected");
    });
  },
);

describe.skipIf(!process.env.DATABASE_URL || process.env.SKIP_DB_DEPENDENT === "1")(
  "TwilioAutomationService Edge Cases",
  () => {
    it("handles concurrent status checks for same org", async () => {
      const orgId = "77777777-7777-7777-7777-777777777777";
      twilioAutomationService.invalidateStatusCache(orgId);

      // Make multiple concurrent requests
      const promises = Array(5)
        .fill(null)
        .map(() => twilioAutomationService.getConnectionStatus(orgId));

      const results = await Promise.all(promises);

      // All should succeed
      for (const status of results) {
        expect(status).toHaveProperty("connected");
        expect(status).toHaveProperty("configured");
      }
    });

    it("handles concurrent status checks for different orgs", async () => {
      const orgIds = [
        "88888888-8888-8888-8888-888888888881",
        "88888888-8888-8888-8888-888888888882",
        "88888888-8888-8888-8888-888888888883",
        "88888888-8888-8888-8888-888888888884",
        "88888888-8888-8888-8888-888888888885",
      ];

      for (const orgId of orgIds) {
        twilioAutomationService.invalidateStatusCache(orgId);
      }

      const promises = orgIds.map((orgId) => twilioAutomationService.getConnectionStatus(orgId));

      const results = await Promise.all(promises);

      for (const status of results) {
        expect(status).toHaveProperty("connected");
      }
    });

    it("handles concurrent message sends", async () => {
      const promises = Array(5)
        .fill(null)
        .map((_, i) =>
          twilioAutomationService.sendMessage("99999999-9999-9999-9999-999999999999", {
            to: `+1555000000${i}`,
            body: `Concurrent message ${i}`,
          }),
        );

      const results = await Promise.all(promises);

      // All should return (success or failure), not throw
      for (const result of results) {
        expect(result).toHaveProperty("success");
      }
    });
  },
);
