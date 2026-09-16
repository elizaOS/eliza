/**
 * Unit coverage for the Steward OAuth PKCE helpers (`steward-oauth-pkce.ts`):
 * verifies the S256 code challenge derives from its verifier, that
 * `buildStewardOAuthAuthorizeUrl` includes the PKCE query params (code_challenge +
 * S256 method) when a challenge is supplied and omits them when it is not, and
 * that the OAuth `state` is carried in the authorize URL, stored beside the
 * verifier, and peekable without consuming it.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearStoredStewardToken,
  getStewardTabSessionAuthorityCoordinator,
  resetStewardTabSessionAuthorityCoordinatorForTests,
  STEWARD_ACTIVE_SCOPE_KEY,
  STEWARD_TOKEN_KEY,
  writeStoredStewardToken,
} from "./index";
import {
  buildStewardOAuthAuthorizeUrl,
  consumeStewardOAuthAttempt,
  consumeStewardPkceVerifier,
  createStewardOAuthAuthorityBinding,
  createStewardPkceChallenge,
  createStewardPkcePair,
  generateStewardOAuthState,
  peekStewardOAuthState,
  storeStewardPkceVerifier,
} from "./steward-oauth-pkce.js";

const STORAGE_KEY = "steward.oauth.pkce.verifier";

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
  resetStewardTabSessionAuthorityCoordinatorForTests();
});

async function storeAttempt(state = "state-1", verifier = "verifier-1") {
  const expected = getStewardTabSessionAuthorityCoordinator().readSnapshot();
  const binding = await createStewardOAuthAuthorityBinding(expected);
  expect(storeStewardPkceVerifier(verifier, state, binding)).toBe(true);
  return expected;
}

describe("OAuth original authority record", () => {
  it.each(["A", "B"])(
    "consumes only launch %s with its own conversation destination",
    async (selected) => {
      const binding = await createStewardOAuthAuthorityBinding(
        getStewardTabSessionAuthorityCoordinator().readSnapshot(),
      );
      expect(
        storeStewardPkceVerifier(
          "verifier-A",
          "state-A",
          binding,
          "/chat?conversation=A",
        ),
      ).toBe(true);
      const first = sessionStorage.getItem(STORAGE_KEY);
      expect(
        storeStewardPkceVerifier(
          "verifier-B",
          "state-B",
          binding,
          "/chat?conversation=B",
        ),
      ).toBe(true);
      if (!first) throw new Error("Missing first launch fixture");
      sessionStorage.setItem(STORAGE_KEY, first);
      const other = selected === "A" ? "B" : "A";
      for (const state of [selected, other]) {
        const consumed = await consumeStewardOAuthAttempt(`state-${state}`);
        expect(consumed.codeVerifier).toBe(`verifier-${state}`);
        expect(consumed.returnTo).toBe(`/chat?conversation=${state}`);
      }
    },
  );

  it.each([
    "https://external.example.test/chat",
    "//external.example.test/chat",
    "/\\external.example.test/chat",
  ])("refuses an unsafe stored destination: %s", async (destination) => {
    const binding = await createStewardOAuthAuthorityBinding(
      getStewardTabSessionAuthorityCoordinator().readSnapshot(),
    );
    expect(
      storeStewardPkceVerifier("verifier", "state", binding, destination),
    ).toBe(false);
    await storeAttempt();
    for (const storage of [sessionStorage, localStorage]) {
      const record = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
      if (!record) throw new Error("Missing launch fixture");
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify({ ...record, returnTo: destination }),
      );
    }
    await expect(consumeStewardOAuthAttempt("state-1")).rejects.toThrow(
      /start sign-in again/,
    );
  });

  it.each([null, "original-token"])(
    "restores matching authority without another bearer copy: %s",
    async (token) => {
      if (token) await writeStoredStewardToken(token);
      const expected = await storeAttempt();
      if (token) expect(localStorage.getItem(STORAGE_KEY)).not.toContain(token);
      expect(await consumeStewardOAuthAttempt("state-1")).toEqual({
        codeVerifier: "verifier-1",
        expected,
        returnTo: null,
      });
      await expect(consumeStewardOAuthAttempt("state-1")).rejects.toThrow(
        /start sign-in again/,
      );
    },
  );

  it.each(["logout", "same-token-login", "replacement", "scope"])(
    "rejects %s across the provider roundtrip",
    async (change) => {
      await writeStoredStewardToken("original-token");
      await storeAttempt();
      if (change === "logout" || change === "same-token-login")
        await clearStoredStewardToken();
      if (change === "same-token-login")
        await writeStoredStewardToken("original-token");
      if (change === "replacement")
        await writeStoredStewardToken("another-token");
      if (change === "scope")
        localStorage.setItem(STEWARD_ACTIVE_SCOPE_KEY, "different-target");
      await expect(consumeStewardOAuthAttempt("state-1")).rejects.toMatchObject(
        { code: "STEWARD_SESSION_AUTHORITY_SUPERSEDED" },
      );
    },
  );

  it("refuses unbound legacy records and leaves a foreign-state launch untouched", async () => {
    storeStewardPkceVerifier("legacy-verifier", "legacy-state");
    await expect(consumeStewardOAuthAttempt("legacy-state")).rejects.toThrow(
      /start sign-in again/,
    );
    await storeAttempt();
    await expect(consumeStewardOAuthAttempt("foreign-state")).rejects.toThrow(
      /start sign-in again/,
    );
    expect((await consumeStewardOAuthAttempt("state-1")).codeVerifier).toBe(
      "verifier-1",
    );
  });

  it("does not splice or delete a different tab's fallback record", async () => {
    await storeAttempt("state-A", "verifier-A");
    const first = sessionStorage.getItem(STORAGE_KEY);
    await storeAttempt("state-B", "verifier-B");
    if (!first) throw new Error("Missing first launch fixture");
    sessionStorage.setItem(STORAGE_KEY, first);
    expect((await consumeStewardOAuthAttempt("state-A")).codeVerifier).toBe(
      "verifier-A",
    );
    expect((await consumeStewardOAuthAttempt("state-B")).codeVerifier).toBe(
      "verifier-B",
    );
  });

  it("selects the complete matching fallback rather than a stale tab-local record", async () => {
    await storeAttempt("state-A", "verifier-A");
    const first = sessionStorage.getItem(STORAGE_KEY);
    await storeAttempt("state-B", "verifier-B");
    if (!first) throw new Error("Missing first launch fixture");
    sessionStorage.setItem(STORAGE_KEY, first);
    expect((await consumeStewardOAuthAttempt("state-B")).codeVerifier).toBe(
      "verifier-B",
    );
    expect((await consumeStewardOAuthAttempt("state-A")).codeVerifier).toBe(
      "verifier-A",
    );
  });

  it("does not claim a launch was stored when writes are silently dropped", () => {
    const set = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (key !== STORAGE_KEY) set.call(this, key, value);
    });
    expect(storeStewardPkceVerifier("verifier", "state")).toBe(false);
  });

  it("uses a complete local record when session storage is denied", async () => {
    const denied = vi
      .spyOn(window, "sessionStorage", "get")
      .mockImplementation(() => {
        throw new DOMException("Denied", "SecurityError");
      });
    await storeAttempt();
    expect((await consumeStewardOAuthAttempt("state-1")).codeVerifier).toBe(
      "verifier-1",
    );
    denied.mockRestore();
  });

  it("refuses an expired record without exchanging it", async () => {
    await storeAttempt();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
    await expect(consumeStewardOAuthAttempt("state-1")).rejects.toThrow(
      /start sign-in again/,
    );
  });

  it("requires acknowledged consumption before returning a verifier", async () => {
    await storeAttempt();
    const remove = Storage.prototype.removeItem;
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (
      this: Storage,
      key,
    ) {
      if (key === STORAGE_KEY)
        throw new DOMException("Denied", "SecurityError");
      return remove.call(this, key);
    });
    await expect(consumeStewardOAuthAttempt("state-1")).rejects.toMatchObject({
      code: "STEWARD_SESSION_AUTHORITY_STORAGE_FAILED",
    });
  });

  it("revalidates after asynchronous fingerprint calculation", async () => {
    await writeStoredStewardToken("original-token");
    await storeAttempt();
    const started = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
      started.resolve();
      await held.promise;
      return digest(...args);
    });
    const result = consumeStewardOAuthAttempt("state-1").catch(
      (error: Error) => error,
    );
    await started.promise;
    // Synthetic legacy writer outside the lease, not a production mutation.
    localStorage.setItem(STEWARD_TOKEN_KEY, "replacement-token");
    held.resolve();
    expect(await result).toMatchObject({
      code: "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
    });
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe("replacement-token");
    expect(peekStewardOAuthState()).toBe("state-1");
  });
});

describe("steward-oauth-pkce", () => {
  it("createStewardPkcePair challenge is the S256 hash of its verifier", async () => {
    const { verifier, challenge } = await createStewardPkcePair();
    expect(await createStewardPkceChallenge(verifier)).toBe(challenge);
  });

  it("buildStewardOAuthAuthorizeUrl includes PKCE params when challenge provided", () => {
    const url = buildStewardOAuthAuthorizeUrl(
      "google",
      "https://os.elizaos.ai/checkout?sku=elizaos-usb",
      {
        stewardApiUrl: "https://api.elizacloud.ai/steward",
        codeChallenge: "challenge-abc",
      },
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/steward/auth/oauth/google/authorize");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge-abc");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "https://os.elizaos.ai/checkout?sku=elizaos-usb",
    );
  });

  it("buildStewardOAuthAuthorizeUrl omits PKCE params without a challenge", () => {
    const url = buildStewardOAuthAuthorizeUrl(
      "github",
      "https://www.elizacloud.ai/login",
      { stewardApiUrl: "https://api.elizacloud.ai/steward" },
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.has("code_challenge")).toBe(false);
    expect(parsed.searchParams.has("code_challenge_method")).toBe(false);
  });

  it("buildStewardOAuthAuthorizeUrl supports Steward's Apple OAuth provider", () => {
    const url = new URL(
      buildStewardOAuthAuthorizeUrl("apple", "https://eliza.app/login", {
        stewardApiUrl: "https://api.eliza.app/steward",
        codeChallenge: "apple-challenge",
        state: "apple-state",
      }),
    );

    expect(url.pathname).toBe("/steward/auth/oauth/apple/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://eliza.app/login",
    );
    expect(url.searchParams.get("code_challenge")).toBe("apple-challenge");
    expect(url.searchParams.get("state")).toBe("apple-state");
  });

  it("buildStewardOAuthAuthorizeUrl carries state only when provided", () => {
    const withState = new URL(
      buildStewardOAuthAuthorizeUrl("google", "https://eliza.app/login", {
        stewardApiUrl: "https://api.elizacloud.ai/steward",
        codeChallenge: "challenge-abc",
        state: "state-123",
      }),
    );
    expect(withState.searchParams.get("state")).toBe("state-123");

    const withoutState = new URL(
      buildStewardOAuthAuthorizeUrl("google", "https://eliza.app/login", {
        stewardApiUrl: "https://api.elizacloud.ai/steward",
        codeChallenge: "challenge-abc",
      }),
    );
    expect(withoutState.searchParams.has("state")).toBe(false);
  });

  it("generateStewardOAuthState is URL-safe, high-entropy, and unique", () => {
    const first = generateStewardOAuthState();
    const second = generateStewardOAuthState();
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 random bytes → 43 base64url chars (no padding).
    expect(first).toHaveLength(43);
    expect(first).not.toBe(second);
  });

  it("stores state beside the verifier and peeks it without consuming", () => {
    expect(storeStewardPkceVerifier("verifier-1", "state-1")).toBe(true);
    expect(peekStewardOAuthState()).toBe("state-1");
    // Peek is non-consuming: a second read still sees the value.
    expect(peekStewardOAuthState()).toBe("state-1");
  });

  it("peekStewardOAuthState is null for a legacy state-less blob", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ verifier: "v", expiresAt: Date.now() + 60_000 }),
    );
    expect(peekStewardOAuthState()).toBeNull();
  });

  it("peeks state and consumes the verifier from local storage when session storage is unavailable", () => {
    const previousWindow = globalThis.window;
    const stored = JSON.stringify({
      verifier: "local-verifier",
      state: "local-state",
      expiresAt: Date.now() + 60_000,
    });
    let removed = false;
    const localStorage = {
      getItem: () => (removed ? null : stored),
      removeItem: () => {
        removed = true;
      },
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: Object.create(null),
    });
    Object.defineProperty(globalThis.window, "sessionStorage", {
      configurable: true,
      get() {
        throw new DOMException("Access denied", "SecurityError");
      },
    });
    Object.defineProperty(globalThis.window, "localStorage", {
      configurable: true,
      value: localStorage,
    });

    try {
      expect(peekStewardOAuthState()).toBe("local-state");
      expect(removed).toBe(false);
      expect(consumeStewardPkceVerifier()).toBe("local-verifier");
      expect(removed).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: previousWindow,
      });
    }
  });
});
