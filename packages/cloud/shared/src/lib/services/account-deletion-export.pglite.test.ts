/** Executes every explicit portable-export join against isolated real PGlite tables. */

import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { installOrganizationPolicyTestSchema } from "../../db/repositories/organization-policy-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

mock.module("../../db/account-deletion-foreign-key-policy", () => ({
  ACCOUNT_DELETION_FOREIGN_KEY_SNAPSHOT_SHA256: "f".repeat(64),
  listAccountDeletionForeignKeys: () => [
    ...["organization_policy_audit", "organization_subscription_authorities"].map(
      (sourceTable) => ({
        sourceTable,
        sourceColumns: "organization_id",
        targetTable: "organizations",
        targetColumns: "id",
        onDelete: "cascade",
      }),
    ),
    {
      sourceTable: "apps",
      sourceColumns: "organization_id",
      targetTable: "organizations",
      targetColumns: "id",
      onDelete: "restrict",
    },
    {
      sourceTable: "conversations",
      sourceColumns: "organization_id",
      targetTable: "organizations",
      targetColumns: "id",
      onDelete: "cascade",
    },
    {
      sourceTable: "conversations",
      sourceColumns: "user_id",
      targetTable: "users",
      targetColumns: "id",
      onDelete: "cascade",
    },
  ],
}));

const { closeDatabaseConnectionsForTests, getPgliteClientForTests } = await import(
  "../../db/client"
);
const { dbWrite } = await import("../../db/helpers");
const { collectPortableAccountDeletionExport } = await import("./account-deletion-export");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const FOREIGN_USER_ID = "11111111-1111-4111-8111-111111111112";
const FOREIGN_ORGANIZATION_ID = "22222222-2222-4222-8222-222222222223";

