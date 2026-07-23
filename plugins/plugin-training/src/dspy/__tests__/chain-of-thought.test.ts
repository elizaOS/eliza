/**
 * Chain-of-thought output separation through the deterministic DSPy adapter.
 */

import { describe, expect, it } from "vitest";
import { ChainOfThought } from "../chain-of-thought.js";
import { MockAdapter } from "../lm-adapter.js";
import { defineSignature } from "../signature.js";

describe("ChainOfThought", () => {
  it("returns reasoning separately from the declared output", async () => {
    const signature = defineSignature<{ question: string }, { answer: string }>(
      {
        name: "answer",
        instructions: "Answer the question.",
        inputs: [{ name: "question", description: "Question", type: "string" }],
        outputs: [{ name: "answer", description: "Answer", type: "string" }],
      },
    );
    const lm = new MockAdapter({
      defaultResponse: "reasoning: The facts imply it.\nanswer: forty-two",
      usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
    });
    const chain = new ChainOfThought({ signature, lm });

    const result = await chain.forward({ question: "What is the answer?" });

    expect(chain.signature.outputs.map((field) => field.name)).toEqual([
      "reasoning",
      "answer",
    ]);
    expect(result.output).toEqual({ answer: "forty-two" });
    expect(result.reasoning).toBe("The facts imply it.");
    expect(result.usage.totalTokens).toBe(12);
    expect(result.trace.rawResponse).toContain("answer: forty-two");
  });
});
