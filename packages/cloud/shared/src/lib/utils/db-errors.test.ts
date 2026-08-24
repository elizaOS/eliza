import { describe, expect, it } from "vitest";
import { isUniqueConstraintError } from "./db-errors.js";

describe("isUniqueConstraintError", () => {
  it("detects by code", () => {
    const err = Object.assign(new Error("fail"), { code: "23505" });
    expect(isUniqueConstraintError(err)).toBe(true);
  });

  it("detects by message", () => {
    expect(
      isUniqueConstraintError(new Error("duplicate key value violates unique constraint")),
    ).toBe(true);
    expect(isUniqueConstraintError(new Error("unique constraint"))).toBe(true);
  });

  it("follows cause chain", () => {
    const inner = Object.assign(new Error("unique constraint"), { code: "23505" });
    const outer = new Error("wrapped", { cause: inner });
    expect(isUniqueConstraintError(outer)).toBe(true);
  });

  it("returns false for other errors and non-errors", () => {
    expect(isUniqueConstraintError(new Error("other"))).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
    expect(isUniqueConstraintError("string")).toBe(false);
  });
});
