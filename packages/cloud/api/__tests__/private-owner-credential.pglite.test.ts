/** Real primary SQL, owner admission, Personal resolver and Hono read boundaries.
 * Authentication proof and Cloudflare namespace are synthetic; no provider/network calls.
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import * as realAuth from "@elizaos/cloud-shared/auth";
import * as realDb from "@elizaos/cloud-shared/db/client";
import { apiKeys } from "@elizaos/cloud-shared/db/schemas/api-keys";
import { apps } from "@elizaos/cloud-shared/db/schemas/apps";
import { organizations } from "@elizaos/cloud-shared/db/schemas/organizations";
import { users } from "@elizaos/cloud-shared/db/schemas/users";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { personalSharedAgentId } from "@elizaos/cloud-shared/lib/services/shared-runtime/personal-shared-identity";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { mobileAppAuthGrants } from "../../shared/src/db/schemas/mobile-app-auth-grants";

const OWNER = "22222222-2222-4222-8222-222222222222";
const ORG = "11111111-1111-4111-8111-111111111111";
const KEY = "33333333-3333-4333-8333-333333333333";
const APP = "44444444-4444-4444-8444-444444444444";
const GRANT = "55555555-5555-4555-8555-555555555555";
const SECRET = "synthetic-private-owner-credential";
const HASH = createHash("sha256").update(SECRET).digest("hex");
const AGENT = personalSharedAgentId({ userId: OWNER, organizationId: ORG });
const pg = new PGlite();
const database = drizzle(pg);
const originalDb = { ...realDb },
  originalAuth = { ...realAuth };
let authMethod: AppEnv["Variables"]["authMethod"] = "api_key";
let historyConsumers = 0,
  namespaceCalls = 0;
const savedFetch = globalThis.fetch;
mock.module("@elizaos/cloud-shared/db/client", () => ({
  ...originalDb,
  dbWrite: database,
  dbRead: new Proxy(database, {
    get() {
      throw new Error("AUTHORIZATION_REPLICA_FORBIDDEN");
    },
  }),
}));
mock.module("@elizaos/cloud-shared/auth", () => ({
  ...originalAuth,
  requireUserOrApiKeyWithOrg: async (
    c: Parameters<typeof realAuth.requireUserOrApiKeyWithOrg>[0],
  ) => {
    c.set("authMethod", authMethod);
    if (authMethod === "api_key") c.set("apiKeyId", KEY);
    return { id: OWNER, organization_id: ORG, created_at: new Date(0) };
  },
}));
const { resolveSharedAgent } = await import(
  "@elizaos/cloud-shared/lib/services/shared-runtime/resolve-shared-agent"
);
const { default: historyRoute } = await import(
  "../v1/eliza/agents/[agentId]/api/conversations/[conversationId]/messages/route"
);
const { default: statusRoute } = await import(
  "../v1/eliza/google/status/route"
);
const { default: captureRoute } = await import(
  "../admin/shared-runtime-capture/route"
);
const app = new Hono<AppEnv>();
app.onError((error, c) => failureResponse(c, error));
app.get("/admit/:agentId", async (c) => {
  const result = await resolveSharedAgent(c);
  if ("error" in result) return c.json({ error: result.error }, result.status);
  historyConsumers += 1;
  return c.json({ owner: result.agent.user_id });
});
app.route("/history/:agentId/:conversationId", historyRoute);
app.route("/google", statusRoute);
app.route("/capture", captureRoute);
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
beforeAll(async () => {
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("NETWORK_FORBIDDEN");
    },
    {
      preconnect: () => {
        throw new Error("NETWORK_FORBIDDEN");
      },
    },
  );
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
      `CREATE TABLE ${quote(config.name)} (${config.columns.map((c) => `${quote(c.name)} ${c.getSQLType()}`).join(",")})`,
    );
  }
});
beforeEach(async () => {
  authMethod = "api_key";
  historyConsumers = 0;
  namespaceCalls = 0;
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
    "INSERT INTO api_keys(id,key_hash,user_id,organization_id,is_active) VALUES($1,$2,$3,$4,true)",
    [KEY, HASH, OWNER, ORG],
  );
});
afterAll(async () => {
  globalThis.fetch = savedFetch;
  mock.module("@elizaos/cloud-shared/db/client", () => originalDb);
  mock.module("@elizaos/cloud-shared/auth", () => originalAuth);
  mock.restore();
  await pg.close();
});
function env(): AppEnv["Bindings"] {
  return {
    ENVIRONMENT: "production",
    ELIZA_MOBILE_APP_AUTH_ENABLED: "true",
    ELIZA_MOBILE_APP_AUTH_APP_ID: APP,
    SHARED_RUNTIME_CONVERSATIONS: {
      getByName() {
        namespaceCalls += 1;
        throw new Error("PRIVATE_NAMESPACE_MUST_NOT_BE_READ");
      },
    },
    SHARED_OWNER_MODEL_CAPTURE_POLICY: JSON.stringify({
      version: 1,
      sessionId: GRANT,
      organizationId: ORG,
      userId: OWNER,
      readerUserId: OWNER,
      roomId: "66666666-6666-4666-8666-666666666666",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60000,
      retainUntil: Date.now() + 3600000,
      maxTurns: 2,
      maxCalls: 4,
      maxBytes: 65536,
    }),
  } as unknown as AppEnv["Bindings"];
}
function request(path: string) {
  return app.fetch(
    new Request(`https://fixture.example.test${path}`, {
      headers:
        authMethod === "api_key"
          ? { "X-API-Key": SECRET }
          : { Cookie: "steward-token=synthetic" },
    }),
    env(),
    { props: {}, waitUntil() {}, passThroughOnException() {} },
  );
}
async function mobile() {
  await pg.query(
    "UPDATE api_keys SET source_app_id=$1,expires_at=NOW()+interval '1 day' WHERE id=$2",
    [APP, KEY],
  );
  await pg.query(
    "INSERT INTO apps(id,is_active,is_approved) VALUES($1,true,true)",
    [APP],
  );
  // The code is expired, while the acknowledged user credential remains current.
  await pg.query(
    "INSERT INTO mobile_app_auth_grants(id,credential_id,app_id,user_id,organization_id,client_id,environment,redirect_uri,scopes,status,acknowledged_at,expires_at) VALUES($1,$2,$3,$4,$5,'ai.elizaos.app','production','https://eliza.app/auth/callback',$6,'acknowledged',NOW(),NOW()-interval '1 hour')",
    [GRANT, KEY, APP, OWNER, ORG, JSON.stringify(["cloud:user"])],
  );
}
test("creator backend key cannot enter Personal admission, actual history, owner Google status or capture", async () => {
  await pg.query(
    "INSERT INTO apps(id,api_key_id,is_active,is_approved) VALUES($1,$2,true,true)",
    [APP, KEY],
  );
  for (const path of [
    `/admit/${AGENT}`,
    `/history/${AGENT}/${AGENT}`,
    "/google?purpose=personal_google_context_v1",
    `/capture/read?sessionId=${GRANT}`,
  ]) {
    expect((await request(path)).status).toBe(403);
  }
  expect(historyConsumers).toBe(0);
  expect(namespaceCalls).toBe(0);
});
test("standard owner keys and already-authenticated Steward/phone sessions retain canonical Personal access", async () => {
  expect((await request(`/admit/${AGENT}`)).status).toBe(200);
  authMethod = "session";
  expect((await request(`/admit/${AGENT}`)).status).toBe(200);
  await pg.exec(
    "UPDATE users SET is_anonymous=true,expires_at=NOW()+interval '1 day'",
  );
  expect((await request(`/admit/${AGENT}`)).status).toBe(200);
  authMethod = "anonymous";
  expect((await request(`/admit/${AGENT}`)).status).toBe(403);
  expect(historyConsumers).toBe(3);
});
test("real acknowledged first-party mobile lineage outlives authorization-code TTL", async () => {
  await mobile();
  expect((await request(`/admit/${AGENT}`)).status).toBe(200);
  await pg.query("UPDATE mobile_app_auth_grants SET status='exchanged'");
  expect((await request(`/admit/${AGENT}`)).status).toBe(403);
  await pg.query(
    "UPDATE mobile_app_auth_grants SET status='acknowledged',user_id=$1",
    [APP],
  );
  expect((await request(`/admit/${AGENT}`)).status).toBe(403);
});
test("source app without exact current user-consented lineage, expiry or registry is refused", async () => {
  await pg.query("UPDATE api_keys SET source_app_id=$1 WHERE id=$2", [
    APP,
    KEY,
  ]);
  expect((await request(`/admit/${AGENT}`)).status).toBe(403);
  await mobile();
  await pg.query("UPDATE api_keys SET expires_at=NOW()-interval '1 minute'");
  expect((await request(`/admit/${AGENT}`)).status).toBe(403);
  await pg.query("UPDATE api_keys SET expires_at=NOW()+interval '1 day'");
  await pg.query(
    "UPDATE mobile_app_auth_grants SET client_id='unknown.client'",
  );
  expect((await request(`/admit/${AGENT}`)).status).toBe(403);
});
test("stale cached auth cannot bypass fresh key revocation/hash or owner lifecycle/membership", async () => {
  for (const mutation of [
    "UPDATE api_keys SET is_active=false",
    "UPDATE api_keys SET key_hash='rotated'",
    "UPDATE users SET is_active=false",
    "UPDATE users SET expires_at=NOW()-interval '1 minute'",
    "UPDATE users SET account_lifecycle_state='deletion_recovery'",
    "UPDATE users SET organization_id='44444444-4444-4444-8444-444444444444'",
    "UPDATE organizations SET account_lifecycle_state='deletion_recovery'",
  ]) {
    await pg.exec(mutation);
    expect((await request(`/admit/${AGENT}`)).status).toBe(403);
    await pg.query("UPDATE api_keys SET is_active=true,key_hash=$1", [HASH]);
    await pg.query(
      "UPDATE users SET is_active=true,organization_id=$1,expires_at=NULL,account_lifecycle_state='active'",
      [ORG],
    );
    await pg.exec("UPDATE organizations SET account_lifecycle_state='active'");
  }
  authMethod = "session";
  await pg.exec("UPDATE users SET is_active=false");
  expect((await request(`/admit/${AGENT}`)).status).toBe(403);
  expect(historyConsumers).toBe(0);
});
