import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { LoginAuth } from "../auth";
import { LoginApiError } from "../client";

// Captures each outbound request so assertions can verify the SDK hit the
// right Steward endpoints with the right bodies (Privy-style email-OTP +
// emailGrant passkey signup).
type Captured = {
  url: string;
  body?: Record<string, unknown>;
  redirect?: RequestRedirect;
};
let captured: Captured[];
let originalFetch: typeof fetch;
let originalWindow: unknown;

const REG_OPTIONS = {
  challenge: "abc",
  rp: { id: "elizacloud.ai", name: "Eliza Cloud" },
  user: { id: "u-1", name: "new@user.test", displayName: "new@user.test" },
};

const VERIFY_RESPONSE = {
  ok: true,
  token: "test-jwt",
  refreshToken: "test-refresh",
  user: { id: "u-1", email: "new@user.test" },
  expiresIn: 3600,
};

// Lets each test override the response for a given path.
let routes: Record<string, () => Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(): void {
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    captured.push({ url, body, redirect: init?.redirect });
    const path = url.replace("https://api.example.test", "");
    const handler = routes[path];
    if (handler) return handler();
    return jsonResponse({ ok: false, error: "unexpected" }, 500);
  }) as typeof fetch;
}

function installBrowserShim(): void {
  // @ts-expect-error — only present in browser
  originalWindow = globalThis.window;
  // @ts-expect-error — minimal shim so isBrowser() passes
  globalThis.window = { document: {} };
}
function restoreBrowserShim(): void {
  // @ts-expect-error — restore
  globalThis.window = originalWindow;
}

mock.module("@simplewebauthn/browser", () => ({
  startRegistration: async () => ({
    id: "credential-1",
    rawId: "credential-1",
    response: {
      clientDataJSON: "client-data",
      attestationObject: "attestation",
    },
    type: "public-key",
  }),
  startAuthentication: async () => ({
    id: "credential-login",
    rawId: "credential-login",
    response: {
      clientDataJSON: "client-data",
      authenticatorData: "authenticator-data",
      signature: "signature",
      userHandle: "u-1",
    },
    type: "public-key",
  }),
}));

beforeEach(() => {
  captured = [];
  originalFetch = global.fetch;
  routes = {
    "/auth/email/send": () =>
      jsonResponse({
        ok: true,
        data: {
          expiresAt: "2026-01-01T00:10:00Z",
          challengeId: "challenge-public",
          pollSecret: "poll-secret",
        },
      }),
    "/auth/email/code/verify": () => jsonResponse(VERIFY_RESPONSE),
    "/auth/email/status": () =>
      jsonResponse({ ok: true, data: { status: "pending" } }),
    "/auth/email/otp/send": () =>
      jsonResponse({ ok: true, data: { expiresAt: "2026-01-01T00:00:00Z" } }),
    "/auth/email/otp/verify": () =>
      jsonResponse({
        ok: true,
        data: { emailGrant: "grant-xyz", expiresInSeconds: 300 },
      }),
    "/auth/passkey/register/options": () => jsonResponse(REG_OPTIONS),
    "/auth/passkey/register/verify": () => jsonResponse(VERIFY_RESPONSE),
  };
  installFetch();
  installBrowserShim();
});

afterEach(() => {
  global.fetch = originalFetch;
  restoreBrowserShim();
});

describe("LoginAuth email magic-link companion code", () => {
  it("unwraps challenge polling fields from signInWithEmail", async () => {
    const auth = new LoginAuth({
      baseUrl: "https://api.example.test",
      tenantId: "elizacloud",
    });
    const res = await auth.signInWithEmail("new@user.test", "captcha-123");

    expect(captured[0]?.url).toBe("https://api.example.test/auth/email/send");
    expect(captured[0]?.body).toMatchObject({
      email: "new@user.test",
      tenantId: "elizacloud",
      captchaToken: "captcha-123",
    });
    expect(captured[0]?.redirect).toBe("error");
    expect(res).toMatchObject({
      ok: true,
      expiresAt: "2026-01-01T00:10:00Z",
      challengeId: "challenge-public",
      pollSecret: "poll-secret",
    });
  });

  it("verifies the login companion code against the additive endpoint", async () => {
    const auth = new LoginAuth({
      baseUrl: "https://api.example.test",
      tenantId: "elizacloud",
    });
    const res = await auth.verifyEmailSignInCode("new@user.test", "123456");

    expect(captured[0]?.url).toBe(
      "https://api.example.test/auth/email/code/verify",
    );
    expect(captured[0]?.body).toMatchObject({
      email: "new@user.test",
      code: "123456",
      tenantId: "elizacloud",
    });
    expect("token" in res || "mfaRequired" in res).toBe(true);
  });

  it("polls email sign-in status with challenge id and poll secret", async () => {
    const auth = new LoginAuth({
      baseUrl: "https://api.example.test",
      tenantId: "elizacloud",
    });
    const res = await auth.pollEmailSignInStatus(
      "challenge-public",
      "poll-secret",
    );

    expect(captured[0]?.url).toBe("https://api.example.test/auth/email/status");
    expect(captured[0]?.body).toMatchObject({
      challengeId: "challenge-public",
      pollSecret: "poll-secret",
      tenantId: "elizacloud",
    });
    expect(res).toMatchObject({ ok: true, status: "pending" });
  });
});

