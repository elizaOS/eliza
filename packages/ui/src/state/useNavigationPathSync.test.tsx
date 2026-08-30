/** Verifies useNavigationPathSync — app-shell registry reactivity through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * App-shell cold deep links reconcile against idle-loaded registrations while
 * preserving the browser path that names the exact owning page.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAppShellPage } from "../app-shell-registry";
import type { Tab } from "../navigation";
import { resetUiRegistryHostForTests } from "../registry-host";
import { useNavigationPathSync } from "./useAppProviderEffects";

afterEach(() => {
  resetUiRegistryHostForTests();
  window.history.replaceState(null, "", "/");
});

describe("useNavigationPathSync — app-shell registry reactivity", () => {
  it.each(["/documents", "/knowledge"])(
    "replaces the retired Knowledge path %s with the canonical registry route",
    (legacyPath) => {
      window.history.replaceState(null, "", `${legacyPath}?source=bookmark`);
      const setTabRaw = vi.fn();

      renderHook(() =>
        useNavigationPathSync({ tab: "views" as Tab, setTabRaw }),
      );

      expect(window.location.pathname).toBe("/character/documents");
      expect(window.location.search).toBe("?source=bookmark");
      expect(setTabRaw).toHaveBeenCalledWith("documents");
    },
  );

  it("canonicalizes a retired Knowledge hash route in app-window navigation", () => {
    window.history.replaceState(null, "", "/index.html?appWindow=1#/knowledge");
    const setTabRaw = vi.fn();

    renderHook(() => useNavigationPathSync({ tab: "views" as Tab, setTabRaw }));

    expect(window.location.pathname).toBe("/index.html");
    expect(window.location.search).toBe("?appWindow=1");
    expect(window.location.hash).toBe("#/character/documents");
    expect(setTabRaw).toHaveBeenCalledWith("documents");
  });

  it("reconciles the active tab when a deep-linked app-shell page registers late", () => {
    window.history.replaceState(null, "", "/apps/custom-panel");

    const setTabRaw = vi.fn();
    // Boot landed on the apps catalog: `/apps/custom-panel` has no
    // registration yet, so `tabFromPath` resolves it to "apps".
    renderHook(() => useNavigationPathSync({ tab: "apps" as Tab, setTabRaw }));
    expect(setTabRaw).not.toHaveBeenCalledWith("custom-panel");

    // The idle-loaded side-effect module finally registers the page.
    act(() => {
      registerAppShellPage({
        id: "custom-panel",
        pluginId: "@elizaos/plugin-custom-panel",
        label: "Custom Panel",
        path: "/apps/custom-panel",
        loader: async () => ({ default: () => null }),
      });
    });

    // The registry-version bump re-runs the sync effect, which now resolves the
    // URL to the real page and reconciles the active tab.
    expect(setTabRaw).toHaveBeenCalledWith("custom-panel");
  });

  it("leaves the tab alone when the URL already matches the active tab", () => {
    // Page already registered (no race) and the active tab already matches the
    // URL: the sync effect must not dispatch a redundant reconciliation.
    registerAppShellPage({
      id: "custom-panel",
      pluginId: "@elizaos/plugin-custom-panel",
      label: "Custom Panel",
      path: "/apps/custom-panel",
      loader: async () => ({ default: () => null }),
    });
    window.history.replaceState(null, "", "/apps/custom-panel");

    const setTabRaw = vi.fn();
    renderHook(() =>
      useNavigationPathSync({ tab: "custom-panel" as Tab, setTabRaw }),
    );

    // routeTab === tab, so no redundant reconciliation is dispatched.
    expect(setTabRaw).not.toHaveBeenCalled();
  });

  it.each([
    {
      path: "/inventory",
      registrations: [
        {
          id: "wallet.activity",
          pluginId: "@elizaos/plugin-wallet:ui",
          label: "Activity",
          path: "/wallet/activity",
        },
        {
          id: "wallet.markets",
          pluginId: "@elizaos/plugin-wallet:ui",
          label: "Markets",
          path: "/wallet/markets",
        },
        {
          id: "wallet.inventory",
          pluginId: "@elizaos/plugin-wallet:ui",
          label: "Wallet",
          path: "/inventory",
        },
      ],
    },
    {
      path: "/wallet/activity",
      registrations: [
        {
          id: "wallet.inventory",
          pluginId: "@elizaos/plugin-wallet:ui",
          label: "Wallet",
          path: "/inventory",
        },
        {
          id: "wallet.markets",
          pluginId: "@elizaos/plugin-wallet:ui",
          label: "Markets",
          path: "/wallet/markets",
        },
        {
          id: "wallet.activity",
          pluginId: "@elizaos/plugin-wallet:ui",
          label: "Activity",
          path: "/wallet/activity",
        },
      ],
    },
    {
      path: "/wallet/markets",
      registrations: [
        {
          id: "wallet.activity",
          pluginId: "@elizaos/plugin-wallet:ui",
          label: "Activity",
          path: "/wallet/activity",
        },
        {
          id: "wallet.inventory",
          pluginId: "@elizaos/plugin-wallet:ui",
          label: "Wallet",
          path: "/inventory",
        },
        {
          id: "wallet.markets",
          pluginId: "@elizaos/plugin-wallet:ui",
          label: "Markets",
          path: "/wallet/markets",
        },
      ],
    },
  ])(
    "keeps $path until its exact wallet-family owner registers",
    ({ path, registrations }) => {
      window.history.replaceState(null, "", path);
      const setTabRaw = vi.fn();
      renderHook(() =>
        useNavigationPathSync({ tab: "views" as Tab, setTabRaw }),
      );

      for (const registration of registrations) {
        act(() => {
          registerAppShellPage({
            ...registration,
            tabAffinity: "inventory",
            loader: async () => ({ default: () => null }),
          });
        });
        expect(window.location.pathname).toBe(path);
      }

      expect(setTabRaw).toHaveBeenCalledTimes(1);
      expect(setTabRaw).toHaveBeenLastCalledWith("inventory");
    },
  );
});
