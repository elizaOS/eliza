/**
 * Isolated compile-gate tests for VFS grep/rg ReDoS rejection. Does not boot
 * VirtualFilesystemService; hang/last-fit cases run against the helper only.
 */
import { describe, expect, it } from "vitest";
import {
  compileVfsSearchPattern,
  MAX_VFS_SEARCH_PATTERN_LENGTH,
  vfsSearchPatternIsUnsafe,
} from "./vfs-search-pattern.ts";

describe("compileVfsSearchPattern", () => {
  it("accepts last-fit linear patterns", () => {
    expect(vfsSearchPatternIsUnsafe("needle")).toBe(false);
    expect(vfsSearchPatternIsUnsafe("foo+")).toBe(false);
    expect(vfsSearchPatternIsUnsafe("(needle)+")).toBe(false);
    expect(vfsSearchPatternIsUnsafe("[a+]+")).toBe(false);
    expect(vfsSearchPatternIsUnsafe("foo|bar")).toBe(false);
    expect(compileVfsSearchPattern("Needles?", true)).toMatchObject({
      ok: true,
    });
    const compiled = compileVfsSearchPattern("needle", false);
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      expect(compiled.matcher.test("a needle here")).toBe(true);
    }
  });

  it("rejects nested quantifiers, quantified alternation, and oversize patterns", () => {
    expect(vfsSearchPatternIsUnsafe("(a+)+$")).toBe(true);
    expect(vfsSearchPatternIsUnsafe("(a*)*")).toBe(true);
    expect(vfsSearchPatternIsUnsafe("(a|aa)+")).toBe(true);
    expect(vfsSearchPatternIsUnsafe("(?:a+)+")).toBe(true);
    expect(
      vfsSearchPatternIsUnsafe("x".repeat(MAX_VFS_SEARCH_PATTERN_LENGTH + 1)),
    ).toBe(false);
    const overflow = compileVfsSearchPattern(
      "x".repeat(MAX_VFS_SEARCH_PATTERN_LENGTH + 1),
    );
    expect(overflow).toEqual({
      ok: false,
      error: `pattern longer than ${MAX_VFS_SEARCH_PATTERN_LENGTH} characters`,
    });
    const nested = compileVfsSearchPattern("(a+)+$");
    expect(nested.ok).toBe(false);
    if (!nested.ok) {
      expect(nested.error).toContain("unsafe regular expression");
    }
  });
});
