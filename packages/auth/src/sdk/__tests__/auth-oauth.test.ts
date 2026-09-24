import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  _generateCodeChallenge,
  _generateCodeVerifier,
  _getOAuthCallbackParams,
  _isTrustedOAuthPopupMessage,
  LoginAuth,
} from "../auth";
import type { LoginProviders, SessionStorage } from "../auth-types";
import { LoginApiError } from "../client";

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

function installMockFetchSequence(
  responses: Array<{ body: object; status?: number }>,
  captures?: CapturedRequest[],
): void {
  let index = 0;
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
    captures?.push(lastCapture);
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
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

const BASE_URL = "http://localhost:3200";

let storage: TestStorage;
let auth: LoginAuth;

function fakeJwt(claims: Record<string, unknown> = {}): string {
  const header = btoa(JSON.stringify({ alg: "HS256" }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const payload = btoa(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + 900,
      ...claims,
    }),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${header}.${payload}.sig`;
}

beforeEach(() => {
  originalFetch = global.fetch;
  storage = new TestStorage();
  auth = new LoginAuth({ baseUrl: BASE_URL, storage });
  lastCapture = null;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("Test account helper", () => {
  it("does not persist refresh tokens to browser localStorage by default", async () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    const originalNavigator = (globalThis as { navigator?: unknown }).navigator;
    const localStore = new TestStorage();
    const fakeWindow = {
      document: {},
      localStorage: localStore,
      location: {
        host: "app.example.test",
        origin: "https://app.example.test",
      },
    };

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: fakeWindow,
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {},
    });

    try {
      const browserAuth = new LoginAuth({ baseUrl: BASE_URL });
      const jwt = fakeJwt({
        address: "0x1234",
        tenantId: "tenant-browser",
        userId: "user-browser",
      });
      installMockFetch({
        ok: true,
        token: jwt,
        refreshToken: "refresh-browser",
        expiresIn: 900,
        user: {
          id: "user-browser",
          email: "browser@example.test",
          walletAddress: "0x1234",
        },
      });

      await browserAuth.getTestAccessToken({
        tenantId: "tenant-browser",
        email: "browser@example.test",
        otp: "123456",
      });

      expect(browserAuth.isAuthenticated()).toBe(true);
      expect(localStore.getItem("steward_session_token")).toBeNull();
      expect(localStore.getItem("steward_refresh_token")).toBeNull();
    } finally {
      if (originalWindow === undefined) {
        Reflect.deleteProperty(globalThis, "window");
      } else {
        Object.defineProperty(globalThis, "window", {
          configurable: true,
          value: originalWindow,
        });
      }
      if (originalNavigator === undefined) {
        Reflect.deleteProperty(globalThis, "navigator");
      } else {
        Object.defineProperty(globalThis, "navigator", {
          configurable: true,
          value: originalNavigator,
        });
      }
    }
  });

  it("exchanges exact test account credentials for a session", async () => {
    const jwt = fakeJwt({
      address: "0x1234",
      tenantId: "tenant-test",
      userId: "user-test",
    });
    installMockFetch({
      ok: true,
      token: jwt,
      refreshToken: "refresh-test",
      expiresIn: 900,
      user: {
        id: "user-test",
        email: "test-123456@steward.test",
        walletAddress: "0x1234",
      },
    });

    const result = await auth.getTestAccessToken({
      tenantId: "tenant-test",
      email: "test-123456@steward.test",
      otp: "123456",
    });

    expect(lastCapture?.url).toBe(`${BASE_URL}/auth/test/token`);
    expect(lastCapture?.method).toBe("POST");
    expect(lastCapture?.body).toEqual({
      tenantId: "tenant-test",
      email: "test-123456@steward.test",
      otp: "123456",
    });
    expect(result.token).toBe(jwt);
    expect(storage.getItem("steward_session_token")).toBe(jwt);
  });
});

describe("Telegram login helper", () => {
  it("exchanges a Telegram Login Widget payload for a session", async () => {
    const jwt = fakeJwt({
      address: "0xtelegram-wallet",
      tenantId: "tenant-telegram",
      userId: "user-telegram",
    });
    const captures: CapturedRequest[] = [];
    installMockFetchSequence(
      [
        { body: { ok: true, challengeId: "telegram-challenge-1" } },
        {
          body: {
            ok: true,
            token: jwt,
            refreshToken: "refresh-telegram",
            expiresIn: 900,
            user: {
              id: "user-telegram",
              email: null,
              walletAddress: "0xtelegram-wallet",
            },
          },
        },
      ],
      captures,
    );

    const result = await auth.signInWithTelegram(
      {
        id: 424242,
        first_name: "Ada",
        username: "ada",
        auth_date: 1_778_200_000,
        hash: "a".repeat(64),
      },
      { tenantId: "tenant-telegram" },
    );

    expect(captures[0]?.url).toBe(`${BASE_URL}/auth/telegram/challenge`);
    expect(captures[0]?.body).toEqual({ tenantId: "tenant-telegram" });
    expect(lastCapture?.url).toBe(`${BASE_URL}/auth/telegram/verify`);
    expect(lastCapture?.method).toBe("POST");
    expect(lastCapture?.body).toEqual({
      id: 424242,
      first_name: "Ada",
      username: "ada",
      auth_date: 1_778_200_000,
      hash: "a".repeat(64),
      challengeId: "telegram-challenge-1",
      tenantId: "tenant-telegram",
    });
    expect(result.token).toBe(jwt);
    expect(result.user.email).toBe("");
    expect(result.user.walletAddress).toBe("0xtelegram-wallet");
    expect(storage.getItem("steward_session_token")).toBe(jwt);
    expect(storage.getItem("steward_refresh_token")).toBe("refresh-telegram");
  });

  it("uses the auth instance tenant when no Telegram tenant override is supplied", async () => {
    auth = new LoginAuth({
      baseUrl: BASE_URL,
      storage,
      tenantId: "tenant-default",
    });
    installMockFetchSequence([
      { body: { ok: true, challengeId: "telegram-challenge-2" } },
      {
        body: {
          ok: true,
          token: fakeJwt({
            tenantId: "tenant-default",
            userId: "user-default",
          }),
          refreshToken: "refresh-default",
          expiresIn: 900,
          user: { id: "user-default", email: "" },
        },
      },
    ]);

    await auth.signInWithTelegram({
      id: "424242",
      auth_date: "1778200000",
      hash: "b".repeat(64),
    });

    expect((lastCapture?.body as { tenantId?: string })?.tenantId).toBe(
      "tenant-default",
    );
  });
});

describe("Farcaster login helper", () => {
  it("exchanges a Farcaster SIWF payload for a session", async () => {
    const jwt = fakeJwt({
      address: "0xfarcaster-wallet",
      tenantId: "tenant-farcaster",
      userId: "user-farcaster",
    });
    installMockFetch({
      ok: true,
      token: jwt,
      refreshToken: "refresh-farcaster",
      expiresIn: 900,
      user: {
        id: "user-farcaster",
        email: null,
        walletAddress: "0xfarcaster-wallet",
      },
    });

    const result = await auth.signInWithFarcaster(
      {
        message: "siwf-message",
        signature: `0x${"a".repeat(130)}`,
        custodyAddress: "0x0000000000000000000000000000000000000001",
        fid: "4242",
        username: "alice",
      },
      { tenantId: "tenant-farcaster" },
    );

    expect(lastCapture?.url).toBe(`${BASE_URL}/auth/farcaster/verify`);
    expect(lastCapture?.method).toBe("POST");
    expect(lastCapture?.body).toEqual({
      message: "siwf-message",
      signature: `0x${"a".repeat(130)}`,
      custodyAddress: "0x0000000000000000000000000000000000000001",
      fid: "4242",
      username: "alice",
      tenantId: "tenant-farcaster",
    });
    expect(result.token).toBe(jwt);
    expect(result.user.email).toBe("");
    expect(storage.getItem("steward_refresh_token")).toBe("refresh-farcaster");
  });
});

describe("WhatsApp OTP helpers", () => {
  it("sends and verifies WhatsApp OTPs through dedicated routes", async () => {
    installMockFetch({ ok: true, expiresAt: "2026-05-25T12:00:00.000Z" });
    const send = await auth.sendWhatsAppOtp("+14155550123");

    expect(send.expiresAt).toBe("2026-05-25T12:00:00.000Z");
    expect(lastCapture?.url).toBe(`${BASE_URL}/auth/whatsapp/send`);
    expect(lastCapture?.body).toEqual({ phone: "+14155550123" });

    const jwt = fakeJwt({
      tenantId: "tenant-whatsapp",
      userId: "user-whatsapp",
    });
    installMockFetch({
      ok: true,
      token: jwt,
      refreshToken: "refresh-whatsapp",
      expiresIn: 900,
      user: { id: "user-whatsapp", email: "", walletAddress: "phone:hash" },
    });

    const result = await auth.verifyWhatsAppOtp("+14155550123", "123456");

    expect(lastCapture?.url).toBe(`${BASE_URL}/auth/whatsapp/verify`);
    expect(lastCapture?.body).toEqual({
      phone: "+14155550123",
      code: "123456",
    });
    expect(result.token).toBe(jwt);
    expect(storage.getItem("steward_refresh_token")).toBe("refresh-whatsapp");
  });

  it("includes tenant and captcha inputs for WhatsApp OTP sends", async () => {
    auth = new LoginAuth({
      baseUrl: BASE_URL,
      storage,
      tenantId: "tenant-default",
    });
    installMockFetch({ ok: true, expiresAt: "2026-05-25T12:00:00.000Z" });

    await auth.sendWhatsAppOtp("+14155550123", "captcha-token");

    expect(lastCapture?.body).toEqual({
      phone: "+14155550123",
      captchaToken: "captcha-token",
      tenantId: "tenant-default",
    });
  });
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
  const mockProviders: LoginProviders = {
    passkey: true,
    email: true,
    siwe: true,
    siws: true,
    google: true,
    discord: false,
    github: false,
    twitter: false,
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
      twitter: false,
      oauth: [],
    });
    const second = await auth.getProviders();
    expect(second).toEqual(mockProviders); // still the cached result
  });

  it("forceRefresh bypasses cache", async () => {
    installMockFetch(mockProviders);
    await auth.getProviders();

    const updated: LoginProviders = {
      ...mockProviders,
      discord: true,
      github: true,
      oauth: ["google", "discord", "github"],
    };
    installMockFetch(updated);
    const result = await auth.getProviders(true);
    expect(result).toEqual(updated);
  });

  it("passes through OIDC/JWT provider metadata", async () => {
    const updated: LoginProviders = {
      ...mockProviders,
      jwt: true,
      oidc: ["auth0", "workos"],
    };
    installMockFetch(updated);

    const result = await auth.getProviders(true);

    expect(result.jwt).toBe(true);
    expect(result.oidc).toEqual(["auth0", "workos"]);
  });

  it("throws LoginApiError on failure", async () => {
    installMockFetch({ ok: false, error: "Internal server error" }, 500);
    try {
      await auth.getProviders();
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(LoginApiError);
      expect((err as LoginApiError).message).toBe("Internal server error");
    }
  });
});

// ─── signInWithJwt ─────────────────────────────────────────────────────────

describe("signInWithJwt", () => {
  function fakeJwt(claims: Record<string, unknown> = {}): string {
    const header = btoa(JSON.stringify({ alg: "HS256" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const payload = btoa(
      JSON.stringify({
        address: "0x1234",
        tenantId: "tenant-oidc",
        userId: "user-oidc",
        exp: Math.floor(Date.now() / 1000) + 900,
        ...claims,
      }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return `${header}.${payload}.sig`;
  }

  it("exchanges a BYO JWT for a Steward session", async () => {
    const accessToken = fakeJwt();
    installMockFetch({
      ok: true,
      token: accessToken,
      refreshToken: "refresh-oidc",
      expiresIn: 900,
      user: {
        id: "user-oidc",
        email: "oidc@example.com",
        walletAddress: "0x1234",
        walletChain: "ethereum",
      },
    });

    const result = await auth.signInWithJwt("external.jwt", {
      tenantId: "tenant-oidc",
      providerId: "auth0",
    });

    expect(lastCapture?.url).toBe(`${BASE_URL}/auth/jwt/login`);
    expect(lastCapture?.method).toBe("POST");
    expect(lastCapture?.body).toEqual({
      tenantId: "tenant-oidc",
      providerId: "auth0",
      token: "external.jwt",
    });
    expect(result.user).toEqual({
      id: "user-oidc",
      email: "oidc@example.com",
      walletAddress: "0x1234",
      walletChain: "ethereum",
    });
    expect(storage.getItem("steward_session_token")).toBe(accessToken);
    expect(storage.getItem("steward_refresh_token")).toBe("refresh-oidc");
  });

  it("requires a tenant id", async () => {
    try {
      await auth.signInWithJwt("external.jwt", { tenantId: "" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(LoginApiError);
      expect((err as LoginApiError).message).toBe(
        "tenantId is required for JWT login",
      );
    }
  });
});

// ─── MFA Recovery Codes ────────────────────────────────────────────────────

describe("MFA recovery code helpers", () => {
  function fakeJwt(claims: Record<string, unknown> = {}): string {
    const header = btoa(JSON.stringify({ alg: "HS256" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const payload = btoa(
      JSON.stringify({
        address: "0x1234",
        tenantId: "tenant-mfa",
        userId: "user-mfa",
        exp: Math.floor(Date.now() / 1000) + 900,
        ...claims,
      }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return `${header}.${payload}.sig`;
  }

  it("completes MFA challenges with TOTP or recovery codes", async () => {
    const accessToken = fakeJwt({ mfaVerifiedAt: Date.now() });
    installMockFetch({
      ok: true,
      token: accessToken,
      refreshToken: "refresh-mfa",
      expiresIn: 900,
      user: { id: "user-mfa", walletAddress: "0x1234" },
    });

    await auth.completeTotpMfa("challenge-1", "123456");
    expect(lastCapture?.url).toBe(`${BASE_URL}/auth/mfa/totp/complete`);
    expect(lastCapture?.method).toBe("POST");
    expect(lastCapture?.body).toEqual({
      challengeId: "challenge-1",
      code: "123456",
    });

    installMockFetch({
      ok: true,
      token: accessToken,
      refreshToken: "refresh-mfa-2",
      expiresIn: 900,
      user: { id: "user-mfa", walletAddress: "0x1234" },
    });
    await auth.completeRecoveryCodeMfa("challenge-2", "ABCDE-FGHJK");
    expect(lastCapture?.body).toEqual({
      challengeId: "challenge-2",
      recoveryCode: "ABCDE-FGHJK",
    });

    installMockFetch({
      ok: true,
      token: accessToken,
      refreshToken: "refresh-mfa-3",
      expiresIn: 900,
      user: { id: "user-mfa", walletAddress: "0x1234" },
    });
    await auth.completeSmsMfa("challenge-3", "222333");
    expect(lastCapture?.url).toBe(`${BASE_URL}/auth/mfa/sms/complete`);
    expect(lastCapture?.body).toEqual({
      challengeId: "challenge-3",
      code: "222333",
    });
  });

  it("gets and regenerates recovery codes with bearer auth", async () => {
    storage.setItem("steward_session_token", fakeJwt());

    installMockFetch({ ok: true, enabled: true, remaining: 7 });
    const status = await auth.getRecoveryCodeStatus();
    expect(lastCapture?.url).toBe(`${BASE_URL}/auth/mfa/recovery-codes/status`);
    expect(lastCapture?.headers.authorization).toBe(
      `Bearer ${storage.getItem("steward_session_token")}`,
    );
    expect(status.remaining).toBe(7);

    installMockFetch({ ok: true, recoveryCodes: ["ABCDE-FGHJK"] });
    const regenerated = await auth.regenerateRecoveryCodes("654321");
    expect(lastCapture?.url).toBe(
      `${BASE_URL}/auth/mfa/recovery-codes/regenerate`,
    );
    expect(lastCapture?.method).toBe("POST");
    expect(lastCapture?.body).toEqual({ code: "654321" });
    expect(regenerated.recoveryCodes).toEqual(["ABCDE-FGHJK"]);
  });

  it("manages SMS MFA enrollment helpers with bearer auth", async () => {
    storage.setItem("steward_session_token", fakeJwt());

    installMockFetch({ ok: true, enabled: false, pending: false });
    const status = await auth.getSmsMfaStatus();
    expect(lastCapture?.url).toBe(`${BASE_URL}/auth/mfa/sms/status`);
    expect(lastCapture?.headers.authorization).toBe(
      `Bearer ${storage.getItem("steward_session_token")}`,
    );
    expect(status.enabled).toBe(false);

    installMockFetch({
      ok: true,
      phone: "***0123",
      expiresAt: "2026-05-25T12:00:00.000Z",
    });
    const enroll = await auth.enrollSmsMfa("+14155550123");
    expect(lastCapture?.url).toBe(`${BASE_URL}/auth/mfa/sms/enroll`);
    expect(lastCapture?.method).toBe("POST");
    expect(lastCapture?.body).toEqual({ phone: "+14155550123" });
    expect(enroll.phone).toBe("***0123");

    installMockFetch({ ok: true, enabled: true, phone: "***0123" });
    const verified = await auth.verifySmsMfa("123456");
    expect(lastCapture?.url).toBe(`${BASE_URL}/auth/mfa/sms/verify`);
    expect(lastCapture?.body).toEqual({ code: "123456" });
    expect(verified.enabled).toBe(true);

    installMockFetch({
      ok: true,
      phone: "***0123",
      expiresAt: "2026-05-25T12:05:00.000Z",
    });
    await auth.sendSmsMfaCode();
    expect(lastCapture?.url).toBe(`${BASE_URL}/auth/mfa/sms/send`);
    expect(lastCapture?.method).toBe("POST");

    installMockFetch({ ok: true });
    await auth.unenrollSmsMfa("654321");
    expect(lastCapture?.url).toBe(`${BASE_URL}/auth/mfa/sms/unenroll`);
    expect(lastCapture?.body).toEqual({ code: "654321" });
  });

  it("returns MFA-required SMS verification without storing an empty session", async () => {
    installMockFetch({
      ok: true,
      mfaRequired: true,
      mfa: {
        type: "totp",
        challengeId: "challenge-sms",
        expiresAt: "2026-05-25T12:00:00.000Z",
      },
      user: { id: "user-mfa", email: "", walletAddress: "phone:hash" },
    });

    const result = await auth.verifySmsOtp("+14155550123", "123456");

    expect(lastCapture?.url).toBe(`${BASE_URL}/auth/sms/verify`);
    expect(result).toMatchObject({
      mfaRequired: true,
      mfa: { challengeId: "challenge-sms" },
    });
    expect(storage.getItem("steward_session_token")).toBeNull();
    expect(storage.getItem("steward_refresh_token")).toBeNull();
  });

  it("returns MFA-required JWT and OAuth callbacks without storing an empty session", async () => {
    installMockFetch({
      ok: true,
      mfaRequired: true,
      mfa: {
        type: "sms",
        challengeId: "challenge-jwt",
        expiresAt: "2026-05-25T12:00:00.000Z",
      },
      user: {
        id: "user-mfa",
        email: "mfa@example.com",
        walletAddress: "0x1234",
      },
    });

    const jwtResult = await auth.signInWithJwt("external.jwt", {
      tenantId: "tenant-mfa",
      providerId: "auth0",
    });
    expect(jwtResult).toMatchObject({
      mfaRequired: true,
      mfa: { type: "sms", challengeId: "challenge-jwt" },
    });
    expect(storage.getItem("steward_session_token")).toBeNull();

    storage.setItem("steward_oauth_state", "state-1");
    storage.setItem("steward_oauth_verifier", "verifier-1");
    installMockFetch({
      ok: true,
      mfaRequired: true,
      mfa: {
        type: "totp",
        challengeId: "challenge-oauth",
        expiresAt: "2026-05-25T12:00:00.000Z",
      },
      user: {
        id: "user-mfa",
        email: "mfa@example.com",
        walletAddress: "0x1234",
      },
    });

    const oauthResult = await auth.handleOAuthCallback("google", {
      code: "code-1",
      state: "state-1",
    });
    expect(oauthResult).toMatchObject({
      mfaRequired: true,
      mfa: { type: "totp", challengeId: "challenge-oauth" },
    });
    expect(storage.getItem("steward_session_token")).toBeNull();
  });
});

describe("identity token helper", () => {
  function fakeJwt(): string {
    const header = btoa(JSON.stringify({ alg: "HS256" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const payload = btoa(
      JSON.stringify({
        address: "0x1234",
        tenantId: "tenant-id",
        userId: "user-id",
        exp: Math.floor(Date.now() / 1000) + 900,
      }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return `${header}.${payload}.sig`;
  }

  it("fetches an identity token with bearer auth", async () => {
    storage.setItem("steward_session_token", fakeJwt());
    installMockFetch({
      ok: true,
      token: "identity.jwt",
      expiresIn: 900,
      claims: {
        sub: "user-id",
        userId: "user-id",
        tenantId: "tenant-id",
        email: "u@example.com",
        emailVerified: true,
        name: null,
        image: null,
        walletAddress: "0x1234",
        walletChain: "ethereum",
        customMetadata: {},
        tenantIds: ["tenant-id"],
        linkedAccounts: [
          {
            id: "acct-1",
            provider: "github",
            providerAccountId: "gh-1",
            expiresAt: null,
          },
        ],
      },
      user: {
        id: "user-id",
        email: "u@example.com",
        walletAddress: "0x1234",
        linkedAccounts: [
          {
            id: "acct-1",
            provider: "github",
            providerAccountId: "gh-1",
            expiresAt: null,
          },
        ],
      },
    });

    const result = await auth.getIdentityToken();

    expect(lastCapture?.url).toBe(`${BASE_URL}/auth/identity-token`);
    expect(lastCapture?.headers.authorization).toBe(
      `Bearer ${storage.getItem("steward_session_token")}`,
    );
    expect(result.token).toBe("identity.jwt");
    expect(result.claims.linkedAccounts[0]?.provider).toBe("github");
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
    const sig = btoa("fakesig")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return `${header}.${payload}.${sig}`;
  }

  it("throws when no state is stored", async () => {
    try {
      await auth.handleOAuthCallback("google", { code: "abc", state: "xyz" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(LoginApiError);
      expect((err as LoginApiError).message).toContain("No OAuth state found");
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
      expect(err).toBeInstanceOf(LoginApiError);
      expect((err as LoginApiError).message).toContain("state mismatch");
    }
  });

  it("throws on error param", async () => {
    try {
      await auth.handleOAuthCallback("google", { error: "access_denied" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(LoginApiError);
      expect((err as LoginApiError).message).toContain("access_denied");
    }
  });

  it("throws on missing code", async () => {
    try {
      await auth.handleOAuthCallback("google", { state: "abc" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(LoginApiError);
      expect((err as LoginApiError).message).toContain("Missing code or state");
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

  it("extracts OAuth callback params from URL fragments", () => {
    const params = _getOAuthCallbackParams(
      new URL(
        "https://app.example/auth/callback#code=frag-code&state=frag-state",
      ),
    );
    expect(params).toEqual({
      code: "frag-code",
      state: "frag-state",
      error: undefined,
    });
  });

  it("includes stored tenant id when exchanging a redirect callback", async () => {
    const state = "tenant-state";
    const verifier = "tenant-verifier";
    storage.setItem("steward_oauth_state", state);
    storage.setItem("steward_oauth_verifier", verifier);
    storage.setItem("steward_oauth_tenant", "tenant-1");

    installMockFetch({
      ok: true,
      token: fakeJwt({ tenantId: "tenant-1" }),
      refreshToken: "rt-tenant",
      expiresIn: 900,
      user: {
        id: "user-1",
        email: "test@example.com",
        walletAddress: "0x1234",
      },
    });

    await auth.handleOAuthCallback("google", {
      code: "tenant-code",
      state,
    });

    expect(lastCapture?.body).toEqual({
      code: "tenant-code",
      redirectUri: "http://localhost/auth/callback",
      state,
      codeVerifier: verifier,
      tenantId: "tenant-1",
    });
    expect(storage.getItem("steward_oauth_tenant")).toBeNull();
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
      expect(err).toBeInstanceOf(LoginApiError);
      expect((err as LoginApiError).message).toBe("Token exchange failed");
    }
  });
});

describe("OAuth popup message binding", () => {
  it("accepts messages only from the exact popup and expected origin", () => {
    const popup = {} as Window;
    const unrelatedWindow = {} as Window;

    expect(
      _isTrustedOAuthPopupMessage(
        { origin: "https://app.example", source: popup },
        popup,
        "https://app.example",
      ),
    ).toBe(true);
    expect(
      _isTrustedOAuthPopupMessage(
        { origin: "https://app.example", source: unrelatedWindow },
        popup,
        "https://app.example",
      ),
    ).toBe(false);
    expect(
      _isTrustedOAuthPopupMessage(
        { origin: "https://evil.example", source: popup },
        popup,
        "https://app.example",
      ),
    ).toBe(false);
  });
});

// ─── signInWithOAuth (non-browser) ────────────────────────────────────────

describe("signInWithOAuth", () => {
  it("throws in non-browser with authorization URL", async () => {
    try {
      await auth.signInWithOAuth("google");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(LoginApiError);
      const msg = (err as LoginApiError).message;
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
