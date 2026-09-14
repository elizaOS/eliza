/** Verifies the bundled Cloud route family declares only its required shell capability. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { listAppShellPages } from "../app-shell-registry";
import { tabFromPath } from "../navigation";
import { resetUiRegistryHostForTests } from "../registry-host";

describe("managed Cloud app-shell registration", () => {
  beforeEach(() => {
    resetUiRegistryHostForTests();
    vi.resetModules();
  });

  it.each(["host-first", "plugin-first"])(
    "preserves account deep links when registrations load %s",
    async (order) => {
      const { registerManagedCloudAppShellPage } = await import(
        "./register-managed-cloud-page"
      );
      if (order === "host-first") registerManagedCloudAppShellPage();
      await import("../../../../plugins/plugin-elizacloud/src/register");
      if (order === "plugin-first") registerManagedCloudAppShellPage();

      const cloud = listAppShellPages().filter((entry) => entry.id === "cloud");
      expect(cloud).toHaveLength(1);
      expect(cloud[0]?.pluginId).toBe("@elizaos/ui");
      expect(tabFromPath("/cloud/billing")).toBe("cloud");
      expect(tabFromPath("/cloud/agents")).toBe("cloud");
    },
  );

  it("retains the signed plugin page in hosts without managed account routes", async () => {
    await import("../../../../plugins/plugin-elizacloud/src/register");
    const cloud = listAppShellPages().find((entry) => entry.id === "cloud");
    expect(cloud?.pluginId).toBe("@elizaos/plugin-elizacloud");
    expect(cloud?.loader).toBeTypeOf("function");
    expect(tabFromPath("/cloud")).toBe("cloud");
  });

  it("grants nested route navigation without widening storage or wallpaper authority", async () => {
    const { registerManagedCloudAppShellPage } = await import(
      "./register-managed-cloud-page"
    );

    registerManagedCloudAppShellPage();

    const registration = listAppShellPages().find(
      (entry) => entry.id === "cloud",
    );
    expect(registration?.path).toBe("/cloud");
    expect(registration?.pathPatterns).toEqual(["/cloud/*"]);
    expect(registration?.availability).toBeUndefined();
    expect(registration?.surface).toEqual({
      capabilities: ["navigate"],
      layout: {
        kind: "immersive",
        topology: "ambient",
        width: "full",
        scroll: "view",
        gutter: "none",
      },
    });
    expect(registration?.surface?.background).toBeUndefined();
  });
});
