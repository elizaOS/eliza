/**
 * Unit tests for repository input normalizer: validates owner/repo expansion,
 * HTTPS clone URL formatting, and SSH preservation.
 */
import { describe, expect, it } from "vitest";
import { normalizeRepositoryInput } from "./repo-input.ts";

describe("repo-input", () => {
  it("returns empty string for empty input", () => {
    expect(normalizeRepositoryInput("")).toBe("");
    expect(normalizeRepositoryInput("   ")).toBe("");
  });

  it("preserves SSH clone URLs unchanged", () => {
    const ssh = "git@github.com:elizaOS/eliza.git";
    expect(normalizeRepositoryInput(ssh)).toBe(ssh);
  });

  it("normalizes owner/repo shorthand to HTTPS clone URL", () => {
    const res = normalizeRepositoryInput("elizaOS/eliza");
    expect(res).toBe("https://github.com/elizaOS/eliza.git");
  });

  it("normalizes github.com/owner/repo without protocol", () => {
    const res = normalizeRepositoryInput("github.com/elizaOS/eliza");
    expect(res).toBe("https://github.com/elizaOS/eliza.git");
  });

  it("normalizes full HTTPS URLs by appending .git if missing", () => {
    const res = normalizeRepositoryInput("https://github.com/elizaOS/eliza");
    expect(res).toBe("https://github.com/elizaOS/eliza.git");
  });
});
