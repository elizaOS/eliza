/**
 * Tests for the skill manifest builder.
 *
 * The manifest is a Markdown document we write into a spawned agent's
 * workspace so the agent has visibility into the parent's installed skills.
 * We verify the rendering shape, recommended/all sections, and the
 * eligibility filter.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { LIFEOPS_CONTEXT_BROKER_MANIFEST_ENTRY } from "../services/skill-lifeops-context-broker.js";
import { buildSkillsManifest } from "../services/skill-manifest.js";

interface FakeSkill {
  slug: string;
  name: string;
  description: string;
}

interface SkillsServiceFake {
  eligible: FakeSkill[];
  enabledSet: Set<string>;
}

function createRuntimeWithSkills(fake: SkillsServiceFake): IAgentRuntime {
  const service = {
    getEligibleSkills: async () => fake.eligible,
    isSkillEnabled: (slug: string) => fake.enabledSet.has(slug),
  };
  const runtime = {
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    getService: (name: string) =>
      name === "AGENT_SKILLS_SERVICE" ? service : null,
  };
  return runtime as unknown as IAgentRuntime;
}

const SKILLS: FakeSkill[] = [
  {
    slug: "github-issues",
    name: "GitHub Issues",
    description: "Read, create, and comment on GitHub issues.",
  },
  {
    slug: "pdf-tools",
    name: "PDF Tools",
    description: "Extract text, rotate, and split PDF documents.",
  },
  {
    slug: "weather",
    name: "Weather",
    description: "Fetch the current weather for a location.",
  },
];

describe("buildSkillsManifest", () => {
  it("renders a Markdown manifest with the expected structure when no recommendations are supplied", async () => {
    const runtime = createRuntimeWithSkills({
      eligible: SKILLS,
      enabledSet: new Set(SKILLS.map((s) => s.slug)),
    });

    const result = await buildSkillsManifest(runtime, { onlyEligible: true });

    expect(result.markdown).toContain("# Available skills");
    expect(result.markdown).toContain("USE_SKILL <slug> <json_args>");
    expect(result.markdown).toContain("## All enabled skills");
    expect(result.markdown).toContain(
      "**GitHub Issues** (`github-issues`) — Read, create, and comment on GitHub issues.",
    );
    expect(result.markdown).toContain("**PDF Tools** (`pdf-tools`)");
    expect(result.markdown).toContain("**Weather** (`weather`)");
    // No recommendations supplied → no recommended section header.
    expect(result.markdown).not.toContain("## Recommended for this task");
    expect(result.slugs).toEqual(["github-issues", "pdf-tools", "weather"]);
  });

  it("highlights recommended slugs in a dedicated section while keeping the full list", async () => {
    const runtime = createRuntimeWithSkills({
      eligible: SKILLS,
      enabledSet: new Set(SKILLS.map((s) => s.slug)),
    });

    const result = await buildSkillsManifest(runtime, {
      onlyEligible: true,
      recommendedSlugs: ["pdf-tools", "github-issues"],
    });

    expect(result.markdown).toContain("## Recommended for this task");
    const recommendedIdx = result.markdown.indexOf(
      "## Recommended for this task",
    );
    const allIdx = result.markdown.indexOf("## All enabled skills");
    expect(recommendedIdx).toBeGreaterThan(0);
    expect(allIdx).toBeGreaterThan(recommendedIdx);

    const recommendedSection = result.markdown.slice(recommendedIdx, allIdx);
    expect(recommendedSection).toContain("`pdf-tools`");
    expect(recommendedSection).toContain("`github-issues`");
    expect(recommendedSection).not.toContain("`weather`");
  });

  it("drops recommended slugs that are not eligible/enabled", async () => {
    const runtime = createRuntimeWithSkills({
      eligible: SKILLS,
      enabledSet: new Set(["github-issues", "pdf-tools"]),
    });

    const result = await buildSkillsManifest(runtime, {
      onlyEligible: true,
      recommendedSlugs: [
        "weather", // disabled — should be dropped from recommended
        "github-issues",
        "phantom-skill", // not installed — should be dropped
      ],
    });

    const recommendedIdx = result.markdown.indexOf(
      "## Recommended for this task",
    );
    const allIdx = result.markdown.indexOf("## All enabled skills");
    const recommendedSection = result.markdown.slice(recommendedIdx, allIdx);

    expect(recommendedSection).toContain("`github-issues`");
    expect(recommendedSection).not.toContain("`weather`");
    expect(recommendedSection).not.toContain("`phantom-skill`");
    expect(result.slugs).not.toContain("weather");
    expect(result.slugs).not.toContain("phantom-skill");
    expect(result.slugs).toContain("github-issues");
    expect(result.slugs).toContain("pdf-tools");
  });

  it("renders task-scoped virtual broker skills when recommended", async () => {
    const runtime = createRuntimeWithSkills({
      eligible: SKILLS,
      enabledSet: new Set(SKILLS.map((s) => s.slug)),
    });

    const result = await buildSkillsManifest(runtime, {
      onlyEligible: true,
      recommendedSlugs: ["lifeops-context"],
      virtualSkills: [LIFEOPS_CONTEXT_BROKER_MANIFEST_ENTRY],
    });

    expect(result.slugs).toContain("lifeops-context");
    expect(result.markdown).toContain("## Recommended for this task");
    expect(result.markdown).toContain("## Task-scoped broker skills");
    expect(result.markdown).toContain("USE_SKILL lifeops-context");
    expect(result.markdown).toContain("email, calendar, inbox, priority");
  });

  it("returns an empty manifest skeleton when AGENT_SKILLS_SERVICE is unavailable", async () => {
    const runtime = {
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      getService: () => null,
    } as unknown as IAgentRuntime;

    const result = await buildSkillsManifest(runtime, { onlyEligible: true });

    expect(result.slugs).toEqual([]);
    expect(result.markdown).toContain("# Available skills");
    expect(result.markdown).toContain("## All enabled skills");
    // Empty section renders the placeholder.
    expect(result.markdown).toContain("_(none)_");
  });
});
