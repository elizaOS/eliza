/** Real PG owners + actual global auth/CSRF/CORS entry; JWT claims are synthetic, never a live OTP proof. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { Hono } from "hono";
import { acquireEphemeralPostgres } from "../../../shared/src/lib/services/tenant-db/__tests__/ephemeral-postgres";

const postgres = await acquireEphemeralPostgres();
const database = `network_sso_${randomUUID().replaceAll("-", "")}`;
const originalDatabase = process.env.DATABASE_URL;
const origin = "http://127.0.0.1:54302";
const apiOrigin = "https://api-staging.eliza.app";
const loginOrigin = "https://cloud-staging.eliza.app";
const serverToken = `synthetic-server-${"x".repeat(40)}`;
const env = {
  ENVIRONMENT: "staging",
  NODE_ENV: "production",
  REDIS_RATE_LIMITING: "false",
  NETWORK_SITE_AUTH_ENABLED: "true",
  NETWORK_SITE_AUTH_ORIGIN: origin,
  NETWORK_SITE_AUTH_SERVER_TOKEN: serverToken,
  STEWARD_SESSION_SECRET: `synthetic-steward-${"y".repeat(40)}`,
};
const verifier = "a".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("hex");
const app = new Hono<{ Bindings: Record<string, unknown> }>();
let admin: SQL | undefined;
let owned = false;
let close: (() => Promise<void>) | undefined;
let db: typeof import("../../../shared/src/db/client").dbWrite;
let users: typeof import("../../../shared/src/db/schemas/users").users;
let organizations: typeof import("../../../shared/src/db/schemas/organizations").organizations;
let codes: typeof import("../../../shared/src/db/schemas/sso-bridge").ssoBridgeCodes;
let logout: typeof import("../../../shared/src/db/schemas/sso-bridge").ssoBridgeLogoutMarkers;
let owner: typeof import("../../../shared/src/lib/services/sso-bridge-codes");
let signer: typeof import("../../../shared/src/lib/auth/steward-client");
let eq: typeof import("drizzle-orm").eq;
let identity: { userId: string; organizationId: string; e164: string };
let subject: string;
let smsToken: string;
let ip = 1;

beforeAll(async () => {
  if (!postgres) return;
  admin = new SQL(postgres.dsn);
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  owned = true;
  const dsn = new URL(postgres.dsn);
  dsn.pathname = `/${database}`;
  process.env.DATABASE_URL = dsn.toString();
  ({ dbWrite: db, closeDatabaseConnectionsForTests: close } = await import(
    "../../../shared/src/db/client"
  ));
  ({ users } = await import("../../../shared/src/db/schemas/users"));
  const orgSchema = await import(
    "../../../shared/src/db/schemas/organizations"
  );
  organizations = orgSchema.organizations;
  ({ ssoBridgeCodes: codes, ssoBridgeLogoutMarkers: logout } = await import(
    "../../../shared/src/db/schemas/sso-bridge"
  ));
  const { userIdentities } = await import(
    "../../../shared/src/db/schemas/user-identities"
  );
  const { pushSchema } = await import("drizzle-kit/api");
  const { apply } = await pushSchema(
    {
      organizationBalanceRevisionSequence:
        orgSchema.organizationBalanceRevisionSequence,
      organizations,
      users,
      userIdentities,
      ssoBridgeCodes: codes,
      ssoBridgeLogoutMarkers: logout,
    } as never,
    db as never,
  );
  await apply();
  ({ eq } = await import("drizzle-orm"));
  owner = await import("../../../shared/src/lib/services/sso-bridge-codes");
  signer = await import("../../../shared/src/lib/auth/steward-client");
  const { usersRepository } = await import(
    "../../../shared/src/db/repositories/users"
  );
  const account = await usersRepository.findOrCreatePhonePersonalAccount({
    phoneNumber: "+12125550194",
    displayName: "Synthetic SSO phone",
    organizationName: "Synthetic SSO owner",
    organizationSlug: database,
  });
  subject = `synthetic-sso-subject-${randomUUID()}`;
  expect(
    (
      await usersRepository.promotePhonePersonalAccountToSteward({
        phoneNumber: account.user.phone_number ?? "",
        stewardUserId: subject,
      })
    ).status,
  ).toBe("promoted");
  identity = {
    userId: account.user.id,
    organizationId: account.organization.id,
    e164: account.user.phone_number ?? "",
  };
  const minted = await signer.mintStewardTokenFromClaims(env, {
    userId: subject,
    authMethod: "sms",
    issuedAt: Math.floor(Date.now() / 1000),
    expiration: Math.floor(Date.now() / 1000) + 3600,
  });
  if (!minted) throw new Error("Synthetic fixture signer unavailable");
  smsToken = minted.token;
  const [
    { authMiddleware },
    { cookieMutationGuardMiddleware },
    { corsMiddleware },
    route,
  ] = await Promise.all([
    import("../../src/middleware/auth"),
    import("../../src/middleware/cookie-mutation-guard"),
    import("../../../shared/src/lib/cors/cloud-api-hono-cors"),
    import("./route"),
  ]);
  app.use("*", corsMiddleware);
  app.use("*", authMiddleware);
  app.use("*", cookieMutationGuardMiddleware);
  app.route("/api/auth/sso-bridge", route.default);
}, 30_000);

afterAll(async () => {
  await close?.();
  if (owned) await admin?.unsafe(`DROP DATABASE "${database}"`);
  await admin?.close();
  await postgres?.stop();
  if (originalDatabase === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabase;
});

async function post(
  path: string,
  body: Record<string, unknown>,
  options: {
    origin?: string;
    authorization?: string;
    env?: Record<string, unknown>;
    api?: string;
  } = {},
) {
  return app.request(
    `${options.api ?? apiOrigin}/api/auth/sso-bridge/${path}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: options.origin ?? loginOrigin,
        authorization: options.authorization ?? `Bearer ${smsToken}`,
        "cf-connecting-ip": `192.0.2.${ip++}`,
      },
      body: JSON.stringify(body),
    },
    { ...env, ...options.env },
  );
}
async function mint() {
  const result = await post("mint", {
    codeChallenge: challenge,
    destination: origin,
  });
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  const body = (await result.json()) as { code: string; expiresIn: number };
  expect(body.expiresIn).toBe(60);
  expect(body.code).toMatch(/^enso_[0-9a-f]{64}$/);
  return body.code;
}
function server(originOverride = origin) {
  return { origin: originOverride, authorization: `Bearer ${serverToken}` };
}

if (!postgres)
  console.warn(
    "[Network SSO real PG] SKIPPED: configure the existing ephemeral-Postgres test owner",
  );
test.skipIf(!postgres)(
  "staging SMS handoff preserves one primary identity, exact authority, atomic code and lifecycle fences",
  async () => {
    const code = await mint();
    const stored = (await db.select().from(codes))[0];
    expect(stored.claims.ssoBridgePhoneAccount).toEqual(identity);
    expect(JSON.stringify(stored)).not.toContain(smsToken);
    expect(stored.code_hash).not.toBe(code);
    expect(stored.code_challenge).not.toBe(verifier);
    expect(owner.looksLikeSsoBridgeCode(code)).toBe(false);
    expect(await owner.consumeSsoBridgeCode(code, verifier)).toBeNull();
    expect(
      (await post("exchange", { code, codeVerifier: verifier })).status,
    ).toBe(400);
    expect(
      (
        await post(
          "network-exchange",
          { code, codeVerifier: verifier },
          { origin, authorization: "Bearer invalid" },
        )
      ).status,
    ).toBe(403);
    expect((await db.select().from(codes)).length).toBe(1);
    const competing = await Promise.all(
      Array.from({ length: 8 }, () =>
        post("network-exchange", { code, codeVerifier: verifier }, server()),
      ),
    );
    expect(competing.filter((r) => r.status === 200)).toHaveLength(1);
    expect(competing.filter((r) => r.status === 401)).toHaveLength(7);
    const acceptedResponse = competing.find((r) => r.status === 200);
    if (!acceptedResponse) throw new Error("No canonical exchange won");
    expect(acceptedResponse.headers.get("cache-control")).toBe("no-store");
    const accepted = (await acceptedResponse.json()) as Record<string, unknown>;
    expect(Object.keys(accepted).sort()).toEqual([
      "e164",
      "expiresAt",
      "issuedAt",
      "organizationId",
      "stewardUserId",
      "userId",
    ]);
    expect(accepted).toMatchObject({ ...identity, stewardUserId: subject });
    expect((await post("network-validate", accepted, server())).status).toBe(
      200,
    );
    expect(
      (
        await post(
          "network-validate",
          { ...accepted, expiresAt: Date.now() - 1 },
          server(),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post(
          "network-validate",
          { ...accepted, e164: "+12125550195" },
          server(),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post(
          "network-validate",
          { ...accepted, issuedAt: Math.floor(Date.now() / 1000) + 30 },
          server(),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post(
          "network-exchange",
          { code, codeVerifier: verifier },
          server(),
        )
      ).status,
    ).toBe(401);

    for (const options of [
      { env: { NETWORK_SITE_AUTH_ENABLED: "false" } },
      { env: { ENVIRONMENT: "production", NODE_ENV: "development" } },
      { env: { ENVIRONMENT: undefined } },
      { env: { NETWORK_SITE_AUTH_SERVER_TOKEN: "short" } },
      { origin },
      { api: "http://127.0.0.1:54303" },
    ])
      expect(
        (
          await post(
            "mint",
            { codeChallenge: challenge, destination: origin },
            options,
          )
        ).status,
      ).toBe(403);
    expect(
      (
        await post("mint", {
          codeChallenge: challenge,
          destination: "https://slop.cash",
        })
      ).status,
    ).toBe(403);
    for (const authMethod of ["email", "wallet"]) {
      const token = await signer.mintStewardTokenFromClaims(env, {
        userId: subject,
        authMethod,
        issuedAt: Math.floor(Date.now() / 1000),
        expiration: Math.floor(Date.now() / 1000) + 3600,
      });
      if (!token) throw new Error("Synthetic fixture signer unavailable");
      expect(
        (
          await post(
            "mint",
            { codeChallenge: challenge, destination: origin },
            { authorization: `Bearer ${token.token}` },
          )
        ).status,
      ).toBe(403);
    }
    expect((await db.select().from(codes)).length).toBe(0);
    await db
      .update(users)
      .set({ phone_verified: false })
      .where(eq(users.id, identity.userId));
    expect(
      (await post("mint", { codeChallenge: challenge, destination: origin }))
        .status,
    ).toBe(403);
    await db
      .update(users)
      .set({ phone_verified: true })
      .where(eq(users.id, identity.userId));
    // A QA-tagged owner record is refused before persistence; this synthetic
    // shape is not presented as a real API-key-backed QA authentication proof.
    await expect(
      owner.issueSsoBridgeCode({
        claims: {
          userId: subject,
          authMethod: "sms",
          issuedAt: Math.floor(Date.now() / 1000),
          expiration: Math.floor(Date.now() / 1000) + 3600,
          stagingSessionBinding: {
            version: "v1",
            apiKeyId: randomUUID(),
            cloudUserId: identity.userId,
            organizationId: identity.organizationId,
            credentialFingerprint: "f".repeat(64),
            sessionIssuedAt: Math.floor(Date.now() / 1000),
            sessionMaxExpiresAt: Math.floor(Date.now() / 1000) + 3600,
          },
        },
        codeChallenge: challenge,
        destination: origin,
        phoneAccount: identity,
      }),
    ).rejects.toThrow("ordinary SMS session");

    // A carried original issuance must bound identity lifetime even if an older
    // stored token expiry was longer. Callback and revalidation share that cap.
    const carried = await mint();
    const carriedIssuedAt = Math.floor(Date.now() / 1000) - 1800;
    await db.update(codes).set({
      token_issued_at: new Date(carriedIssuedAt * 1000),
      token_expires_at: new Date(Date.now() + 7200_000),
    });
    const carriedExchange = await post(
      "network-exchange",
      { code: carried, codeVerifier: verifier },
      server(),
    );
    expect(carriedExchange.status).toBe(200);
    const carriedIdentity = (await carriedExchange.json()) as Record<
      string,
      unknown
    >;
    expect(carriedIdentity.expiresAt).toBe(
      (carriedIssuedAt + signer.STEWARD_ACCESS_TOKEN_TTL_SECONDS) * 1000,
    );
    expect(
      (await post("network-validate", carriedIdentity, server())).status,
    ).toBe(200);
    const pastWindow = await mint();
    await db
      .update(codes)
      .set({ token_issued_at: new Date(Date.now() - 3601_000) });
    expect(
      (
        await post(
          "network-exchange",
          { code: pastWindow, codeVerifier: verifier },
          server(),
        )
      ).status,
    ).toBe(401);

    const bound = await mint();
    expect(
      (
        await post(
          "network-exchange",
          { code: bound, codeVerifier: verifier },
          {
            ...server("http://127.0.0.1:54303"),
            env: { NETWORK_SITE_AUTH_ORIGIN: "http://127.0.0.1:54303" },
          },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await post(
          "network-exchange",
          { code: bound, codeVerifier: verifier },
          server(),
        )
      ).status,
    ).toBe(401);
    const changedPhone = await mint();
    await db
      .update(users)
      .set({ phone_number: "+12125550195" })
      .where(eq(users.id, identity.userId));
    expect(
      (
        await post(
          "network-exchange",
          { code: changedPhone, codeVerifier: verifier },
          server(),
        )
      ).status,
    ).toBe(403);
    await db
      .update(users)
      .set({ phone_number: identity.e164 })
      .where(eq(users.id, identity.userId));
    const deleted = await mint();
    await db
      .update(users)
      .set({ deleted_at: new Date() })
      .where(eq(users.id, identity.userId));
    expect(
      (
        await post(
          "network-exchange",
          { code: deleted, codeVerifier: verifier },
          server(),
        )
      ).status,
    ).toBe(403);
    await db
      .update(users)
      .set({ deleted_at: null })
      .where(eq(users.id, identity.userId));
    await db
      .update(organizations)
      .set({ is_active: false })
      .where(eq(organizations.id, identity.organizationId));
    expect((await post("network-validate", accepted, server())).status).toBe(
      403,
    );
    await db
      .update(organizations)
      .set({ is_active: true })
      .where(eq(organizations.id, identity.organizationId));
    const expired = await mint();
    await db.update(codes).set({ expires_at: new Date(0) });
    expect(
      (
        await post(
          "network-exchange",
          { code: expired, codeVerifier: verifier },
          server(),
        )
      ).status,
    ).toBe(401);
    const burn = await mint();
    expect((await post("burn", { code: burn })).status).toBe(204);
    expect(
      (
        await post(
          "network-exchange",
          { code: burn, codeVerifier: verifier },
          server(),
        )
      ).status,
    ).toBe(401);
    const wrongVerifier = await mint();
    expect(
      (
        await post(
          "network-exchange",
          { code: wrongVerifier, codeVerifier: "b".repeat(64) },
          server(),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await post(
          "network-exchange",
          { code: wrongVerifier, codeVerifier: verifier },
          server(),
        )
      ).status,
    ).toBe(401);

    const legacy = await post(
      "mint",
      { codeChallenge: challenge },
      { origin: "https://staging.eliza.app" },
    );
    expect(legacy.status).toBe(200);
    const legacyCode = ((await legacy.json()) as { code: string }).code;
    expect(legacyCode).toMatch(/^esso_[0-9a-f]{64}$/);
    expect(
      (
        await post(
          "network-exchange",
          { code: legacyCode, codeVerifier: verifier },
          server(),
        )
      ).status,
    ).toBe(401);
    const legacyExchange = await post("exchange", {
      code: legacyCode,
      codeVerifier: verifier,
    });
    expect(legacyExchange.status).toBe(200);
    expect(
      typeof ((await legacyExchange.json()) as { token?: unknown }).token,
    ).toBe("string");
    const loggedOut = await mint();
    await owner.markSsoBridgeLogout(subject);
    expect(
      (
        await post(
          "network-exchange",
          { code: loggedOut, codeVerifier: verifier },
          server(),
        )
      ).status,
    ).toBe(401);
    expect((await post("network-validate", accepted, server())).status).toBe(
      403,
    );
    expect(
      (await post("mint", { codeChallenge: challenge, destination: origin }))
        .status,
    ).toBe(401);
    await db.delete(logout);
    expect((await db.select().from(users)).length).toBe(1);
    expect((await db.select().from(organizations)).length).toBe(1);
  },
  30_000,
);
