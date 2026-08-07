/**
 * Covers `internal-tool-apps.ts`: how ViewDeclaration-derived internal apps map
 * to catalog descriptors, target tabs, window paths, and pinnable names, and how
 * routes bridge to tool tabs. Pure functions over in-memory view fixtures.
 */

import { describe, expect, it } from "vitest";
import type { ViewRegistryEntry } from "../../hooks/useAvailableViews";
import { tabFromPath } from "../../navigation";
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
  it("bridges the Automations app route to the task tool tab", () => {
    const appName = "@elizaos/plugin-task-coordinator";
    const descriptor = getInternalToolAppDescriptors().find(
      (item) => item.name === appName,
    );
    const catalogApp = getInternalToolApps().find(
      (item) => item.name === appName,
    );

    expect(getInternalToolAppWindowPath(appName)).toBe("/apps/tasks");
    expect(getInternalToolAppTargetTab(appName)).toBe("tasks");
    expect(getInternalToolAppHasDetailsPage(appName)).toBe(false);
    expect(descriptor).toMatchObject({
      displayName: "Automations",
    });
    expect(catalogApp).toMatchObject({
      displayName: "Automations",
      description:
        "Create, inspect, and manage workflows, triggers, and scheduled items.",
      capabilities: expect.arrayContaining([
        "tasks",
        "workflows",
        "automations",
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
    expect(tabFromPath("/apps/custom-panel/detail")).toBe("views");
  });

  it("overlays a plugin's live /api/views ViewDeclaration onto the catalog", () => {
    // Renaming a plugin app's displayName in its ViewDeclaration must update the
    // UI catalog with no edit to the static internal-tool declarations.
    const automationsView: ViewRegistryEntry = {
      id: "task-coordinator",
      label: "Workflow Studio",
      description: "Renamed via ViewDeclaration",
      path: "/apps/tasks",
      tags: ["automations", "renamed"],
      available: true,
      pluginName: "@elizaos/plugin-task-coordinator",
      hasHeroImage: true,
      heroImageUrl: "/api/views/task-coordinator/hero",
    };

    const staticApp = getInternalToolApps().find(
      (app) => app.name === "@elizaos/plugin-task-coordinator",
    );
    expect(staticApp?.displayName).toBe("Automations");

    const overlaid = getInternalToolApps([automationsView]).find(
      (app) => app.name === "@elizaos/plugin-task-coordinator",
    );
    expect(overlaid?.displayName).toBe("Workflow Studio");
    expect(overlaid?.description).toBe("Renamed via ViewDeclaration");
    expect(overlaid?.capabilities).toEqual(["automations", "renamed"]);
    expect(overlaid?.heroImage).toBe("/api/views/task-coordinator/hero");
  });

  it("maps window paths back to their internal-tool app name", () => {
    expect(getInternalToolAppNameForPath("/apps/tasks")).toBe(
      "@elizaos/plugin-task-coordinator",
    );
    expect(getInternalToolAppNameForPath("/apps/plugins")).toBe(
      "@elizaos/app-plugin-viewer",
    );
    expect(getInternalToolAppNameForPath("/apps/nonexistent")).toBeNull();
  });

  it("derives the pinnable list from declared pinnable flags", () => {
    const pinnable = getPinnableInternalAppNames();
    expect(pinnable).toContain("@elizaos/plugin-task-coordinator");
    // Files is a non-pinnable internal tool.
    expect(pinnable).not.toContain("@elizaos/app-files-viewer");
    for (const name of pinnable) {
      expect(getInternalToolAppTargetTab(name)).not.toBeNull();
    }
  });
});
