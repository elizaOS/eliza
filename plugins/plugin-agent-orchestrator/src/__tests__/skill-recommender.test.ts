/**
 * Verifies recommendSkillsForTask.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
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

const elizaCloudSkill: FakeSkill = {
  slug: "eliza-cloud",
  name: "Eliza Cloud",
  description:
    "Manage Eliza Cloud apps, auth, containers, app charges, x402 payments, affiliate earnings, redemptions, and payouts.",
  tags: ["cloud", "payments", "x402", "payouts"],
};

/** Run `fn` with ELIZA_FORCE_CLOUD_APP_SKILLS set to `value` (deleted when
 * undefined), restoring the previous process.env state afterwards. */
async function withForceCloudAppSkillsEnv(
  value: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = process.env.ELIZA_FORCE_CLOUD_APP_SKILLS;
  if (value === undefined) {
    delete process.env.ELIZA_FORCE_CLOUD_APP_SKILLS;
  } else {
    process.env.ELIZA_FORCE_CLOUD_APP_SKILLS = value;
  }
  try {
    await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.ELIZA_FORCE_CLOUD_APP_SKILLS;
    } else {
      process.env.ELIZA_FORCE_CLOUD_APP_SKILLS = previous;
    }
  }
}

describe("recommendSkillsForTask", () => {
  it("returns and model-scores every eligible skill without normalizing descriptions", async () => {
    const skills = Array.from({ length: 12 }, (_, index) => ({
      slug: `browser-skill-${index}`,
      name: `Browser Skill ${index}`,
      description:
        index === 11
          ? "  Browser automation\n\nwith exact spacing.  "
          : `Browser automation capability ${index}.`,
    }));
    let capturedPrompt = "";
    const runtime = createRuntime({ skills }) as IAgentRuntime & {
      useModel: (model: unknown, params: { prompt: string }) => Promise<string>;
    };
    runtime.useModel = async (_model, params) => {
      capturedPrompt = params.prompt;
      return JSON.stringify({
        scores: [{ slug: skills[0].slug, score: 0.8, reason: "relevant" }],
      });
    };

    const recommendations = await recommendSkillsForTask(runtime, {
      taskText: "automate browser testing",
      max: 1,
    });

    expect(recommendations).toHaveLength(skills.length);
    expect(recommendations.map((skill) => skill.slug)).toEqual(
      expect.arrayContaining(skills.map((skill) => skill.slug)),
    );
    expect(capturedPrompt).toContain(JSON.stringify(skills[11].description));
    expect(capturedPrompt).toContain(`"slug":"${skills[11].slug}"`);
  });

  it("forces paired Cloud build and backend skills for app prompts when explicitly enabled", async () => {
    await withForceCloudAppSkillsEnv("1", async () => {
      const recommendations = await recommendSkillsForTask(
        createRuntime({
          skills: [...genericSkills, cloudAppSkill, elizaCloudSkill],
        }),
        {
          taskText: "build me a simple wellness buddy chat app",
          max: 5,
          disableLlmPass: true,
        },
      );

      expect(recommendations.slice(0, 2).map((skill) => skill.slug)).toEqual([
        "build-monetized-app",
        "eliza-cloud",
      ]);
      expect(recommendations[0]?.score).toBe(1);
      expect(recommendations[1]?.score).toBe(1);
    });
  });

  it("does not force Cloud skills for app prompts by default", async () => {
    await withForceCloudAppSkillsEnv(undefined, async () => {
      const recommendations = await recommendSkillsForTask(
        createRuntime({
          skills: [...genericSkills, cloudAppSkill, elizaCloudSkill],
        }),
        {
          taskText: "build me a simple wellness buddy chat app",
          max: 5,
          disableLlmPass: true,
        },
      );

      // Without the explicit opt-in the keyword ranking wins: no skill gets
      // the forced score-1 promotion to the head of the list.
      expect(
        recommendations.find(
          (skill) =>
            (skill.slug === "build-monetized-app" ||
              skill.slug === "eliza-cloud") &&
            skill.score === 1,
        ),
      ).toBeUndefined();
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
    ).toMatchObject({ score: 0 });
  });
});
