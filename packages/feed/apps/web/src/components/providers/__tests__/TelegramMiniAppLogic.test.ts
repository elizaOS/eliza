/**
 * Tests for Telegram Mini App Provider — Pure Logic
 *
 * Tests the non-React pure logic used in TelegramMiniAppProvider:
 * - Share URL construction
 * - User field normalization (camelCase ↔ snake_case mapping)
 *
 * @see TelegramMiniAppProvider.tsx
 */

import { describe, expect, it } from "bun:test";

/**
 * Replicate the Telegram share URL construction from TelegramMiniAppProvider.
 */
function buildTelegramShareUrl(url: string, text?: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(url)}${text ? `&text=${encodeURIComponent(text)}` : ""}`;
}

/**
 * Replicate the user field normalization logic from TelegramMiniAppProvider.
 * Maps loosely-typed Telegram user data (potentially either camelCase or
 * snake_case) to the TelegramUser interface.
 */
function normalizeTelegramUser(u: Record<string, unknown>): {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
  photoUrl?: string;
} {
  return {
    id: Number(u.id),
    firstName: String(u.firstName ?? u.first_name ?? ""),
    lastName:
      u.lastName != null || u.last_name != null
        ? String(u.lastName ?? u.last_name)
        : undefined,
    username: u.username != null ? String(u.username) : undefined,
    photoUrl:
      u.photoUrl != null || u.photo_url != null
        ? String(u.photoUrl ?? u.photo_url)
        : undefined,
  };
}

describe("Telegram Share URL Construction", () => {
  it("should construct a share URL with just a URL", () => {
    const result = buildTelegramShareUrl("https://example.com");
    expect(result).toBe("https://t.me/share/url?url=https%3A%2F%2Fexample.com");
  });

  it("should construct a share URL with URL and text", () => {
    const result = buildTelegramShareUrl("https://example.com", "Check this!");
    expect(result).toBe(
      "https://t.me/share/url?url=https%3A%2F%2Fexample.com&text=Check%20this!",
    );
  });

  it("should properly encode special characters in URL", () => {
    const result = buildTelegramShareUrl(
      "https://example.com/path?foo=bar&baz=qux",
    );
    expect(result).toContain(
      encodeURIComponent("https://example.com/path?foo=bar&baz=qux"),
    );
  });

  it("should properly encode special characters in text", () => {
    const result = buildTelegramShareUrl(
      "https://example.com",
      'Hello & goodbye! "quotes"',
    );
    expect(result).toContain(encodeURIComponent('Hello & goodbye! "quotes"'));
  });

  it("should handle empty text as no text parameter", () => {
    const result = buildTelegramShareUrl("https://example.com", "");
    // Empty string is falsy, so no &text= parameter
    expect(result).not.toContain("&text=");
  });

  it("should handle undefined text", () => {
    const result = buildTelegramShareUrl("https://example.com", undefined);
    expect(result).not.toContain("&text=");
  });

  it("should handle URLs with Unicode characters", () => {
    const result = buildTelegramShareUrl("https://example.com/日本語");
    expect(result).toContain(encodeURIComponent("https://example.com/日本語"));
  });

  it("should handle text with emoji", () => {
    const result = buildTelegramShareUrl("https://example.com", "🚀 Launch!");
    expect(result).toContain(encodeURIComponent("🚀 Launch!"));
  });
});

describe("Telegram User Field Normalization", () => {
  it("should normalize snake_case fields to camelCase", () => {
    const user = normalizeTelegramUser({
      id: 123,
      first_name: "John",
      last_name: "Doe",
      username: "johndoe",
      photo_url: "https://photo.url",
    });
    expect(user.id).toBe(123);
    expect(user.firstName).toBe("John");
    expect(user.lastName).toBe("Doe");
    expect(user.username).toBe("johndoe");
    expect(user.photoUrl).toBe("https://photo.url");
  });

  it("should normalize camelCase fields", () => {
    const user = normalizeTelegramUser({
      id: 456,
      firstName: "Jane",
      lastName: "Smith",
      username: "janesmith",
      photoUrl: "https://photo2.url",
    });
    expect(user.id).toBe(456);
    expect(user.firstName).toBe("Jane");
    expect(user.lastName).toBe("Smith");
    expect(user.username).toBe("janesmith");
    expect(user.photoUrl).toBe("https://photo2.url");
  });

  it("should prefer camelCase over snake_case when both present", () => {
    const user = normalizeTelegramUser({
      id: 789,
      firstName: "CamelFirst",
      first_name: "SnakeFirst",
      lastName: "CamelLast",
      last_name: "SnakeLast",
      photoUrl: "https://camel.url",
      photo_url: "https://snake.url",
    });
    // The logic uses: u.firstName ?? u.first_name
    // So camelCase wins when present
    expect(user.firstName).toBe("CamelFirst");
    expect(user.lastName).toBe("CamelLast");
    expect(user.photoUrl).toBe("https://camel.url");
  });

  it("should handle missing optional fields", () => {
    const user = normalizeTelegramUser({
      id: 100,
      first_name: "Minimal",
    });
    expect(user.id).toBe(100);
    expect(user.firstName).toBe("Minimal");
    expect(user.lastName).toBeUndefined();
    expect(user.username).toBeUndefined();
    expect(user.photoUrl).toBeUndefined();
  });

  it("should handle missing first_name gracefully (empty string fallback)", () => {
    const user = normalizeTelegramUser({
      id: 200,
    });
    expect(user.firstName).toBe("");
  });

  it("should convert numeric string id correctly", () => {
    const user = normalizeTelegramUser({
      id: "999",
      first_name: "StringId",
    });
    expect(user.id).toBe(999);
  });

  it("should handle Unicode in user names", () => {
    const user = normalizeTelegramUser({
      id: 300,
      first_name: "太郎",
      last_name: "田中",
      username: "tanaka_taro",
    });
    expect(user.firstName).toBe("太郎");
    expect(user.lastName).toBe("田中");
  });

  it("should handle emoji in user names", () => {
    const user = normalizeTelegramUser({
      id: 400,
      first_name: "🚀 Rocket",
      last_name: "Man 🌙",
    });
    expect(user.firstName).toBe("🚀 Rocket");
    expect(user.lastName).toBe("Man 🌙");
  });

  it("should treat null username as undefined", () => {
    const user = normalizeTelegramUser({
      id: 500,
      first_name: "Test",
      username: null,
    });
    expect(user.username).toBeUndefined();
  });

  it("should handle last_name being null while lastName is undefined", () => {
    // When last_name is explicitly null (not undefined), the condition
    // `u.lastName != null || u.last_name != null` should still be false
    // because null != null is false
    const user = normalizeTelegramUser({
      id: 600,
      first_name: "Test",
      last_name: null,
    });
    // null != null is false, so lastName should be undefined
    expect(user.lastName).toBeUndefined();
  });
});
