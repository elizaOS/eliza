import { afterEach, describe, expect, it } from "vitest";
import {
  clearRegistryCacheForTests,
  getEntryByNpmName,
  loadRegistry,
} from "./index";
import type { AppEntry } from "./schema";

describe("training app registry entry", () => {
  afterEach(() => {
    clearRegistryCacheForTests();
  });

  it("exposes the fine-tuning dashboard through the static app catalog", () => {
    const entry = getEntryByNpmName(
      loadRegistry(),
      "@elizaos/plugin-training",
    ) as AppEntry | undefined;

    expect(entry).toMatchObject({
      id: "training",
      kind: "app",
      name: "Fine Tuning",
      npmName: "@elizaos/plugin-training",
      render: {
        visible: true,
        icon: "BrainCircuit",
        actions: ["launch", "configure"],
      },
      launch: {
        type: "internal-tab",
        target: "fine-tuning",
        capabilities: expect.arrayContaining([
          "training",
          "fine-tuning",
          "trajectories",
          "datasets",
          "models",
          "evals",
          "benchmarks",
          "analysis",
          "data-collection",
        ]),
        uiExtension: {
          detailPanelId: "plugin-dash-fine-tuning",
        },
        routePlugin: {
          specifier: "@elizaos/plugin-training/setup-routes",
          exportName: "trainingPlugin",
        },
        // Self-declared runtime-hook: the host drains this through the generic
        // runtime-hook channel instead of hard-wiring the training specifier in
        // the boot tail.
        runtimeHook: {
          specifier: "@elizaos/plugin-training",
          exportName: "registerTrainingRuntimeHooks",
        },
      },
    });
  });
});
