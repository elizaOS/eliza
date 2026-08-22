/**
 * Verifies dynamic skill retrieval uses the current turn rather than allowing
 * an unrelated prior topic to keep injecting its instructions.
 */
import { describe, expect, it } from "vitest";
import {
  createDynamicSkillProvider,
  normalizeDescription,
} from "./skill-provider.ts";

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const skills = [
  {
    slug: "eliza-cloud",
    name: "Eliza Cloud",
    description: "Use when deploying an app to the Eliza Cloud backend.",
  },
  {
    slug: "personal-notes",
    name: "Personal Notes",
    description: "Use for creating and organizing personal notes.",
  },
];

function runtime() {
  return {
    getService: () => ({
      getLoadedSkills: () => skills,
      getSkillInstructions: (slug: string) => ({
        slug,
        body: `Instructions for ${slug}`,
        estimatedTokens: 4,
      }),
    }),
  };
}

describe("dynamic skill current-turn relevance", () => {
  it("does not activate a skill from stale recent messages", async () => {
    const provider = createDynamicSkillProvider();
    const result = await provider.get(
      runtime() as never,
      { content: { text: "go home" } } as never,
      {
        data: {
          providers: {
            RECENT_MESSAGES: {
              data: {
                recentMessages: [
                  { content: { text: "deploy my app to eliza cloud" } },
                ],
              },
            },
          },
        },
      } as never,
    );

    expect(result.data?.matchedSkills).toEqual([]);
    expect(result.text).not.toContain("Active Skill");
    expect(result.text).not.toContain("eliza-cloud");
  });

  it("still activates a skill explicitly named in the current turn", async () => {
    const provider = createDynamicSkillProvider();
    const result = await provider.get(
      runtime() as never,
      { content: { text: "deploy this with eliza-cloud" } } as never,
      {} as never,
    );

    expect(result.values?.activeSkill).toBe("eliza-cloud");
    expect(result.text).toContain("## Active Skill: Eliza Cloud");
  });
});

describe("normalizeDescription Unicode handling", () => {
  it("keeps a complete description beyond the former boundary", () => {
    const text = `${"a".repeat(76)}🦊${"b".repeat(50)}`;
    const out = normalizeDescription(text);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(text);
  });

  it("preserves fitting emoji under limit", () => {
    const text = `${"a".repeat(70)}🦊`;
    const out = normalizeDescription(text);
    expect(out).toBe(text);
    expect(isWellFormed(out)).toBe(true);
  });

  it("sanitizes lone surrogates without shortening", () => {
    const lone = `a\uD800${"b".repeat(100)}`;
    const out = normalizeDescription(lone);
    expect(out).toContain("�");
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(lone.length);
  });
});

describe("createDynamicSkillProvider instructions well-formed Unicode", () => {
  it("keeps complete active skill instructions", async () => {
    const longBody = `${"a".repeat(1999)}🦊${"b".repeat(50)}`;
    const customRuntime = {
      getService: () => ({
        getLoadedSkills: () => [
          {
            slug: "test-skill",
            name: "Test Skill",
            description: "A test skill with long instructions",
          },
        ],
        getSkillInstructions: () => ({
          slug: "test-skill",
          body: longBody,
          estimatedTokens: 500,
        }),
      }),
    };

    const provider = createDynamicSkillProvider();
    const result = await provider.get(
      customRuntime as never,
      { content: { text: "test-skill instructions" } } as never,
      {} as never,
    );

    if (typeof result.text !== "string") {
      throw new Error("expected provider result text to be a string");
    }
    expect(isWellFormed(result.text)).toBe(true);
    expect(result.text).toContain(longBody);
  });
});
