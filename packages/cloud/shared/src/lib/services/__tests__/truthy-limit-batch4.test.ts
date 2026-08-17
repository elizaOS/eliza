/**
 * Proves truthy-limit batch4: 0 preserved via ?? / isFinite (rank 8 systematic).
 * Covers mcp (Number||10 → isFinite), app-earnings (||50/||0 → ??), memory (||50 → ??), agent-events grep.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const mcpPath = new URL("../../eliza/plugin-mcp/actions/mcp.ts", import.meta.url).pathname;
const earningsPath = new URL("../app-earnings.ts", import.meta.url).pathname;
const memoryPath = new URL("../memory.ts", import.meta.url).pathname;
const agentEventsPath = new URL("../../../db/repositories/agent-events.ts", import.meta.url).pathname;

describe("truthy-limit batch4 — file uses ??/isFinite not ||", () => {
  test("mcp uses Number.isFinite not || 10 for limit/offset", () => {
    const src = readFileSync(mcpPath, "utf8");
    expect(src).toContain("Number.isFinite(parsedLimit) ? parsedLimit : 10");
    expect(src).toContain("Number.isFinite(parsedOffset) ? parsedOffset : 0");
    expect(src).not.toContain("Number(params.limit) || 10");
    expect(src).not.toContain("Number(params.offset) || 0");
  });

  test("app-earnings uses ?? not || for limit/offset", () => {
    const src = readFileSync(earningsPath, "utf8");
    expect(src).toContain("options?.limit ?? 50");
    expect(src).toContain("options?.offset ?? 0");
    expect(src).not.toContain("options?.limit || 50");
    expect(src).not.toContain("options?.offset || 0");
  });

  test("memory uses ?? not || for lastN", () => {
    const src = readFileSync(memoryPath, "utf8");
    expect(src).toContain("input.lastN ?? 50");
    expect(src).not.toContain("input.lastN || 50");
  });

  test("agent-events uses ?? not || for limit", () => {
    const src = readFileSync(agentEventsPath, "utf8");
    expect(src).toContain("filters?.limit ?? 50");
    expect(src).toContain("filters?.limit ?? 100");
    expect(src).not.toContain("filters?.limit || 50");
    expect(src).not.toContain("filters?.limit || 100");
  });

  test("direct ?? vs || and isFinite proof", () => {
    const zero: number | undefined = 0;
    expect(zero ?? 50).toBe(0);
    expect((zero as any) || 50).toBe(50);
    expect(Number.isFinite(Number(0)) ? Number(0) : 10).toBe(0);
    expect((Number(0) as any) || 10).toBe(10);
    expect(Number.isFinite(NaN) ? NaN : 10).toBe(10);
    expect((NaN as any) || 10).toBe(10);
  });
});
