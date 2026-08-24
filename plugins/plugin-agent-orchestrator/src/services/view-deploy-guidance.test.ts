/**
 * Unit tests for view deploy guidance prompts: validates cloud and local
 * prompt contracts, sourceDir propagation, and key instructions.
 */
import { describe, expect, it } from "vitest";
import {
  buildLocalViewPluginPrompt,
  buildViewPluginDeployPrompt,
} from "./view-deploy-guidance.ts";

describe("view-deploy-guidance", () => {
  it("builds cloud view plugin deploy prompt with custom sourceDir", () => {
    const prompt = buildViewPluginDeployPrompt({
      sourceDir: "packages/my-view",
    });

    expect(prompt).toContain("View Plugin Deployment (Eliza Cloud)");
    expect(prompt).toContain("packages/my-view");
    expect(prompt).toContain("Plugin.views");
    expect(prompt).toContain("viewKind");
    expect(prompt).toContain("apps.create");
  });

  it("builds local view plugin deploy prompt", () => {
    const prompt = buildLocalViewPluginPrompt();

    expect(prompt).toContain("View Plugin Deployment (local sandbox)");
    expect(prompt).toContain("/api/views");
    expect(prompt).toContain("Plugin.views");
  });
});
