import { describe, expect, test } from "bun:test";
import { getRow } from "../../types";

describe("getRow", () => {
  test("returns first row by default", () => {
    const result = { rows: [{ id: 1, name: "test" }] };
    const row = getRow<{ id: number; name: string }>(result);
    expect(row).toEqual({ id: 1, name: "test" });
  });

  test("returns row at specified index", () => {
    const result = { rows: [{ id: 1 }, { id: 2 }, { id: 3 }] };
    const row = getRow<{ id: number }>(result, 1);
    expect(row).toEqual({ id: 2 });
  });

  test("returns last row when index is length - 1", () => {
    const result = { rows: [{ id: 1 }, { id: 2 }, { id: 3 }] };
    const row = getRow<{ id: number }>(result, 2);
    expect(row).toEqual({ id: 3 });
  });

  test("returns undefined for out-of-bounds index", () => {
    const result = { rows: [{ id: 1 }] };
    const row = getRow<{ id: number }>(result, 5);
    expect(row).toBeUndefined();
  });

  test("returns undefined for negative index", () => {
    const result = { rows: [{ id: 1 }] };
    const row = getRow<{ id: number }>(result, -1);
    expect(row).toBeUndefined();
  });

  test("returns undefined for empty rows array", () => {
    const result = { rows: [] };
    const row = getRow<{ id: number }>(result);
    expect(row).toBeUndefined();
  });

  test("handles complex row types", () => {
    interface AgentRow {
      id: string;
      name: string;
      config: Record<string, string>;
    }
    const result = {
      rows: [{ id: "agent-1", name: "Agent", config: { model: "gpt-4" } }],
    };
    const row = getRow<AgentRow>(result);
    expect(row).toBeDefined();
    expect(row?.id).toBe("agent-1");
    expect(row?.config.model).toBe("gpt-4");
  });

  test("defaults to index 0 when not specified", () => {
    const result = { rows: [{ val: "first" }, { val: "second" }] };
    const row = getRow<{ val: string }>(result);
    expect(row?.val).toBe("first");
  });
});

describe("DrizzleDatabase type", () => {
  test("type module is importable", async () => {
    const mod = await import("../../types");
    expect(mod.getRow).toBeDefined();
    expect(mod.getDb).toBeDefined();
    expect(typeof mod.getRow).toBe("function");
    expect(typeof mod.getDb).toBe("function");
  });
});
