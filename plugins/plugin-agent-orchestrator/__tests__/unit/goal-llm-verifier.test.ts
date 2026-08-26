/**
 * Unit tests for the LLM goal verifier — covers the pure parts (prompt
 * builder, response parser) and the orchestrator paths that bypass the
 * model entirely (empty criteria, empty evidence, model failure).
 *
 * The model call itself is mocked via a minimal runtime stub so the suite
 * never reaches a real provider.
 */

import { describe, expect, it } from "vitest";
import { EVIDENCE_INCOMPLETE_MARKER } from "../../src/services/completion-evidence.js";
import {
  buildAutoVerifyCorrection,
  buildVerificationPrompt,
  LLM_GOAL_VERIFIER_NAME,
  MAX_AUTO_VERIFY_ATTEMPTS,
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

  it("embeds oversize evidence COMPLETE — no local truncation (provider boundary owns oversize)", () => {
    // PROMPT-INTEGRITY: the old head+tail middle-cut shipped the judge a
    // silent prefix (live tj-92080304431050 fabricated "malformed HTML" from
    // one). The builder must never cut; a genuinely oversize prompt is
    // rejected TYPED at the provider dispatch boundary instead.
    const middle = `MIDDLE-SENTINEL-${"m".repeat(50)}`;
    const longEvidence = `${"X".repeat(20_000)}\n${middle}\n${"Y".repeat(20_000)}\nEND-SENTINEL`;
    const prompt = buildVerificationPrompt({
      goal: "X",
      acceptanceCriteria: ["c"],
      completionEvidence: longEvidence,
    });
    expect(prompt).toContain(middle);
    expect(prompt).toContain("END-SENTINEL");
    expect(prompt).toContain(longEvidence);
    expect(prompt).not.toMatch(/\[…evidence truncated…\]/);
  });

  it("carries evidence-integrity rules for the typed incomplete marker", () => {
    const prompt = buildVerificationPrompt({
      goal: "X",
      acceptanceCriteria: ["c"],
      completionEvidence: "e",
    });
    expect(prompt).toContain(EVIDENCE_INCOMPLETE_MARKER);
    expect(prompt).toMatch(/NEVER describe content that ends at a cut marker/);
    expect(prompt).toMatch(/UNVERIFIABLE, not failed/);
    expect(prompt).toMatch(/list it in `unverifiable`/);
  });

  it("demands concrete proof per criterion and rejects unproven claims", () => {
    const prompt = buildVerificationPrompt({
      goal: "Ship X",
      acceptanceCriteria: ["tests pass"],
      completionEvidence: "I ran the tests and they pass",
    });
    // Frames the judge as a skeptical, evidence-first manager.
    expect(prompt).toMatch(/demanding/i);
    expect(prompt).toMatch(/concrete proof/i);
    // Explicitly fails plausible-but-unproven claims.
    expect(prompt).toMatch(/plausible-but-unproven claim FAILS/);
    expect(prompt).toMatch(/is NOT proof/);
  });

  it("enumerates the acceptable kinds of proof (test/build, diff, URL, screenshot/trajectory)", () => {
    const prompt = buildVerificationPrompt({
      goal: "X",
      acceptanceCriteria: ["c"],
      completionEvidence: "e",
    });
    expect(prompt).toMatch(/passing test \/ build \/ typecheck/i);
    expect(prompt).toMatch(/diff hunk/i);
    expect(prompt).toMatch(/NON-loopback URL/i);
    expect(prompt).toMatch(/screenshot or trajectory/i);
  });

  it("rejects loopback URLs as proof of a deploy", () => {
    const prompt = buildVerificationPrompt({
      goal: "X",
      acceptanceCriteria: ["app is live"],
      completionEvidence: "served at http://localhost:3000",
    });
    expect(prompt).toMatch(/localhost \/ 127\.0\.0\.1 \/ ::1 do NOT count/);
  });

  it("declares the {passed,summary,missing,unverifiable} JSON schema", () => {
    const prompt = buildVerificationPrompt({
      goal: "X",
      acceptanceCriteria: ["c"],
      completionEvidence: "e",
    });
    expect(prompt).toMatch(/"passed": <true\|false>/);
    expect(prompt).toMatch(/"summary":/);
    expect(prompt).toMatch(/"missing":/);
    expect(prompt).toMatch(/"unverifiable":/);
    expect(prompt).toMatch(/SINGLE JSON object/);
    expect(prompt).toMatch(
      /`passed` MUST be false whenever `missing` or `unverifiable` is non-empty/,
    );
  });
});

