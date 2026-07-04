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
