import { describe, expect, it } from "vitest";
import { pathForTab, tabFromPath } from "../../navigation";
import {
  buildInternalToolAppViewOverlays,
  getInternalToolAppDescriptors,
  getInternalToolAppHasDetailsPage,
  getInternalToolApps,
  getInternalToolAppTargetTab,
  getInternalToolAppWindowPath,
  type InternalToolAppViewOverlay,
} from "./internal-tool-apps";

describe("internal tool app descriptors", () => {
  it("bridges the Fine Tuning app route to the training tool tab", () => {
    const appName = "@elizaos/plugin-training";
    const descriptor = getInternalToolAppDescriptors().find(
      (item) => item.name === appName,
    );
    const catalogApp = getInternalToolApps().find(
      (item) => item.name === appName,
    );

    expect(getInternalToolAppWindowPath(appName)).toBe("/apps/fine-tuning");
    expect(getInternalToolAppTargetTab(appName)).toBe("fine-tuning");
    expect(getInternalToolAppHasDetailsPage(appName)).toBe(true);
    expect(pathForTab("fine-tuning")).toBe("/apps/fine-tuning");
    expect(tabFromPath("/apps/fine-tuning")).toBe("fine-tuning");
    expect(descriptor).toMatchObject({
      displayName: "Fine Tuning",
    });
    expect(catalogApp).toMatchObject({
      displayName: "Fine Tuning",
      description:
        "Collect training data, inspect trajectories, run Eliza harness evals, benchmark model tiers, and manage fine-tuned models.",
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
    });
  });

  it("keeps internal window paths unique", () => {
    const paths = getInternalToolAppDescriptors()
      .map((descriptor) => descriptor.windowPath)
      .filter((path): path is string => path !== null);

    expect(new Set(paths).size).toBe(paths.length);
  });

  it("routes nested app view paths through the dynamic view renderer", () => {
    expect(tabFromPath("/apps/facewear/tui")).toBe("views");
    expect(tabFromPath("/apps/smartglasses/tui")).toBe("views");
  });
});

describe("internal tool app /api/views overlay", () => {
  it("lets a plugin's ViewDeclaration override the literal presentation for @elizaos/plugin-training", () => {
    const views: InternalToolAppViewOverlay[] = [
      {
        id: "training",
        label: "Renamed Training",
        description: "Overlaid description from the plugin ViewDeclaration",
        heroImageUrl: "/api/views/training/hero.png",
        capabilities: [
          { id: "renamed-capability" },
          { id: "second-capability" },
        ],
      },
    ];
    const overlaid = getInternalToolApps(
      buildInternalToolAppViewOverlays(views),
    ).find((app) => app.name === "@elizaos/plugin-training");

    expect(overlaid).toBeDefined();
    expect(overlaid?.displayName).toBe("Renamed Training");
    expect(overlaid?.description).toBe(
      "Overlaid description from the plugin ViewDeclaration",
    );
    expect(overlaid?.heroImage).toBe("/api/views/training/hero.png");
    expect(overlaid?.capabilities).toEqual([
      "renamed-capability",
      "second-capability",
    ]);
  });

  it("overlays @elizaos/plugin-task-coordinator from its task-coordinator view id", () => {
    const views: InternalToolAppViewOverlay[] = [
      { id: "task-coordinator", label: "Renamed Automations" },
    ];
    const overlaid = getInternalToolApps(
      buildInternalToolAppViewOverlays(views),
    ).find((app) => app.name === "@elizaos/plugin-task-coordinator");

    expect(overlaid?.displayName).toBe("Renamed Automations");
  });

  it("falls back to literal metadata for the synthetic built-in-tab tools (no matching /api/views id)", () => {
    const views: InternalToolAppViewOverlay[] = [
      { id: "training", label: "Renamed Training" },
    ];
    const overlaid = getInternalToolApps(
      buildInternalToolAppViewOverlays(views),
    ).find((app) => app.name === "@elizaos/app-plugin-viewer");

    expect(overlaid?.displayName).toBe("Plugin Viewer");
    expect(overlaid?.description).toBe(
      "Inspect installed plugins, connectors, and runtime feature flags.",
    );
  });

  it("keeps literal metadata when called with no views feed", () => {
    const training = getInternalToolApps().find(
      (app) => app.name === "@elizaos/plugin-training",
    );
    expect(training?.displayName).toBe("Fine Tuning");
  });

  it("indexes only the view ids referenced by plugin-backed tools", () => {
    const views: InternalToolAppViewOverlay[] = [
      { id: "training", label: "Training" },
      { id: "some-unrelated-view", label: "Unrelated" },
      { id: "task-coordinator", label: "Task Coordinator" },
    ];
    const byId = buildInternalToolAppViewOverlays(views);
    expect([...byId.keys()].sort()).toEqual(["task-coordinator", "training"]);
  });
});
