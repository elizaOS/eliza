/** Executes every explicit portable-export join against isolated real PGlite tables. */

import { afterAll, beforeAll, expect, mock, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

mock.module("../../db/account-deletion-foreign-key-policy", () => ({
  ACCOUNT_DELETION_FOREIGN_KEY_SNAPSHOT_SHA256: "f".repeat(64),
  listAccountDeletionForeignKeys: () => [
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

const { closeDatabaseConnectionsForTests } = await import("../../db/client");
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
      name text NOT NULL
    )`,
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
      ('55555555-5555-4555-8555-555555555551', '${ORGANIZATION_ID}', 'Owned app'),
      ('55555555-5555-4555-8555-555555555552', '${FOREIGN_ORGANIZATION_ID}', 'Foreign app')`,
    `INSERT INTO app_analytics VALUES
      ('66666666-6666-4666-8666-666666666661', '55555555-5555-4555-8555-555555555551', 7),
      ('66666666-6666-4666-8666-666666666662', '55555555-5555-4555-8555-555555555552', 99)`,
    `INSERT INTO secret_audit_log VALUES
      ('77777777-7777-4777-8777-777777777771', '${ORGANIZATION_ID}', 'owned-read', 'owned-secret'),
      ('77777777-7777-4777-8777-777777777772', '${FOREIGN_ORGANIZATION_ID}', 'foreign-read', 'foreign-secret')`,
  ]) {
    await dbWrite.execute(statement);
  }
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
  expect(JSON.stringify(artifact)).not.toContain("foreign");
  expect(JSON.stringify(artifact)).not.toContain("owned-secret");
});
