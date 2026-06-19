/**
 * Unit tests for the LLM goal verifier — covers the pure parts (prompt
 * builder, response parser) and the orchestrator paths that bypass the
 * model entirely (empty criteria, empty evidence, model failure).
 *
 * The model call itself is mocked via a minimal runtime stub so the suite
 * never reaches a real provider.
 */

import { describe, expect, it } from "vitest";
import {
  buildVerificationPrompt,
  LLM_GOAL_VERIFIER_NAME,
  parseJudgeResponse,
  verifyGoalCompletion,
} from "../../src/services/goal-llm-verifier.js";

interface MockRuntimeOptions {
  response?: string;
  shouldThrow?: Error;
  recordCall?: (args: { modelType: unknown; params: unknown }) => void;
}

function makeMockRuntime(opts: MockRuntimeOptions = {}) {
  return {
    useModel: async (modelType: unknown, params: unknown) => {
      opts.recordCall?.({ modelType, params });
      if (opts.shouldThrow) throw opts.shouldThrow;
      return opts.response ?? "";
    },
  } as unknown as Parameters<typeof verifyGoalCompletion>[0];
}

describe("LLM_GOAL_VERIFIER_NAME", () => {
  it("is the stable string callers stamp onto validateTask payloads", () => {
    expect(LLM_GOAL_VERIFIER_NAME).toBe("llm-goal-verifier");
  });
});

