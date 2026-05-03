import { describe, expect, test } from "bun:test";
import {
  getAvailableActionNames,
  validateMultiStepDecision,
} from "@/lib/eliza/plugin-cloud-bootstrap/utils/multi-step-guards";

describe("cloud bootstrap multi-step guards", () => {
  test("extracts available action names from provider data", () => {
    expect(
      [...getAvailableActionNames([{ name: "WEB_SEARCH" }, { name: "FINISH" }, null])].sort(),
    ).toEqual(["FINISH", "WEB_SEARCH"]);
  });

  test("accepts valid known actions with JSON parameters", () => {
    const result = validateMultiStepDecision(
      {
        action: "WEB_SEARCH",
        parameters: '{"query":"latest bun release"}',
        isFinish: "false",
      },
      new Set(["WEB_SEARCH"]),
    );

    expect(result.error).toBeUndefined();
    expect(result.decision).toEqual({
      action: "WEB_SEARCH",
      isFinish: false,
      parameters: { query: "latest bun release" },
      thought: undefined,
    });
  });

  test("rejects unknown action names", () => {
    const result = validateMultiStepDecision(
      {
        action: "DELETE_ALL_DATA",
        parameters: "{}",
      },
      new Set(["WEB_SEARCH"]),
    );

    expect(result.error).toBe("unknown action: DELETE_ALL_DATA");
  });

  test("rejects non-object parameters", () => {
    const result = validateMultiStepDecision(
      {
        action: "WEB_SEARCH",
        parameters: "[]",
      },
      new Set(["WEB_SEARCH"]),
    );

    expect(result.error).toBe("parameters must be a JSON object");
  });

  test("allows explicit finish without an action", () => {
    const result = validateMultiStepDecision(
      {
        isFinish: "true",
        parameters: {},
      },
      new Set(["WEB_SEARCH"]),
    );

    expect(result.error).toBeUndefined();
    expect(result.decision).toEqual({
      isFinish: true,
      parameters: {},
      thought: undefined,
    });
  });
});
