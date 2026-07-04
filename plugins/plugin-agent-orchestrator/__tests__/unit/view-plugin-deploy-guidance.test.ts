/**
 * Verifies isViewPluginTask (#8918).
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import {
  augmentTaskWithDeployGuidance,
  isAppBuildTask,
  isViewPluginTask,
  viewPluginGuidance,
} from "../../src/services/app-deploy-guidance.js";
import { buildViewPluginDeployPrompt } from "../../src/services/view-deploy-guidance.js";

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
  it("states the cloud view-plugin deploy contract", () => {
    const g = viewPluginGuidance({ target: "cloud" });
    expect(g).toContain("View Plugin Deployment (Eliza Cloud)");
    expect(g).toContain("Build the view bundle");
    expect(g).toContain("apps.create");
    expect(g).toContain("Plugin.views");
    expect(g).toContain("viewKind");
    expect(g).toContain("Cloud CDN `bundleUrl`");
    expect(g).toContain("X-Affiliate-Code");
    expect(g).toContain("Cloud app sandboxes are isolated and ephemeral");
  });

  it("keeps non-cloud view-plugin tasks in the local sandbox", () => {
    const g = viewPluginGuidance({
      target: "custom",
      customAppsDir: "/data/apps",
      customBaseUrl: "https://custom-host.test",
    });
    expect(g).toContain("View Plugin Deployment (local sandbox)");
    expect(g).toContain("Plugin.views");
    expect(g).toContain("viewKind");
    expect(g).toContain("/api/views");
    expect(g).not.toContain("apps.create");
  });

  it("buildViewPluginDeployPrompt can include the source directory", () => {
    const g = buildViewPluginDeployPrompt({
      sourceDir: "/workspace/plugins/plugin-example",
    });
    expect(g).toContain("/workspace/plugins/plugin-example");
  });
});

describe("augmentTaskWithDeployGuidance routing (#8918)", () => {
  it("appends cloud view-plugin guidance to a cloud-targeted view task", () => {
    const out = augmentTaskWithDeployGuidance("create a view plugin");
    expect(out).toContain("--- View Plugin Deployment (Eliza Cloud) ---");
    expect(out).toContain("apps.create");
    expect(out).not.toContain("--- App Deployment");
  });

  it("accepts target: 'cloud' as a cloud view deploy target", () => {
    const out = augmentTaskWithDeployGuidance("build a new view", {
      target: "cloud",
    });
    expect(out).toContain("View Plugin Deployment (Eliza Cloud)");
    expect(out).toContain("Cloud CDN `bundleUrl`");
  });

  it("passes the scaffolded source directory into cloud view guidance", () => {
    const out = augmentTaskWithDeployGuidance(
      [
        'You are building a new Eliza plugin called "Metrics View".',
        "The plugin source directory is /workspace/plugins/plugin-metrics-view. It has already been scaffolded.",
        "Build a view plugin for metrics.",
      ].join("\n"),
      { target: "cloud" },
    );
    expect(out).toContain("/workspace/plugins/plugin-metrics-view");
    expect(out).toContain("Cloud sandbox");
  });

  it("appends local sandbox guidance for non-cloud view targets", () => {
    const out = augmentTaskWithDeployGuidance("build a new view", {
      target: "custom",
      customAppsDir: "/data/apps",
      customBaseUrl: "https://custom-host.test",
    });
    expect(out).toContain("View Plugin Deployment (local sandbox)");
    expect(out).not.toContain("apps.create");
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
