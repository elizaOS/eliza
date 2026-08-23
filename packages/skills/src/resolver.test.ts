/**
 * Unit tests for skills directory path resolution, caching, and atomic skill promotion.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearSkillsDirCache,
  getCuratedActiveDir,
  getProposedSkillsDir,
  getSkillsDir,
  promoteSkill,
} from "./resolver.js";

describe("skills resolver", () => {
  const originalEnv = process.env.ELIZAOS_BUNDLED_SKILLS_DIR;
  let testTempDir: string;

  beforeEach(() => {
    clearSkillsDirCache();
    testTempDir = join(
      tmpdir(),
      `test-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testTempDir, { recursive: true });
  });

  afterEach(() => {
    clearSkillsDirCache();
    if (originalEnv !== undefined) {
      process.env.ELIZAOS_BUNDLED_SKILLS_DIR = originalEnv;
    } else {
      delete process.env.ELIZAOS_BUNDLED_SKILLS_DIR;
    }
    rmSync(testTempDir, { recursive: true, force: true });
  });

  it("resolves bundled skills directory via environment override", () => {
    process.env.ELIZAOS_BUNDLED_SKILLS_DIR = testTempDir;
    const resolved = getSkillsDir();
    expect(resolved).toBe(testTempDir);
  });

  it("resolves curated active and proposed directories", () => {
    const activeDir = getCuratedActiveDir();
    const proposedDir = getProposedSkillsDir();

    expect(activeDir).toContain("skills");
    expect(activeDir.endsWith("active")).toBe(true);
    expect(proposedDir.endsWith("proposed")).toBe(true);
  });

  it("validates skill name and rejects invalid characters in promoteSkill", () => {
    expect(() => promoteSkill("Invalid_Skill_Name")).toThrow(
      /Invalid skill name/,
    );
    expect(() => promoteSkill("skill/with/slashes")).toThrow(
      /Invalid skill name/,
    );
  });

  it("throws when promoting nonexistent proposed skill", () => {
    expect(() => promoteSkill("nonexistent-skill")).toThrow(/not found/);
  });
});
