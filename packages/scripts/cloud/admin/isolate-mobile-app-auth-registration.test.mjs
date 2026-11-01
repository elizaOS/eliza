import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readDatabaseIdentityReceipt } from "../../../cloud/scripts/admin/database-identity-receipt.ts";
import {
  applyPublisherRegistration,
  planPublisherRegistration,
} from "./isolate-mobile-app-auth-registration.ts";
import {
  provisioningTarget,
  registryDigest,
} from "./plan-mobile-client-addition.ts";
import {
  queryMobileAppAuthRegistration,
  validateMobileAppAuthRegistrationRow,
} from "./verify-mobile-app-auth-registration.ts";

const PRIMARY = "11111111-1111-4111-8111-111111111111";
const APP = "22222222-2222-4222-8222-222222222222";
const OPERATOR_ORG = "33333333-3333-4333-8333-333333333333";
const OPERATOR = "44444444-4444-4444-8444-444444444444";
const PUBLISHER = "55555555-5555-4555-8555-555555555555";
const LEGACY_ORG = "66666666-6666-4666-8666-666666666666";
const CREATOR = "77777777-7777-4777-8777-777777777777";
const KEY = "88888888-8888-4888-8888-888888888888";
const CUSTOMER_ORG = "99999999-9999-4999-8999-999999999999";
const CUSTOMER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CALLBACK = "https://cloud-staging.eliza.app/auth/reader/callback";
let pg, input, statements;
const database = {
  async query(sql, values) {
    statements.push(sql);
    if (sql.includes("pg_catalog.pg_control_system()"))
      return {
        rows: [
          {
            system_identifier: "1234567890123456789",
            database_name: "fixture",
            role_name: "fixture",
            server_version_num: "180001",
          },
        ],
      };
    return pg.query(sql, values);
  },
};
const expectation = ({
  candidateSha256,
  nonTargetSha256,
  appBindingSha256,
  creationSha256,
}) => ({ candidateSha256, nonTargetSha256, appBindingSha256, creationSha256 });
const financialColumns = [
  "referral_bonus_credits",
  "total_credits_used",
  "custom_pricing_enabled",
  "monetization_enabled",
  "inference_markup_percentage",
  "purchase_share_percentage",
  "platform_offset_amount",
  "total_creator_earnings",
  "total_platform_revenue",
];
before(async () => {
  pg = await PGlite.create();
  // Test the deployed migration defaults, not today's Drizzle defaults. Later
  // migrations change these numeric types but retain purchase share 10 / offset 1.
  const initialAppsDefinition = readFileSync(
    new URL(
      "../../../cloud/shared/src/db/migrations/0000_last_reavers.sql",
      import.meta.url,
    ),
    "utf8",
  ).match(/CREATE TABLE "apps" \(([\s\S]*?)\n\);/)[1];
  const financialDefinitions = financialColumns
    .map((column) => {
      const definition = initialAppsDefinition
        .split("\n")
        .find((line) => line.trimStart().startsWith(`"${column}" `));
      assert.ok(definition, `Historical apps definition includes ${column}`);
      return definition.trim().replace(/,$/, "");
    })
    .join(",\n");
  await pg.exec(`
    CREATE TABLE organizations(id uuid PRIMARY KEY,name text,slug text,is_active boolean NOT NULL DEFAULT true,
      account_lifecycle_state text NOT NULL DEFAULT 'active',paid_work_fenced_at timestamptz,account_deletion_request_id uuid);
    CREATE TABLE users(id uuid PRIMARY KEY,organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
      is_active boolean DEFAULT true,deleted_at timestamptz,role text DEFAULT 'owner');
    CREATE TABLE api_keys(id uuid PRIMARY KEY,organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,is_active boolean,deleted_at timestamptz);
    CREATE TABLE apps(id uuid PRIMARY KEY,name text,description text,slug text,organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
      created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,app_url text,allowed_origins jsonb,api_key_id uuid,
      is_active boolean,is_approved boolean,metadata jsonb NOT NULL DEFAULT '{}',updated_at timestamptz,
      deployment_status text DEFAULT 'draft',production_url text,last_deployed_at timestamptz,github_repo text,
      affiliate_code text,promotional_assets jsonb DEFAULT '[]',linked_character_ids jsonb DEFAULT '[]',
      discord_automation jsonb DEFAULT '{"enabled":false}',telegram_automation jsonb DEFAULT '{"enabled":false}',
      twitter_automation jsonb DEFAULT '{"enabled":false}',${financialDefinitions});
    CREATE TABLE app_users(app_id uuid REFERENCES apps(id),user_id uuid REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE mobile_app_auth_grants(app_id uuid REFERENCES apps(id),user_id uuid REFERENCES users(id) ON DELETE CASCADE,organization_id uuid);
    CREATE TABLE billing_resources(app_id uuid REFERENCES apps(id));
  `);
  const migration = readFileSync(
    new URL(
      "../../../cloud/shared/src/db/migrations/0551_native_app_publishers.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const sql of migration.split("--> statement-breakpoint"))
    if (sql.trim()) await pg.exec(sql);
});
beforeEach(async () => {
  statements = [];
  await pg.exec(
    "TRUNCATE billing_resources,app_users,mobile_app_auth_grants,apps,api_keys,users,native_app_publishers,organizations CASCADE",
  );
  await pg.query("INSERT INTO organizations(id) VALUES($1),($2),($3)", [
    OPERATOR_ORG,
    LEGACY_ORG,
    CUSTOMER_ORG,
  ]);
  await pg.query(
    "INSERT INTO users(id,organization_id) VALUES($1,$2),($3,$4),($5,$6)",
    [OPERATOR, OPERATOR_ORG, CREATOR, LEGACY_ORG, CUSTOMER, CUSTOMER_ORG],
  );
  await pg.query(
    "INSERT INTO apps(id,organization_id,created_by_user_id,app_url,allowed_origins,api_key_id,is_active,is_approved) VALUES($1,$2,$3,'https://eliza.app',$4,$5,true,true)",
    [
      PRIMARY,
      OPERATOR_ORG,
      OPERATOR,
      JSON.stringify(["https://eliza.app/auth/callback"]),
      KEY,
    ],
  );
  const receipt = await readDatabaseIdentityReceipt(database, "staging");
  input = {
    environment: "staging",
    clientId: "org.example.reader",
    redirectUri: CALLBACK,
    registry: "[]",
    primaryAppId: PRIMARY,
    intendedAppId: APP,
    publisherOrganizationId: PUBLISHER,
    organizationId: "",
    ownerUserId: "",
    displayName: "Reader",
    clusterSha256: receipt.clusterSha256,
    authoritySha256: receipt.authoritySha256,
  };
  statements = [];
});
after(async () => {
  await pg.close();
});

async function plan(mode, value = input) {
  return planPublisherRegistration(
    database,
    value,
    mode,
    "elizaOS/eliza",
    "a".repeat(40),
  );
}
async function seedLegacy(environment = "staging") {
  input.environment = environment;
  input.redirectUri =
    environment === "production"
      ? "https://cloud.eliza.app/auth/reader/callback"
      : CALLBACK;
  const receipt = await readDatabaseIdentityReceipt(database, environment);
  input.clusterSha256 = receipt.clusterSha256;
  input.authoritySha256 = receipt.authoritySha256;
  await pg.query("INSERT INTO api_keys VALUES($1,$2,$3,false,NOW())", [
    KEY,
    LEGACY_ORG,
    CREATOR,
  ]);
  // Keep the primary's synthetic key reference absent and distinct.
  await pg.query("UPDATE apps SET api_key_id=$1 WHERE id=$2", [
    CUSTOMER,
    PRIMARY,
  ]);
  await pg.query(
    "INSERT INTO apps(id,name,organization_id,created_by_user_id,app_url,allowed_origins,api_key_id,is_active,is_approved,purchase_share_percentage,platform_offset_amount) VALUES($1,'Reader',$2,$3,$4,$5,$6,true,true,0,0)",
    [
      APP,
      LEGACY_ORG,
      CREATOR,
      new URL(input.redirectUri).origin,
      JSON.stringify([input.redirectUri]),
      KEY,
    ],
  );
  await pg.query("INSERT INTO app_users VALUES($1,$2)", [APP, CUSTOMER]);
  await pg.query("INSERT INTO mobile_app_auth_grants VALUES($1,$2,$3)", [
    APP,
    CUSTOMER,
    CUSTOMER_ORG,
  ]);
  input.registry = JSON.stringify([
    {
      clientId: input.clientId,
      appId: APP,
      redirectUri: input.redirectUri,
      enabled: true,
    },
  ]);
}

test("fresh publisher overrides historical financial defaults without changing existing apps", async () => {
  const financialProjection = financialColumns.join(",");
  const existing = (
    await pg.query(`SELECT ${financialProjection} FROM apps WHERE id=$1`, [
      PRIMARY,
    ])
  ).rows;
  assert.equal(Number(existing[0].purchase_share_percentage), 10);
  assert.equal(Number(existing[0].platform_offset_amount), 1);
  const planned = await plan("provision");
  assert.equal(planned.normalizesLegacyDefaults, false);
  assert.equal(planned.publisherVerified, false);
  assert.equal(planned.requiresPublisherCreation, true);
  assert.equal(planned.requiresAppCreation, true);
  assert.equal(planned.requiresCreation, true);
  for (const id of [APP, PUBLISHER, OPERATOR, OPERATOR_ORG])
    assert.equal(JSON.stringify(planned).includes(id), false);
  assert.equal(
    statements.some((sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql)),
    false,
  );
  assert.equal(
    (await pg.query("SELECT id FROM organizations WHERE id=$1", [PUBLISHER]))
      .rows.length,
    0,
  );
  await applyPublisherRegistration(
    database,
    input,
    "provision",
    expectation(planned),
  );
  const row = (
    await pg.query(
      "SELECT organization_id,created_by_user_id,api_key_id FROM apps WHERE id=$1",
      [APP],
    )
  ).rows[0];
  assert.deepEqual(row, {
    organization_id: PUBLISHER,
    created_by_user_id: null,
    api_key_id: null,
  });
  const financial = (
    await pg.query(`SELECT ${financialProjection} FROM apps WHERE id=$1`, [APP])
  ).rows[0];
  for (const column of financialColumns) {
    if (
      column === "monetization_enabled" ||
      column === "custom_pricing_enabled"
    ) {
      assert.equal(financial[column], false, column);
    } else {
      assert.equal(Number(financial[column]), 0, column);
    }
  }
  assert.deepEqual(
    (
      await pg.query(`SELECT ${financialProjection} FROM apps WHERE id=$1`, [
        PRIMARY,
      ])
    ).rows,
    existing,
  );
  assert.equal(
    (
      await pg.query("SELECT * FROM users WHERE organization_id=$1", [
        PUBLISHER,
      ])
    ).rows.length,
    0,
  );
  const first = (await pg.query("SELECT * FROM apps WHERE id=$1", [APP])).rows;
  await applyPublisherRegistration(
    database,
    input,
    "provision",
    expectation(planned),
  );
  assert.deepEqual(
    (await pg.query("SELECT * FROM apps WHERE id=$1", [APP])).rows,
    first,
  );
  assert.equal(input.registry, "[]");
});

test("isolation preserves app identity, audit creator, customer grants and revoked legacy key bytes", async () => {
  await seedLegacy();
  const key = (await pg.query("SELECT * FROM api_keys WHERE id=$1", [KEY]))
    .rows;
  const grants = (await pg.query("SELECT * FROM mobile_app_auth_grants")).rows;
  const source = input.registry;
  input.intendedAppId = undefined;
  const planned = await plan("isolate");
  assert.equal(planned.normalizesLegacyDefaults, false);
  assert.equal(planned.candidateSha256, registryDigest(source));
  assert.equal("candidate" in planned, false);
  await applyPublisherRegistration(
    database,
    input,
    "isolate",
    expectation(planned),
  );
  assert.deepEqual(
    (
      await pg.query(
        "SELECT id,organization_id,created_by_user_id,api_key_id FROM apps WHERE id=$1",
        [APP],
      )
    ).rows[0],
    {
      id: APP,
      organization_id: PUBLISHER,
      created_by_user_id: CREATOR,
      api_key_id: null,
    },
  );
  assert.deepEqual(
    (await pg.query("SELECT * FROM api_keys WHERE id=$1", [KEY])).rows,
    key,
  );
  assert.deepEqual(
    (await pg.query("SELECT * FROM mobile_app_auth_grants")).rows,
    grants,
  );
  await applyPublisherRegistration(
    database,
    input,
    "isolate",
    expectation(planned),
  );
  assert.equal(input.registry, source);
  // Deleting the former personal tenant cannot cascade through product ownership.
  await pg.query("DELETE FROM organizations WHERE id=$1", [LEGACY_ORG]);
  const registered = await queryMobileAppAuthRegistration(
    database.query.bind(database),
    APP,
    provisioningTarget(input),
  );
  validateMobileAppAuthRegistrationRow(
    registered,
    APP,
    provisioningTarget(input),
    { requirePublisher: true },
  );
  assert.deepEqual(
    (await pg.query("SELECT * FROM mobile_app_auth_grants")).rows,
    grants,
  );
});

for (const environment of ["staging", "production"]) {
  test(`${environment} isolation normalizes only unused historical fee defaults and preserves identity, grants, key and retry receipt`, async () => {
    await seedLegacy(environment);
    const neutralPlan = await plan("isolate");
    await pg.query(
      "UPDATE apps SET purchase_share_percentage=10,platform_offset_amount=1 WHERE id=$1",
      [APP],
    );
    for (const mutation of [
      `UPDATE apps SET purchase_share_percentage=11 WHERE id='${APP}'`,
      `UPDATE apps SET platform_offset_amount=2 WHERE id='${APP}'`,
      `UPDATE apps SET monetization_enabled=true WHERE id='${APP}'`,
      `UPDATE apps SET custom_pricing_enabled=true WHERE id='${APP}'`,
      `UPDATE apps SET custom_pricing_enabled=NULL WHERE id='${APP}'`,
      `UPDATE apps SET total_creator_earnings=1 WHERE id='${APP}'`,
      `UPDATE apps SET total_platform_revenue=1 WHERE id='${APP}'`,
      `UPDATE apps SET total_credits_used=1 WHERE id='${APP}'`,
      `UPDATE apps SET inference_markup_percentage=1 WHERE id='${APP}'`,
      `INSERT INTO billing_resources VALUES('${APP}')`,
    ]) {
      await pg.exec("BEGIN");
      // The historical column is nullable after 0048; preserve that DB behavior.
      await pg.exec(
        "ALTER TABLE apps ALTER COLUMN custom_pricing_enabled DROP NOT NULL",
      );
      await pg.exec(mutation);
      await assert.rejects(plan("isolate"));
      await pg.exec("ROLLBACK");
    }
    const planned = await plan("isolate");
    assert.equal(planned.normalizesLegacyDefaults, true);
    assert.notEqual(planned.creationSha256, neutralPlan.creationSha256);
    assert.equal(planned.appBindingSha256, neutralPlan.appBindingSha256);
    await assert.rejects(
      applyPublisherRegistration(
        database,
        input,
        "isolate",
        expectation(neutralPlan),
      ),
      /publisher_reviewed_plan_mismatch/,
    );
    const key = (await pg.query("SELECT * FROM api_keys WHERE id=$1", [KEY]))
      .rows;
    const grants = (await pg.query("SELECT * FROM mobile_app_auth_grants"))
      .rows;
    const existing = (
      await pg.query("SELECT * FROM apps WHERE id=$1", [PRIMARY])
    ).rows;
    await applyPublisherRegistration(
      database,
      input,
      "isolate",
      expectation(planned),
    );
    const isolated = (await pg.query("SELECT * FROM apps WHERE id=$1", [APP]))
      .rows;
    assert.equal(isolated[0].id, APP);
    assert.equal(isolated[0].organization_id, PUBLISHER);
    assert.equal(isolated[0].created_by_user_id, CREATOR);
    assert.equal(isolated[0].api_key_id, null);
    assert.equal(Number(isolated[0].purchase_share_percentage), 0);
    assert.equal(Number(isolated[0].platform_offset_amount), 0);
    assert.equal(isolated[0].monetization_enabled, false);
    assert.equal(isolated[0].custom_pricing_enabled, false);
    assert.equal(
      isolated[0].metadata.nativeAppPublisherIsolation.normalizesLegacyDefaults,
      true,
    );
    assert.deepEqual(
      (await pg.query("SELECT * FROM apps WHERE id=$1", [PRIMARY])).rows,
      existing,
    );
    assert.deepEqual(
      (await pg.query("SELECT * FROM api_keys WHERE id=$1", [KEY])).rows,
      key,
    );
    assert.deepEqual(
      (await pg.query("SELECT * FROM mobile_app_auth_grants")).rows,
      grants,
    );
    await applyPublisherRegistration(
      database,
      input,
      "isolate",
      expectation(planned),
    );
    assert.deepEqual(
      (await pg.query("SELECT * FROM apps WHERE id=$1", [APP])).rows,
      isolated,
    );
  });
}

test("isolation refuses active keys, hosted resources, billing history and changed reviewed input before any writes", async () => {
  await seedLegacy();
  for (const mutation of [
    "UPDATE api_keys SET is_active=true",
    `UPDATE apps SET deployment_status='running' WHERE id='${APP}'`,
    'UPDATE apps SET metadata=\'{"imageTag":"something"}\' WHERE id=\'' +
      APP +
      "'",
    `INSERT INTO billing_resources VALUES('${APP}')`,
    `UPDATE apps SET referral_bonus_credits=1 WHERE id='${APP}'`,
    `UPDATE apps SET affiliate_code='reward' WHERE id='${APP}'`,
    `UPDATE apps SET purchase_share_percentage=10 WHERE id='${APP}'`,
    `UPDATE apps SET platform_offset_amount=1 WHERE id='${APP}'`,
  ]) {
    await pg.exec("BEGIN");
    await pg.exec(mutation);
    await assert.rejects(plan("isolate"));
    await pg.exec("ROLLBACK");
  }
  const planned = await plan("isolate");
  for (const changed of [
    { ...input, publisherOrganizationId: CUSTOMER_ORG },
    { ...input, registry: "[]" },
    { ...input, displayName: "Changed" },
    { ...input, intendedAppId: PRIMARY },
  ]) {
    statements = [];
    await assert.rejects(
      applyPublisherRegistration(
        database,
        changed,
        "isolate",
        expectation(planned),
      ),
    );
    assert.equal(
      statements.some((sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql)),
      false,
    );
  }
});

test("publisher operation pins active primary audit authority and cannot adopt an ordinary organization", async () => {
  await assert.rejects(
    plan("provision", { ...input, publisherOrganizationId: OPERATOR_ORG }),
  );
  await assert.rejects(
    plan("provision", { ...input, publisherOrganizationId: CUSTOMER_ORG }),
  );
  const planned = await plan("provision");
  await pg.query("UPDATE users SET is_active=false WHERE id=$1", [OPERATOR]);
  await assert.rejects(
    applyPublisherRegistration(
      database,
      input,
      "provision",
      expectation(planned),
    ),
  );
  assert.equal(
    (await pg.query("SELECT id FROM apps WHERE id=$1", [APP])).rows.length,
    0,
  );
});

test("changed reviewed hashes and a key activation under the operation lock roll back without creating a publisher", async () => {
  await seedLegacy();
  const planned = await plan("isolate");
  for (const field of Object.keys(expectation(planned))) {
    await assert.rejects(
      applyPublisherRegistration(database, input, "isolate", {
        ...expectation(planned),
        [field]: "0".repeat(64),
      }),
      /publisher_reviewed_plan_mismatch/,
    );
  }
  const changedAtLock = {
    async query(sql, values) {
      const result = await database.query(sql, values);
      if (sql.includes("pg_advisory_xact_lock")) {
        await pg.query("UPDATE api_keys SET is_active=true WHERE id=$1", [KEY]);
      }
      return result;
    },
  };
  await assert.rejects(
    applyPublisherRegistration(
      changedAtLock,
      input,
      "isolate",
      expectation(planned),
    ),
    /publisher_registration_invalid/,
  );
  assert.equal(
    (await pg.query("SELECT id FROM organizations WHERE id=$1", [PUBLISHER]))
      .rows.length,
    0,
  );
  assert.equal(
    (await pg.query("SELECT is_active FROM api_keys WHERE id=$1", [KEY]))
      .rows[0].is_active,
    false,
  );
});
