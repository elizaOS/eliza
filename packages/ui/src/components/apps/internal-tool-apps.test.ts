/**
 * Covers `internal-tool-apps.ts`: how ViewDeclaration-derived internal apps map
 * to catalog descriptors, target tabs, window paths, and pinnable names, and how
 * routes bridge to tool tabs. Pure functions over in-memory view fixtures.
 */

import { describe, expect, it } from "vitest";
import type { ViewRegistryEntry } from "../../hooks/useAvailableViews";
import { pathForTab, tabFromPath } from "../../navigation";
import {
  getInternalToolAppDescriptors,
  getInternalToolAppHasDetailsPage,
  getInternalToolAppNameForPath,
  getInternalToolApps,
  getInternalToolAppTargetTab,
  getInternalToolAppWindowPath,
  getPinnableInternalAppNames,
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

  it("overlays a plugin's live /api/views ViewDeclaration onto the catalog", () => {
    // Renaming a plugin app's displayName in its ViewDeclaration must update the
    // UI catalog with no edit to the static internal-tool declarations.
    const trainingView: ViewRegistryEntry = {
      id: "training",
      label: "Model Studio",
      description: "Renamed via ViewDeclaration",
      path: "/apps/fine-tuning",
      tags: ["training", "renamed"],
      available: true,
      pluginName: "@elizaos/plugin-training",
      hasHeroImage: true,
      heroImageUrl: "/api/views/training/hero",
    };

    const staticApp = getInternalToolApps().find(
      (app) => app.name === "@elizaos/plugin-training",
    );
    expect(staticApp?.displayName).toBe("Fine Tuning");

    const overlaid = getInternalToolApps([trainingView]).find(
      (app) => app.name === "@elizaos/plugin-training",
    );
    expect(overlaid?.displayName).toBe("Model Studio");
    expect(overlaid?.description).toBe("Renamed via ViewDeclaration");
    expect(overlaid?.capabilities).toEqual(["training", "renamed"]);
    expect(overlaid?.heroImage).toBe("/api/views/training/hero");
  });

  it("maps window paths back to their internal-tool app name", () => {
    expect(getInternalToolAppNameForPath("/apps/fine-tuning")).toBe(
      "@elizaos/plugin-training",
    );
    expect(getInternalToolAppNameForPath("/apps/plugins")).toBe(
      "@elizaos/app-plugin-viewer",
    );
    expect(getInternalToolAppNameForPath("/apps/nonexistent")).toBeNull();
  });

  it("derives the pinnable list from declared pinnable flags", () => {
    const pinnable = getPinnableInternalAppNames();
    expect(pinnable).toContain("@elizaos/plugin-training");
    expect(pinnable).toContain("@elizaos/plugin-task-coordinator");
    // Files is a non-pinnable internal tool.
    expect(pinnable).not.toContain("@elizaos/app-files-viewer");
    for (const name of pinnable) {
      expect(getInternalToolAppTargetTab(name)).not.toBeNull();
    }
  });
});
