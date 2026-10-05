/**
 * Exercises the exported MCP action's read_resource selection against
 * deterministic runtime and service stubs: the selection prompt must list the
 * connected servers' resources even though the MCP provider's composed state
 * carries only its compact `mcpServers` line.
 */

import type { HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { buildMcpProviderData } from "../../utils/mcp";
import { mcpAction } from "../mcp";

const RESOURCE_URI = "docs://handbook/onboarding";

function makeRuntime() {
  const providerData = buildMcpProviderData([
    {
      name: "docs",
      status: "connected",
      config: "{}",
      resources: [
        {
          uri: RESOURCE_URI,
          name: "Onboarding handbook",
          description: "Steps for a new teammate's first week",
        },
      ],
    },
  ]);
  const readResource = vi.fn(async () => ({
    contents: [{ uri: RESOURCE_URI, mimeType: "text/plain", text: "Day one: meet the team." }],
  }));
  const prompts: string[] = [];
  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000aa",
    // What the MCP provider contributes to composed state.
    composeState: vi.fn(
      async (): Promise<State> => ({
        values: { mcpServers: "mcpServers[1]:" },
        data: {},
        text: "",
      })
    ),
    getService: vi.fn(() => ({
      getProviderData: () => providerData,
      readResource,
    })),
    getModel: vi.fn(() => undefined),
    getSetting: vi.fn(() => undefined),
    addEmbeddingToMemory: vi.fn(async (memory: Memory) => memory),
    createMemory: vi.fn(async () => "memory-id"),
    useModel: vi.fn(async (_model: string, input: { prompt: string }) => {
      prompts.push(input.prompt);
      return prompts.length === 1
        ? JSON.stringify({
            serverName: "docs",
            uri: RESOURCE_URI,
            reasoning: "The handbook covers onboarding.",
          })
        : "Day one is for meeting the team.";
    }),
  } as unknown as IAgentRuntime;
  return { prompts, readResource, runtime };
}

const message = {
  entityId: "00000000-0000-0000-0000-0000000000bb",
  roomId: "00000000-0000-0000-0000-0000000000cc",
  content: { text: "what happens on my first day?", source: "test" },
} as unknown as Memory;

describe("MCP read_resource selection", () => {
  it("shows the model the connected servers' resources and reads the chosen one", async () => {
    const { prompts, readResource, runtime } = makeRuntime();
    const callback = vi.fn(async () => {}) as unknown as HandlerCallback;

    const result = await mcpAction.handler(
      runtime,
      message,
      undefined,
      { action: "read_resource" },
      callback
    );

    expect(vi.mocked(runtime.useModel).mock.calls[0]?.[0]).toBe(ModelType.TEXT_SMALL);
    expect(prompts[0]).toContain(RESOURCE_URI);
    expect(prompts[0]).toContain("Onboarding handbook");
    expect(readResource).toHaveBeenCalledWith("docs", RESOURCE_URI);
    expect(result.success).toBe(true);
  });
});
