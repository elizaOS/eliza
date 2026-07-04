/**
 * Skill-package validation tests for Agent Skills frontmatter.
 * The parser gates SKILL.md loading, including slug constraints, directory/name alignment, and required fields.
 */

import { describe, expect, it } from "vitest";
import { validateFrontmatter, validateSkillDirectory } from "./parser.ts";
import type { SkillFrontmatter } from "./types.ts";

const fm = (over: Partial<SkillFrontmatter> = {}): SkillFrontmatter => ({
  name: "my-skill",
  description: "A clear description of what this skill does and when to use it.",
  ...over,
});
const codes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code);

describe("validateFrontmatter", () => {
  it("accepts a well-formed skill", () => {
    const r = validateFrontmatter(fm());
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("requires name and description", () => {
    expect(codes(validateFrontmatter(fm({ name: "" })))).toContain(
      "MISSING_NAME",
    );
    expect(codes(validateFrontmatter(fm({ description: "" })))).toContain(
      "MISSING_DESCRIPTION",
    );
  });

  it("rejects a name that is not a lowercase slug", () => {
    for (const name of ["My-Skill", "my_skill", "has space"]) {
      const r = validateFrontmatter(fm({ name }));
      expect(r.valid).toBe(false);
      expect(codes(r)).toContain("INVALID_NAME_FORMAT");
    }
  });

  it("rejects leading/trailing and consecutive hyphens explicitly", () => {
    expect(codes(validateFrontmatter(fm({ name: "-skill" })))).toContain(
      "NAME_INVALID_HYPHEN",
    );
    expect(codes(validateFrontmatter(fm({ name: "my--skill" })))).toContain(
      "NAME_CONSECUTIVE_HYPHENS",
    );
  });

  it("rejects an over-length name", () => {
    expect(codes(validateFrontmatter(fm({ name: "a".repeat(65) })))).toContain(
      "NAME_TOO_LONG",
    );
  });

  it("requires the name to match its directory", () => {
    const r = validateFrontmatter(fm({ name: "my-skill" }), "other-dir");
    expect(r.valid).toBe(false);
    expect(codes(r)).toContain("NAME_MISMATCH");
  });
});

describe("validateSkillDirectory", () => {
  it("rejects content with no YAML frontmatter", () => {
    const r = validateSkillDirectory("/x/SKILL.md", "# just a body", "my-skill");
    expect(r.valid).toBe(false);
    expect(codes(r)).toContain("MISSING_FRONTMATTER");
  });

  it("accepts a SKILL.md whose frontmatter is valid and matches the dir", () => {
    const content = [
      "---",
      "name: my-skill",
      "description: A clear description of what this skill does and when to use it.",
      "---",
      "",
      "# My Skill",
    ].join("\n");
    const r = validateSkillDirectory("/x/SKILL.md", content, "my-skill");
    expect(r.valid).toBe(true);
  });
});
