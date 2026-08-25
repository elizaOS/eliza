/**
 * Tests for formatSkillsForPrompt: empty output for no skills, exclusion of
 * skills marked `disableModelInvocation`, the structured-text layout, and
 * punctuation preservation in name/description. Deterministic, no model.
 */
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

  it("preserves punctuation in name and description", () => {
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

  it("truncates descriptions without splitting UTF-16 surrogate pairs", () => {
    // 98 ascii characters followed by 🤖 (which is 2 UTF-16 code units, at indices 98 and 99)
    const descWithSurrogateAtBoundary = `${"a".repeat(98)}🤖extra`;
    const entries: SkillEntry[] = [
      {
        skill: { name: "emoji-desc", description: descWithSurrogateAtBoundary },
        frontmatter: {},
        metadata: {},
        invocation: {},
      },
    ];
    const specs = buildSkillCommandSpecs(entries);
    assert.strictEqual(specs[0].description, `${"a".repeat(98)}…`);
  });

  it("replaces pre-existing lone surrogates before building descriptions", () => {
    const entries: SkillEntry[] = [
      {
        skill: { name: "short", description: "before \uD83D after" },
        frontmatter: {},
        metadata: {},
        invocation: {},
      },
      {
        skill: {
          name: "boundary",
          description: `${"a".repeat(98)}\uD83Dextra`,
        },
        frontmatter: {},
        metadata: {},
        invocation: {},
      },
    ];
    const specs = buildSkillCommandSpecs(entries);
    assert.strictEqual(specs[0].description, "before � after");
    assert.strictEqual(specs[1].description, `${"a".repeat(98)}�…`);
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

  it("compacts multi-line whitespace and trims fields in formatted prompt", () => {
    const skills: Skill[] = [
      {
        name: "  multi   line  \n skill  ",
        description: "  A \n\t description  with   extra \r\n spaces  ",
        filePath: "  /path/to/\n  SKILL.md  ",
      },
    ];
    const result = formatSkillsForPrompt(skills);
    assert.ok(result.includes("- name: multi line skill"));
    assert.ok(result.includes("description: A description with extra spaces"));
    assert.ok(result.includes("location: /path/to/ SKILL.md"));
  });

  it("falls back to default command name when sanitized name is empty", () => {
    const entries: SkillEntry[] = [
      {
        skill: { name: "!!! @@@ ###", description: "Symbol-only name" },
        frontmatter: {},
        metadata: {},
        invocation: {},
      },
    ];
    const specs = buildSkillCommandSpecs(entries);
    assert.strictEqual(specs[0].name, "skill");
    assert.strictEqual(specs[0].skillName, "!!! @@@ ###");
  });

  it("strips duplicate and leading/trailing underscores from sanitized command names", () => {
    const entries: SkillEntry[] = [
      {
        skill: {
          name: "___MY---Awesome___Skill___",
          description: "Decorated name",
        },
        frontmatter: {},
        metadata: {},
        invocation: {},
      },
    ];
    const specs = buildSkillCommandSpecs(entries);
    assert.strictEqual(specs[0].name, "my_awesome_skill");
  });

  it("handles collisions on long names by truncating base to fit numeric suffix", () => {
    const longName = "a".repeat(35);
    const entries: SkillEntry[] = [
      {
        skill: { name: longName, description: "First long skill" },
        frontmatter: {},
        metadata: {},
        invocation: {},
      },
      {
        skill: { name: longName, description: "Second long skill" },
        frontmatter: {},
        metadata: {},
        invocation: {},
      },
    ];
    const specs = buildSkillCommandSpecs(entries);
    assert.strictEqual(specs.length, 2);
    assert.strictEqual(specs[0].name, "a".repeat(32));
    assert.strictEqual(specs[1].name, `${"a".repeat(30)}_1`);
    assert.strictEqual(specs[0].name.length, 32);
    assert.strictEqual(specs[1].name.length, 32);
  });

  it("treats reserved command names case-insensitively", () => {
    const entries: SkillEntry[] = [
      {
        skill: { name: "admin", description: "Admin skill" },
        frontmatter: {},
        metadata: {},
        invocation: {},
      },
    ];
    const specs = buildSkillCommandSpecs(entries, new Set(["ADMIN", "HeLp"]));
    assert.strictEqual(specs[0].name, "admin_1");
  });

  it("supports snake_case dispatch frontmatter aliases and case-insensitive dispatch values", () => {
    const entries: SkillEntry[] = [
      {
        skill: { name: "aliased", description: "Uses snake_case dispatch" },
        frontmatter: {
          command_dispatch: "TOOL",
          command_tool: "executeAction",
        },
        metadata: {},
        invocation: {},
      },
      {
        skill: { name: "empty-tool", description: "Tool is blank" },
        frontmatter: {
          command_dispatch: "tool",
          command_tool: "   ",
        },
        metadata: {},
        invocation: {},
      },
    ];
    const specs = buildSkillCommandSpecs(entries);
    assert.ok(specs[0].dispatch);
    assert.strictEqual(specs[0].dispatch?.kind, "tool");
    assert.strictEqual(specs[0].dispatch?.toolName, "executeAction");
    assert.strictEqual(specs[0].dispatch?.argMode, "raw");
    assert.strictEqual(specs[1].dispatch, undefined);
  });
});
