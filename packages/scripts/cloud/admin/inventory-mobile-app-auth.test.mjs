import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readDatabaseIdentityReceipt } from "../../../cloud/scripts/admin/database-identity-receipt.ts";
import {
  compareClientAuthority,
  planClientRegistryUpdate,
  requireMobileAuthInventoryOperation,
} from "./inventory-mobile-app-auth.ts";
import { resolveTargetRegistration } from "./repair-mobile-app-auth-registration.ts";
import { resolveMobileAppAuthRegistrationSelection } from "./verify-mobile-app-auth-registration.ts";

const PRIMARY = "11111111-1111-4111-8111-111111111111",
  ALPHA = "22222222-2222-4222-8222-222222222222",
  ORG = "33333333-3333-4333-8333-333333333333",
  OWNER = "44444444-4444-4444-8444-444444444444";
const ALPHA_CLIENT = "org.example.reader",
  entry = {
    clientId: ALPHA_CLIENT,
    appId: ALPHA,
    redirectUri: "https://eliza.app/reader/auth/callback",
    enabled: true,
    credentialTtlSeconds: 7776000,
  };
const identity = {
  system_identifier: "1234567890123456789",
  database_name: "fixture",
  role_name: "fixture",
  server_version_num: "180001",
};
const keys = [
  "ELIZA_MOBILE_APP_AUTH_APP_ID",
  "ELIZA_MOBILE_APP_AUTH_TARGET_CLIENT_ID",
  "ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON",
  "ELIZA_MOBILE_APP_AUTH_ORGANIZATION_ID",
  "ELIZA_MOBILE_APP_AUTH_OWNER_USER_ID",
  "ELIZA_MOBILE_APP_AUTH_ENVIRONMENT",
  "DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256",
  "DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256",
];
const prior = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
let db,
  queries = [];
