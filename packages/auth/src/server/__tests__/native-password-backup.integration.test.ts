import { expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";

test("Cloud rechecks the registered native Google identity for backup without creating a sign-in session", async () => {
  const { openNativeBackupSteward } = await import(
    "../../../test/fixtures/native-backup-steward"
  );
  const { createAuthorizationSignature } = await import(
    "../api/middleware/authorization-signature"
  );
  const { accounts, refreshTokens } = await import("../db/schema-auth");
  const { tenants, tenantAppClients } = await import("../db/schema");
  const { eq } = await import("drizzle-orm");
  let updateWhileFetching: (() => Promise<void>) | undefined;
  const f = await openNativeBackupSteward({
    beforeGoogleKeys: async () => {
      await updateWhileFetching?.();
    },
  });
  const registration = {
    packageName: f.packageName,
    redirectUri: f.redirectUri,
    environment: f.environment,
  };
  const request = async (
    op: string,
    fields: Record<string, unknown> = {},
    options: { key?: string; sign?: boolean; origin?: string } = {},
  ) => {
    const url = `https://login.internal/auth/oauth/google/native/backup/${op}`;
    const body = JSON.stringify({ ...registration, ...fields });
    const expiresAt = String(Math.floor(Date.now() / 1000) + 60);
    const idempotencyKey = randomUUID();
    const apiKey = options.key ?? f.tenantKey;
    const headers = new Headers({
      "Content-Type": "application/json",
      "X-Steward-Tenant": f.tenantId,
      "X-Steward-Key": apiKey,
      "X-Steward-Request-Expires-At": expiresAt,
      "Idempotency-Key": idempotencyKey,
    });
    if (options.origin) headers.set("Origin", options.origin);
    if (options.sign !== false)
      headers.set(
        "X-Steward-Signature",
        await createAuthorizationSignature(
          {
            method: "POST",
            url,
            body,
            expiresAt,
            idempotencyKey,
            apiKey,
            tenantId: f.tenantId,
          },
          f.signingSecret,
        ),
      );
    return f.app.request(url, { method: "POST", headers, body });
  };
  try {
    const sessions = () =>
      f.db.db.select({ id: refreshTokens.id }).from(refreshTokens);
    const before = await sessions();
    const otherTenantKey = randomBytes(32).toString("base64url");
    await f.db.db.insert(tenants).values({
      id: "another-backup-tenant",
      name: "Other tenant",
      apiKeyHash: createHash("sha256").update(otherTenantKey).digest("hex"),
    });
    expect((await request("registration", {}, { sign: false })).status).toBe(
      401,
    );
    expect(
      (await request("registration", {}, { key: otherTenantKey })).status,
    ).toBe(403);
    expect(
      (await request("registration", {}, { origin: "https://example.test" }))
        .ok,
    ).toBe(false);
    expect(
      (await request("registration", { environment: "production" })).ok,
    ).toBe(false);
    expect(await (await request("registration")).json()).toEqual({
      serverClientId: f.serverClientId,
    });
    await f.db.db
      .insert(tenantAppClients)
      .values({ ...f.registration, id: "duplicate-backup" });
    expect((await request("registration")).ok).toBe(false);
    await f.db.db
      .delete(tenantAppClients)
      .where(eq(tenantAppClients.id, "duplicate-backup"));
    const start = await (
      await request("registration", { ownerId: f.ownerId })
    ).json();
    expect(start).toEqual({
      serverClientId: f.serverClientId,
      ownerBinding: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const nonce = randomBytes(32).toString("base64url");
    const proof = {
      nonce,
      idToken: await f.googleIdToken(nonce),
      ownerId: f.ownerId,
      ownerBinding: start.ownerBinding,
    };
    expect(
      (await request("verify", { ...proof, ownerId: f.otherOwnerId })).ok,
    ).toBe(false);
    expect(
      (
        await request("verify", {
          ...proof,
          nonce: randomBytes(32).toString("base64url"),
        })
      ).ok,
    ).toBe(false);
    expect(
      (await request("verify", { ...proof, ownerBinding: "0".repeat(64) })).ok,
    ).toBe(false);
    const accepted = await (await request("verify", proof)).json();
    expect(accepted).toEqual({
      verified: true,
      serverClientId: f.serverClientId,
      proofBinding: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect((await request("verify", proof)).ok).toBe(false);
    const current = {
      ownerId: f.ownerId,
      proofBinding: accepted.proofBinding,
    };
    expect(await (await request("current", current)).json()).toEqual({
      verified: true,
      serverClientId: f.serverClientId,
    });
    const { clearOidcJwksCacheForTests } = await import("../auth/oidc");
    clearOidcJwksCacheForTests();
    let changed = false;
    updateWhileFetching = async () => {
      await f.db.db.delete(accounts).where(eq(accounts.userId, f.ownerId));
      changed = true;
    };
    const rotated = { ...proof, idToken: await f.googleIdToken(nonce) };
    expect((await request("verify", rotated)).ok).toBe(false);
    expect(changed).toBe(true);
    expect((await request("current", current)).ok).toBe(false);
    expect(await sessions()).toEqual(before);
  } finally {
    await f.close();
  }
}, 240_000);
