import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("plugin app metadata", () => {
  it("publishes the fine-tuning dashboard metadata for local app discovery", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    );

    expect(packageJson.elizaos?.app).toMatchObject({
      displayName: "Fine Tuning",
      category: "tool",
      launchType: "internal-tab",
      icon: "BrainCircuit",
      heroImage: "assets/hero.png",
      capabilities: [
        "training",
        "fine-tuning",
        "trajectories",
        "datasets",
        "models",
        "evals",
        "benchmarks",
        "analysis",
        "data-collection",
      ],
      uiExtension: {
        detailPanelId: "plugin-dash-fine-tuning",
      },
      developerOnly: true,
      visibleInAppStore: true,
    });
  });

  it("publishes analysis, eval, and benchmark tags on training views", async () => {
    const setupRoutes = await readFile(
      new URL("../setup-routes.ts", import.meta.url),
      "utf8",
    );

    expect(setupRoutes).toContain("data collection");
    expect(setupRoutes).toContain("evals");
    expect(setupRoutes).toContain("benchmarks");
    for (const tag of [
      "training",
      "fine-tuning",
      "trajectories",
      "datasets",
      "evals",
      "benchmarks",
      "analysis",
      "data-collection",
    ]) {
      expect(setupRoutes).toContain(`"${tag}"`);
    }
  });
});
