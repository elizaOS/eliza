/**
 * Exercises the DATABASE action through its real dispatcher, SQL safety guard,
 * result normalization, vector-search registration, and runtime boundaries.
 * The deterministic runtime records real module inputs without replacing the
 * action or its branch logic.
 */
import {
  type ActionParameters,
  type ActionResult,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type SearchCategoryRegistration,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { databaseAction, registerVectorSearchCategory } from "./database.ts";

interface DbResult {
  rows: unknown;
  fields?: Array<{ name: string }>;
}

interface RuntimeOptions {
  categoryRegistered?: boolean;
  dbResults?: Array<DbResult | Error>;
  embeddingResult?: unknown;
  memories?: Memory[];
  modelError?: Error;
  searchError?: Error;
  withoutDb?: boolean;
}

function rawSqlText(query: { queryChunks: unknown[] }): string {
  const first = query.queryChunks[0] as { value?: unknown } | undefined;
  return Array.isArray(first?.value)
    ? first.value.map((part) => String(part)).join("")
    : "";
}

function makeRuntime(options: RuntimeOptions = {}) {
  let categoryRegistered = options.categoryRegistered ?? false;
  const dbResults = [...(options.dbResults ?? [])];
  const queries: string[] = [];
  const registrations: SearchCategoryRegistration[] = [];
  const modelCalls: Array<{ model: unknown; input: unknown }> = [];
  const searches: unknown[] = [];

  const adapter = options.withoutDb
    ? {}
    : {
        db: {
          execute: async (query: { queryChunks: unknown[] }) => {
            const text = rawSqlText(query);
            queries.push(text);
            const next = dbResults.shift();
            if (!next) throw new Error(`Unexpected SQL: ${text}`);
            if (next instanceof Error) throw next;
            return next;
          },
        },
      };

  const runtime = {
    adapter,
    getSearchCategory: (category: string) => {
      if (!categoryRegistered || category !== "vectors") {
        throw new Error(`Unknown search category: ${category}`);
      }
      return registrations.at(-1) ?? { category: "vectors" };
    },
    registerSearchCategory: (registration: SearchCategoryRegistration) => {
      categoryRegistered = true;
      registrations.push(registration);
    },
    useModel: async (model: unknown, input: unknown) => {
      modelCalls.push({ model, input });
      if (options.modelError) throw options.modelError;
      return Object.hasOwn(options, "embeddingResult")
        ? options.embeddingResult
        : [0.25, 0.75];
    },
    searchMemories: async (params: unknown) => {
      searches.push(params);
      if (options.searchError) throw options.searchError;
      return options.memories ?? [];
    },
  } as unknown as IAgentRuntime;

  return { runtime, modelCalls, queries, registrations, searches };
}

async function run(
  runtime: IAgentRuntime,
  parameters?: ActionParameters,
): Promise<ActionResult> {
  const result = await databaseAction.handler(
    runtime,
    {} as Memory,
    undefined,
    parameters ? { parameters } : undefined,
  );
  if (!result) throw new Error("DATABASE handler returned no result");
  return result;
}

describe("DATABASE search category registration", () => {
  it("registers the vector category once and exposes its searchable tables", () => {
    const { runtime, registrations } = makeRuntime();

    registerVectorSearchCategory(runtime);
    registerVectorSearchCategory(runtime);

    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({
      category: "vectors",
      contexts: ["admin", "documents"],
      capabilities: ["semantic", "embeddings", "database"],
    });
    expect(
      registrations[0].filters
        ?.find((filter) => filter.name === "table")
        ?.options?.map((option) => option.value),
    ).toEqual([
      "messages",
      "memories",
      "facts",
      "documents",
      "document_fragments",
    ]);
  });

  it("leaves an existing category untouched and validates the action", async () => {
    const { runtime, registrations } = makeRuntime({
      categoryRegistered: true,
    });

    await expect(databaseAction.validate(runtime, {} as Memory)).resolves.toBe(
      true,
    );
    expect(registrations).toHaveLength(0);
    expect(databaseAction).toMatchObject({
      name: "DATABASE",
      roleGate: { minRole: "OWNER" },
    });
  });
});

describe("DATABASE dispatch", () => {
  it("rejects missing and unknown operations without touching the adapter", async () => {
    const missing = makeRuntime();
    const missingResult = await run(missing.runtime);
    expect(missingResult).toMatchObject({
      success: false,
      values: { error: "DATABASE_INVALID", received: null },
    });
    expect(missing.queries).toHaveLength(0);

    const unknown = makeRuntime();
    const unknownResult = await run(unknown.runtime, { action: "vacuum" });
    expect(unknownResult).toMatchObject({
      success: false,
      values: { error: "DATABASE_INVALID", received: "vacuum" },
    });
    expect(unknown.queries).toHaveLength(0);
  });

  it.each(["action", "subaction", "op"] as const)(
    "accepts the operation through the %s parameter",
    async (parameterName) => {
      const observed = makeRuntime({
        dbResults: [{ rows: [{ answer: 42 }] }],
      });

      const result = await run(observed.runtime, {
        [parameterName]: "query",
        sql: "SELECT 42 AS answer",
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        op: "query",
        result: {
          columns: ["answer"],
          rows: [{ answer: 42 }],
          rowCount: 1,
        },
      });
      expect(observed.queries).toEqual(["SELECT 42 AS answer"]);
    },
  );
});

describe("DATABASE list_tables", () => {
  it("preserves database ordering and maps columns onto their schema-qualified table", async () => {
    const observed = makeRuntime({
      dbResults: [
        {
          rows: [
            { schema: "audit", name: "events", row_count: "2" },
            null,
            { schema: "public", name: "empty_table", row_count: null },
          ],
        },
        {
          rows: [
            {
              schema: "audit",
              table_name: "events",
              name: "id",
              type: "uuid",
              nullable: false,
              default_value: "gen_random_uuid()",
              is_primary_key: true,
            },
            {
              schema: "audit",
              table_name: "events",
              name: "payload",
              type: "jsonb",
              nullable: true,
              default_value: null,
              is_primary_key: false,
            },
          ],
        },
      ],
    });

    const result = await run(observed.runtime, { action: "list_tables" });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      op: "list_tables",
      totalBeforeFilter: 2,
      tables: [
        {
          name: "events",
          schema: "audit",
          rowCount: 2,
          columns: [
            {
              name: "id",
              type: "uuid",
              nullable: false,
              defaultValue: "gen_random_uuid()",
              isPrimaryKey: true,
            },
            {
              name: "payload",
              type: "jsonb",
              nullable: true,
              defaultValue: null,
              isPrimaryKey: false,
            },
          ],
        },
        {
          name: "empty_table",
          schema: "public",
          rowCount: 0,
          columns: [],
        },
      ],
    });
    expect(observed.queries[0]).toContain(
      "ORDER BY t.table_schema, t.table_name",
    );
    expect(observed.queries[1]).toContain(
      "ORDER BY c.table_schema, c.table_name, c.ordinal_position",
    );
  });

  it("returns a distinct empty state when the database has no user tables", async () => {
    const observed = makeRuntime({
      dbResults: [{ rows: [] }, { rows: [] }],
    });

    const result = await run(observed.runtime, { action: "list_tables" });

    expect(result).toMatchObject({
      success: true,
      text: "No tables found.",
      values: { count: 0, totalBeforeFilter: 0 },
      data: { tables: [], filter: "", includeEmpty: true },
    });
  });

  it("combines case-insensitive filtering with empty-table exclusion", async () => {
    const tables = [
      { schema: "public", name: "Memories", row_count: 3 },
      { schema: "public", name: "memory_archive", row_count: 0 },
      { schema: "public", name: "rooms", row_count: 2 },
    ];
    const observed = makeRuntime({
      dbResults: [{ rows: tables }, { rows: [] }],
    });

    const result = await run(observed.runtime, {
      action: "list_tables",
      filter: "  MEM  ",
      includeEmpty: false,
    });

    expect(result.data).toMatchObject({
      filter: "mem",
      includeEmpty: false,
      tables: [{ name: "Memories" }],
      totalBeforeFilter: 3,
    });
    expect(result.text).toContain(
      'narrowed by name contains "mem" and includeEmpty:false',
    );
    expect(result.text).toContain("drop the filter or pass includeEmpty:true");
  });
});

