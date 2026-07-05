// Exercises cloud API auth steward refresh route.test behavior with deterministic Worker route fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";

type VerifiedStewardClaims = {
  userId: string;
  email: string;
  tenantId: string;
  expiration: number;
  issuedAt: number;
};

const verifyStewardTokenCached = mock<
  (_env: unknown, _token: string) => Promise<VerifiedStewardClaims | null>
>(async () => ({
  userId: "steward-user-1",
  email: "user@example.com",
  tenantId: "elizacloud",
  expiration: Math.floor(Date.now() / 1000) + 60,
  issuedAt: Math.floor(Date.now() / 1000) - 60,
}));

const mintStewardTokenFromClaims = mock<
  (
    _env: unknown,
    _claims: VerifiedStewardClaims,
    _ttlSeconds: number,
  ) => Promise<{ token: string; expiresAt: number; expiresIn: number } | null>
>(async () => ({
  token: "fresh-steward-jwt",
  expiresAt: 1_800_000_000,
  expiresIn: 3600,
}));

mock.module("@/lib/auth/steward-client", () => ({
  STEWARD_AUTH_UPSTREAM_TIMEOUT_MS: 25_000,
  verifyStewardTokenCached,
  mintStewardTokenFromClaims,
}));

mock.module("@/lib/steward/sign", () => ({
  signStewardMutatingRequest: mock(async () => undefined),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");

const ENV = {
  NODE_ENV: "production",
  STEWARD_JWT_SECRET: "secret",
  STEWARD_TENANT_ID: "elizacloud",
};

function post(headers: HeadersInit = {}) {
  return app.fetch(
    new Request("https://api.elizacloud.ai/", {
      method: "POST",
      headers,
    }),
    ENV,
  );
}

function deletedCookieNames(res: Response): string[] {
  return res.headers
    .getSetCookie()
    .filter((cookie) => /Max-Age=0/i.test(cookie))
    .map((cookie) => cookie.split("=")[0]);
}

describe("steward-refresh bearer rotation", () => {
  beforeEach(() => {
    verifyStewardTokenCached.mockClear();
    mintStewardTokenFromClaims.mockClear();
    verifyStewardTokenCached.mockResolvedValue({
      userId: "steward-user-1",
      email: "user@example.com",
      tenantId: "elizacloud",
      expiration: Math.floor(Date.now() / 1000) + 60,
      issuedAt: Math.floor(Date.now() / 1000) - 60,
    });
    mintStewardTokenFromClaims.mockResolvedValue({
      token: "fresh-steward-jwt",
      expiresAt: 1_800_000_000,
      expiresIn: 3600,
    });
  });

  test("accepts native Bearer refresh without browser Origin or refresh cookie", async () => {
    const response = await post({
      Authorization: "Bearer near-expiry-steward-jwt",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      token: "fresh-steward-jwt",
      expiresAt: 1_800_000_000,
      expiresIn: 3600,
    });
    expect(verifyStewardTokenCached).toHaveBeenCalledWith(
      expect.objectContaining({ STEWARD_JWT_SECRET: "secret" }),
      "near-expiry-steward-jwt",
    );
    expect(mintStewardTokenFromClaims).toHaveBeenCalledWith(
      expect.objectContaining({ STEWARD_JWT_SECRET: "secret" }),
      expect.objectContaining({ userId: "steward-user-1" }),
      3600,
    );
  });

  test("rejects invalid Bearer refresh before falling back to cookie refresh", async () => {
    verifyStewardTokenCached.mockResolvedValue(null);

    const response = await post({
      Authorization: "Bearer expired-steward-jwt",
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid token",
      code: "invalid_token",
    });
    expect(mintStewardTokenFromClaims).not.toHaveBeenCalled();
  });

  test("keeps the browser cookie path origin-gated when no Bearer token is supplied", async () => {
    const response = await post();

    expect(response.status).toBe(403);
    expect(verifyStewardTokenCached).not.toHaveBeenCalled();
    expect(mintStewardTokenFromClaims).not.toHaveBeenCalled();
  });
});

describe("steward-refresh browser cookie cleanup", () => {
  test("staging legacy-only refresh cookie is not read or forwarded", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async () => {
      throw new Error("legacy refresh cookie must not reach Steward");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const response = await app.fetch(
        new Request("https://api-staging.elizacloud.ai/", {
          method: "POST",
          headers: {
            host: "api-staging.elizacloud.ai",
            origin: "https://staging.elizacloud.ai",
            cookie: "steward-refresh-token=prod-refresh; steward-authed=1",
          },
        }),
        {
          ...ENV,
          ENVIRONMENT: "staging",
          STEWARD_API_URL: "https://steward.example.test",
        },
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: "Refresh token required",
        code: "missing_token",
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(deletedCookieNames(response)).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("staging invalid refresh clears only staging cookies", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({ ok: false, error: "refresh rejected" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    try {
      const response = await app.fetch(
        new Request("https://api-staging.elizacloud.ai/", {
          method: "POST",
          headers: {
            host: "api-staging.elizacloud.ai",
            origin: "https://staging.elizacloud.ai",
            cookie:
              "steward-refresh-token=prod-refresh; steward-authed=1; steward-refresh-token-staging=staging-refresh; steward-authed-staging=1",
          },
        }),
        {
          ...ENV,
          ENVIRONMENT: "staging",
          STEWARD_API_URL: "https://steward.example.test",
        },
      );

      expect(response.status).toBe(401);
      const cleared = deletedCookieNames(response);
      expect(cleared).toContain("steward-token-staging");
      expect(cleared).toContain("steward-refresh-token-staging");
      expect(cleared).toContain("steward-authed-staging");
      expect(cleared).not.toContain("steward-token");
      expect(cleared).not.toContain("steward-refresh-token");
      expect(cleared).not.toContain("steward-authed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
