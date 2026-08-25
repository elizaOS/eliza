/**
 * Proves mobile sign-out revokes only the exact first-party credential that
 * authenticated the request and fails closed for every other auth shape.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import crypto from "node:crypto";
import { Hono } from "hono";

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
const requireUserWithOrg = mock(async () => ({
  id: credential.user_id,
  organization_id: credential.organization_id,
}));
const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: credential.user_id,
  organization_id: credential.organization_id,
}));
const requireSessionUserWithOrg = mock(async () => ({
  id: credential.user_id,
  organization_id: credential.organization_id,
}));
const manageableKey = {
  ...credential,
  id: "55555555-5555-4555-8555-555555555555",
  name: "User-managed key",
  description: "Created from settings",
  key_prefix: "eliza_user",
  source_app_id: null,
};
const listByOrganization = mock(async () => [manageableKey]);
const create = mock(async () => ({
  apiKey: manageableKey,
  plainKey: `eliza_${"b".repeat(64)}`,
}));
const getManageableById = mock(async (id: string) =>
  id === manageableKey.id ? manageableKey : undefined,
);
const update = mock(async (_id: string, data: Record<string, unknown>) => ({
  ...manageableKey,
  ...data,
}));
const regenerate = mock(async () => ({
  apiKey: manageableKey,
  plainKey: `eliza_${"c".repeat(64)}`,
}));
const deleteApiKey = mock(async () => undefined);
const generateApiKey = mock(() => ({
  key: `eliza_${"c".repeat(64)}`,
  hash: "c".repeat(64),
  prefix: "eliza_cccccc",
}));
const listMobileCredentialsForAccount = mock(async () => [
  {
    id: credential.id,
    name: credential.name,
    source_app_id: credential.source_app_id,
    created_at: credential.created_at.toISOString(),
    last_used_at: null,
    expires_at: credential.expires_at?.toISOString(),
    status: "active",
  },
]);
const revokeMobileCredentialForAccount = mock(async () => ({
  receipt: revocationReceipt,
  revokedNow: true,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireApiKeyCredential,
  requireSessionUserWithOrg,
  requireUserOrApiKeyWithOrg,
  requireUserWithOrg,
}));
mock.module("@/lib/services/api-keys", () => ({
  apiKeysService: {
    create,
    delete: deleteApiKey,
    generateApiKey,
    getManageableById,
    listByOrganization,
    listMobileCredentialsForAccount,
    regenerate,
    revokeExactMobileCredential,
    revokeMobileCredentialForAccount,
    revokePresentedMobileCredential,
    update,
  },
  isMobileApiKeySecret: (value: string) =>
    /^eliza_mobile_[0-9a-f]{64}$/.test(value),
}));
mock.module("@/api-app/middleware/org-membership", () => ({
  assertOrgMembership: mock(async () => undefined),
}));
mock.module("@/api-app/services/audit-dispatcher-singleton", () => ({
  getAuditDispatcher: () => ({ emit: emitAudit }),
}));
mock.module("@elizaos/cloud-shared/db/crypto/api-keys", () => ({
  encryptApiKey: mock(async () => ({
    ciphertext: "ciphertext",
    nonce: "nonce",
    auth_tag: "auth-tag",
    kms_key_id: "kms-key",
    kms_key_version: 1,
  })),
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
const { default: apiKeysApp } = await import("../route");
const { default: apiKeyApp } = await import("../[id]/route");
const { default: regenerateApiKeyApp } = await import(
  "../[id]/regenerate/route"
);
const { default: accountCredentialsApp } = await import(
  "../../app-auth/mobile/credentials/route"
);
const { default: accountCredentialApp } = await import(
  "../../app-auth/mobile/credentials/[id]/route"
);

const apiKeyHarness = new Hono();
apiKeyHarness.route("/api/v1/api-keys", apiKeysApp);
apiKeyHarness.route("/api/v1/api-keys/:id", apiKeyApp);
apiKeyHarness.route("/api/v1/api-keys/:id/regenerate", regenerateApiKeyApp);
apiKeyHarness.route(
  "/api/v1/app-auth/mobile/credentials",
  accountCredentialsApp,
);
apiKeyHarness.route(
  "/api/v1/app-auth/mobile/credentials/:id",
  accountCredentialApp,
);

beforeEach(() => {
  contextMismatch = false;
  credentialRevoked = false;
  authenticationDependencyUnavailable = false;
  requireApiKeyCredential.mockClear();
  requireSessionUserWithOrg.mockClear();
  requireUserOrApiKeyWithOrg.mockClear();
  requireUserWithOrg.mockClear();
  listByOrganization.mockClear();
  create.mockClear();
  getManageableById.mockClear();
  update.mockClear();
  deleteApiKey.mockClear();
  generateApiKey.mockClear();
  listMobileCredentialsForAccount.mockClear();
  revokeExactMobileCredential.mockClear();
  revokeMobileCredentialForAccount.mockClear();
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
  ])(
    "rejects %s without revoking another key",
    async (_label, authorization) => {
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
    },
  );

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

describe("user-managed API-key routes", () => {
  test("lists and creates only non-mobile keys through session auth", async () => {
    const listResponse = await apiKeyHarness.request("/api/v1/api-keys");
    expect(listResponse.status).toBe(200);
    expect((await listResponse.json()) as Record<string, unknown>).toEqual({
      keys: [
        expect.objectContaining({
          id: manageableKey.id,
          name: manageableKey.name,
          key_prefix: manageableKey.key_prefix,
        }),
      ],
    });

    const createResponse = await apiKeyHarness.request("/api/v1/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Settings key", rate_limit: 500 }),
    });
    expect(createResponse.status).toBe(201);
    expect(
      (await createResponse.json()) as Record<string, unknown>,
    ).toMatchObject({
      apiKey: { id: manageableKey.id },
      plainKey: `eliza_${"b".repeat(64)}`,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: credential.organization_id,
        user_id: credential.user_id,
        is_active: true,
      }),
    );
  });

  test("rejects reserved names before creating or updating a key", async () => {
    const createResponse = await apiKeyHarness.request("/api/v1/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "agent-sandbox:managed" }),
    });
    expect(createResponse.status).toBe(400);
    expect(create).not.toHaveBeenCalled();

    const patchResponse = await apiKeyHarness.request(
      `/api/v1/api-keys/${manageableKey.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "agent-sandbox:managed" }),
      },
    );
    expect(patchResponse.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  test("updates, deletes, and rotates only manageable keys", async () => {
    const patchResponse = await apiKeyHarness.request(
      `/api/v1/api-keys/${manageableKey.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ is_active: false, expires_at: null }),
      },
    );
    expect(patchResponse.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      manageableKey.id,
      expect.objectContaining({ is_active: false, expires_at: null }),
    );

    const regenerateResponse = await apiKeyHarness.request(
      `/api/v1/api-keys/${manageableKey.id}/regenerate`,
      { method: "POST" },
    );
    expect(regenerateResponse.status).toBe(200);
    expect(regenerate).toHaveBeenCalledWith(manageableKey.id);

    const deleteResponse = await apiKeyHarness.request(
      `/api/v1/api-keys/${manageableKey.id}`,
      { method: "DELETE" },
    );
    expect(deleteResponse.status).toBe(200);
    expect(deleteApiKey).toHaveBeenCalledWith(manageableKey.id);

    const mobileResponse = await apiKeyHarness.request(
      `/api/v1/api-keys/${credential.id}`,
      { method: "DELETE" },
    );
    expect(mobileResponse.status).toBe(404);
    expect(deleteApiKey).not.toHaveBeenCalledWith(credential.id);
  });
});

describe("account mobile credential routes", () => {
  test("lists session-owned mobile credential receipts", async () => {
    const response = await apiKeyHarness.request(
      "/api/v1/app-auth/mobile/credentials",
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      success: true,
      credentials: [expect.objectContaining({ id: credential.id })],
    });
    expect(listMobileCredentialsForAccount).toHaveBeenCalledWith(
      credential.user_id,
      credential.organization_id,
    );
  });

  test("revokes one session-owned mobile credential idempotently", async () => {
    const response = await apiKeyHarness.request(
      `/api/v1/app-auth/mobile/credentials/${credential.id}`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toEqual({
      success: true,
      ...revocationReceipt,
    });
    expect(revokeMobileCredentialForAccount).toHaveBeenCalledWith(
      credential.id,
      credential.user_id,
      credential.organization_id,
    );
    expect(emitAudit).toHaveBeenCalledTimes(1);
  });
});
