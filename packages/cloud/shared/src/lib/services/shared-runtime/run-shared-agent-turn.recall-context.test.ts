/**
 * Pins the P3 recall-context contract on the shared turn: a caller-provided
 * `recallContext` is appended to the system prompt the model receives, and an
 * absent one leaves the prompt untouched. The `ai` SDK and language-model
 * router are stubbed; the capture is the real `system` argument.
 */

import { describe, expect, mock, test } from "bun:test";

let capturedSystem: string | undefined;

mock.module("../../providers/language-model", () => ({
  getInteractiveCerebrasLanguageModel: () => ({ modelId: "stub" }),
  hasLanguageModelProviderConfigured: () => true,
}));

mock.module("ai", () => ({
  generateText: async (options: { system?: string }) => {
    capturedSystem = options.system;
    return { text: "reply", usage: { totalTokens: 2 } };
  },
  streamText: () => {
    throw new Error("stream path not under test");
  },
}));

const { runSharedAgentTurn } = await import("./run-shared-agent-turn");

const character = { name: "Recall Probe", system: "Base persona." };

describe("shared turn recall context", () => {
  test("appends the recall block to the system prompt", async () => {
    capturedSystem = undefined;
    const block = "Recalled from earlier in this conversation:\n- [user] pick blue";
    await runSharedAgentTurn({
      character,
      history: [],
      message: "which color did I pick?",
      recallContext: block,
    });
    expect(capturedSystem).toBeDefined();
    expect(capturedSystem?.endsWith(block)).toBe(true);
    expect(capturedSystem?.startsWith("Base persona.")).toBe(true);
  });

  test("leaves the system prompt untouched without recall", async () => {
    capturedSystem = undefined;
    await runSharedAgentTurn({
      character,
      history: [],
      message: "hello",
    });
    expect(capturedSystem).toBeDefined();
    expect(capturedSystem).not.toContain("Recalled from earlier");
  });
});
