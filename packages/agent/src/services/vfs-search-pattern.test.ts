/**
 * Exercises the isolated VFS grep evaluator with real worker threads. The
 * suite covers JavaScript RegExp compatibility and timeout termination.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_VFS_SEARCH_PATTERN_LENGTH,
  runVfsSearchPattern,
} from "./vfs-search-pattern.ts";

describe("runVfsSearchPattern", () => {
  it("preserves safe alternation, lookahead, backreference, and invert semantics", async () => {
    const alternation = await runVfsSearchPattern({
      pattern: "^(cat|dog)+$",
      ignoreCase: false,
      invertMatch: false,
      filesWithMatches: false,
      linesByTarget: [["catdog", "bird"]],
    });
    expect(alternation).toEqual({ ok: true, selectedLineIndexes: [[0]] });

    const advanced = await runVfsSearchPattern({
      pattern: "^(a)(?=a)\\1$",
      ignoreCase: false,
      invertMatch: true,
      filesWithMatches: false,
      linesByTarget: [["aa", "ab"]],
    });
    expect(advanced).toEqual({ ok: true, selectedLineIndexes: [[1]] });
  });

  it("returns syntax and length failures without testing lines", async () => {
    await expect(
      runVfsSearchPattern({
        pattern: "(",
        ignoreCase: false,
        invertMatch: false,
        filesWithMatches: false,
        linesByTarget: [["anything"]],
      }),
    ).resolves.toMatchObject({ ok: false });

    await expect(
      runVfsSearchPattern({
        pattern: "x".repeat(MAX_VFS_SEARCH_PATTERN_LENGTH + 1),
        ignoreCase: false,
        invertMatch: false,
        filesWithMatches: false,
        linesByTarget: [["anything"]],
      }),
    ).resolves.toEqual({
      ok: false,
      error: `pattern longer than ${MAX_VFS_SEARCH_PATTERN_LENGTH} characters`,
    });
  });

  it("terminates catastrophic backtracking without blocking the caller", async () => {
    const startedAt = Date.now();
    const result = await runVfsSearchPattern({
      pattern: "(a+)+$",
      ignoreCase: false,
      invertMatch: false,
      filesWithMatches: false,
      linesByTarget: [[`${"a".repeat(30)}!`]],
      timeoutMs: 100,
    });

    expect(result).toEqual({
      ok: false,
      error: "regular expression timed out",
    });
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });
});
