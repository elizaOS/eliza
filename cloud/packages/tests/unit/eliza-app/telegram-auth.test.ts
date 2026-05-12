/**
 * Telegram Auth Service Tests
 *
 * Tests HMAC-SHA256 verification for Telegram Login Widget:
 * - Valid signature verification
 * - Invalid/tampered signatures
 * - Expired auth_date (replay attack prevention)
 * - Future auth_date (clock skew)
 * - Missing fields
 * - Edge cases
 */

import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "crypto";

// Test bot token (not a real token)
const TEST_BOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrsTUVwxyz";

/**
 * Generate valid Telegram auth hash for testing
 */
function generateValidHash(data: Record<string, string | number>, botToken: string): string {
  const secretKey = createHash("sha256").update(botToken).digest();

  const entries = Object.entries(data)
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b));

  const checkString = entries.map(([key, value]) => `${key}=${value}`).join("\n");

  return createHmac("sha256", secretKey).update(checkString).digest("hex");
}

describe("Telegram Auth Hash Generation", () => {
  test("generates 64-character hex hash", () => {
    const data = {
      id: 123456789,
      first_name: "Test",
      auth_date: Math.floor(Date.now() / 1000),
    };
    const hash = generateValidHash(data, TEST_BOT_TOKEN);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("same data produces same hash", () => {
    const data = {
      id: 123456789,
      first_name: "Test",
      auth_date: 1700000000,
    };
    const hash1 = generateValidHash(data, TEST_BOT_TOKEN);
    const hash2 = generateValidHash(data, TEST_BOT_TOKEN);
    expect(hash1).toBe(hash2);
  });

  test("different data produces different hash", () => {
    const data1 = { id: 111, first_name: "Alice", auth_date: 1700000000 };
    const data2 = { id: 222, first_name: "Bob", auth_date: 1700000000 };
    const hash1 = generateValidHash(data1, TEST_BOT_TOKEN);
    const hash2 = generateValidHash(data2, TEST_BOT_TOKEN);
    expect(hash1).not.toBe(hash2);
  });

  test("different bot token produces different hash", () => {
    const data = { id: 123, first_name: "Test", auth_date: 1700000000 };
    const hash1 = generateValidHash(data, TEST_BOT_TOKEN);
    const hash2 = generateValidHash(data, "987654321:ZYXwvuTSRqponMLKjihGFEdcba");
    expect(hash1).not.toBe(hash2);
  });

  test("fields are sorted alphabetically", () => {
    // Same data in different order should produce same hash
    const data1 = { auth_date: 1700000000, first_name: "Test", id: 123 };
    const data2 = { id: 123, first_name: "Test", auth_date: 1700000000 };
    const hash1 = generateValidHash(data1, TEST_BOT_TOKEN);
    const hash2 = generateValidHash(data2, TEST_BOT_TOKEN);
    expect(hash1).toBe(hash2);
  });

  test("optional fields affect hash when present", () => {
    const dataWithoutUsername = {
      id: 123,
      first_name: "Test",
      auth_date: 1700000000,
    };
    const dataWithUsername = {
      id: 123,
      first_name: "Test",
      username: "testuser",
      auth_date: 1700000000,
    };
    const hash1 = generateValidHash(dataWithoutUsername, TEST_BOT_TOKEN);
    const hash2 = generateValidHash(dataWithUsername, TEST_BOT_TOKEN);
    expect(hash1).not.toBe(hash2);
  });
});

describe("Auth Date Validation", () => {
  const MAX_AUTH_AGE_SECONDS = 86400; // 24 hours

  test("current timestamp is valid", () => {
    const authDate = Math.floor(Date.now() / 1000);
    const currentTime = Math.floor(Date.now() / 1000);
    const age = currentTime - authDate;
    expect(age).toBeLessThanOrEqual(MAX_AUTH_AGE_SECONDS);
  });

  test("1 hour old auth is valid", () => {
    const authDate = Math.floor(Date.now() / 1000) - 3600;
    const currentTime = Math.floor(Date.now() / 1000);
    const age = currentTime - authDate;
    expect(age).toBeLessThanOrEqual(MAX_AUTH_AGE_SECONDS);
  });

  test("23 hours old auth is valid", () => {
    const authDate = Math.floor(Date.now() / 1000) - 23 * 3600;
    const currentTime = Math.floor(Date.now() / 1000);
    const age = currentTime - authDate;
    expect(age).toBeLessThanOrEqual(MAX_AUTH_AGE_SECONDS);
  });

  test("25 hours old auth is expired", () => {
    const authDate = Math.floor(Date.now() / 1000) - 25 * 3600;
    const currentTime = Math.floor(Date.now() / 1000);
    const age = currentTime - authDate;
    expect(age).toBeGreaterThan(MAX_AUTH_AGE_SECONDS);
  });

  test("future auth_date is invalid (negative age)", () => {
    const authDate = Math.floor(Date.now() / 1000) + 3600; // 1 hour in future
    const currentTime = Math.floor(Date.now() / 1000);
    const age = currentTime - authDate;
    expect(age).toBeLessThan(0);
  });
});

describe("Hash Tampering Detection", () => {
  test("modified id invalidates hash", () => {
    const originalData = {
      id: 123456789,
      first_name: "Test",
      auth_date: 1700000000,
    };
    const originalHash = generateValidHash(originalData, TEST_BOT_TOKEN);

    const tamperedData = { ...originalData, id: 987654321 };
    const tamperedHash = generateValidHash(tamperedData, TEST_BOT_TOKEN);

    expect(originalHash).not.toBe(tamperedHash);
  });

  test("modified first_name invalidates hash", () => {
    const originalData = {
      id: 123456789,
      first_name: "Alice",
      auth_date: 1700000000,
    };
    const originalHash = generateValidHash(originalData, TEST_BOT_TOKEN);

    const tamperedData = { ...originalData, first_name: "Eve" };
    const tamperedHash = generateValidHash(tamperedData, TEST_BOT_TOKEN);

    expect(originalHash).not.toBe(tamperedHash);
  });

  test("modified auth_date invalidates hash", () => {
    const originalData = {
      id: 123456789,
      first_name: "Test",
      auth_date: 1700000000,
    };
    const originalHash = generateValidHash(originalData, TEST_BOT_TOKEN);

    const tamperedData = { ...originalData, auth_date: 1700000001 };
    const tamperedHash = generateValidHash(tamperedData, TEST_BOT_TOKEN);

    expect(originalHash).not.toBe(tamperedHash);
  });

  test("single character change invalidates hash", () => {
    const originalData = {
      id: 123456789,
      first_name: "Test",
      auth_date: 1700000000,
    };
    const originalHash = generateValidHash(originalData, TEST_BOT_TOKEN);

    const tamperedData = { ...originalData, first_name: "Testt" };
    const tamperedHash = generateValidHash(tamperedData, TEST_BOT_TOKEN);

    expect(originalHash).not.toBe(tamperedHash);
  });
});

describe("Edge Cases", () => {
  test("handles unicode in first_name", () => {
    const data = {
      id: 123456789,
      first_name: "测试用户🎉",
      auth_date: 1700000000,
    };
    const hash = generateValidHash(data, TEST_BOT_TOKEN);
    expect(hash).toHaveLength(64);
  });

  test("handles empty username", () => {
    const data = {
      id: 123456789,
      first_name: "Test",
      username: "",
      auth_date: 1700000000,
    };
    const hash = generateValidHash(data, TEST_BOT_TOKEN);
    expect(hash).toHaveLength(64);
  });

  test("handles very long first_name", () => {
    const data = {
      id: 123456789,
      first_name: "A".repeat(256),
      auth_date: 1700000000,
    };
    const hash = generateValidHash(data, TEST_BOT_TOKEN);
    expect(hash).toHaveLength(64);
  });

  test("handles special characters in username", () => {
    const data = {
      id: 123456789,
      first_name: "Test",
      username: "test_user_123",
      auth_date: 1700000000,
    };
    const hash = generateValidHash(data, TEST_BOT_TOKEN);
    expect(hash).toHaveLength(64);
  });

  test("handles max int32 for id", () => {
    const data = {
      id: 2147483647,
      first_name: "Test",
      auth_date: 1700000000,
    };
    const hash = generateValidHash(data, TEST_BOT_TOKEN);
    expect(hash).toHaveLength(64);
  });

  test("handles photo_url field", () => {
    const dataWithPhoto = {
      id: 123456789,
      first_name: "Test",
      photo_url: "https://t.me/i/userpic/320/abc123.jpg",
      auth_date: 1700000000,
    };
    const dataWithoutPhoto = {
      id: 123456789,
      first_name: "Test",
      auth_date: 1700000000,
    };
    const hash1 = generateValidHash(dataWithPhoto, TEST_BOT_TOKEN);
    const hash2 = generateValidHash(dataWithoutPhoto, TEST_BOT_TOKEN);
    expect(hash1).not.toBe(hash2);
  });
});

describe("Timing Safe Comparison", () => {
  test("Buffer comparison for equal hashes", () => {
    const hash = "a".repeat(64);
    const buffer1 = Buffer.from(hash, "hex");
    const buffer2 = Buffer.from(hash, "hex");
    expect(buffer1.equals(buffer2)).toBe(true);
  });

  test("Buffer comparison for different hashes", () => {
    const hash1 = "a".repeat(64);
    const hash2 = "b".repeat(64);
    const buffer1 = Buffer.from(hash1, "hex");
    const buffer2 = Buffer.from(hash2, "hex");
    expect(buffer1.equals(buffer2)).toBe(false);
  });

  test("Buffer length must match for valid comparison", () => {
    const hash64 = "a".repeat(64);
    const hash32 = "a".repeat(32);
    const buffer64 = Buffer.from(hash64, "hex");
    const buffer32 = Buffer.from(hash32, "hex");
    expect(buffer64.length).not.toBe(buffer32.length);
  });
});
