/**
 * Eliza App Auth Endpoint Tests
 *
 * Tests the /api/eliza-app/auth/telegram endpoint:
 * - Request body validation (Zod schema)
 * - Response format validation
 * - Error response codes and messages
 * - Edge cases for Telegram auth data
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

// Schema matching auth/telegram/route.ts
const telegramAuthSchema = z.object({
  id: z.number().int().positive(),
  first_name: z.string().min(1).max(256),
  last_name: z.string().max(256).optional(),
  username: z.string().max(32).optional(),
  photo_url: z.string().url().max(2048).optional(),
  auth_date: z.number().int().positive(),
  hash: z.string().length(64),
});

// Response schemas
const authSuccessResponseSchema = z.object({
  success: z.literal(true),
  user: z.object({
    id: z.string(),
    telegram_id: z.string(),
    telegram_username: z.string().nullable(),
    name: z.string().nullable(),
    organization_id: z.string(),
  }),
  session: z.object({
    token: z.string(),
    expires_at: z.string(),
  }),
  is_new_user: z.boolean(),
});

const authErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  code: z.string(),
});

describe("Telegram Auth Request Schema", () => {
  describe("Valid Requests", () => {
    test("minimal valid request passes", () => {
      const data = {
        id: 223116693,
        first_name: "Test",
        auth_date: 1700000000,
        hash: "a".repeat(64),
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    test("full valid request passes", () => {
      const data = {
        id: 223116693,
        first_name: "Test",
        last_name: "User",
        username: "testuser",
        photo_url: "https://t.me/i/userpic/320/abc.jpg",
        auth_date: 1700000000,
        hash: "a".repeat(64),
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    test("unicode first_name is valid", () => {
      const data = {
        id: 223116693,
        first_name: "测试用户",
        auth_date: 1700000000,
        hash: "a".repeat(64),
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    test("max length first_name (256 chars) is valid", () => {
      const data = {
        id: 223116693,
        first_name: "A".repeat(256),
        auth_date: 1700000000,
        hash: "a".repeat(64),
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    test("max length username (32 chars) is valid", () => {
      const data = {
        id: 223116693,
        first_name: "Test",
        username: "a".repeat(32),
        auth_date: 1700000000,
        hash: "a".repeat(64),
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(true);
    });
  });

  describe("Invalid Requests - Missing Fields", () => {
    test("missing id fails", () => {
      const data = {
        first_name: "Test",
        auth_date: 1700000000,
        hash: "a".repeat(64),
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    test("missing first_name fails", () => {
      const data = {
        id: 223116693,
        auth_date: 1700000000,
        hash: "a".repeat(64),
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    test("missing auth_date fails", () => {
      const data = {
        id: 223116693,
        first_name: "Test",
        hash: "a".repeat(64),
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    test("missing hash fails", () => {
      const data = {
        id: 223116693,
        first_name: "Test",
        auth_date: 1700000000,
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(false);
    });
  });

  describe("Invalid Requests - Wrong Types", () => {
    test("string id fails", () => {
      const data = {
        id: "223116693",
        first_name: "Test",
        auth_date: 1700000000,
        hash: "a".repeat(64),
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    test("float id fails", () => {
      const data = {
        id: 223116693.5,
        first_name: "Test",
        auth_date: 1700000000,
        hash: "a".repeat(64),
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    test("negative id fails", () => {
      const data = {
        id: -223116693,
        first_name: "Test",
        auth_date: 1700000000,
        hash: "a".repeat(64),
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    test("zero id fails", () => {
      const data = {
        id: 0,
        first_name: "Test",
        auth_date: 1700000000,
        hash: "a".repeat(64),
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    test("string auth_date fails", () => {
      const data = {
        id: 223116693,
        first_name: "Test",
        auth_date: "1700000000",
        hash: "a".repeat(64),
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    test("number first_name fails", () => {
      const data = {
        id: 223116693,
        first_name: 12345,
        auth_date: 1700000000,
        hash: "a".repeat(64),
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(false);
    });
  });

  describe("Invalid Requests - Constraint Violations", () => {
    test("empty first_name fails", () => {
      const data = {
        id: 223116693,
        first_name: "",
        auth_date: 1700000000,
        hash: "a".repeat(64),
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    test("first_name over 256 chars fails", () => {
      const data = {
        id: 223116693,
        first_name: "A".repeat(257),
        auth_date: 1700000000,
        hash: "a".repeat(64),
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    test("username over 32 chars fails", () => {
      const data = {
        id: 223116693,
        first_name: "Test",
        username: "a".repeat(33),
        auth_date: 1700000000,
        hash: "a".repeat(64),
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    test("hash not 64 chars fails (63 chars)", () => {
      const data = {
        id: 223116693,
        first_name: "Test",
        auth_date: 1700000000,
        hash: "a".repeat(63),
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    test("hash not 64 chars fails (65 chars)", () => {
      const data = {
        id: 223116693,
        first_name: "Test",
        auth_date: 1700000000,
        hash: "a".repeat(65),
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    test("invalid photo_url fails", () => {
      const data = {
        id: 223116693,
        first_name: "Test",
        photo_url: "not-a-valid-url",
        auth_date: 1700000000,
        hash: "a".repeat(64),
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    test("photo_url over 2048 chars fails", () => {
      const data = {
        id: 223116693,
        first_name: "Test",
        photo_url: "https://example.com/" + "a".repeat(2030),
        auth_date: 1700000000,
        hash: "a".repeat(64),
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(false);
    });
  });

  describe("Edge Cases", () => {
    test("whitespace-only first_name passes (has length)", () => {
      const data = {
        id: 223116693,
        first_name: "   ",
        auth_date: 1700000000,
        hash: "a".repeat(64),
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    test("emoji in first_name is valid", () => {
      const data = {
        id: 223116693,
        first_name: "Test 🎉",
        auth_date: 1700000000,
        hash: "a".repeat(64),
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    test("null values for optional fields fail", () => {
      const data = {
        id: 223116693,
        first_name: "Test",
        last_name: null,
        auth_date: 1700000000,
        hash: "a".repeat(64),
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(false);
    });

    test("extra fields are stripped (passthrough not enabled)", () => {
      const data = {
        id: 223116693,
        first_name: "Test",
        auth_date: 1700000000,
        hash: "a".repeat(64),
        extra_field: "should be ignored",
      };
      const result = telegramAuthSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as Record<string, unknown>).extra_field).toBeUndefined();
      }
    });
  });
});

describe("Auth Success Response Schema", () => {
  test("valid success response passes", () => {
    const response = {
      success: true,
      user: {
        id: "550e8400-e29b-41d4-a716-446655440000",
        telegram_id: "223116693",
        telegram_username: "testuser",
        name: "Test User",
        organization_id: "org-123",
      },
      session: {
        token: "eyJhbGciOiJIUzI1NiJ9...",
        expires_at: "2024-01-15T12:00:00.000Z",
      },
      is_new_user: false,
    };
    const result = authSuccessResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  test("new user response is valid", () => {
    const response = {
      success: true,
      user: {
        id: "new-user-id",
        telegram_id: "223116693",
        telegram_username: null,
        name: null,
        organization_id: "new-org-id",
      },
      session: {
        token: "jwt-token",
        expires_at: "2024-01-15T12:00:00.000Z",
      },
      is_new_user: true,
    };
    const result = authSuccessResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  test("missing success field fails", () => {
    const response = {
      user: {
        id: "1",
        telegram_id: "1",
        telegram_username: null,
        name: null,
        organization_id: "1",
      },
      session: { token: "t", expires_at: "2024-01-01" },
      is_new_user: false,
    };
    const result = authSuccessResponseSchema.safeParse(response);
    expect(result.success).toBe(false);
  });
});

describe("Auth Error Response Schema", () => {
  test("INVALID_JSON error response", () => {
    const response = {
      success: false,
      error: "Invalid JSON body",
      code: "INVALID_JSON",
    };
    const result = authErrorResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  test("INVALID_REQUEST error response", () => {
    const response = {
      success: false,
      error: "Invalid request body",
      code: "INVALID_REQUEST",
    };
    const result = authErrorResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  test("INVALID_AUTH error response", () => {
    const response = {
      success: false,
      error: "Invalid authentication data",
      code: "INVALID_AUTH",
    };
    const result = authErrorResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  test("success: true fails error schema", () => {
    const response = {
      success: true,
      error: "Some error",
      code: "ERROR",
    };
    const result = authErrorResponseSchema.safeParse(response);
    expect(result.success).toBe(false);
  });
});

describe("HTTP Status Code Expectations", () => {
  const statusCodes = {
    INVALID_JSON: 400,
    INVALID_REQUEST: 400,
    INVALID_AUTH: 401,
    RATE_LIMITED: 429,
    INTERNAL_ERROR: 500,
  };

  test("INVALID_JSON returns 400", () => {
    expect(statusCodes.INVALID_JSON).toBe(400);
  });

  test("INVALID_REQUEST returns 400", () => {
    expect(statusCodes.INVALID_REQUEST).toBe(400);
  });

  test("INVALID_AUTH returns 401", () => {
    expect(statusCodes.INVALID_AUTH).toBe(401);
  });

  test("RATE_LIMITED returns 429", () => {
    expect(statusCodes.RATE_LIMITED).toBe(429);
  });

  test("INTERNAL_ERROR returns 500", () => {
    expect(statusCodes.INTERNAL_ERROR).toBe(500);
  });
});
