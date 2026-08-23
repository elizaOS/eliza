/** Applies the group participant identity registry migration to real PGlite. */

import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

const bindingsMigration = await Bun.file(
  new URL("./0297_personal_shared_group_bindings.sql", import.meta.url),
).text();
const migration = await Bun.file(
  new URL("./0311_personal_shared_group_participants.sql", import.meta.url),
).text();
const databases: PGlite[] = [];
const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const BINDING = "44444444-4444-4444-8444-444444444444";
const OTHER_BINDING = "55555555-5555-4555-8555-555555555555";

async function database(): Promise<PGlite> {
  const db = new PGlite();
  databases.push(db);
  await db.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY);
    INSERT INTO organizations (id) VALUES ('${ORG}');
    INSERT INTO users (id) VALUES ('${USER}');
  `);
  await db.exec(bindingsMigration);
  await db.exec(migration);
  for (const id of [BINDING, OTHER_BINDING]) {
    await db.query(
      `INSERT INTO personal_shared_group_bindings
         (id, organization_id, owner_user_id, personal_agent_id, platform, project,
          connector_account_id, provider_chat_id, conversation_id,
          created_by_platform_user_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'agent-1', 'blooio', 'eliza-app',
         '+15550000001', $4, $5, '+15551234567')`,
      [id, ORG, USER, `chat:${id}`, `group:${id}`],
    );
  }
  return db;
}

function insertParticipant(
  db: PGlite,
  columns: Record<string, string | number | null>,
): Promise<unknown> {
  const base: Record<string, string | number | null> = {
    binding_id: BINDING,
    platform_user_id: "+15551234567",
    ordinal: 1,
    ...columns,
  };
  const names = Object.keys(base);
  return db.query(
    `INSERT INTO personal_shared_group_participants (${names.join(", ")})
     VALUES (${names.map((_, index) => `$${index + 1}`).join(", ")})`,
    names.map((name) => base[name]),
  );
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()));
});

describe("0311 Personal Shared group participants", () => {
  test("keeps one row per connector handle within a binding", async () => {
    const db = await database();
    await insertParticipant(db, {});
    await expect(insertParticipant(db, { ordinal: 2 })).rejects.toThrow();
    // The same person in another group is a distinct participant with their
    // own ordinal, so labels never bleed across bindings.
    await insertParticipant(db, { binding_id: OTHER_BINDING });
  });

  test("refuses to give two participants the same ordinal in one binding", async () => {
    const db = await database();
    await insertParticipant(db, {});
    await expect(
      insertParticipant(db, { platform_user_id: "+15559990000", ordinal: 1 }),
    ).rejects.toThrow();
    await insertParticipant(db, { platform_user_id: "+15559990000", ordinal: 2 });
    // Ordinal 1 is free again in a different binding.
    await insertParticipant(db, { binding_id: OTHER_BINDING, ordinal: 1 });
  });

  test("rejects an ordinal that could not label anyone", async () => {
    const db = await database();
    await expect(insertParticipant(db, { ordinal: 0 })).rejects.toThrow();
    await expect(insertParticipant(db, { ordinal: -1 })).rejects.toThrow();
  });

  test("rejects a display name that would render as a nameless label", async () => {
    const db = await database();
    await expect(insertParticipant(db, { display_name: "" })).rejects.toThrow();
    await expect(insertParticipant(db, { display_name: "n".repeat(129) })).rejects.toThrow();
    // Null is the shipped state for a connector that sends no name, and
    // the fallback whenever a supplied name is rejected.
    await insertParticipant(db, { display_name: null });
    const { rows } = await db.query<{ display_name: string | null; ordinal: number }>(
      "SELECT display_name, ordinal FROM personal_shared_group_participants",
    );
    expect(rows).toEqual([{ display_name: null, ordinal: 1 }]);
  });

  test("stamps first and last seen on insert", async () => {
    const db = await database();
    await insertParticipant(db, {});
    const { rows } = await db.query<{ first_seen_at: Date; last_seen_at: Date }>(
      "SELECT first_seen_at, last_seen_at FROM personal_shared_group_participants",
    );
    expect(rows[0]?.first_seen_at).toBeInstanceOf(Date);
    expect(rows[0]?.last_seen_at).toBeInstanceOf(Date);
  });

  test("drops the roster with its binding", async () => {
    const db = await database();
    await insertParticipant(db, {});
    await db.query("DELETE FROM personal_shared_group_bindings WHERE id = $1", [BINDING]);
    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM personal_shared_group_participants",
    );
    expect(rows[0]?.count).toBe("0");
  });

  test("refuses a participant for a binding that does not exist", async () => {
    const db = await database();
    await expect(
      insertParticipant(db, { binding_id: "66666666-6666-4666-8666-666666666666" }),
    ).rejects.toThrow();
  });
});
