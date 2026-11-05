import { describe, expect, it } from "vitest";
import { parseJudgeResponse } from "../services/goal-llm-verifier.ts";

const CRITERIA = ["tests pass", "build succeeds"];

describe("parseJudgeResponse", () => {
  it("accepts a bare verdict object", () => {
    const result = parseJudgeResponse(
      `{"passed": true, "summary": "All proven.", "missing": []}`,
      CRITERIA,
    );
    expect(result.passed).toBe(true);
    expect(result.inconclusive).toBe(false);
    expect(result.missing).toEqual([]);
  });

  it("accepts a verdict behind brace-free prose", () => {
    const result = parseJudgeResponse(
      `Verdict: {"passed": false, "summary": "No test output.", "missing": ["tests pass"]}`,
      CRITERIA,
    );
    expect(result.passed).toBe(false);
    expect(result.inconclusive).toBe(false);
    expect(result.missing).toEqual(["tests pass"]);
  });

  it("accepts a verdict whose summary holds a closing brace", () => {
    const result = parseJudgeResponse(
      `{"passed": true, "summary": "Closed the {parser} gap } cleanly", "missing": []}`,
      CRITERIA,
    );
    expect(result.passed).toBe(true);
    expect(result.inconclusive).toBe(false);
  });

  it("accepts a verdict whose summary holds an unclosed opening brace", () => {
    const result = parseJudgeResponse(
      `{"passed": true, "summary": "Template {name is now filled", "missing": []}`,
      CRITERIA,
    );
    expect(result.passed).toBe(true);
    expect(result.inconclusive).toBe(false);
  });

  it("accepts a verdict behind an unclosed prose brace", () => {
    const result = parseJudgeResponse(
      `Checking {the diff now:\n{"passed": true, "summary": "Proven.", "missing": []}`,
      CRITERIA,
    );
    expect(result.passed).toBe(true);
    expect(result.inconclusive).toBe(false);
  });

  it("still fails closed on a reply with no verdict object", () => {
    const result = parseJudgeResponse("The evidence looks fine.", CRITERIA);
    expect(result.passed).toBe(false);
    expect(result.inconclusive).toBe(true);
    expect(result.missing).toEqual(CRITERIA);
  });
});
