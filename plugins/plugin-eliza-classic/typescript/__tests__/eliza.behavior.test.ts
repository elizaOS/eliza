import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, test } from "vitest";
import { generateElizaResponse } from "../models/text";

function makeRuntime(): IAgentRuntime {
  // Object identity only; no methods called.
  return {} as IAgentRuntime;
}

describe("ELIZA behavior (script-driven)", () => {
  test("uses clause delimiter 'but' to prefer first clause with a keyword", () => {
    const runtime = makeRuntime();
    const response = generateElizaResponse(runtime, "My mother is kind but computers worry me");
    // "my" has precedence 2 and appears in the first clause.
    expect(response).toBe("Tell me more about your family");
  });

  test("uses '.' and ',' as clause delimiters during scanning", () => {
    const runtime = makeRuntime();
    const response = generateElizaResponse(runtime, "Computers worry me, my mother is kind");
    // First clause contains "computers" keyword (precedence 50) so it wins before later clause.
    expect(response).toBe("Do computers worry you?");
  });

  test("alt list matching works ([everyone everybody nobody noone])", () => {
    const runtime = makeRuntime();
    const response = generateElizaResponse(runtime, "Everyone hates me");
    expect(response).toBe("Really, everyone?");
  });

  test("group matching works (@belief) for I-keyword patterns after substitution", () => {
    const runtime = makeRuntime();
    const response = generateElizaResponse(runtime, "I am happy");
    expect(response).toBe("How have I helped you to be happy?");
  });

  test("PRE rules work (YOU'RE -> I'M -> pre + redirect)", () => {
    const runtime = makeRuntime();
    const response = generateElizaResponse(runtime, "you're sad");
    // YOU'RE rule builds "I ARE sad" then redirects to YOU rules.
    expect(response).toBe("What makes you think I am sad?");
  });

  test("NEWKEY causes fallback to default when no other keyword applies", () => {
    const runtime = makeRuntime();
    const response = generateElizaResponse(runtime, "remember");
    // No other keyword available after :newkey, so we fall back to the NONE/default list.
    expect(response).toBe("I am not sure I understand you fully");
  });

  test("redirect (=what) works once the reassembly cycle reaches it", () => {
    const runtime = makeRuntime();
    // Due to substitutions, "can i ..." typically matches the "* can you *" rule.
    // That rule's 4th response is "=what".
    generateElizaResponse(runtime, "can i help you"); // 1
    generateElizaResponse(runtime, "can i help you"); // 2
    generateElizaResponse(runtime, "can i help you"); // 3
    const redirected = generateElizaResponse(runtime, "can i help you"); // 4 -> =what
    expect(redirected).toBe("Why do you ask?");
  });

  test("reassembly rules cycle deterministically", () => {
    const runtime = makeRuntime();
    const r1 = generateElizaResponse(runtime, "computer");
    const r2 = generateElizaResponse(runtime, "computer");
    expect(r1).toBe("Do computers worry you?");
    expect(r2).toBe("Why do you mention computers?");
  });

  test("MEMORY is recalled when the 4-step counter hits 4 and no keyword matches", () => {
    const runtime = makeRuntime();

    // Record a memory via MY keyword (doctor.json stores memory rules under "my").
    generateElizaResponse(runtime, "my car is broken");

    // Advance LIMIT; memory is recalled on the call when LIMIT == 4.
    generateElizaResponse(runtime, "xyzzy"); // limit=3
    const recalled = generateElizaResponse(runtime, "xyzzy"); // limit=4 => memory

    const possible = new Set<string>([
      "Lets discuss further why your car is broken",
      "Earlier you said your car is broken",
      "But your car is broken",
      "Does that have anything to do with the fact that your car is broken?",
    ]);
    expect(possible.has(recalled)).toBe(true);
  });

  test("goodbye detection returns a goodbye response", () => {
    const runtime = makeRuntime();
    const response = generateElizaResponse(runtime, "goodbye");
    expect(response.toLowerCase()).toContain("goodbye");
  });
});
