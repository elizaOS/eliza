import { describe, expect, it } from "vitest";

import benchmarksPlugin, {
  benchmarksPlugin as namedPlugin,
  osworldAction,
  tauBenchToolAction,
  vendingMachineAction,
  visualWebBenchTaskAction,
  webshopAction,
} from "../src/index";

describe("@elizaos/plugin-benchmarks", () => {
  it("exports the same plugin via default and named export", () => {
    expect(benchmarksPlugin).toBe(namedPlugin);
    expect(benchmarksPlugin.name).toBe("benchmarks");
  });

  it("registers every promoted virtual action plus the umbrellas", () => {
    // 1+9 vending + 1+5 webshop + 1+11 osworld + 1 tau-bench + 1+7 visualwebbench = 37
    expect(benchmarksPlugin.actions).toBeDefined();
    expect(benchmarksPlugin.actions?.length).toBe(37);
  });

  it("includes the expected umbrella names", () => {
    const names = (benchmarksPlugin.actions ?? []).map((action) => action.name);
    expect(names).toContain("VENDING_MACHINE");
    expect(names).toContain("WEBSHOP");
    expect(names).toContain("OSWORLD");
    expect(names).toContain("TAU_BENCH_TOOL");
    expect(names).toContain("VISUALWEBBENCH_TASK");
  });

  it("includes representative promoted virtuals", () => {
    const names = new Set((benchmarksPlugin.actions ?? []).map((action) => action.name));
    expect(names.has("VENDING_MACHINE_VIEW_STATE")).toBe(true);
    expect(names.has("VENDING_MACHINE_PLACE_ORDER")).toBe(true);
    expect(names.has("VENDING_MACHINE_ADVANCE_DAY")).toBe(true);
    expect(names.has("WEBSHOP_SEARCH")).toBe(true);
    expect(names.has("WEBSHOP_BUY")).toBe(true);
    expect(names.has("OSWORLD_CLICK")).toBe(true);
    expect(names.has("OSWORLD_SCREENSHOT")).toBe(true);
    expect(names.has("OSWORLD_DONE")).toBe(true);
    expect(names.has("VISUALWEBBENCH_TASK_ACTION_PREDICTION")).toBe(true);
    expect(names.has("VISUALWEBBENCH_TASK_ACTION_GROUND")).toBe(true);
  });

  it("does not promote virtuals for tau-bench (no enum on tool_name)", () => {
    const names = (benchmarksPlugin.actions ?? []).map((action) => action.name);
    const tauVirtuals = names.filter(
      (name) => name.startsWith("TAU_BENCH_TOOL_") && name !== "TAU_BENCH_TOOL"
    );
    expect(tauVirtuals).toHaveLength(0);
  });

  it("attaches subActions to umbrellas after promotion", () => {
    expect(vendingMachineAction.subActions?.length).toBe(9);
    expect(webshopAction.subActions?.length).toBe(5);
    expect(osworldAction.subActions?.length).toBe(11);
    expect(visualWebBenchTaskAction.subActions?.length).toBe(7);
    expect(tauBenchToolAction.subActions ?? []).toHaveLength(0);
  });

  it("each registered action has a non-empty description and a handler function", () => {
    for (const action of benchmarksPlugin.actions ?? []) {
      expect(typeof action.description).toBe("string");
      expect(action.description.length).toBeGreaterThan(0);
      expect(typeof action.handler).toBe("function");
      expect(typeof action.validate).toBe("function");
    }
  });
});
