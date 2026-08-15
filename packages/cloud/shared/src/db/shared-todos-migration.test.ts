/** Applies the Shared Todo tables to real PGlite and proves their tenant boundaries. */

import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { todoMutationsTable, todosTable } from "../../../../../plugins/plugin-todos/src/db/schema";

describe("0206-0207 Shared Todos", () => {
  const databases: PGlite[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  test("is registered and matches the canonical plugin schema", async () => {
    const database = new PGlite();
    databases.push(database);
    const todosMigration = await readFile(
      new URL("./migrations/0206_shared_todos.sql", import.meta.url),
      "utf8",
    );
    const mutationMigration = await readFile(
      new URL("./migrations/0207_todo_mutation_ledger.sql", import.meta.url),
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

    expect(journal.entries.some((entry) => entry.tag === "0206_shared_todos")).toBe(true);
    expect(journal.entries.at(-1)).toEqual({
      idx: 206,
      version: "7",
      when: 1787601600000,
      tag: "0207_todo_mutation_ledger",
      breakpoints: true,
    });
    await database.exec(todosMigration);
    await database.exec(mutationMigration);
    await database.exec(todosMigration);
    await database.exec(mutationMigration);

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

    const client = drizzle(database, {
      schema: { todoMutationsTable, todosTable },
    });
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

    const mutationColumns = await database.query<{
      column_name: string;
      data_type: string;
      is_nullable: "YES" | "NO";
      column_default: string | null;
    }>(`
      SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = 'todos' AND table_name = 'todo_mutations'
       ORDER BY column_name
    `);
    expect(mutationColumns.rows).toEqual([
      {
        column_name: "agent_id",
        data_type: "uuid",
        is_nullable: "NO",
        column_default: null,
      },
      {
        column_name: "applied",
        data_type: "boolean",
        is_nullable: "NO",
        column_default: null,
      },
      {
        column_name: "committed_at",
        data_type: "timestamp with time zone",
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
        column_name: "idempotency_key",
        data_type: "text",
        is_nullable: "NO",
        column_default: null,
      },
      {
        column_name: "mutation_id",
        data_type: "uuid",
        is_nullable: "NO",
        column_default: "gen_random_uuid()",
      },
      {
        column_name: "operation",
        data_type: "text",
        is_nullable: "NO",
        column_default: null,
      },
      {
        column_name: "request_digest",
        data_type: "text",
        is_nullable: "NO",
        column_default: null,
      },
      {
        column_name: "result_json",
        data_type: "jsonb",
        is_nullable: "NO",
        column_default: null,
      },
    ]);

    const mutationIndexes = await database.query<{ indexname: string }>(`
      SELECT indexname
        FROM pg_indexes
       WHERE schemaname = 'todos' AND tablename = 'todo_mutations'
       ORDER BY indexname
    `);
    expect(mutationIndexes.rows.map((index) => index.indexname)).toEqual([
      "idx_todo_mutations_scope_commit",
      "todo_mutations_agent_entity_idempotency_key_unique",
      "todo_mutations_pkey",
    ]);

    const requestDigest = "a".repeat(64);
    const resultJson = {
      action: "create",
      todo: { content: "Prove Shared Todos" },
    };
    const [mutation] = await client
      .insert(todoMutationsTable)
      .values({
        agentId,
        entityId,
        idempotencyKey: "telegram:message-1:action-0",
        requestDigest,
        operation: "create",
        applied: true,
        resultJson,
      })
      .returning();

    expect(mutation).toMatchObject({
      agentId,
      entityId,
      idempotencyKey: "telegram:message-1:action-0",
      requestDigest,
      operation: "create",
      applied: true,
      resultJson,
    });
    expect(mutation?.mutationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(mutation?.committedAt).toBeInstanceOf(Date);

    await expect(
      database.exec(`
        INSERT INTO todos.todo_mutations (
          agent_id, entity_id, idempotency_key, request_digest, operation,
          applied, result_json
        ) VALUES (
          '${agentId}',
          '${entityId}',
          'telegram:message-1:action-0',
          '${"b".repeat(64)}',
          'delete',
          true,
          '{"action":"delete","deleted":null}'::jsonb
        );
      `),
    ).rejects.toThrow("todo_mutations_agent_entity_idempotency_key_unique");

    const otherEntityId = "df89c28c-e54c-439a-b5cd-cfc2bb0d6598";
    const otherAgentId = "21f69e67-c39d-45fc-9b42-3c9a5bc3bc19";
    await client.insert(todoMutationsTable).values([
      {
        agentId,
        entityId: otherEntityId,
        idempotencyKey: "telegram:message-1:action-0",
        requestDigest: "c".repeat(64),
        operation: "create",
        applied: true,
        resultJson: { action: "create", todo: { content: "Other entity" } },
      },
      {
        agentId: otherAgentId,
        entityId,
        idempotencyKey: "telegram:message-1:action-0",
        requestDigest: "d".repeat(64),
        operation: "create",
        applied: true,
        resultJson: { action: "create", todo: { content: "Other agent" } },
      },
    ]);
    const mutationRows = await client
      .select()
      .from(todoMutationsTable)
      .orderBy(asc(todoMutationsTable.agentId), asc(todoMutationsTable.entityId));
    expect(mutationRows).toHaveLength(3);
    expect(mutationRows.every((row) => row.operation === "create")).toBe(true);
    expect(mutationRows.every((row) => row.committedAt instanceof Date)).toBe(true);

    const originalScopeRows = await client
      .select()
      .from(todoMutationsTable)
      .where(
        and(eq(todoMutationsTable.agentId, agentId), eq(todoMutationsTable.entityId, entityId)),
      );
    expect(originalScopeRows).toHaveLength(1);
    expect(originalScopeRows[0]).toMatchObject({
      mutationId: mutation?.mutationId,
      idempotencyKey: "telegram:message-1:action-0",
      resultJson,
    });
  });
});
