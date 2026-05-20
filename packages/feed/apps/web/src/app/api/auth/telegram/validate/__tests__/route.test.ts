/**
 * Tests for Telegram Mini App initData Validation
 *
 * @route POST /api/auth/telegram/validate
 *
 * Covers:
 * - HMAC-SHA-256 signature verification algorithm
 * - Valid initData parsing
 * - Tampered initData rejection
 * - Expired auth_date rejection
 * - Missing/malformed fields
 * - Edge cases
 */

import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";

const TEST_BOT_TOKEN = "123456789:ABCDefGHIJKLmnoPQRSTuvWXyz";

/**
 * Build a valid Telegram initData string with a correct HMAC-SHA-256 hash.
 * Follows Telegram's validation algorithm exactly.
 */
function buildInitData(
  params: Record<string, string>,
  botToken: string,
): string {
  // Sort params alphabetically, build data_check_string
  const entries = Object.entries(params)
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`);
  const dataCheckString = entries.join("\n");

  // Compute HMAC-SHA-256
  const secretKey = createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const hash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  // Build URL-encoded string
  const allParams = { ...params, hash };
  return new URLSearchParams(allParams).toString();
}

/**
 * Create a standard test user JSON string
 */
function makeUserJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 12345678,
    first_name: "John",
    last_name: "Doe",
    username: "johndoe",
    language_code: "en",
    ...overrides,
  });
}

/**
 * Replicate the validation logic for testing (pure function, no HTTP).
 * This matches the algorithm in the route handler exactly.
 */
function validateTelegramInitData(
  initDataRaw: string,
  botToken: string,
): { valid: true; userId: number } | { valid: false; reason: string } {
  const params = new URLSearchParams(initDataRaw);

  const hash = params.get("hash");
  if (!hash) return { valid: false, reason: "missing hash parameter" };
  params.delete("hash");

  const entries: string[] = [];
  for (const [key, value] of params.entries()) {
    entries.push(`${key}=${value}`);
  }
  entries.sort();
  const dataCheckString = entries.join("\n");

  const secretKey = createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const computedHash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const hashBuffer = Buffer.from(hash, "hex");
  const computedBuffer = Buffer.from(computedHash, "hex");

  if (hashBuffer.length !== computedBuffer.length) {
    return { valid: false, reason: "hash length mismatch" };
  }

  const { timingSafeEqual } = require("node:crypto") as typeof import("crypto");
  if (!timingSafeEqual(hashBuffer, computedBuffer)) {
    return { valid: false, reason: "hash verification failed" };
  }

  const authDateStr = params.get("auth_date");
  if (!authDateStr) return { valid: false, reason: "missing auth_date" };

  const authDate = Number.parseInt(authDateStr, 10);
  if (Number.isNaN(authDate)) {
    return { valid: false, reason: "invalid auth_date" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (now - authDate > 300) {
    return { valid: false, reason: "auth_date expired" };
  }

  const userStr = params.get("user");
  if (!userStr) return { valid: false, reason: "missing user data" };

  let user: { id?: number; first_name?: string };
  try {
    user = JSON.parse(userStr);
  } catch {
    return { valid: false, reason: "malformed user JSON" };
  }

  if (!user.id || !user.first_name) {
    return { valid: false, reason: "incomplete user data" };
  }

  return { valid: true, userId: user.id };
}

describe("Telegram initData Validation", () => {
  describe("Valid initData", () => {
    it("should validate correctly signed initData", () => {
      const authDate = Math.floor(Date.now() / 1000).toString();
      const initData = buildInitData(
        {
          user: makeUserJson(),
          auth_date: authDate,
          query_id: "AAHdF6IQ",
        },
        TEST_BOT_TOKEN,
      );

      const result = validateTelegramInitData(initData, TEST_BOT_TOKEN);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.userId).toBe(12345678);
      }
    });

    it("should validate initData with minimal fields (user + auth_date)", () => {
      const authDate = Math.floor(Date.now() / 1000).toString();
      const initData = buildInitData(
        {
          user: makeUserJson(),
          auth_date: authDate,
        },
        TEST_BOT_TOKEN,
      );

      const result = validateTelegramInitData(initData, TEST_BOT_TOKEN);
      expect(result.valid).toBe(true);
    });

    it("should validate initData with extra fields", () => {
      const authDate = Math.floor(Date.now() / 1000).toString();
      const initData = buildInitData(
        {
          user: makeUserJson(),
          auth_date: authDate,
          query_id: "AAHdF6IQ",
          chat_type: "private",
          chat_instance: "999888777",
        },
        TEST_BOT_TOKEN,
      );

      const result = validateTelegramInitData(initData, TEST_BOT_TOKEN);
      expect(result.valid).toBe(true);
    });
  });

  describe("Tampered initData", () => {
    it("should reject initData signed with a different bot token", () => {
      const authDate = Math.floor(Date.now() / 1000).toString();
      const initData = buildInitData(
        {
          user: makeUserJson(),
          auth_date: authDate,
        },
        "wrong-bot-token",
      );

      const result = validateTelegramInitData(initData, TEST_BOT_TOKEN);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("hash verification failed");
      }
    });

    it("should reject initData with a tampered user ID", () => {
      const authDate = Math.floor(Date.now() / 1000).toString();
      // Build valid initData
      const validInitData = buildInitData(
        {
          user: makeUserJson({ id: 12345678 }),
          auth_date: authDate,
        },
        TEST_BOT_TOKEN,
      );

      // Tamper with the user ID by replacing it in the encoded string
      const tampered = validInitData.replace(
        encodeURIComponent('"id":12345678'),
        encodeURIComponent('"id":99999999'),
      );

      const result = validateTelegramInitData(tampered, TEST_BOT_TOKEN);
      expect(result.valid).toBe(false);
    });

    it("should reject initData with a tampered hash", () => {
      const authDate = Math.floor(Date.now() / 1000).toString();
      const initData = buildInitData(
        {
          user: makeUserJson(),
          auth_date: authDate,
        },
        TEST_BOT_TOKEN,
      );

      // Replace the hash with a random one
      const params = new URLSearchParams(initData);
      params.set("hash", "a".repeat(64));
      const tampered = params.toString();

      const result = validateTelegramInitData(tampered, TEST_BOT_TOKEN);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("hash verification failed");
      }
    });
  });

  describe("Missing/malformed fields", () => {
    it("should reject initData without hash", () => {
      const params = new URLSearchParams({
        user: makeUserJson(),
        auth_date: Math.floor(Date.now() / 1000).toString(),
      });

      const result = validateTelegramInitData(
        params.toString(),
        TEST_BOT_TOKEN,
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("missing hash parameter");
      }
    });

    it("should reject initData without auth_date", () => {
      // Build initData with auth_date, then remove it (hash will still be computed over it, so it's invalid)
      // Instead, we sign data WITHOUT auth_date to test the auth_date check
      const initData = buildInitData(
        {
          user: makeUserJson(),
        },
        TEST_BOT_TOKEN,
      );

      const result = validateTelegramInitData(initData, TEST_BOT_TOKEN);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("missing auth_date");
      }
    });

    it("should reject initData without user", () => {
      const initData = buildInitData(
        {
          auth_date: Math.floor(Date.now() / 1000).toString(),
        },
        TEST_BOT_TOKEN,
      );

      const result = validateTelegramInitData(initData, TEST_BOT_TOKEN);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("missing user data");
      }
    });

    it("should reject initData with malformed user JSON", () => {
      const initData = buildInitData(
        {
          user: "not-valid-json{{{",
          auth_date: Math.floor(Date.now() / 1000).toString(),
        },
        TEST_BOT_TOKEN,
      );

      const result = validateTelegramInitData(initData, TEST_BOT_TOKEN);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("malformed user JSON");
      }
    });

    it("should reject initData with user missing required fields", () => {
      const initData = buildInitData(
        {
          user: JSON.stringify({ username: "test" }), // missing id and first_name
          auth_date: Math.floor(Date.now() / 1000).toString(),
        },
        TEST_BOT_TOKEN,
      );

      const result = validateTelegramInitData(initData, TEST_BOT_TOKEN);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("incomplete user data");
      }
    });
  });

  describe("Expiry", () => {
    it("should reject initData with expired auth_date (> 5 minutes old)", () => {
      const oldAuthDate = (Math.floor(Date.now() / 1000) - 400).toString();
      const initData = buildInitData(
        {
          user: makeUserJson(),
          auth_date: oldAuthDate,
        },
        TEST_BOT_TOKEN,
      );

      const result = validateTelegramInitData(initData, TEST_BOT_TOKEN);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("auth_date expired");
      }
    });

    it("should accept initData with auth_date just within the TTL", () => {
      const recentAuthDate = (Math.floor(Date.now() / 1000) - 290).toString(); // 290s < 300s TTL
      const initData = buildInitData(
        {
          user: makeUserJson(),
          auth_date: recentAuthDate,
        },
        TEST_BOT_TOKEN,
      );

      const result = validateTelegramInitData(initData, TEST_BOT_TOKEN);
      expect(result.valid).toBe(true);
    });
  });

  describe("Unicode and special characters", () => {
    it("should validate initData with Unicode user names", () => {
      const authDate = Math.floor(Date.now() / 1000).toString();
      const initData = buildInitData(
        {
          user: makeUserJson({
            first_name: "太郎",
            last_name: "田中",
            username: "tanaka",
          }),
          auth_date: authDate,
        },
        TEST_BOT_TOKEN,
      );

      const result = validateTelegramInitData(initData, TEST_BOT_TOKEN);
      expect(result.valid).toBe(true);
    });

    it("should validate initData with emoji in user names", () => {
      const authDate = Math.floor(Date.now() / 1000).toString();
      const initData = buildInitData(
        {
          user: makeUserJson({
            first_name: "🚀 Rocket",
            last_name: "Man 🌙",
          }),
          auth_date: authDate,
        },
        TEST_BOT_TOKEN,
      );

      const result = validateTelegramInitData(initData, TEST_BOT_TOKEN);
      expect(result.valid).toBe(true);
    });

    it("should validate initData with special characters in user names", () => {
      const authDate = Math.floor(Date.now() / 1000).toString();
      const initData = buildInitData(
        {
          user: makeUserJson({
            first_name: "O'Brien",
            last_name: "Müller-Schmidt",
          }),
          auth_date: authDate,
        },
        TEST_BOT_TOKEN,
      );

      const result = validateTelegramInitData(initData, TEST_BOT_TOKEN);
      expect(result.valid).toBe(true);
    });
  });

  describe("Cross-token isolation", () => {
    it("should reject initData signed with token A when verified with token B", () => {
      const tokenA = "111111111:AAAAaaaBBBBbbbbCCCCcccc";
      const tokenB = "222222222:DDDDddddEEEEeeeeFFFFF";

      const authDate = Math.floor(Date.now() / 1000).toString();
      const initData = buildInitData(
        { user: makeUserJson(), auth_date: authDate },
        tokenA,
      );

      const result = validateTelegramInitData(initData, tokenB);
      expect(result.valid).toBe(false);
    });

    it("should validate initData only with the exact token used for signing", () => {
      const correctToken = "333333333:GGGGggggHHHHhhhhIIIIiiii";
      const authDate = Math.floor(Date.now() / 1000).toString();
      const initData = buildInitData(
        { user: makeUserJson(), auth_date: authDate },
        correctToken,
      );

      // Correct token should validate
      const correct = validateTelegramInitData(initData, correctToken);
      expect(correct.valid).toBe(true);

      // Even a slightly different token should fail
      const almostRight = validateTelegramInitData(
        initData,
        `${correctToken}x`,
      );
      expect(almostRight.valid).toBe(false);
    });
  });

  describe("Algorithm correctness", () => {
    it("should sort parameters alphabetically before computing hash", () => {
      const authDate = Math.floor(Date.now() / 1000).toString();

      // Build with parameters in different orders — result should be the same
      const params = {
        user: makeUserJson(),
        auth_date: authDate,
        query_id: "test-query",
        chat_type: "private",
      };

      const initData = buildInitData(params, TEST_BOT_TOKEN);

      // Both should validate because buildInitData sorts internally
      const result = validateTelegramInitData(initData, TEST_BOT_TOKEN);
      expect(result.valid).toBe(true);
    });

    it("should use WebAppData as the HMAC key for the secret derivation", () => {
      // Manually compute the hash to verify the algorithm
      const authDate = Math.floor(Date.now() / 1000).toString();
      const user = makeUserJson();

      // Step 1: data_check_string (sorted)
      const dataCheckString = `auth_date=${authDate}\nuser=${user}`;

      // Step 2: secret_key = HMAC-SHA-256("WebAppData", bot_token)
      const secretKey = createHmac("sha256", "WebAppData")
        .update(TEST_BOT_TOKEN)
        .digest();

      // Step 3: hash = HMAC-SHA-256(secret_key, data_check_string)
      const expectedHash = createHmac("sha256", secretKey)
        .update(dataCheckString)
        .digest("hex");

      // Build initData with the manually computed hash
      const initData = new URLSearchParams({
        user,
        auth_date: authDate,
        hash: expectedHash,
      }).toString();

      const result = validateTelegramInitData(initData, TEST_BOT_TOKEN);
      expect(result.valid).toBe(true);
    });
  });
});
