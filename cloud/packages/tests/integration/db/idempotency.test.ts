/**
 * Idempotency Utility Integration Tests
 *
 * Tests for the database-backed idempotency service.
 * These tests verify that replay protection works correctly.
 *
 * These tests require database connectivity.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
  cleanupExpiredKeys,
  clearProcessedMessages,
  getProcessedMessagesCount,
  isAlreadyProcessed,
  markAsProcessed,
  releaseProcessingClaim,
  tryClaimForProcessing,
} from "@/lib/utils/idempotency";

describe.skipIf(!process.env.DATABASE_URL || process.env.SKIP_DB_DEPENDENT === "1")(
  "Idempotency Utility",
  () => {
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
        await markAsProcessed(key, "twilio");
      });

      it("uses default source when not provided", async () => {
        const key = `${testPrefix}:default-source-${Date.now()}`;

        // Should not throw
        await markAsProcessed(key);
      });

      it("handles duplicate marking gracefully", async () => {
        const key = `${testPrefix}:duplicate-${Date.now()}`;

        // Mark twice - should not throw
        await markAsProcessed(key, "test");
        await markAsProcessed(key, "test");

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
        await clearProcessedMessages();
      });
    });
  },
);

describe.skipIf(!process.env.DATABASE_URL || process.env.SKIP_DB_DEPENDENT === "1")(
  "tryClaimForProcessing",
  () => {
    const claimPrefix = `claim-${Date.now()}`;

    afterAll(async () => {
      try {
        await clearProcessedMessages();
      } catch {
        // Ignore cleanup errors in tests
      }
    });

    it("returns true for first claim", async () => {
      const key = `${claimPrefix}:first-${Date.now()}`;
      expect(await tryClaimForProcessing(key, "test")).toBe(true);
    });

    it("returns false for duplicate claim", async () => {
      const key = `${claimPrefix}:duplicate-${Date.now()}`;
      await tryClaimForProcessing(key, "test");
      expect(await tryClaimForProcessing(key, "test")).toBe(false);
    });

    it("handles concurrent claims correctly - only one wins", async () => {
      const key = `${claimPrefix}:concurrent-${Date.now()}`;
      const results = await Promise.all([
        tryClaimForProcessing(key, "test"),
        tryClaimForProcessing(key, "test"),
        tryClaimForProcessing(key, "test"),
      ]);
      const successCount = results.filter((r) => r === true).length;
      expect(successCount).toBe(1);
    });

    it("claimed key is visible to isAlreadyProcessed", async () => {
      const key = `${claimPrefix}:visible-${Date.now()}`;
      await tryClaimForProcessing(key, "test");
      expect(await isAlreadyProcessed(key)).toBe(true);
    });

    it("uses default source when not provided", async () => {
      const key = `${claimPrefix}:default-source-${Date.now()}`;
      const result = await tryClaimForProcessing(key);
      expect(typeof result).toBe("boolean");
    });
  },
);

describe.skipIf(!process.env.DATABASE_URL || process.env.SKIP_DB_DEPENDENT === "1")(
  "releaseProcessingClaim",
  () => {
    const releasePrefix = `release-${Date.now()}`;

    afterAll(async () => {
      try {
        await clearProcessedMessages();
      } catch {
        // Ignore cleanup errors in tests
      }
    });

    it("allows re-claim after release", async () => {
      const key = `${releasePrefix}:reclaim-${Date.now()}`;

      // First claim succeeds
      expect(await tryClaimForProcessing(key, "test")).toBe(true);

      // Second claim fails (already claimed)
      expect(await tryClaimForProcessing(key, "test")).toBe(false);

      // Release the claim
      await releaseProcessingClaim(key);

      // Now re-claim should succeed
      expect(await tryClaimForProcessing(key, "test")).toBe(true);
    });

    it("released key is no longer visible to isAlreadyProcessed", async () => {
      const key = `${releasePrefix}:invisible-${Date.now()}`;

      await tryClaimForProcessing(key, "test");
      expect(await isAlreadyProcessed(key)).toBe(true);

      await releaseProcessingClaim(key);
      expect(await isAlreadyProcessed(key)).toBe(false);
    });

    it("does not throw when releasing a non-existent key", async () => {
      const key = `${releasePrefix}:nonexistent-${Date.now()}`;
      await releaseProcessingClaim(key);
    });
  },
);

describe.skipIf(!process.env.DATABASE_URL || process.env.SKIP_DB_DEPENDENT === "1")(
  "Idempotency Security Tests",
  () => {
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
        await markAsProcessed(longKey, "test");
      });

      it("handles keys with special webhook-related characters", async () => {
        const key = `${securityPrefix}:webhook:msg_123:abc=def&foo=bar`;
        expect(await isAlreadyProcessed(key)).toBe(false);
        await markAsProcessed(key, "test");
        expect(await isAlreadyProcessed(key)).toBe(true);
      });
    });
  },
);
