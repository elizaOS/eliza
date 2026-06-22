import { describe, expect, it } from "vitest";
import {
  augmentTaskWithDeployGuidance,
  isAppBuildTask,
  isViewPluginTask,
  viewPluginGuidance,
} from "../../src/services/app-deploy-guidance.js";

describe("isViewPluginTask (#8918)", () => {
  it("matches view/plugin build tasks", () => {
    for (const t of [
      "create a view plugin for the dashboard",
      "build a new view that shows metrics",
      "make a plugin with a viewKind",
      "register a view in the app",
    ]) {
      expect(isViewPluginTask(t)).toBe(true);
    }
  });

  it("does not match unrelated tasks", () => {
    expect(isViewPluginTask("fix the login bug")).toBe(false);
    expect(isViewPluginTask("")).toBe(false);
    expect(isViewPluginTask(null)).toBe(false);
  });
});

describe("viewPluginGuidance (#8918)", () => {
  it("states the cloud-vs-local-sandbox contract", () => {
    const g = viewPluginGuidance();
    expect(g).toContain("View/Plugin Deployment (cloud vs local sandbox)");
    expect(g).toContain("LOCAL SANDBOX (default)");
    expect(g).toContain("Plugin.views");
    expect(g).toContain("viewKind");
    expect(g).toContain("/api/views");
    expect(g).toContain("ELIZA CLOUD");
  });
});

describe("augmentTaskWithDeployGuidance routing (#8918)", () => {
  it("appends view-plugin guidance to a view task", () => {
    const out = augmentTaskWithDeployGuidance("create a view plugin");
    expect(out).toContain("--- View/Plugin Deployment");
    expect(out).not.toContain("--- App Deployment");
  });

  it("is idempotent for view tasks", () => {
    const once = augmentTaskWithDeployGuidance("build a new view");
    const twice = augmentTaskWithDeployGuidance(once);
    expect(twice).toBe(once);
  });

  it("leaves a plain (non-app, non-view) task unchanged", () => {
    const t = "refactor the parser";
    expect(augmentTaskWithDeployGuidance(t)).toBe(t);
    expect(isAppBuildTask(t)).toBe(false);
    expect(isViewPluginTask(t)).toBe(false);
  });
});
