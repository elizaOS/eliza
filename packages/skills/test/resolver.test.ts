/**
 * Tests for getSkillsDir: it returns an existing on-disk path, caches the
 * result, and honors the `ELIZAOS_BUNDLED_SKILLS_DIR` override (ignoring an
 * empty value). Touches the real filesystem, no model.
 */
import assert from "node:assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  clearSkillsDirCache,
  getCuratedActiveDir,
  getProposedSkillsDir,
  getSkillsDir,
  promoteSkill,
} from "../src/resolver.js";

function makeSkillDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "test.md"),
    "---\nname: test\ndescription: test\n---\n# Test skill",
  );
  return dir;
}

describe("getSkillsDir", () => {
  afterEach(() => {
    clearSkillsDirCache();
    delete process.env.ELIZAOS_BUNDLED_SKILLS_DIR;
  });

  it("returns a non-empty string path", () => {
    const dir = getSkillsDir();
    assert.ok(typeof dir === "string");
    assert.ok(dir.length > 0);
  });

  it("returns a path that exists on disk", () => {
    const dir = getSkillsDir();
    assert.ok(existsSync(dir), `Skills dir should exist: ${dir}`);
  });

  it("returns consistent path (caching works)", () => {
    const first = getSkillsDir();
    const second = getSkillsDir();
    assert.strictEqual(first, second);
  });

  it("respects ELIZAOS_BUNDLED_SKILLS_DIR environment variable", () => {
    const tempDir = makeSkillDir("test-skills-resolver");

    clearSkillsDirCache();
    process.env.ELIZAOS_BUNDLED_SKILLS_DIR = tempDir;

    const result = getSkillsDir();
    assert.strictEqual(result, tempDir);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("ignores empty environment variable", () => {
    clearSkillsDirCache();
    process.env.ELIZAOS_BUNDLED_SKILLS_DIR = "";

    const dir = getSkillsDir();
    assert.ok(typeof dir === "string");
    assert.ok(dir.length > 0);
  });
});

describe("clearSkillsDirCache", () => {
  afterEach(() => {
    clearSkillsDirCache();
    delete process.env.ELIZAOS_BUNDLED_SKILLS_DIR;
  });

  it("clears cache and re-resolves path", () => {
    const first = getSkillsDir();
    clearSkillsDirCache();
    const second = getSkillsDir();
    assert.strictEqual(first, second);
  });

  it("picks up environment variable changes after clearing cache", () => {
    const defaultDir = getSkillsDir();
    const tempDir = makeSkillDir("test-skills-cache");

    clearSkillsDirCache();
    process.env.ELIZAOS_BUNDLED_SKILLS_DIR = tempDir;

    const overriddenDir = getSkillsDir();
    assert.strictEqual(overriddenDir, tempDir);
    assert.notStrictEqual(overriddenDir, defaultDir);

    rmSync(tempDir, { recursive: true, force: true });
  });
});

describe("getCuratedActiveDir and getProposedSkillsDir", () => {
  const originalStateDir = process.env.ELIZA_STATE_DIR;

  afterEach(() => {
    if (originalStateDir !== undefined) {
      process.env.ELIZA_STATE_DIR = originalStateDir;
    } else {
      delete process.env.ELIZA_STATE_DIR;
    }
  });

  it("resolves curated active and proposed directories relative to state dir", () => {
    const tempDir = join(tmpdir(), `test-curated-dirs-${Date.now()}`);
    process.env.ELIZA_STATE_DIR = tempDir;

    const activeDir = getCuratedActiveDir();
    const proposedDir = getProposedSkillsDir();

    assert.strictEqual(activeDir, join(tempDir, "skills", "curated", "active"));
    assert.strictEqual(
      proposedDir,
      join(tempDir, "skills", "curated", "proposed"),
    );
  });
});

describe("promoteSkill", () => {
  const originalStateDir = process.env.ELIZA_STATE_DIR;
  let tempStateDir: string;

  beforeEach(() => {
    tempStateDir = join(tmpdir(), `test-skills-promote-${Date.now()}`);
    process.env.ELIZA_STATE_DIR = tempStateDir;
  });

  afterEach(() => {
    if (tempStateDir && existsSync(tempStateDir)) {
      rmSync(tempStateDir, { recursive: true, force: true });
    }
    if (originalStateDir !== undefined) {
      process.env.ELIZA_STATE_DIR = originalStateDir;
    } else {
      delete process.env.ELIZA_STATE_DIR;
    }
  });

  it("rejects invalid skill names", () => {
    assert.throws(
      () => promoteSkill("Invalid_Name"),
      /Invalid skill name "Invalid_Name"/,
    );
    assert.throws(() => promoteSkill("skill!"), /Invalid skill name "skill!"/);
    assert.throws(
      () => promoteSkill("CamelCaseSkill"),
      /Invalid skill name "CamelCaseSkill"/,
    );
  });

  it("throws when proposed skill directory does not exist", () => {
    assert.throws(
      () => promoteSkill("nonexistent-skill"),
      /Proposed skill "nonexistent-skill" not found/,
    );
  });

  it("atomically promotes a proposed skill to active", () => {
    const skillName = "test-skill-promo";
    const proposedDir = join(getProposedSkillsDir(), skillName);
    mkdirSync(proposedDir, { recursive: true });
    writeFileSync(
      join(proposedDir, "SKILL.md"),
      "---\nname: test-skill-promo\ndescription: A test skill\n---\n# Test",
    );

    assert.strictEqual(existsSync(proposedDir), true);

    const activeDir = promoteSkill(skillName);

    assert.strictEqual(existsSync(proposedDir), false);
    assert.strictEqual(existsSync(activeDir), true);
    assert.strictEqual(activeDir, join(getCuratedActiveDir(), skillName));
    assert.strictEqual(existsSync(join(activeDir, "SKILL.md")), true);
  });

  it("throws when active skill already exists", () => {
    const skillName = "duplicate-skill";
    const proposedDir = join(getProposedSkillsDir(), skillName);
    const activeDir = join(getCuratedActiveDir(), skillName);

    mkdirSync(proposedDir, { recursive: true });
    mkdirSync(activeDir, { recursive: true });

    writeFileSync(join(proposedDir, "SKILL.md"), "proposed");
    writeFileSync(join(activeDir, "SKILL.md"), "active");

    assert.throws(
      () => promoteSkill(skillName),
      /Active skill "duplicate-skill" already exists/,
    );
  });
});
