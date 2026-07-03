import { afterEach, describe, expect, it } from "vitest";
import { registerAppShellPage } from "../app-shell-registry";
import { tabFromPath } from "./index";

const REGISTRY_KEY = Symbol.for("elizaos.app-core.app-shell-page-registry");

interface RegistryStoreShape {
  entries: Map<string, unknown>;
  version: number;
  listeners: Set<() => void>;
}

function clearTestRegistration(id: string): void {
  const store = (globalThis as Record<PropertyKey, unknown>)[REGISTRY_KEY] as
    | RegistryStoreShape
    | undefined;
  if (!store) return;
  if (!store.entries.delete(id)) return;
  store.version += 1;
  for (const listener of store.listeners) listener();
}

afterEach(() => {
  clearTestRegistration("test.wallet.inventory");
  clearTestRegistration("test.phone-companion");
  clearTestRegistration("test.unaffiliated");
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
});
