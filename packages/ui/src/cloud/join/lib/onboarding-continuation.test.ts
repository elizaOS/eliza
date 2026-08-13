/** Verifies browser-only continuation credential persistence and cleanup. */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingOnboardingSession,
  peekPendingOnboardingSession,
  sanitizeOnboardingSessionToken,
  storePendingOnboardingSession,
} from "./onboarding-continuation";

const TOKEN = "aaaaaaaa-test-test-test-tokentoken01";
const STORAGE_KEY = "eliza.join.onboardingSession";

afterEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("sanitizeOnboardingSessionToken", () => {
  it("accepts only the opaque browser continuation shape", () => {
    expect(sanitizeOnboardingSessionToken(TOKEN)).toBe(TOKEN);
    expect(sanitizeOnboardingSessionToken(`  ${TOKEN}  `)).toBe(TOKEN);
    expect(
      sanitizeOnboardingSessionToken("platform:discord:999900000000000099"),
    ).toBeNull();
  });

  it.each([
    null,
    "",
    "short",
    "a".repeat(200),
    "bad token with spaces",
    "<script>alert(1)</script>",
  ])("rejects malformed value %j", (value) => {
    expect(sanitizeOnboardingSessionToken(value)).toBeNull();
  });
});

describe("pending-token persistence", () => {
  it("persists without consuming the token", () => {
    expect(storePendingOnboardingSession(TOKEN)).toBe(true);
    expect(peekPendingOnboardingSession()).toBe(TOKEN);
    expect(peekPendingOnboardingSession()).toBe(TOKEN);
  });

  it("never stores an invalid token", () => {
    expect(storePendingOnboardingSession("platform:discord:123456789012")).toBe(
      false,
    );
    expect(peekPendingOnboardingSession()).toBeNull();
  });

  it("expires the stored token", () => {
    vi.useFakeTimers();
    storePendingOnboardingSession(TOKEN);
    vi.setSystemTime(Date.now() + 61 * 60 * 1000);
    expect(peekPendingOnboardingSession()).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("removes malformed stored values without deleting a valid fallback", () => {
    window.localStorage.setItem(STORAGE_KEY, "not-json");
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ token: TOKEN, expiresAt: Date.now() + 60_000 }),
    );

    expect(peekPendingOnboardingSession()).toBe(TOKEN);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it("removes malformed values from both stores when no fallback is valid", () => {
    window.localStorage.setItem(STORAGE_KEY, "not-json");
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ token: "short", expiresAt: Date.now() + 60_000 }),
    );

    expect(peekPendingOnboardingSession()).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("clears both browser stores on explicit dismissal", () => {
    storePendingOnboardingSession(TOKEN);
    expect(clearPendingOnboardingSession()).toBe(true);
    expect(peekPendingOnboardingSession()).toBeNull();
  });

  it.each([
    ["local", true, false],
    ["session", false, true],
    ["both", true, true],
  ])(
    "reports a residual %s storage copy after removal",
    (_name, blockLocal, blockSession) => {
      storePendingOnboardingSession(TOKEN);
      const originalRemoveItem = Storage.prototype.removeItem;
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (
        this: Storage,
        key: string,
      ) {
        if (
          (blockLocal && this === window.localStorage) ||
          (blockSession && this === window.sessionStorage)
        ) {
          return;
        }
        originalRemoveItem.call(this, key);
      });

      expect(clearPendingOnboardingSession()).toBe(false);
      expect(window.localStorage.getItem(STORAGE_KEY) !== null).toBe(
        blockLocal,
      );
      expect(window.sessionStorage.getItem(STORAGE_KEY) !== null).toBe(
        blockSession,
      );
    },
  );

  it("reports success when session storage alone preserves the credential", () => {
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (this === window.localStorage)
        throw new Error("local storage blocked");
      originalSetItem.call(this, key, value);
    });

    expect(storePendingOnboardingSession(TOKEN)).toBe(true);
    expect(peekPendingOnboardingSession()).toBe(TOKEN);
  });

  it("reports failure when neither browser store verifies the credential", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });

    expect(storePendingOnboardingSession(TOKEN)).toBe(false);
    expect(peekPendingOnboardingSession()).toBeNull();
  });

  it("prefers a fresh cross-tab token over stale session storage", () => {
    const staleToken = "bbbbbbbb-test-test-test-tokentoken02";
    storePendingOnboardingSession(staleToken);
    window.localStorage.clear();
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (this === window.sessionStorage)
        throw new Error("session storage blocked");
      originalSetItem.call(this, key, value);
    });

    expect(storePendingOnboardingSession(TOKEN)).toBe(true);
    expect(peekPendingOnboardingSession()).toBe(TOKEN);
  });
});
