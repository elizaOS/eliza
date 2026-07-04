/**
 * Unit and property tests (fast-check) for the tolerant LLM-response parsing
 * helpers: JSON extraction from fenced/prose output and per-field
 * scalar/array/boolean/number/priority coercion. Deterministic, no live model.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  getBooleanValue,
  getNumberValue,
  getPriorityNumberValue,
  getRecordValue,
  getStringArrayValue,
  getStringValue,
  parseLinearPromptResponse,
} from "./parseLinearPrompt";

describe("parseLinearPromptResponse", () => {
  it("extracts JSON from fenced or prose-wrapped model responses", () => {
    expect(
      parseLinearPromptResponse(
        'Sure:\n```json\n{"title":"Fix login","priority":"high","labels":["bug"]}\n```'
      )
    ).toEqual({
      title: "Fix login",
      priority: "high",
      labels: ["bug"],
    });
    expect(parseLinearPromptResponse('Result: {"title":"Fix API"} thanks')).toEqual({
      title: "Fix API",
    });
  });

  it("normalizes empty scalar/list sentinels and priority names", () => {
    expect(getStringValue(" n/a ")).toBeUndefined();
    expect(getStringValue('"ENG"')).toBe("ENG");
    expect(getStringArrayValue("bug, regression\nfrontend")).toEqual([
      "bug",
      "regression",
      "frontend",
    ]);
    expect(getStringArrayValue("clear all")).toEqual([]);
    expect(getPriorityNumberValue("urgent")).toBe(1);
    expect(getPriorityNumberValue("low")).toBe(4);
  });

  it("rejects hostile or malformed model values without leaking bogus fields", () => {
    expect(parseLinearPromptResponse('["not", "an", "object"]')).toEqual({});
    expect(parseLinearPromptResponse('{"title":"first"} trailing {"title":"second"}')).toEqual({});
    expect(getRecordValue('{"updates":{"title":"Fix it"}}')).toEqual({
      updates: { title: "Fix it" },
    });
    expect(getRecordValue('{"updates":')).toBeUndefined();
    expect(getStringArrayValue(["bug, regression", null, 4, false])).toEqual([
      "bug",
      "regression",
      "4",
      "false",
    ]);
    expect(getStringArrayValue('"clear"')).toEqual([]);
    expect(getBooleanValue("YES")).toBe(true);
    expect(getBooleanValue("0")).toBeUndefined();
    expect(getNumberValue("Infinity")).toBeUndefined();
    expect(getPriorityNumberValue(0)).toBeUndefined();
  });

  it("fuzzes arbitrary model text as non-throwing object output", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2_000 }), (response) => {
        const parsed = parseLinearPromptResponse(response);

        expect(parsed).not.toBeNull();
        expect(typeof parsed).toBe("object");
        expect(Array.isArray(parsed)).toBe(false);
      }),
      { numRuns: 500 }
    );
  });
});
