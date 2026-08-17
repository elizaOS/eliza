/**
 * Verifies the production native-planner setting resolver across defaults,
 * canonical values, invalid input, lower/upper bounds, and message overrides.
 */

import { describe, expect, test } from "bun:test";
import {
  type NativePlannerLimitSetting,
  resolveNativePlannerLimits,
} from "./native-planner-limits";

const defaults = {
  maxIterations: 6,
  maxConsecutiveFailures: 2,
  maxParseRetries: 2,
  maxSummaryRetries: 2,
} as const;

function resolve(
  settings: Partial<Record<NativePlannerLimitSetting, unknown>> = {},
  maxIterationsOverride?: number,
) {
  return resolveNativePlannerLimits((name) => settings[name], maxIterationsOverride);
}

describe("resolveNativePlannerLimits", () => {
  test("uses production defaults when settings are absent or blank", () => {
    expect(resolve()).toEqual(defaults);
    expect(
      resolve({
        NATIVE_PLANNER_MAX_ITERATIONS: "",
        NATIVE_PLANNER_MAX_CONSECUTIVE_FAILURES: "  ",
        NATIVE_PLANNER_PARSE_RETRIES: null,
        NATIVE_RESPONSE_PARSE_RETRIES: undefined,
      }),
    ).toEqual(defaults);
  });

  test("accepts canonical values for all four limits", () => {
    expect(
      resolve({
        NATIVE_PLANNER_MAX_ITERATIONS: "12",
        NATIVE_PLANNER_MAX_CONSECUTIVE_FAILURES: 4,
        NATIVE_PLANNER_PARSE_RETRIES: "3",
        NATIVE_RESPONSE_PARSE_RETRIES: 5,
      }),
    ).toEqual({
      maxIterations: 12,
      maxConsecutiveFailures: 4,
      maxParseRetries: 3,
      maxSummaryRetries: 5,
    });
  });

  test.each(["abc", "1e2", "2.5", "Infinity", "9007199254740992"])(
    "falls back for non-canonical or unsafe input %j",
    (value) => {
      expect(
        resolve({
          NATIVE_PLANNER_MAX_ITERATIONS: value,
          NATIVE_PLANNER_MAX_CONSECUTIVE_FAILURES: value,
          NATIVE_PLANNER_PARSE_RETRIES: value,
          NATIVE_RESPONSE_PARSE_RETRIES: value,
        }),
      ).toEqual(defaults);
    },
  );

  test("clamps every setting to its production bounds", () => {
    expect(
      resolve({
        NATIVE_PLANNER_MAX_ITERATIONS: "999999",
        NATIVE_PLANNER_MAX_CONSECUTIVE_FAILURES: "999999",
        NATIVE_PLANNER_PARSE_RETRIES: "999999",
        NATIVE_RESPONSE_PARSE_RETRIES: "999999",
      }),
    ).toEqual({
      maxIterations: 20,
      maxConsecutiveFailures: 10,
      maxParseRetries: 5,
      maxSummaryRetries: 5,
    });
    expect(
      resolve({
        NATIVE_PLANNER_MAX_ITERATIONS: "-1",
        NATIVE_PLANNER_MAX_CONSECUTIVE_FAILURES: "0",
        NATIVE_PLANNER_PARSE_RETRIES: "-20",
        NATIVE_RESPONSE_PARSE_RETRIES: "0",
      }),
    ).toEqual({
      maxIterations: 1,
      maxConsecutiveFailures: 1,
      maxParseRetries: 1,
      maxSummaryRetries: 1,
    });
  });

  test("the message override takes precedence but cannot bypass the iteration cap", () => {
    expect(resolve({ NATIVE_PLANNER_MAX_ITERATIONS: "3" }, 8).maxIterations).toBe(8);
    expect(resolve({ NATIVE_PLANNER_MAX_ITERATIONS: "3" }, 1000).maxIterations).toBe(20);
    expect(resolve({ NATIVE_PLANNER_MAX_ITERATIONS: "3" }, Number.NaN).maxIterations).toBe(6);
  });
});
