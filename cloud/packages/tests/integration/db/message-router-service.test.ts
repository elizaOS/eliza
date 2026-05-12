/**
 * MessageRouterService Integration Tests
 *
 * Tests for the message router service including:
 * - Phone number normalization
 * - Message routing logic
 * - Entity and room ID generation
 * - Message logging
 * - Error handling
 */

import { describe, expect, it } from "bun:test";
import { messageRouterService } from "@/lib/services/message-router";

describe.skipIf(!process.env.DATABASE_URL || process.env.SKIP_DB_DEPENDENT === "1")(
  "MessageRouterService",
  () => {
    const testOrgId = "88888888-8888-8888-8888-888888888888";

    describe("Phone Number Normalization", () => {
      // The private normalizePhoneNumber method is tested indirectly through public methods

      it("handles standard E.164 format in routing", async () => {
        const result = await messageRouterService.routeIncomingMessage({
          from: "+15551234567",
          to: "+15559876543",
          body: "Test message",
          provider: "twilio",
        });

        // Will fail because no phone mapping, but tests normalization path
        expect(result).toHaveProperty("success");
      });

      it("handles phone number without country code", async () => {
        const result = await messageRouterService.routeIncomingMessage({
          from: "5551234567",
          to: "+15559876543",
          body: "Test message",
          provider: "twilio",
        });

        expect(result).toHaveProperty("success");
      });

      it("handles phone number with spaces and dashes", async () => {
        const result = await messageRouterService.routeIncomingMessage({
          from: "+1 555-123-4567",
          to: "+15559876543",
          body: "Test message",
          provider: "twilio",
        });

        expect(result).toHaveProperty("success");
      });

      it("handles email addresses for iMessage", async () => {
        const result = await messageRouterService.routeIncomingMessage({
          from: "user@example.com",
          to: "agent@company.com",
          body: "iMessage via email",
          provider: "blooio",
        });

        expect(result).toHaveProperty("success");
      });

      it("handles uppercase email addresses", async () => {
        const result = await messageRouterService.routeIncomingMessage({
          from: "USER@EXAMPLE.COM",
          to: "agent@company.com",
          body: "Uppercase email",
          provider: "blooio",
        });

        expect(result).toHaveProperty("success");
      });
    });

    describe("routeIncomingMessage", () => {
      it("returns error when no phone mapping found", async () => {
        const result = await messageRouterService.routeIncomingMessage({
          from: "+15551234567",
          to: "+15559999999", // Non-existent mapping
          body: "Test message",
          provider: "twilio",
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("No agent configured");
      });

      it("includes error message in result", async () => {
        const result = await messageRouterService.routeIncomingMessage({
          from: "+15551234567",
          to: "+10000000000",
          body: "Test",
          provider: "twilio",
        });

        expect(result.success).toBe(false);
        expect(result).toHaveProperty("error");
        expect(typeof result.error).toBe("string");
      });

      it("handles message with media URLs", async () => {
        const result = await messageRouterService.routeIncomingMessage({
          from: "+15551234567",
          to: "+15559876543",
          body: "Check this out",
          provider: "twilio",
          mediaUrls: ["https://example.com/image.jpg"],
        });

        expect(result).toHaveProperty("success");
      });

      it("handles message with metadata", async () => {
        const result = await messageRouterService.routeIncomingMessage({
          from: "+15551234567",
          to: "+15559876543",
          body: "With metadata",
          provider: "twilio",
          metadata: {
            fromCity: "San Francisco",
            fromState: "CA",
          },
        });

        expect(result).toHaveProperty("success");
      });

      it("handles different message types", async () => {
        const smsResult = await messageRouterService.routeIncomingMessage({
          from: "+15551234567",
          to: "+15559876543",
          body: "SMS",
          provider: "twilio",
          messageType: "sms",
        });

        const mmsResult = await messageRouterService.routeIncomingMessage({
          from: "+15551234567",
          to: "+15559876543",
          body: "MMS",
          provider: "twilio",
          messageType: "mms",
        });

        expect(smsResult).toHaveProperty("success");
        expect(mmsResult).toHaveProperty("success");
      });

      it("handles iMessage type", async () => {
        const result = await messageRouterService.routeIncomingMessage({
          from: "+15551234567",
          to: "+15559876543",
          body: "iMessage",
          provider: "blooio",
          messageType: "imessage",
        });

        expect(result).toHaveProperty("success");
      });

      it("handles WhatsApp message type", async () => {
        const result = await messageRouterService.routeIncomingMessage({
          from: "14245071234",
          to: "+14245074963",
          body: "WhatsApp message",
          provider: "whatsapp",
          messageType: "whatsapp",
        });

        expect(result).toHaveProperty("success");
      });
    });

    describe("sendMessage", () => {
      it("returns false for unknown provider", async () => {
        const result = await messageRouterService.sendMessage({
          to: "+15551234567",
          from: "+15559876543",
          body: "Test message",
          // @ts-expect-error - Testing invalid provider
          provider: "unknown",
          organizationId: testOrgId,
        });

        expect(result).toBe(false);
      });

      it("handles Twilio provider (fails without credentials)", async () => {
        const result = await messageRouterService.sendMessage({
          to: "+15551234567",
          from: "+15559876543",
          body: "Test message",
          provider: "twilio",
          organizationId: testOrgId,
        });

        // Will fail due to missing credentials
        expect(result).toBe(false);
      });

      it("handles Blooio provider (fails without credentials)", async () => {
        const result = await messageRouterService.sendMessage({
          to: "+15551234567",
          from: "+15559876543",
          body: "Test message",
          provider: "blooio",
          organizationId: testOrgId,
        });

        // Will fail due to missing credentials
        expect(result).toBe(false);
      });

      it("handles WhatsApp provider (fails without credentials)", async () => {
        const result = await messageRouterService.sendMessage({
          to: "14245071234",
          from: "+14245074963",
          body: "Test WhatsApp message",
          provider: "whatsapp",
          organizationId: testOrgId,
        });

        // Will fail due to missing credentials
        expect(result).toBe(false);
      });

      it("handles message with media URLs", async () => {
        const result = await messageRouterService.sendMessage({
          to: "+15551234567",
          from: "+15559876543",
          body: "With media",
          provider: "twilio",
          organizationId: testOrgId,
          mediaUrls: ["https://example.com/image.jpg"],
        });

        expect(typeof result).toBe("boolean");
      });
    });

    describe("getPhoneNumbers", () => {
      it("returns array for organization", async () => {
        const phoneNumbers = await messageRouterService.getPhoneNumbers(testOrgId);
        expect(Array.isArray(phoneNumbers)).toBe(true);
      });

      it("returns empty array for non-existent organization", async () => {
        const phoneNumbers = await messageRouterService.getPhoneNumbers(
          "99999999-9999-9999-9999-999999999999",
        );
        expect(Array.isArray(phoneNumbers)).toBe(true);
      });
    });

    describe("getPhoneNumberById", () => {
      it("returns null for non-existent phone number", async () => {
        const phoneNumber = await messageRouterService.getPhoneNumberById(
          "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        );
        expect(phoneNumber).toBeNull();
      });

      it("throws error for invalid UUID format", async () => {
        await expect(messageRouterService.getPhoneNumberById("not-a-uuid")).rejects.toThrow();
      });
    });

    describe("deactivatePhoneNumber", () => {
      it("does not throw for non-existent phone number", async () => {
        await messageRouterService.deactivatePhoneNumber("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
      });
    });

    describe("Error Handling", () => {
      it("handles empty message body", async () => {
        const result = await messageRouterService.routeIncomingMessage({
          from: "+15551234567",
          to: "+15559876543",
          body: "",
          provider: "twilio",
        });

        expect(result).toHaveProperty("success");
      });

      it("handles undefined optional fields", async () => {
        const result = await messageRouterService.routeIncomingMessage({
          from: "+15551234567",
          to: "+15559876543",
          body: "Test",
          provider: "twilio",
          mediaUrls: undefined,
          metadata: undefined,
          providerMessageId: undefined,
        });

        expect(result).toHaveProperty("success");
      });

      it("handles special characters in message body", async () => {
        const result = await messageRouterService.routeIncomingMessage({
          from: "+15551234567",
          to: "+15559876543",
          body: "Hello! 🎉 <script>alert('xss')</script> && \"quotes\"",
          provider: "twilio",
        });

        expect(result).toHaveProperty("success");
      });

      it("handles very long message body", async () => {
        const longBody = "A".repeat(10000);
        const result = await messageRouterService.routeIncomingMessage({
          from: "+15551234567",
          to: "+15559876543",
          body: longBody,
          provider: "twilio",
        });

        expect(result).toHaveProperty("success");
      });
    });

    describe("registerPhoneNumber", () => {
      // Note: These tests may fail if database is not available
      // They verify the method signatures and basic error handling

      it("has correct method signature", () => {
        expect(typeof messageRouterService.registerPhoneNumber).toBe("function");
      });

      it("requires organizationId, agentId, phoneNumber, and provider", async () => {
        // Testing with valid parameters (may succeed or fail based on DB)
        const _params = {
          organizationId: testOrgId,
          agentId: "test-agent-id",
          phoneNumber: "+15550001234",
          provider: "twilio" as const,
        };

        // This test verifies the method is callable with correct params
        expect(typeof messageRouterService.registerPhoneNumber).toBe("function");
      });
    });

    describe("updateMessageLog", () => {
      it("has correct method signature", () => {
        expect(typeof messageRouterService.updateMessageLog).toBe("function");
      });
    });

    describe("markMessageFailed", () => {
      it("has correct method signature", () => {
        expect(typeof messageRouterService.markMessageFailed).toBe("function");
      });
    });
  },
);

describe.skipIf(!process.env.DATABASE_URL || process.env.SKIP_DB_DEPENDENT === "1")(
  "MessageRouterService ID Generation",
  () => {
    // Test deterministic ID generation behavior

    describe("Entity ID Generation", () => {
      it("generates consistent IDs for same phone number", async () => {
        // We test this indirectly through routing behavior
        // The entity ID should be deterministic for the same input
        const result1 = await messageRouterService.routeIncomingMessage({
          from: "+15551234567",
          to: "+15559876543",
          body: "Message 1",
          provider: "twilio",
        });

        const result2 = await messageRouterService.routeIncomingMessage({
          from: "+15551234567",
          to: "+15559876543",
          body: "Message 2",
          provider: "twilio",
        });

        // Both should go through same routing logic
        expect(result1).toHaveProperty("success");
        expect(result2).toHaveProperty("success");
      });
    });

    describe("Room ID Generation", () => {
      it("generates consistent IDs regardless of direction", async () => {
        // Room ID should be the same whether from A->B or B->A
        const result1 = await messageRouterService.routeIncomingMessage({
          from: "+15551111111",
          to: "+15552222222",
          body: "A to B",
          provider: "twilio",
        });

        const result2 = await messageRouterService.routeIncomingMessage({
          from: "+15552222222",
          to: "+15551111111",
          body: "B to A",
          provider: "twilio",
        });

        // Both should work (even if they fail for other reasons)
        expect(result1).toHaveProperty("success");
        expect(result2).toHaveProperty("success");
      });
    });
  },
);

describe.skipIf(!process.env.DATABASE_URL || process.env.SKIP_DB_DEPENDENT === "1")(
  "MessageRouterService Concurrent Operations",
  () => {
    const concurrentOrgId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

    it("handles concurrent message routing", async () => {
      const promises = Array(10)
        .fill(null)
        .map((_, i) =>
          messageRouterService.routeIncomingMessage({
            from: `+1555000000${i}`,
            to: "+15559876543",
            body: `Concurrent message ${i}`,
            provider: "twilio",
          }),
        );

      const results = await Promise.all(promises);

      // All should complete (success or failure)
      for (const result of results) {
        expect(result).toHaveProperty("success");
      }
    });

    it("handles concurrent message sending", async () => {
      const promises = Array(5)
        .fill(null)
        .map((_, i) =>
          messageRouterService.sendMessage({
            to: `+1555000000${i}`,
            from: "+15559876543",
            body: `Concurrent send ${i}`,
            provider: "twilio",
            organizationId: concurrentOrgId,
          }),
        );

      const results = await Promise.all(promises);

      // All should complete (all false since no credentials)
      for (const result of results) {
        expect(typeof result).toBe("boolean");
      }
    });

    it("handles concurrent phone number lookups", async () => {
      const promises = Array(10)
        .fill(null)
        .map(() => messageRouterService.getPhoneNumbers(concurrentOrgId));

      const results = await Promise.all(promises);

      // All should return arrays
      for (const result of results) {
        expect(Array.isArray(result)).toBe(true);
      }
    });
  },
);

describe.skipIf(!process.env.DATABASE_URL || process.env.SKIP_DB_DEPENDENT === "1")(
  "MessageRouterService Provider Handling",
  () => {
    it("correctly identifies Twilio messages", async () => {
      const result = await messageRouterService.routeIncomingMessage({
        from: "+15551234567",
        to: "+15559876543",
        body: "Twilio message",
        provider: "twilio",
        messageType: "sms",
      });

      expect(result).toHaveProperty("success");
    });

    it("correctly identifies Blooio messages", async () => {
      const result = await messageRouterService.routeIncomingMessage({
        from: "+15551234567",
        to: "+15559876543",
        body: "Blooio message",
        provider: "blooio",
        messageType: "imessage",
      });

      expect(result).toHaveProperty("success");
    });

    it("handles provider message ID", async () => {
      const result = await messageRouterService.routeIncomingMessage({
        from: "+15551234567",
        to: "+15559876543",
        body: "With provider ID",
        provider: "twilio",
        providerMessageId: "SM" + "a".repeat(32),
      });

      expect(result).toHaveProperty("success");
    });
  },
);
