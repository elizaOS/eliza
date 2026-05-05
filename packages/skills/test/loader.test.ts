import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, mock } from "bun:test";

mock.module("@elizaos/core", () => ({
  resolveStateDir: () => join(tmpdir(), "eliza-state"),
}));

const { loadSkill, validateDescription, validateName } = await import(
  "../src/loader.js"
);

function withTempSkill<T>(
  name: string,
  content: string,
  callback: (skillFile: string) => T,
): T {
  const root = mkdtempSync(join(tmpdir(), "skills-loader-"));
  try {
    const skillDir = join(root, name);
    mkdirSync(skillDir, { recursive: true });
    const skillFile = join(skillDir, "SKILL.md");
    writeFileSync(skillFile, content);
    return callback(skillFile);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("validateName", () => {
  it("accepts a valid matching name", () => {
    assert.deepStrictEqual(validateName("valid-skill", "valid-skill"), []);
  });

  it("requires a non-empty name", () => {
    assert.deepStrictEqual(validateName("", "valid-skill"), [
      "name is required",
    ]);
  });

  it("rejects unicode names", () => {
    assert.deepStrictEqual(validateName("skill-é", "skill-é"), [
      "name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)",
    ]);
  });
});

describe("validateDescription", () => {
  it("rejects whitespace-only descriptions", () => {
    assert.deepStrictEqual(validateDescription("   \t\n"), [
      "description is required",
    ]);
  });

  it("accepts descriptions at the 1024 character limit", () => {
    assert.deepStrictEqual(validateDescription("a".repeat(1024)), []);
  });

  it("rejects descriptions over the 1024 character limit", () => {
    assert.deepStrictEqual(validateDescription("a".repeat(1025)), [
      "description exceeds 1024 characters (1025)",
    ]);
  });
});

describe("loadSkill", () => {
  it("loads a valid SKILL.md with parsed frontmatter and body", () => {
    const content = `---
name: valid-skill
description: Loads a valid skill file
disable-model-invocation: true
---
# Valid Skill

Body content here.
`;

    withTempSkill("valid-skill", content, (skillFile) => {
      const result = loadSkill(skillFile, "test");

      assert.deepStrictEqual(result.diagnostics, []);
      assert.strictEqual(result.frontmatter.name, "valid-skill");
      assert.strictEqual(
        result.frontmatter.description,
        "Loads a valid skill file",
      );
      assert.strictEqual(result.frontmatter["disable-model-invocation"], true);
      assert.strictEqual(result.body, "# Valid Skill\n\nBody content here.");
      assert.strictEqual(result.skill?.name, "valid-skill");
      assert.strictEqual(result.skill?.description, "Loads a valid skill file");
      assert.strictEqual(result.skill?.filePath, skillFile);
      assert.strictEqual(result.skill?.baseDir, dirname(skillFile));
      assert.strictEqual(result.skill?.source, "test");
      assert.strictEqual(result.skill?.disableModelInvocation, true);
    });
  });
});
