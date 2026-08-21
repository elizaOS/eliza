/**
 * Deterministic unit tests for the bounded goal/evidence prompt walk.
 * Covers honest rendering plus fail-closed depth, node, and cycle budgets.
 * Imports the walk module directly so the harness does not load the core barrel.
 */
import { describe, expect, it } from "vitest";
import { GoalsServiceError } from "./goal-normalize.js";
import {
  formatPromptValue,
  GOAL_PROMPT_VALUE_UNBOUNDED,
  MAX_GOAL_PROMPT_VALUE_CODE_UNITS,
  MAX_GOAL_PROMPT_VALUE_DEPTH,
  MAX_GOAL_PROMPT_VALUE_NODES,
} from "./goal-prompt-value.js";

function nestArray(depth: number): unknown {
  let value: unknown = "leaf";
  for (let i = 0; i < depth; i++) {
    value = [value];
  }
  return value;
}

function expectUnbounded(fn: () => unknown): GoalsServiceError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GoalsServiceError);
    expect(error).not.toBeInstanceOf(RangeError);
    expect((error as GoalsServiceError).code).toBe(GOAL_PROMPT_VALUE_UNBOUNDED);
    return error as GoalsServiceError;
  }
  throw new Error("expected GOAL_PROMPT_VALUE_UNBOUNDED");
}

describe("formatPromptValue", () => {
  it("renders honest scalars, lists, and nested records", () => {
    expect(formatPromptValue("hello")).toBe("hello");
    expect(formatPromptValue(3)).toBe("3");
    expect(formatPromptValue(true)).toBe("true");
    expect(formatPromptValue(null)).toBe("null");
    expect(formatPromptValue(undefined)).toBe("");
    expect(formatPromptValue([])).toBe("(none)");
    expect(formatPromptValue({})).toBe("(empty)");
    expect(formatPromptValue(["a", "b"])).toBe("  - a\n  - b");
    expect(formatPromptValue({ title: "Sleep", hours: 8 })).toBe(
      "title: Sleep\nhours: 8",
    );
    expect(
      formatPromptValue({
        goal: { title: "Sleep" },
        evidence: ["logged"],
      }),
    ).toBe("goal:   title: Sleep\nevidence:     - logged");
  });

  it(`accepts a ${MAX_GOAL_PROMPT_VALUE_DEPTH}-deep array nest`, () => {
    expect(formatPromptValue(nestArray(MAX_GOAL_PROMPT_VALUE_DEPTH))).toContain(
      "leaf",
    );
  });

  it(`throws ${GOAL_PROMPT_VALUE_UNBOUNDED} one past depth ${MAX_GOAL_PROMPT_VALUE_DEPTH}`, () => {
    const error = expectUnbounded(() =>
      formatPromptValue(nestArray(MAX_GOAL_PROMPT_VALUE_DEPTH + 1)),
    );
    expect(error.message).toContain(String(MAX_GOAL_PROMPT_VALUE_DEPTH));
  });

  it(`throws ${GOAL_PROMPT_VALUE_UNBOUNDED} past ${MAX_GOAL_PROMPT_VALUE_NODES} nodes`, () => {
    const siblings = Array.from(
      { length: MAX_GOAL_PROMPT_VALUE_NODES },
      (_, index) => `v${index}`,
    );
    expectUnbounded(() => formatPromptValue(siblings));
  });

  it("throws on cyclic objects instead of RangeError", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expectUnbounded(() => formatPromptValue(cyclic));
  });

  it("does not RangeError a 20k array nest", () => {
    const error = expectUnbounded(() => formatPromptValue(nestArray(20_000)));
    expect(error.message).toContain(String(MAX_GOAL_PROMPT_VALUE_DEPTH));
  });

  it("rejects sparse arrays by logical slots", () => {
    const sparse: unknown[] = [];
    sparse.length = MAX_GOAL_PROMPT_VALUE_NODES + 1;
    expectUnbounded(() => formatPromptValue(sparse));
  });

  it("rejects object accessors without invoking them", () => {
    let calls = 0;
    const value = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        calls += 1;
        return "value";
      },
    });
    expectUnbounded(() => formatPromptValue(value));
    expect(calls).toBe(0);
  });

  it("bounds rendered prompt contribution", () => {
    expectUnbounded(() =>
      formatPromptValue("x".repeat(MAX_GOAL_PROMPT_VALUE_CODE_UNITS + 1)),
    );
  });

  it("contains hostile descriptor traps", () => {
    const value = new Proxy(
      { field: "value" },
      {
        getOwnPropertyDescriptor() {
          throw new Error("descriptor trap");
        },
      },
    );
    expectUnbounded(() => formatPromptValue(value));
  });
});
