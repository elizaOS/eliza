/**
 * Unit tests for the cockpit mode → providerPolicy lowering (cockpit-modes):
 * that each of the four modes resolves to the right provider source, model, and
 * create-task input. Pure functions, no DOM or network.
 */
import { describe, expect, it } from "vitest";

import {
  buildCockpitCreateTaskInput,
  cockpitModeModel,
  cockpitModeProviderSource,
  cockpitModeToProviderPolicy,
  normalizeCockpitSpawnTarget,
} from "./cockpit-modes";

describe("cockpit-modes lowering", () => {
  describe("cockpitModeProviderSource", () => {
    it("eliza-cloud + opencode source from eliza-cloud; subscription/experimental from the vendor", () => {
      expect(
        cockpitModeProviderSource({
          mode: "eliza-cloud",
          agentType: "elizaos",
          tier: "small",
        }),
      ).toBe("eliza-cloud");
      expect(
        cockpitModeProviderSource({ mode: "opencode", agentType: "opencode" }),
      ).toBe("eliza-cloud");
      expect(
        cockpitModeProviderSource({
          mode: "subscription",
          agentType: "claude",
        }),
      ).toBe("user-claude");
      expect(
        cockpitModeProviderSource({ mode: "subscription", agentType: "codex" }),
      ).toBe("user-openai");
      expect(
        cockpitModeProviderSource({
          mode: "experimental",
          agentType: "codex",
          proxy: "codex-cli",
        }),
      ).toBe("user-openai");
    });
  });

  describe("cockpitModeModel", () => {
    it("eliza-cloud maps tier→model; others pass through (or undefined)", () => {
      expect(
        cockpitModeModel({
          mode: "eliza-cloud",
          agentType: "elizaos",
          tier: "small",
        }),
      ).toBe("gemma-4-31b");
      expect(
        cockpitModeModel({
          mode: "eliza-cloud",
          agentType: "elizaos",
          tier: "large",
        }),
      ).toBe("gemma-4-31b");
      expect(
        cockpitModeModel({ mode: "opencode", agentType: "opencode" }),
      ).toBeUndefined();
      expect(
        cockpitModeModel({
          mode: "subscription",
          agentType: "claude",
          model: "opus",
        }),
      ).toBe("opus");
    });
  });

  describe("cockpitModeToProviderPolicy", () => {
    it("produces the {preferredFramework, providerSource, model} the create route accepts", () => {
      expect(
        cockpitModeToProviderPolicy({
          mode: "eliza-cloud",
          agentType: "elizaos",
          tier: "large",
        }),
      ).toEqual({
        preferredFramework: "elizaos",
        providerSource: "eliza-cloud",
        model: "gemma-4-31b",
      });
      expect(
        cockpitModeToProviderPolicy({
          mode: "subscription",
          agentType: "claude",
        }),
      ).toEqual({
        preferredFramework: "claude",
        providerSource: "user-claude",
      });
    });
  });

  describe("buildCockpitCreateTaskInput", () => {
    it("derives the title from the goal's first line and attaches the policy", () => {
      const input = buildCockpitCreateTaskInput({
        goal: "Fix the auth bug\nthen open a PR",
        mode: { mode: "subscription", agentType: "codex" },
      });
      expect(input.title).toBe("Fix the auth bug");
      expect(input.goal).toBe("Fix the auth bug\nthen open a PR");
      expect(input.providerPolicy).toEqual({
        preferredFramework: "codex",
        providerSource: "user-openai",
      });
    });

    it("honors an explicit title and truncates a long derived title", () => {
      expect(
        buildCockpitCreateTaskInput({
          goal: "do a thing",
          title: "Custom Title",
          mode: { mode: "opencode", agentType: "opencode" },
        }).title,
      ).toBe("Custom Title");
      const long = "x".repeat(120);
      const t = buildCockpitCreateTaskInput({
        goal: long,
        mode: { mode: "opencode", agentType: "opencode" },
      }).title;
      expect(t.length).toBeLessThanOrEqual(80);
      expect(t.endsWith("…")).toBe(true);
    });
  });

  describe("normalizeCockpitSpawnTarget", () => {
    it("returns undefined when both fields are blank or whitespace", () => {
      expect(normalizeCockpitSpawnTarget({})).toBeUndefined();
      expect(
        normalizeCockpitSpawnTarget({ repo: "   ", workdir: "  " }),
      ).toBeUndefined();
    });

    it("trims and keeps only the fields with content", () => {
      expect(normalizeCockpitSpawnTarget({ repo: "  owner/repo  " })).toEqual({
        repo: "owner/repo",
      });
      expect(
        normalizeCockpitSpawnTarget({
          repo: "owner/repo",
          workdir: " packages/ui ",
        }),
      ).toEqual({ repo: "owner/repo", workdir: "packages/ui" });
    });

    it("still returns a workdir-only target (caller enforces the repo requirement)", () => {
      expect(normalizeCockpitSpawnTarget({ workdir: "packages/ui" })).toEqual({
        workdir: "packages/ui",
      });
    });
  });
});
