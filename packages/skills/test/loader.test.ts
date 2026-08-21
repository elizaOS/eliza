/**
 * Unit tests for loadSkills, loadSkillsFromDir, and loadSkillEntries in packages/skills/src/loader.ts.
 * Tests loading valid skills, warning diagnostics for invalid metadata, and safe handling of
 * dangling symlinks and read errors.
 */
import assert from "node:assert";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { formatSkillsForPrompt } from "../src/formatter.js";
import {
  loadSkillEntries,
  loadSkills,
  loadSkillsFromDir,
} from "../src/loader.js";

function createTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("loadSkillsFromDir", () => {
  it("returns empty result for non-existent directory", () => {
    const result = loadSkillsFromDir({
      dir: "/non/existent/path/for/skills/test",
      source: "test",
    });
    assert.deepStrictEqual(result.skills, []);
    assert.deepStrictEqual(result.diagnostics, []);
  });

  it("loads valid skills from direct markdown files and SKILL.md subdirectories", () => {
    const tempDir = createTempDir("skill-loader-valid");
    try {
      // 1. Direct markdown file in root
      writeFileSync(
        join(tempDir, "root-skill.md"),
        `---
name: root-skill
description: Root markdown skill description
---
# Root Skill`,
      );

      // 2. Subdirectory with SKILL.md
      const subDir = join(tempDir, "sub-skill");
      mkdirSync(subDir, { recursive: true });
      writeFileSync(
        join(subDir, "SKILL.md"),
        `---
name: sub-skill
description: Subdirectory skill description
---
# Sub Skill`,
      );

      const result = loadSkillsFromDir({ dir: tempDir, source: "test" });
      assert.strictEqual(result.skills.length, 2);
      assert.strictEqual(result.diagnostics.length, 0);

      const rootSkill = result.skills.find((s) => s.name === "root-skill");
      assert.ok(rootSkill);
      assert.strictEqual(
        rootSkill.description,
        "Root markdown skill description",
      );

      const subSkill = result.skills.find((s) => s.name === "sub-skill");
      assert.ok(subSkill);
      assert.strictEqual(
        subSkill.description,
        "Subdirectory skill description",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("defaults flat markdown skill name to filename slug when name is omitted", () => {
    const tempDir = createTempDir("skill-loader-flat-slug");
    try {
      writeFileSync(
        join(tempDir, "auto-named-tool.md"),
        `---
description: Tool description without explicit name
---
# Content`,
      );

      const result = loadSkillsFromDir({ dir: tempDir, source: "test" });
      assert.strictEqual(result.skills.length, 1);
      assert.strictEqual(result.diagnostics.length, 0);
      assert.strictEqual(result.skills[0]?.name, "auto-named-tool");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("emits warning diagnostic when flat markdown skill name does not match filename slug", () => {
    const tempDir = createTempDir("skill-loader-mismatched-slug");
    try {
      writeFileSync(
        join(tempDir, "actual-filename.md"),
        `---
name: different-name
description: Mismatched skill name
---
# Content`,
      );

      const result = loadSkillsFromDir({ dir: tempDir, source: "test" });
      assert.strictEqual(result.skills.length, 1);
      const diag = result.diagnostics.find((d) =>
        d.message.includes(
          'name "different-name" does not match filename slug "actual-filename"',
        ),
      );
      assert.ok(diag);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("safely ignores dangling symlinks and emits warning diagnostic", () => {
    const tempDir = createTempDir("skill-loader-symlink");
    try {
      // Create a valid skill file
      writeFileSync(
        join(tempDir, "valid-skill.md"),
        `---
name: valid-skill
description: Valid skill description
---
# Valid Skill`,
      );

      // Create a dangling symlink pointing to a missing target
      const brokenTarget = join(tempDir, "non-existent-target.md");
      const brokenSymlink = join(tempDir, "dangling-link.md");
      let symlinksSupported = true;
      try {
        symlinkSync(brokenTarget, brokenSymlink);
      } catch {
        // error-policy:J3 symlink creation unsupported on this OS; skip the diagnostic assertion below
        symlinksSupported = false;
      }

      const result = loadSkillsFromDir({ dir: tempDir, source: "test" });
      const validSkill = result.skills.find((s) => s.name === "valid-skill");
      assert.ok(validSkill);

      // Verify that the dangling symlink produced a diagnostic without crashing
      if (symlinksSupported) {
        const symlinkDiag = result.diagnostics.find((d) =>
          d.message.includes("Dangling or inaccessible symlink"),
        );
        assert.ok(symlinkDiag);
      }
      assert.ok(result.skills.length >= 1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("emits warning diagnostics for missing or invalid metadata", () => {
    const tempDir = createTempDir("skill-loader-invalid");
    try {
      // Missing description
      writeFileSync(
        join(tempDir, "no-desc.md"),
        `---
name: no-desc
---
# No Desc`,
      );

      const result = loadSkillsFromDir({ dir: tempDir, source: "test" });
      assert.strictEqual(result.skills.length, 0);

      const descDiag = result.diagnostics.find((d) =>
        d.message.includes("description is required"),
      );
      assert.ok(descDiag);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports malformed YAML instead of a fabricated metadata error", () => {
    const tempDir = createTempDir("skill-loader-malformed-yaml");
    try {
      const filePath = join(tempDir, "malformed.md");
      writeFileSync(
        filePath,
        `---
invalid: : : yaml syntax error
---
# Malformed`,
      );

      const result = loadSkillsFromDir({ dir: tempDir, source: "test" });

      assert.deepStrictEqual(result.skills, []);
      assert.deepStrictEqual(result.diagnostics, [
        {
          type: "warning",
          message: "Skill frontmatter contains invalid YAML",
          path: filePath,
        },
      ]);
      assert.ok(
        !result.diagnostics.some((diagnostic) =>
          diagnostic.message.includes("description is required"),
        ),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("loadSkills and loadSkillEntries", () => {
  it("detects name collisions across skill sources", () => {
    const tempDir1 = createTempDir("skill-source-1");
    const tempDir2 = createTempDir("skill-source-2");

    try {
      writeFileSync(
        join(tempDir1, "dup-skill.md"),
        `---
name: dup-skill
description: First skill
---
# First`,
      );

      writeFileSync(
        join(tempDir2, "dup-skill.md"),
        `---
name: dup-skill
description: Second skill
---
# Second`,
      );

      const result = loadSkills({
        includeDefaults: false,
        skillPaths: [tempDir1, tempDir2],
      });

      assert.strictEqual(result.skills.length, 1);
      const collision = result.diagnostics.find((d) => d.type === "collision");
      assert.ok(collision);
      assert.strictEqual(collision.collision?.name, "dup-skill");
    } finally {
      rmSync(tempDir1, { recursive: true, force: true });
      rmSync(tempDir2, { recursive: true, force: true });
    }
  });

  it("loadSkills honors both kebab-case and snake_case disable-model-invocation", () => {
    // Regression for #22755: loader.ts read only the kebab key, so a skill
    // authored with snake_case `disable_model_invocation: true` was still
    // injected into the system prompt via loadSkills()/formatSkillsForPrompt(),
    // even though loadSkillEntries()/resolveSkillInvocationPolicy() hid it.
    for (const key of [
      "disable-model-invocation",
      "disable_model_invocation",
    ]) {
      const tempDir = createTempDir(`skill-disable-${key}`);
      try {
        const skillName = `hidden-${key.replace(/_/g, "-")}`;
        writeFileSync(
          join(tempDir, `${skillName}.md`),
          `---
name: ${skillName}
description: Should be hidden from the model
${key}: true
---
# body`,
        );

        const { skills } = loadSkills({
          includeDefaults: false,
          skillPaths: [tempDir],
        });
        assert.strictEqual(skills.length, 1);
        assert.strictEqual(
          skills[0]?.disableModelInvocation,
          true,
          `loadSkills must honor ${key}`,
        );

        const entries = loadSkillEntries({
          includeDefaults: false,
          skillPaths: [tempDir],
        });
        assert.strictEqual(entries.length, 1);
        assert.strictEqual(
          entries[0]?.invocation.disableModelInvocation,
          true,
          `loadSkillEntries must honor ${key}`,
        );

        const prompt = formatSkillsForPrompt(skills);
        assert.ok(
          !prompt.includes(skillName),
          `formatSkillsForPrompt must exclude a skill hidden via ${key}`,
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it("loadSkills keeps a skill visible when disable_model_invocation is false", () => {
    const tempDir = createTempDir("skill-disable-false");
    try {
      writeFileSync(
        join(tempDir, "visible-skill.md"),
        `---
name: visible-skill
description: Should remain visible to the model
disable_model_invocation: false
---
# body`,
      );

      const { skills } = loadSkills({
        includeDefaults: false,
        skillPaths: [tempDir],
      });
      assert.strictEqual(skills.length, 1);
      assert.strictEqual(skills[0]?.disableModelInvocation, false);

      const prompt = formatSkillsForPrompt(skills);
      assert.ok(prompt.includes("visible-skill"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("loadSkillEntries parses full metadata and invocation policy", () => {
    const tempDir = createTempDir("skill-entries");
    try {
      writeFileSync(
        join(tempDir, "policy-skill.md"),
        `---
name: policy-skill
description: Policy skill
primary-env: node
disable-model-invocation: true
---
# Content`,
      );

      const entries = loadSkillEntries({
        includeDefaults: false,
        skillPaths: [tempDir],
      });

      assert.strictEqual(entries.length, 1);
      const entry = entries[0];
      assert.strictEqual(entry.skill.name, "policy-skill");
      assert.strictEqual(entry.metadata.primaryEnv, "node");
      assert.strictEqual(entry.invocation.disableModelInvocation, true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
