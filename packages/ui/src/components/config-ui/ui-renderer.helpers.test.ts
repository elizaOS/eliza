/**
 * Isolated tests for UiRenderer validation helpers. Agent-authored specs
 * supply `pattern` strings; nested-quantifier shapes must fail closed
 * without compiling into a hang.
 */
import { describe, expect, it } from "vitest";
import { runValidation } from "./ui-renderer.helpers";

describe("UiRenderer pattern validator", () => {
  it("fails closed on nested-quantifier agent patterns", () => {
    const errors = runValidation(
      [{ fn: "pattern", args: { pattern: "^(a+)+$" }, message: "bad" }],
      `${"a".repeat(30)}!`,
    );
    expect(errors).toEqual(["bad"]);
  });

  it.each(["^((a+))+$", "^(a|aa)+$", "^a+a+$", "^(a)\\1$"])(
    "fails closed on adversarial pattern %s",
    (pattern) => {
      expect(
        runValidation(
          [{ fn: "pattern", args: { pattern }, message: "bad" }],
          `${"a".repeat(30)}!`,
        ),
      ).toEqual(["bad"]);
    },
  );

  it("still accepts an honest format pattern", () => {
    expect(
      runValidation(
        [
          {
            fn: "pattern",
            args: { pattern: "^[a-z0-9_-]{1,32}$" },
            message: "bad",
          },
        ],
        "ok_id",
      ),
    ).toEqual([]);
    expect(
      runValidation(
        [
          {
            fn: "pattern",
            args: { pattern: "^[a-z0-9_-]{1,32}$" },
            message: "bad",
          },
        ],
        "NO",
      ),
    ).toEqual(["bad"]);
  });
});
