/**
 * Verifies parseOwnerRepo.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import { stripAnsi } from "../../src/services/ansi-utils.js";
import { normalizeRepositoryInput } from "../../src/services/repo-input.js";
import { parseOwnerRepo } from "../../src/services/workspace-github.js";

// #9146 — coding-agent orchestration parses repo inputs from many surfaces
// (URL, shorthand, SSH) and cleans CLI output before showing it. These are pure
// and were untested.

describe("parseOwnerRepo", () => {
  it("parses shorthand and github URLs", () => {
    expect(parseOwnerRepo("owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
    expect(parseOwnerRepo("https://github.com/elizaOS/eliza")).toEqual({
      owner: "elizaOS",
      repo: "eliza",
    });
  });

  it("stops the repo name at a dot (drops .git)", () => {
    expect(parseOwnerRepo("https://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("throws when no owner/repo can be extracted", () => {
    expect(() => parseOwnerRepo("nothinghere")).toThrow(
      "Cannot parse owner/repo",
    );
  });
});

describe("normalizeRepositoryInput", () => {
  it("normalizes shorthand + URL + host-prefixed forms to an https clone URL", () => {
    const expected = "https://github.com/owner/repo.git";
    expect(normalizeRepositoryInput("owner/repo")).toBe(expected);
    expect(normalizeRepositoryInput("https://github.com/owner/repo")).toBe(
      expected,
    );
    expect(normalizeRepositoryInput("https://github.com/owner/repo/")).toBe(
      expected,
    );
    expect(normalizeRepositoryInput("github.com/owner/repo")).toBe(expected);
    expect(normalizeRepositoryInput("owner/repo.git")).toBe(expected);
  });

  it("preserves an SSH clone URL verbatim", () => {
    const ssh = "git@github.com:owner/repo.git";
    expect(normalizeRepositoryInput(ssh)).toBe(ssh);
  });

  it("returns empty for blank input", () => {
    expect(normalizeRepositoryInput("   ")).toBe("");
  });
});

describe("stripAnsi", () => {
  it("removes SGR color escapes, keeping the text", () => {
    expect(stripAnsi("[31mred[0m")).toBe("red");
    expect(stripAnsi("[1m[32mbold green[0m")).toBe("bold green");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });
});
