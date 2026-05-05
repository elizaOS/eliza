import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { extractLifeOperationWithLlm } from "./life.extractor.js";

const ROOM_ID = "00000000-0000-4000-8000-000000000001" as UUID;
const ENTITY_ID = "11111111-1111-4000-8000-000000000001" as UUID;
const AGENT_ID = "22222222-2222-4000-8000-000000000001" as UUID;

function buildMessage(text: string): Memory {
  return {
    id: "33333333-3333-4000-8000-000000000001" as UUID,
    roomId: ROOM_ID,
    entityId: ENTITY_ID,
    agentId: AGENT_ID,
    content: { text, source: "test" },
  } as Memory;
}

describe("extractLifeOperationWithLlm", () => {
  it("returns the reply-only plan when runtime.useModel is unavailable", async () => {
    const result = await extractLifeOperationWithLlm({
      runtime: {} as IAgentRuntime,
      message: buildMessage("set an alarm for 7am"),
      state: undefined,
      intent: "set an alarm for 7am",
    });

    expect(result.operation).toBeNull();
    expect(result.shouldAct).toBe(false);
  });

  it("returns the parsed operation plan from a valid first-pass response", async () => {
    const useModel = vi.fn(async () =>
      JSON.stringify({
        operation: "create_definition",
        confidence: 0.9,
        shouldAct: true,
        missing: [],
      }),
    );

    const result = await extractLifeOperationWithLlm({
      runtime: { useModel } as unknown as IAgentRuntime,
      message: buildMessage("set an alarm for 7am"),
      state: undefined,
      intent: "set an alarm for 7am",
    });

    expect(result.operation).toBe("create_definition");
    expect(result.shouldAct).toBe(true);
    expect(useModel).toHaveBeenCalledTimes(1);
  });

  it("invokes the recovery pass when the first parse returns operation=null", async () => {
    const responses = [
      JSON.stringify({
        operation: null,
        confidence: 0.5,
        shouldAct: false,
        missing: [],
      }),
      JSON.stringify({
        operation: "complete_occurrence",
        confidence: 0.9,
        shouldAct: true,
        missing: [],
      }),
    ];
    const useModel = vi.fn(async () => responses.shift() ?? "");

    const result = await extractLifeOperationWithLlm({
      runtime: { useModel } as unknown as IAgentRuntime,
      message: buildMessage("just did it"),
      state: undefined,
      intent: "just did it",
    });

    expect(result.operation).toBe("complete_occurrence");
    expect(useModel).toHaveBeenCalledTimes(2);
  });

  it("issues a repair pass when the first response is unparseable", async () => {
    const calls: string[] = [];
    const useModel = vi.fn(async (_type: string, opts: { prompt: string }) => {
      calls.push(opts.prompt);
      if (calls.length === 1) {
        return "garbled";
      }
      return JSON.stringify({
        operation: "query_overview",
        confidence: 0.8,
        shouldAct: true,
        missing: [],
      });
    });

    const result = await extractLifeOperationWithLlm({
      runtime: { useModel } as unknown as IAgentRuntime,
      message: buildMessage("what's left for today"),
      state: undefined,
      intent: "what's left for today",
    });

    expect(result.operation).toBe("query_overview");
    expect(useModel).toHaveBeenCalledTimes(2);
    expect(calls[1]).toContain(
      "Your last reply for the LifeOps operation planner was invalid",
    );
  });
});
