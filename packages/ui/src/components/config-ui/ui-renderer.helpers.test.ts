/**
 * Isolated tests for UiRenderer validation helpers. Agent-authored specs
 * supply `pattern` strings; nested-quantifier shapes must fail closed
 * without compiling into a hang.
 */
import { describe, expect, it } from "vitest";
import { runValidation } from "./ui-renderer.helpers";

describe("UiRenderer pattern validator", () => {
  it("fails closed on nested-quantifier agent patterns before compile", () => {
    const started = performance.now();
    const errors = runValidation(
      [{ fn: "pattern", args: { pattern: "^(a+)+$" }, message: "bad" }],
      `${"a".repeat(30)}!`,
    );
    expect(errors).toEqual(["bad"]);
    expect(performance.now() - started).toBeLessThan(20);
  });

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
