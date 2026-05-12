import assert from "node:assert";
import { describe, it } from "node:test";
import {
  buildSkillCommandSpecs,
  formatSkillEntriesForPrompt,
  formatSkillSummary,
  formatSkillsForPrompt,
  formatSkillsList,
} from "../src/formatter.js";
import type { Skill, SkillEntry } from "../src/types.js";

describe("formatSkillsForPrompt", () => {
  it("returns empty string for no skills", () => {
    assert.strictEqual(formatSkillsForPrompt([]), "");
  });

  it("returns empty string when all skills have disableModelInvocation", () => {
    const skills: Skill[] = [
      {
        name: "hidden",
        description: "Hidden skill",
        disableModelInvocation: true,
      },
    ];
    assert.strictEqual(formatSkillsForPrompt(skills), "");
  });

  it("formats visible skills as structured text", () => {
    const skills: Skill[] = [
      {
        name: "test-skill",
        description: "A test skill",
        filePath: "/path/to/SKILL.md",
      },
    ];
    const result = formatSkillsForPrompt(skills);
    assert.ok(result.includes("available_skills:"));
    assert.ok(result.includes("- name: test-skill"));
    assert.ok(result.includes("description: A test skill"));
    assert.ok(result.includes("location: /path/to/SKILL.md"));
  });

  it("omits location when filePath is not set", () => {
    const skills: Skill[] = [{ name: "inline", description: "Inline skill" }];
    const result = formatSkillsForPrompt(skills);
    assert.ok(result.includes("- name: inline"));
    assert.ok(!result.includes("location:"));
  });

  it("preserves non-XML text characters in name and description", () => {
    const skills: Skill[] = [
      { name: "test", description: "Uses <tags> & \"quotes\" and 'apos'" },
    ];
    const result = formatSkillsForPrompt(skills);
    assert.ok(result.includes("Uses <tags> & \"quotes\" and 'apos'"));
  });

  it("formats multiple skills", () => {
    const skills: Skill[] = [
      { name: "skill-a", description: "First" },
      { name: "skill-b", description: "Second" },
    ];
    const result = formatSkillsForPrompt(skills);
    assert.ok(result.includes("- name: skill-a"));
    assert.ok(result.includes("- name: skill-b"));
  });
});

describe("formatSkillEntriesForPrompt", () => {
  it("filters entries by invocation policy", () => {
    const entries: SkillEntry[] = [
      {
        skill: { name: "visible", description: "Visible" },
        frontmatter: {},
        metadata: {},
        invocation: { disableModelInvocation: false },
      },
      {
        skill: { name: "hidden", description: "Hidden" },
        frontmatter: {},
        metadata: {},
        invocation: { disableModelInvocation: true },
      },
    ];
    const result = formatSkillEntriesForPrompt(entries);
    assert.ok(result.includes("visible"));
    assert.ok(!result.includes("- name: hidden"));
  });

  it("returns empty string when all entries are hidden", () => {
    const entries: SkillEntry[] = [
      {
        skill: { name: "hidden", description: "Hidden" },
        frontmatter: {},
        metadata: {},
        invocation: { disableModelInvocation: true },
      },
    ];
    assert.strictEqual(formatSkillEntriesForPrompt(entries), "");
  });
});

describe("formatSkillSummary", () => {
  it("formats as 'name: description'", () => {
    const skill: Skill = { name: "my-skill", description: "Does things" };
    assert.strictEqual(formatSkillSummary(skill), "my-skill: Does things");
  });
});

describe("formatSkillsList", () => {
  it("formats multiple skills as newline-separated list", () => {
    const skills: Skill[] = [
      { name: "a", description: "First" },
      { name: "b", description: "Second" },
    ];
    assert.strictEqual(formatSkillsList(skills), "a: First\nb: Second");
  });

  it("returns empty string for empty array", () => {
    assert.strictEqual(formatSkillsList([]), "");
  });

  it("handles single skill", () => {
    const skills: Skill[] = [{ name: "solo", description: "Only one" }];
    assert.strictEqual(formatSkillsList(skills), "solo: Only one");
  });
});

describe("buildSkillCommandSpecs", () => {
  it("builds command specs from entries", () => {
    const entries: SkillEntry[] = [
      {
        skill: { name: "my-skill", description: "A skill" },
        frontmatter: {},
        metadata: {},
        invocation: {},
      },
    ];
    const specs = buildSkillCommandSpecs(entries);
    assert.strictEqual(specs.length, 1);
    assert.strictEqual(specs[0].name, "my_skill");
    assert.strictEqual(specs[0].skillName, "my-skill");
    assert.strictEqual(specs[0].description, "A skill");
  });

  it("excludes non-user-invocable skills", () => {
    const entries: SkillEntry[] = [
      {
        skill: { name: "internal", description: "Internal only" },
        frontmatter: {},
        metadata: {},
        invocation: { userInvocable: false },
      },
    ];
    const specs = buildSkillCommandSpecs(entries);
    assert.strictEqual(specs.length, 0);
  });

  it("avoids reserved names by appending suffix", () => {
    const entries: SkillEntry[] = [
      {
        skill: { name: "help", description: "Help skill" },
        frontmatter: {},
        metadata: {},
        invocation: {},
      },
    ];
    const specs = buildSkillCommandSpecs(entries, new Set(["help"]));
    assert.notStrictEqual(specs[0].name, "help");
    assert.ok(specs[0].name.startsWith("help"));
  });

  it("truncates long descriptions to 100 chars", () => {
    const longDesc = "A".repeat(200);
    const entries: SkillEntry[] = [
      {
        skill: { name: "long", description: longDesc },
        frontmatter: {},
        metadata: {},
        invocation: {},
      },
    ];
    const specs = buildSkillCommandSpecs(entries);
    assert.ok(specs[0].description.length <= 100);
  });

  it("handles duplicate skill names by adding numeric suffix", () => {
    const entries: SkillEntry[] = [
      {
        skill: { name: "dup", description: "First" },
        frontmatter: {},
        metadata: {},
        invocation: {},
      },
      {
        skill: { name: "dup", description: "Second" },
        frontmatter: {},
        metadata: {},
        invocation: {},
      },
    ];
    const specs = buildSkillCommandSpecs(entries);
    assert.strictEqual(specs.length, 2);
    assert.notStrictEqual(specs[0].name, specs[1].name);
  });

  it("parses dispatch configuration from frontmatter", () => {
    const entries: SkillEntry[] = [
      {
        skill: { name: "dispatched", description: "Has dispatch" },
        frontmatter: {
          "command-dispatch": "tool",
          "command-tool": "myTool",
        },
        metadata: {},
        invocation: {},
      },
    ];
    const specs = buildSkillCommandSpecs(entries);
    assert.ok(specs[0].dispatch);
    assert.strictEqual(specs[0].dispatch?.kind, "tool");
    assert.strictEqual(specs[0].dispatch?.toolName, "myTool");
    assert.strictEqual(specs[0].dispatch?.argMode, "raw");
  });

  it("returns no dispatch when command-dispatch is not 'tool'", () => {
    const entries: SkillEntry[] = [
      {
        skill: { name: "no-dispatch", description: "No dispatch" },
        frontmatter: {
          "command-dispatch": "other",
        },
        metadata: {},
        invocation: {},
      },
    ];
    const specs = buildSkillCommandSpecs(entries);
    assert.strictEqual(specs[0].dispatch, undefined);
  });
});
