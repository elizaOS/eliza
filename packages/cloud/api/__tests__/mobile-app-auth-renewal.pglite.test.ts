/**
 * Mobile key renewal against real SQL in PGlite: the real renew route, the
 * real renewal, issuance and acknowledgement services and the real grants
 * repository. Tables are built from the Drizzle schemas, then the real 0572
 * and 0573 migrations add `session_started_at`, `session_id` and
 * `renewed_from_credential_id`. Revocation goes through the real credential
 * service, and the renewal's last step through the real
 * DELETE /api/v1/api-keys/current route.
 *
 * Synthetic parts: the credential row is published by the repository's
 * exchange with a locally generated secret (no KMS) and the service's own
 * expiry rule, the inference revocation boundary is not bound (the service
 * skips it), and the shared limiter runs against an in-memory Redis stand-in.
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import * as realDb from "@elizaos/cloud-shared/db/client";
import { apiKeys } from "@elizaos/cloud-shared/db/schemas/api-keys";
import { apps } from "@elizaos/cloud-shared/db/schemas/apps";
import { authEvents } from "@elizaos/cloud-shared/db/schemas/auth-events";
import { organizations } from "@elizaos/cloud-shared/db/schemas/organizations";
import { users } from "@elizaos/cloud-shared/db/schemas/users";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { mobileAppAuthClients } from "../../shared/src/db/schemas/mobile-app-auth-clients";
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

process.env.MOCK_REDIS = "1";

const pg = new PGlite();
const database = drizzle(pg, { schema: { apiKeys } });
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
  mobileCredentialExpiry,
  resolveMobileAppAuthRegistration,
  sha256Hex,
} = await import("@elizaos/cloud-shared/lib/services/mobile-app-auth");
const { mobileAppAuthGrantsRepository, MOBILE_RENEWAL_RETIREMENT_GRACE_MS } =
  await import("../../shared/src/db/repositories/mobile-app-auth-grants");
const { buildMobileAppAuthCredentialProvenance } = await import(
  "../../shared/src/db/mobile-app-auth-credential-policy"
);
const { createMobileAppAuthRenewRoute } = await import(
  "../v1/app-auth/mobile/renew/route"
);
const { apiKeysService } = await import(
  "@elizaos/cloud-shared/lib/services/api-keys"
);
const { default: currentKeyRoute } = await import(
  "../v1/api-keys/current/route"
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

/** Exchange a code for an inactive credential, as `mobile/token` does. */
async function exchange(code: string, attempt: ReturnType<typeof pkce>) {
  const registration = resolveMobileAppAuthRegistration(env(), CLIENT.clientId);
  const state = await mobileAppAuthGrantsRepository.findStateByCodeHash(
    sha256Hex(code),
  );
  if (!state) throw new Error("issued grant is missing");
  const secret = `eliza_mobile_${randomBytes(32).toString("hex")}`;
  const credentialId = randomUUID();
  const claim = await mobileAppAuthGrantsRepository.exchange(
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
      // The service's own expiry rule, as `mobile/token` applies it.
      expires_at: mobileCredentialExpiry(
        state.grant,
        clock,
        registration.credentialTtlSeconds,
      ),
    },
    clock,
  );
  return { claim, held: { secret, credentialId, grantId: state.grant.id } };
}

/** Acknowledge an exchanged credential, as `mobile/ack` does. */
async function acknowledge(
  code: string,
  attempt: ReturnType<typeof pkce>,
  held: Held,
) {
  return await acknowledgeMobileAppAuthCredential({
    registration: resolveMobileAppAuthRegistration(env(), CLIENT.clientId),
    binding: {
      clientId: CLIENT.clientId,
      environment: "production",
      redirectUri: CLIENT.redirectUri,
      state: attempt.binding.state,
    },
    code,
    codeVerifier: attempt.verifier,
    credentialId: held.credentialId,
    secret: held.secret,
    now: clock,
  });
}

