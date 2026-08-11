/**
 * Cloud Apps destination registration against the real app-shell registry.
 */

import { listAppShellPages } from "@elizaos/ui/app-shell-registry";
import { describe, expect, it, vi } from "vitest";
import { cloudAppsStudioKind } from "./cloud-apps-view";

vi.mock("@elizaos/ui/platform", () => ({
  getFrontendPlatform: () => "ios",
}));

describe("Cloud Apps destination", () => {
  it("uses the host-aware studio wrapper", () => {
    expect(cloudAppsStudioKind("web")).toBe("web");
    expect(cloudAppsStudioKind("ios")).toBe("native");
    expect(cloudAppsStudioKind("android")).toBe("native");
    expect(cloudAppsStudioKind("desktop")).toBe("native");
  });

  it("registers a bundled app-shell page at the path emitted by VIEWS", () => {
    const page = listAppShellPages().find((entry) => entry.id === "cloud-apps");

    expect(page).toMatchObject({
      id: "cloud-apps",
      pluginId: "@elizaos/app",
      label: "Cloud Apps",
      path: "/cloud-apps",
    });
    expect(page?.loader).toBeTypeOf("function");
  });
});
