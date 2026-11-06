/** A native host resuming a saved sign-in after the code's `acknowledgeBy`,
 * against the real `/api/v1/app-auth/mobile/ack` route, service, repository
 * and SQL (PGlite). Only the app registration lookup and the rate limiter are
 * stubbed; the host is the real `@elizaos/auth` native-host enrollment.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import * as realDb from "@elizaos/cloud-shared/db/client";
import { apiKeys } from "@elizaos/cloud-shared/db/schemas/api-keys";
import { apps } from "@elizaos/cloud-shared/db/schemas/apps";
import { organizations } from "@elizaos/cloud-shared/db/schemas/organizations";
import { users } from "@elizaos/cloud-shared/db/schemas/users";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { mobileAppAuthGrants } from "../../shared/src/db/schemas/mobile-app-auth-grants";

const OWNER = "22222222-2222-4222-8222-222222222222";
const ORG = "11111111-1111-4111-8111-111111111111";
const APP = "44444444-4444-4444-8444-444444444444";
const binding = Object.freeze({
  clientId: "org.example.native",
  environment: "staging" as const,
  redirectUri: "https://example.org/native/callback",
});
// The host module is untyped JavaScript; this test needs only its handle().
type NativeCloudAuth = {
  handle(operation: "resume"): Promise<Record<string, unknown>>;
};
const enrollmentModule = "../../../auth/native-host/cloud-enrollment.mjs";
const { createNativeCloudAuth } = (await import(enrollmentModule)) as {
  createNativeCloudAuth(options: Record<string, unknown>): NativeCloudAuth;
};
const pg = new PGlite();
const database = drizzle(pg);
const originalDb = { ...realDb };
mock.module("@elizaos/cloud-shared/db/client", () => ({
  ...originalDb,
  dbWrite: database,
  dbRead: database,
}));
const service = await import(
  "@elizaos/cloud-shared/lib/services/mobile-app-auth"
);
const registration = {
  appId: APP,
  ...binding,
  scopes: service.MOBILE_APP_AUTH_SCOPES,
  credentialTtlSeconds: 3600,
};
mock.module("../v1/app-auth/mobile/_registration", () => ({
  requireRegisteredMobileApp: async () => ({ app: { id: APP }, registration }),
}));
const realRateLimit = await import("../v1/app-auth/mobile/_rate-limit");
mock.module("../v1/app-auth/mobile/_rate-limit", () => ({
  ...realRateLimit,
  mobileAppAuthRateLimitMiddleware:
    () => async (_c: unknown, next: () => Promise<void>) => {
      await next();
    },
}));
const { default: ackRoute } = await import("../v1/app-auth/mobile/ack/route");
const { mobileAppAuthGrantsRepository } = await import(
  "../../shared/src/db/repositories/mobile-app-auth-grants"
);
const { buildMobileAppAuthCredentialProvenance } = await import(
  "../../shared/src/db/mobile-app-auth-credential-policy"
);
const cloud = new Hono();
cloud.route("/api/v1/app-auth/mobile/ack", ackRoute);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const hex = () => randomBytes(32).toString("hex");

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
      `CREATE TABLE ${quote(config.name)} (${config.columns.map((c) => `${quote(c.name)} ${c.getSQLType()}${c.primary ? " PRIMARY KEY" : ""}`).join(",")})`,
    );
  }
});
afterAll(() => {
  setSystemTime();
});
beforeEach(async () => {
  setSystemTime();
  await pg.exec(
    "TRUNCATE mobile_app_auth_grants, apps, api_keys, users, organizations",
  );
  await pg.query(
    "INSERT INTO organizations(id,is_active,account_lifecycle_state) VALUES($1,true,'active')",
    [ORG],
  );
  await pg.query(
    "INSERT INTO users(id,organization_id,is_active,account_lifecycle_state) VALUES($1,$2,true,'active')",
    [OWNER, ORG],
  );
  await pg.query(
    "INSERT INTO apps(id,is_active,is_approved) VALUES($1,true,true)",
    [APP],
  );
});

/** Cloud's state after `/token`: an exchanged grant holding an inactive key,
 * and the host's durable receipt for it, as the host writes it. */
