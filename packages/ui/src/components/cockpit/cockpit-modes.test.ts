/**
 * Unit tests for the cockpit mode → providerPolicy lowering (cockpit-modes):
 * that each of the three modes resolves to the right provider source, model, and
 * create-task input. Pure functions, no DOM or network.
 */
import { toWellFormedUnicode } from "@elizaos/core";
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
    it("eliza-cloud sources from eliza-cloud; subscription/experimental from the vendor", () => {
      expect(
        cockpitModeProviderSource({
          mode: "eliza-cloud",
          agentType: "elizaos",
          tier: "small",
        }),
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
        cockpitModeModel({ mode: "subscription", agentType: "codex" }),
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
          mode: { mode: "subscription", agentType: "codex" },
        }).title,
      ).toBe("Custom Title");
      const long = "x".repeat(120);
      const t = buildCockpitCreateTaskInput({
        goal: long,
        mode: { mode: "subscription", agentType: "codex" },
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

describe("deriveTitle surrogate safety via buildCockpitCreateTaskInput", () => {
  const isWellFormed = (s: string): boolean => {
    const w = s as unknown as { isWellFormed?: () => boolean };
    if (typeof w.isWellFormed === "function") return w.isWellFormed();
    return toWellFormedUnicode(s) === s;
  };
  const mode = { mode: "opencode" as const, agentType: "opencode" as const };

  it("backs off when truncation would split a surrogate pair (a*79+🦊 at 80)", () => {
    const goal = `${"a".repeat(79)}🦊${"b".repeat(20)}`;
    const { title } = buildCockpitCreateTaskInput({ goal, mode });
    expect(isWellFormed(title)).toBe(true);
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(() => JSON.stringify(title)).not.toThrow();
  });

  it("preserves a fitting astral emoji at the cap (a*78+🦊 at 80)", () => {
    const goal = `${"a".repeat(78)}🦊`;
    const { title } = buildCockpitCreateTaskInput({ goal, mode });
    expect(isWellFormed(title)).toBe(true);
    expect(title).toBe(toWellFormedUnicode(goal.trim()));
  });

  it("sanitizes lone high surrogate", () => {
    const goal = `ok \ud800 end ${"x".repeat(100)}`;
    const { title } = buildCockpitCreateTaskInput({ goal, mode });
    expect(isWellFormed(title)).toBe(true);
    expect(title.includes("�")).toBe(true);
  });

  it("sanitizes lone low surrogate", () => {
    const goal = `ok \udc00 end ${"x".repeat(100)}`;
    const { title } = buildCockpitCreateTaskInput({ goal, mode });
    expect(isWellFormed(title)).toBe(true);
    expect(title.includes("�")).toBe(true);
  });

  it("stays well-formed across every offset in a sweep (cap 20)", () => {
    for (let offset = 0; offset <= 25; offset++) {
      const goal = `${"a".repeat(offset)}🦊${"b".repeat(100)}`;
      const { title } = buildCockpitCreateTaskInput({ goal, mode });
      expect(isWellFormed(title)).toBe(true);
      expect(title.length).toBeLessThanOrEqual(80);
      expect(() => JSON.stringify(title)).not.toThrow();
    }
  });

  it("returns well-formed when under cap with lone surrogate", () => {
    const goal = "ok \ud800 end";
    const { title } = buildCockpitCreateTaskInput({ goal, mode });
    expect(isWellFormed(title)).toBe(true);
    expect(title.includes("�")).toBe(true);
  });

  it("handles astral at 1-char budget without lone", () => {
    const goal = `${"x".repeat(79)}😀${"a".repeat(10)}`;
    const { title } = buildCockpitCreateTaskInput({ goal, mode });
    expect(isWellFormed(title)).toBe(true);
  });
});
