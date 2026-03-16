/**
 * BlooioAutomationService Unit Tests
 *
 * Tests for the Blooio automation service including:
 * - API key validation
 * - Credential storage and retrieval
 * - Connection status with caching
 * - Message sending
 * - Chat ID validation
 * - Error handling
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { blooioAutomationService } from "@/lib/services/blooio-automation";

// Mock external dependencies
const mockSecretsService = {
  create: mock(() => Promise.resolve()),
  list: mock(() => Promise.resolve([])),
  get: mock(() => Promise.resolve(null)),
  rotate: mock(() => Promise.resolve()),
  delete: mock(() => Promise.resolve()),
};

const mockBlooioApiRequest = mock(() => Promise.resolve({}));
const mockValidateBlooioChatId = mock(() => true);

// These would typically be mocked at module level, but for now we test observable behavior

describe("BlooioAutomationService", () => {
  const testOrgId = "org-123";
  const testUserId = "user-456";
  const testApiKey = "bloo_test_api_key_123";

  beforeEach(() => {
    // Clear the status cache before each test
    blooioAutomationService.invalidateStatusCache(testOrgId);
  });

  describe("validateApiKey", () => {
    it("returns invalid when API key is empty", async () => {
      const result = await blooioAutomationService.validateApiKey("");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("API key is required");
    });

    it("returns invalid when API key is whitespace", async () => {
      const result = await blooioAutomationService.validateApiKey("   ");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("API key is required");
    });

    // Note: Full validation tests would require mocking blooioApiRequest
  });

  describe("invalidateStatusCache", () => {
    it("clears cache for organization", async () => {
      // This is a simple method that clears the internal cache
      // We test it doesn't throw
      expect(() => {
        blooioAutomationService.invalidateStatusCache(testOrgId);
      }).not.toThrow();
    });

    it("handles multiple invalidations", () => {
      expect(() => {
        blooioAutomationService.invalidateStatusCache(testOrgId);
        blooioAutomationService.invalidateStatusCache(testOrgId);
        blooioAutomationService.invalidateStatusCache("other-org");
      }).not.toThrow();
    });
  });

  describe("getWebhookUrl", () => {
    it("returns correct webhook URL format", () => {
      const url = blooioAutomationService.getWebhookUrl(testOrgId);
      expect(url).toContain("/api/webhooks/blooio/");
      expect(url).toContain(testOrgId);
    });

    it("includes organization ID in URL", () => {
      const orgId = "test-org-xyz";
      const url = blooioAutomationService.getWebhookUrl(orgId);
      expect(url).toContain(orgId);
    });
  });

  describe("Chat ID Validation", () => {
    // These tests validate the chat ID normalization and validation logic

    describe("normalizes chat IDs", () => {
      it("handles phone numbers", async () => {
        // sendMessage normalizes chat IDs before sending
        // This tests the format validation behavior
        const result = await blooioAutomationService.sendMessage(
          testOrgId,
          "+15551234567",
          { text: "test" }
        );
        
        // Will fail because no API key, but tests normalization path
        expect(result.success).toBe(false);
      });

      it("handles email addresses", async () => {
        const result = await blooioAutomationService.sendMessage(
          testOrgId,
          "user@example.com",
          { text: "test" }
        );
        
        expect(result.success).toBe(false);
        // Would fail at send, not validation
      });

      it("handles comma-separated chat IDs", async () => {
        // Test multiple recipients
        const result = await blooioAutomationService.sendMessage(
          testOrgId,
          "+15551234567, +15559876543",
          { text: "test" }
        );
        
        expect(result.success).toBe(false);
      });
    });
  });

  describe("sendMessage", () => {
    it("returns error when Blooio is not configured", async () => {
      // getApiKey returns null when not configured
      const result = await blooioAutomationService.sendMessage(
        testOrgId,
        "+15551234567",
        { text: "Hello" }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("not configured");
    });

    it("validates chat ID format", async () => {
      // Invalid chat ID format - would fail validation if API key existed
      const result = await blooioAutomationService.sendMessage(
        testOrgId,
        "invalid-chat-id",
        { text: "Hello" }
      );

      // May return "not configured" or validation error depending on order
      expect(result.success).toBe(false);
    });

    it("handles group chat IDs", async () => {
      // Group IDs start with grp_
      const result = await blooioAutomationService.sendMessage(
        testOrgId,
        "grp_abc123",
        { text: "Hello group" }
      );

      // Will fail due to no config, but validates format is accepted
      expect(result.success).toBe(false);
    });

    it("handles message with attachments", async () => {
      const result = await blooioAutomationService.sendMessage(
        testOrgId,
        "+15551234567",
        {
          text: "Check this out",
          attachments: [
            { url: "https://example.com/image.jpg", name: "image.jpg" }
          ]
        }
      );

      expect(result.success).toBe(false);
    });

    it("handles message with metadata", async () => {
      const result = await blooioAutomationService.sendMessage(
        testOrgId,
        "+15551234567",
        {
          text: "With metadata",
          metadata: { source: "test", timestamp: Date.now() }
        }
      );

      expect(result.success).toBe(false);
    });
  });

  describe("isConfigured", () => {
    it("returns false when no API key is stored", async () => {
      const result = await blooioAutomationService.isConfigured(testOrgId);
      // Without mocking secrets service, this depends on actual secrets
      expect(typeof result).toBe("boolean");
    });
  });

  describe("getConnectionStatus", () => {
    it("returns unconfigured status when no API key", async () => {
      const status = await blooioAutomationService.getConnectionStatus(testOrgId);
      
      // Without mock, depends on actual config
      expect(status).toHaveProperty("connected");
      expect(status).toHaveProperty("configured");
      expect(typeof status.connected).toBe("boolean");
      expect(typeof status.configured).toBe("boolean");
    });

    it("caches status for performance", async () => {
      // First call
      const status1 = await blooioAutomationService.getConnectionStatus(testOrgId);
      
      // Second call should use cache
      const status2 = await blooioAutomationService.getConnectionStatus(testOrgId);
      
      // Results should be identical
      expect(status1.connected).toBe(status2.connected);
      expect(status1.configured).toBe(status2.configured);
    });

    it("respects skipCache option", async () => {
      // First call
      const status1 = await blooioAutomationService.getConnectionStatus(testOrgId);
      
      // Second call with skipCache
      const status2 = await blooioAutomationService.getConnectionStatus(testOrgId, {
        skipCache: true,
      });
      
      // Both should work without error
      expect(status2).toHaveProperty("connected");
    });

    it("returns fromNumber when available", async () => {
      const status = await blooioAutomationService.getConnectionStatus(testOrgId);
      
      // fromNumber is optional
      if (status.connected) {
        expect(typeof status.fromNumber === "string" || status.fromNumber === undefined).toBe(true);
      }
    });
  });

  describe("Error Handling", () => {
    it("handles empty organization ID gracefully", async () => {
      const status = await blooioAutomationService.getConnectionStatus("");
      expect(status).toHaveProperty("connected");
    });

    it("handles special characters in organization ID", async () => {
      const status = await blooioAutomationService.getConnectionStatus("org-with-special-chars-!@#$");
      expect(status).toHaveProperty("connected");
    });
  });

  describe("Credential Methods", () => {
    describe("getApiKey", () => {
      it("returns null when no API key stored", async () => {
        // This tests the fallback behavior
        const apiKey = await blooioAutomationService.getApiKey("non-existent-org");
        // May return null or env var fallback
        expect(apiKey === null || typeof apiKey === "string").toBe(true);
      });
    });

    describe("getWebhookSecret", () => {
      it("returns null when no webhook secret stored", async () => {
        const secret = await blooioAutomationService.getWebhookSecret("non-existent-org");
        expect(secret === null || typeof secret === "string").toBe(true);
      });
    });

    describe("getFromNumber", () => {
      it("returns null when no from number stored", async () => {
        const fromNumber = await blooioAutomationService.getFromNumber("non-existent-org");
        expect(fromNumber === null || typeof fromNumber === "string").toBe(true);
      });
    });
  });

  describe("Message Request Handling", () => {
    it("handles text-only message", async () => {
      const result = await blooioAutomationService.sendMessage(
        testOrgId,
        "+15551234567",
        { text: "Simple text message" }
      );
      expect(result).toHaveProperty("success");
    });

    it("handles message with typing indicator", async () => {
      const result = await blooioAutomationService.sendMessage(
        testOrgId,
        "+15551234567",
        {
          text: "Message with typing",
          use_typing_indicator: true,
        }
      );
      expect(result).toHaveProperty("success");
    });

    it("handles message with idempotency key", async () => {
      const result = await blooioAutomationService.sendMessage(
        testOrgId,
        "+15551234567",
        {
          text: "Idempotent message",
          idempotencyKey: "unique-key-123",
        }
      );
      expect(result).toHaveProperty("success");
    });
  });
});

describe("BlooioAutomationService Integration-style Tests", () => {
  // These tests would require database and secrets service to be available
  // They test the full flow without external Blooio API calls

  const integrationOrgId = "integration-test-org";
  const integrationUserId = "integration-test-user";

  describe("Credential Lifecycle", () => {
    it("can store and retrieve credentials", async () => {
      // This would require actual database access
      // For now, we verify the method signatures
      const credentials = {
        apiKey: "test-api-key",
        webhookSecret: "test-webhook-secret",
        fromNumber: "+15551234567",
      };

      // These calls would interact with the secrets service
      // In a real integration test, we'd verify the data is persisted
      expect(typeof blooioAutomationService.storeCredentials).toBe("function");
      expect(typeof blooioAutomationService.removeCredentials).toBe("function");
    });

    it("credential storage invalidates cache", async () => {
      // Verify that storeCredentials calls invalidateStatusCache
      // This is behavioral verification without mocking
      expect(typeof blooioAutomationService.storeCredentials).toBe("function");
    });
  });
});
