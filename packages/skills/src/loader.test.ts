/**
 * Unit tests for discovering, loading, and validating skills from directories and filepaths.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkillEntries, loadSkills, loadSkillsFromDir } from "./loader.js";

describe("skills loader", () => {
  let testTempDir: string;

  beforeEach(() => {
    testTempDir = join(
      tmpdir(),
      `test-skills-loader-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testTempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testTempDir, { recursive: true, force: true });
  });

  it("loads valid skill markdown file from directory", () => {
    const skillContent = `---
name: sample-skill
description: A sample skill for testing
---
# Sample Skill
Instructions here.
`;
    writeFileSync(join(testTempDir, "sample-skill.md"), skillContent, "utf-8");

    const result = loadSkillsFromDir({ dir: testTempDir, source: "test" });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("sample-skill");
    expect(result.skills[0].description).toBe("A sample skill for testing");
    expect(result.skills[0].source).toBe("test");
  });

  it("loads nested skill directory with SKILL.md", () => {
    const skillSubdir = join(testTempDir, "calculator");
    mkdirSync(skillSubdir, { recursive: true });

    const skillContent = `---
name: calculator
description: Math tools and calculator
---
# Calculator Skill
`;
    writeFileSync(join(skillSubdir, "SKILL.md"), skillContent, "utf-8");

    const result = loadSkillsFromDir({ dir: testTempDir, source: "nested" });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("calculator");
    expect(result.skills[0].description).toBe("Math tools and calculator");
  });

  it("loads skill entries with metadata parsing", () => {
    const skillContent = `---
name: weather-forecast
description: Provides weather forecasts
metadata:
  version: 1.0.0
---
# Weather Forecast
`;
    writeFileSync(
      join(testTempDir, "weather-forecast.md"),
      skillContent,
      "utf-8",
    );

    const entries = loadSkillEntries({
      skillPaths: [join(testTempDir, "weather-forecast.md")],
      includeDefaults: false,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].skill.name).toBe("weather-forecast");
    expect(entries[0].frontmatter.description).toBe(
      "Provides weather forecasts",
    );
  });

  it("emits diagnostic warning for missing skill paths", () => {
    const result = loadSkills({
      skillPaths: [join(testTempDir, "nonexistent-skill.md")],
      includeDefaults: false,
    });

    expect(result.skills).toHaveLength(0);
    expect(
      result.diagnostics.some((d) => d.message.includes("does not exist")),
    ).toBe(true);
  });
});
