/**
 * Exercises Unicode-safe truncation through the grounded reply prompt path.
 * The harness captures the real TEXT_SMALL prompt so the regression proof
 * covers context serialization and recent-action rendering, not a replica of
 * the private truncation helper.
 */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { renderGroundedActionReply } from "./grounded-action-reply.ts";

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

async function capturePrompt(options: {
  context?: Record<string, unknown>;
  state?: State;
}): Promise<string> {
  let prompt = "";
  const runtime = {
    useModel: vi.fn(async (_model, params: { prompt: string }) => {
      prompt = params.prompt;
      return "Done.";
    }),
    getMemories: vi.fn(async () => []),
    character: { name: "TestAgent" },
  } as unknown as IAgentRuntime;

  await renderGroundedActionReply({
    runtime,
    message: { content: { text: "handle it" } } as unknown as Memory,
    state: options.state,
    intent: "confirm",
    domain: "lifeops",
    scenario: "unicode truncation",
    fallback: "Handled.",
    context: options.context,
  });

  return prompt;
}

describe("grounded reply prompt Unicode truncation", () => {
  it("does not split an emoji at the structured-context limit", async () => {
    const empty = JSON.stringify({ payload: "" });
    const contentStart = empty.indexOf('""') + 1;
    const highSurrogateIndex = 2_398;
    const payload = `${"a".repeat(highSurrogateIndex - contentStart)}🦊tail`;

    const prompt = await capturePrompt({ context: { payload } });
    const contextLine = prompt
      .split("\n")
      .find((line) => line.startsWith("Structured context: "));

    expect(contextLine).toBeDefined();
    expect(isWellFormed(contextLine ?? "")).toBe(true);
    expect(contextLine).not.toContain("🦊");
    expect(contextLine?.endsWith("…")).toBe(true);
  });

  it("sanitizes a lone surrogate in recent action text", async () => {
    const state = {
      data: {
        actionResults: [
          {
            success: true,
            text: `result \ud800 ${"x".repeat(200)}`,
            data: { actionName: "TEST_ACTION" },
          },
        ],
      },
    } as unknown as State;

    const prompt = await capturePrompt({ state });
    const historyLine = prompt
      .split("\n")
      .find((line) => line.startsWith("Recent action history: "));

    expect(historyLine).toBeDefined();
    expect(isWellFormed(historyLine ?? "")).toBe(true);
    expect(historyLine).toContain("�");
    expect(historyLine).not.toContain("\\ud800");
  });

  it("preserves a complete emoji that fits before the context limit", async () => {
    const prompt = await capturePrompt({ context: { payload: "hello🦊" } });
    const contextLine = prompt
      .split("\n")
      .find((line) => line.startsWith("Structured context: "));

    expect(contextLine).toContain("🦊");
    expect(isWellFormed(contextLine ?? "")).toBe(true);
  });
});
