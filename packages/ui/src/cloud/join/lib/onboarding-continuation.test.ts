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
const OTHER_TOKEN = "bbbbbbbb-test-test-test-tokentoken02";
const STORAGE_KEY = "eliza.join.onboardingSession";

function storedSession(token = TOKEN, expiresAt = Date.now() + 60_000): string {
  return JSON.stringify({ token, expiresAt });
}

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
    expect(storePendingOnboardingSession(TOKEN)).toBe("present");
    expect(peekPendingOnboardingSession()).toBe("present");
    expect(peekPendingOnboardingSession()).toBe("present");
  });

  it("never stores an invalid token", () => {
    expect(storePendingOnboardingSession("platform:discord:123456789012")).toBe(
      "indeterminate",
    );
    expect(peekPendingOnboardingSession()).toBe("absent");
  });

  it("expires the stored token", () => {
    vi.useFakeTimers();
    storePendingOnboardingSession(TOKEN);
    vi.setSystemTime(Date.now() + 61 * 60 * 1000);
    expect(peekPendingOnboardingSession()).toBe("absent");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("removes malformed stored values without deleting a valid fallback", () => {
    window.localStorage.setItem(STORAGE_KEY, "not-json");
    window.sessionStorage.setItem(STORAGE_KEY, storedSession());

    expect(peekPendingOnboardingSession()).toBe("present");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it("removes malformed values from both stores when no fallback is valid", () => {
    window.localStorage.setItem(STORAGE_KEY, "not-json");
    window.sessionStorage.setItem(STORAGE_KEY, storedSession("short"));

    expect(peekPendingOnboardingSession()).toBe("absent");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("cleanup-verifies an empty malformed record instead of treating it as absent", () => {
    window.localStorage.setItem(STORAGE_KEY, "");
    const originalRemoveItem = Storage.prototype.removeItem;
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (
      this: Storage,
      key: string,
    ) {
      if (this === window.localStorage) return;
      originalRemoveItem.call(this, key);
    });

    expect(peekPendingOnboardingSession()).toBe("indeterminate");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("");
  });

  it("clears both browser stores on explicit dismissal", () => {
    storePendingOnboardingSession(TOKEN);
    expect(clearPendingOnboardingSession()).toBe("absent");
    expect(peekPendingOnboardingSession()).toBe("absent");
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

      expect(clearPendingOnboardingSession()).toBe("indeterminate");
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

    expect(storePendingOnboardingSession(TOKEN)).toBe("present");
    expect(peekPendingOnboardingSession()).toBe("present");
  });

  it("reports failure when neither browser store verifies the credential", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });

    expect(storePendingOnboardingSession(TOKEN)).toBe("indeterminate");
    expect(peekPendingOnboardingSession()).toBe("absent");
  });

  it.each([
    ["local", () => window.localStorage, () => window.sessionStorage],
    ["session", () => window.sessionStorage, () => window.localStorage],
  ])(
    "reports presence with a fresh %s record and cleans the expired peer",
    (_name, freshStorage, expiredStorage) => {
      freshStorage().setItem(STORAGE_KEY, storedSession());
      expiredStorage().setItem(STORAGE_KEY, storedSession(OTHER_TOKEN, 0));

      expect(peekPendingOnboardingSession()).toBe("present");
      expect(freshStorage().getItem(STORAGE_KEY)).not.toBeNull();
      expect(expiredStorage().getItem(STORAGE_KEY)).toBeNull();
    },
  );

  it("reports only presence when both stores contain different valid tokens", () => {
    const localRecord = storedSession(TOKEN);
    const sessionRecord = storedSession(OTHER_TOKEN);
    window.localStorage.setItem(STORAGE_KEY, localRecord);
    window.sessionStorage.setItem(STORAGE_KEY, sessionRecord);

    expect(peekPendingOnboardingSession()).toBe("present");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(localRecord);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(sessionRecord);
  });

  it("reports indeterminate when writes cannot be read back exactly", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => null);

    expect(storePendingOnboardingSession(TOKEN)).toBe("indeterminate");
  });

  it.each(["local", "session"])(
    "reports an unreadable %s store when no readable token exists",
    (blockedName) => {
      const blockedStorage =
        blockedName === "local" ? window.localStorage : window.sessionStorage;
      const originalGetItem = Storage.prototype.getItem;
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (
        this: Storage,
        key: string,
      ) {
        if (this === blockedStorage) throw new Error("storage unreadable");
        return originalGetItem.call(this, key);
      });

      expect(peekPendingOnboardingSession()).toBe("indeterminate");
    },
  );

  it("prefers a readable token when the other store is unreadable", () => {
    storePendingOnboardingSession(TOKEN);
    const originalGetItem = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (
      this: Storage,
      key: string,
    ) {
      if (this === window.localStorage) throw new Error("local unreadable");
      return originalGetItem.call(this, key);
    });

    expect(peekPendingOnboardingSession()).toBe("present");
  });

  it("reports unreadable when malformed storage cannot be cleaned", () => {
    window.localStorage.setItem(STORAGE_KEY, "not-json");
    const originalRemoveItem = Storage.prototype.removeItem;
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (
      this: Storage,
      key: string,
    ) {
      if (this === window.localStorage) return;
      originalRemoveItem.call(this, key);
    });

    expect(peekPendingOnboardingSession()).toBe("indeterminate");
  });

  it("reports indeterminate when malformed cleanup throws", () => {
    window.localStorage.setItem(STORAGE_KEY, "not-json");
    const originalRemoveItem = Storage.prototype.removeItem;
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (
      this: Storage,
      key: string,
    ) {
      if (this === window.localStorage) throw new Error("cleanup blocked");
      originalRemoveItem.call(this, key);
    });

    expect(peekPendingOnboardingSession()).toBe("indeterminate");
  });

  it.each(["localStorage", "sessionStorage"] as const)(
    "reports indeterminate when the %s property cannot be accessed",
    (storageName) => {
      const storageSpy = vi
        .spyOn(window, storageName, "get")
        .mockImplementation(() => {
          throw new Error(`${storageName} access blocked`);
        });

      expect(peekPendingOnboardingSession()).toBe("indeterminate");
      storageSpy.mockRestore();
    },
  );

  it.each(["localStorage", "sessionStorage"] as const)(
    "reports indeterminate when clear cannot access %s",
    (storageName) => {
      storePendingOnboardingSession(TOKEN);
      const storageSpy = vi
        .spyOn(window, storageName, "get")
        .mockImplementation(() => {
          throw new Error(`${storageName} access blocked`);
        });

      expect(clearPendingOnboardingSession()).toBe("indeterminate");
      storageSpy.mockRestore();
    },
  );

  it.each(["local", "session"])(
    "reports indeterminate when clear cannot verify the %s store",
    (blockedName) => {
      storePendingOnboardingSession(TOKEN);
      const blockedStorage =
        blockedName === "local" ? window.localStorage : window.sessionStorage;
      const originalGetItem = Storage.prototype.getItem;
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (
        this: Storage,
        key: string,
      ) {
        if (this === blockedStorage) throw new Error("verification blocked");
        return originalGetItem.call(this, key);
      });

      expect(clearPendingOnboardingSession()).toBe("indeterminate");
    },
  );

  it("accepts a removal exception only after both stores verify absence", () => {
    storePendingOnboardingSession(TOKEN);
    const originalRemoveItem = Storage.prototype.removeItem;
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (
      this: Storage,
      key: string,
    ) {
      originalRemoveItem.call(this, key);
      throw new Error("browser reported a late removal error");
    });

    expect(clearPendingOnboardingSession()).toBe("absent");
    expect(peekPendingOnboardingSession()).toBe("absent");
  });
});
