/**
 * Verifies explicit Steward passkey authentication and enrollment boundaries
 * using the real client and SimpleWebAuthn implementation. HTTP and browser
 * credential boundaries are deterministic, but each ceremony executes all
 * SDK/browser-library code through navigator.credentials.
 */
// @vitest-environment jsdom

import { StewardApiError, StewardAuth } from "@stwd/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

function jsonResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function successResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function recordFetch(responses: Response[]) {
  let calls = 0;
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    requests.push({ input, init });
    const response = responses[calls];
    calls += 1;
    if (!response) throw new Error("Unexpected fetch call");
    return response;
  };
  return { fetch, callCount: () => calls, requests: () => requests };
}

function base64UrlJson(value: object): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function validSessionToken(userId = "user-1"): string {
  return `${base64UrlJson({ alg: "none", typ: "JWT" })}.${base64UrlJson({
    exp: Math.floor(Date.now() / 1000) + 3600,
    userId,
    email: "person@example.com",
  })}.test-signature`;
}

function memoryStorage(token?: string) {
  const values = new Map<string, string>();
  if (token) values.set("steward_session_token", token);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function installWebAuthnCredentialContainer(credentials: object): void {
  const testNavigator = Object.create(window.navigator) as Navigator;
  Object.defineProperty(testNavigator, "credentials", {
    configurable: true,
    value: credentials,
  });
  vi.stubGlobal("navigator", testNavigator);
  vi.stubGlobal("PublicKeyCredential", class PublicKeyCredential {});
}

function credentialBuffer(): ArrayBuffer {
  return Uint8Array.of(1, 2, 3, 4).buffer;
}

function authSuccess(token = validSessionToken()) {
  return {
    token,
    refreshToken: "refresh-token",
    expiresIn: 900,
    user: { id: "user-1", email: "person@example.com" },
  };
}

describe("StewardAuth passkey ceremony boundaries", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("runs WebAuthn for constant-shaped options without starting registration", async () => {
    const get = vi.fn(async () => {
      throw new DOMException("No matching credential", "NotAllowedError");
    });
    installWebAuthnCredentialContainer({ get });
    const recorder = recordFetch([
      successResponse({
        challenge: "AQIDBA",
        challengeId: "login-challenge-id",
        rpId: "example.test",
        allowCredentials: [],
        userVerification: "required",
      }),
    ]);
    vi.stubGlobal("fetch", recorder.fetch);
    const auth = new StewardAuth({ baseUrl: "https://api.example.test" });

    const error = await auth
      .signInWithPasskey("person@example.com", {
        fallbackToRegistration: false,
      })
      .catch((cause: unknown) => cause);

    expect(recorder.callCount()).toBe(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(StewardApiError);
    expect(error).toMatchObject({
      status: 0,
      message: expect.stringContaining("No matching credential"),
    });
    expect(String(recorder.requests()[0]?.input)).toBe(
      "https://api.example.test/auth/passkey/login/options",
    );
  });

  it("does not reinterpret non-404 login failures", async () => {
    const recorder = recordFetch([
      jsonResponse(500, "Passkey service unavailable"),
    ]);
    vi.stubGlobal("fetch", recorder.fetch);
    const auth = new StewardAuth({ baseUrl: "https://api.example.test" });

    await expect(
      auth.signInWithPasskey("person@example.com", {
        fallbackToRegistration: false,
      }),
    ).rejects.toMatchObject({
      status: 500,
      message: "Passkey service unavailable",
    });
    expect(recorder.callCount()).toBe(1);
  });

  it("reaches navigator.credentials.create through the real registration stack", async () => {
    const registrationOptions = {
      challenge: "AQIDBA",
      rp: { id: "example.test", name: "Example" },
      user: {
        id: "BQYHCA",
        name: "person@example.com",
        displayName: "Person",
      },
      pubKeyCredParams: [{ alg: -7, type: "public-key" }],
      timeout: 60_000,
    };
    const create = vi.fn(async (_options: CredentialCreationOptions) => ({
      id: "registration-credential",
      rawId: credentialBuffer(),
      response: {
        attestationObject: credentialBuffer(),
        clientDataJSON: credentialBuffer(),
        getTransports: () => ["internal"],
      },
      type: "public-key",
      authenticatorAttachment: "platform",
      getClientExtensionResults: () => ({}),
    }));
    installWebAuthnCredentialContainer({ create });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const recorder = recordFetch([
      successResponse(registrationOptions),
      successResponse(authSuccess()),
    ]);
    vi.stubGlobal("fetch", recorder.fetch);
    const auth = new StewardAuth({ baseUrl: "https://api.example.test" });

    await expect(
      auth.addPasskey("person@example.com", { emailGrant: "email-grant" }),
    ).resolves.toMatchObject({ token: expect.any(String) });

    expect(create).toHaveBeenCalledTimes(1);
    const createRequest = create.mock.calls[0]?.[0];
    expect(createRequest?.publicKey?.challenge).toBeInstanceOf(ArrayBuffer);
    expect(createRequest?.publicKey?.user.id).toBeInstanceOf(ArrayBuffer);
    expect(warn).not.toHaveBeenCalled();
    expect(recorder.callCount()).toBe(2);
    const optionsRequest = recorder.requests()[0];
    expect(String(optionsRequest?.input)).toBe(
      "https://api.example.test/auth/passkey/register/options",
    );
    expect(JSON.parse(String(optionsRequest?.init?.body))).toMatchObject({
      email: "person@example.com",
      emailGrant: "email-grant",
    });
    const verifyRequest = recorder.requests()[1];
    expect(String(verifyRequest?.input)).toBe(
      "https://api.example.test/auth/passkey/register/verify",
    );
    expect(JSON.parse(String(verifyRequest?.init?.body))).toMatchObject({
      email: "person@example.com",
      response: { id: "registration-credential", type: "public-key" },
    });
  });

  it("reaches navigator.credentials.get through the real MFA assertion stack", async () => {
    const mfaOptions = {
      challenge: "AQIDBA",
      challengeId: "mfa-challenge-id",
      rpId: "example.test",
      allowCredentials: [],
      userVerification: "required",
    };
    const get = vi.fn(async (_options: CredentialRequestOptions) => ({
      id: "mfa-credential",
      rawId: credentialBuffer(),
      response: {
        authenticatorData: credentialBuffer(),
        clientDataJSON: credentialBuffer(),
        signature: credentialBuffer(),
        userHandle: null,
      },
      type: "public-key",
      authenticatorAttachment: "platform",
      getClientExtensionResults: () => ({}),
    }));
    installWebAuthnCredentialContainer({ get });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const recorder = recordFetch([
      successResponse(mfaOptions),
      successResponse(authSuccess(validSessionToken("mfa-user"))),
    ]);
    vi.stubGlobal("fetch", recorder.fetch);
    const accessToken = validSessionToken();
    const auth = new StewardAuth({
      baseUrl: "https://api.example.test",
      storage: memoryStorage(accessToken),
    });

    await expect(auth.completePasskeyMfa()).resolves.toMatchObject({
      token: expect.any(String),
    });

    expect(get).toHaveBeenCalledTimes(1);
    const getRequest = get.mock.calls[0]?.[0];
    expect(getRequest?.publicKey?.challenge).toBeInstanceOf(ArrayBuffer);
    expect(getRequest?.publicKey?.allowCredentials).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(recorder.callCount()).toBe(2);
    const optionsHeaders = new Headers(recorder.requests()[0]?.init?.headers);
    expect(optionsHeaders.get("Authorization")).toBe(`Bearer ${accessToken}`);
    const completeRequest = recorder.requests()[1];
    expect(String(completeRequest?.input)).toBe(
      "https://api.example.test/auth/mfa/passkey/complete",
    );
    expect(JSON.parse(String(completeRequest?.init?.body))).toMatchObject({
      challengeId: "mfa-challenge-id",
      response: { id: "mfa-credential", type: "public-key" },
    });
  });
});
