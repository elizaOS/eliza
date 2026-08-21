/**
 * Deterministic tests for the P4 shared facts module: the rollout gate, the
 * extraction prompt contract, strict response parsing (including the typed
 * invalid-response failures), normalization-based dedupe, and the bounded
 * facts provider block. The `generate` collaborator is a scripted stub; no
 * model, store, or network is involved.
 */
import { describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core/edge";
import {
  buildSharedFactsContext,
  buildSharedFactsExtractionPrompt,
  extractSharedTurnFacts,
  normalizeSharedFact,
  parseSharedFactsResponse,
  SHARED_FACTS_CONTEXT_MAX_CHARS,
  SHARED_FACTS_CONTEXT_MAX_FACTS,
  SHARED_FACTS_INVALID_RESPONSE,
  SHARED_FACTS_MAX_FACT_CHARS,
  SHARED_FACTS_MAX_PER_TURN,
  sharedFactsEnabled,
} from "./shared-facts";

describe("sharedFactsEnabled", () => {
  test("is on only for the exact string 'true'", () => {
    expect(sharedFactsEnabled("true")).toBe(true);
    for (const raw of [undefined, "", "false", "TRUE", "1", "yes"]) {
      expect(sharedFactsEnabled(raw)).toBe(false);
    }
  });
});

describe("normalizeSharedFact", () => {
  test("collapses whitespace, case, and the terminal period into one identity", () => {
    expect(normalizeSharedFact("  The user   LIVES in Lisbon.  ")).toBe("the user lives in lisbon");
    expect(normalizeSharedFact("The user lives in Lisbon")).toBe("the user lives in lisbon");
  });

  test("keeps genuinely different facts distinct", () => {
    expect(normalizeSharedFact("The user lives in Lisbon")).not.toBe(
      normalizeSharedFact("The user lived in Lisbon"),
    );
  });
});

describe("buildSharedFactsExtractionPrompt", () => {
  test("carries the exchange, known facts, and the strict output contract", () => {
    const prompt = buildSharedFactsExtractionPrompt({
      agentName: "Eliza",
      userMessage: "I'm allergic to peanuts",
      assistantReply: "Noted — I'll remember that.",
      knownFacts: ["The user lives in Lisbon"],
    });
    expect(prompt).toContain('"Eliza"');
    expect(prompt).toContain("User: I'm allergic to peanuts");
    expect(prompt).toContain("Assistant: Noted — I'll remember that.");
    expect(prompt).toContain("- The user lives in Lisbon");
    expect(prompt).toContain(`at most ${SHARED_FACTS_MAX_PER_TURN}`);
  });

  test("renders an explicit empty known-facts marker instead of a blank section", () => {
    const prompt = buildSharedFactsExtractionPrompt({
      agentName: "Eliza",
      userMessage: "hi",
      assistantReply: "hello",
      knownFacts: [],
    });
    expect(prompt).toContain("(none)");
  });
});

describe("parseSharedFactsResponse", () => {
  test("parses a bare JSON array and a fenced one identically", () => {
    expect(parseSharedFactsResponse('["The user has a dog"]')).toEqual(["The user has a dog"]);
    expect(parseSharedFactsResponse('```json\n["The user has a dog"]\n```')).toEqual([
      "The user has a dog",
    ]);
  });

  test("accepts prose around the array but nothing without one", () => {
    expect(parseSharedFactsResponse('Here you go: ["A"] thanks')).toEqual(["A"]);
    expect(parseSharedFactsResponse("[]")).toEqual([]);
  });

  test("drops blank entries, clips long facts, and caps the count", () => {
    const long = "x".repeat(SHARED_FACTS_MAX_FACT_CHARS + 50);
    const parsed = parseSharedFactsResponse(
      JSON.stringify(["  ", long, "a", "b", "c", "d", "e", "f"]),
    );
    expect(parsed.length).toBe(SHARED_FACTS_MAX_PER_TURN);
    expect(parsed[0]?.length).toBe(SHARED_FACTS_MAX_FACT_CHARS);
    expect(parsed[0]?.endsWith("…")).toBe(true);
  });

  test.each([
    ["no array at all", "I could not find any facts."],
    ["malformed JSON", "[unquoted]"],
    ["non-string entries", '["ok", 42]'],
    ["a JSON object with no array", '{"facts": 1}'],
  ])("throws the typed invalid-response error on %s", (_label, body) => {
    expect(() => parseSharedFactsResponse(body)).toThrow(ElizaError);
    try {
      parseSharedFactsResponse(body);
    } catch (error) {
      expect((error as ElizaError).code).toBe(SHARED_FACTS_INVALID_RESPONSE);
    }
  });
});

describe("extractSharedTurnFacts", () => {
  const base = {
    agentName: "Eliza",
    userMessage: "My birthday is June 3rd",
    assistantReply: "Happy early birthday!",
  };

  test("returns only facts not already known, after normalization", async () => {
    const facts = await extractSharedTurnFacts({
      ...base,
      knownFacts: ["the user's birthday is june 3rd."],
      generate: async () =>
        JSON.stringify([
          "The user's   birthday is June 3rd",
          "The user likes surprises",
          "The user likes surprises.",
        ]),
    });
    expect(facts).toEqual(["The user likes surprises"]);
  });

  test("skips the model call entirely for a blank user message", async () => {
    let calls = 0;
    const facts = await extractSharedTurnFacts({
      ...base,
      userMessage: "   ",
      knownFacts: [],
      generate: async () => {
        calls += 1;
        return "[]";
      },
    });
    expect(facts).toEqual([]);
    expect(calls).toBe(0);
  });

  test("propagates generate and parse failures typed instead of returning empty", async () => {
    await expect(
      extractSharedTurnFacts({
        ...base,
        knownFacts: [],
        generate: async () => {
          throw new Error("provider down");
        },
      }),
    ).rejects.toThrow("provider down");
    await expect(
      extractSharedTurnFacts({
        ...base,
        knownFacts: [],
        generate: async () => "no facts here",
      }),
    ).rejects.toThrow(ElizaError);
  });
});

describe("buildSharedFactsContext", () => {
  test("renders a bounded bullet block and null for nothing renderable", () => {
    expect(buildSharedFactsContext([])).toBeNull();
    expect(buildSharedFactsContext(["  ", ""])).toBeNull();
    const block = buildSharedFactsContext(["The user has a dog", "The user lives in Lisbon"]);
    expect(block).toContain("Durable facts");
    expect(block).toContain("- The user has a dog");
    expect(block).toContain("- The user lives in Lisbon");
  });

  test("caps rendered rows and total characters", () => {
    const many = Array.from({ length: SHARED_FACTS_CONTEXT_MAX_FACTS + 5 }, (_, i) => `Fact ${i}`);
    const block = buildSharedFactsContext(many);
    expect(block?.match(/^- /gm)?.length).toBe(SHARED_FACTS_CONTEXT_MAX_FACTS);
    const huge = Array.from({ length: 10 }, () => "y".repeat(400));
    const bounded = buildSharedFactsContext(huge);
    expect((bounded ?? "").length).toBeLessThanOrEqual(SHARED_FACTS_CONTEXT_MAX_CHARS);
    expect(bounded).not.toBeNull();
  });
});
