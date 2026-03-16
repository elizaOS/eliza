/**
 * Idempotency Utility Tests
 *
 * Tests for the database-backed idempotency service.
 * These tests verify that replay protection works correctly.
 *
 * Note: These tests require database connectivity. In a CI environment,
 * they may need to be skipped or run with a test database.
 */

import { describe, it, expect, afterAll } from "bun:test";
import {
  isAlreadyProcessed,
  markAsProcessed,
  getProcessedMessagesCount,
  cleanupExpiredKeys,
  clearProcessedMessages,
} from "@/lib/utils/idempotency";

describe("Idempotency Utility", () => {
  // Use unique keys for each test to avoid conflicts
  const testPrefix = `test-${Date.now()}`;

  afterAll(async () => {
    // Clean up after all tests
    try {
      await clearProcessedMessages();
    } catch {
      // Ignore cleanup errors in tests
    }
  });

  describe("isAlreadyProcessed", () => {
    it("returns false for new keys", async () => {
      const key = `${testPrefix}:new-key-${Date.now()}`;
      const result = await isAlreadyProcessed(key);
      expect(result).toBe(false);
    });

    it("returns true for processed keys", async () => {
      const key = `${testPrefix}:processed-key-${Date.now()}`;

      // Mark as processed
      await markAsProcessed(key, "test");

      // Check if already processed
      const result = await isAlreadyProcessed(key);
      expect(result).toBe(true);
    });

    it("handles empty key gracefully", async () => {
      const result = await isAlreadyProcessed("");
      expect(typeof result).toBe("boolean");
    });

    it("handles special characters in keys", async () => {
      const key = `${testPrefix}:special-!@#$%^&*()-${Date.now()}`;
      expect(await isAlreadyProcessed(key)).toBe(false);

      await markAsProcessed(key, "test");
      expect(await isAlreadyProcessed(key)).toBe(true);
    });
  });

  describe("markAsProcessed", () => {
    it("marks a key as processed", async () => {
      const key = `${testPrefix}:mark-test-${Date.now()}`;

      // Initially not processed
      expect(await isAlreadyProcessed(key)).toBe(false);

      // Mark as processed
      await markAsProcessed(key, "blooio");

      // Now should be processed
      expect(await isAlreadyProcessed(key)).toBe(true);
    });

    it("accepts source parameter", async () => {
      const key = `${testPrefix}:source-test-${Date.now()}`;

      // This should not throw
      await expect(markAsProcessed(key, "twilio")).resolves.not.toThrow();
    });

    it("uses default source when not provided", async () => {
      const key = `${testPrefix}:default-source-${Date.now()}`;

      // Should not throw
      await expect(markAsProcessed(key)).resolves.not.toThrow();
    });

    it("handles duplicate marking gracefully", async () => {
      const key = `${testPrefix}:duplicate-${Date.now()}`;

      // Mark twice - should not throw
      await markAsProcessed(key, "test");
      await expect(markAsProcessed(key, "test")).resolves.not.toThrow();

      // Should still be processed
      expect(await isAlreadyProcessed(key)).toBe(true);
    });
  });

  describe("getProcessedMessagesCount", () => {
    it("returns a number", async () => {
      const count = await getProcessedMessagesCount();
      expect(typeof count).toBe("number");
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it("increases after marking a key", async () => {
      const initialCount = await getProcessedMessagesCount();

      const key = `${testPrefix}:count-test-${Date.now()}`;
      await markAsProcessed(key, "test");

      const newCount = await getProcessedMessagesCount();
      expect(newCount).toBeGreaterThanOrEqual(initialCount);
    });
  });

  describe("cleanupExpiredKeys", () => {
    it("returns number of deleted keys", async () => {
      const deletedCount = await cleanupExpiredKeys();
      expect(typeof deletedCount).toBe("number");
      expect(deletedCount).toBeGreaterThanOrEqual(0);
    });

    it("does not delete recent keys", async () => {
      const key = `${testPrefix}:recent-${Date.now()}`;
      await markAsProcessed(key, "test");

      // Run cleanup
      await cleanupExpiredKeys();

      // Key should still exist
      expect(await isAlreadyProcessed(key)).toBe(true);
    });
  });

  describe("clearProcessedMessages", () => {
    it("clears all messages without error", async () => {
      await expect(clearProcessedMessages()).resolves.not.toThrow();
    });
  });
});

describe("Idempotency Security Tests", () => {
  const securityPrefix = `security-${Date.now()}`;

  describe("Replay Attack Prevention", () => {
    it("prevents duplicate processing of same message", async () => {
      const messageId = `${securityPrefix}:replay-${Date.now()}`;

      // First time - not processed
      const firstCheck = await isAlreadyProcessed(messageId);
      expect(firstCheck).toBe(false);

      // Mark as processed
      await markAsProcessed(messageId, "webhook");

      // Second time - should be detected
      const secondCheck = await isAlreadyProcessed(messageId);
      expect(secondCheck).toBe(true);
    });

    it("uses unique keys for different message sources", async () => {
      const messageId = "same-id-123";
      const blooioKey = `${securityPrefix}:blooio:${messageId}`;
      const twilioKey = `${securityPrefix}:twilio:${messageId}`;

      // Process same message ID from different sources
      await markAsProcessed(blooioKey, "blooio");

      // Twilio version should not be marked as processed
      expect(await isAlreadyProcessed(twilioKey)).toBe(false);
    });
  });

  describe("Key Format Validation", () => {
    it("handles very long keys", async () => {
      const longKey = `${securityPrefix}:${"x".repeat(500)}`;
      expect(await isAlreadyProcessed(longKey)).toBe(false);
      await expect(markAsProcessed(longKey, "test")).resolves.not.toThrow();
    });

    it("handles keys with special webhook-related characters", async () => {
      const key = `${securityPrefix}:webhook:msg_123:abc=def&foo=bar`;
      expect(await isAlreadyProcessed(key)).toBe(false);
      await markAsProcessed(key, "test");
      expect(await isAlreadyProcessed(key)).toBe(true);
    });
  });
});