const client = {
  query: async (sql, values) => {
    queries.push({ sql, values });
    if (sql.includes("pg_catalog.pg_control_system()"))
      return { rows: [identity] };
    assert.match(sql.trim(), /^(?:SELECT|WITH)\b/);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i);
    return db.query(sql, values);
  },
};
before(async () => {
  db = await PGlite.create();
  await db.exec(
    `CREATE TABLE organizations(id uuid PRIMARY KEY,is_active boolean);CREATE TABLE users(id uuid PRIMARY KEY,organization_id uuid,is_active boolean,deleted_at timestamptz,role text);CREATE TABLE apps(id uuid PRIMARY KEY,organization_id uuid,created_by_user_id uuid,is_active boolean,is_approved boolean,app_url text,allowed_origins jsonb,api_key_id uuid);CREATE TABLE api_keys(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,is_active boolean,deleted_at timestamptz);`,
  );
});
beforeEach(async () => {
  await db.exec("TRUNCATE apps,users,organizations,api_keys;");
  await db.query("INSERT INTO organizations VALUES ($1,true)", [ORG]);
  await db.query("INSERT INTO users VALUES ($1,$2,true,NULL,'owner')", [
    OWNER,
    ORG,
  ]);
  await db.query(
    "INSERT INTO apps(id,organization_id,created_by_user_id,is_active,is_approved) VALUES ($1,$2,$3,true,true)",
    [PRIMARY, ORG, OWNER],
  );
  const proof = await readDatabaseIdentityReceipt(client, "production");
  Object.assign(process.env, {
    ELIZA_MOBILE_APP_AUTH_APP_ID: PRIMARY,
    ELIZA_MOBILE_APP_AUTH_TARGET_CLIENT_ID: ALPHA_CLIENT,
    ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON: JSON.stringify([entry]),
    ELIZA_MOBILE_APP_AUTH_ORGANIZATION_ID: ORG,
    ELIZA_MOBILE_APP_AUTH_OWNER_USER_ID: OWNER,
    ELIZA_MOBILE_APP_AUTH_ENVIRONMENT: "production",
    DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256: proof.clusterSha256,
    DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256: proof.authoritySha256,
  });
  queries = [];
});
after(async () => {
  await db?.close();
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
test("requested additional client reports its missing row instead of the healthy primary", async () => {
  const result = await compareClientAuthority(client, "production");
  assert.equal(result.clientId, ALPHA_CLIENT);
  assert.equal(result.identityMatched, true);
  assert.equal(result.liveWorkerCompared, false);
  assert.equal(result.app_exists, false);
  assert.equal(result.app_active_approved, false);
  assert.equal(queries.at(-1).values[0], ALPHA);
  assert.equal("primary_app_exists" in result, false);
});
test("comparison reports actual approval and owner mismatches without rewriting them", async () => {
  await db.query(
    "INSERT INTO apps(id,organization_id,created_by_user_id,is_active,is_approved) VALUES ($1,$2,$3,false,true)",
    [ALPHA, ORG, OWNER],
  );
  assert.equal(
    (await compareClientAuthority(client, "production")).app_active_approved,
    false,
  );
  await db.query(
    "UPDATE apps SET is_active=true,is_approved=false WHERE id=$1",
    [ALPHA],
  );
  assert.equal(
    (await compareClientAuthority(client, "production")).app_active_approved,
    false,
  );
  await db.query("UPDATE apps SET is_approved=true WHERE id=$1", [ALPHA]);
  assert.equal(
    (await compareClientAuthority(client, "production")).owner_authorized,
    true,
  );
  await db.query("UPDATE users SET role='member' WHERE id=$1", [OWNER]);
  assert.equal(
    (await compareClientAuthority(client, "production")).owner_authorized,
    false,
  );
  assert.equal(
    (await db.query("SELECT is_approved FROM apps WHERE id=$1", [ALPHA]))
      .rows[0].is_approved,
    true,
  );
});
test("database identity mismatch refuses the app query", async () => {
  process.env.DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256 = "0".repeat(64);
  await assert.rejects(
    () => compareClientAuthority(client, "production"),
    /identity_mismatch/,
  );
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /pg_control_system/);
});
test("unknown or disabled requested client never falls back to primary or queries the database", async () => {
  process.env.ELIZA_MOBILE_APP_AUTH_TARGET_CLIENT_ID = "org.example.unknown";
  await assert.rejects(
    () => compareClientAuthority(client, "production"),
    /Unknown or disabled/,
  );
  assert.equal(queries.length, 0);
  process.env.ELIZA_MOBILE_APP_AUTH_TARGET_CLIENT_ID = ALPHA_CLIENT;
  process.env.ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON = JSON.stringify([
    { ...entry, enabled: false },
  ]);
  await assert.rejects(
    () => compareClientAuthority(client, "production"),
    /Unknown or disabled/,
  );
  assert.equal(queries.length, 0);
});
test("legacy primary operation refuses an additional-client label; requested-client mode selects it", () => {
  assert.throws(
    () => requireMobileAuthInventoryOperation("compare-primary", ALPHA_CLIENT),
    /primary_comparison_requires_primary_client/,
  );
  assert.equal(
    requireMobileAuthInventoryOperation("compare-primary", "ai.elizaos.app"),
    "compare-primary",
  );
  assert.equal(
    requireMobileAuthInventoryOperation("compare-client", ALPHA_CLIENT),
    "compare-client",
  );
  assert.throws(
    () => requireMobileAuthInventoryOperation("other", ALPHA_CLIENT),
    /operation_required/,
  );
});
test("diagnose, repair and comparison share the same primary/additional registration selector", async () => {
  const selected = resolveMobileAppAuthRegistrationSelection(
    ALPHA_CLIENT,
    "production",
    JSON.stringify([entry]),
    PRIMARY,
  );
  assert.equal(selected.appId, ALPHA);
  assert.equal(selected.target.clientId, ALPHA_CLIENT);
  assert.deepEqual(resolveTargetRegistration(process.env), selected);
  delete process.env.ELIZA_MOBILE_APP_AUTH_TARGET_CLIENT_ID;
  assert.equal(resolveTargetRegistration(process.env).appId, PRIMARY);
  const result = await compareClientAuthority(client, "production");
  assert.equal(result.clientId, "ai.elizaos.app");
  assert.equal(result.app_exists, true);
  assert.equal(queries.at(-1).values[0], PRIMARY);
});

test("source plan validates the actual intended row and preserves the source environment", async () => {
  const intended = "55555555-5555-4555-8555-555555555555";
  await db.query(
    "INSERT INTO apps VALUES ($1,$2,$3,true,true,$4,$5::jsonb,$6)",
    [
      intended,
      ORG,
      OWNER,
      "https://eliza.app",
      JSON.stringify([entry.redirectUri]),
      "66666666-6666-4666-8666-666666666666",
    ],
  );
  const before = process.env.ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON;
  const plan = await planClientRegistryUpdate(client, "production", intended);
  assert.equal(plan.ok, true);
  assert.equal(plan.changed, true);
  assert.deepEqual(JSON.parse(plan.registryJson), [
    { ...entry, appId: intended },
  ]);
  assert.equal(process.env.ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON, before);
  assert.equal(
    (await db.query("SELECT count(*)::integer AS count FROM apps")).rows[0]
      .count,
    2,
  );
});
test("source plan accepts metadata paths and keeps missing-row, origin and exact-callback gates", async () => {
  const intended = "55555555-5555-4555-8555-555555555555";
  await assert.rejects(
    () => planClientRegistryUpdate(client, "production", intended),
    /does not resolve/,
  );
  await db.query(
    "INSERT INTO apps VALUES ($1,$2,$3,true,true,$4,$5::jsonb,$6)",
    [
      intended,
      ORG,
      OWNER,
      entry.redirectUri,
      JSON.stringify([entry.redirectUri]),
      "66666666-6666-4666-8666-666666666666",
    ],
  );
  assert.equal(
    (await planClientRegistryUpdate(client, "production", intended)).ok,
    true,
  );
  await db.query(
    "UPDATE apps SET app_url='https://evil.example/home' WHERE id=$1",
    [intended],
  );
  await assert.rejects(
    () => planClientRegistryUpdate(client, "production", intended),
    /apps.app_url/,
  );
  await db.query(
    "UPDATE apps SET app_url=$2,allowed_origins=$3::jsonb WHERE id=$1",
    [intended, entry.redirectUri, JSON.stringify(["https://eliza.app/other"])],
  );
  await assert.rejects(
    () => planClientRegistryUpdate(client, "production", intended),
    /apps.allowed_origins/,
  );
  assert.equal(
    JSON.parse(process.env.ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON)[0].appId,
    ALPHA,
  );
});