describe("DATABASE get_table", () => {
  it("rejects a missing table name before issuing SQL", async () => {
    const observed = makeRuntime();

    const result = await run(observed.runtime, {
      action: "get_table",
      tableName: "   ",
    });

    expect(result).toMatchObject({
      success: false,
      values: {
        error: "DATABASE_GET_TABLE_FAILED",
        reason: "MISSING_TABLE",
      },
    });
    expect(observed.queries).toHaveLength(0);
  });

  it("escapes a table name during existence checks and reports a miss", async () => {
    const observed = makeRuntime({ dbResults: [{ rows: [] }] });

    const result = await run(observed.runtime, {
      action: "get_table",
      tableName: "owner's notes",
    });

    expect(result).toMatchObject({
      success: false,
      values: {
        error: "DATABASE_GET_TABLE_FAILED",
        reason: "TABLE_NOT_FOUND",
      },
    });
    expect(observed.queries[0]).toContain("table_name = 'owner''s notes'");
  });

  it("quotes identifiers, validates sorting, caps the page, and filters non-row values", async () => {
    const observed = makeRuntime({
      dbResults: [
        { rows: [{ exists: 1 }] },
        { rows: [{ column_name: 'created"at' }] },
        { rows: [{ total: "2" }] },
        {
          rows: [{ id: 1 }, null, "not-a-row", { id: 2 }],
          fields: [{ name: "id" }],
        },
      ],
    });

    const result = await run(observed.runtime, {
      action: "get_table",
      tableName: 'audit"log',
      limit: 900,
      offset: 4.9,
      sortBy: 'created"at',
      sortDir: "desc",
    });

    expect(result).toMatchObject({
      success: true,
      values: { rowCount: 2, total: 2 },
      data: {
        tableName: 'audit"log',
        rows: [{ id: 1 }, { id: 2 }],
        columns: ["id"],
        total: 2,
        offset: 4,
        limit: 500,
      },
    });
    expect(observed.queries[3]).toContain(
      'SELECT * FROM "audit""log" ORDER BY "created""at" DESC LIMIT 500 OFFSET 4',
    );
  });

  it("omits an invalid sort and clamps pagination to its lower bounds", async () => {
    const observed = makeRuntime({
      dbResults: [
        { rows: [{ exists: 1 }] },
        { rows: [{ column_name: "id" }] },
        { rows: [] },
        { rows: [{ id: 7 }] },
      ],
    });

    const result = await run(observed.runtime, {
      action: "get_table",
      tableName: "events",
      limit: 0,
      offset: -8,
      sortBy: "missing_column",
      sortDir: "desc",
    });

    expect(result.data).toMatchObject({
      columns: ["id"],
      total: 0,
      offset: 0,
      limit: 1,
    });
    expect(observed.queries[3]).toContain(
      'SELECT * FROM "events"  LIMIT 1 OFFSET 0',
    );
    expect(observed.queries[3]).not.toContain("ORDER BY");
  });
});

