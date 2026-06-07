import { describe, expect, it, vi } from "vitest";
import {
  APP_AUTH_CODE_PREFIX,
  buildAppAuthorizeUrl,
  ElizaCloudAppAuth,
  ElizaCloudAuthError,
  exchangeAppAuthorizeCode,
  looksLikeAppAuthCode,
  parseAppAuthorizeCallback,
} from "./index.js";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const REDIRECT = "https://nubilio.app/auth/callback";
const CODE = `${APP_AUTH_CODE_PREFIX}abcdef123456`;

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Cast a narrow fetch mock to the full `typeof fetch` the SDK expects. */
const asFetch = (fn: FetchFn): typeof fetch => fn as unknown as typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch mock that always returns `body` with `status`. */
function fetchReturning(body: unknown, status = 200) {
  return vi.fn<FetchFn>(async () => jsonResponse(body, status));
}

/** Read the headers object the mock was first called with. */
function headersOf(
  mock: ReturnType<typeof fetchReturning>,
): Record<string, string> {
  const init: RequestInit = mock.mock.calls[0][1] ?? {};
  return (init.headers ?? {}) as Record<string, string>;
}

describe("buildAppAuthorizeUrl", () => {
  it("builds the consent URL with app_id, redirect_uri, state", () => {
    const url = new URL(
      buildAppAuthorizeUrl({
        appId: APP_ID,
        redirectUri: REDIRECT,
        state: "xyz",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://www.elizacloud.ai/app-auth/authorize",
    );
    expect(url.searchParams.get("app_id")).toBe(APP_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toBe("xyz");
  });

  it("omits state when not provided and honors a custom baseUrl", () => {
    const url = new URL(
      buildAppAuthorizeUrl({
        appId: APP_ID,
        redirectUri: REDIRECT,
        baseUrl: "https://staging.elizacloud.ai/",
      }),
    );
    expect(url.host).toBe("staging.elizacloud.ai");
    expect(url.searchParams.has("state")).toBe(false);
  });

  it("throws when appId or redirectUri is missing", () => {
    expect(() =>
      buildAppAuthorizeUrl({ appId: "", redirectUri: REDIRECT }),
    ).toThrow();
    expect(() =>
      buildAppAuthorizeUrl({ appId: APP_ID, redirectUri: "" }),
    ).toThrow();
  });
});

describe("looksLikeAppAuthCode", () => {
  it("accepts eac_ codes and rejects everything else", () => {
    expect(looksLikeAppAuthCode(CODE)).toBe(true);
    expect(looksLikeAppAuthCode("nope")).toBe(false);
    expect(looksLikeAppAuthCode(null)).toBe(false);
    expect(looksLikeAppAuthCode(undefined)).toBe(false);
  });
});

describe("parseAppAuthorizeCallback", () => {
  it("parses a success callback from a full URL string", () => {
    const cb = parseAppAuthorizeCallback(`${REDIRECT}?code=${CODE}&state=xyz`);
    expect(cb).toEqual({
      code: CODE,
      state: "xyz",
      error: null,
      errorDescription: null,
    });
  });

  it("parses a denial callback", () => {
    const cb = parseAppAuthorizeCallback(
      `${REDIRECT}?error=access_denied&error_description=User%20denied%20authorization&state=xyz`,
    );
    expect(cb.error).toBe("access_denied");
    expect(cb.errorDescription).toBe("User denied authorization");
    expect(cb.code).toBeNull();
  });

  it("accepts URLSearchParams, a bare query string, and a Location-like object", () => {
    expect(
      parseAppAuthorizeCallback(new URLSearchParams(`code=${CODE}`)).code,
    ).toBe(CODE);
    expect(parseAppAuthorizeCallback(`?code=${CODE}`).code).toBe(CODE);
    expect(parseAppAuthorizeCallback(`code=${CODE}`).code).toBe(CODE);
    expect(parseAppAuthorizeCallback({ search: `?code=${CODE}` }).code).toBe(
      CODE,
    );
  });

  it("returns all-null for an empty callback", () => {
    expect(parseAppAuthorizeCallback(REDIRECT)).toEqual({
      code: null,
      state: null,
      error: null,
      errorDescription: null,
    });
  });
});

describe("exchangeAppAuthorizeCode", () => {
  it("GETs the session endpoint with a Bearer code and returns the user", async () => {
    const user = {
      id: "user-1",
      email: "nubs@example.com",
      name: "Nubs",
      avatar: null,
      createdAt: "2026-06-06T00:00:00Z",
    };
    const fetchImpl = fetchReturning({
      success: true,
      user,
      app: { id: APP_ID, name: "Nubilio" },
    });

    const session = await exchangeAppAuthorizeCode(CODE, {
      appId: APP_ID,
      fetchImpl: asFetch(fetchImpl),
    });

    expect(session.user).toEqual(user);
    expect(session.app).toEqual({ id: APP_ID, name: "Nubilio" });

    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://api.elizacloud.ai/api/v1/app-auth/session",
    );
    expect(fetchImpl.mock.calls[0][1]?.method).toBe("GET");
    const headers = headersOf(fetchImpl);
    expect(headers.authorization).toBe(`Bearer ${CODE}`);
    expect(headers["x-app-id"]).toBe(APP_ID);
  });

  it("honors a custom apiBaseUrl", async () => {
    const fetchImpl = fetchReturning({
      success: true,
      user: { id: "u", email: null, name: null, avatar: null, createdAt: null },
    });
    await exchangeAppAuthorizeCode(CODE, {
      apiBaseUrl: "https://api.staging.elizacloud.ai/api/v1/",
      fetchImpl: asFetch(fetchImpl),
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://api.staging.elizacloud.ai/api/v1/app-auth/session",
    );
  });

  it("rejects a non-eac_ code before making any request", async () => {
    const fetchImpl = vi.fn<FetchFn>();
    await expect(
      exchangeAppAuthorizeCode("not-a-code", { fetchImpl: asFetch(fetchImpl) }),
    ).rejects.toBeInstanceOf(ElizaCloudAuthError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws ElizaCloudAuthError with the server code on a 401", async () => {
    const fetchImpl = fetchReturning(
      {
        error: {
          code: "code_invalid",
          message: "Invalid or expired authorization code",
        },
      },
      401,
    );
    const promise = exchangeAppAuthorizeCode(CODE, {
      fetchImpl: asFetch(fetchImpl),
    });
    await expect(promise).rejects.toBeInstanceOf(ElizaCloudAuthError);
    await expect(promise).rejects.toMatchObject({
      statusCode: 401,
      code: "code_invalid",
    });
    await expect(promise).rejects.toThrow("Invalid or expired");
  });
});

describe("ElizaCloudAppAuth", () => {
  it("binds appId + redirectUri and delegates", async () => {
    const fetchImpl = fetchReturning({
      success: true,
      user: { id: "u", email: null, name: null, avatar: null, createdAt: null },
    });
    const auth = new ElizaCloudAppAuth({
      appId: APP_ID,
      redirectUri: REDIRECT,
      fetchImpl: asFetch(fetchImpl),
    });

    expect(new URL(auth.authorizeUrl("s")).searchParams.get("app_id")).toBe(
      APP_ID,
    );

    await auth.completeSignIn(`${REDIRECT}?code=${CODE}&state=s`);
    expect(headersOf(fetchImpl)["x-app-id"]).toBe(APP_ID);
  });

  it("completeSignIn throws on a denial callback without fetching", async () => {
    const fetchImpl = vi.fn<FetchFn>();
    const auth = new ElizaCloudAppAuth({
      appId: APP_ID,
      redirectUri: REDIRECT,
      fetchImpl: asFetch(fetchImpl),
    });
    await expect(
      auth.completeSignIn(
        `${REDIRECT}?error=access_denied&error_description=nope`,
      ),
    ).rejects.toMatchObject({ code: "access_denied" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("completeSignIn throws when no code is present", async () => {
    const auth = new ElizaCloudAppAuth({
      appId: APP_ID,
      redirectUri: REDIRECT,
    });
    await expect(auth.completeSignIn(REDIRECT)).rejects.toMatchObject({
      code: "missing_code",
    });
  });
});
