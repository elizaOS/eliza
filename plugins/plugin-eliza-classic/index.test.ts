import { describe, expect, it } from "vitest";
import { ModelType } from "@elizaos/core";
import {
  elizaClassicPlugin,
  generateElizaEmbedding,
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
      handler?.({} as never, {
        prompt: "System: stay deterministic\nUser: why am I tired?\nAssistant:",
      } as never),
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

  it("generates normalized deterministic lexical embeddings", () => {
    const familyEmbedding = generateElizaEmbedding("mother father family");
    const workEmbedding = generateElizaEmbedding("deadline project work");
    const repeatEmbedding = generateElizaEmbedding("mother father family");

    expect(familyEmbedding).toHaveLength(1536);
    expect(Math.hypot(...familyEmbedding)).toBeCloseTo(1, 8);
    expect(repeatEmbedding).toEqual(familyEmbedding);
    expect(workEmbedding).not.toEqual(familyEmbedding);
  });

  it("registers deterministic handlers for text, planning, and embedding models", async () => {
    expect(elizaClassicPlugin.models?.[ModelType.TEXT_NANO]).toBeTypeOf(
      "function",
    );
    expect(elizaClassicPlugin.models?.[ModelType.ACTION_PLANNER]).toBeTypeOf(
      "function",
    );

    const embeddingHandler = elizaClassicPlugin.models?.[
      ModelType.TEXT_EMBEDDING
    ] as ((runtime: unknown, params: unknown) => Promise<number[]>) | undefined;

    const embedding = await embeddingHandler?.({} as never, {
      text: "I feel sad today",
    } as never);
    expect(embedding).toHaveLength(1536);
    expect(Math.hypot(...(embedding ?? []))).toBeCloseTo(1, 8);
  });
});
