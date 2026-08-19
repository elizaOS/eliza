/**
 * Pins recall projection before the Shared turn enters AgentRuntime. Recall is
 * appended to the character system prompt without changing the base persona.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let capturedSystem: string | undefined;

mock.module("../../providers/language-model", () => ({
  hasLanguageModelProviderConfigured: () => true,
}));

mock.module("./shared-eliza-runtime", () => ({
  runSharedElizaRuntimeTurn: async (input: Record<string, unknown>) => {
    capturedSystem = (input.character as { system: string }).system;
    return {
      reply: "reply",
      history: [],
      model: String(input.model),
      degraded: false,
    };
  },
  runSharedElizaRuntimeTurnStream: () => {
    throw new Error("stream path not under test");
  },
}));

const { runSharedAgentTurn } = await import("./run-shared-agent-turn");
const character = { name: "Recall Probe", system: "Base persona." };

beforeEach(() => {
  capturedSystem = undefined;
});

describe("shared turn recall context", () => {
  test("appends the recall block to the runtime character prompt", async () => {
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

  test("does not add recall when none was provided", async () => {
    await runSharedAgentTurn({ character, history: [], message: "hello" });
    expect(capturedSystem?.startsWith("Base persona.")).toBe(true);
    expect(capturedSystem).not.toContain("Recalled from earlier");
  });
});
