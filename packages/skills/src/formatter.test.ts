/**
 * Unit tests for prompt formatting of skills and command spec generation.
 */

import { describe, expect, it } from "vitest";
import {
  buildSkillCommandSpecs,
  formatSkillEntriesForPrompt,
  formatSkillSummary,
  formatSkillsForPrompt,
  formatSkillsList,
} from "./formatter.js";
import type { Skill, SkillEntry } from "./types.js";

describe("skills formatter", () => {
  const sampleSkill1: Skill = {
    name: "fetch-web",
    description: "Fetches url content",
    filePath: "/skills/fetch-web/SKILL.md",
  };

  const sampleSkill2: Skill = {
    name: "internal-skill",
    description: "Internal tasks only",
    disableModelInvocation: true,
  };

  it("formats visible skills for system prompt and excludes disabled ones", () => {
    const formatted = formatSkillsForPrompt([sampleSkill1, sampleSkill2]);

    expect(formatted).toContain("available_skills:");
    expect(formatted).toContain("- name: fetch-web");
    expect(formatted).toContain("description: Fetches url content");
    expect(formatted).toContain("location: /skills/fetch-web/SKILL.md");
    expect(formatted).not.toContain("internal-skill");
  });

  it("returns empty string when no skills are visible to model", () => {
    expect(formatSkillsForPrompt([])).toBe("");
    expect(formatSkillsForPrompt([sampleSkill2])).toBe("");
  });

  it("formats SkillEntry items through formatSkillEntriesForPrompt", () => {
    const entries: SkillEntry[] = [
      {
        skill: sampleSkill1,
        frontmatter: {},
        invocation: {},
      },
      {
        skill: { name: "disabled-entry", description: "Disabled" },
        frontmatter: {},
        invocation: { disableModelInvocation: true },
      },
    ];

    const formatted = formatSkillEntriesForPrompt(entries);
    expect(formatted).toContain("- name: fetch-web");
    expect(formatted).not.toContain("disabled-entry");
  });

  it("builds sanitized and deduplicated skill command specifications", () => {
    const entries: SkillEntry[] = [
      {
        skill: { name: "Web Search!", description: "Search the web" },
        frontmatter: {},
      },
      {
        skill: { name: "web_search", description: "Duplicate command name" },
        frontmatter: {},
      },
      {
        skill: { name: "Non Invocable", description: "Hidden" },
        frontmatter: {},
        invocation: { userInvocable: false },
      },
    ];

    const specs = buildSkillCommandSpecs(entries, new Set(["help"]));

    expect(specs).toHaveLength(2);
    expect(specs[0].name).toBe("web_search");
    expect(specs[0].skillName).toBe("Web Search!");
    expect(specs[1].name).toBe("web_search_1");
  });

  it("formats summary and skill list representations", () => {
    expect(formatSkillSummary(sampleSkill1)).toBe(
      "fetch-web: Fetches url content",
    );

    const list = formatSkillsList([sampleSkill1]);
    expect(list).toBe("fetch-web: Fetches url content");
  });
});
