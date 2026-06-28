import { describe, expect, it } from "vitest";
import {
  augmentTaskWithDeployGuidance,
  buildAppDeployGuidance,
  isAppBuildTask,
  isMonetizedAppTask,
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

  describe("isMonetizedAppTask", () => {
    it("matches money-earning app builds", () => {
      expect(isMonetizedAppTask("build a monetized web app")).toBe(true);
      expect(
        isMonetizedAppTask("an app that charges $2 per use with a markup"),
      ).toBe(true);
      expect(isMonetizedAppTask("a paid app with premium tiers")).toBe(true);
    });
    it("does NOT match a plain static/fun app", () => {
      expect(isMonetizedAppTask("build me a magic 8-ball web app")).toBe(false);
      expect(isMonetizedAppTask("a quick countdown timer page")).toBe(false);
      expect(isMonetizedAppTask("")).toBe(false);
    });
  });

  describe("agent-home monetized vs static", () => {
    const cfg = {
      target: "agent-home" as const,
      agentHomeAppsDir: "/data/apps",
      agentHomeBaseUrl: "https://example.test",
    };
    it("a MONETIZED agent-home app registers with Cloud + starts from the edad template (no 'no Cloud')", () => {
      const out = augmentTaskWithDeployGuidance(
        "build a monetized web app that charges $3 per use",
        cfg,
      );
      expect(out).toContain("App Deployment (agent-home)");
      expect(out).toContain("register it with Eliza Cloud");
      expect(out).toContain("packages/examples/cloud/edad");
      expect(out).toContain("cloud.json");
      expect(out).not.toContain("Do NOT use Eliza Cloud for this one");
    });
    it("a NON-monetized agent-home app stays static-only (keeps 'no Cloud')", () => {
      const out = augmentTaskWithDeployGuidance(
        "build a magic 8-ball app",
        cfg,
      );
      expect(out).toContain("Do NOT use Eliza Cloud for this one");
      expect(out).not.toContain("register it with Eliza Cloud");
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
    it("a MONETIZED Eliza-Cloud build starts from the edad template (no from-scratch)", () => {
      const out = buildAppDeployGuidance(
        { target: "eliza-cloud" },
        "build a monetized app that charges $2 per use",
      );
      expect(out).toContain("packages/examples/cloud/edad");
      expect(out).toContain("START FROM THE TEMPLATE");
      // forwards to the org-balance endpoint, not the stranded per-app pool
      expect(out).toContain("/api/v1/messages");
      expect(out).not.toContain("/api/v1/apps/<appId>/chat");
    });
    it("a NON-monetized build keeps the generic Cloud contract (no edad)", () => {
      const out = buildAppDeployGuidance(
        { target: "eliza-cloud" },
        "build a website about cats",
      );
      expect(out).toContain("App Deployment (Eliza Cloud)");
      expect(out).not.toContain("packages/examples/cloud/edad");
    });
    it("defaults to Eliza Cloud for an unspecified/empty config", () => {
      expect(buildAppDeployGuidance({ target: "eliza-cloud" })).toContain(
        "Eliza Cloud",
      );
    });
  });
});
