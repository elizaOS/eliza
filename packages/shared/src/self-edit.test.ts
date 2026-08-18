/**
 * Tests for self-edit safety gate and path denylist helpers.
 */
import { describe, expect, it } from "vitest";
import {
  DEV_MODE_ENV,
  getSelfEditDeniedSuffixes,
  isSelfEditEnabled,
  isSelfEditPathDenied,
  SELF_EDIT_ENABLE_ENV,
} from "./self-edit.ts";

describe("isSelfEditEnabled", () => {
  it("returns false when enable env var is unset or falsey", () => {
    expect(isSelfEditEnabled({})).toBe(false);
    expect(isSelfEditEnabled({ [SELF_EDIT_ENABLE_ENV]: "0" })).toBe(false);
    expect(isSelfEditEnabled({ [SELF_EDIT_ENABLE_ENV]: "false" })).toBe(false);
    expect(isSelfEditEnabled({ [SELF_EDIT_ENABLE_ENV]: "" })).toBe(false);
  });

  it("returns true in non-production environments when enabled", () => {
    expect(
      isSelfEditEnabled({
        [SELF_EDIT_ENABLE_ENV]: "1",
        NODE_ENV: "development",
      }),
    ).toBe(true);
    expect(
      isSelfEditEnabled({
        [SELF_EDIT_ENABLE_ENV]: "true",
        NODE_ENV: "test",
      }),
    ).toBe(true);
  });

  it("returns false in production unless dev mode is explicitly active", () => {
    expect(
      isSelfEditEnabled({
        [SELF_EDIT_ENABLE_ENV]: "1",
        NODE_ENV: "production",
      }),
    ).toBe(false);

    expect(
      isSelfEditEnabled({
        [SELF_EDIT_ENABLE_ENV]: "1",
        NODE_ENV: "production",
        [DEV_MODE_ENV]: "1",
      }),
    ).toBe(true);
  });

  it("handles nullish or invalid env safely", () => {
    expect(
      typeof isSelfEditEnabled(null as unknown as Record<string, string>),
    ).toBe("boolean");
    expect(
      typeof isSelfEditEnabled(undefined as unknown as Record<string, string>),
    ).toBe("boolean");
  });
});

describe("isSelfEditPathDenied", () => {
  it("denies paths inside .git directory or metadata", () => {
    expect(isSelfEditPathDenied(".git")).toBe(true);
    expect(isSelfEditPathDenied(".git/config")).toBe(true);
    expect(isSelfEditPathDenied("/project/.git/HEAD")).toBe(true);
    expect(isSelfEditPathDenied("C:\\project\\.git\\index")).toBe(true);
    expect(isSelfEditPathDenied("project//.git//hooks")).toBe(true);
  });

  it("denies paths matching protected files in denylist", () => {
    for (const suffix of getSelfEditDeniedSuffixes()) {
      expect(isSelfEditPathDenied(`/workspace/${suffix}`)).toBe(true);
      expect(
        isSelfEditPathDenied(`C:\\workspace\\${suffix.replace(/\//g, "\\")}`),
      ).toBe(true);
      expect(isSelfEditPathDenied(suffix)).toBe(true);
    }
  });

  it("allows normal project source files", () => {
    expect(isSelfEditPathDenied("/workspace/packages/core/src/index.ts")).toBe(
      false,
    );
    expect(isSelfEditPathDenied("/workspace/.gitignore")).toBe(false);
    expect(isSelfEditPathDenied("/workspace/.gitmodules")).toBe(false);
    expect(isSelfEditPathDenied("/workspace/README.md")).toBe(false);
  });

  it("returns false for non-string, empty, or whitespace inputs", () => {
    expect(isSelfEditPathDenied("")).toBe(false);
    expect(isSelfEditPathDenied("   ")).toBe(false);
    expect(isSelfEditPathDenied(null as unknown as string)).toBe(false);
    expect(isSelfEditPathDenied(undefined as unknown as string)).toBe(false);
    expect(isSelfEditPathDenied(123 as unknown as string)).toBe(false);
  });
});

describe("getSelfEditDeniedSuffixes", () => {
  it("returns a non-empty array containing critical security files", () => {
    const suffixes = getSelfEditDeniedSuffixes();
    expect(Array.isArray(suffixes)).toBe(true);
    expect(suffixes.length).toBeGreaterThan(0);
    expect(suffixes).toContain("packages/shared/src/self-edit.ts");
    expect(suffixes).toContain("packages/shared/src/restart.ts");
  });
});
