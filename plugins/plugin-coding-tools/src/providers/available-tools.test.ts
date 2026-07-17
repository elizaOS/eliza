import { describe, expect, it } from "vitest";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { availableToolsProvider } from "./available-tools.js";

describe("availableToolsProvider", () => {
  it("lists every native coding tool including the web tools", async () => {
    const result = await availableToolsProvider.get(
      {} as IAgentRuntime,
      {} as Memory,
    );

    expect(result.text).toContain("# Native coding tools");
    for (const tool of ["FILE", "SHELL", "WEB_FETCH", "WEB_SEARCH", "WORKTREE"]) {
      expect(result.text).toContain(`- ${tool}`);
      expect(result.data?.codingTools).toContain(tool);
    }
  });

  it("returns a defensive copy of the tool list", async () => {
    const first = await availableToolsProvider.get(
      {} as IAgentRuntime,
      {} as Memory,
    );
    const second = await availableToolsProvider.get(
      {} as IAgentRuntime,
      {} as Memory,
    );
    expect(first.data?.codingTools).not.toBe(second.data?.codingTools);
    expect(first.data?.codingTools).toEqual(second.data?.codingTools);
  });

  it("is registered close to the front of rendered state", () => {
    expect(availableToolsProvider.position).toBe(-10);
    expect(availableToolsProvider.cacheStable).toBe(true);
  });
});
