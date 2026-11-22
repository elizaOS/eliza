import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";

const { dbWrite, closeDatabaseConnectionsForTests } = await import("../../db/client");
const { organizations } = await import("../../db/schemas/organizations");
const { users } = await import("../../db/schemas/users");
const { userIdentities } = await import("../../db/schemas/user-identities");
const { apiKeys } = await import("../../db/schemas/api-keys");
const { ssoBridgeLogoutMarkers } = await import("../../db/schemas/sso-bridge");
const { loadExistingStagingSessionSubjectForMint, validateStagingSessionBinding } = await import(
  "./staging-session-binding"
);

const { mintStewardTokenFromClaims, verifyStewardTokenCached } = await import("./steward-client");

const apiKeyId = crypto.randomUUID(),
  cloudUserId = crypto.randomUUID(),
  organizationId = crypto.randomUUID(),
  stewardUserId = crypto.randomUUID();
const address = "0x1111111111111111111111111111111111111111";
const tenantId = "elizacloud-staging";
const key = "eliza_" + "ab".repeat(32);
const now = new Date();
const seconds = Math.floor(now.getTime() / 1000);
const env = {
  NODE_ENV: "production",
  ENVIRONMENT: "staging",
  STEWARD_TENANT_ID: tenantId,
  STAGING_SESSION_EXCHANGE_ENABLED: "true",
  STAGING_SESSION_EXCHANGE_VERSION: "v1",
  STAGING_SESSION_EXCHANGE_SIGNING_SECRET: "unit-test-signing-key-which-is-long-enough",
  STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: "staging-qa-v1-test",
  STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS: apiKeyId,
  STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS: cloudUserId,
  STAGING_SESSION_EXCHANGE_ALLOWED_ORGANIZATION_IDS: organizationId,
  STAGING_SESSION_EXCHANGE_FIXTURE_SUBJECT: stewardUserId,
  STAGING_SESSION_EXCHANGE_GRANT_READ_KEY: "test-grant-reader",
};
const grant = {
  version: 1,
  grantId: crypto.randomUUID(),
  principal: { method: "siwe", address },
  apiKeyId,
  cloudUserId,
  organizationId,
  issuedAt: seconds - 20,
  expiresAt: seconds + 120,
};
const profile = (entry: unknown) => ({
  ok: true,
  data: {
    userId: stewardUserId,
    tenantId,
    tenantCustomMetadata: { elizaStagingSessionExchange: entry },
  },
});
const mint = (config = env) =>
  loadExistingStagingSessionSubjectForMint({ env: config, apiKeyId, presentedApiKey: key, now });

beforeAll(async () => {
  const { apply } = await pushSchema(
    { organizations, users, userIdentities, apiKeys, ssoBridgeLogoutMarkers } as never,
    dbWrite as never,
  );
  await apply();
  await dbWrite.execute("CREATE TABLE apps (id uuid PRIMARY KEY, api_key_id uuid)");
  await dbWrite
    .insert(organizations)
    .values({ id: organizationId, name: "Public customer", slug: "public-customer" });
  await dbWrite.insert(users).values({
    id: cloudUserId,
    steward_user_id: stewardUserId,
    organization_id: organizationId,
    role: "owner",
    wallet_address: address,
    wallet_chain_type: "ethereum",
    wallet_verified: true,
  });
  await dbWrite
    .insert(userIdentities)
    .values({ user_id: cloudUserId, steward_user_id: stewardUserId });
  await dbWrite.insert(apiKeys).values({
    id: apiKeyId,
    name: "Release QA",
    organization_id: organizationId,
    user_id: cloudUserId,
    key_prefix: key.slice(0, 10),
    key_hash: createHash("sha256").update(key).digest("hex"),
    user_created: true,
  });
}, 60000);
afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

