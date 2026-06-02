import { ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  elizaClassicPlugin,
  generateElizaResponse,
  getElizaGreeting,
} from "./index.js";

describe("eliza-classic deterministic responses", () => {
  it("returns the fixed greeting used by offline ELIZA sessions", () => {
    expect(getElizaGreeting()).toBe("Hello. How are you feeling today?");
  });

  it("matches specific patterns before the catch-all fallback", () => {
    expect(generateElizaResponse("I feel sad today")).toBe(
      "Do you often feel this way?",
    );
    expect(generateElizaResponse("my father called")).toBe(
      "How does that make you feel about your father?",
    );
    expect(generateElizaResponse("unmatched input")).toBe("Please go on.");
  });

  it("extracts user turns from prompts and emits response-handler JSON", async () => {
    const handler = elizaClassicPlugin.models?.[ModelType.TEXT_SMALL];

    await expect(
      handler?.(
        {} as never,
        {
          prompt:
            "System: stay deterministic\nUser: why am I tired?\nAssistant:",
        } as never,
      ),
    ).resolves.toEqual(
      JSON.stringify({
        thought: "Responding with deterministic ELIZA pattern matching.",
        actions: ["REPLY"],
        providers: [],
        text: "That's a good question. What do you think?",
        useKnowledgeProviders: false,
      }),
    );
  });

  it("registers deterministic handlers for text and planning models only", () => {
    expect(elizaClassicPlugin.models?.[ModelType.TEXT_NANO]).toBeTypeOf(
      "function",
    );
    expect(elizaClassicPlugin.models?.[ModelType.ACTION_PLANNER]).toBeTypeOf(
      "function",
    );
    expect(
      elizaClassicPlugin.models?.[ModelType.TEXT_EMBEDDING],
    ).toBeUndefined();
  });
});
