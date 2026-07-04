/**
 * Unit tests for `buildResultsGridRowKey`: composite keys use every primary-key
 * column, and rows without a complete primary key fall back to the row index.
 * Pure function; no DOM or backend.
 */

import { describe, expect, it } from "vitest";

import type { ColumnInfo } from "../../api";
import { buildResultsGridRowKey } from "./database-utils";

function col(primary: boolean): ColumnInfo {
  return {
    name: "",
    type: "text",
    isPrimaryKey: primary,
    nullable: false,
    defaultValue: null,
  };
}

describe("buildResultsGridRowKey", () => {
  it("uses every primary-key column for composite keys", () => {
    const meta = new Map<string, ColumnInfo>([
      ["agent_id", col(true)],
      ["entity_id", col(true)],
      ["body", col(false)],
    ]);

    expect(
      buildResultsGridRowKey(
        ["agent_id", "entity_id", "body"],
        { agent_id: "a", entity_id: "1", body: "first" },
        0,
        meta,
      ),
    ).not.toBe(
      buildResultsGridRowKey(
        ["agent_id", "entity_id", "body"],
        { agent_id: "a", entity_id: "2", body: "second" },
        1,
        meta,
      ),
    );
  });

  it("falls back to row index when there is no complete primary key", () => {
    const meta = new Map<string, ColumnInfo>([["id", col(true)]]);

    expect(buildResultsGridRowKey(["id"], { id: null }, 7, meta)).toBe(7);
    expect(buildResultsGridRowKey(["body"], { body: "x" }, 3, meta)).toBe(3);
  });
});
