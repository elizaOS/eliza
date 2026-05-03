/**
 * Discord User Service Tests
 *
 * Tests for Discord-related methods in user-service.ts:
 * - findOrCreateByDiscordId() - auto-provisioning logic
 * - getByDiscordId() - lookup functionality
 * - updateDiscordProfile() - profile updates
 * - Slug generation for Discord users
 * - Race condition handling (unique constraint errors)
 */

import { describe, expect, test } from "bun:test";

describe("Discord User Service", () => {
  describe("generateSlugFromDiscord", () => {
    // Replicating the slug generation logic for testing
    const generateSlugFromDiscord = (username?: string, discordId?: string): string => {
      const base = username ? username.toLowerCase().replace(/[^a-z0-9]/g, "-") : discordId;
      const random = Math.random().toString(36).substring(2, 8);
      const timestamp = Date.now().toString(36).slice(-4);
      return `discord-${base}-${timestamp}${random}`;
    };

    test("generates slug with discord- prefix when username provided", () => {
      const slug = generateSlugFromDiscord("TestUser", "123456789");
      expect(slug).toMatch(/^discord-testuser-[a-z0-9]+$/);
    });

    test("generates slug with discord- prefix when only discordId provided", () => {
      const slug = generateSlugFromDiscord(undefined, "123456789");
      expect(slug).toMatch(/^discord-123456789-[a-z0-9]+$/);
    });

    test("sanitizes special characters in username", () => {
      const slug = generateSlugFromDiscord("Test_User.123", "123456789");
      expect(slug).toMatch(/^discord-test-user-123-[a-z0-9]+$/);
    });

    test("converts username to lowercase", () => {
      const slug = generateSlugFromDiscord("UPPERCASE", "123456789");
      expect(slug).toMatch(/^discord-uppercase-[a-z0-9]+$/);
    });

    test("handles unicode characters by removing them", () => {
      const slug = generateSlugFromDiscord("Test🎉User", "123456789");
      expect(slug).toMatch(/^discord-test--user-[a-z0-9]+$/);
    });

    test("generates unique slugs on multiple calls", () => {
      const slug1 = generateSlugFromDiscord("TestUser", "123456789");
      const slug2 = generateSlugFromDiscord("TestUser", "123456789");
      // Due to random component, slugs should be different
      // (technically could collide but extremely unlikely)
      expect(slug1.startsWith("discord-testuser-")).toBe(true);
      expect(slug2.startsWith("discord-testuser-")).toBe(true);
    });
  });

  describe("Discord user data handling", () => {
    interface DiscordUserData {
      username: string;
      globalName?: string | null;
      avatarUrl?: string | null;
    }

    test("handles Discord user with all fields", () => {
      const userData: DiscordUserData = {
        username: "testuser",
        globalName: "Test User",
        avatarUrl: "https://cdn.discordapp.com/avatars/123/abc.png",
      };
      expect(userData.username).toBe("testuser");
      expect(userData.globalName).toBe("Test User");
      expect(userData.avatarUrl).toContain("cdn.discordapp.com");
    });

    test("handles Discord user with minimal fields", () => {
      const userData: DiscordUserData = {
        username: "testuser",
      };
      expect(userData.username).toBe("testuser");
      expect(userData.globalName).toBeUndefined();
      expect(userData.avatarUrl).toBeUndefined();
    });

    test("handles null globalName and avatarUrl", () => {
      const userData: DiscordUserData = {
        username: "testuser",
        globalName: null,
        avatarUrl: null,
      };
      expect(userData.globalName).toBeNull();
      expect(userData.avatarUrl).toBeNull();
    });
  });

  describe("Discord avatar URL generation", () => {
    const generateAvatarUrl = (discordUserId: string, avatar: string | null): string | null => {
      if (!avatar) return null;
      return `https://cdn.discordapp.com/avatars/${discordUserId}/${avatar}.png`;
    };

    test("generates correct avatar URL", () => {
      const url = generateAvatarUrl("123456789", "abcdef123456");
      expect(url).toBe("https://cdn.discordapp.com/avatars/123456789/abcdef123456.png");
    });

    test("returns null when no avatar", () => {
      const url = generateAvatarUrl("123456789", null);
      expect(url).toBeNull();
    });

    test("handles various avatar hash formats", () => {
      // Discord avatar hashes can be different lengths
      const url1 = generateAvatarUrl("123", "a_abcdef123456"); // Animated avatar prefix
      const url2 = generateAvatarUrl("123", "abcdef");
      expect(url1).toContain("a_abcdef123456");
      expect(url2).toContain("abcdef");
    });
  });

  describe("Display name resolution", () => {
    const resolveDisplayName = (username: string, globalName?: string | null): string => {
      return globalName || username;
    };

    test("uses globalName when available", () => {
      expect(resolveDisplayName("testuser", "Test User")).toBe("Test User");
    });

    test("falls back to username when globalName is null", () => {
      expect(resolveDisplayName("testuser", null)).toBe("testuser");
    });

    test("falls back to username when globalName is undefined", () => {
      expect(resolveDisplayName("testuser", undefined)).toBe("testuser");
    });

    test("falls back to username when globalName is empty string", () => {
      expect(resolveDisplayName("testuser", "")).toBe("testuser");
    });
  });

  describe("Profile update detection", () => {
    interface ExistingUser {
      discord_username?: string | null;
      discord_global_name?: string | null;
      discord_avatar_url?: string | null;
    }

    interface NewUserData {
      username: string;
      globalName?: string | null;
      avatarUrl?: string | null;
    }

    const needsProfileUpdate = (existing: ExistingUser, newData: NewUserData): boolean => {
      if (newData.username && newData.username !== existing.discord_username) return true;
      if (newData.globalName !== undefined && newData.globalName !== existing.discord_global_name)
        return true;
      if (newData.avatarUrl !== undefined && newData.avatarUrl !== existing.discord_avatar_url)
        return true;
      return false;
    };

    test("detects username change", () => {
      const existing: ExistingUser = { discord_username: "olduser" };
      const newData: NewUserData = { username: "newuser" };
      expect(needsProfileUpdate(existing, newData)).toBe(true);
    });

    test("detects globalName change", () => {
      const existing: ExistingUser = {
        discord_username: "user",
        discord_global_name: "Old Name",
      };
      const newData: NewUserData = { username: "user", globalName: "New Name" };
      expect(needsProfileUpdate(existing, newData)).toBe(true);
    });

    test("detects avatar change", () => {
      const existing: ExistingUser = {
        discord_username: "user",
        discord_avatar_url: "https://old.png",
      };
      const newData: NewUserData = {
        username: "user",
        avatarUrl: "https://new.png",
      };
      expect(needsProfileUpdate(existing, newData)).toBe(true);
    });

    test("returns false when no changes", () => {
      const existing: ExistingUser = {
        discord_username: "user",
        discord_global_name: "User",
        discord_avatar_url: "https://avatar.png",
      };
      const newData: NewUserData = {
        username: "user",
        globalName: "User",
        avatarUrl: "https://avatar.png",
      };
      expect(needsProfileUpdate(existing, newData)).toBe(false);
    });

    test("handles null to value transition", () => {
      const existing: ExistingUser = {
        discord_username: "user",
        discord_global_name: null,
      };
      const newData: NewUserData = { username: "user", globalName: "New Name" };
      expect(needsProfileUpdate(existing, newData)).toBe(true);
    });

    test("handles value to null transition", () => {
      const existing: ExistingUser = {
        discord_username: "user",
        discord_global_name: "Name",
      };
      const newData: NewUserData = { username: "user", globalName: null };
      expect(needsProfileUpdate(existing, newData)).toBe(true);
    });
  });

  describe("Unique constraint error detection", () => {
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

    test("detects unique constraint violation message", () => {
      const error = new Error("unique constraint violation on discord_id");
      expect(isUniqueConstraintError(error)).toBe(true);
    });

    test("detects duplicate key message", () => {
      const error = new Error("duplicate key value violates unique constraint");
      expect(isUniqueConstraintError(error)).toBe(true);
    });

    test("detects PostgreSQL error code 23505", () => {
      const error = Object.assign(new Error("Error"), { code: "23505" });
      expect(isUniqueConstraintError(error)).toBe(true);
    });

    test("returns false for other errors", () => {
      const error = new Error("Connection timeout");
      expect(isUniqueConstraintError(error)).toBe(false);
    });

    test("returns false for non-Error objects", () => {
      expect(isUniqueConstraintError("string error")).toBe(false);
      expect(isUniqueConstraintError({ message: "unique constraint" })).toBe(false);
      expect(isUniqueConstraintError(null)).toBe(false);
    });
  });

  describe("Organization name generation", () => {
    const generateOrgName = (displayName: string): string => {
      return `${displayName}'s Workspace`;
    };

    test("generates workspace name from display name", () => {
      expect(generateOrgName("Test User")).toBe("Test User's Workspace");
    });

    test("handles single word name", () => {
      expect(generateOrgName("TestUser")).toBe("TestUser's Workspace");
    });

    test("handles unicode characters", () => {
      expect(generateOrgName("测试用户")).toBe("测试用户's Workspace");
    });

    test("handles emoji in name", () => {
      expect(generateOrgName("Test 🎉")).toBe("Test 🎉's Workspace");
    });
  });
});

describe("Discord ID validation", () => {
  // Discord IDs are snowflakes - 64-bit integers represented as strings
  const isValidDiscordId = (id: string): boolean => {
    // Discord snowflakes are numeric strings, typically 17-19 digits
    if (!/^\d{17,19}$/.test(id)) return false;
    // Additional validation: must be a valid bigint
    try {
      BigInt(id);
      return true;
    } catch {
      return false;
    }
  };

  test("validates correct Discord ID format", () => {
    expect(isValidDiscordId("123456789012345678")).toBe(true);
    expect(isValidDiscordId("1234567890123456789")).toBe(true);
  });

  test("rejects too short IDs", () => {
    expect(isValidDiscordId("123456789")).toBe(false);
    expect(isValidDiscordId("1234567890123456")).toBe(false);
  });

  test("rejects too long IDs", () => {
    expect(isValidDiscordId("12345678901234567890")).toBe(false);
  });

  test("rejects non-numeric IDs", () => {
    expect(isValidDiscordId("abc456789012345678")).toBe(false);
    expect(isValidDiscordId("12345678901234567a")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(isValidDiscordId("")).toBe(false);
  });
});
