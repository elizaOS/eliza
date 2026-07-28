/**
 * Verifies the shared CI classifier parses Git's NUL-delimited changed-path
 * inventory without losing rename endpoints or unusual valid filenames.
 */
import { describe, expect, it } from "bun:test";
import { parseGitNameStatus } from "../ci-path-gate.mjs";

describe("parseGitNameStatus", () => {
  it("returns an empty inventory for an empty diff", () => {
    expect(parseGitNameStatus("")).toEqual([]);
  });

  it("parses ordinary add, delete, modify, and type-change records", () => {
    expect(
      parseGitNameStatus(
        [
          "A",
          "added.ts",
          "D",
          "deleted.ts",
          "M",
          "modified.ts",
          "T",
          "type-changed.ts",
          "",
        ].join("\0"),
      ),
    ).toEqual(["added.ts", "deleted.ts", "modified.ts", "type-changed.ts"]);
  });

  it("includes both endpoints for renames and copies", () => {
    expect(
      parseGitNameStatus(
        [
          "R100",
          "packages/app/src/covered.ts",
          "packages/docs/covered.ts",
          "C75",
          "packages/core/src/source.ts",
          "packages/shared/src/copied.ts",
          "",
        ].join("\0"),
      ),
    ).toEqual([
      "packages/app/src/covered.ts",
      "packages/docs/covered.ts",
      "packages/core/src/source.ts",
      "packages/shared/src/copied.ts",
    ]);
  });

  it("preserves spaces, tabs, and newlines inside paths", () => {
    const unusual = "packages/app/src/space tab\tline\nbreak.ts";
    expect(parseGitNameStatus(["A", unusual, ""].join("\0"))).toEqual([
      unusual,
    ]);
  });

  it("deduplicates paths while retaining first-seen order", () => {
    expect(
      parseGitNameStatus(
        ["M", "same.ts", "R100", "same.ts", "moved.ts", ""].join("\0"),
      ),
    ).toEqual(["same.ts", "moved.ts"]);
  });

  it("fails closed on unsupported or truncated records", () => {
    expect(() => parseGitNameStatus("Z\0mystery.ts\0")).toThrow(
      /unsupported git diff status/,
    );
    expect(() => parseGitNameStatus("R100\0source.ts\0")).toThrow(
      /malformed git diff record/,
    );
    expect(() => parseGitNameStatus("M")).toThrow(/malformed git diff record/);
  });
});
