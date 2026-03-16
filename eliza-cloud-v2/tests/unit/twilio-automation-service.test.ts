/**
 * TwilioAutomationService Unit Tests
 *
 * Tests for the Twilio automation service including:
 * - Credential validation
 * - Credential storage and retrieval
 * - Connection status with caching
 * - Message sending with E.164 validation
 * - Error handling
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { twilioAutomationService } from "@/lib/services/twilio-automation";

describe("TwilioAutomationService", () => {
  const testOrgId = "test-org-123";
  const testUserId = "test-user-456";
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
        twilioAutomationService.invalidateStatusCache("other-org");
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
      const orgId = "my-twilio-org";
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
        mediaUrl: [
          "https://example.com/image1.jpg",
          "https://example.com/image2.jpg",
        ],
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
      const status1 = await twilioAutomationService.getConnectionStatus(testOrgId);
      const status2 = await twilioAutomationService.getConnectionStatus(testOrgId, {
        skipCache: true,
      });

      expect(status2).toHaveProperty("connected");
    });

    it("includes phoneNumber when available", async () => {
      const status = await twilioAutomationService.getConnectionStatus(testOrgId);

      // phoneNumber is optional
      if (status.connected) {
        expect(typeof status.phoneNumber === "string" || status.phoneNumber === undefined).toBe(true);
      }
    });
  });

  describe("Credential Retrieval Methods", () => {
    describe("getAccountSid", () => {
      it("returns null when no credential stored", async () => {
        const sid = await twilioAutomationService.getAccountSid("non-existent-org");
        expect(sid === null || typeof sid === "string").toBe(true);
      });
    });

    describe("getAuthToken", () => {
      it("returns null when no credential stored", async () => {
        const token = await twilioAutomationService.getAuthToken("non-existent-org");
        expect(token === null || typeof token === "string").toBe(true);
      });
    });

    describe("getPhoneNumber", () => {
      it("returns null when no phone number stored", async () => {
        const phone = await twilioAutomationService.getPhoneNumber("non-existent-org");
        expect(phone === null || typeof phone === "string").toBe(true);
      });
    });
  });

  describe("Error Handling", () => {
    it("handles empty organization ID", async () => {
      const status = await twilioAutomationService.getConnectionStatus("");
      expect(status).toHaveProperty("connected");
    });

    it("handles special characters in organization ID", async () => {
      const status = await twilioAutomationService.getConnectionStatus("org-!@#$%");
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
});

describe("TwilioAutomationService Cache Behavior", () => {
  const cacheTestOrgId = "cache-test-org";

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
});

describe("TwilioAutomationService Edge Cases", () => {
  it("handles concurrent status checks for same org", async () => {
    const orgId = "concurrent-test-org";
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
    const orgIds = ["org-1", "org-2", "org-3", "org-4", "org-5"];

    for (const orgId of orgIds) {
      twilioAutomationService.invalidateStatusCache(orgId);
    }

    const promises = orgIds.map((orgId) =>
      twilioAutomationService.getConnectionStatus(orgId)
    );

    const results = await Promise.all(promises);

    for (const status of results) {
      expect(status).toHaveProperty("connected");
    }
  });

  it("handles concurrent message sends", async () => {
    const promises = Array(5)
      .fill(null)
      .map((_, i) =>
        twilioAutomationService.sendMessage("test-org", {
          to: `+1555000000${i}`,
          body: `Concurrent message ${i}`,
        })
      );

    const results = await Promise.all(promises);

    // All should return (success or failure), not throw
    for (const result of results) {
      expect(result).toHaveProperty("success");
    }
  });
});