describe("DATABASE query", () => {
  it("rejects missing SQL and blocks a mutation before adapter execution", async () => {
    const missing = makeRuntime();
    const missingResult = await run(missing.runtime, {
      action: "query",
      sql: "   ",
    });
    expect(missingResult.values).toMatchObject({
      error: "DATABASE_QUERY_FAILED",
      reason: "MISSING_SQL",
    });
    expect(missing.queries).toHaveLength(0);

    const mutation = makeRuntime();
    const mutationResult = await run(mutation.runtime, {
      action: "query",
      sql: "DELETE FROM memories",
    });
    expect(mutationResult).toMatchObject({
      success: false,
      values: {
        error: "DATABASE_QUERY_FAILED",
        reason: "MUTATION_BLOCKED",
      },
      data: { actionName: "DATABASE", op: "query" },
    });
    expect(mutationResult.text).toContain('"DELETE" is a mutation keyword');
    expect(mutation.queries).toHaveLength(0);
  });

  it("normalizes a read result and derives columns when fields are absent", async () => {
    const observed = makeRuntime({
      dbResults: [
        {
          rows: [{ id: 1, label: "first" }, false, { id: 2, label: "second" }],
        },
      ],
    });

    const result = await run(observed.runtime, {
      action: "query",
      sql: "  SELECT id, label FROM items  ",
    });

    expect(result.success).toBe(true);
    expect(result.values).toMatchObject({ rowCount: 2, allowWrites: false });
    expect(result.data).toMatchObject({
      result: {
        columns: ["id", "label"],
        rows: [
          { id: 1, label: "first" },
          { id: 2, label: "second" },
        ],
        rowCount: 2,
      },
    });
    expect(observed.queries).toEqual(["SELECT id, label FROM items"]);
    expect(
      (result.values as { durationMs: number }).durationMs,
    ).toBeGreaterThanOrEqual(0);
  });

  it("executes a mutation only when allowWrites is explicitly true", async () => {
    const observed = makeRuntime({
      dbResults: [{ rows: [], fields: [{ name: "affected" }] }],
    });

    const result = await run(observed.runtime, {
      action: "query",
      sql: "UPDATE memories SET content = '{}'",
      allowWrites: true,
    });

    expect(result.success).toBe(true);
    expect(result.values).toMatchObject({ rowCount: 0, allowWrites: true });
    expect(result.data).toMatchObject({
      result: { columns: ["affected"], rows: [], rowCount: 0 },
    });
    expect(observed.queries).toEqual(["UPDATE memories SET content = '{}'"]);
  });

  it("translates a missing Drizzle adapter and execution failure", async () => {
    const missingAdapter = makeRuntime({ withoutDb: true });
    const missingAdapterResult = await run(missingAdapter.runtime, {
      action: "query",
      sql: "SELECT 1",
    });
    expect(missingAdapterResult).toMatchObject({
      success: false,
      values: { error: "DATABASE_QUERY_FAILED" },
    });
    expect(missingAdapterResult.text).toContain(
      "Runtime adapter does not expose a Drizzle database",
    );

    const failedQuery = makeRuntime({
      dbResults: [new Error("database offline")],
    });
    const failedQueryResult = await run(failedQuery.runtime, {
      action: "query",
      sql: "SELECT 1",
    });
    expect(failedQueryResult).toMatchObject({
      success: false,
      values: { error: "DATABASE_QUERY_FAILED" },
    });
    expect(failedQueryResult.text).toContain("database offline");
  });
});