async function exchangedSignIn() {
  const now = new Date();
  const grantId = randomUUID();
  const proof = {
    ...binding,
    state: `state-${hex()}`,
    code: `emac_${hex()}`,
    codeVerifier: `verifier-${hex()}`,
    credentialId: randomUUID(),
    secret: `eliza_mobile_${hex()}`,
  };
  const grantBinding = {
    codeHash: service.sha256Hex(proof.code),
    appId: APP,
    ...binding,
    stateHash: service.sha256Hex(proof.state),
    codeChallenge: service.deriveMobileAppAuthS256Challenge(proof.codeVerifier),
  };
  const acknowledgeBy = new Date(now.getTime() + 60_000);
  await pg.query(
    `INSERT INTO mobile_app_auth_grants(id,code_hash,app_id,client_id,user_id,organization_id,environment,redirect_uri,state_hash,code_challenge,code_challenge_method,scopes,status,expires_at,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'S256',$11,'pending',$12,$13,$13)`,
    [
      grantId,
      grantBinding.codeHash,
      APP,
      binding.clientId,
      OWNER,
      ORG,
      binding.environment,
      binding.redirectUri,
      grantBinding.stateHash,
      grantBinding.codeChallenge,
      JSON.stringify(registration.scopes),
      acknowledgeBy,
      now,
    ],
  );
  const attribution = buildMobileAppAuthCredentialProvenance({
    grantId,
    environment: binding.environment,
    deviceName: null,
    clientId: binding.clientId,
    scopes: [...registration.scopes],
  });
  const exchanged = await mobileAppAuthGrantsRepository.exchange(
    grantBinding,
    {
      id: proof.credentialId,
      name: attribution.name,
      description: attribution.description,
      organization_id: ORG,
      user_id: OWNER,
      source_app_id: APP,
      key_hash: service.sha256Hex(proof.secret),
      key_prefix: "test-only",
      is_active: false,
      expires_at: new Date(now.getTime() + 3_600_000),
      rate_limit: 1000,
      key_ciphertext: "test-ciphertext",
      key_nonce: "test-nonce",
      key_auth_tag: "test-tag",
      key_kms_key_id: "test-key",
      key_kms_key_version: 1,
    },
    now,
  );
  expect(exchanged.kind).toBe("created");
  return {
    proof,
    acknowledgeBy,
    receipt: JSON.stringify({
      version: 1,
      acknowledgeBy: acknowledgeBy.toISOString(),
      proof,
    }),
  };
}

/** The real host, with Cloud's `/ack` answered by the real route. `network`
 * decides, per ack, whether the request reaches Cloud and whether its reply
 * comes back. */
function host(receipt: string) {
  let pending: string | null = receipt,
    active: string | null = null;
  const network = { reachesCloud: true, replyLost: false };
  const statuses: number[] = [];
  const auth = createNativeCloudAuth({
    binding,
    appName: "Example Native",
    pendingStore: {
      read: async () => pending,
      write: async (value: string) => {
        pending = value;
      },
      clear: async () => {
        pending = null;
      },
    },
    activate: async (secret: string) => {
      active = secret;
    },
    fetchImpl: async (url: string, init: RequestInit) => {
      const { pathname } = new URL(url);
      if (pathname !== "/api/v1/app-auth/mobile/ack")
        throw new Error(`unexpected request ${pathname}`);
      if (!network.reachesCloud) return Response.json({}, { status: 503 });
      const response = await cloud.request(pathname, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: init.body,
      });
      statuses.push(response.status);
      return network.replyLost ? Response.json({}, { status: 503 }) : response;
    },
  });
  return {
    auth,
    network,
    statuses,
    get pending() {
      return pending;
    },
    get active() {
      return active;
    },
  };
}

async function keyRow(id: string) {
  const result = await pg.query<{
    is_active: boolean;
    deleted_at: Date | null;
  }>("SELECT is_active, deleted_at FROM api_keys WHERE id=$1", [id]);
  return result.rows[0];
}

test("an ack that landed before acknowledgeBy, with its reply lost, is replayed by Cloud after it", async () => {
  const signIn = await exchangedSignIn();
  const device = host(signIn.receipt);
  device.network.replyLost = true;
  await expect(device.auth.handle("resume")).rejects.toMatchObject({
    status: 502,
  });
  // Cloud activated the key; the host never heard.
  expect(device.statuses).toEqual([200]);
  expect(await keyRow(signIn.proof.credentialId)).toMatchObject({
    is_active: true,
  });
  expect(device.pending).toBe(signIn.receipt);

  setSystemTime(new Date(signIn.acknowledgeBy.getTime() + 1_000));
  device.network.replyLost = false;
  const resumed = await device.auth.handle("resume");
  expect(resumed).toMatchObject({ status: "authenticated", connected: true });
  expect(device.statuses).toEqual([200, 200]);
  expect(device.active).toBe(signIn.proof.secret);
  expect(device.pending).toBeNull();
});

test("an ack that never landed is an expired sign-in after acknowledgeBy, on every resume", async () => {
  const signIn = await exchangedSignIn();
  const device = host(signIn.receipt);
  device.network.reachesCloud = false;
  await expect(device.auth.handle("resume")).rejects.toMatchObject({
    status: 502,
  });
  expect(device.statuses).toEqual([]);

  setSystemTime(new Date(signIn.acknowledgeBy.getTime() + 1_000));
  device.network.reachesCloud = true;
  const expired = { status: 410, message: "Sign-in expired. Start again." };
  await expect(device.auth.handle("resume")).rejects.toMatchObject(expired);
  // Cloud's first refusal also removed the expired grant, so its next answer
  // is a missing code; the host still reports the same expired sign-in.
  await expect(device.auth.handle("resume")).rejects.toMatchObject(expired);
  expect(device.statuses).toEqual([410, 400]);
  expect(device.active).toBeNull();
  expect(device.pending).toBe(signIn.receipt);
  expect((await keyRow(signIn.proof.credentialId))?.is_active).not.toBe(true);
});
