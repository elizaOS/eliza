/**
 * Coverage for db-errors.
 */
import { describe, expect, it } from "vitest";
import { isUniqueConstraintError } from "./db-errors.js";

describe("db-errors", () => {
  it("detects unique constraint", () => {
    const err = Object.assign(new Error("duplicate key violates unique constraint"), {
      code: "23505",
    });
    expect(isUniqueConstraintError(err)).toBe(true);
  });
  it("detects message", () => {
    expect(isUniqueConstraintError(new Error("unique constraint failed"))).toBe(true);
  });
  it("false for other", () => {
    expect(isUniqueConstraintError(new Error("other"))).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
  });
  it("follows cause chain", () => {
    const inner = Object.assign(new Error("duplicate key"), { code: "23505" });
    const outer = new Error("wrap", { cause: inner });
    expect(isUniqueConstraintError(outer)).toBe(true);
  });
});
