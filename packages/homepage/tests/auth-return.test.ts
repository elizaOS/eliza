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
