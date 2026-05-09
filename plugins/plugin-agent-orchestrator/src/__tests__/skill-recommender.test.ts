import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { recommendSkillsForTask } from "../services/skill-recommender.js";

interface FakeSkill {
  slug: string;
  name: string;
  description: string;
  tags?: string[];
}

function createRuntime(options: {
  skills: FakeSkill[];
  enabled?: Set<string>;
}): IAgentRuntime {
  const enabled =
    options.enabled ?? new Set(options.skills.map((skill) => skill.slug));
  const service = {
    getEligibleSkills: async () =>
      options.skills.map((skill) => ({
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        frontmatter: {
          metadata: {
            otto: {
              tags: skill.tags,
            },
          },
        },
      })),
    isSkillEnabled: (slug: string) => enabled.has(slug),
  };

  return {
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    getService: (name: string) =>
      name === "AGENT_SKILLS_SERVICE" ? service : undefined,
  } as IAgentRuntime;
}

const genericSkills: FakeSkill[] = [
  {
    slug: "github-issues",
    name: "GitHub Issues",
    description: "Read, create, and comment on GitHub issues.",
    tags: ["github"],
  },
  {
    slug: "playwright-runner",
    name: "Playwright Runner",
    description: "Run browser automation tests against a web app.",
    tags: ["browser", "tests"],
  },
];

const cloudAppSkill: FakeSkill = {
  slug: "build-monetized-app",
  name: "Build Monetized App",
  description:
    "Build Eliza Cloud apps with container deploys, OAuth, monetized inference, affiliate revenue, and custom domain offers.",
  tags: ["cloud", "container", "monetization", "domain"],
};

describe("recommendSkillsForTask", () => {
  it("forces the Cloud app-build skill for normal app prompts", async () => {
    const recommendations = await recommendSkillsForTask(
      createRuntime({ skills: [...genericSkills, cloudAppSkill] }),
      {
        taskText: "build me a simple wellness buddy chat app",
        max: 5,
        disableLlmPass: true,
      },
    );

    expect(recommendations[0]).toMatchObject({
      slug: "build-monetized-app",
      score: 1,
    });
  });

  it("does not force the Cloud app-build skill when it is disabled", async () => {
    const recommendations = await recommendSkillsForTask(
      createRuntime({
        skills: [...genericSkills, cloudAppSkill],
        enabled: new Set(genericSkills.map((skill) => skill.slug)),
      }),
      {
        taskText: "make me a dashboard app",
        max: 5,
        disableLlmPass: true,
      },
    );

    expect(
      recommendations.find((skill) => skill.slug === "build-monetized-app"),
    ).toBeUndefined();
  });

  it("does not force the Cloud app-build skill for writing tasks", async () => {
    const recommendations = await recommendSkillsForTask(
      createRuntime({ skills: [...genericSkills, cloudAppSkill] }),
      {
        taskText: "write a blog post about a chat app architecture",
        max: 5,
        disableLlmPass: true,
      },
    );

    expect(
      recommendations.find((skill) => skill.slug === "build-monetized-app"),
    ).toBeUndefined();
  });
});
