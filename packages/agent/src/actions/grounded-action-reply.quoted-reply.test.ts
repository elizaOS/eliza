/**
 * Proves grounded replies preserve the complete model output byte-for-byte.
 * The harness exercises the real model call boundary with deterministic output.
 */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { renderGroundedActionReply } from "./grounded-action-reply.ts";

const FALLBACK = "I've handled that.";

function runtimeReturning(modelOutput: string): IAgentRuntime {
  return {
    useModel: vi.fn(async () => modelOutput),
    getMemories: vi.fn(async () => []),
    character: { name: "TestAgent" },
  } as unknown as IAgentRuntime;
}

async function render(modelOutput: string): Promise<string> {
  return renderGroundedActionReply({
    runtime: runtimeReturning(modelOutput),
    message: { content: { text: "add milk" } } as unknown as Memory,
    state: undefined as unknown as State | undefined,
    intent: "confirm",
    domain: "lifeops",
    scenario: "test",
    fallback: FALLBACK,
  });
}

describe("renderGroundedActionReply output preservation", () => {
  it.each([
    '"Sure — I added milk to your shopping list."',
    "'Added milk.'",
    "  Added milk to your list.  ",
    '{"response": "Added milk", "confidence": 0.9}',
    '```json\n{"response": "Added milk"}\n```',
    "shouldAct: true\nresponse: Added milk",
    "<thinking>should I</thinking>",
    "   ",
  ])("returns %j unchanged", async (modelOutput) => {
    expect(await render(modelOutput)).toBe(modelOutput);
  });
});
