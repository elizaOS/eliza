/**
 * Mobile key renewal against real SQL in PGlite: the real renew route, the
 * real renewal, issuance and acknowledgement services and the real grants
 * repository. Tables are built from the Drizzle schemas, then the real 0572
 * migration adds `session_started_at`.
 *
 * Synthetic parts: the credential row is published by the repository's
 * exchange with a locally generated secret (no KMS), the old key's revocation
 * is a direct tombstone (DELETE /api/v1/api-keys/current has its own suite),
 * and the shared limiter runs against an in-memory Redis stand-in.
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import * as realDb from "@elizaos/cloud-shared/db/client";
import { apiKeys } from "@elizaos/cloud-shared/db/schemas/api-keys";
import { apps } from "@elizaos/cloud-shared/db/schemas/apps";
import { organizations } from "@elizaos/cloud-shared/db/schemas/organizations";
import { users } from "@elizaos/cloud-shared/db/schemas/users";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { mobileAppAuthGrants } from "../../shared/src/db/schemas/mobile-app-auth-grants";

const OWNER = "22222222-2222-4222-8222-222222222222";
const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "11111111-1111-4111-8111-111111111112";
const APP = "44444444-4444-4444-8444-444444444444";
const CLIENT = {
  clientId: "ai.alphacompute.alphaphone",
  appId: APP,
  redirectUri: "https://eliza.app/alphaphone/auth/callback",
  enabled: true,
};
const DAY = 86_400_000;
const T0 = new Date("2026-01-01T00:00:00.000Z");

const pg = new PGlite();
const database = drizzle(pg);
const originalDb = { ...realDb };
mock.module("@elizaos/cloud-shared/db/client", () => ({
  ...originalDb,
  dbWrite: database,
  dbRead: database,
}));

const {
  acknowledgeMobileAppAuthCredential,
  authorizeMobileAppAuthRenewal,
  deriveMobileAppAuthS256Challenge,
  issueMobileAppAuthRenewalCode,
  MobileAppAuthRenewalError,
  issueMobileAppAuthCode,
  MOBILE_APP_AUTH_RENEWAL_CAP_SECONDS,
  resolveMobileAppAuthRegistration,
  sha256Hex,
} = await import("@elizaos/cloud-shared/lib/services/mobile-app-auth");
const { mobileAppAuthGrantsRepository } = await import(
  "../../shared/src/db/repositories/mobile-app-auth-grants"
);
const { buildMobileAppAuthCredentialProvenance } = await import(
  "../../shared/src/db/mobile-app-auth-credential-policy"
);
const { createMobileAppAuthRenewRoute } = await import(
  "../v1/app-auth/mobile/renew/route"
);
const { MOBILE_APP_AUTH_RENEW_CREDENTIAL_MAX } = await import(
  "../v1/app-auth/mobile/_rate-limit"
);

let clock = T0;
let registry: Record<string, unknown>[] = [CLIENT];
let limiter: "disabled" | "redis" | "missing" = "disabled";
const counters = new Map<string, number>();

/** The subset of the Redis client the limiter drives. */
function redisStandIn() {
  return {
    pipeline() {
      const steps: Array<() => number> = [];
      const chain = {
        incr(key: string) {
          steps.push(() => {
            const next = (counters.get(key) ?? 0) + 1;
            counters.set(key, next);
            return next;
          });
          return chain;
        },
        pttl() {
          steps.push(() => 60_000);
          return chain;
        },
        async exec() {
          return steps.map((step) => step());
        },
      };
      return chain;
    },
    async pexpire() {
      return 1;
    },
  };
}

const route = createMobileAppAuthRenewRoute({
  now: () => clock,
  rateLimit: {
    buildRedisClient: () =>
      (limiter === "redis" ? redisStandIn() : null) as never,
  },
});

function env(overrides: Record<string, unknown> = {}): AppEnv["Bindings"] {
  return {
    ENVIRONMENT: "production",
    NODE_ENV: "test",
    ELIZA_MOBILE_APP_AUTH_ENABLED: "true",
    ELIZA_MOBILE_APP_AUTH_APP_ID: "44444444-4444-4444-8444-4444444444ff",
    ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON: JSON.stringify(registry),
    ...(limiter === "disabled" && { RATE_LIMIT_DISABLED: "true" }),
    ...overrides,
  } as unknown as AppEnv["Bindings"];
}

