/**
 * Unit coverage for path→tab resolution against the app-shell registry. In-memory
 * registry, no runtime.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAppShellPage } from "../app-shell-registry";
import { resetUiRegistryHostForTests } from "../registry-host";
import { ALL_TAB_GROUPS, tabFromPath } from "./index";

beforeEach(() => {
  resetUiRegistryHostForTests();
});

afterEach(() => {
  resetUiRegistryHostForTests();
});

describe("navigation tabFromPath", () => {
  it("uses app-shell tab affinity for registered plugin pages", () => {
    registerAppShellPage({
      id: "test.wallet.inventory",
      pluginId: "@elizaos/plugin-wallet-ui",
      label: "Wallet",
      path: "/test/inventory",
      tabAffinity: "inventory",
      loader: async () => ({ default: () => null }),
    });

    expect(tabFromPath("/test/inventory")).toBe("inventory");
  });

  it("falls back to the app-shell page id when no tab affinity is declared", () => {
    registerAppShellPage({
      id: "test.unaffiliated",
      pluginId: "test-plugin",
      label: "Unaffiliated",
      path: "/test/unaffiliated",
      loader: async () => ({ default: () => null }),
    });

    expect(tabFromPath("/test/unaffiliated")).toBe("test.unaffiliated");
  });

  it("routes phone companion from its registration metadata", () => {
    registerAppShellPage({
      id: "test.phone-companion",
      pluginId: "@elizaos/plugin-phone",
      label: "Phone Companion",
      path: "/test/phone-companion",
      tabAffinity: "test.phone-companion",
      loader: async () => ({ default: () => null }),
    });

    expect(tabFromPath("/test/phone-companion")).toBe("test.phone-companion");
  });

  it("builds wallet launcher grouping from app-shell page group metadata", () => {
    registerAppShellPage({
      id: "test.wallet",
      pluginId: "test-wallet",
      label: "Wallet",
      path: "/inventory",
      tabAffinity: "inventory",
      group: "wallet",
      order: 10,
      loader: async () => ({ default: () => null }),
    });
    registerAppShellPage({
      id: "test.perps",
      pluginId: "test-perps",
      label: "Perps",
      path: "/perps",
      tabAffinity: "inventory",
      group: "wallet",
      order: 20,
      loader: async () => ({ default: () => null }),
    });

    const walletGroup = ALL_TAB_GROUPS.find(
      (group) => group.label === "Wallet",
    );
    expect(walletGroup?.tabs).toEqual(["inventory", "test.perps"]);
  });
});
