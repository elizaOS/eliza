/**
 * Regression coverage for the prompt-reachable DATABASE action read-only guard.
 * These tests keep model-shaped SQL inputs on the same linear sanitizer path as
 * the dashboard API guard without importing the full action runtime graph.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { checkReadOnly } from "../security/sql-readonly-guard.ts";
import { databaseAction } from "./database.ts";

describe("DATABASE action read-only guard", () => {
  it("rejects the context-ordering regression before adapter execution", async () => {
    const execute = vi.fn();
    const runtime = {
      adapter: { db: { execute } },
    } as unknown as IAgentRuntime;
    const result = await databaseAction.handler(
      runtime,
      {} as Memory,
      undefined,
      {
        parameters: {
          action: "query",
          sql: "SELECT 'value--'; DELETE FROM memories",
        },
      },
    );

    expect(result).toMatchObject({
      success: false,
      values: { error: "DATABASE_QUERY_FAILED", reason: "MUTATION_BLOCKED" },
    });
    expect(result?.text).toContain("DELETE");
    expect(execute).not.toHaveBeenCalled();
  });

  it("collapses block-comment-split mutation keywords", () => {
    expect(checkReadOnly("DE/* */LETE FROM memories")).toMatchObject({
      ok: false,
      reason:
        '"DELETE" is a mutation keyword. Set allowWrites:true to execute mutations.',
    });
  });

  it("ignores mutation keywords inside closed dollar-quoted strings", () => {
    expect(checkReadOnly("SELECT $$DELETE FROM memories$$")).toEqual({
      ok: true,
    });
  });

  it("blocks dangerous functions outside dollar-quoted strings", () => {
    expect(checkReadOnly("SELECT pg_sleep(10)")).toMatchObject({
      ok: false,
      reason:
        '"PG_SLEEP" is a dangerous function. Set allowWrites:true to execute.',
    });
  });

  it("blocks unicode-escaped identifiers that can hide dangerous functions", () => {
    expect(checkReadOnly("SELECT U&\"s\\0065tval\"('seq', 2)")).toMatchObject({
      ok: false,
      reason:
        'Unicode-escaped identifiers (U&"...") are not allowed in read-only mode: they can hide a dangerous function name from the guard.',
    });
  });

  it("stays fast on unterminated block comments from model-generated SQL", () => {
    const sql = `SELECT 1 /*${" /*".repeat(200_000)}`;
    const start = performance.now();
    const result = checkReadOnly(sql);
    const elapsed = performance.now() - start;

    expect(result).toMatchObject({ ok: false });
    expect(elapsed).toBeLessThan(1000);
  });

  it("stays fast on unterminated dollar quotes from model-generated SQL", () => {
    const sql = `SELECT $tag$${" $tag2$".repeat(200_000)}`;
    const start = performance.now();
    const result = checkReadOnly(sql);
    const elapsed = performance.now() - start;

    expect(result).toMatchObject({ ok: false });
    expect(elapsed).toBeLessThan(1000);
  });
});
