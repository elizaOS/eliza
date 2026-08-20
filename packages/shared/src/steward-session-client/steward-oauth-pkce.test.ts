/**
 * Unit coverage for the Steward OAuth PKCE helpers (`steward-oauth-pkce.ts`):
 * verifies the S256 code challenge derives from its verifier, that
 * `buildStewardOAuthAuthorizeUrl` includes the PKCE query params (code_challenge +
 * S256 method) when a challenge is supplied and omits them when it is not, and
 * that the OAuth `state` is carried in the authorize URL, stored beside the
 * verifier, and peekable without consuming it.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  buildStewardOAuthAuthorizeUrl,
  consumeStewardPkceVerifier,
  createStewardPkceChallenge,
  createStewardPkcePair,
  generateStewardOAuthState,
  peekStewardOAuthState,
  storeStewardPkceVerifier,
} from "./steward-oauth-pkce.js";

const STORAGE_KEY = "steward.oauth.pkce.verifier";
const COOKIE_KEY = "steward_oauth_pkce_verifier";

afterEach(() => {
  window.sessionStorage.removeItem(STORAGE_KEY);
  window.localStorage.removeItem(STORAGE_KEY);
  // biome-ignore lint/suspicious/noDocumentCookie: deterministic cleanup for the cookie-fallback test
  document.cookie = `${COOKIE_KEY}=; Path=/; Max-Age=0`;
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

  it("falls back to a short-lived same-site cookie when Web Storage is unavailable", () => {
    const previousWindow = globalThis.window;
    const restrictedWindow = Object.create(previousWindow) as Window;
    Object.defineProperty(restrictedWindow, "sessionStorage", {
      configurable: true,
      get() {
        throw new DOMException("Access denied", "SecurityError");
      },
    });
    Object.defineProperty(restrictedWindow, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Access denied", "SecurityError");
      },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: restrictedWindow,
    });

    try {
      expect(storeStewardPkceVerifier("cookie-verifier", "cookie-state")).toBe(
        true,
      );
      expect(document.cookie).toContain(`${COOKIE_KEY}=`);
      expect(peekStewardOAuthState()).toBe("cookie-state");
      expect(consumeStewardPkceVerifier()).toBe("cookie-verifier");
      expect(document.cookie).not.toContain(`${COOKIE_KEY}=`);
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: previousWindow,
      });
    }
  });
});
