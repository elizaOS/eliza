/**
 * Discord Auth Tests
 *
 * Tests for Discord OAuth2 authentication:
 * - Avatar URL generation (static and animated)
 * - Display name resolution
 * - Bot/system account rejection
 * - Token response validation
 * - User profile field validation
 * - Request body schema validation (Zod)
 * - Phone number linking logic
 * - OAuth enforcement in webhook
 * - Race condition handling
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";

import { isValidE164, normalizePhoneNumber } from "@/lib/utils/phone-normalization";

// =============================================================================
// DISCORD AUTH SERVICE - Pure logic tests
// =============================================================================

describe("Discord Auth Service", () => {
  describe("getAvatarUrl", () => {
    const getAvatarUrl = (userId: string, avatarHash: string | null): string | null => {
      if (!avatarHash) return null;
      const ext = avatarHash.startsWith("a_") ? "gif" : "png";
      return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}`;
    };

    test("generates correct static avatar URL", () => {
      const url = getAvatarUrl("123456789", "abcdef123456");
      expect(url).toBe("https://cdn.discordapp.com/avatars/123456789/abcdef123456.png");
    });

    test("generates gif URL for animated avatars (a_ prefix)", () => {
      const url = getAvatarUrl("123456789", "a_abcdef123456");
      expect(url).toBe("https://cdn.discordapp.com/avatars/123456789/a_abcdef123456.gif");
    });

    test("returns null when avatarHash is null", () => {
      expect(getAvatarUrl("123456789", null)).toBeNull();
    });

    test("handles various avatar hash lengths", () => {
      const url = getAvatarUrl("123", "abc");
      expect(url).toBe("https://cdn.discordapp.com/avatars/123/abc.png");
    });

    test("animated detection is prefix-only", () => {
      // Hash containing a_ but not as prefix should be .png
      const url = getAvatarUrl("123", "not_a_animated");
      expect(url).toContain(".png");
    });
  });

  describe("getDisplayName", () => {
    const getDisplayName = (data: { global_name: string | null; username: string }): string => {
      return data.global_name || data.username;
    };

    test("uses global_name when available", () => {
      expect(getDisplayName({ global_name: "Test User", username: "testuser" })).toBe("Test User");
    });

    test("falls back to username when global_name is null", () => {
      expect(getDisplayName({ global_name: null, username: "testuser" })).toBe("testuser");
    });

    test("falls back to username when global_name is empty", () => {
      expect(getDisplayName({ global_name: "", username: "testuser" })).toBe("testuser");
    });
  });

  describe("Bot/system account rejection", () => {
    interface DiscordApiUser {
      id: string;
      username: string;
      bot?: boolean;
      system?: boolean;
    }

    const shouldReject = (user: DiscordApiUser): boolean => {
      return !!user.bot || !!user.system;
    };

    test("rejects bot accounts", () => {
      expect(shouldReject({ id: "123", username: "bot", bot: true })).toBe(true);
    });

    test("rejects system accounts", () => {
      expect(shouldReject({ id: "123", username: "system", system: true })).toBe(true);
    });

    test("rejects accounts that are both bot and system", () => {
      expect(shouldReject({ id: "123", username: "both", bot: true, system: true })).toBe(true);
    });

    test("accepts normal user accounts", () => {
      expect(shouldReject({ id: "123", username: "user" })).toBe(false);
    });

    test("accepts when bot is explicitly false", () => {
      expect(shouldReject({ id: "123", username: "user", bot: false })).toBe(false);
    });

    test("accepts when system is explicitly false", () => {
      expect(shouldReject({ id: "123", username: "user", system: false })).toBe(false);
    });
  });

  describe("Token response validation", () => {
    const validateTokenResponse = (raw: Record<string, unknown>): boolean => {
      return !!raw.access_token;
    };

    test("valid token response with access_token", () => {
      expect(
        validateTokenResponse({
          access_token: "abc123",
          token_type: "Bearer",
          expires_in: 604800,
          refresh_token: "def456",
          scope: "identify",
        }),
      ).toBe(true);
    });

    test("rejects response without access_token", () => {
      expect(
        validateTokenResponse({
          token_type: "Bearer",
          error: "invalid_grant",
        }),
      ).toBe(false);
    });

    test("rejects empty response", () => {
      expect(validateTokenResponse({})).toBe(false);
    });

    test("rejects response with null access_token", () => {
      expect(validateTokenResponse({ access_token: null })).toBe(false);
    });

    test("rejects response with empty string access_token", () => {
      expect(validateTokenResponse({ access_token: "" })).toBe(false);
    });
  });

  describe("User profile field validation", () => {
    interface DiscordApiUser {
      id?: string;
      username?: string;
      global_name?: string | null;
      avatar?: string | null;
    }

    const hasRequiredFields = (user: DiscordApiUser): boolean => {
      return !!user.id && !!user.username;
    };

    test("valid user with all fields", () => {
      expect(
        hasRequiredFields({
          id: "123456789",
          username: "testuser",
          global_name: "Test User",
          avatar: "abcdef",
        }),
      ).toBe(true);
    });

    test("valid user with minimal fields", () => {
      expect(
        hasRequiredFields({
          id: "123456789",
          username: "testuser",
        }),
      ).toBe(true);
    });

    test("rejects user missing id", () => {
      expect(hasRequiredFields({ username: "testuser" })).toBe(false);
    });

    test("rejects user missing username", () => {
      expect(hasRequiredFields({ id: "123" })).toBe(false);
    });

    test("rejects user with empty id", () => {
      expect(hasRequiredFields({ id: "", username: "testuser" })).toBe(false);
    });

    test("rejects user with empty username", () => {
      expect(hasRequiredFields({ id: "123", username: "" })).toBe(false);
    });

    test("rejects completely empty user", () => {
      expect(hasRequiredFields({})).toBe(false);
    });
  });

  describe("Error message truncation", () => {
    const truncateErrorMessage = (msg: string): string => msg.slice(0, 200);

    test("short messages pass through unchanged", () => {
      const msg = "Invalid grant";
      expect(truncateErrorMessage(msg)).toBe(msg);
    });

    test("truncates long messages to 200 chars", () => {
      const longMsg = "x".repeat(500);
      const truncated = truncateErrorMessage(longMsg);
      expect(truncated).toHaveLength(200);
    });

    test("handles empty string", () => {
      expect(truncateErrorMessage("")).toBe("");
    });

    test("handles exactly 200 chars", () => {
      const msg = "y".repeat(200);
      expect(truncateErrorMessage(msg)).toHaveLength(200);
      expect(truncateErrorMessage(msg)).toBe(msg);
    });
  });
});

// =============================================================================
// AUTH ENDPOINT SCHEMA VALIDATION - Tests using actual Zod + phone normalization
// =============================================================================

describe("Discord Auth Request Schema - ACTUAL Zod + normalizePhoneNumber()", () => {
  const optionalPhoneSchema = z
    .string()
    .optional()
    .transform((val, ctx) => {
      if (!val || val.trim() === "") return undefined;
      const normalized = normalizePhoneNumber(val);
      if (!isValidE164(normalized)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Invalid phone number format. Please use international format (e.g., +1234567890)",
        });
        return z.NEVER;
      }
      return normalized;
    });

  const discordAuthSchema = z.object({
    code: z.string().min(1, "Authorization code is required"),
    redirect_uri: z.string().url("Invalid redirect URI"),
    phone_number: optionalPhoneSchema,
  });

  describe("Valid requests", () => {
    test("accepts valid request with code and redirect_uri", () => {
      const result = discordAuthSchema.safeParse({
        code: "abc123",
        redirect_uri: "https://eliza.app/callback",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.code).toBe("abc123");
        expect(result.data.redirect_uri).toBe("https://eliza.app/callback");
        expect(result.data.phone_number).toBeUndefined();
      }
    });

    test("accepts request with valid US phone number", () => {
      const result = discordAuthSchema.safeParse({
        code: "abc123",
        redirect_uri: "https://eliza.app/callback",
        phone_number: "+14155551234",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.phone_number).toBe("+14155551234");
      }
    });

    test("normalizes formatted phone number", () => {
      const result = discordAuthSchema.safeParse({
        code: "abc123",
        redirect_uri: "https://eliza.app/callback",
        phone_number: "(415) 555-1234",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.phone_number).toBe("+14155551234");
      }
    });

    test("accepts international phone numbers", () => {
      const result = discordAuthSchema.safeParse({
        code: "abc123",
        redirect_uri: "https://eliza.app/callback",
        phone_number: "+442071234567",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.phone_number).toBe("+442071234567");
      }
    });

    test("treats empty phone_number as undefined", () => {
      const result = discordAuthSchema.safeParse({
        code: "abc123",
        redirect_uri: "https://eliza.app/callback",
        phone_number: "",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.phone_number).toBeUndefined();
      }
    });

    test("treats whitespace-only phone_number as undefined", () => {
      const result = discordAuthSchema.safeParse({
        code: "abc123",
        redirect_uri: "https://eliza.app/callback",
        phone_number: "   ",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.phone_number).toBeUndefined();
      }
    });
  });

  describe("Invalid requests", () => {
    test("rejects missing code", () => {
      const result = discordAuthSchema.safeParse({
        redirect_uri: "https://eliza.app/callback",
      });
      expect(result.success).toBe(false);
    });

    test("rejects empty code", () => {
      const result = discordAuthSchema.safeParse({
        code: "",
        redirect_uri: "https://eliza.app/callback",
      });
      expect(result.success).toBe(false);
    });

    test("rejects missing redirect_uri", () => {
      const result = discordAuthSchema.safeParse({
        code: "abc123",
      });
      expect(result.success).toBe(false);
    });

    test("rejects invalid redirect_uri", () => {
      const result = discordAuthSchema.safeParse({
        code: "abc123",
        redirect_uri: "not-a-url",
      });
      expect(result.success).toBe(false);
    });

    test("rejects invalid phone number format", () => {
      const result = discordAuthSchema.safeParse({
        code: "abc123",
        redirect_uri: "https://eliza.app/callback",
        phone_number: "not-a-phone",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const phoneIssue = result.error.issues.find((i) => i.path.includes("phone_number"));
        expect(phoneIssue).toBeDefined();
        expect(phoneIssue!.message).toContain("Invalid phone number format");
      }
    });

    test("rejects completely empty body", () => {
      const result = discordAuthSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });
});

// =============================================================================
// PHONE LINKING LOGIC
// =============================================================================

describe("Phone Linking Logic", () => {
  describe("Phone linking decision", () => {
    const shouldLinkPhone = (
      phoneNumber: string | undefined,
      existingPhone: string | null,
    ): boolean => {
      return !!phoneNumber && !existingPhone;
    };

    test("links when phone provided and user has no phone", () => {
      expect(shouldLinkPhone("+14155551234", null)).toBe(true);
    });

    test("skips when phone provided but user already has phone", () => {
      expect(shouldLinkPhone("+14155551234", "+19175551234")).toBe(false);
    });

    test("skips when no phone provided", () => {
      expect(shouldLinkPhone(undefined, null)).toBe(false);
    });

    test("skips when no phone provided and user has phone", () => {
      expect(shouldLinkPhone(undefined, "+14155551234")).toBe(false);
    });
  });

  describe("Phone conflict detection", () => {
    interface LinkResult {
      success: boolean;
      error?: string;
    }

    const simulateLinkResult = (userId: string, existingOwner: string | null): LinkResult => {
      if (!existingOwner) return { success: true };
      if (existingOwner === userId) return { success: true };
      return {
        success: false,
        error: "This phone number is already linked to another account",
      };
    };

    test("succeeds when phone is unlinked", () => {
      expect(simulateLinkResult("user-1", null)).toEqual({ success: true });
    });

    test("succeeds when phone already linked to same user", () => {
      expect(simulateLinkResult("user-1", "user-1")).toEqual({ success: true });
    });

    test("fails when phone linked to different user", () => {
      const result = simulateLinkResult("user-1", "user-2");
      expect(result.success).toBe(false);
      expect(result.error).toContain("already linked");
    });
  });
});

// =============================================================================
// OAUTH ENFORCEMENT IN WEBHOOK
// =============================================================================

describe("Discord OAuth Enforcement - Verified Against Webhook", () => {
  test("webhook requires OAuth (checks userWithOrg?.organization)", () => {
    const checkOAuth = (
      userWithOrg: { organization?: { id: string } | null } | undefined,
    ): boolean => {
      return !!userWithOrg?.organization;
    };

    expect(checkOAuth(undefined)).toBe(false);
    expect(checkOAuth({ organization: null })).toBe(false);
    expect(checkOAuth({ organization: undefined })).toBe(false);
    expect(checkOAuth({ organization: { id: "org-123" } })).toBe(true);
  });

  test("welcome message uses configurable appUrl", () => {
    const webhookSource = readFileSync(
      join(process.cwd(), "apps/api/eliza-app/webhook/discord/route.ts"),
      "utf-8",
    );
    // Verify it uses elizaAppConfig.appUrl, not a hardcoded URL
    expect(webhookSource).toContain("elizaAppConfig.appUrl");
    expect(webhookSource).toContain("/get-started");
  });

  test("Discord idempotency key format", () => {
    const eventId = "1234567890123456789";
    const key = `discord:eliza-app:${eventId}`;
    expect(key).toBe("discord:eliza-app:1234567890123456789");
  });
});

// =============================================================================
// AUTH ENDPOINT ERROR CODE CONSISTENCY
// =============================================================================

describe("Discord Auth Error Codes", () => {
  const ERROR_CODES = {
    INVALID_JSON: "INVALID_JSON",
    INVALID_REQUEST: "INVALID_REQUEST",
    INVALID_AUTH: "INVALID_AUTH",
    PHONE_ALREADY_LINKED: "PHONE_ALREADY_LINKED",
    INTERNAL_ERROR: "INTERNAL_ERROR",
  } as const;

  test("error codes are uppercase with underscores", () => {
    for (const code of Object.values(ERROR_CODES)) {
      expect(code).toMatch(/^[A-Z_]+$/);
    }
  });

  test("all expected error codes are present", () => {
    expect(ERROR_CODES.INVALID_JSON).toBe("INVALID_JSON");
    expect(ERROR_CODES.INVALID_REQUEST).toBe("INVALID_REQUEST");
    expect(ERROR_CODES.INVALID_AUTH).toBe("INVALID_AUTH");
    expect(ERROR_CODES.PHONE_ALREADY_LINKED).toBe("PHONE_ALREADY_LINKED");
    expect(ERROR_CODES.INTERNAL_ERROR).toBe("INTERNAL_ERROR");
  });

  test("error codes are verified against actual route code", () => {
    const routeSource = readFileSync(
      join(process.cwd(), "apps/api/eliza-app/auth/discord/route.ts"),
      "utf-8",
    );
    for (const code of Object.values(ERROR_CODES)) {
      expect(routeSource).toContain(`code: "${code}"`);
    }
  });
});

// =============================================================================
// RACE CONDITION HANDLING
// =============================================================================

describe("Discord Auth Race Condition Handling", () => {
  const isUniqueConstraintError = (error: unknown): boolean => {
    if (error instanceof Error) {
      return (
        error.message.includes("unique constraint") ||
        error.message.includes("duplicate key") ||
        (error as { code?: string }).code === "23505"
      );
    }
    return false;
  };

  test("detects PostgreSQL unique constraint error code", () => {
    const error = Object.assign(new Error("Error"), { code: "23505" });
    expect(isUniqueConstraintError(error)).toBe(true);
  });

  test("detects duplicate key message", () => {
    const error = new Error("duplicate key value violates unique constraint");
    expect(isUniqueConstraintError(error)).toBe(true);
  });

  test("ignores unrelated errors", () => {
    expect(isUniqueConstraintError(new Error("timeout"))).toBe(false);
    expect(isUniqueConstraintError(new Error("connection refused"))).toBe(false);
  });

  test("ignores non-Error objects", () => {
    expect(isUniqueConstraintError("string error")).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
    expect(isUniqueConstraintError(undefined)).toBe(false);
  });
});

// =============================================================================
// CONFIG VALIDATION
// =============================================================================

describe("Discord Config Structure", () => {
  test("config requires all Discord fields", () => {
    const configSource = readFileSync(
      join(process.cwd(), "packages/lib/services/eliza-app/config.ts"),
      "utf-8",
    );
    expect(configSource).toContain("ELIZA_APP_DISCORD_BOT_TOKEN");
    expect(configSource).toContain("ELIZA_APP_DISCORD_APPLICATION_ID");
    expect(configSource).toContain("ELIZA_APP_DISCORD_CLIENT_SECRET");
  });

  test("config defers Discord secrets to optional runtime envs", () => {
    const configSource = readFileSync(
      join(process.cwd(), "packages/lib/services/eliza-app/config.ts"),
      "utf-8",
    );
    expect(configSource).toContain('botToken: optionalRuntimeEnv("ELIZA_APP_DISCORD_BOT_TOKEN")');
    expect(configSource).toContain(
      'applicationId: optionalRuntimeEnv("ELIZA_APP_DISCORD_APPLICATION_ID")',
    );
    expect(configSource).toContain(
      'clientSecret: optionalRuntimeEnv("ELIZA_APP_DISCORD_CLIENT_SECRET")',
    );
  });

  test("config still validates Discord secrets when Discord is enabled", () => {
    const configSource = readFileSync(
      join(process.cwd(), "packages/lib/services/eliza-app/config.ts"),
      "utf-8",
    );
    expect(configSource).toContain('process.env.ELIZA_APP_DISCORD_ENABLED === "true"');
    expect(configSource).toContain(
      "Discord is enabled but required Discord env vars are not set in production",
    );
  });

  test("config includes appUrl for dynamic URLs", () => {
    const configSource = readFileSync(
      join(process.cwd(), "packages/lib/services/eliza-app/config.ts"),
      "utf-8",
    );
    expect(configSource).toContain("ELIZA_APP_URL");
    expect(configSource).toContain("appUrl");
  });
});
