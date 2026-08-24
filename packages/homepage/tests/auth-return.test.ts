/**
 * Unit coverage for the same-origin post-authentication return contract.
 */

/* The package lane uses Bun while the isolated merge-readiness lane uses Vitest.
import { describe, expect, test } from "bun:test";
*/
import { safeReturnTo } from "../src/lib/auth-return";
import {
  getTelegramLinkDestination,
  TELEGRAM_ACCOUNT_CONNECTED_PATH,
  TELEGRAM_CONNECTED_PATH,
} from "../src/lib/telegram-onboarding";

const { describe, expect, test } = process.env.VITEST
  ? await import("vitest")
  : await import("bun:test");

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

describe("Telegram onboarding destination literals", () => {
  test("bot return destination pins the from=telegram marker on /connected", () => {
    expect(TELEGRAM_CONNECTED_PATH).toBe("/connected?from=telegram");
  });

  test("account linking pins the bare /connected path without the bot marker", () => {
    expect(TELEGRAM_ACCOUNT_CONNECTED_PATH).toBe("/connected");
  });

  test("the destinations stay distinct so redemption state remains observable", () => {
    expect(TELEGRAM_CONNECTED_PATH).not.toBe(TELEGRAM_ACCOUNT_CONNECTED_PATH);
    expect(getTelegramLinkDestination(true)).not.toBe(
      getTelegramLinkDestination(false),
    );
  });

  test("both destinations stay on the /connected route with only the bot return carrying the marker", () => {
    const botReturn = new URL(TELEGRAM_CONNECTED_PATH, "https://eliza.app");
    const accountLink = new URL(
      TELEGRAM_ACCOUNT_CONNECTED_PATH,
      "https://eliza.app",
    );
    expect(botReturn.pathname).toBe("/connected");
    expect(accountLink.pathname).toBe("/connected");
    expect(botReturn.searchParams.get("from")).toBe("telegram");
    expect(accountLink.searchParams.has("from")).toBe(false);
  });
});

const { clearRememberedReturnTo, peekReturnTo, rememberReturnTo } =
  await import("../src/lib/auth-return");

describe("safeReturnTo input edges", () => {
  test("rejects undefined and empty destinations", () => {
    expect(safeReturnTo(undefined)).toBeNull();
    expect(safeReturnTo("")).toBeNull();
  });

  test("accepts internal paths containing doubled slashes inside the path", () => {
    expect(safeReturnTo("/a//b")).toBe("/a//b");
  });
});

class MemorySessionStorage {
  private readonly entries = new Map<string, string>();

  snapshot(): Map<string, string> {
    return new Map(this.entries);
  }

  getItem(key: string): string | null {
    return this.entries.has(key) ? (this.entries.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, String(value));
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }
}

const sharedGlobals = globalThis as unknown as {
  window?: unknown;
  sessionStorage?: unknown;
};

function withBrowserGlobals(
  run: (storage: MemorySessionStorage) => void,
): void {
  const { window: previousWindow, sessionStorage: previousStorage } =
    sharedGlobals;
  const storage = new MemorySessionStorage();
  sharedGlobals.sessionStorage = storage;
  sharedGlobals.window = globalThis;
  try {
    run(storage);
  } finally {
    if (previousWindow === undefined) delete sharedGlobals.window;
    else sharedGlobals.window = previousWindow;
    if (previousStorage === undefined) delete sharedGlobals.sessionStorage;
    else sharedGlobals.sessionStorage = previousStorage;
  }
}

function withoutWindow(run: () => void): void {
  const { window: previousWindow, sessionStorage: previousStorage } =
    sharedGlobals;
  delete sharedGlobals.window;
  delete sharedGlobals.sessionStorage;
  try {
    run();
  } finally {
    if (previousWindow !== undefined) sharedGlobals.window = previousWindow;
    if (previousStorage !== undefined) {
      sharedGlobals.sessionStorage = previousStorage;
    }
  }
}

describe("remembered return persistence", () => {
  test("without a browser session the helpers degrade to explicit fallbacks", () => {
    withoutWindow(() => {
      expect(() => rememberReturnTo("/profile/edit")).not.toThrow();
      expect(() => clearRememberedReturnTo()).not.toThrow();
      expect(peekReturnTo(null)).toBe("/connected");
      expect(peekReturnTo("//evil.com", "/get-started")).toBe("/get-started");
    });
  });

  test("a remembered safe destination round-trips query and hash", () => {
    withBrowserGlobals(() => {
      rememberReturnTo("/profile/edit?source=login#wallet");
      expect(peekReturnTo(null)).toBe("/profile/edit?source=login#wallet");
    });
  });

  test("a safe query destination wins over the remembered value", () => {
    withBrowserGlobals(() => {
      rememberReturnTo("/profile/edit");
      expect(peekReturnTo("/connected")).toBe("/connected");
    });
  });

  test("an unsafe query destination falls back to the remembered value", () => {
    withBrowserGlobals(() => {
      rememberReturnTo("/profile/edit");
      expect(peekReturnTo("https://example.com")).toBe("/profile/edit");
    });
  });

  test("remembering an unsafe or null destination removes the stored return", () => {
    withBrowserGlobals(() => {
      rememberReturnTo("/profile/edit");
      rememberReturnTo("https://example.com");
      expect(peekReturnTo(null)).toBe("/connected");
      rememberReturnTo("/wallet");
      rememberReturnTo(null);
      expect(peekReturnTo(null)).toBe("/connected");
    });
  });

  test("clearRememberedReturnTo drops the remembered destination", () => {
    withBrowserGlobals(() => {
      rememberReturnTo("/profile/edit");
      clearRememberedReturnTo();
      expect(peekReturnTo(null)).toBe("/connected");
    });
  });

  test("an escaping value planted in storage cannot hijack the fallback", () => {
    withBrowserGlobals((storage) => {
      rememberReturnTo("/known-safe");
      const [storedKey] =
        [...storage.snapshot().entries()].find(
          ([, value]) => value === "/known-safe",
        ) ?? [];
      expect(typeof storedKey).toBe("string");
      storage.setItem(storedKey as string, "//evil.com");
      expect(peekReturnTo(null)).toBe("/connected");
    });
  });
});
