import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, test } from "vitest";
import { generateElizaResponse } from "../models/text";

function makeRuntime(): IAgentRuntime {
  // Object identity only; no methods called.
  return {} as IAgentRuntime;
}

describe("ELIZA golden transcript (deterministic)", () => {
  test("reproduces a deterministic mini-conversation", () => {
    const runtime = makeRuntime();

    const transcript: Array<{ input: string; expected: string }> = [
      { input: "hello", expected: "How do you do? Please state your problem" },
      { input: "computer", expected: "Do computers worry you?" },
      { input: "computer", expected: "Why do you mention computers?" },
      { input: "computer", expected: "What do you think machines have to do with your problem?" },
      { input: "my mother is kind", expected: "Tell me more about your family" },
      { input: "xyzzy", expected: "I am not sure I understand you fully" },
    ];

    for (const { input, expected } of transcript) {
      const response = generateElizaResponse(runtime, input);
      expect(response).toBe(expected);
    }
  });
});
