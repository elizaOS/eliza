/**
 * Covers markdown scanner pure helpers isMarkdown and buildMarkdownRules.
 * isMarkdown checks extension allowlist; buildMarkdownRules returns the
 * rule table with md-external-url pattern using the safe-domain allowlist.
 */

import { describe, expect, it } from "vitest";

import { buildMarkdownRules, isMarkdown } from "./markdown-scanner.ts";

describe("isMarkdown", () => {
  it("accepts .md, .mdx, .markdown (case-insensitive)", () => {
    expect(isMarkdown("SKILL.md")).toBe(true);
    expect(isMarkdown("a.mdx")).toBe(true);
    expect(isMarkdown("b.markdown")).toBe(true);
    expect(isMarkdown("UPPER.MD")).toBe(true);
    expect(isMarkdown("MiXeD.MdX")).toBe(true);
  });

  it("rejects non-markdown extensions and no extension", () => {
    expect(isMarkdown("file.txt")).toBe(false);
    expect(isMarkdown("file.js")).toBe(false);
    expect(isMarkdown("noext")).toBe(false);
    expect(isMarkdown("")).toBe(false);
    expect(isMarkdown(".md")).toBe(true); // dot at 0 still has extension
  });

  it("uses last dot for extension", () => {
    expect(isMarkdown("a.b.md")).toBe(true);
    expect(isMarkdown("a.md.txt")).toBe(false);
    expect(isMarkdown("path/to/SKILL.md")).toBe(true);
    expect(isMarkdown("path/to/file.MARKDOWN")).toBe(true);
  });
});

describe("buildMarkdownRules", () => {
  it("returns an array with expected ruleIds", () => {
    const rules = buildMarkdownRules();
    const ids = rules.map((r) => r.ruleId);
    expect(ids).toContain("md-pipe-to-shell");
    expect(ids).toContain("md-curl-exec");
    expect(ids).toContain("md-prompt-injection");
    expect(ids).toContain("md-external-url");
    expect(ids.length).toBeGreaterThan(5);
  });

  it("md-external-url rule matches external URLs", () => {
    const rules = buildMarkdownRules();
    const ext = rules.find((r) => r.ruleId === "md-external-url")!;
    expect(ext).toBeDefined();
    expect(ext.pattern.test("https://evil.com/x")).toBe(true);
    expect(ext.pattern.test("http://evil.com")).toBe(true);
    // safe domains should still match the pattern (pattern is just https?://), the filtering is via match()
    expect(ext.pattern.test("https://github.com/a/b")).toBe(true);
  });

  it("md-external-url match() filters safe domains", () => {
    const rules = buildMarkdownRules();
    const ext = rules.find((r) => r.ruleId === "md-external-url")!;
    // Without safe domain, should flag external
    expect(ext.match?.("Download from https://evil.com/x", "SKILL.md")).toBe(true);
    // Safe domain should not flag
    expect(ext.match?.("See https://github.com/a/b", "SKILL.md")).toBe(false);
    expect(ext.match?.("Fetch https://raw.githubusercontent.com/o/r/main/f", "SKILL.md")).toBe(false);
  });

  it("safe-domain filter respects additionalSafeDomains", () => {
    const rules = buildMarkdownRules(["my-safe.example.com"]);
    const ext = rules.find((r) => r.ruleId === "md-external-url")!;
    expect(ext.match?.("See https://my-safe.example.com/x", "SKILL.md")).toBe(false);
    expect(ext.match?.("See https://other.example.com/x", "SKILL.md")).toBe(true);
  });

  it("every rule has required fields", () => {
    const rules = buildMarkdownRules();
    for (const rule of rules) {
      expect(rule.ruleId).toBeTypeOf("string");
      expect(rule.severity).toMatch(/critical|warn/);
      expect(rule.message).toBeTypeOf("string");
      expect(rule.pattern).toBeInstanceOf(RegExp);
    }
  });
});
