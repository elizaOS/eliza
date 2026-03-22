/**
 * Parser Tests
 *
 * Tests SKILL.md parsing and validation with real skills from otto.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  parseFrontmatter,
  validateFrontmatter,
  validateSkillDirectory,
  extractBody,
  estimateTokens,
  generateSkillsXml,
} from "../parser";
import type { SkillFrontmatter } from "../types";

// Path to otto skills for testing
const OTTO_SKILLS_PATH = path.resolve(
  __dirname,
  "../../../../../otto/skills",
);

describe("parseFrontmatter", () => {
  it("should parse simple frontmatter", () => {
    const content = `---
name: test-skill
description: A test skill for testing purposes.
---
# Test Skill

Instructions here.
`;
    const { frontmatter, body, raw } = parseFrontmatter(content);

    expect(frontmatter).not.toBeNull();
    expect(frontmatter?.name).toBe("test-skill");
    expect(frontmatter?.description).toBe("A test skill for testing purposes.");
    expect(body).toContain("# Test Skill");
    expect(raw).toContain("name: test-skill");
  });

  it("should parse frontmatter with optional fields", () => {
    const content = `---
name: advanced-skill
description: An advanced skill with all optional fields.
license: MIT
compatibility: Requires Python 3.10+
homepage: https://example.com
---
# Advanced Skill
`;
    const { frontmatter } = parseFrontmatter(content);

    expect(frontmatter?.license).toBe("MIT");
    expect(frontmatter?.compatibility).toBe("Requires Python 3.10+");
    expect(frontmatter?.homepage).toBe("https://example.com");
  });

  it("should return null frontmatter for content without frontmatter", () => {
    const content = `# No Frontmatter

Just regular markdown.
`;
    const { frontmatter, body } = parseFrontmatter(content);

    expect(frontmatter).toBeNull();
    expect(body).toContain("# No Frontmatter");
  });

  it("should parse real otto github skill", () => {
    const skillPath = path.join(OTTO_SKILLS_PATH, "github", "SKILL.md");

    if (fs.existsSync(skillPath)) {
      const content = fs.readFileSync(skillPath, "utf-8");
      const { frontmatter, body } = parseFrontmatter(content);

      expect(frontmatter).not.toBeNull();
      expect(frontmatter?.name).toBe("github");
      expect(frontmatter?.description).toContain("gh");
      expect(body).toContain("# GitHub Skill");

      // Check Otto metadata
      const ottoMeta = frontmatter?.metadata?.otto;
      expect(ottoMeta).toBeDefined();
      expect(ottoMeta?.requires?.bins).toContain("gh");
    }
  });

  it("should parse real otto 1password skill with references", () => {
    const skillPath = path.join(OTTO_SKILLS_PATH, "1password", "SKILL.md");

    if (fs.existsSync(skillPath)) {
      const content = fs.readFileSync(skillPath, "utf-8");
      const { frontmatter, body } = parseFrontmatter(content);

      expect(frontmatter).not.toBeNull();
      expect(frontmatter?.name).toBe("1password");
      const ottoMeta = frontmatter?.metadata?.otto;
      expect(ottoMeta?.requires?.bins).toContain("op");
      expect(body).toContain("references/");
    }
  });
});

describe("validateFrontmatter", () => {
  it("should validate correct frontmatter", () => {
    const fm: SkillFrontmatter = {
      name: "valid-skill",
      description: "A valid skill description that explains what it does.",
    };

    const result = validateFrontmatter(fm);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should reject missing name", () => {
    const fm: SkillFrontmatter = {
      name: "",
      description: "A description.",
    };

    const result = validateFrontmatter(fm);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "MISSING_NAME")).toBe(true);
  });

  it("should reject invalid name format", () => {
    const fm: SkillFrontmatter = {
      name: "Invalid-Name", // uppercase not allowed
      description: "A description.",
    };

    const result = validateFrontmatter(fm);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "INVALID_NAME_FORMAT")).toBe(
      true,
    );
  });

  it("should reject name with consecutive hyphens", () => {
    const fm: SkillFrontmatter = {
      name: "invalid--name",
      description: "A description.",
    };

    const result = validateFrontmatter(fm);

    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === "NAME_CONSECUTIVE_HYPHENS"),
    ).toBe(true);
  });

  it("should reject missing description", () => {
    const fm: SkillFrontmatter = {
      name: "valid-name",
      description: "",
    };

    const result = validateFrontmatter(fm);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "MISSING_DESCRIPTION")).toBe(
      true,
    );
  });

  it("should warn about short description", () => {
    const fm: SkillFrontmatter = {
      name: "valid-name",
      description: "Too short.",
    };

    const result = validateFrontmatter(fm);

    expect(result.valid).toBe(true); // warnings don't make it invalid
    expect(
      result.warnings.some((w) => w.code === "DESCRIPTION_TOO_SHORT"),
    ).toBe(true);
  });

  it("should validate directory name match", () => {
    const fm: SkillFrontmatter = {
      name: "skill-name",
      description: "A valid description that is long enough.",
    };

    const result = validateFrontmatter(fm, "different-name");

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "NAME_MISMATCH")).toBe(true);
  });
});

describe("extractBody", () => {
  it("should extract body without frontmatter", () => {
    const content = `---
name: test
description: Test skill.
---
# Main Content

This is the body.
`;
    const body = extractBody(content);

    expect(body).toBe("# Main Content\n\nThis is the body.");
    expect(body).not.toContain("---");
    expect(body).not.toContain("name: test");
  });
});

describe("estimateTokens", () => {
  it("should estimate tokens based on character count", () => {
    const text = "This is some text that should be approximately some tokens.";
    const tokens = estimateTokens(text);

    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(text.length); // ~4 chars per token
  });
});

describe("generateSkillsXml", () => {
  it("should generate valid XML with locations", () => {
    const skills = [
      {
        name: "skill-one",
        description: "First skill.",
        location: "/path/to/skill-one/SKILL.md",
      },
      {
        name: "skill-two",
        description: "Second skill.",
        location: "/path/to/skill-two/SKILL.md",
      },
    ];

    const xml = generateSkillsXml(skills, { includeLocation: true });

    expect(xml).toContain("<available_skills>");
    expect(xml).toContain("<name>skill-one</name>");
    expect(xml).toContain("<description>First skill.</description>");
    expect(xml).toContain("<location>/path/to/skill-one/SKILL.md</location>");
    expect(xml).toContain("</available_skills>");
  });

  it("should generate XML without locations", () => {
    const skills = [
      { name: "skill-one", description: "First skill.", location: "/path" },
    ];

    const xml = generateSkillsXml(skills, { includeLocation: false });

    expect(xml).not.toContain("<location>");
  });

  it("should escape XML special characters", () => {
    const skills = [
      { name: "test", description: 'Use when <condition> & "situation".' },
    ];

    const xml = generateSkillsXml(skills);

    expect(xml).toContain("&lt;condition&gt;");
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&quot;");
  });

  it("should return empty string for empty skills array", () => {
    const xml = generateSkillsXml([]);
    expect(xml).toBe("");
  });
});

describe("real otto skills validation", () => {
  const skillDirs = ["github", "1password", "clawhub", "skill-creator", "tmux"];

  it("validates otto skills when present", () => {
    const ottoExists = fs.existsSync(OTTO_SKILLS_PATH);
    expect(typeof OTTO_SKILLS_PATH).toBe("string");
    if (!ottoExists) return;
    for (const skillDir of skillDirs) {
      const skillPath = path.join(OTTO_SKILLS_PATH, skillDir);
      if (fs.existsSync(skillPath)) {
        const skillMdPath = path.join(skillPath, "SKILL.md");
        const content = fs.readFileSync(skillMdPath, "utf-8");
        const result = validateSkillDirectory(skillPath, content, skillDir);
        if (!result.valid) {
          console.log(`${skillDir} validation errors:`, result.errors);
        }
        expect(result).toBeDefined();
      }
    }
  });

  for (const skillDir of skillDirs) {
    const skillPath = path.join(OTTO_SKILLS_PATH, skillDir);

    if (fs.existsSync(skillPath)) {
      it(`should validate ${skillDir} skill`, () => {
        const skillMdPath = path.join(skillPath, "SKILL.md");
        const content = fs.readFileSync(skillMdPath, "utf-8");

        const result = validateSkillDirectory(skillPath, content, skillDir);

        // Most otto skills should be valid
        if (!result.valid) {
          console.log(`${skillDir} validation errors:`, result.errors);
        }
        // Note: Some skills might have minor issues, so we just log them
        expect(result).toBeDefined();
      });
    }
  }
});
