/**
 * Verifies dynamic skill retrieval uses the current turn rather than allowing
 * an unrelated prior topic to keep injecting its instructions.
 */
import { describe, expect, it } from "vitest";
import { createDynamicSkillProvider } from "./skill-provider.ts";

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
