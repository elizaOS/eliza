/** Applies the shared_agent_memories migration to real PGlite and proves its shape and tenant fences. */

import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

describe("0210 shared_agent_memories", () => {
  const databases: PGlite[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  test("is registered, idempotent, and matches the core-shape tenant schema", async () => {
    const database = new PGlite();
    databases.push(database);
    const migration = await readFile(
      new URL("./migrations/0210_shared_agent_memories.sql", import.meta.url),
      "utf8",
    );
    const journal = JSON.parse(
      await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8"),
    ) as {
      entries: Array<{
        idx: number;
        version: string;
        when: number;
        tag: string;
        breakpoints: boolean;
      }>;
    };
    // Pinned by tag, not journal position, so later appended migrations do not
    // invalidate this registration proof.
    expect(journal.entries.find((entry) => entry.tag === "0210_shared_agent_memories")).toEqual({
      idx: 209,
      version: "7",
      when: 1787860800000,
      tag: "0210_shared_agent_memories",
      breakpoints: true,
    });

    // The FK targets exist long before 0210 in the real chain; recreate just
    // enough of them so the migration applies against a fresh database.
    await database.exec(`
      CREATE TABLE IF NOT EXISTS "organizations" ("id" uuid PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS "users" ("id" uuid PRIMARY KEY);
    `);
    await database.exec(migration);
    await database.exec(migration);

    const columns = await database.query<{
      column_name: string;
      data_type: string;
      is_nullable: "YES" | "NO";
    }>(`
      SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'shared_agent_memories'
       ORDER BY column_name
    `);
    expect(columns.rows).toEqual([
      { column_name: "agent_id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "content", data_type: "jsonb", is_nullable: "NO" },
      {
        column_name: "created_at",
        data_type: "timestamp without time zone",
        is_nullable: "NO",
      },
      { column_name: "embedding", data_type: "ARRAY", is_nullable: "YES" },
      { column_name: "embedding_model", data_type: "text", is_nullable: "YES" },
      { column_name: "entity_id", data_type: "uuid", is_nullable: "YES" },
      { column_name: "id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "organization_id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "room_id", data_type: "uuid", is_nullable: "YES" },
      { column_name: "type", data_type: "text", is_nullable: "NO" },
      { column_name: "user_id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "world_id", data_type: "uuid", is_nullable: "YES" },
    ]);

    const indexes = await database.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
       WHERE tablename = 'shared_agent_memories'
       ORDER BY indexname
    `);
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "idx_shared_agent_memories_tenant_room_recency",
      "idx_shared_agent_memories_tenant_type",
      "shared_agent_memories_pkey",
    ]);

    // Tenant fences: NOT NULL ownership and FK enforcement both hold.
    await database.exec(`
      INSERT INTO "organizations" ("id") VALUES ('11111111-1111-4111-8111-111111111111');
      INSERT INTO "users" ("id") VALUES ('22222222-2222-4222-8222-222222222222');
      INSERT INTO "shared_agent_memories"
        ("organization_id", "user_id", "agent_id", "type", "content", "embedding")
      VALUES (
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333',
        'messages',
        '{"text":"landed"}'::jsonb,
        ARRAY[0.25, 0.5]::real[]
      );
    `);
    await expect(
      database.exec(`
        INSERT INTO "shared_agent_memories"
          ("organization_id", "user_id", "agent_id", "type", "content")
        VALUES (
          '99999999-9999-4999-8999-999999999999',
          '22222222-2222-4222-8222-222222222222',
          '33333333-3333-4333-8333-333333333333',
          'messages',
          '{"text":"orphan org"}'::jsonb
        );
      `),
    ).rejects.toThrow(/foreign key/i);

    const stored = await database.query<{ embedding: number[]; type: string }>(
      `SELECT "embedding", "type" FROM "shared_agent_memories"`,
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.type).toBe("messages");
    expect(stored.rows[0]?.embedding).toEqual([0.25, 0.5]);
  });
});
