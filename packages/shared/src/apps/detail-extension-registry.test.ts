/**
 * Tests for app detail extension registry lifecycle and component lookup.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RegistryAppInfo } from "../contracts/apps.ts";
import {
  clearDetailExtensionRegistry,
  getAppDetailExtension,
  getDetailExtension,
  registerDetailExtension,
  unregisterDetailExtension,
} from "./detail-extension-registry.ts";
import type { AppDetailExtensionComponent } from "./detail-extension-types.ts";

describe("detail-extension-registry", () => {
  beforeEach(() => {
    clearDetailExtensionRegistry();
  });

  afterEach(() => {
    clearDetailExtensionRegistry();
  });

  const MockPanelComponent: AppDetailExtensionComponent = (() =>
    null) as unknown as AppDetailExtensionComponent;

  it("registers and retrieves detail extension components", () => {
    expect(getDetailExtension("wallet-detail-panel")).toBeNull();

    registerDetailExtension("wallet-detail-panel", MockPanelComponent);
    expect(getDetailExtension("wallet-detail-panel")).toBe(MockPanelComponent);

    const app: RegistryAppInfo = {
      name: "wallet-app",
      displayName: "Wallet",
      description: "Crypto wallet",
      category: "finance",
      launchType: "tab",
      launchUrl: null,
      icon: "wallet",
      heroImage: null,
      capabilities: [],
      stars: 0,
      repository: "",
      latestVersion: null,
      supports: { v0: false, v1: false, v2: true },
      npm: {
        package: "wallet-app",
        v0Version: null,
        v1Version: null,
        v2Version: null,
      },
      uiExtension: {
        detailPanelId: "wallet-detail-panel",
      },
    };

    expect(getAppDetailExtension(app)).toBe(MockPanelComponent);
  });

  it("unregisters detail extension components", () => {
    registerDetailExtension("chat-detail-panel", MockPanelComponent);
    expect(getDetailExtension("chat-detail-panel")).toBe(MockPanelComponent);

    expect(unregisterDetailExtension("chat-detail-panel")).toBe(true);
    expect(getDetailExtension("chat-detail-panel")).toBeNull();
    expect(unregisterDetailExtension("chat-detail-panel")).toBe(false);
  });

  it("clears all detail extensions via clearDetailExtensionRegistry", () => {
    registerDetailExtension("panel-1", MockPanelComponent);
    registerDetailExtension("panel-2", MockPanelComponent);

    expect(getDetailExtension("panel-1")).toBe(MockPanelComponent);
    expect(getDetailExtension("panel-2")).toBe(MockPanelComponent);

    clearDetailExtensionRegistry();
    expect(getDetailExtension("panel-1")).toBeNull();
    expect(getDetailExtension("panel-2")).toBeNull();
  });

  it("returns null when app lacks uiExtension or detailPanelId is unknown", () => {
    const plainApp: RegistryAppInfo = {
      name: "plain-app",
      displayName: "Plain",
      description: "No extension",
      category: "tools",
      launchType: "tab",
      launchUrl: null,
      icon: "tool",
      heroImage: null,
      capabilities: [],
      stars: 0,
      repository: "",
      latestVersion: null,
      supports: { v0: false, v1: false, v2: true },
      npm: {
        package: "plain-app",
        v0Version: null,
        v1Version: null,
        v2Version: null,
      },
    };

    expect(getAppDetailExtension(plainApp)).toBeNull();
    expect(getAppDetailExtension(null)).toBeNull();
    expect(getAppDetailExtension(undefined)).toBeNull();
  });

  it("guards against invalid or empty registration arguments", () => {
    registerDetailExtension("", MockPanelComponent);
    registerDetailExtension(null as unknown as string, MockPanelComponent);
    registerDetailExtension(
      "valid-id",
      null as unknown as AppDetailExtensionComponent,
    );

    expect(getDetailExtension("")).toBeNull();
    expect(getDetailExtension("valid-id")).toBeNull();
    expect(unregisterDetailExtension(null as unknown as string)).toBe(false);
  });
});
