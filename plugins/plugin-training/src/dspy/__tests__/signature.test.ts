/**
 * Signature round-trip test: render a Signature with 2 inputs + 1 output,
 * synthesize the LM-shaped response a Signature.render() implies, parse it
 * back, and assert structural equality.
 */

import { describe, expect, it } from "vitest";
import { defineSignature } from "../signature.js";

describe("Signature round-trip", () => {
  it("renders and parses a 2-input / 1-output signature", () => {
    const sig = defineSignature<
      { topic: string; tone: string },
      { summary: string }
    >({
      name: "summarize",
      instructions: "Summarize the topic in the given tone.",
      inputs: [
        { name: "topic", description: "Topic to summarize.", type: "string" },
        { name: "tone", description: "Tone of voice.", type: "string" },
      ],
      outputs: [
        {
          name: "summary",
          description: "One-sentence summary.",
          type: "string",
        },
      ],
    });

    const rendered = sig.render({ topic: "polar bears", tone: "playful" });
    expect(rendered.system).toContain("Summarize the topic");
    expect(rendered.system).toContain("- topic (string)");
    expect(rendered.system).toContain("- summary (string)");
    expect(rendered.user).toBe("topic: polar bears\ntone: playful");

    const lmResponse =
      "summary: Polar bears are charming, fluffy ice-loungers.";
    const parsed = sig.parse(lmResponse);
    expect(parsed.summary).toBe(
      "Polar bears are charming, fluffy ice-loungers.",
    );
  });

  it("parses multi-line output values", () => {
    const sig = defineSignature<
      { q: string },
      { reasoning: string; answer: string }
    >({
      name: "qa",
      instructions: "Answer.",
      inputs: [{ name: "q", description: "question", type: "string" }],
      outputs: [
        { name: "reasoning", description: "thought", type: "string" },
        { name: "answer", description: "final", type: "string" },
      ],
    });
    const parsed = sig.parse(
      "reasoning: line one\nline two\nanswer: forty two",
    );
    expect(parsed.reasoning).toBe("line one\nline two");
    expect(parsed.answer).toBe("forty two");
  });

  it("coerces typed fields", () => {
    const sig = defineSignature<{ x: string }, { n: number; b: boolean }>({
      name: "typed",
      instructions: "Pull numbers.",
      inputs: [{ name: "x", description: "input", type: "string" }],
      outputs: [
        { name: "n", description: "number out", type: "number" },
        { name: "b", description: "bool out", type: "boolean" },
      ],
    });
    const parsed = sig.parse("n: 42\nb: true");
    expect(parsed.n).toBe(42);
    expect(parsed.b).toBe(true);
  });
});