describe("DATABASE search_vectors", () => {
  it("registers the category before rejecting missing input or a disallowed table", async () => {
    const missing = makeRuntime();
    const missingResult = await run(missing.runtime, {
      action: "search_vectors",
      query: "   ",
    });
    expect(missingResult.values).toMatchObject({
      error: "DATABASE_SEARCH_VECTORS_FAILED",
      reason: "MISSING_QUERY",
    });
    expect(missing.registrations).toHaveLength(1);
    expect(missing.modelCalls).toHaveLength(0);

    const disallowed = makeRuntime();
    const disallowedResult = await run(disallowed.runtime, {
      action: "search_vectors",
      query: "road trip",
      table: "users",
    });
    expect(disallowedResult.values).toMatchObject({
      error: "DATABASE_SEARCH_VECTORS_FAILED",
      reason: "TABLE_NOT_ALLOWED",
    });
    expect(disallowedResult.text).toContain('table "users" is not searchable');
    expect(disallowed.modelCalls).toHaveLength(0);
  });

  it.each([null, [], {}, { embedding: [] }])(
    "rejects an unusable embedding result %#",
    async (embeddingResult) => {
      const observed = makeRuntime({ embeddingResult });

      const result = await run(observed.runtime, {
        action: "search_vectors",
        query: "road trip",
      });

      expect(result).toMatchObject({
        success: false,
        values: {
          error: "DATABASE_SEARCH_VECTORS_FAILED",
          reason: "NO_EMBEDDING",
        },
      });
      expect(observed.searches).toHaveLength(0);
    },
  );

  it("uses object embeddings, lower-limit clamping, and the default table", async () => {
    const observed = makeRuntime({
      embeddingResult: { embedding: [0.4, 0.6] },
    });

    const result = await run(observed.runtime, {
      action: "search_vectors",
      query: "  road trip  ",
      limit: 0,
    });

    expect(observed.modelCalls).toEqual([
      {
        model: ModelType.TEXT_EMBEDDING,
        input: { text: "road trip" },
      },
    ]);
    expect(observed.searches).toEqual([
      { embedding: [0.4, 0.6], tableName: "messages", limit: 1 },
    ]);
    expect(result).toMatchObject({
      success: true,
      text: 'No matches for "road trip" in messages.',
      values: { count: 0, table: "messages" },
      data: { query: "road trip", table: "messages", limit: 1, results: [] },
    });
  });

  it("caps results, forwards numeric thresholds, and formats complete and sparse hits", async () => {
    const sparseHit = {
      content: {},
      roomId: null,
      entityId: null,
    } as unknown as Memory;
    const observed = makeRuntime({
      embeddingResult: [0.2, 0.8],
      memories: [
        {
          id: "00000000-0000-0000-0000-000000000001",
          content: { text: "\ud800  spaced\ntext" },
          roomId: "00000000-0000-0000-0000-000000000002",
          entityId: "00000000-0000-0000-0000-000000000003",
          createdAt: 17,
          similarity: 0.8759,
        } as unknown as Memory,
        sparseHit,
      ],
    });

    const result = await run(observed.runtime, {
      action: "search_vectors",
      query: "similar memory",
      table: "facts",
      limit: 999,
      threshold: 0.55,
    });

    expect(observed.searches).toEqual([
      {
        embedding: [0.2, 0.8],
        tableName: "facts",
        limit: 100,
        match_threshold: 0.55,
      },
    ]);
    expect(result.text).toContain("1. [0.876] � spaced text");
    expect(result.text).toContain("2. [n/a] ");
    expect(result.data).toMatchObject({
      table: "facts",
      limit: 100,
      results: [
        {
          similarity: 0.8759,
          createdAt: 17,
          tableName: "facts",
        },
        {
          id: null,
          text: "",
          similarity: null,
          roomId: null,
          entityId: null,
          createdAt: null,
          tableName: "facts",
        },
      ],
    });
  });

  it("translates model and search failures with the operation-specific code", async () => {
    const modelFailure = makeRuntime({
      modelError: new Error("embed offline"),
    });
    const modelResult = await run(modelFailure.runtime, {
      action: "search_vectors",
      query: "road trip",
    });
    expect(modelResult).toMatchObject({
      success: false,
      values: { error: "DATABASE_SEARCH_VECTORS_FAILED" },
    });
    expect(modelResult.text).toContain("embed offline");

    const searchFailure = makeRuntime({
      searchError: new Error("vector index offline"),
    });
    const searchResult = await run(searchFailure.runtime, {
      action: "search_vectors",
      query: "road trip",
    });
    expect(searchResult).toMatchObject({
      success: false,
      values: { error: "DATABASE_SEARCH_VECTORS_FAILED" },
    });
    expect(searchResult.text).toContain("vector index offline");
  });
});
