import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleTextSmall } from "../models/text";

function createRuntime() {
  return {
    character: { system: "system prompt" },
    emitEvent: vi.fn(),
    getSetting: vi.fn(() => undefined),
  } as unknown as IAgentRuntime;
}

describe("Ollama native text plumbing", () => {
  it("fails clearly when native tools are requested", async () => {
    await expect(
      handleTextSmall(createRuntime(), {
        prompt: "use a tool",
        tools: { lookup: { description: "Lookup", inputSchema: { type: "object" } } },
      } as never)
    ).rejects.toThrow("[Ollama] Native tools plumbing is not supported");
  });
});
