/**
 * Tests for the skill recommender.
 *
 * Covers the keyword fast path, the LLM scoring pass, deduplication, and
 * the `max` cap. We use a fake runtime + fake AGENT_SKILLS_SERVICE — no
 * network, no PTY, no SQL.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  LIFEOPS_CONTEXT_BROKER_SLUG,
  shouldRecommendLifeOpsContextBroker,
  withLifeOpsContextBrokerRecommendation,
} from "../services/skill-lifeops-context-broker.js";
import { recommendSkillsForTask } from "../services/skill-recommender.js";

interface FakeSkill {
  slug: string;
  name: string;
  description: string;
  category?: string;
  tags?: string[];
}

interface RuntimeOpts {
  skills: FakeSkill[];
  enabledSet?: Set<string>;
  useModel?: (typeArg: unknown, opts: unknown) => Promise<string>;
}

function createRuntime(opts: RuntimeOpts): IAgentRuntime {
  const enabled = opts.enabledSet ?? new Set(opts.skills.map((s) => s.slug));
  const service = {
    getEligibleSkills: async () =>
      opts.skills.map((skill) => ({
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        frontmatter: {
          metadata: {
            otto: {
              category: skill.category,
              tags: skill.tags,
            },
          },
        },
      })),
    isSkillEnabled: (slug: string) => enabled.has(slug),
  };
  const runtime: Record<string, unknown> = {
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    getService: (name: string) =>
      name === "AGENT_SKILLS_SERVICE" ? service : null,
  };
  if (opts.useModel) {
    runtime.useModel = opts.useModel;
  }
  return runtime as unknown as IAgentRuntime;
}

const SAMPLE_SKILLS: FakeSkill[] = [
  {
    slug: "github-issues",
    name: "GitHub Issues",
    description:
      "Read, create, and comment on github issues across repositories.",
    tags: ["github", "vcs"],
  },
  {
    slug: "pdf-tools",
    name: "PDF Tools",
    description: "Extract text, rotate, and split pdf documents.",
    tags: ["pdf", "documents"],
  },
  {
    slug: "weather-lookup",
    name: "Weather Lookup",
    description: "Fetch the current weather forecast for a location.",
    tags: ["weather"],
  },
  {
    slug: "playwright-runner",
    name: "Playwright Runner",
    description: "Run playwright browser automation tests against a webapp.",
    tags: ["playwright", "browser", "tests"],
  },
];

describe("recommendSkillsForTask — keyword fast path", () => {
  it("returns skills whose descriptions/tags overlap the task tokens", async () => {
    const runtime = createRuntime({ skills: SAMPLE_SKILLS });

    const recommendations = await recommendSkillsForTask(runtime, {
      taskText: "Look at the github issues for the auth bug and triage them.",
      max: 5,
      disableLlmPass: true,
    });

    expect(recommendations.length).toBeGreaterThan(0);
    expect(recommendations[0]?.slug).toBe("github-issues");
    expect(recommendations[0]?.score).toBeGreaterThan(0);
    expect(recommendations[0]?.reason).toMatch(/github/i);
  });

  it("returns an empty list when no installed skill matches the task", async () => {
    const runtime = createRuntime({ skills: SAMPLE_SKILLS });

    const recommendations = await recommendSkillsForTask(runtime, {
      taskText: "Practise piano scales for fifteen minutes.",
      disableLlmPass: true,
    });

    expect(recommendations).toEqual([]);
  });

  it("respects the max parameter", async () => {
    const runtime = createRuntime({ skills: SAMPLE_SKILLS });

    const recommendations = await recommendSkillsForTask(runtime, {
      // Mention several distinct domains so multiple skills match.
      taskText:
        "Triage github issues, generate a pdf report, and run playwright browser tests for the webapp.",
      max: 2,
      disableLlmPass: true,
    });

    expect(recommendations.length).toBeLessThanOrEqual(2);
    expect(recommendations.length).toBeGreaterThan(0);
  });

  it("filters out disabled skills before scoring", async () => {
    const runtime = createRuntime({
      skills: SAMPLE_SKILLS,
      enabledSet: new Set(["pdf-tools", "weather-lookup", "playwright-runner"]),
    });

    const recommendations = await recommendSkillsForTask(runtime, {
      taskText: "Look at the github issues for the auth bug.",
      disableLlmPass: true,
    });

    expect(
      recommendations.find((r) => r.slug === "github-issues"),
    ).toBeUndefined();
  });

  it("returns nothing when AGENT_SKILLS_SERVICE is missing", async () => {
    const runtime = {
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      getService: () => null,
    } as unknown as IAgentRuntime;

    const recommendations = await recommendSkillsForTask(runtime, {
      taskText: "Anything",
    });
    expect(recommendations).toEqual([]);
  });
});

describe("recommendSkillsForTask — LLM scoring pass", () => {
  it("blends LLM scores into the final ranking and dedupes", async () => {
    const useModel = vi.fn(async () =>
      JSON.stringify([
        { slug: "playwright-runner", score: 0.95, reason: "browser test fit" },
        { slug: "github-issues", score: 0.4, reason: "tangential" },
        { slug: "playwright-runner", score: 0.6, reason: "duplicate entry" },
      ]),
    );
    const runtime = createRuntime({ skills: SAMPLE_SKILLS, useModel });

    const recommendations = await recommendSkillsForTask(runtime, {
      taskText: "Run the playwright browser tests for the github webapp.",
      max: 5,
    });

    expect(useModel).toHaveBeenCalledTimes(1);
    // Top result should be playwright-runner since the LLM scored it 0.95.
    expect(recommendations[0]?.slug).toBe("playwright-runner");
    expect(recommendations[0]?.reason).toBe("browser test fit");

    // Slug uniqueness — playwright-runner appears once even though the LLM
    // emitted two entries for it.
    const slugs = recommendations.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("falls back to the keyword pass when the LLM returns unparseable output", async () => {
    const useModel = vi.fn(async () => "not even close to JSON, sorry");
    const runtime = createRuntime({ skills: SAMPLE_SKILLS, useModel });

    const recommendations = await recommendSkillsForTask(runtime, {
      taskText: "Pull github issues for the auth bug.",
      max: 5,
    });

    expect(recommendations.length).toBeGreaterThan(0);
    expect(recommendations[0]?.slug).toBe("github-issues");
    // Reason should be the keyword-pass reason since the LLM pass failed.
    expect(recommendations[0]?.reason).toMatch(/matched task tokens/i);
  });

  it("respects max after the LLM pass", async () => {
    const useModel = vi.fn(async () =>
      JSON.stringify([
        { slug: "playwright-runner", score: 0.9, reason: "fit" },
        { slug: "github-issues", score: 0.7, reason: "fit" },
        { slug: "pdf-tools", score: 0.6, reason: "fit" },
      ]),
    );
    const runtime = createRuntime({ skills: SAMPLE_SKILLS, useModel });

    const recommendations = await recommendSkillsForTask(runtime, {
      taskText:
        "Generate a pdf report from github issues and run playwright tests on the result.",
      max: 2,
    });

    expect(recommendations.length).toBeLessThanOrEqual(2);
  });
});

describe("LifeOps context broker recommendation overlay", () => {
  it("adds the broker for task-agent prompts that need owner LifeOps context", () => {
    const recommendations = withLifeOpsContextBrokerRecommendation(
      "Ask the parent for my calendar and inbox context before drafting the plan.",
      [
        {
          slug: "github-issues",
          name: "GitHub Issues",
          score: 0.5,
          reason: "matched github",
        },
      ],
    );

    expect(recommendations[0]?.slug).toBe(LIFEOPS_CONTEXT_BROKER_SLUG);
    expect(recommendations.map((rec) => rec.slug)).toContain("github-issues");
  });

  it("does not force the broker into unrelated coding tasks", () => {
    expect(
      shouldRecommendLifeOpsContextBroker(
        "Refactor the app-lifeops route tests and fix the TypeScript errors.",
      ),
    ).toBe(false);
  });

  it("honors explicit requests for the broker", () => {
    expect(
      shouldRecommendLifeOpsContextBroker(
        "Use lifeops-context if you need parent-owned email details.",
      ),
    ).toBe(true);
  });
});