beforeAll(async () => {
  for (const statement of [
    "CREATE TABLE organizations (id uuid PRIMARY KEY, name text NOT NULL)",
    "CREATE TABLE users (id uuid PRIMARY KEY, email text NOT NULL)",
    `CREATE TABLE conversations (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL,
      organization_id uuid NOT NULL,
      title text NOT NULL
    )`,
    `CREATE TABLE conversation_messages (
      id uuid PRIMARY KEY,
      conversation_id uuid NOT NULL,
      content text NOT NULL
    )`,
    `CREATE TABLE apps (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      name text NOT NULL,
      created_by_user_id uuid NOT NULL
    )`,
    `CREATE TABLE app_users (app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, UNIQUE(app_id,user_id))`,
    `CREATE TABLE app_analytics (
      id uuid PRIMARY KEY,
      app_id uuid NOT NULL,
      total_requests integer NOT NULL
    )`,
    `CREATE TABLE secret_audit_log (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      action text NOT NULL,
      access_token text NOT NULL
    )`,
  ]) {
    await dbWrite.execute(statement);
  }
  await installOrganizationPolicyTestSchema((statement) =>
    getPgliteClientForTests().exec(statement),
  );
  for (const statement of [
    `INSERT INTO organizations VALUES
      ('${ORGANIZATION_ID}', 'Owned'),
      ('${FOREIGN_ORGANIZATION_ID}', 'Foreign')`,
    `INSERT INTO users VALUES
      ('${USER_ID}', 'owned@example.test'),
      ('${FOREIGN_USER_ID}', 'foreign@example.test')`,
    `INSERT INTO conversations VALUES
      ('33333333-3333-4333-8333-333333333331', '${USER_ID}', '${ORGANIZATION_ID}', 'Owned conversation'),
      ('33333333-3333-4333-8333-333333333332', '${FOREIGN_USER_ID}', '${FOREIGN_ORGANIZATION_ID}', 'Foreign conversation')`,
    `INSERT INTO conversation_messages VALUES
      ('44444444-4444-4444-8444-444444444441', '33333333-3333-4333-8333-333333333331', 'owned portable message'),
      ('44444444-4444-4444-8444-444444444442', '33333333-3333-4333-8333-333333333332', 'foreign message')`,
    `INSERT INTO apps VALUES
      ('55555555-5555-4555-8555-555555555551', '${ORGANIZATION_ID}', 'Owned app', '${USER_ID}'),
      ('55555555-5555-4555-8555-555555555552', '${FOREIGN_ORGANIZATION_ID}', 'Foreign app', '${FOREIGN_USER_ID}')`,
    `INSERT INTO app_analytics VALUES
      ('66666666-6666-4666-8666-666666666661', '55555555-5555-4555-8555-555555555551', 7),
      ('66666666-6666-4666-8666-666666666662', '55555555-5555-4555-8555-555555555552', 99)`,
    `INSERT INTO secret_audit_log VALUES
      ('77777777-7777-4777-8777-777777777771', '${ORGANIZATION_ID}', 'owned-read', 'owned-secret'),
      ('77777777-7777-4777-8777-777777777772', '${FOREIGN_ORGANIZATION_ID}', 'foreign-read', 'foreign-secret')`,
  ]) {
    await dbWrite.execute(statement);
  }
  const migration = await Bun.file(
    new URL("../../db/migrations/0381_app_billing_registration.sql", import.meta.url),
  ).text();
  await dbWrite.execute(`UPDATE organization_subscription_authorities SET policy_generation=3`);
  await dbWrite.execute(`INSERT INTO organization_policy_audit(organization_id,generation,reason,actor,change)
    VALUES ('${ORGANIZATION_ID}',3,'manual_override','${USER_ID}','{"completionsRpm":7}'),
      ('${FOREIGN_ORGANIZATION_ID}',3,'foreign_override','${FOREIGN_USER_ID}','{"completionsRpm":99}')`);
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await getPgliteClientForTests().exec(statement);
  }
  const noticeMigration = await Bun.file(
    new URL("../../db/migrations/0382_subscription_notice_intents.sql", import.meta.url),
  ).text();
  for (const statement of noticeMigration.split("--> statement-breakpoint")) {
    if (statement.trim()) await getPgliteClientForTests().exec(statement);
  }
  for (const [organizationId, subscriptionId, noticeId, label] of [
    [
      ORGANIZATION_ID,
      "99999999-9999-4999-8999-999999999981",
      "99999999-9999-4999-8999-999999999991",
      "owned",
    ],
    [
      FOREIGN_ORGANIZATION_ID,
      "99999999-9999-4999-8999-999999999982",
      "99999999-9999-4999-8999-999999999992",
      "foreign",
    ],
  ]) {
    await getPgliteClientForTests().query(
      `INSERT INTO billing_subscriptions(id,organization_id,provider_environment,stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,plan_key,catalog_version,status,current_period_start,current_period_end,lifecycle_revision,provider_object_digest)
      VALUES ($1,$2,'test',$3,$4,$5,'plus_monthly','v1','canceled','2026-08-01Z','2026-09-01Z',1,$6)`,
      [
        subscriptionId,
        organizationId,
        `cus_${label}`,
        `sub_${label}`,
        `si_${label}`,
        "a".repeat(64),
      ],
    );
    await getPgliteClientForTests().query(
      `INSERT INTO billing_subscription_revisions(organization_id,subscription_id,revision,source,provider_environment,stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,plan_key,catalog_version,status,current_period_start,current_period_end,cancel_at_period_end,provider_object_digest)
      SELECT organization_id,id,1,'webhook',provider_environment,stripe_customer_id,stripe_subscription_id,stripe_subscription_item_id,plan_key,catalog_version,status,current_period_start,current_period_end,false,provider_object_digest FROM billing_subscriptions WHERE id=$1`,
      [subscriptionId],
    );
    await getPgliteClientForTests().query(
      `INSERT INTO subscription_notice_intents(id,organization_id,subscription_id,source_revision,state) VALUES ($1,$2,$3,1,'uncertain')`,
      [noticeId, organizationId, subscriptionId],
    );
    await getPgliteClientForTests().query(
      `INSERT INTO subscription_notice_attempts(notice_id,organization_id,policy_digest,status,reason,started_at,expires_at,completed_at) VALUES ($1,$2,$3,'uncertain','submission_outcome_unrecorded',now()-interval '2 minutes',now()-interval '1 minute',now())`,
      [noticeId, organizationId, "b".repeat(64)],
    );
  }
  await dbWrite.execute(`INSERT INTO app_users SELECT a.id,u.id FROM apps a CROSS JOIN users u`);
  await dbWrite.execute(
    `INSERT INTO app_billing_registrations(app_id,owner_organization_id,infrastructure_payer_organization_id,registered_by_user_id,provider_environment) SELECT id,organization_id,organization_id,created_by_user_id,'test' FROM apps`,
  );
  await dbWrite.execute(
    `INSERT INTO app_subscriber_accounts(registration_id,app_id,subscriber_user_id) SELECT r.id,r.app_id,c.user_id FROM app_billing_registrations r JOIN app_users c ON c.app_id=r.app_id`,
  );
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

test("exports transitive owned rows and excludes cross-tenant rows through real joins", async () => {
  const bytes = await collectPortableAccountDeletionExport({
    requestId: "88888888-8888-4888-8888-888888888888",
    userId: USER_ID,
    organizationId: ORGANIZATION_ID,
    generatedAt: new Date("2026-08-25T12:00:00.000Z"),
  });
  const artifact = JSON.parse(new TextDecoder().decode(bytes)) as {
    tables: Array<{ table: string; policy?: string; rows: Array<Record<string, unknown>> }>;
  };
  const table = (name: string) => artifact.tables.find((entry) => entry.table === name);

  expect(table("conversations")?.rows).toEqual([
    expect.objectContaining({ title: "Owned conversation" }),
  ]);
  expect(table("conversation_messages")).toMatchObject({
    policy: "portable_subject_data",
    rows: [expect.objectContaining({ content: "owned portable message" })],
  });
  expect(table("app_analytics")).toMatchObject({
    policy: "portable_subject_data",
    rows: [expect.objectContaining({ total_requests: 7 })],
  });
  expect(table("secret_audit_log")).toMatchObject({
    policy: "retained_security_audit",
    rows: [
      expect.objectContaining({
        action: "owned-read",
        access_token: "[REDACTED_SECURITY_MATERIAL]",
      }),
    ],
  });
  expect(table("app_billing_registrations")?.rows).toEqual([
    expect.objectContaining({
      owner_organization_id: ORGANIZATION_ID,
      registered_by_user_id: USER_ID,
    }),
  ]);
  expect(table("organization_policy_audit")?.rows).toEqual([
    expect.objectContaining({
      organization_id: ORGANIZATION_ID,
      reason: "manual_override",
      actor: USER_ID,
      change: { completionsRpm: 7 },
    }),
  ]);
  expect(table("organization_subscription_authorities")?.rows).toEqual([
    expect.objectContaining({
      organization_id: ORGANIZATION_ID,
      state: "none",
      subscription_id: null,
    }),
  ]);
  const accounts = table("app_subscriber_accounts")?.rows;
  expect(accounts).toHaveLength(2);
  expect(accounts?.every((row) => row.subscriber_user_id === USER_ID)).toBe(true);
  expect(new Set(accounts?.map((row) => row.app_id))).toEqual(
    new Set(["55555555-5555-4555-8555-555555555551", "55555555-5555-4555-8555-555555555552"]),
  );
  expect(table("subscription_notice_intents")?.rows).toEqual([
    expect.objectContaining({
      organization_id: ORGANIZATION_ID,
      subscription_id: "99999999-9999-4999-8999-999999999981",
      source_revision: 1,
      state: "uncertain",
    }),
  ]);
  expect(table("subscription_notice_attempts")?.rows).toEqual([
    expect.objectContaining({
      organization_id: ORGANIZATION_ID,
      notice_id: "99999999-9999-4999-8999-999999999991",
      status: "uncertain",
      reason: "submission_outcome_unrecorded",
    }),
  ]);
  expect(JSON.stringify(artifact)).not.toContain("foreign");
  expect(JSON.stringify(artifact)).not.toContain("owned-secret");
});
