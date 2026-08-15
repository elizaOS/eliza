/** Applies the Shared Todos migration to real PGlite through the plugin's canonical schema. */

import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { todosTable } from "../../../../../plugins/plugin-todos/src/db/schema";

describe("0206 Shared Todos", () => {
  const databases: PGlite[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  test("is registered and matches the canonical plugin schema", async () => {
    const database = new PGlite();
    databases.push(database);
    const migration = await readFile(
      new URL("./migrations/0206_shared_todos.sql", import.meta.url),
      "utf8",
    );
    const journal = JSON.parse(
      await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8"),
    ) as { entries: Array<{ tag: string }> };

    expect(journal.entries.some((entry) => entry.tag === "0206_shared_todos")).toBe(true);
    await database.exec(migration);
    await database.exec(migration);

    const columns = await database.query<{
      column_name: string;
      data_type: string;
      is_nullable: "YES" | "NO";
      column_default: string | null;
    }>(`
      SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = 'todos' AND table_name = 'todos'
       ORDER BY column_name
    `);
    expect(columns.rows).toEqual([
      {
        column_name: "active_form",
        data_type: "text",
        is_nullable: "NO",
        column_default: null,
      },
      {
        column_name: "agent_id",
        data_type: "uuid",
        is_nullable: "NO",
        column_default: null,
      },
      {
        column_name: "completed_at",
        data_type: "timestamp without time zone",
        is_nullable: "YES",
        column_default: null,
      },
      {
        column_name: "content",
        data_type: "text",
        is_nullable: "NO",
        column_default: null,
      },
      {
        column_name: "created_at",
        data_type: "timestamp without time zone",
        is_nullable: "NO",
        column_default: "now()",
      },
      {
        column_name: "entity_id",
        data_type: "uuid",
        is_nullable: "NO",
        column_default: null,
      },
      {
        column_name: "id",
        data_type: "uuid",
        is_nullable: "NO",
        column_default: "gen_random_uuid()",
      },
      {
        column_name: "metadata",
        data_type: "jsonb",
        is_nullable: "NO",
        column_default: "'{}'::jsonb",
      },
      {
        column_name: "parent_todo_id",
        data_type: "uuid",
        is_nullable: "YES",
        column_default: null,
      },
      {
        column_name: "parent_trajectory_step_id",
        data_type: "text",
        is_nullable: "YES",
        column_default: null,
      },
      {
        column_name: "room_id",
        data_type: "uuid",
        is_nullable: "YES",
        column_default: null,
      },
      {
        column_name: "status",
        data_type: "text",
        is_nullable: "NO",
        column_default: null,
      },
      {
        column_name: "updated_at",
        data_type: "timestamp without time zone",
        is_nullable: "NO",
        column_default: "now()",
      },
      {
        column_name: "world_id",
        data_type: "uuid",
        is_nullable: "YES",
        column_default: null,
      },
    ]);
    const indexes = await database.query<{ indexname: string }>(`
      SELECT indexname
        FROM pg_indexes
       WHERE schemaname = 'todos' AND tablename = 'todos'
       ORDER BY indexname
    `);
    expect(indexes.rows.map((index) => index.indexname)).toEqual([
      "idx_todos_agent_entity",
      "idx_todos_entity_status",
      "idx_todos_room",
      "todos_pkey",
    ]);

    const client = drizzle(database, { schema: { todosTable } });
    const agentId = "d67cf563-74cf-4514-89a3-af4f4fd38c6c";
    const entityId = "6dcd5bb9-36f9-4323-8347-5f53f4de9d4d";
    const [created] = await client
      .insert(todosTable)
      .values({
        agentId,
        entityId,
        content: "Prove Shared Todos",
        activeForm: "Proving Shared Todos",
        status: "pending",
        metadata: { source: "shared" },
      })
      .returning();

    expect(created).toMatchObject({
      agentId,
      entityId,
      content: "Prove Shared Todos",
      activeForm: "Proving Shared Todos",
      status: "pending",
      parentTodoId: null,
      metadata: { source: "shared" },
      completedAt: null,
    });
    expect(created?.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created?.createdAt).toBeInstanceOf(Date);
    expect(created?.updatedAt).toBeInstanceOf(Date);
  });
});
