/**
 * Unit coverage for the app-shell page registry (register/list/snapshot). In-
 * memory registry, no runtime.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appShellAgentSurfaceDescriptor,
  appShellPageIsAvailable,
  appShellPageMatchesPath,
  buildRegisteredAgentSurfaceInventory,
  getAppShellPageRegistrySnapshot,
  listAppShellPages,
  overlayAgentSurfaceDescriptor,
  registerAppShellPage,
  subscribeAppShellPages,
} from "./app-shell-registry";
import { resetUiRegistryHostForTests } from "./registry-host";

describe("app-shell-registry", () => {
  beforeEach(() => {
    resetUiRegistryHostForTests();
  });

  it("stores metadata-only lazy registrations and notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAppShellPages(listener);
    const before = getAppShellPageRegistrySnapshot();
    const id = `test.lazy-page.${before}`;

    registerAppShellPage({
      id,
      pluginId: "test-plugin",
      label: "Lazy test page",
      path: `/test-lazy-page-${before}`,
      backgroundPolicy: "shared",
      loader: async () => ({ default: () => null }),
    });

    expect(getAppShellPageRegistrySnapshot()).toBe(before + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    const registration = listAppShellPages().find((entry) => entry.id === id);
    expect(registration).toEqual(
      expect.objectContaining({
        backgroundPolicy: "shared",
        id,
        loader: expect.any(Function),
      }),
    );
    expect(registration?.Component).toBeUndefined();

    unsubscribe();
    registerAppShellPage({
      id: `${id}.after-unsubscribe`,
      pluginId: "test-plugin",
      label: "Lazy test page after unsubscribe",
      path: `/test-lazy-page-${before}-after-unsubscribe`,
      loader: async () => ({ default: () => null }),
    });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("matches a page's concrete path and nested route patterns", () => {
    const page = {
      id: "cloud",
      pluginId: "test-plugin",
      label: "Cloud",
      path: "/dashboard",
      pathPatterns: ["/dashboard/*", "/invoices/:id"],
    };

    expect(appShellPageMatchesPath(page, "/dashboard")).toBe(true);
    expect(appShellPageMatchesPath(page, "/dashboard/agents/agent-1")).toBe(
      true,
    );
    expect(
      appShellPageMatchesPath(page, "/invoices/invoice-1?download=1"),
    ).toBe(true);
    expect(appShellPageMatchesPath(page, "/dashboardish")).toBe(false);
    expect(appShellPageMatchesPath(page, "/invoices/a/extra")).toBe(false);
  });

  it("enforces managed-cloud availability from one registration contract", () => {
    const page = {
      id: "cloud",
      pluginId: "test-plugin",
      label: "Cloud",
      path: "/cloud",
      availability: "managed-cloud" as const,
    };

    expect(appShellPageIsAvailable(page, { managedCloud: false })).toBe(false);
    expect(appShellPageIsAvailable(page, { managedCloud: true })).toBe(true);
    expect(
      appShellPageIsAvailable(
        { ...page, availability: "always" },
        { managedCloud: false },
      ),
    ).toBe(true);
  });

  it("derives the exhaustive app-shell and overlay agent-bridge inventory", () => {
    const page = {
      id: "wallet.inventory",
      pluginId: "@elizaos/plugin-wallet",
      label: "Wallet",
      path: "/inventory",
    };
    const overlay = {
      name: "@elizaos/plugin-native-settings",
      displayName: "Device Settings",
      description: "Device settings",
      category: "system",
      icon: null,
    };

    expect(appShellAgentSurfaceDescriptor(page)).toEqual({
      kind: "app-shell",
      viewId: "wallet.inventory",
      ownerId: "@elizaos/plugin-wallet",
      path: "/inventory",
    });
    expect(overlayAgentSurfaceDescriptor(overlay)).toEqual({
      kind: "overlay",
      viewId: "native-settings",
      ownerId: "@elizaos/plugin-native-settings",
      path: "/apps/native-settings",
    });
    expect(
      buildRegisteredAgentSurfaceInventory([page], [overlay]).map(
        ({ viewId }) => viewId,
      ),
    ).toEqual(["native-settings", "wallet.inventory"]);
  });

  it("fails closed when two registered renderers would own one handler key", () => {
    expect(() =>
      buildRegisteredAgentSurfaceInventory(
        [
          {
            id: "contacts",
            pluginId: "@elizaos/plugin-contacts-page",
            label: "Contacts",
            path: "/contacts",
          },
        ],
        [
          {
            name: "@elizaos/plugin-contacts",
            displayName: "Contacts",
            description: "Contacts",
            category: "system",
            icon: null,
          },
        ],
      ),
    ).toThrow(/registered by both app-shell:.* and overlay:/);
  });

  it("rejects empty app-shell ids before they reach the bridge", () => {
    expect(() =>
      appShellAgentSurfaceDescriptor({
        id: "  ",
        pluginId: "test-plugin",
        label: "Invalid",
        path: "/invalid",
      }),
    ).toThrow(/empty agent view id/);
  });
});
