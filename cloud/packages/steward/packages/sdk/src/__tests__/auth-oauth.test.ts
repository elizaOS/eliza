import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { _generateCodeChallenge, _generateCodeVerifier, StewardAuth } from "../auth";
import type { SessionStorage, StewardProviders } from "../auth-types";
import { StewardApiError } from "../client";

// ─── Fetch Mocking Helpers ────────────────────────────────────────────────

type FetchFn = typeof fetch;

let originalFetch: FetchFn;

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let lastCapture: CapturedRequest | null = null;

function installMockFetch(responseBody: object, status = 200): void {
  global.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => {
        headers[k] = v;
      });
    }
    lastCapture = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

// ─── In-Memory Storage ────────────────────────────────────────────────────

class TestStorage implements SessionStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

// ─── Test Setup ───────────────────────────────────────────────────────────

const BASE_URL = "https://api.steward.fi";

let storage: TestStorage;
let auth: StewardAuth;

beforeEach(() => {
  originalFetch = global.fetch;
  storage = new TestStorage();
  auth = new StewardAuth({ baseUrl: BASE_URL, storage });
  lastCapture = null;
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ─── PKCE Helpers ─────────────────────────────────────────────────────────

describe("PKCE helpers", () => {
  it("generateCodeVerifier returns a 43-char base64url string", async () => {
    const verifier = await _generateCodeVerifier();
    expect(verifier.length).toBe(43);
    // base64url charset: A-Z, a-z, 0-9, -, _
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
    // No padding
    expect(verifier).not.toContain("=");
  });

  it("generateCodeVerifier produces unique values", async () => {
    const a = await _generateCodeVerifier();
    const b = await _generateCodeVerifier();
    expect(a).not.toBe(b);
  });

  it("generateCodeChallenge produces a valid S256 challenge", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await _generateCodeChallenge(verifier);
    // Should be base64url encoded, no padding
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(challenge).not.toContain("=");
    // SHA-256 of 32 bytes = 32 bytes = 43 base64url chars
    expect(challenge.length).toBe(43);
  });

  it("generateCodeChallenge is deterministic for same input", async () => {
    const verifier = "test-verifier-12345";
    const a = await _generateCodeChallenge(verifier);
    const b = await _generateCodeChallenge(verifier);
    expect(a).toBe(b);
  });

  it("generateCodeChallenge differs for different inputs", async () => {
    const a = await _generateCodeChallenge("verifier-a");
    const b = await _generateCodeChallenge("verifier-b");
    expect(a).not.toBe(b);
  });
});

// ─── getProviders ─────────────────────────────────────────────────────────

describe("getProviders", () => {
  const mockProviders: StewardProviders = {
    passkey: true,
    email: true,
    siwe: true,
    siws: true,
    google: true,
    discord: false,
    github: false,
    oauth: ["google"],
  };

  it("fetches providers from /auth/providers", async () => {
    installMockFetch(mockProviders);
    const result = await auth.getProviders();

    expect(lastCapture).not.toBeNull();
    expect(lastCapture?.url).toBe(`${BASE_URL}/auth/providers`);
    expect(lastCapture?.method).toBe("GET");
    expect(result).toEqual(mockProviders);
  });

  it("caches the result for subsequent calls", async () => {
    installMockFetch(mockProviders);

    const first = await auth.getProviders();
    expect(first).toEqual(mockProviders);

    // Install a different mock to verify cache is used
    installMockFetch({
      passkey: false,
      email: false,
      siwe: false,
      siws: false,
      google: false,
      discord: false,
      github: false,
      oauth: [],
    });
    const second = await auth.getProviders();
    expect(second).toEqual(mockProviders); // still the cached result
  });

  it("forceRefresh bypasses cache", async () => {
    installMockFetch(mockProviders);
    await auth.getProviders();

    const updated: StewardProviders = {
      ...mockProviders,
      discord: true,
      github: true,
      oauth: ["google", "discord", "github"],
    };
    installMockFetch(updated);
    const result = await auth.getProviders(true);
    expect(result).toEqual(updated);
  });

  it("throws StewardApiError on failure", async () => {
    installMockFetch({ ok: false, error: "Internal server error" }, 500);
    try {
      await auth.getProviders();
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(StewardApiError);
      expect((err as StewardApiError).message).toBe("Internal server error");
    }
  });
});

// ─── handleOAuthCallback ──────────────────────────────────────────────────

describe("handleOAuthCallback", () => {
  // Helper: build a fake JWT for the mock response
  function fakeJwt(claims: Record<string, unknown> = {}): string {
    const header = btoa(JSON.stringify({ alg: "HS256" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const payload = btoa(
      JSON.stringify({
        address: "0x1234",
        tenantId: "t-test",
        userId: "user-1",
        email: "test@example.com",
        exp: Math.floor(Date.now() / 1000) + 900,
        ...claims,
      }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const sig = btoa("fakesig").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${header}.${payload}.${sig}`;
  }

  it("throws when no state is stored", async () => {
    try {
      await auth.handleOAuthCallback("google", { code: "abc", state: "xyz" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(StewardApiError);
      expect((err as StewardApiError).message).toContain("No OAuth state found");
    }
  });

  it("throws on state mismatch", async () => {
    storage.setItem("steward_oauth_state", "correct-state");
    storage.setItem("steward_oauth_verifier", "test-verifier");

    try {
      await auth.handleOAuthCallback("google", {
        code: "abc",
        state: "wrong-state",
      });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(StewardApiError);
      expect((err as StewardApiError).message).toContain("state mismatch");
    }
  });

  it("throws on error param", async () => {
    try {
      await auth.handleOAuthCallback("google", { error: "access_denied" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(StewardApiError);
      expect((err as StewardApiError).message).toContain("access_denied");
    }
  });

  it("throws on missing code", async () => {
    try {
      await auth.handleOAuthCallback("google", { state: "abc" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(StewardApiError);
      expect((err as StewardApiError).message).toContain("Missing code or state");
    }
  });

  it("exchanges code for session when state matches", async () => {
    const state = "test-state-123";
    const verifier = "test-verifier-456";
    storage.setItem("steward_oauth_state", state);
    storage.setItem("steward_oauth_verifier", verifier);

    const jwt = fakeJwt();
    installMockFetch({
      ok: true,
      token: jwt,
      refreshToken: "rt-123",
      expiresIn: 900,
      user: {
        id: "user-1",
        email: "test@example.com",
        walletAddress: "0x1234",
      },
    });

    const result = await auth.handleOAuthCallback("google", {
      code: "auth-code-789",
      state,
    });

    // Verify the token exchange request
    expect(lastCapture).not.toBeNull();
    expect(lastCapture?.url).toBe(`${BASE_URL}/auth/oauth/google/token`);
    expect(lastCapture?.method).toBe("POST");
    expect(lastCapture?.body).toEqual({
      code: "auth-code-789",
      redirectUri: "http://localhost/auth/callback", // non-browser fallback
      state,
      codeVerifier: verifier,
    });

    // Verify result
    expect(result.provider).toBe("google");
    expect(result.token).toBe(jwt);
    expect(result.refreshToken).toBe("rt-123");
    expect(result.user.email).toBe("test@example.com");

    // Verify PKCE state was cleaned up
    expect(storage.getItem("steward_oauth_state")).toBeNull();
    expect(storage.getItem("steward_oauth_verifier")).toBeNull();

    // Verify session was stored
    expect(auth.isAuthenticated()).toBe(true);
  });

  it("handles token exchange failure", async () => {
    const state = "test-state";
    storage.setItem("steward_oauth_state", state);
    storage.setItem("steward_oauth_verifier", "test-verifier");

    installMockFetch({ ok: false, error: "Token exchange failed" }, 502);

    try {
      await auth.handleOAuthCallback("google", { code: "bad-code", state });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(StewardApiError);
      expect((err as StewardApiError).message).toBe("Token exchange failed");
    }
  });
});

// ─── signInWithOAuth (non-browser) ────────────────────────────────────────

describe("signInWithOAuth", () => {
  it("throws in non-browser with authorization URL", async () => {
    try {
      await auth.signInWithOAuth("google");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(StewardApiError);
      const msg = (err as StewardApiError).message;
      expect(msg).toContain("OAuth popup flow requires a browser");
      expect(msg).toContain("/auth/oauth/google/authorize");
      expect(msg).toContain("code_challenge=");
      expect(msg).toContain("code_challenge_method=S256");
      expect(msg).toContain("state=");
    }
  });

  it("stores state and verifier before throwing in non-browser", async () => {
    try {
      await auth.signInWithOAuth("discord");
    } catch {
      // Expected
    }

    // State and verifier should be stored for potential redirect flow
    expect(storage.getItem("steward_oauth_state")).not.toBeNull();
    expect(storage.getItem("steward_oauth_verifier")).not.toBeNull();
  });
});
