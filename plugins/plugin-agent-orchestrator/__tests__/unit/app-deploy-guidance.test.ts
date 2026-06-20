import { describe, expect, it } from "vitest";
import {
  augmentTaskWithDeployGuidance,
  buildAppDeployGuidance,
  isAppBuildTask,
} from "../../src/services/app-deploy-guidance.js";

describe("app-deploy-guidance", () => {
  describe("isAppBuildTask", () => {
    it("matches hosted web-surface builds", () => {
      expect(isAppBuildTask("build me a website about cats")).toBe(true);
      expect(isAppBuildTask("create a landing page for my startup")).toBe(true);
      expect(isAppBuildTask("make a web app dashboard")).toBe(true);
    });

    it("does NOT match non-hosted builds (CLI / library / script / bot)", () => {
      expect(isAppBuildTask("build a CLI tool to parse logs")).toBe(false);
      expect(isAppBuildTask("create a npm library for dates")).toBe(false);
      expect(isAppBuildTask("write a script to rename files")).toBe(false);
      expect(isAppBuildTask("fix the bug in the parser")).toBe(false);
    });

    it("ignores empty/nullish input", () => {
      expect(isAppBuildTask("")).toBe(false);
      expect(isAppBuildTask(undefined)).toBe(false);
      expect(isAppBuildTask(null)).toBe(false);
    });
  });

  describe("augmentTaskWithDeployGuidance", () => {
    it("appends the Eliza Cloud contract to an app-build task by default", () => {
      const out = augmentTaskWithDeployGuidance("build a website about cats", {
        target: "eliza-cloud",
      });
      expect(out).toContain("build a website about cats");
      expect(out).toContain("App Deployment (Eliza Cloud)");
      expect(out).toContain("verified live");
    });

    it("passes a non-app task through unchanged", () => {
      const task = "fix the bug in the parser";
      expect(
        augmentTaskWithDeployGuidance(task, { target: "eliza-cloud" }),
      ).toBe(task);
    });

    it("is idempotent — does not double-append the contract", () => {
      const once = augmentTaskWithDeployGuidance("build a website", {
        target: "eliza-cloud",
      });
      const twice = augmentTaskWithDeployGuidance(once, {
        target: "eliza-cloud",
      });
      expect(twice).toBe(once);
    });

    it("uses the gated agent-home host when that target is configured", () => {
      const out = augmentTaskWithDeployGuidance("build a website", {
        target: "agent-home",
        agentHomeAppsDir: "/data/apps",
        agentHomeBaseUrl: "https://example.test",
      });
      expect(out).toContain("App Deployment (agent-home)");
      expect(out).toContain("/data/apps/<slug>/");
      expect(out).toContain("https://example.test/apps/<slug>/");
      // The Cloud contract header must not appear (the agent-home block only
      // references Cloud to say "do NOT use it for this one").
      expect(out).not.toContain("App Deployment (Eliza Cloud)");
    });
  });

  describe("buildAppDeployGuidance", () => {
    it("defaults to Eliza Cloud for an unspecified/empty config", () => {
      expect(buildAppDeployGuidance({ target: "eliza-cloud" })).toContain(
        "Eliza Cloud",
      );
    });
  });
});
