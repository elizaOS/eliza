import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  PARENT_AGENT_BROKER_MANIFEST_ENTRY,
  PARENT_AGENT_BROKER_SLUG,
} from "../services/parent-agent-broker.js";
import { buildSkillsManifest } from "../services/skill-manifest.js";

function createRuntime(service?: unknown): IAgentRuntime {
  return {
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    getService: vi.fn(() => service),
  } as unknown as IAgentRuntime;
}

describe("buildSkillsManifest", () => {
  it("emits parent-agent as a requestable virtual skill without a disk skills service", async () => {
    const manifest = await buildSkillsManifest(createRuntime(), {
      recommendedSlugs: [PARENT_AGENT_BROKER_SLUG],
      virtualSkills: [PARENT_AGENT_BROKER_MANIFEST_ENTRY],
    });

    expect(manifest.slugs).toEqual([PARENT_AGENT_BROKER_SLUG]);
    expect(manifest.markdown).toContain("Parent Eliza Agent");
    expect(manifest.markdown).toContain("Task-scoped broker skills");
    expect(manifest.markdown).toContain("USE_SKILL parent-agent");
  });

  it("uses the union of enabled skills and virtual brokers as requestable slugs", async () => {
    const service = {
      getEligibleSkills: vi.fn(async () => [
        {
          slug: "eliza-cloud",
          name: "Eliza Cloud",
          description: "Cloud APIs, apps, billing, and media.",
        },
        {
          slug: "disabled-skill",
          name: "Disabled",
          description: "Should not be requestable.",
        },
      ]),
      isSkillEnabled: vi.fn((slug: string) => slug !== "disabled-skill"),
    };

    const manifest = await buildSkillsManifest(createRuntime(service), {
      onlyEligible: true,
      recommendedSlugs: [PARENT_AGENT_BROKER_SLUG, "eliza-cloud"],
      virtualSkills: [PARENT_AGENT_BROKER_MANIFEST_ENTRY],
    });

    expect(manifest.slugs).toEqual([PARENT_AGENT_BROKER_SLUG, "eliza-cloud"]);
    expect(manifest.markdown).toContain("Eliza Cloud");
    expect(manifest.markdown).not.toContain("Disabled");
  });
});
