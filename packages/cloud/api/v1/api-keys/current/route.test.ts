/**
 * Proves mobile sign-out revokes only the exact first-party credential that
 * authenticated the request and fails closed for every other auth shape.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import crypto from "node:crypto";

const { ApiError, AuthenticationError } = await import(
  "@/lib/api/cloud-worker-errors"
);

const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_APP_ID = "44444444-4444-4444-8444-444444444444";
const SECRET = `eliza_mobile_${"a".repeat(64)}`;
const REVOKED_AT = "2026-07-15T12:00:00.000Z";
const credential = {
  id: CREDENTIAL_ID,
  name: "Eliza mobile - staging - grant",
  description: null,
  key_hash: "a".repeat(64),
  key_prefix: "eliza_exact",
  key_ciphertext: null,
  key_nonce: null,
  key_auth_tag: null,
  key_kms_key_id: null,
  key_kms_key_version: null,
  organization_id: "22222222-2222-4222-8222-222222222222",
  user_id: "33333333-3333-4333-8333-333333333333",
  source_app_id: SOURCE_APP_ID,
  rate_limit: 1000,
  is_active: true,
  usage_count: 0,
  expires_at: new Date(Date.now() + 60_000),
  last_used_at: null,
  created_at: new Date(),
  updated_at: new Date(),
  deleted_at: null,
};

let contextMismatch = false;
let credentialRevoked = false;
let authenticationDependencyUnavailable = false;
const requireApiKeyCredential = mock(
  async (c: {
    req: { header(name: string): string | undefined };
    set(key: "apiKeyId" | "authMethod", value: string): void;
  }) => {
    if (authenticationDependencyUnavailable) {
      throw new ApiError(
        503,
        "service_unavailable",
        "API key validation is temporarily unavailable. Please retry.",
      );
    }
    if (
      credentialRevoked ||
      c.req.header("authorization") !== `Bearer ${SECRET}`
    ) {
      throw AuthenticationError("An API key credential is required");
    }
    c.set("authMethod", "api_key");
    c.set("apiKeyId", contextMismatch ? crypto.randomUUID() : credential.id);
    return credential;
  },
);
const revocationReceipt = {
  credentialId: CREDENTIAL_ID,
  revokedAt: REVOKED_AT,
  status: "revoked" as const,
};
const selfRevocationResult = (revokedNow: boolean) => ({
  receipt: revocationReceipt,
  revokedNow,
  userId: credential.user_id,
  organizationId: credential.organization_id,
});
const revokeExactMobileCredential = mock(async () =>
  selfRevocationResult(true),
);
const revokePresentedMobileCredential = mock(async (secret: string) =>
  (credentialRevoked || authenticationDependencyUnavailable) &&
  secret === SECRET
    ? selfRevocationResult(authenticationDependencyUnavailable)
    : null,
);
const emitAudit = mock(async () => undefined);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireApiKeyCredential,
}));
mock.module("@/lib/services/api-keys", () => ({
  apiKeysService: {
    revokeExactMobileCredential,
    revokePresentedMobileCredential,
  },
  isMobileApiKeySecret: (value: string) =>
    /^eliza_mobile_[0-9a-f]{64}$/.test(value),
}));
mock.module("@/api-app/services/audit-dispatcher-singleton", () => ({
  getAuditDispatcher: () => ({ emit: emitAudit }),
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  getIpKey: mock(() => "ip:test"),
  RateLimitPresets: {
    STANDARD: { maxRequests: 60, windowMs: 60_000 },
    STRICT: { maxRequests: 10, windowMs: 60_000 },
  },
  rateLimit:
    () =>
    async (_context: unknown, next: () => Promise<void>): Promise<void> =>
      await next(),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");

beforeEach(() => {
  contextMismatch = false;
  credentialRevoked = false;
  authenticationDependencyUnavailable = false;
  requireApiKeyCredential.mockClear();
  revokeExactMobileCredential.mockClear();
  revokePresentedMobileCredential.mockClear();
  emitAudit.mockClear();
});

describe("DELETE /api/v1/api-keys/current", () => {
  test("revokes the exact authenticated mobile credential and returns its ID", async () => {
    const response = await app.request("/", {
      method: "DELETE",
      headers: { authorization: `Bearer ${SECRET}` },
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toEqual({
      success: true,
      credentialId: CREDENTIAL_ID,
      revokedAt: REVOKED_AT,
      status: "revoked",
    });
    expect(revokeExactMobileCredential).toHaveBeenCalledWith(credential);
    expect(emitAudit).toHaveBeenCalledTimes(1);
  });

  test("returns the same exact durable tombstone after the key stops authenticating", async () => {
    credentialRevoked = true;
    const response = await app.request("/", {
      method: "DELETE",
      headers: { authorization: `Bearer ${SECRET}` },
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toEqual({
      success: true,
      ...revocationReceipt,
    });
    expect(revokePresentedMobileCredential).toHaveBeenCalledWith(SECRET);
    expect(revokeExactMobileCredential).not.toHaveBeenCalled();
    expect(emitAudit).not.toHaveBeenCalled();
  });

  test("revokes the exact presented mobile credential when the auth cache is unavailable", async () => {
    authenticationDependencyUnavailable = true;
    const response = await app.request("/", {
      method: "DELETE",
      headers: { authorization: `Bearer ${SECRET}` },
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toEqual({
      success: true,
      ...revocationReceipt,
    });
    expect(revokePresentedMobileCredential).toHaveBeenCalledWith(SECRET);
    expect(revokeExactMobileCredential).not.toHaveBeenCalled();
    expect(emitAudit).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["missing auth", undefined],
    ["JWT session", "Bearer header.payload.signature"],
    ["invalid key", "Bearer eliza_unknown"],
    ["ordinary API key", `Bearer eliza_${"f".repeat(64)}`],
    ["wrong exact-shaped mobile key", `Bearer eliza_mobile_${"f".repeat(64)}`],
  ])("rejects %s without revoking another key", async (_label, authorization) => {
    const response = await app.request("/", {
      method: "DELETE",
      ...(authorization ? { headers: { authorization } } : {}),
    });

    expect(response.status).toBe(401);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      success: false,
      code: "authentication_required",
    });
    expect(revokeExactMobileCredential).not.toHaveBeenCalled();
  });

  test("fails closed when auth cannot prove the returned key ID on context", async () => {
    contextMismatch = true;
    const response = await app.request("/", {
      method: "DELETE",
      headers: { authorization: `Bearer ${SECRET}` },
    });

    expect(response.status).toBe(401);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      success: false,
      code: "authentication_required",
    });
    expect(revokeExactMobileCredential).not.toHaveBeenCalled();
    expect(emitAudit).not.toHaveBeenCalled();
  });

  test("rejects dual credentials without consulting a tombstone", async () => {
    credentialRevoked = true;
    const response = await app.request("/", {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "x-api-key": SECRET,
      },
    });

    expect(response.status).toBe(401);
    expect(revokePresentedMobileCredential).not.toHaveBeenCalled();
    expect(revokeExactMobileCredential).not.toHaveBeenCalled();
  });
});
