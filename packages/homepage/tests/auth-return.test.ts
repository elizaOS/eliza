/**
 * Unit coverage for the same-origin post-authentication return contract.
 */

import { describe, expect, test } from "bun:test";
import { safeReturnTo } from "../src/lib/auth-return";
import {
  getTelegramLinkDestination,
  TELEGRAM_ACCOUNT_CONNECTED_PATH,
  TELEGRAM_CONNECTED_PATH,
} from "../src/lib/telegram-onboarding";

describe("safe auth return paths", () => {
  test("accepts internal paths with query strings and hashes", () => {
    expect(safeReturnTo("/profile/edit?source=login#wallet")).toBe(
      "/profile/edit?source=login#wallet",
    );
  });

  test("rejects external, scheme-relative, and malformed destinations", () => {
    expect(safeReturnTo("https://example.com")).toBeNull();
    expect(safeReturnTo("//example.com/profile/edit")).toBeNull();
    expect(safeReturnTo("profile/edit")).toBeNull();
    expect(safeReturnTo(null)).toBeNull();
  });

  test("rejects dot-segment inputs that normalize into origin-escaping //host", () => {
    // Each input starts with a single "/" so it slips past the raw "//" guard,
    // but URL normalization collapses the traversal into a protocol-relative
    // "//evil.com" that escapes the homepage origin.
    expect(safeReturnTo("/..//evil.com")).toBeNull();
    expect(safeReturnTo("/..//..//evil.com")).toBeNull();
    expect(safeReturnTo("/./..//evil.com")).toBeNull();
    expect(safeReturnTo("/x/../..//evil.com")).toBeNull();
    expect(safeReturnTo("/%2e%2e//evil.com")).toBeNull();
  });

  test("still accepts legitimate internal paths after the traversal guard", () => {
    expect(safeReturnTo("/profile/edit")).toBe("/profile/edit");
    expect(safeReturnTo("/connected")).toBe("/connected");
    expect(safeReturnTo("/get-started?returnTo=%2Fcloud")).toBe(
      "/get-started?returnTo=%2Fcloud",
    );
    expect(safeReturnTo("/a/../b")).toBe("/b");
  });
});

describe("Telegram onboarding continuation", () => {
  test("returns to the bot only after a bot continuation auth flow", () => {
    expect(getTelegramLinkDestination(true)).toBe(TELEGRAM_CONNECTED_PATH);
  });

  test("preserves ordinary Telegram account linking", () => {
    expect(getTelegramLinkDestination(false)).toBe(
      TELEGRAM_ACCOUNT_CONNECTED_PATH,
    );
  });
});