describe("LoginAuth.sendEmailOtp", () => {
  it("POSTs email (+ tenant) to /auth/email/otp/send", async () => {
    const auth = new LoginAuth({
      baseUrl: "https://api.example.test",
      tenantId: "elizacloud",
    });
    const res = await auth.sendEmailOtp("new@user.test");

    expect(captured[0]?.url).toBe(
      "https://api.example.test/auth/email/otp/send",
    );
    expect(captured[0]?.body?.email).toBe("new@user.test");
    expect(captured[0]?.body?.tenantId).toBe("elizacloud");
    expect(res.ok).toBe(true);
  });

  it("forwards an optional captchaToken", async () => {
    const auth = new LoginAuth({ baseUrl: "https://api.example.test" });
    await auth.sendEmailOtp("new@user.test", "captcha-123");
    expect(captured[0]?.body?.captchaToken).toBe("captcha-123");
  });

  it("throws LoginApiError on a rate-limited send", async () => {
    routes["/auth/email/otp/send"] = () =>
      jsonResponse(
        { ok: false, error: "Too many requests. Please try again later." },
        429,
      );
    const auth = new LoginAuth({ baseUrl: "https://api.example.test" });
    await expect(auth.sendEmailOtp("new@user.test")).rejects.toBeInstanceOf(
      LoginApiError,
    );
  });
});

describe("LoginAuth.verifyEmailOtp", () => {
  it("exchanges a code for an emailGrant", async () => {
    const auth = new LoginAuth({
      baseUrl: "https://api.example.test",
      tenantId: "elizacloud",
    });
    const res = await auth.verifyEmailOtp("new@user.test", "123456");

    expect(captured[0]?.url).toBe(
      "https://api.example.test/auth/email/otp/verify",
    );
    expect(captured[0]?.body?.email).toBe("new@user.test");
    expect(captured[0]?.body?.code).toBe("123456");
    expect(res.emailGrant).toBe("grant-xyz");
    expect(res.expiresInSeconds).toBe(300);
  });

  it("throws LoginApiError on a wrong/expired code", async () => {
    routes["/auth/email/otp/verify"] = () =>
      jsonResponse({ ok: false, error: "Invalid or expired code" }, 401);
    const auth = new LoginAuth({ baseUrl: "https://api.example.test" });
    await expect(
      auth.verifyEmailOtp("new@user.test", "000000"),
    ).rejects.toBeInstanceOf(LoginApiError);
  });
});

describe("LoginAuth.addPasskey with emailGrant (signed-out first-time signup)", () => {
  it("forwards the emailGrant on BOTH register/options and register/verify", async () => {
    const auth = new LoginAuth({
      baseUrl: "https://api.example.test",
      tenantId: "elizacloud",
    });
    const result = await auth.addPasskey("new@user.test", {
      emailGrant: "grant-xyz",
    });

    const paths = captured.map((c) =>
      c.url.replace("https://api.example.test", ""),
    );
    expect(paths).toEqual([
      "/auth/passkey/register/options",
      "/auth/passkey/register/verify",
    ]);

    // The grant must ride along on both calls — Steward peeks it on options
    // and consumes it on verify, in place of a session.
    expect(captured[0]?.body?.emailGrant).toBe("grant-xyz");
    expect(captured[1]?.body?.emailGrant).toBe("grant-xyz");
    expect(captured[0]?.body?.email).toBe("new@user.test");

    expect(result.token).toBe("test-jwt");
    expect(result.user?.email).toBe("new@user.test");
  });

  it("rejects a signed-out add-passkey when no emailGrant is supplied", async () => {
    const auth = new LoginAuth({ baseUrl: "https://api.example.test" });
    await expect(auth.addPasskey("existing@user.test")).rejects.toThrow(
      "Not authenticated. Sign in first or provide a verified-email grant.",
    );
    expect(captured).toEqual([]);
  });
});

describe("end-to-end Privy-style passkey signup", () => {
  it("send OTP → verify OTP → register passkey with the grant", async () => {
    const auth = new LoginAuth({
      baseUrl: "https://api.example.test",
      tenantId: "elizacloud",
    });

    await auth.sendEmailOtp("new@user.test");
    const { emailGrant } = await auth.verifyEmailOtp("new@user.test", "123456");
    const result = await auth.addPasskey("new@user.test", { emailGrant });

    const paths = captured.map((c) =>
      c.url.replace("https://api.example.test", ""),
    );
    expect(paths).toEqual([
      "/auth/email/otp/send",
      "/auth/email/otp/verify",
      "/auth/passkey/register/options",
      "/auth/passkey/register/verify",
    ]);
    expect(result.token).toBe("test-jwt");
  });
});
