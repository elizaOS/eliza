/**
 * Covers parser helpers extractBody and generateSkillsJson.
 * extractBody delegates to parseFrontmatter; generateSkillsJson builds the
 * availableSkills prompt JSON with optional location.
 */

import { describe, expect, it } from "vitest";

import { extractBody, generateSkillsJson } from "./parser.ts";

describe("extractBody", () => {
  it("returns body when frontmatter present", () => {
    const content = ["---", "name: s", "description: d", "---", "", "# Body here"].join("\n");
    expect(extractBody(content)).toBe("# Body here");
  });

  it("returns full content when no frontmatter", () => {
    expect(extractBody("# just body")).toBe("# just body");
    expect(extractBody("")).toBe("");
  });

  it("trims body and handles CRLF frontmatter", () => {
    const crlf = ["---", "name: s", "description: d", "---", "", "Body"].join("\r\n");
    expect(extractBody(crlf)).toBe("Body");
  });

  it("returns empty when body is empty after frontmatter", () => {
    const content = ["---", "name: s", "description: d", "---", ""].join("\n");
    expect(extractBody(content)).toBe("");
  });

  it("handles mixed line endings and preserves body newlines", () => {
    const content = "---\r\nname: s\r\ndescription: d\r\n---\n\nLine1\nLine2";
    expect(extractBody(content)).toBe("Line1\nLine2");
  });
});

describe("generateSkillsJson", () => {
  it("returns empty string for empty skills", () => {
    expect(generateSkillsJson([])).toBe("");
    expect(generateSkillsJson([], { includeLocation: true })).toBe("");
  });

  it("serializes single skill without location by default", () => {
    const json = generateSkillsJson([{ name: "a", description: "desc" }]);
    expect(JSON.parse(json)).toEqual({ availableSkills: [{ name: "a", description: "desc" }] });
  });

  it("includes location only when requested and present", () => {
    const skills = [{ name: "a", description: "d", location: "/x/SKILL.md" }];
    expect(JSON.parse(generateSkillsJson(skills))).toEqual({ availableSkills: [{ name: "a", description: "d" }] });
    expect(JSON.parse(generateSkillsJson(skills, { includeLocation: true }))).toEqual({
      availableSkills: [{ name: "a", description: "d", location: "/x/SKILL.md" }],
    });
  });

  it("omits location when skill has no location even if requested", () => {
    const json = generateSkillsJson([{ name: "a", description: "d" }], { includeLocation: true });
    expect(JSON.parse(json)).toEqual({ availableSkills: [{ name: "a", description: "d" }] });
  });

  it("handles multiple skills", () => {
    const skills = [
      { name: "a", description: "da", location: "/a" },
      { name: "b", description: "db", location: "/b" },
    ];
    const parsed = JSON.parse(generateSkillsJson(skills, { includeLocation: true }));
    expect(parsed.availableSkills).toHaveLength(2);
    expect(parsed.availableSkills[0]).toEqual({ name: "a", description: "da", location: "/a" });
    expect(parsed.availableSkills[1]).toEqual({ name: "b", description: "db", location: "/b" });
  });

  it("produces valid JSON for any input", () => {
    const json = generateSkillsJson([{ name: "x", description: "y" }]);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
