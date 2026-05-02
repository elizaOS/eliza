import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createPluginAction } from "../../actions/plugin";

function makeMessage(text: string): Memory {
  return {
    entityId: "owner-1",
    roomId: "room-1",
    content: { text },
  } as unknown as Memory;
}

function makeRuntime(service: unknown): IAgentRuntime {
  return {
    agentId: "agent-1",
    getService: vi.fn((name: string) => {
      if (name === "plugin_manager") return service;
      return null;
    }),
  } as unknown as IAgentRuntime;
}

describe("PLUGIN action handler", () => {
  it("reads mode and query from nested parameters", async () => {
    const queries: string[] = [];
    const service = {
      searchRegistry: vi.fn(async (query: string) => {
        queries.push(query);
        return [];
      }),
    };
    const action = createPluginAction({
      hasOwnerAccess: async () => true,
      repoRoot: "/tmp/repo",
    });

    const result = await action.handler(
      makeRuntime(service),
      makeMessage("please do it"),
      undefined,
      { parameters: { mode: "search", query: "blockchain" } }
    );

    expect(result?.success).toBe(true);
    expect(queries).toEqual(["blockchain"]);
  });

  it("denies direct handler calls when owner access is denied", async () => {
    const service = {
      searchRegistry: vi.fn(async () => []),
    };
    const action = createPluginAction({
      hasOwnerAccess: async () => false,
      repoRoot: "/tmp/repo",
    });

    const result = await action.handler(
      makeRuntime(service),
      makeMessage("please do it"),
      undefined,
      { parameters: { mode: "search", query: "blockchain" } }
    );

    expect(result?.success).toBe(false);
    expect(result?.text).toBe("Permission denied: only the owner may manage plugins.");
    expect(service.searchRegistry).toHaveBeenCalledTimes(0);
  });
});