function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  return {
    verifier,
    binding: {
      clientId: CLIENT.clientId,
      environment: "production",
      redirectUri: CLIENT.redirectUri,
      state: randomBytes(32).toString("base64url"),
      codeChallenge: deriveMobileAppAuthS256Challenge(verifier),
      codeChallengeMethod: "S256",
    },
  };
}

async function renew(
  secret: string | null,
  body: unknown,
  options: {
    env?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {},
) {
  const response = await route.fetch(
    new Request("https://fixture.example.test/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "198.51.100.7",
        ...(secret && { authorization: `Bearer ${secret}` }),
        ...options.headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env(options.env),
    {
      props: {},
      waitUntil() {},
      passThroughOnException() {},
    } as never,
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

interface Held {
  secret: string;
  credentialId: string;
  grantId: string;
}

/** Exchange and acknowledge a code the way the phone does after either flow. */
async function redeem(
  code: string,
  attempt: ReturnType<typeof pkce>,
): Promise<Held> {
  const registration = resolveMobileAppAuthRegistration(env(), CLIENT.clientId);
  const state = await mobileAppAuthGrantsRepository.findStateByCodeHash(
    sha256Hex(code),
  );
  if (!state) throw new Error("issued grant is missing");
  const secret = `eliza_mobile_${randomBytes(32).toString("hex")}`;
  const credentialId = randomUUID();
  const exchanged = await mobileAppAuthGrantsRepository.exchange(
    {
      codeHash: sha256Hex(code),
      appId: APP,
      clientId: CLIENT.clientId,
      environment: "production",
      redirectUri: CLIENT.redirectUri,
      stateHash: sha256Hex(attempt.binding.state),
      codeChallenge: attempt.binding.codeChallenge,
    },
    {
      id: credentialId,
      ...buildMobileAppAuthCredentialProvenance({
        grantId: state.grant.id,
        environment: state.grant.environment,
        deviceName: state.grant.device_name,
        clientId: state.grant.client_id,
        scopes: state.grant.scopes,
      }),
      user_id: state.grant.user_id,
      organization_id: state.grant.organization_id,
      source_app_id: APP,
      key_hash: sha256Hex(secret),
      key_prefix: secret.slice(0, 20),
      is_active: false,
      expires_at: new Date(
        clock.getTime() + registration.credentialTtlSeconds * 1000,
      ),
    },
    clock,
  );
  expect(exchanged.kind).toBe("created");
  const acknowledged = await acknowledgeMobileAppAuthCredential({
    registration,
    binding: {
      clientId: CLIENT.clientId,
      environment: "production",
      redirectUri: CLIENT.redirectUri,
      state: attempt.binding.state,
    },
    code,
    codeVerifier: attempt.verifier,
    credentialId,
    secret,
    now: clock,
  });
  expect(acknowledged.status).toBe("acknowledged");
  return { secret, credentialId, grantId: state.grant.id };
}

/** A browser-approved sign-in that ends with an acknowledged key. */
async function signIn(): Promise<Held> {
  const attempt = pkce();
  const issued = await issueMobileAppAuthCode({
    registration: resolveMobileAppAuthRegistration(env(), CLIENT.clientId),
    userId: OWNER,
    organizationId: ORG,
    binding: attempt.binding,
    now: clock,
  });
  return await redeem(issued.code, attempt);
}

async function grantRow(id: string) {
  const { rows } = await pg.query<{
    session_started_at: Date | null;
    status: string;
    credential_id: string | null;
  }>(
    "SELECT session_started_at,status,credential_id FROM mobile_app_auth_grants WHERE id=$1",
    [id],
  );
  return rows[0];
}

async function grantCount(): Promise<number> {
  const { rows } = await pg.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM mobile_app_auth_grants",
  );
  return rows[0].n;
}

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const migration = readFileSync(
  new URL(
    "../../shared/src/db/migrations/0572_mobile_app_auth_session_start.sql",
    import.meta.url,
  ),
  "utf8",
);

beforeAll(async () => {
  const enums = new Set<string>();
  for (const table of [
    organizations,
    users,
    apiKeys,
    apps,
    mobileAppAuthGrants,
  ]) {
    const config = getTableConfig(table);
    for (const column of config.columns) {
      const definition = (
        column as unknown as {
          enum?: { enumName: string; enumValues: string[] };
        }
      ).enum;
      if (definition && !enums.has(definition.enumName)) {
        await pg.exec(
          `CREATE TYPE ${quote(definition.enumName)} AS ENUM (${definition.enumValues.map((v) => `'${v.replaceAll("'", "''")}'`).join(",")})`,
        );
        enums.add(definition.enumName);
      }
    }
    await pg.exec(
      `CREATE TABLE ${quote(config.name)} (${config.columns
        .filter((column) => column.name !== "session_started_at")
        .map(
          (c) =>
            `${quote(c.name)} ${c.getSQLType()}${c.primary ? " PRIMARY KEY" : ""}`,
        )
        .join(",")})`,
    );
  }
  await pg.exec(`
    ALTER TABLE mobile_app_auth_grants ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE mobile_app_auth_grants ALTER COLUMN created_at SET DEFAULT now();
    ALTER TABLE mobile_app_auth_grants ALTER COLUMN updated_at SET DEFAULT now();
  `);
  await pg.exec(migration);
});

beforeEach(async () => {
  clock = T0;
  registry = [CLIENT];
  limiter = "disabled";
  counters.clear();
  await pg.exec(
    "TRUNCATE mobile_app_auth_grants, apps, api_keys, users, organizations",
  );
  for (const id of [ORG, OTHER_ORG]) {
    await pg.query(
      "INSERT INTO organizations(id,is_active,account_lifecycle_state) VALUES($1,true,'active')",
      [id],
    );
  }
  await pg.query(
    "INSERT INTO users(id,organization_id,is_active,account_lifecycle_state) VALUES($1,$2,true,'active')",
    [OWNER, ORG],
  );
  await pg.query(
    "INSERT INTO apps(id,is_active,is_approved) VALUES($1,true,true)",
    [APP],
  );
});

afterAll(async () => {
  mock.module("@elizaos/cloud-shared/db/client", () => originalDb);
  mock.restore();
  await pg.close();
});

test("the real migration adds a nullable sign-in time and can be applied again", async () => {
  await pg.exec(migration);
  const { rows } = await pg.query<{ data_type: string; is_nullable: string }>(
    "SELECT data_type,is_nullable FROM information_schema.columns WHERE table_name='mobile_app_auth_grants' AND column_name='session_started_at'",
  );
  expect(rows).toEqual([
    { data_type: "timestamp with time zone", is_nullable: "YES" },
  ]);
});

test("an acknowledged key renews into a successor that keeps the sign-in time", async () => {
  const first = await signIn();
  expect((await grantRow(first.grantId)).session_started_at).toEqual(T0);

  // Twenty-two days later the phone has under ten days left.
  clock = new Date(T0.getTime() + 22 * DAY);
  const attempt = pkce();
  const answer = await renew(first.secret, {
    ...attempt.binding,
    deviceName: "Pixel 9",
  });
  expect(answer.status).toBe(200);
  expect(answer.body).toEqual({
    success: true,
    code: expect.stringMatching(/^emac_[0-9a-f]{64}$/),
    codeType: "mobile_app_auth_code",
    expiresAt: new Date(clock.getTime() + 300_000).toISOString(),
    expiresIn: 300,
  });

  const second = await redeem(String(answer.body.code), attempt);
  expect(second.credentialId).not.toBe(first.credentialId);
  expect(await grantRow(second.grantId)).toEqual({
    session_started_at: T0,
    status: "acknowledged",
    credential_id: second.credentialId,
  });
  const { rows } = await pg.query<{
    id: string;
    is_active: boolean;
    expires_at: Date;
  }>("SELECT id,is_active,expires_at FROM api_keys ORDER BY expires_at");
  // The old key stays usable until the phone revokes it; the successor has a
  // full lifetime counted from the renewal.
  expect(rows).toEqual([
    {
      id: first.credentialId,
      is_active: true,
      expires_at: new Date(T0.getTime() + 30 * DAY),
    },
    {
      id: second.credentialId,
      is_active: true,
      expires_at: new Date(clock.getTime() + 30 * DAY),
    },
  ]);

  // The successor renews in turn and still counts from the first sign-in.
  clock = new Date(T0.getTime() + 45 * DAY);
  const next = pkce();
  const third = await renew(second.secret, next.binding, {
    headers: { authorization: "", "x-api-key": second.secret },
  });
  expect(third.status).toBe(200);
  const held = await redeem(String(third.body.code), next);
  expect((await grantRow(held.grantId)).session_started_at).toEqual(T0);
});

test("both credential headers are accepted only when they carry the same key", async () => {
  const first = await signIn();
  const other = `eliza_mobile_${"a".repeat(64)}`;
  expect(
    (
      await renew(first.secret, pkce().binding, {
        headers: { "x-api-key": first.secret },
      })
    ).status,
  ).toBe(200);
  const mixed = await renew(first.secret, pkce().binding, {
    headers: { "x-api-key": other },
  });
  expect(mixed.status).toBe(401);
  expect(mixed.body.code).toBe("authentication_required");
});

test("an expired, unacknowledged, revoked, unknown or non-mobile key is refused with 401", async () => {
  const first = await signIn();
  const before = await grantCount();
  const refused = async (secret: string | null) => {
    const answer = await renew(secret, pkce().binding);
    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({
      success: false,
      code: "authentication_required",
    });
  };

  await refused(null);
  await refused(`eliza_${"b".repeat(64)}`);
  await refused(`eliza_mobile_${"c".repeat(64)}`);

  // Expired: the instant the key's lifetime ends.
  clock = new Date(T0.getTime() + 30 * DAY);
  await refused(first.secret);
  clock = new Date(T0.getTime() + 30 * DAY - 1);
  expect((await renew(first.secret, pkce().binding)).status).toBe(200);
  clock = T0;

  // Exchanged but never acknowledged.
  await pg.query(
    "UPDATE mobile_app_auth_grants SET status='exchanged' WHERE id=$1",
    [first.grantId],
  );
  await refused(first.secret);
  await pg.query(
    "UPDATE mobile_app_auth_grants SET status='acknowledged' WHERE id=$1",
    [first.grantId],
  );

  // Deactivated without a tombstone, then tombstoned.
  await pg.query("UPDATE api_keys SET is_active=false WHERE id=$1", [
    first.credentialId,
  ]);
  await refused(first.secret);
  await pg.query(
    "UPDATE api_keys SET is_active=true,deleted_at=now() WHERE id=$1",
    [first.credentialId],
  );
  await refused(first.secret);

  // Only the one successful request above created a grant.
  expect(await grantCount()).toBe(before + 1);
});

test("a disabled, removed or re-registered client is refused with 401", async () => {
  const first = await signIn();
  const before = await grantCount();
  const refused = async (overrides: Record<string, unknown> = {}) => {
    const answer = await renew(first.secret, pkce().binding, {
      env: overrides,
    });
    expect(answer.status).toBe(401);
    expect(answer.body.code).toBe("authentication_required");
  };

  registry = [{ ...CLIENT, enabled: false }];
  await refused();
  registry = [];
  await refused();
  registry = [
    { ...CLIENT, redirectUri: "https://eliza.app/other/auth/callback" },
  ];
  await refused();
  registry = [{ ...CLIENT, appId: "44444444-4444-4444-8444-444444444445" }];
  await refused();
  registry = [CLIENT];
  await refused({ ENVIRONMENT: "staging" });

  await pg.query("UPDATE apps SET is_active=false WHERE id=$1", [APP]);
  await refused();
  await pg.query(
    "UPDATE apps SET is_active=true,is_approved=false WHERE id=$1",
    [APP],
  );
  await refused();
  await pg.query("UPDATE apps SET is_approved=true WHERE id=$1", [APP]);

  // A switched-off or unreadable server configuration is an outage to retry,
  // never a revoked key.
  for (const overrides of [
    { ELIZA_MOBILE_APP_AUTH_ENABLED: "false" },
    { ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON: "{not json" },
  ]) {
    const answer = await renew(first.secret, pkce().binding, {
      env: overrides,
    });
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({
      code: "service_unavailable",
      retryAfterSeconds: 30,
    });
  }
  expect(await grantCount()).toBe(before);
  expect((await renew(first.secret, pkce().binding)).status).toBe(200);
});

test("a key whose owner moved organization, was deactivated or whose organization closed is refused with 403", async () => {
  const first = await signIn();
  const before = await grantCount();
  const refused = async () => {
    const answer = await renew(first.secret, pkce().binding);
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({
      success: false,
      code: "access_denied",
    });
  };

  await pg.query("UPDATE users SET organization_id=$1 WHERE id=$2", [
    OTHER_ORG,
    OWNER,
  ]);
  await refused();
  await pg.query("UPDATE users SET organization_id=NULL WHERE id=$1", [OWNER]);
  await refused();
  await pg.query(
    "UPDATE users SET organization_id=$1,is_active=false WHERE id=$2",
    [ORG, OWNER],
  );
  await refused();
  await pg.query("UPDATE users SET is_active=true WHERE id=$1", [OWNER]);

  await pg.query("UPDATE organizations SET is_active=false WHERE id=$1", [ORG]);
  await refused();
  await pg.query(
    "UPDATE organizations SET is_active=true,account_lifecycle_state='deletion_recovery' WHERE id=$1",
    [ORG],
  );
  await refused();
  await pg.query(
    "UPDATE organizations SET account_lifecycle_state='active',account_deletion_request_id=$2 WHERE id=$1",
    [ORG, randomUUID()],
  );
  await refused();
  await pg.query(
    "UPDATE organizations SET account_deletion_request_id=NULL WHERE id=$1",
    [ORG],
  );

  expect(await grantCount()).toBe(before);
  expect((await renew(first.secret, pkce().binding)).status).toBe(200);
});

test("renewal stops with 409 once the sign-in is older than the 180-day cap", async () => {
  expect(MOBILE_APP_AUTH_RENEWAL_CAP_SECONDS).toBe(180 * 86_400);
  let held = await signIn();
  // Renew every 25 days; each successor lives 30 days from its renewal.
  for (let day = 25; day <= 175; day += 25) {
    clock = new Date(T0.getTime() + day * DAY);
    const attempt = pkce();
    const answer = await renew(held.secret, attempt.binding);
    expect(answer.status).toBe(200);
    held = await redeem(String(answer.body.code), attempt);
    expect((await grantRow(held.grantId)).session_started_at).toEqual(T0);
  }

  // The last instant of the cap still renews; one millisecond later does not.
  clock = new Date(T0.getTime() + 180 * DAY);
  expect((await renew(held.secret, pkce().binding)).status).toBe(200);
  const before = await grantCount();
  clock = new Date(T0.getTime() + 180 * DAY + 1);
  const closed = await renew(held.secret, pkce().binding);
  expect(closed.status).toBe(409);
  expect(closed.body).toMatchObject({
    success: false,
    code: "renewal_window_closed",
  });
  expect(await grantCount()).toBe(before);

  // The key itself is still valid until it expires (day 205); only renewal is closed.
  const { rows } = await pg.query<{ expires_at: Date }>(
    "SELECT expires_at FROM api_keys WHERE id=$1",
    [held.credentialId],
  );
  expect(rows[0].expires_at).toEqual(new Date(T0.getTime() + 205 * DAY));
});

test("a grant from before the column counts the cap from its creation", async () => {
  const first = await signIn();
  await pg.query(
    "UPDATE mobile_app_auth_grants SET session_started_at=NULL,created_at=$2 WHERE id=$1",
    [first.grantId, new Date(T0.getTime() - 170 * DAY)],
  );
  clock = new Date(T0.getTime() + 10 * DAY);
  const attempt = pkce();
  const answer = await renew(first.secret, attempt.binding);
  expect(answer.status).toBe(200);
  const successor = await redeem(String(answer.body.code), attempt);
  expect((await grantRow(successor.grantId)).session_started_at).toEqual(
    new Date(T0.getTime() - 170 * DAY),
  );

  clock = new Date(T0.getTime() + 10 * DAY + 1);
  expect((await renew(first.secret, pkce().binding)).status).toBe(409);
  expect((await renew(successor.secret, pkce().binding)).status).toBe(409);
});

test("a replayed renewal cannot extend the cap, and a revoked predecessor cannot renew again", async () => {
  const first = await signIn();
  clock = new Date(T0.getTime() + 21 * DAY);
  const attempt = pkce();

  // The same request twice (a lost reply) yields two independent codes that
  // both carry the original sign-in time.
  const one = await renew(first.secret, attempt.binding);
  const two = await renew(first.secret, attempt.binding);
  expect([one.status, two.status]).toEqual([200, 200]);
  expect(one.body.code).not.toBe(two.body.code);
  const { rows } = await pg.query<{ session_started_at: Date; status: string }>(
    "SELECT session_started_at,status FROM mobile_app_auth_grants WHERE id<>$1",
    [first.grantId],
  );
  expect(rows).toEqual([
    { session_started_at: T0, status: "pending" },
    { session_started_at: T0, status: "pending" },
  ]);

  // A renewal code is single-credential like any other: acknowledging it
  // twice returns the same receipt and mints nothing new.
  const successor = await redeem(String(one.body.code), attempt);
  const registration = resolveMobileAppAuthRegistration(env(), CLIENT.clientId);
  const again = await acknowledgeMobileAppAuthCredential({
    registration,
    binding: {
      clientId: CLIENT.clientId,
      environment: "production",
      redirectUri: CLIENT.redirectUri,
      state: attempt.binding.state,
    },
    code: String(one.body.code),
    codeVerifier: attempt.verifier,
    credentialId: successor.credentialId,
    secret: successor.secret,
    now: clock,
  });
  expect(again.credentialId).toBe(successor.credentialId);
  const keys = await pg.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM api_keys",
  );
  expect(keys.rows[0].n).toBe(2);

  // The phone revokes the predecessor; replaying its renewal is now a 401.
  await pg.query(
    "UPDATE api_keys SET is_active=false,deleted_at=$2 WHERE id=$1",
    [first.credentialId, clock],
  );
  const replay = await renew(first.secret, attempt.binding);
  expect(replay.status).toBe(401);
  expect(replay.body.code).toBe("authentication_required");
  expect((await renew(successor.secret, pkce().binding)).status).toBe(200);
});

test("a key revoked or a client deactivated after authorization issues no code", async () => {
  const first = await signIn();
  const before = await grantCount();
  const refusal = async () => {
    const authorization = await authorizeMobileAppAuthRenewal({
      env: env(),
      secret: first.secret,
      now: clock,
    });
    return async () => {
      try {
        await issueMobileAppAuthRenewalCode({
          authorization,
          binding: pkce().binding,
          now: clock,
        });
      } catch (error) {
        if (error instanceof MobileAppAuthRenewalError) return error.refusal;
        throw error;
      }
      return "issued";
    };
  };

  // The revocation commits between the authority read and the issuing write.
  let issue = await refusal();
  await pg.query(
    "UPDATE api_keys SET is_active=false,deleted_at=$2 WHERE id=$1",
    [first.credentialId, clock],
  );
  expect(await issue()).toBe("credential_invalid");
  await pg.query(
    "UPDATE api_keys SET is_active=true,deleted_at=NULL WHERE id=$1",
    [first.credentialId],
  );

  issue = await refusal();
  await pg.query("UPDATE apps SET is_active=false WHERE id=$1", [APP]);
  expect(await issue()).toBe("client_unavailable");
  await pg.query("UPDATE apps SET is_active=true WHERE id=$1", [APP]);

  // The cap is counted at the request's own time, also when issuing.
  issue = await refusal();
  await pg.query("UPDATE api_keys SET expires_at=$2 WHERE id=$1", [
    first.credentialId,
    new Date(T0.getTime() + 400 * DAY),
  ]);
  clock = new Date(T0.getTime() + 180 * DAY + 1);
  expect(await issue()).toBe("renewal_window_closed");
  clock = T0;

  expect(await grantCount()).toBe(before);
  expect(await (await refusal())()).toBe("issued");
});

test("a malformed renewal body is a 400 and creates nothing", async () => {
  const first = await signIn();
  const before = await grantCount();
  const { binding } = pkce();
  for (const body of [
    "{not json",
    { ...binding, flow: "mobile_pkce" },
    { ...binding, codeChallengeMethod: "plain" },
    { ...binding, codeChallenge: "short" },
    { ...binding, state: "bad state" },
    { ...binding, deviceName: "bad\u0007name" },
    { ...binding, clientId: "ai.elizaos.app" },
    { ...binding, environment: "staging" },
    { ...binding, redirectUri: "https://eliza.app/auth/callback" },
    { clientId: binding.clientId },
  ]) {
    const answer = await renew(first.secret, body);
    expect(answer.status).toBe(400);
    expect(answer.body.code).toBe("validation_error");
  }
  // An unauthenticated caller learns nothing about the body.
  expect((await renew(null, "{not json")).status).toBe(401);
  expect(await grantCount()).toBe(before);
});

test("one credential is limited with 429, and a missing limiter store is a retryable 503", async () => {
  const first = await signIn();
  limiter = "redis";
  for (let i = 0; i < MOBILE_APP_AUTH_RENEW_CREDENTIAL_MAX; i++) {
    expect((await renew(first.secret, pkce().binding)).status).toBe(200);
  }
  const before = await grantCount();
  const limited = await renew(first.secret, pkce().binding);
  expect(limited.status).toBe(429);
  expect(limited.body).toMatchObject({
    success: false,
    code: "rate_limit_exceeded",
    retryAfterSeconds: expect.any(Number),
  });

  limiter = "missing";
  const unavailable = await renew(first.secret, pkce().binding);
  expect(unavailable.status).toBe(503);
  expect(unavailable.body).toMatchObject({
    success: false,
    code: "service_unavailable",
  });
  expect(await grantCount()).toBe(before);
});
