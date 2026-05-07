import { describe, expect, test } from "bun:test";
import {
  getAvailableActionNames,
  normalizeCloudActionArgs,
  parseNativeMultiStepDecision,
  toNativeActionParams,
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

  test("parses v5 native tool-call-compatible planner output", () => {
    const parsed = parseNativeMultiStepDecision(
      JSON.stringify({
        thought: "search current docs",
        tool_calls: [
          {
            type: "function",
            function: {
              name: "WEB_SEARCH",
              arguments: { query: "native tool calls" },
            },
          },
        ],
      }),
    );

    expect(parsed).toEqual({
      action: "WEB_SEARCH",
      isFinish: undefined,
      parameters: { query: "native tool calls" },
      thought: "search current docs",
    });
  });

  test("normalizes legacy cloud arg shapes into native params", () => {
    expect(toNativeActionParams("web_search", { query: "eliza" })).toEqual({
      WEB_SEARCH: { query: "eliza" },
    });

    expect(
      normalizeCloudActionArgs("WEB_SEARCH", {
        params: { WEB_SEARCH: { query: "native" } },
        actionParams: { query: "legacy" },
        actionInput: { query: "older" },
      }),
    ).toEqual({ query: "native" });

    expect(
      normalizeCloudActionArgs("WEB_SEARCH", {
        actionParams: { query: "legacy" },
        actionInput: { query: "older" },
      }),
    ).toEqual({ query: "legacy" });
  });
});
