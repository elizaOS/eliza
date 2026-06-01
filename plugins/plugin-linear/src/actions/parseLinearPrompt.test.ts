import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  getPriorityNumberValue,
  getStringArrayValue,
  getStringValue,
  parseLinearPromptResponse,
} from "./parseLinearPrompt";

describe("parseLinearPromptResponse", () => {
  it("extracts JSON from fenced or prose-wrapped model responses", () => {
    expect(
      parseLinearPromptResponse(
        'Sure:\n```json\n{"title":"Fix login","priority":"high","labels":["bug"]}\n```',
      ),
    ).toEqual({
      title: "Fix login",
      priority: "high",
      labels: ["bug"],
    });
    expect(
      parseLinearPromptResponse('Result: {"title":"Fix API"} thanks'),
    ).toEqual({ title: "Fix API" });
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

  it("fuzzes arbitrary model text as non-throwing object output", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2_000 }), (response) => {
        const parsed = parseLinearPromptResponse(response);

        expect(parsed).not.toBeNull();
        expect(typeof parsed).toBe("object");
        expect(Array.isArray(parsed)).toBe(false);
      }),
      { numRuns: 500 },
    );
  });
});
