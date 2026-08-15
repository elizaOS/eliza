/**
 * DATABASE op:list_tables must disclose the narrowing it applied. `filter`
 * (substring on table name) and `includeEmpty:false` (drops zero-row tables)
 * both run silently, so "No tables found." read as an empty database and
 * "Found 7 table(s)" read as the schema's full table count while `allTables`
 * held the real one. Deterministic: the Drizzle adapter is a stub whose first
 * execute() answers the tables query and whose second answers the columns
 * query, matching opListTables' fixed call order.
 */
import type { ActionResult, IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";

import { databaseAction } from "./database.ts";

interface TableRow {
  schema: string;
  name: string;
  row_count: number;
}

function makeRuntime(tables: TableRow[]): IAgentRuntime {
  let call = 0;
  const columnRows = tables.map((table) => ({
    schema: table.schema,
    table_name: table.name,
    name: "id",
    type: "uuid",
    nullable: false,
    default_value: null,
    is_primary_key: true,
  }));
  return {
    registerSearchCategory: () => undefined,
    adapter: {
      db: {
        execute: async () => {
          call += 1;
          return { rows: call === 1 ? tables : columnRows, fields: undefined };
        },
      },
    },
  } as unknown as IAgentRuntime;
}

async function listTables(
  runtime: IAgentRuntime,
  parameters: Record<string, unknown>,
): Promise<ActionResult> {
  const result = await databaseAction.handler(
    runtime,
    {} as Memory,
    undefined,
    { parameters: { action: "list_tables", ...parameters } },
  );
  if (!result) throw new Error("handler returned no result");
  return result;
}

const SCHEMA: TableRow[] = [
  { schema: "public", name: "memories", row_count: 12 },
  { schema: "public", name: "entities", row_count: 4 },
  { schema: "public", name: "rooms", row_count: 0 },
  { schema: "public", name: "tasks", row_count: 3 },
];

describe("DATABASE list_tables scope disclosure", () => {
  it("names the filter and the pre-filter total on an empty result", async () => {
    const result = await listTables(makeRuntime(SCHEMA), { filter: "invoice" });
    const text = String(result.text ?? "");

    expect(text).not.toBe("No tables found.");
    expect(text).toContain('name contains "invoice"');
    expect(text).toContain("4 table(s) exist before filtering");
    expect(text).toContain("drop the filter");
    expect(result.values).toMatchObject({ count: 0, totalBeforeFilter: 4 });
  });

  it("names the filter and the pre-filter total on a populated result", async () => {
    const result = await listTables(makeRuntime(SCHEMA), { filter: "e" });
    const text = String(result.text ?? "");

    expect(text).toContain('narrowed by name contains "e"');
    expect(text).toContain("4 table(s) exist before filtering");
    expect(result.values).toMatchObject({ count: 2, totalBeforeFilter: 4 });
  });

  it("names includeEmpty:false as the narrowing that dropped zero-row tables", async () => {
    const result = await listTables(makeRuntime(SCHEMA), {
      includeEmpty: false,
    });
    const text = String(result.text ?? "");

    expect(text).toContain("includeEmpty:false");
    expect(text).toContain("4 table(s) exist before filtering");
    expect(text).toContain("pass includeEmpty:true");
    expect(text).not.toContain("- rooms ");
    expect(result.values).toMatchObject({ count: 3, totalBeforeFilter: 4 });
  });

  it("stays plain when nothing narrowed the list", async () => {
    const result = await listTables(makeRuntime(SCHEMA), {});
    const text = String(result.text ?? "");

    expect(text).toContain("Found 4 table(s):");
    expect(text).not.toContain("narrowed by");
  });
});
