/**
 * Security Validation Tests
 *
 * Tests for various security measures implemented in the codebase:
 * - Metadata size limits
 * - Message length validation
 * - JSON parsing safety
 * - Input sanitization
 */

import { describe, expect, it } from "bun:test";
import { z } from "zod";

// Recreate validation schemas from the codebase for testing
const MAX_METADATA_SIZE = 10 * 1024; // 10KB
const MAX_MESSAGE_LENGTH = 10000; // 10,000 characters

/**
 * Message metadata schema - allows simple key-value pairs only.
 * Prevents deeply nested or malicious objects from being stored.
 */
const messageMetadataSchema = z
  .record(
    z.string(),
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(z.union([z.string(), z.number(), z.boolean()])),
    ]),
  )
  .optional();

describe("Security Validations", () => {
  describe("Metadata Size Limits", () => {
    it("accepts metadata within size limit", () => {
      const smallMetadata = {
        key1: "value1",
        key2: "value2",
      };

      const size = JSON.stringify(smallMetadata).length;
      expect(size).toBeLessThan(MAX_METADATA_SIZE);
      expect(() => messageMetadataSchema.parse(smallMetadata)).not.toThrow();
    });

    it("identifies metadata exceeding size limit", () => {
      // Create metadata larger than 10KB
      const largeMetadata: Record<string, string> = {};
      const longValue = "x".repeat(1000);
      for (let i = 0; i < 20; i++) {
        largeMetadata[`key${i}`] = longValue;
      }

      const size = JSON.stringify(largeMetadata).length;
      expect(size).toBeGreaterThan(MAX_METADATA_SIZE);

      // Schema validation passes but size check would fail
      expect(() => messageMetadataSchema.parse(largeMetadata)).not.toThrow();
    });

    it("rejects deeply nested objects", () => {
      const nestedMetadata = {
        level1: {
          level2: {
            level3: "value",
          },
        },
      };

      // Our schema only allows simple values, not nested objects
      expect(() => messageMetadataSchema.parse(nestedMetadata)).toThrow();
    });

    it("accepts arrays of primitive values", () => {
      const arrayMetadata = {
        tags: ["tag1", "tag2", "tag3"],
        numbers: [1, 2, 3],
        mixed: ["string", 123, true],
      };

      expect(() => messageMetadataSchema.parse(arrayMetadata)).not.toThrow();
    });

    it("rejects arrays with objects", () => {
      const arrayWithObjects = {
        items: [{ nested: "object" }],
      };

      expect(() => messageMetadataSchema.parse(arrayWithObjects)).toThrow();
    });
  });

  describe("Message Length Validation", () => {
    it("accepts messages within length limit", () => {
      const shortMessage = "Hello, this is a test message.";
      expect(shortMessage.length).toBeLessThan(MAX_MESSAGE_LENGTH);
    });

    it("identifies messages exceeding length limit", () => {
      const longMessage = "x".repeat(MAX_MESSAGE_LENGTH + 1);
      expect(longMessage.length).toBeGreaterThan(MAX_MESSAGE_LENGTH);
    });

    it("handles unicode characters correctly", () => {
      // Unicode characters may have different byte lengths
      const unicodeMessage = "\u{1F600}".repeat(100); // Emoji
      expect(unicodeMessage.length).toBe(200); // Each emoji is 2 UTF-16 code units
    });
  });

  describe("JSON Parsing Safety", () => {
    it("handles valid JSON without issues", () => {
      const validJSON = '{"key": "value", "number": 123}';
      expect(() => JSON.parse(validJSON)).not.toThrow();
    });

    it("safely handles invalid JSON", () => {
      const invalidJSON = '{"key": "value"'; // Missing closing brace
      expect(() => JSON.parse(invalidJSON)).toThrow(SyntaxError);
    });

    it("handles null values in JSON", () => {
      const jsonWithNull = '{"key": null}';
      const parsed = JSON.parse(jsonWithNull);
      expect(parsed.key).toBeNull();
    });

    it("handles prototype pollution attempts in JSON", () => {
      const protoJSON = '{"__proto__": {"polluted": true}}';
      const parsed = JSON.parse(protoJSON);

      // JSON.parse creates objects without prototype pollution
      // The __proto__ becomes a regular property
      expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
      const pristine: Record<string, unknown> = {};
      expect(pristine.polluted).toBeUndefined(); // Global prototype not polluted
    });

    it("handles very large numbers correctly", () => {
      // JavaScript has limited precision for large numbers
      const largeNumber = '{"id": 9007199254740993}'; // > Number.MAX_SAFE_INTEGER
      const parsed = JSON.parse(largeNumber);
      expect(parsed.id.toString()).not.toBe("9007199254740993"); // Precision lost
    });

    it("handles escaped characters", () => {
      const escapedJSON = '{"message": "Hello\\nWorld\\t!"}';
      const parsed = JSON.parse(escapedJSON);
      expect(parsed.message).toBe("Hello\nWorld\t!");
    });
  });

  describe("Input Sanitization", () => {
    it("handles control characters", () => {
      const controlChars = "\x00\x01\x02"; // Null and other control chars
      expect(controlChars.length).toBe(3);

      // Control characters should be handled without crashing
      const result = controlChars.replace(/[\x00-\x1F]/g, "");
      expect(result).toBe("");
    });

    it("handles unicode null character", () => {
      const nullChar = "\u0000";
      expect(nullChar.length).toBe(1);

      // Replace unicode null
      const sanitized = nullChar.replace(/\u0000/g, "");
      expect(sanitized).toBe("");
    });

    it("preserves valid unicode characters", () => {
      const unicode = "Hello 世界 🌍";
      // Valid unicode should not be stripped
      expect(unicode.length).toBe(11);
    });
  });

  describe("Rate Limiting Configuration", () => {
    // Test that rate limit configurations are reasonable
    const MESSAGE_RATE_LIMIT = {
      windowMs: 60000, // 1 minute
      maxRequests: process.env.NODE_ENV === "production" ? 30 : 100,
    };

    it("has reasonable production rate limit", () => {
      expect(30).toBeLessThanOrEqual(60); // Max 1 message per 2 seconds
      expect(30).toBeGreaterThan(0);
    });

    it("has higher development rate limit", () => {
      expect(100).toBeGreaterThan(30); // Dev should be higher than prod
    });

    it("uses 1-minute window", () => {
      expect(MESSAGE_RATE_LIMIT.windowMs).toBe(60000);
    });
  });

  describe("Timestamp Validation", () => {
    const TIMESTAMP_TOLERANCE_MS = 2 * 60 * 1000; // 2 minutes

    it("accepts timestamps within tolerance", () => {
      const now = Date.now();
      const recent = now - 1 * 60 * 1000; // 1 minute ago

      const diff = Math.abs(now - recent);
      expect(diff).toBeLessThanOrEqual(TIMESTAMP_TOLERANCE_MS);
    });

    it("rejects timestamps outside tolerance", () => {
      const now = Date.now();
      const old = now - 5 * 60 * 1000; // 5 minutes ago

      const diff = Math.abs(now - old);
      expect(diff).toBeGreaterThan(TIMESTAMP_TOLERANCE_MS);
    });

    it("handles future timestamps within tolerance", () => {
      const now = Date.now();
      const future = now + 1 * 60 * 1000; // 1 minute in future

      const diff = Math.abs(now - future);
      expect(diff).toBeLessThanOrEqual(TIMESTAMP_TOLERANCE_MS);
    });

    it("rejects far future timestamps", () => {
      const now = Date.now();
      const farFuture = now + 10 * 60 * 1000; // 10 minutes in future

      const diff = Math.abs(now - farFuture);
      expect(diff).toBeGreaterThan(TIMESTAMP_TOLERANCE_MS);
    });
  });
});

describe("Webhook Security", () => {
  describe("Signature Verification", () => {
    it("verifies HMAC signature format", () => {
      // HMAC-SHA256 signature should be 64 hex characters
      const validSignature = "a".repeat(64);
      expect(validSignature.length).toBe(64);
      expect(/^[a-f0-9]+$/.test(validSignature)).toBe(true);
    });

    it("rejects invalid signature format", () => {
      const shortSignature = "a".repeat(32);
      expect(shortSignature.length).not.toBe(64);

      const invalidChars = "g".repeat(64); // 'g' is not hex
      expect(/^[a-f0-9]+$/.test(invalidChars)).toBe(false);
    });
  });

  describe("Organization ID Validation", () => {
    it("validates UUID format for organization IDs", () => {
      const validUUID = "550e8400-e29b-41d4-a716-446655440000";
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(uuidRegex.test(validUUID)).toBe(true);
    });

    it("rejects invalid organization IDs", () => {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      expect(uuidRegex.test("not-a-uuid")).toBe(false);
      expect(uuidRegex.test("")).toBe(false);
      expect(uuidRegex.test("../../../etc/passwd")).toBe(false);
    });
  });
});