/** Exchange and acknowledge a code the way the phone does after either flow. */
async function redeem(
  code: string,
  attempt: ReturnType<typeof pkce>,
): Promise<Held> {
  const { claim, held } = await exchange(code, attempt);
  expect(claim.kind).toBe("created");
  expect((await acknowledge(code, attempt, held)).status).toBe("acknowledged");
  return held;
}

/** The protocol refusal of an exchange or acknowledgement, or "accepted". */
async function protocolRefusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const code = (error as { protocolCode?: unknown }).protocolCode;
    if (typeof code === "string") return code;
    throw error;
  }
  return "accepted";
}

/** Which of these credentials are usable keys right now. */
async function live(...held: Held[]): Promise<boolean[]> {
  const { rows } = await pg.query<{ id: string }>(
    "SELECT id FROM api_keys WHERE is_active AND deleted_at IS NULL AND expires_at > $1",
    [clock],
  );
  const ids = new Set(rows.map((row) => row.id));
  return held.map((key) => ids.has(key.credentialId));
}

/** DELETE /api/v1/api-keys/current through the real route. */
async function revokeCurrent(headers: Record<string, string>) {
  const response = await currentKeyRoute.fetch(
    new Request("https://fixture.example.test/", {
      method: "DELETE",
      headers: { "cf-connecting-ip": "198.51.100.7", ...headers },
    }),
    env(),
    { props: {}, waitUntil() {}, passThroughOnException() {} } as never,
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/** The header with which a renewal's last step names the new key. */
const renewedInto = (successor: Held) => ({
  "x-renewed-credential-id": successor.credentialId,
});

/**
 * Moves a key's acknowledgement to `ms` before the wall clock. The
 * self-revocation route decides at the wall clock, while this suite drives
 * sign-in and renewal with its own clock.
 */
async function acknowledgedAgo(held: Held, ms: number): Promise<void> {
  const moved = await pg.query(
    "UPDATE mobile_app_auth_grants SET acknowledged_at=$1 WHERE credential_id=$2 AND status='acknowledged'",
    [new Date(Date.now() - ms), held.credentialId],
  );
  expect(moved.affectedRows).toBe(1);
}

/** A renewal from request to acknowledged successor. */
async function renewInto(from: Held): Promise<Held> {
  const attempt = pkce();
  const answer = await renew(from.secret, attempt.binding);
  expect(answer.status).toBe(200);
  return await redeem(String(answer.body.code), attempt);
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
const migration = [
  "0572_mobile_app_auth_session_start",
  "0573_mobile_app_auth_renewal_lineage",
]
  .map((tag) =>
    readFileSync(
      new URL(`../../shared/src/db/migrations/${tag}.sql`, import.meta.url),
      "utf8",
    ),
  )
  .join("\n");
const MIGRATED_COLUMNS = new Set([
  "session_started_at",
  "session_id",
  "renewed_from_credential_id",
]);

beforeAll(async () => {
  const enums = new Set<string>();
  for (const table of [
    organizations,
    users,
    apiKeys,
    apps,
    authEvents,
    mobileAppAuthGrants,
    mobileAppAuthClients,
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
        .filter(
          (column) =>
            table !== mobileAppAuthGrants || !MIGRATED_COLUMNS.has(column.name),
        )
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
    "TRUNCATE mobile_app_auth_grants, mobile_app_auth_clients, apps, api_keys, users, organizations, auth_events",
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

test("the real migrations add nullable lineage columns and can be applied again", async () => {
  await pg.exec(migration);
  const { rows } = await pg.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    "SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_name='mobile_app_auth_grants' AND column_name = ANY($1) ORDER BY column_name",
    [[...MIGRATED_COLUMNS]],
  );
  expect(rows).toEqual([
    {
      column_name: "renewed_from_credential_id",
      data_type: "uuid",
      is_nullable: "YES",
    },
    { column_name: "session_id", data_type: "uuid", is_nullable: "YES" },
    {
      column_name: "session_started_at",
      data_type: "timestamp with time zone",
      is_nullable: "YES",
    },
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
  // The successor joins the sign-in's session and names the key that asked.
  const lineage = await pg.query<{
    id: string;
    session_id: string | null;
    renewed_from_credential_id: string | null;
  }>(
    "SELECT id,session_id,renewed_from_credential_id FROM mobile_app_auth_grants ORDER BY created_at,id",
  );
  const sessionOf = (grantId: string) =>
    lineage.rows.find((row) => row.id === grantId);
  expect(sessionOf(first.grantId)?.session_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(sessionOf(first.grantId)?.renewed_from_credential_id).toBeNull();
  expect(sessionOf(second.grantId)).toMatchObject({
    session_id: sessionOf(first.grantId)?.session_id,
    renewed_from_credential_id: first.credentialId,
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

test("both credential headers are accepted only when they carry the same key, on renewal and on self-revocation", async () => {
  const first = await signIn();
  const other = `eliza_mobile_${"a".repeat(64)}`;
  const before = await grantCount();
  // Two different keys are ambiguous on both routes.
  const mixed = await renew(first.secret, pkce().binding, {
    headers: { "x-api-key": other },
  });
  expect(mixed.status).toBe(401);
  expect(mixed.body.code).toBe("authentication_required");
  expect(await grantCount()).toBe(before);
  const mixedRevoke = await revokeCurrent({
    authorization: `Bearer ${first.secret}`,
    "x-api-key": other,
  });
  expect(mixedRevoke.status).toBe(401);
  expect(await live(first)).toEqual([true]);

  // The same key in both headers is what the Cloud SDK sends. A whole
  // renewal, its last step included, works that way.
  const both = (held: Held) => ({
    authorization: `Bearer ${held.secret}`,
    "x-api-key": held.secret,
  });
  const attempt = pkce();
  const answer = await renew(first.secret, attempt.binding, {
    headers: both(first),
  });
  expect(answer.status).toBe(200);
  const successor = await redeem(String(answer.body.code), attempt);
  const revoked = await revokeCurrent({
    ...both(first),
    ...renewedInto(successor),
  });
  expect(revoked.status).toBe(200);
  expect(revoked.body).toMatchObject({
    success: true,
    credentialId: first.credentialId,
    status: "revoked",
  });
  expect(await live(first, successor)).toEqual([false, true]);
  // A lost reply is retried with the same headers and gets the same receipt.
  expect(
    (await revokeCurrent({ ...both(first), ...renewedInto(successor) })).body,
  ).toMatchObject({
    credentialId: first.credentialId,
    status: "revoked",
  });
  expect(await live(successor)).toEqual([true]);

  // Either header alone works on both routes too.
  const next = pkce();
  const viaHeader = await renew(null, next.binding, {
    headers: { "x-api-key": successor.secret },
  });
  expect(viaHeader.status).toBe(200);
  const third = await redeem(String(viaHeader.body.code), next);
  expect(
    (
      await revokeCurrent({
        "x-api-key": successor.secret,
        ...renewedInto(third),
      })
    ).status,
  ).toBe(200);
  expect(await live(successor, third)).toEqual([false, true]);
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

// Changed on purpose: a renewed key used to get a full lifetime, so the last
// key of a sign-in lived until day 205. No key now outlives the 180-day cap.
test("renewal stops with 409 at the 180-day cap, and no key outlives it", async () => {
  expect(MOBILE_APP_AUTH_RENEWAL_CAP_SECONDS).toBe(180 * 86_400);
  const expiry = async (held: Held) =>
    (
      await pg.query<{ expires_at: Date }>(
        "SELECT expires_at FROM api_keys WHERE id=$1",
        [held.credentialId],
      )
    ).rows[0].expires_at;
  let held = await signIn();
  // Renew every 20 days; each successor lives 30 days from its renewal.
  for (let day = 20; day <= 140; day += 20) {
    clock = new Date(T0.getTime() + day * DAY);
    held = await renewInto(held);
    expect((await grantRow(held.grantId)).session_started_at).toEqual(T0);
    expect(await expiry(held)).toEqual(new Date(clock.getTime() + 30 * DAY));
  }

  // Day 160: the successor would live to day 190 and is cut at day 180.
  clock = new Date(T0.getTime() + 160 * DAY);
  held = await renewInto(held);
  expect(await expiry(held)).toEqual(new Date(T0.getTime() + 180 * DAY));

  // That key already lives to the cap: a further renewal could not extend it.
  const before = await grantCount();
  clock = new Date(T0.getTime() + 171 * DAY);
  const closed = await renew(held.secret, pkce().binding);
  expect(closed.status).toBe(409);
  expect(closed.body).toMatchObject({
    success: false,
    code: "renewal_window_closed",
  });
  expect(await grantCount()).toBe(before);
  // It stays a valid key until the cap, and is an expired one from then on.
  clock = new Date(T0.getTime() + 180 * DAY - 1);
  expect(await live(held)).toEqual([true]);
  expect((await renew(held.secret, pkce().binding)).status).toBe(409);
  clock = new Date(T0.getTime() + 180 * DAY);
  expect(await live(held)).toEqual([false]);
  expect((await renew(held.secret, pkce().binding)).status).toBe(401);
});

test("the credential expiry rule never passes the sign-in's cap", () => {
  const ttl = 30 * 86_400;
  const at = (day: number) => new Date(T0.getTime() + day * DAY);
  const grant = { session_started_at: T0, created_at: at(170) };
  expect(mobileCredentialExpiry(grant, at(0), ttl)).toEqual(at(30));
  expect(mobileCredentialExpiry(grant, at(150), ttl)).toEqual(at(180));
  expect(mobileCredentialExpiry(grant, at(179.9), ttl)).toEqual(at(180));
  // A client registered with the longest lifetime is cut the same way.
  expect(mobileCredentialExpiry(grant, at(179.9), 90 * 86_400)).toEqual(
    at(180),
  );
  // Past the cap nothing is left, which the exchange refuses.
  expect(mobileCredentialExpiry(grant, at(181), ttl) <= at(181)).toBe(true);
  // A grant from before the column counts from its creation.
  expect(
    mobileCredentialExpiry(
      { session_started_at: null, created_at: T0 },
      at(170),
      ttl,
    ),
  ).toEqual(at(180));
});

test("a key issued before the clamp that outlives the cap is refused with 409 once the cap passes", async () => {
  const first = await signIn();
  await pg.query("UPDATE api_keys SET expires_at=$2 WHERE id=$1", [
    first.credentialId,
    new Date(T0.getTime() + 205 * DAY),
  ]);
  for (const day of [170, 180, 181]) {
    clock = new Date(T0.getTime() + day * DAY);
    const closed = await renew(first.secret, pkce().binding);
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe("renewal_window_closed");
  }
  expect(await grantCount()).toBe(1);
});

test("a grant from before the columns counts the cap from its creation and becomes its own session", async () => {
  const first = await signIn();
  await pg.query(
    "UPDATE mobile_app_auth_grants SET session_started_at=NULL,session_id=NULL,created_at=$2 WHERE id=$1",
    [first.grantId, new Date(T0.getTime() - 170 * DAY)],
  );
  // Day 175 of the sign-in: the key (valid to day 200, issued before the
  // clamp) still gains nothing from a successor that would end at day 180.
  clock = new Date(T0.getTime() + 5 * DAY);
  expect((await renew(first.secret, pkce().binding)).status).toBe(409);

  // The same sign-in with a key that ends before the cap renews, counts from
  // the grant's creation, and stamps the old grant as the session's first.
  await pg.query("UPDATE api_keys SET expires_at=$2 WHERE id=$1", [
    first.credentialId,
    new Date(T0.getTime() + 8 * DAY),
  ]);
  const successor = await renewInto(first);
  expect((await grantRow(successor.grantId)).session_started_at).toEqual(
    new Date(T0.getTime() - 170 * DAY),
  );
  const { rows } = await pg.query<{ id: string; session_id: string }>(
    "SELECT id,session_id FROM mobile_app_auth_grants ORDER BY created_at",
  );
  expect(rows).toEqual([
    { id: first.grantId, session_id: first.grantId },
    { id: successor.grantId, session_id: first.grantId },
  ]);
  const expires = await pg.query<{ expires_at: Date }>(
    "SELECT expires_at FROM api_keys WHERE id=$1",
    [successor.credentialId],
  );
  expect(expires.rows[0].expires_at).toEqual(new Date(T0.getTime() + 10 * DAY));

  // Revoking the old device row ends the session it started.
  expect(
    (
      await apiKeysService.revokeMobileCredentialForAccount(
        first.credentialId,
        OWNER,
        ORG,
      )
    )?.revokedNow,
  ).toBe(true);
  expect(await live(first, successor)).toEqual([false, false]);
});

// Changed on purpose: two renewals by one key used to leave two redeemable
// codes. A key now has one live successor, so the newer request supersedes
// the older code.
test("a repeated renewal supersedes the code still in flight, and a revoked predecessor cannot renew again", async () => {
  const first = await signIn();
  clock = new Date(T0.getTime() + 21 * DAY);
  const lost = pkce();
  const kept = pkce();

  // The reply to the first request is lost and the phone asks again.
  const one = await renew(first.secret, lost.binding);
  const two = await renew(first.secret, kept.binding);
  expect([one.status, two.status]).toEqual([200, 200]);
  expect(one.body.code).not.toBe(two.body.code);
  const { rows } = await pg.query<{
    session_started_at: Date;
    status: string;
    redeemable: boolean;
  }>(
    "SELECT session_started_at,status,expires_at > $2 AS redeemable FROM mobile_app_auth_grants WHERE id<>$1 ORDER BY created_at,expires_at",
    [first.grantId, clock],
  );
  expect(rows.map((row) => row.redeemable).sort()).toEqual([false, true]);
  expect(rows.every((row) => row.status === "pending")).toBe(true);
  expect(
    rows.every((row) => row.session_started_at.getTime() === T0.getTime()),
  ).toBe(true);

  // The superseded code mints nothing; the newest one is the successor.
  const superseded = await exchange(String(one.body.code), lost);
  expect(superseded.claim).toEqual({
    kind: "invalid",
    reason: "grant_invalid",
  });
  const successor = await redeem(String(two.body.code), kept);

  // A superseded code that was already exchanged loses its inactive credential.
  const third = pkce();
  const fourth = pkce();
  const exchangedThenSuperseded = await renew(successor.secret, third.binding);
  const pendingKey = await exchange(
    String(exchangedThenSuperseded.body.code),
    third,
  );
  expect(pendingKey.claim.kind).toBe("created");
  expect((await renew(successor.secret, fourth.binding)).status).toBe(200);
  expect(
    await protocolRefusal(() =>
      acknowledge(
        String(exchangedThenSuperseded.body.code),
        third,
        pendingKey.held,
      ),
    ),
  ).toBe("authorization_code_expired");
  const stranded = await pg.query<{ is_active: boolean; revoked: boolean }>(
    "SELECT is_active,deleted_at IS NOT NULL AS revoked FROM api_keys WHERE id=$1",
    [pendingKey.held.credentialId],
  );
  expect(stranded.rows).toEqual([{ is_active: false, revoked: true }]);

  // A renewal code is single-credential like any other: acknowledging it
  // twice returns the same receipt and mints nothing new.
  const again = await acknowledge(String(two.body.code), kept, successor);
  expect(again.credentialId).toBe(successor.credentialId);

  // The phone revokes the predecessor through the real route; replaying its
  // renewal is now a 401, and acknowledging the successor again still works.
  const revoked = await revokeCurrent({
    authorization: `Bearer ${first.secret}`,
    ...renewedInto(successor),
  });
  expect(revoked.status).toBe(200);
  expect(revoked.body).toMatchObject({
    success: true,
    credentialId: first.credentialId,
    status: "revoked",
  });
  expect(await live(first, successor)).toEqual([false, true]);
  const replay = await renew(first.secret, lost.binding);
  expect(replay.status).toBe(401);
  expect(replay.body.code).toBe("authentication_required");
  expect(
    (await acknowledge(String(two.body.code), kept, successor)).credentialId,
  ).toBe(successor.credentialId);
  expect(await live(successor)).toEqual([true]);
});

test("a code issued before its key was revoked mints and activates nothing", async () => {
  // The holder of a copied key asks for a code, then the owner revokes the
  // device from the account before the code is exchanged.
  const stolen = await signIn();
  const early = pkce();
  const code = String((await renew(stolen.secret, early.binding)).body.code);
  expect(
    (
      await apiKeysService.revokeMobileCredentialForAccount(
        stolen.credentialId,
        OWNER,
        ORG,
      )
    )?.revokedNow,
  ).toBe(true);
  expect((await exchange(code, early)).claim).toEqual({
    kind: "invalid",
    reason: "grant_invalid",
  });
  expect(
    (await pg.query("SELECT 1 FROM api_keys WHERE deleted_at IS NULL")).rows,
  ).toEqual([]);

  // The same when the code was already exchanged: the inactive successor is
  // tombstoned with the device and can never be acknowledged.
  const copied = await signIn();
  const late = pkce();
  const lateCode = String((await renew(copied.secret, late.binding)).body.code);
  const minted = await exchange(lateCode, late);
  expect(minted.claim.kind).toBe("created");
  await apiKeysService.revokeMobileCredentialForAccount(
    copied.credentialId,
    OWNER,
    ORG,
  );
  expect(
    await protocolRefusal(() => acknowledge(lateCode, late, minted.held)),
  ).toBe("credential_proof_invalid");
  expect(await live(copied, minted.held)).toEqual([false, false]);
  expect(
    (await pg.query("SELECT 1 FROM api_keys WHERE deleted_at IS NULL")).rows,
  ).toEqual([]);

  // And when the key signs itself out instead of being revoked by the owner.
  const signedOut = await signIn();
  const pendingAttempt = pkce();
  const pendingCode = String(
    (await renew(signedOut.secret, pendingAttempt.binding)).body.code,
  );
  expect((await revokeCurrent({ "x-api-key": signedOut.secret })).status).toBe(
    200,
  );
  expect((await exchange(pendingCode, pendingAttempt)).claim).toEqual({
    kind: "invalid",
    reason: "grant_invalid",
  });

  // A natural expiry of the predecessor closes the code the same way.
  const expiring = await signIn();
  clock = new Date(T0.getTime() + 30 * DAY - 60_000);
  const lastMinute = pkce();
  const lastCode = String(
    (await renew(expiring.secret, lastMinute.binding)).body.code,
  );
  clock = new Date(T0.getTime() + 30 * DAY);
  expect((await exchange(lastCode, lastMinute)).claim).toEqual({
    kind: "invalid",
    reason: "grant_invalid",
  });
});

test("a key that renews after its successor was acknowledged ends the whole sign-in", async () => {
  // A copy of the phone's key renews first and keeps renewing.
  const phone = await signIn();
  clock = new Date(T0.getTime() + 5 * DAY);
  const copy = await renewInto(phone);
  clock = new Date(T0.getTime() + 10 * DAY);
  const copyNext = await renewInto(copy);
  // An unrelated sign-in of the same owner on another device.
  const otherDevice = await signIn();
  expect(await live(phone, copy, copyNext, otherDevice)).toEqual([
    true,
    true,
    true,
    true,
  ]);

  // The phone, still holding the first key, renews when it nears expiry.
  clock = new Date(T0.getTime() + 22 * DAY);
  const before = await grantCount();
  const reuse = await renew(phone.secret, pkce().binding);
  expect(reuse.status).toBe(401);
  expect(reuse.body).toMatchObject({
    success: false,
    code: "authentication_required",
  });
  expect(await grantCount()).toBe(before);
  // Every key of that sign-in is revoked, the copy's chain included; the
  // other device's sign-in is untouched.
  expect(await live(phone, copy, copyNext, otherDevice)).toEqual([
    false,
    false,
    false,
    true,
  ]);
  for (const dead of [phone, copy, copyNext]) {
    expect((await renew(dead.secret, pkce().binding)).status).toBe(401);
  }
  expect((await renew(otherDevice.secret, pkce().binding)).status).toBe(200);
});

test("revoking a device ends its sign-in, while a renewal's last step ends only the old key", async () => {
  // Renewal's last step: the old key revokes itself, names the key it was
  // renewed into, and the successor stays. The acknowledgement is long past.
  const first = await signIn();
  clock = new Date(T0.getTime() + 21 * DAY);
  const second = await renewInto(first);
  await acknowledgedAgo(second, 30 * DAY);
  const lastStep = {
    authorization: `Bearer ${first.secret}`,
    ...renewedInto(second),
  };
  expect((await revokeCurrent(lastStep)).status).toBe(200);
  expect(await live(first, second)).toEqual([false, true]);
  // The same request again (a lost reply) returns the same receipt and still
  // leaves the successor alone.
  expect((await revokeCurrent(lastStep)).status).toBe(200);
  expect(await live(second)).toEqual([true]);

  // The old key was never revoked (its DELETE was lost), and the phone signs
  // out with the key it holds: the forgotten predecessor goes with it.
  clock = new Date(T0.getTime() + 40 * DAY);
  const third = await renewInto(second);
  expect(await live(second, third)).toEqual([true, true]);
  expect(
    (await revokeCurrent({ authorization: `Bearer ${third.secret}` })).status,
  ).toBe(200);
  expect(await live(second, third)).toEqual([false, false]);

  // The owner revokes a device row that was already superseded: the key the
  // phone holds now belongs to the same sign-in and ends with it, and a code
  // that key had asked for is worth nothing.
  clock = T0;
  const old = await signIn();
  const current = await renewInto(old);
  const pending = pkce();
  const pendingCode = String(
    (await renew(current.secret, pending.binding)).body.code,
  );
  const otherDevice = await signIn();
  const receipt = await apiKeysService.revokeMobileCredentialForAccount(
    old.credentialId,
    OWNER,
    ORG,
  );
  expect(receipt).toMatchObject({
    revokedNow: true,
    receipt: { credentialId: old.credentialId, status: "revoked" },
  });
  expect(await live(old, current, otherDevice)).toEqual([false, false, true]);
  expect((await exchange(pendingCode, pending)).claim).toEqual({
    kind: "invalid",
    reason: "grant_invalid",
  });
  // A retry of the owner's revocation is the same receipt.
  expect(
    await apiKeysService.revokeMobileCredentialForAccount(
      old.credentialId,
      OWNER,
      ORG,
    ),
  ).toMatchObject({ revokedNow: false });
  expect(await live(otherDevice)).toEqual([true]);
});

test("a sign-out with a key that somebody else renewed ends the keys renewed from it", async () => {
  // A copy of the phone's key renews and keeps renewing. The phone holds only
  // the first key and never renews.
  const phone = await signIn();
  clock = new Date(T0.getTime() + 5 * DAY);
  const copy = await renewInto(phone);
  clock = new Date(T0.getTime() + 10 * DAY);
  const copyNext = await renewInto(copy);
  const otherDevice = await signIn();
  await acknowledgedAgo(copy, MOBILE_RENEWAL_RETIREMENT_GRACE_MS + 1_000);
  expect(await live(phone, copy, copyNext, otherDevice)).toEqual([
    true,
    true,
    true,
    true,
  ]);
  // The phone signs out. It cannot name a successor, so this is not the last
  // step of a renewal and the whole sign-in ends, the copy's chain included.
  const signOut = await revokeCurrent({
    authorization: `Bearer ${phone.secret}`,
  });
  expect(signOut.status).toBe(200);
  expect(signOut.body).toMatchObject({
    credentialId: phone.credentialId,
    status: "revoked",
  });
  expect(await live(phone, copy, copyNext, otherDevice)).toEqual([
    false,
    false,
    false,
    true,
  ]);
  for (const dead of [phone, copy, copyNext]) {
    expect((await renew(dead.secret, pkce().binding)).status).toBe(401);
  }

  // The copy finished its renewal properly and revoked the phone's key. The
  // phone's later sign-out with that dead key still ends the copy's key.
  clock = T0;
  const taken = await signIn();
  const thief = await renewInto(taken);
  expect(
    (
      await revokeCurrent({
        authorization: `Bearer ${taken.secret}`,
        ...renewedInto(thief),
      })
    ).status,
  ).toBe(200);
  await acknowledgedAgo(thief, 2 * MOBILE_RENEWAL_RETIREMENT_GRACE_MS);
  expect(await live(taken, thief)).toEqual([false, true]);
  expect(
    (await revokeCurrent({ authorization: `Bearer ${taken.secret}` })).status,
  ).toBe(200);
  expect(await live(taken, thief, otherDevice)).toEqual([false, false, true]);

  // Naming a key that is not the acknowledged successor is a sign-out too,
  // even right after the acknowledgement.
  const held = await signIn();
  const renewed = await renewInto(held);
  await acknowledgedAgo(renewed, 0);
  expect(
    (
      await revokeCurrent({
        authorization: `Bearer ${held.secret}`,
        ...renewedInto(otherDevice),
      })
    ).status,
  ).toBe(200);
  expect(await live(held, renewed, otherDevice)).toEqual([false, false, true]);
});

test("a last step that names no successor counts only right after the acknowledgement", async () => {
  const first = await signIn();
  clock = new Date(T0.getTime() + 21 * DAY);
  const second = await renewInto(first);
  // Inside the grace period the unnamed revocation ends only the old key.
  await acknowledgedAgo(second, MOBILE_RENEWAL_RETIREMENT_GRACE_MS - 30_000);
  expect(
    (await revokeCurrent({ authorization: `Bearer ${first.secret}` })).status,
  ).toBe(200);
  expect(await live(first, second)).toEqual([false, true]);
  // After it, the same request is a sign-out, a retry of it included.
  await acknowledgedAgo(second, MOBILE_RENEWAL_RETIREMENT_GRACE_MS + 1_000);
  expect(
    (await revokeCurrent({ authorization: `Bearer ${first.secret}` })).status,
  ).toBe(200);
  expect(await live(first, second)).toEqual([false, false]);

  // A value that is not a credential id is refused and revokes nothing.
  clock = T0;
  const key = await signIn();
  const next = await renewInto(key);
  const malformed = await revokeCurrent({
    authorization: `Bearer ${key.secret}`,
    "x-renewed-credential-id": "not-a-credential",
  });
  expect(malformed.status).toBe(400);
  expect(malformed.body).toMatchObject({
    success: false,
    code: "validation_error",
  });
  expect(await live(key, next)).toEqual([true, true]);
  // A key that was never renewed signs out whatever it names.
  expect(
    (
      await revokeCurrent({
        authorization: `Bearer ${next.secret}`,
        ...renewedInto(key),
      })
    ).status,
  ).toBe(200);
  expect(await live(key, next)).toEqual([false, false]);
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
  await pg.query("UPDATE api_keys SET expires_at=$2 WHERE id=$1", [
    first.credentialId,
    new Date(T0.getTime() + 30 * DAY),
  ]);

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
