/**
 * Verifies buildSkillsManifest.
 * Deterministic unit test with a stubbed runtime; no live model.
 */
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
          slug: "build-monetized-app",
          name: "Build Monetized App",
          description: "Build, deploy, and monetize Eliza Cloud apps.",
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
      recommendedSlugs: [
        PARENT_AGENT_BROKER_SLUG,
        "build-monetized-app",
        "eliza-cloud",
      ],
      virtualSkills: [PARENT_AGENT_BROKER_MANIFEST_ENTRY],
    });

    expect(manifest.slugs).toEqual([
      PARENT_AGENT_BROKER_SLUG,
      "build-monetized-app",
      "eliza-cloud",
    ]);
    expect(manifest.markdown).toContain("Eliza Cloud");
    expect(manifest.markdown).toContain("Build Monetized App");
    expect(manifest.markdown).not.toContain("Disabled");
  });

  it("appends the ViewKind contract when includeViewKindContract is set (#8917)", async () => {
    const manifest = await buildSkillsManifest(createRuntime(), {
      recommendedSlugs: [PARENT_AGENT_BROKER_SLUG],
      virtualSkills: [PARENT_AGENT_BROKER_MANIFEST_ENTRY],
      includeViewKindContract: true,
    });

    expect(manifest.markdown).toContain("## View kind");
    expect(manifest.markdown).toContain("`release`");
    expect(manifest.markdown).toContain("`preview`");
    expect(manifest.markdown).toContain("`developer`");
    expect(manifest.markdown).toContain("`system`");
    expect(manifest.markdown).toContain("Do not use");
    // Default resolution is documented so an omitted viewKind is unambiguous.
    expect(manifest.markdown).toContain("resolves to `release`");
  });

  it("omits the ViewKind contract from the generic manifest by default (#8917)", async () => {
    const manifest = await buildSkillsManifest(createRuntime(), {
      virtualSkills: [PARENT_AGENT_BROKER_MANIFEST_ENTRY],
    });

    // The generic manifest must stay clean — ViewKind is app-build-only.
    expect(manifest.markdown).not.toContain("View kind");
  });
});
