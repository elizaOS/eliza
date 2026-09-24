import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { benchmarksPlugin } from "../src/index";

const runtime = {} as IAgentRuntime;
const message = {} as Memory;

describe("benchmark action capture boundary", () => {
  it("rejects contradictory operations instead of recording a rewritten success", async () => {
    const action = benchmarksPlugin.actions?.find(
      (candidate) => candidate.name === "WEBSHOP_SEARCH",
    );
    expect(action).toBeDefined();
    const result = await action!.handler(runtime, message, undefined, {
      parameters: { action: "buy", query: "boots" },
    });
    expect(result).toMatchObject({ success: false });
  });

  it("preserves complete query text through a promoted action", async () => {
    const action = benchmarksPlugin.actions?.find(
      (candidate) => candidate.name === "WEBSHOP_SEARCH",
    );
    const query = `${"cotton ".repeat(1000)}under $50 — size M`;
    const result = await action!.handler(runtime, message, undefined, {
      parameters: { query },
    });
    expect(result).toMatchObject({
      success: true,
      data: { action: "search", query },
    });
  });

  it("exports unique names so registration cannot overwrite a different tool", () => {
    const names = benchmarksPlugin.actions?.map((action) => action.name) ?? [];
    expect(names.length).toBeGreaterThan(5);
    expect(new Set(names).size).toBe(names.length);
  });
});
