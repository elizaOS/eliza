import assert from "node:assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { clearSkillsDirCache, getSkillsDir } from "../src/resolver.js";

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