describe("buildVerificationPrompt", () => {
  it("enumerates acceptance criteria as a numbered list", () => {
    const prompt = buildVerificationPrompt({
      goal: "Ship X",
      acceptanceCriteria: ["foo passes", "bar passes"],
      completionEvidence: "all done",
    });
    expect(prompt).toContain("1. foo passes");
    expect(prompt).toContain("2. bar passes");
  });

  it("instructs the model to fail when evidence is silent on a criterion", () => {
    const prompt = buildVerificationPrompt({
      goal: "Ship X",
      acceptanceCriteria: ["foo"],
      completionEvidence: "nothing to see",
    });
    expect(prompt).toMatch(/silent on a criterion/);
  });

  it("includes the goal text", () => {
    const prompt = buildVerificationPrompt({
      goal: "Implement caching for /search endpoint",
      acceptanceCriteria: ["c1"],
      completionEvidence: "e",
    });
    expect(prompt).toContain("Implement caching for /search endpoint");
  });

  it("places a no-fence JSON instruction near the schema", () => {
    const prompt = buildVerificationPrompt({
      goal: "X",
      acceptanceCriteria: ["c"],
      completionEvidence: "e",
    });
    expect(prompt).toMatch(/Do not wrap it in ```/);
    expect(prompt).toMatch(/"passed": <true\|false>/);
  });

  it("truncates very long completion evidence to keep the prompt bounded", () => {
    const longEvidence = "X".repeat(20_000);
    const prompt = buildVerificationPrompt({
      goal: "X",
      acceptanceCriteria: ["c"],
      completionEvidence: longEvidence,
    });
    expect(prompt).toMatch(/\[…evidence truncated…\]/);
    expect(prompt.length).toBeLessThan(20_000);
  });
});

describe("parseJudgeResponse", () => {
  it("accepts a clean JSON object and reports passed=true with empty missing", () => {
    const parsed = parseJudgeResponse(
      '{"passed": true, "summary": "all green", "missing": []}',
      ["c1"],
    );
    expect(parsed.passed).toBe(true);
    expect(parsed.summary).toBe("all green");
    expect(parsed.missing).toEqual([]);
  });

  it("treats passed=true + non-empty missing as a failed verdict (schema invariant)", () => {
    const parsed = parseJudgeResponse(
      '{"passed": true, "summary": "x", "missing": ["c1"]}',
      ["c1"],
    );
    expect(parsed.passed).toBe(false);
    expect(parsed.missing).toEqual(["c1"]);
  });

  it("extracts the JSON object from prose preamble", () => {
    const parsed = parseJudgeResponse(
      'Here is my analysis. {"passed": false, "summary": "c2 not met", "missing": ["c2"]} Thanks.',
      ["c1", "c2"],
    );
    expect(parsed.passed).toBe(false);
    expect(parsed.summary).toBe("c2 not met");
    expect(parsed.missing).toEqual(["c2"]);
  });

  it("handles nested braces in JSON values", () => {
    const parsed = parseJudgeResponse(
      '{"passed": false, "summary": "outer", "missing": ["{still text}"]}',
      ["c"],
    );
    expect(parsed.missing).toEqual(["{still text}"]);
  });

  it("falls back to fail with full criteria list when no JSON object is present", () => {
    const parsed = parseJudgeResponse("totally not json", ["c1", "c2"]);
    expect(parsed.passed).toBe(false);
    expect(parsed.summary).toMatch(/could not be parsed/);
    expect(parsed.missing).toEqual(["c1", "c2"]);
  });

  it("falls back to fail when the JSON has invalid syntax", () => {
    const parsed = parseJudgeResponse('{"passed": true, this is broken}', [
      "c1",
    ]);
    expect(parsed.passed).toBe(false);
    expect(parsed.missing).toEqual(["c1"]);
  });

  it("falls back to fail when parsed JSON is not an object", () => {
    const parsed = parseJudgeResponse("[1,2,3]", ["c1"]);
    expect(parsed.passed).toBe(false);
    expect(parsed.missing).toEqual(["c1"]);
  });

  it("trims whitespace from missing entries and drops empties", () => {
    const parsed = parseJudgeResponse(
      '{"passed": false, "summary": "s", "missing": ["  c1  ", "", "c2"]}',
      ["c1", "c2"],
    );
    expect(parsed.missing).toEqual(["c1", "c2"]);
  });

  it("clamps the summary to 280 chars", () => {
    const long = "a".repeat(500);
    const parsed = parseJudgeResponse(
      `{"passed": true, "summary": "${long}", "missing": []}`,
      ["c"],
    );
    expect(parsed.summary.length).toBe(280);
  });
});

describe("verifyGoalCompletion (orchestration paths)", () => {
  it("short-circuits to pass when acceptanceCriteria is empty", async () => {
    const runtime = makeMockRuntime({
      recordCall: () => {
        throw new Error("model should not be called");
      },
    });
    const result = await verifyGoalCompletion(runtime, {
      goal: "anything",
      acceptanceCriteria: [],
      completionEvidence: "done",
    });
    expect(result.passed).toBe(true);
    expect(result.summary).toMatch(/no acceptance criteria/i);
    expect(result.missing).toEqual([]);
    expect(result.rawResponse).toBe("");
  });

  it("short-circuits to fail when completionEvidence is empty", async () => {
    const runtime = makeMockRuntime({
      recordCall: () => {
        throw new Error("model should not be called");
      },
    });
    const result = await verifyGoalCompletion(runtime, {
      goal: "x",
      acceptanceCriteria: ["c1"],
      completionEvidence: "",
    });
    expect(result.passed).toBe(false);
    expect(result.summary).toMatch(/no completion evidence/i);
    expect(result.missing).toEqual(["c1"]);
  });

  it("short-circuits to fail when completionEvidence is only whitespace", async () => {
    const runtime = makeMockRuntime();
    const result = await verifyGoalCompletion(runtime, {
      goal: "x",
      acceptanceCriteria: ["c1"],
      completionEvidence: "   \n  \t  ",
    });
    expect(result.passed).toBe(false);
    expect(result.missing).toEqual(["c1"]);
  });

  it("calls the model with TEXT_SMALL and forwards the prompt", async () => {
    const calls: Array<{ modelType: unknown; params: unknown }> = [];
    const runtime = makeMockRuntime({
      recordCall: (args) => calls.push(args),
      response: '{"passed": true, "summary": "ok", "missing": []}',
    });
    await verifyGoalCompletion(runtime, {
      goal: "x",
      acceptanceCriteria: ["c1"],
      completionEvidence: "evidence",
    });
    expect(calls).toHaveLength(1);
    const [{ modelType, params }] = calls;
    expect(modelType).toBe("TEXT_SMALL");
    expect(params).toMatchObject({ stopSequences: [] });
    expect((params as { prompt: string }).prompt).toMatch(
      /Acceptance criteria/,
    );
  });

  it("returns a structured fail when the model throws", async () => {
    const runtime = makeMockRuntime({
      shouldThrow: new Error("provider down"),
    });
    const result = await verifyGoalCompletion(runtime, {
      goal: "x",
      acceptanceCriteria: ["c1"],
      completionEvidence: "evidence",
    });
    expect(result.passed).toBe(false);
    expect(result.summary).toMatch(/provider down/);
    expect(result.missing).toEqual(["c1"]);
    expect(result.rawResponse).toBe("");
  });

  it("returns a passed verdict on a clean model response", async () => {
    const runtime = makeMockRuntime({
      response: '{"passed": true, "summary": "all good", "missing": []}',
    });
    const result = await verifyGoalCompletion(runtime, {
      goal: "x",
      acceptanceCriteria: ["c1", "c2"],
      completionEvidence: "ran tests, all passed",
    });
    expect(result.passed).toBe(true);
    expect(result.summary).toBe("all good");
    expect(result.missing).toEqual([]);
    expect(result.rawResponse).toContain('"passed": true');
  });

  it("returns a failed verdict when the model identifies missing criteria", async () => {
    const runtime = makeMockRuntime({
      response:
        '{"passed": false, "summary": "tests not run", "missing": ["test suite green"]}',
    });
    const result = await verifyGoalCompletion(runtime, {
      goal: "x",
      acceptanceCriteria: ["test suite green"],
      completionEvidence: "edited files but did not run tests",
    });
    expect(result.passed).toBe(false);
    expect(result.summary).toBe("tests not run");
    expect(result.missing).toEqual(["test suite green"]);
  });
});