test("a tenant-authorized owner can mint and revalidate only the exact live grant, without delegating its organization", async () => {
  const originalFetch = globalThis.fetch;
  let result: unknown = profile(grant);
  let status = 200;
  const issuer = mock(async (url: URL | string | Request, init?: RequestInit) => {
    expect(String(url)).toBe(
      `https://login-staging.eliza.app/platform/tenants/elizacloud-staging/users/${stewardUserId}`,
    );
    expect(new Headers(init?.headers).get("X-Steward-Platform-Key")).toBe(
      env.STAGING_SESSION_EXCHANGE_GRANT_READ_KEY,
    );
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    return Response.json(result, { status });
  });
  globalThis.fetch = Object.assign(issuer, { preconnect: originalFetch.preconnect });
  try {
    const minted = await mint();
    expect(minted.expiration).toBe(grant.expiresAt);
    const revalidate = () =>
      validateStagingSessionBinding({
        env,
        binding: minted.binding,
        stewardUserId,
        tenantId,
        issuedAt: seconds,
        expiration: minted.expiration,
        now,
      });
    expect(await revalidate()).toBe(true);
    const session = await mintStewardTokenFromClaims(env, {
      userId: stewardUserId,
      tenantId,
      issuedAt: seconds,
      expiration: minted.expiration,
      bridged: true,
      stagingSessionBinding: minted.binding,
    });
    if (!session) throw new Error("Expected a signed staging session");
    expect((await verifyStewardTokenCached(env, session.token))?.userId).toBe(stewardUserId);
    result = profile(null);
    expect(await verifyStewardTokenCached(env, session.token)).toBeNull();

    for (const invalid of [
      undefined,
      { ...grant, apiKeyId: crypto.randomUUID() },
      { ...grant, cloudUserId: crypto.randomUUID() },
      { ...grant, organizationId: crypto.randomUUID() },
      { ...grant, expiresAt: seconds },
      { ...grant, issuedAt: seconds + 1 },
      { ...grant, principal: { method: "siwe", address: "0x" + "22".repeat(20) } },
      { ...grant, principal: { method: "email", email: "unverified@example.test" } },
    ]) {
      result = profile(invalid);
      await expect(mint()).rejects.toMatchObject({ reason: "tenant" });
      expect(await revalidate()).toBe(false);
    }
    result = profile({ ...grant, grantId: crypto.randomUUID() });
    expect(await revalidate()).toBe(false);
    result = profile({ ...grant, issuedAt: seconds - 1 });
    expect(await revalidate()).toBe(false);
    result = profile(grant);
    for (const failure of [302, 401, 403, 404, 503]) {
      status = failure;
      await expect(mint()).rejects.toMatchObject({ reason: "tenant" });
    }
    status = 200;
    result = { ok: true, data: { ...profile(grant).data, tenantId: "other-tenant" } };
    await expect(mint()).rejects.toMatchObject({ reason: "tenant" });
    result = { ok: true, data: { ...profile(grant).data, userId: crypto.randomUUID() } };
    await expect(mint()).rejects.toMatchObject({ reason: "tenant" });
    result = profile(grant);
    await expect(
      mint({ ...env, STAGING_SESSION_EXCHANGE_FIXTURE_SUBJECT: crypto.randomUUID() }),
    ).rejects.toMatchObject({ reason: "tenant" });
    await expect(
      mint({ ...env, STAGING_SESSION_EXCHANGE_GRANT_READ_KEY: "" }),
    ).rejects.toMatchObject({ reason: "tenant" });
    await expect(
      mint({ ...env, STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS: crypto.randomUUID() }),
    ).rejects.toMatchObject({ reason: "allowlist" });
    await expect(mint({ ...env, ENVIRONMENT: "production" })).rejects.toThrow("disabled");
    await dbWrite.update(users).set({ wallet_verified: false }).where(eq(users.id, cloudUserId));
    await expect(mint()).rejects.toMatchObject({ reason: "tenant" });
    await dbWrite
      .update(users)
      .set({ wallet_verified: true, role: "member" })
      .where(eq(users.id, cloudUserId));
    await expect(mint()).rejects.toMatchObject({ reason: "tenant" });
    await dbWrite
      .update(users)
      .set({ role: "owner", email: "qa@example.test", email_verified: true })
      .where(eq(users.id, cloudUserId));
    result = profile({ ...grant, principal: { method: "email", email: "qa@example.test" } });
    expect((await mint()).stewardUserId).toBe(stewardUserId);
    result = profile(grant);
    await dbWrite.update(apiKeys).set({ expires_at: now }).where(eq(apiKeys.id, apiKeyId));
    await expect(mint()).rejects.toMatchObject({ reason: "source_key" });
    await dbWrite.update(apiKeys).set({ expires_at: null }).where(eq(apiKeys.id, apiKeyId));
    await dbWrite.update(apiKeys).set({ user_created: false }).where(eq(apiKeys.id, apiKeyId));
    await expect(mint()).rejects.toMatchObject({ reason: "tenant" });
    await dbWrite
      .update(apiKeys)
      .set({ user_created: true, is_active: false })
      .where(eq(apiKeys.id, apiKeyId));
    await expect(mint()).rejects.toMatchObject({ reason: "source_key" });
    await dbWrite.update(apiKeys).set({ is_active: true }).where(eq(apiKeys.id, apiKeyId));
    const [org] = await dbWrite
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    expect(org?.steward_tenant_id).toBeNull();
    expect(org?.steward_tenant_api_key).toBeNull();
    await dbWrite
      .update(organizations)
      .set({ steward_tenant_id: tenantId })
      .where(eq(organizations.id, organizationId));
    result = profile(null);
    await expect(mint()).rejects.toMatchObject({ reason: "tenant" });
    const reads = issuer.mock.calls.length;
    const delegated = await mint({ ...env, STAGING_SESSION_EXCHANGE_FIXTURE_SUBJECT: "" });
    expect(delegated.stewardUserId).toBe(stewardUserId);
    expect(issuer.mock.calls.length).toBe(reads);
    expect(delegated.binding.credentialFingerprint).not.toBe(minted.binding.credentialFingerprint);
  } finally {
    globalThis.fetch = originalFetch;
  }
}, 60000);
