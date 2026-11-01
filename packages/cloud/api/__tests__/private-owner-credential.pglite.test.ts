/** Real primary SQL, owner admission, Personal resolver and Hono read boundaries.
 * Authentication proof and Cloudflare namespace are synthetic; no provider/network calls.
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import * as realAuth from "@elizaos/cloud-shared/auth";
import * as realDb from "@elizaos/cloud-shared/db/client";
import { apiKeys } from "@elizaos/cloud-shared/db/schemas/api-keys";
import { apps } from "@elizaos/cloud-shared/db/schemas/apps";
import { managedDomains } from "@elizaos/cloud-shared/db/schemas/managed-domains";
import { organizations } from "@elizaos/cloud-shared/db/schemas/organizations";
import {
  personalSharedGroupBindings,
  personalSharedGroupJoinChallenges,
  personalSharedGroupParticipants,
} from "@elizaos/cloud-shared/db/schemas/personal-shared-groups";
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
  namespaceCalls = 0,
  authenticationCalls = 0;
let publicMetadataRead = false;
let authUserId = OWNER,
  authOrganizationId = ORG,
  authKeyId = KEY,
  authSecret = SECRET;
const savedFetch = globalThis.fetch;
mock.module("@elizaos/cloud-shared/db/client", () => ({
  ...originalDb,
  dbWrite: database,
  dbRead: new Proxy(database, {
    get(target, property, receiver) {
      if (!publicMetadataRead)
        throw new Error("AUTHORIZATION_REPLICA_FORBIDDEN");
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }),
}));
mock.module("@elizaos/cloud-shared/auth", () => ({
  ...originalAuth,
  requireUserOrApiKeyWithOrg: async (
    c: Parameters<typeof realAuth.requireUserOrApiKeyWithOrg>[0],
  ) => {
    authenticationCalls += 1;
    c.set("authMethod", authMethod);
    if (authMethod === "api_key") c.set("apiKeyId", authKeyId);
    return {
      id: authUserId,
      organization_id: authOrganizationId,
      created_at: new Date(0),
    };
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
const { default: mobileConfigRoute } = await import(
  "../v1/app-auth/mobile/config/route"
);
const {
  deriveMobileAppAuthS256Challenge,
  issueMobileAppAuthCode,
  resolveMobileAppAuthRegistration,
  sha256Hex,
} = await import("@elizaos/cloud-shared/lib/services/mobile-app-auth");
const { mobileAppAuthGrantsRepository } = await import(
  "../../shared/src/db/repositories/mobile-app-auth-grants"
);
const { buildMobileAppAuthCredentialProvenance } = await import(
  "../../shared/src/db/mobile-app-auth-credential-policy"
);
const { usersRepository } = await import(
  "../../shared/src/db/repositories/users"
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
app.route("/mobile/config", mobileConfigRoute);
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
    managedDomains,
    mobileAppAuthGrants,
    personalSharedGroupBindings,
    personalSharedGroupJoinChallenges,
    personalSharedGroupParticipants,
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
  await pg.exec(`
    ALTER TABLE mobile_app_auth_grants ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE mobile_app_auth_grants ALTER COLUMN created_at SET DEFAULT now();
    ALTER TABLE mobile_app_auth_grants ALTER COLUMN updated_at SET DEFAULT now();
  `);
  await pg.exec(
    readFileSync(
      new URL(
        "../../shared/src/db/migrations/0551_native_app_publishers.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
});
beforeEach(async () => {
  authMethod = "api_key";
  historyConsumers = 0;
  namespaceCalls = 0;
  authenticationCalls = 0;
  publicMetadataRead = false;
  authUserId = OWNER;
  authOrganizationId = ORG;
  authKeyId = KEY;
  authSecret = SECRET;
  await pg.exec(
    "TRUNCATE native_app_publishers, mobile_app_auth_grants, apps, api_keys, users, organizations",
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
          ? { "X-API-Key": authSecret }
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

test("memberless publisher survives creator personal-account deletion without transferring customer credentials or funds", async () => {
  const publisherOrg = randomUUID();
  const otherOrg = randomUUID();
  const otherUser = randomUUID();
  await pg.query(
    "INSERT INTO organizations(id,is_active,account_lifecycle_state,credit_balance) VALUES($1,true,'active',0),($2,true,'active',9.99)",
    [publisherOrg, otherOrg],
  );
  await pg.query(
    "INSERT INTO users(id,organization_id,is_active,account_lifecycle_state) VALUES($1,$2,true,'active')",
    [otherUser, otherOrg],
  );
  await pg.query(
    "INSERT INTO native_app_publishers(organization_id) VALUES($1)",
    [publisherOrg],
  );
  await pg.query("UPDATE organizations SET credit_balance=12.34 WHERE id=$1", [
    ORG,
  ]);
  // The publisher has no members. The creator is only historical app metadata;
  // both customers retain their own personal organizations and credentials.
  await pg.query(
    "INSERT INTO apps(id,organization_id,created_by_user_id,name,app_url,allowed_origins,is_active,is_approved) VALUES($1,$2,$3,'Reader','https://eliza.app',$4,true,true)",
    [
      APP,
      publisherOrg,
      OWNER,
      JSON.stringify(["https://eliza.app/auth/callback"]),
    ],
  );
  const runtime = {
    ...env(),
    NODE_ENV: "test",
    RATE_LIMIT_DISABLED: "true",
  } as AppEnv["Bindings"];
  publicMetadataRead = true;
  const metadata = await app.request(
    "/mobile/config?clientId=ai.elizaos.app&environment=production&redirectUri=https%3A%2F%2Feliza.app%2Fauth%2Fcallback",
    // No cookie, Authorization, API-key header, or authenticated context.
    {},
    runtime,
  );
  publicMetadataRead = false;
  expect(metadata.status).toBe(200);
  expect(authenticationCalls).toBe(0);
  const payload = (await metadata.json()) as Record<string, unknown>;
  expect(payload).toEqual({
    success: true,
    clientId: "ai.elizaos.app",
    environment: "production",
    redirectUri: "https://eliza.app/auth/callback",
    codeChallengeMethod: "S256",
    scopes: ["cloud:user"],
    app: { name: "Reader", description: null, logoUrl: null, websiteUrl: null },
  });

  const registration = resolveMobileAppAuthRegistration(runtime);
  const now = new Date();
  const credentials = [];
  for (const [userId, organizationId] of [
    [OWNER, ORG],
    [otherUser, otherOrg],
  ]) {
    const binding = {
      clientId: registration.clientId,
      environment: registration.environment,
      redirectUri: registration.redirectUri,
      state: randomUUID().replaceAll("-", "").repeat(2),
      codeChallenge: deriveMobileAppAuthS256Challenge("v".repeat(64)),
      codeChallengeMethod: "S256",
    };
    const issued = await issueMobileAppAuthCode({
      registration,
      userId,
      organizationId,
      binding,
      now,
    });
    const grantBinding = {
      ...binding,
      appId: APP,
      stateHash: sha256Hex(binding.state),
      codeHash: sha256Hex(issued.code),
    };
    const pending = await mobileAppAuthGrantsRepository.findActiveState(
      grantBinding,
      now,
    );
    expect(pending?.grant.user_id).toBe(userId);
    expect(pending?.grant.organization_id).toBe(organizationId);
    expect(pending?.grant.app_id).toBe(APP);
    if (!pending) throw new Error("Expected issued grant");
    const provenance = buildMobileAppAuthCredentialProvenance({
      grantId: pending.grant.id,
      environment: pending.grant.environment,
      deviceName: pending.grant.device_name,
      clientId: pending.grant.client_id,
      scopes: pending.grant.scopes,
    });
    const credentialId = randomUUID();
    const credentialSecret = randomUUID();
    const credentialHash = sha256Hex(credentialSecret);
    const exchanged = await mobileAppAuthGrantsRepository.exchange(
      grantBinding,
      {
        id: credentialId,
        ...provenance,
        user_id: userId,
        organization_id: organizationId,
        source_app_id: APP,
        key_hash: credentialHash,
        key_prefix: "synthetic",
        is_active: false,
        expires_at: new Date(now.getTime() + 86_400_000),
      },
      now,
    );
    expect(exchanged.kind).toBe("created");
    const acknowledged = await mobileAppAuthGrantsRepository.acknowledge({
      binding: grantBinding,
      credentialId,
      credentialHash,
      now,
    });
    expect(acknowledged?.credential?.user_id).toBe(userId);
    expect(acknowledged?.credential?.organization_id).toBe(organizationId);
    expect(acknowledged?.credential?.source_app_id).toBe(APP);
    expect(acknowledged?.credential?.is_active).toBe(true);
    credentials.push({
      credentialId,
      credentialSecret,
      grantBinding,
      userId,
      organizationId,
    });
  }
  expect(credentials[0].credentialId).not.toBe(credentials[1].credentialId);
  const first = credentials[0];
  for (const [column, foreignValue] of [
    ["user_id", otherUser],
    ["organization_id", otherOrg],
  ]) {
    await pg.query(`UPDATE api_keys SET ${column}=$1 WHERE id=$2`, [
      foreignValue,
      first.credentialId,
    ]);
    await expect(
      mobileAppAuthGrantsRepository.findActiveState(first.grantBinding, now),
    ).rejects.toThrow("credential ownership mismatch");
    await pg.query(`UPDATE api_keys SET ${column}=$1 WHERE id=$2`, [
      column === "user_id" ? first.userId : first.organizationId,
      first.credentialId,
    ]);
  }

  // These earlier admission tests deliberately allow malformed ownership rows.
  // Apply the real schema's deletion FKs for this end-to-end deletion boundary.
  const deletionTables = [
    organizations,
    users,
    apiKeys,
    apps,
    mobileAppAuthGrants,
  ];
  const deletionTableNames = new Set(
    deletionTables.map((table) => getTableConfig(table).name),
  );
  const constraints: Array<{ table: string; name: string }> = [];
  try {
    for (const table of deletionTables) {
      const config = getTableConfig(table);
      for (const foreignKey of config.foreignKeys) {
        const reference = foreignKey.reference();
        const target = getTableConfig(reference.foreignTable).name;
        if (!deletionTableNames.has(target)) continue;
        const name = foreignKey.getName();
        await pg.exec(
          `ALTER TABLE ${quote(config.name)} ADD CONSTRAINT ${quote(name)} FOREIGN KEY (${reference.columns.map((column) => quote(column.name)).join(",")}) REFERENCES ${quote(target)} (${reference.foreignColumns.map((column) => quote(column.name)).join(",")}) ON DELETE ${foreignKey.onDelete ?? "no action"}`,
        );
        constraints.push({ table: config.name, name });
      }
    }

    await usersRepository.deletePersonalOrganizationAtomically(OWNER, ORG);

    expect(
      (await pg.query("SELECT id FROM users WHERE id=$1", [OWNER])).rows,
    ).toEqual([]);
    expect(
      (await pg.query("SELECT id FROM organizations WHERE id=$1", [ORG])).rows,
    ).toEqual([]);
    expect(
      (
        await pg.query(
          "SELECT id FROM api_keys WHERE user_id=$1 OR organization_id=$2",
          [OWNER, ORG],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await pg.query(
          "SELECT id FROM mobile_app_auth_grants WHERE user_id=$1 OR organization_id=$2",
          [OWNER, ORG],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await pg.query(
          "SELECT organization_id,created_by_user_id FROM apps WHERE id=$1",
          [APP],
        )
      ).rows,
    ).toEqual([{ organization_id: publisherOrg, created_by_user_id: null }]);
    expect(
      (
        await pg.query("SELECT id FROM users WHERE organization_id=$1", [
          publisherOrg,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (await pg.query("SELECT organization_id FROM native_app_publishers", []))
        .rows,
    ).toEqual([{ organization_id: publisherOrg }]);
    expect(
      (
        await pg.query(
          "SELECT id,credit_balance FROM organizations ORDER BY id",
          [],
        )
      ).rows,
    ).toEqual(
      [
        { id: publisherOrg, credit_balance: "0.000000" },
        { id: otherOrg, credit_balance: "9.990000" },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );

    // A stale creator session cannot enter Personal; the other customer's
    // acknowledged credential remains usable only for that customer's agent.
    expect((await request(`/admit/${AGENT}`)).status).toBe(403);
    const remaining = credentials[1];
    const survivingGrant = await mobileAppAuthGrantsRepository.findActiveState(
      remaining.grantBinding,
      now,
    );
    expect(survivingGrant?.grant.user_id).toBe(otherUser);
    expect(survivingGrant?.credential?.id).toBe(remaining.credentialId);
    expect(survivingGrant?.credential?.organization_id).toBe(otherOrg);
    authUserId = otherUser;
    authOrganizationId = otherOrg;
    authKeyId = remaining.credentialId;
    authSecret = remaining.credentialSecret;
    const otherAgent = personalSharedAgentId({
      userId: otherUser,
      organizationId: otherOrg,
    });
    expect((await request(`/admit/${otherAgent}`)).status).toBe(200);
    expect((await request(`/admit/${AGENT}`)).status).toBe(404);

    publicMetadataRead = true;
    const survivingMetadata = await app.request(
      "/mobile/config?clientId=ai.elizaos.app&environment=production&redirectUri=https%3A%2F%2Feliza.app%2Fauth%2Fcallback",
      {},
      runtime,
    );
    publicMetadataRead = false;
    expect(survivingMetadata.status).toBe(200);
    expect(await survivingMetadata.json()).toEqual(payload);
  } finally {
    publicMetadataRead = false;
    for (const constraint of constraints.reverse()) {
      await pg.exec(
        `ALTER TABLE ${quote(constraint.table)} DROP CONSTRAINT ${quote(constraint.name)}`,
      );
    }
  }
});