describe("buildAutoVerifyCorrection", () => {
  it("names build/typecheck/test proof for a generic criterion", () => {
    const text = buildAutoVerifyCorrection(["the parser handles nested input"]);
    expect(text).toContain("the parser handles nested input");
    expect(text).toMatch(/proof to produce:/);
    expect(text).toMatch(/build\/typecheck\/tests/);
    expect(text).toMatch(/diff hunk/i);
  });

  it("names a passing test/build output line for a test criterion", () => {
    const text = buildAutoVerifyCorrection(["the unit test suite is green"]);
    expect(text).toMatch(/passing output tail/);
  });

  it("demands a screenshot for a UI criterion", () => {
    const text = buildAutoVerifyCorrection([
      "the settings page renders the new toggle",
    ]);
    expect(text).toMatch(/screenshot/i);
  });

  it("demands a scenario trajectory for an agent-behavior criterion", () => {
    const text = buildAutoVerifyCorrection([
      "the agent replies with the weather when asked",
    ]);
    expect(text).toMatch(/scenario trajectory/i);
    expect(text).toMatch(/live model/i);
  });

  it("demands a reachable non-loopback URL for a deploy criterion", () => {
    const text = buildAutoVerifyCorrection([
      "the app is deployed and reachable",
    ]);
    expect(text).toMatch(/non-loopback URL/i);
    expect(text).toMatch(/localhost\/127\.0\.0\.1 URL does NOT count/);
  });

  it("instructs the worker to re-report WITH the proof inline", () => {
    const text = buildAutoVerifyCorrection(["c1", "c2"]);
    expect(text).toMatch(/report complete AGAIN/i);
    expect(text).toMatch(/INCLUDE that proof inline/i);
    expect(text).toMatch(/Claims without pasted evidence will fail/i);
    // Each unmet criterion is listed with its own proof demand.
    expect(text).toContain("- c1");
    expect(text).toContain("- c2");
  });

  it("defaults to the collegial attempt-1 phrasing when no attempt is passed", () => {
    const text = buildAutoVerifyCorrection(["tests pass"]);
    // Attempt-1 wording, identical to the explicit attempt=1 call.
    expect(text).toBe(buildAutoVerifyCorrection(["tests pass"], 1));
    // No escalation language at attempt 1.
    expect(text).not.toMatch(/FINAL ATTEMPT/);
    expect(text).not.toMatch(/ALREADY FAILED/);
  });

  describe("escalating grill across attempts", () => {
    const missing = ["the unit test suite is green", "the docs are updated"];

    it("attempt 1 is collegial — no prior-failure or final-attempt warning", () => {
      const text = buildAutoVerifyCorrection(missing, 1);
      expect(text).toMatch(/did not confirm the task is complete/);
      expect(text).toMatch(/proof to produce:/);
      expect(text).not.toMatch(/ALREADY FAILED/);
      expect(text).not.toMatch(/FINAL ATTEMPT/);
    });

    it("attempt 2 is pointed/socratic — direct questions and a prior-failure callout", () => {
      const text = buildAutoVerifyCorrection(missing, 2);
      // Calls out that a prior attempt already failed.
      expect(text).toMatch(/attempt 2/);
      expect(text).toMatch(/ALREADY FAILED/);
      // Direct, socratic questions per criterion.
      expect(text).toMatch(/Exactly which command did you run/);
      expect(text).toMatch(/what was its EXACT output\?/);
      expect(text).toMatch(/did you assume it works\?/i);
      // Still not the final-attempt phrasing.
      expect(text).not.toMatch(/FINAL ATTEMPT/);
    });

    it("attempt 3 (final) warns about escalation to a human before parking", () => {
      const text = buildAutoVerifyCorrection(missing, 3);
      expect(text).toMatch(/FINAL ATTEMPT/);
      expect(text).toMatch(/ESCALATED to a human/);
      expect(text).toMatch(/PARKED/);
      expect(text).toMatch(/failed automatic verification twice/);
    });

    it("attempts 1, 2 and 3 produce DIFFERENT, escalating bodies", () => {
      const a1 = buildAutoVerifyCorrection(missing, 1);
      const a2 = buildAutoVerifyCorrection(missing, 2);
      const a3 = buildAutoVerifyCorrection(missing, 3);
      expect(a1).not.toBe(a2);
      expect(a2).not.toBe(a3);
      expect(a1).not.toBe(a3);
    });

    it("clamps attempts above the cap to the final-attempt phrasing", () => {
      const high = buildAutoVerifyCorrection(
        missing,
        MAX_AUTO_VERIFY_ATTEMPTS + 5,
      );
      const final = buildAutoVerifyCorrection(
        missing,
        MAX_AUTO_VERIFY_ATTEMPTS,
      );
      expect(high).toBe(final);
    });

    it("clamps non-positive / non-finite attempts to attempt 1", () => {
      const a1 = buildAutoVerifyCorrection(missing, 1);
      expect(buildAutoVerifyCorrection(missing, 0)).toBe(a1);
      expect(buildAutoVerifyCorrection(missing, -3)).toBe(a1);
      expect(buildAutoVerifyCorrection(missing, Number.NaN)).toBe(a1);
    });
  });

  describe("evidence checklist (every attempt)", () => {
    const missing = ["tests pass", "the settings page renders the new toggle"];

    for (const attempt of [1, 2, 3]) {
      it(`attempt ${attempt} appends a checkbox list with one item + proof per unmet criterion`, () => {
        const text = buildAutoVerifyCorrection(missing, attempt);
        expect(text).toMatch(/Evidence checklist/i);
        // One checkbox per unmet criterion, each carrying its proof demand.
        expect(text).toContain("- [ ] tests pass — proof: ");
        expect(text).toContain(
          "- [ ] the settings page renders the new toggle — proof: ",
        );
        // The proof demand is the same one proofDemandFor produces (UI → screenshot).
        const checklistLine = text
          .split("\n")
          .find((l) =>
            l.includes("the settings page renders the new toggle — proof:"),
          );
        expect(checklistLine).toMatch(/screenshot/i);
        // Exactly one checkbox per criterion (no duplicates / extras).
        const boxes = text.split("\n").filter((l) => l.startsWith("- [ ] "));
        expect(boxes).toHaveLength(missing.length);
      });
    }
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

  it("an unverifiable-only verdict is inconclusive, not a failed criterion", () => {
    // The tj-92080304431050 regression contract: incomplete evidence must
    // route to the inconclusive path, never to the defect-blaming grill.
    const parsed = parseJudgeResponse(
      '{"passed": false, "summary": "diff was cut", "missing": [], "unverifiable": ["the page shows a word counter"]}',
      ["the page shows a word counter"],
    );
    expect(parsed.passed).toBe(false);
    expect(parsed.inconclusive).toBe(true);
    expect(parsed.missing).toEqual([]);
    expect(parsed.unverifiable).toEqual(["the page shows a word counter"]);
  });

  it("unverifiable wins when the model lists a criterion in both arrays", () => {
    const parsed = parseJudgeResponse(
      '{"passed": false, "summary": "s", "missing": ["c1", "c2"], "unverifiable": ["c1"]}',
      ["c1", "c2"],
    );
    expect(parsed.missing).toEqual(["c2"]);
    expect(parsed.unverifiable).toEqual(["c1"]);
    // A real proven gap remains — the verdict is a genuine fail, not inconclusive.
    expect(parsed.inconclusive).toBe(false);
    expect(parsed.passed).toBe(false);
  });

  it("treats passed=true + non-empty unverifiable as not passed (no auto-pass on incomplete evidence)", () => {
    const parsed = parseJudgeResponse(
      '{"passed": true, "summary": "s", "missing": [], "unverifiable": ["c1"]}',
      ["c1"],
    );
    expect(parsed.passed).toBe(false);
    expect(parsed.inconclusive).toBe(true);
  });

  it("a response without the unverifiable field parses exactly as before", () => {
    const parsed = parseJudgeResponse(
      '{"passed": false, "summary": "no proof", "missing": ["c1"]}',
      ["c1"],
    );
    expect(parsed.passed).toBe(false);
    expect(parsed.missing).toEqual(["c1"]);
    expect(parsed.unverifiable).toEqual([]);
    expect(parsed.inconclusive).toBe(false);
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
    expect(result.inconclusive).toBe(false);
  });

  it("a typed provider context-overflow rejection yields an inconclusive verdict, never criterion blame", async () => {
    // PROMPT-INTEGRITY: complete evidence in the prompt; the provider dispatch
    // boundary owns oversize rejection. When it rejects, nothing was judged —
    // failing criteria here would fabricate blame from evidence nobody saw.
    const overflow = new Error(
      "prompt is too long: 210021 tokens > 204698 maximum",
    );
    const runtime = makeMockRuntime({ shouldThrow: overflow });
    const result = await verifyGoalCompletion(runtime, {
      goal: "x",
      acceptanceCriteria: ["c1", "c2"],
      completionEvidence: "e".repeat(100),
    });
    expect(result.passed).toBe(false);
    expect(result.inconclusive).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.unverifiable).toEqual(["c1", "c2"]);
    expect(result.summary).toMatch(/inconclusive/i);
    expect(result.summary).toMatch(/context limit/i);
  });

  it("classifies the planner-loop's typed PROVIDER_CONTEXT_OVERFLOW code, including on the cause chain", async () => {
    const inner = Object.assign(new Error("model call failed"), {
      code: "PROVIDER_CONTEXT_OVERFLOW",
    });
    const wrapped = new Error("useModel failed");
    (wrapped as { cause?: unknown }).cause = inner;
    const runtime = makeMockRuntime({ shouldThrow: wrapped });
    const result = await verifyGoalCompletion(runtime, {
      goal: "x",
      acceptanceCriteria: ["c1"],
      completionEvidence: "evidence",
    });
    expect(result.inconclusive).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.unverifiable).toEqual(["c1"]);
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
