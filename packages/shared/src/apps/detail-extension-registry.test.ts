/**
 * Unit tests for app detail extension component registry.
 */

import { describe, expect, it } from "vitest";
import type { RegistryAppInfo } from "../contracts/apps.js";
import {
  getAppDetailExtension,
  registerDetailExtension,
} from "./detail-extension-registry.js";
import type { AppDetailExtensionComponent } from "./detail-extension-types.js";

function makeApp(
  uiExtension?: RegistryAppInfo["uiExtension"],
): RegistryAppInfo {
  return {
    name: "test-app",
    displayName: "Test App",
    description: "App description",
    category: "tools",
    launchType: "overlay",
    launchUrl: null,
    icon: "test-icon",
    heroImage: null,
    capabilities: [],
    stars: 0,
    repository: "",
    latestVersion: null,
    supports: { v0: false, v1: false, v2: true },
    npm: {
      package: "test-app",
      v0Version: null,
      v1Version: null,
      v2Version: null,
    },
    uiExtension,
  };
}

describe("detail extension registry", () => {
  it("registers and retrieves component for app with matching detailPanelId", () => {
    const dummyComponent: AppDetailExtensionComponent = (() =>
      null) as unknown as AppDetailExtensionComponent;

    registerDetailExtension("my-custom-panel", dummyComponent);

    const appWithExtension = makeApp({
      detailPanelId: "my-custom-panel",
    });

    const retrieved = getAppDetailExtension(appWithExtension);
    expect(retrieved).toBe(dummyComponent);
  });

  it("returns null when app has no uiExtension or detailPanelId", () => {
    const appWithoutExtension = makeApp(undefined);
    expect(getAppDetailExtension(appWithoutExtension)).toBeNull();

    const appWithEmptyId = makeApp({
      detailPanelId: "",
    });
    expect(getAppDetailExtension(appWithEmptyId)).toBeNull();
  });

  it("returns null when detailPanelId is not registered in the registry", () => {
    const appWithUnregisteredId = makeApp({
      detailPanelId: "unregistered-panel-123",
    });
    expect(getAppDetailExtension(appWithUnregisteredId)).toBeNull();
  });
});
