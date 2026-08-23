/** Applies the inbound-media admission ledger migration to real PGlite. */

import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

const migration = await Bun.file(
  new URL("./0310_personal_shared_inbound_media_admission.sql", import.meta.url),
).text();
const databases: PGlite[] = [];
const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

async function database(): Promise<PGlite> {
  const db = new PGlite();
  databases.push(db);
  await db.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY);
    INSERT INTO organizations (id) VALUES ('${ORG}');
    INSERT INTO users (id) VALUES ('${USER}');
  `);
  await db.exec(migration);
  return db;
}

function insertDescription(
  db: PGlite,
  columns: Record<string, string | number | null>,
): Promise<unknown> {
  const base: Record<string, string | number | null> = {
    platform: "blooio",
    project: "eliza-app",
    connector_account_id: "+15550000001",
    source_message_id: "blooio:eliza-app:msg-1",
    organization_id: ORG,
    user_id: USER,
    media_digest: "digest",
    image_count: 1,
    claim_token: "44444444-4444-4444-8444-444444444444",
    lease_expires_at: "2026-08-23T00:02:00.000Z",
    ...columns,
  };
  const names = Object.keys(base);
  return db.query(
    `INSERT INTO personal_shared_inbound_media_descriptions (${names.join(", ")})
     VALUES (${names.map((_, index) => `$${index + 1}`).join(", ")})`,
    names.map((name) => base[name]),
  );
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe("0310 Personal Shared inbound media admission", () => {
  test("keeps one claim per connector message id", async () => {
    const db = await database();
    await insertDescription(db, {});
    await expect(
      insertDescription(db, { claim_token: "55555555-5555-4555-8555-555555555555" }),
    ).rejects.toThrow();
    // The same provider message id under another connector account is distinct.
    await insertDescription(db, { connector_account_id: "+15550000002" });
  });

  test("rejects terminal rows whose shape contradicts their state", async () => {
    const db = await database();
    await expect(
      insertDescription(db, { state: "described", description: null, completed_at: null }),
    ).rejects.toThrow();
    await expect(
      insertDescription(db, {
        state: "described",
        description: "a cat",
        failure_reason: "leftover",
        completed_at: "2026-08-23T00:01:00.000Z",
      }),
    ).rejects.toThrow();
    await expect(
      insertDescription(db, {
        state: "failed",
        failure_reason: null,
        completed_at: "2026-08-23T00:01:00.000Z",
      }),
    ).rejects.toThrow();
    await expect(
      insertDescription(db, { state: "pending", description: "early" }),
    ).rejects.toThrow();
    await expect(insertDescription(db, { image_count: 0 })).rejects.toThrow();
    await expect(insertDescription(db, { platform: "telegram" })).rejects.toThrow();
    await insertDescription(db, {
      state: "described",
      description: "a cat",
      completed_at: "2026-08-23T00:01:00.000Z",
    });
  });

  test("cascades ledger rows with their account and keeps counters bounded to one day bucket", async () => {
    const db = await database();
    await insertDescription(db, {});
    await db.exec(`DELETE FROM users WHERE id = '${USER}'`);
    const { rows } = await db.query(
      "SELECT count(*)::int AS count FROM personal_shared_inbound_media_descriptions",
    );
    expect(rows).toEqual([{ count: 0 }]);

    await db.exec(`INSERT INTO personal_shared_inbound_media_quotas
      (scope, scope_key, day, image_count) VALUES ('sender', '${ORG}', '2026-08-23', 3)`);
    await expect(
      db.exec(`INSERT INTO personal_shared_inbound_media_quotas
        (scope, scope_key, day, image_count) VALUES ('sender', '${ORG}', '2026-08-23', 1)`),
    ).rejects.toThrow();
    await expect(
      db.exec(`INSERT INTO personal_shared_inbound_media_quotas
        (scope, scope_key, day, image_count) VALUES ('owner', '${ORG}', '2026-08-23', 1)`),
    ).rejects.toThrow();
    await expect(
      db.exec(`INSERT INTO personal_shared_inbound_media_quotas
        (scope, scope_key, day, image_count) VALUES ('sender', '${ORG}', '2026-08-24', -1)`),
    ).rejects.toThrow();
    await db.exec(`INSERT INTO personal_shared_inbound_media_quotas
      (scope, scope_key, day, image_count) VALUES ('sender', '${ORG}', '2026-08-24', 0)`);
  });
});
