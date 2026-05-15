/**
 * Views action scenario tests.
 *
 * Tests user-intent scenarios against the views registry directly — no live
 * LLM required. The registry module is reset between tests via module-level
 * isolation so each case starts with a clean slate.
 */

import type { Plugin } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Inline registry isolation helpers
// ---------------------------------------------------------------------------

// The registry is a module-level Map in views-registry.ts. We reset it
// between tests by importing the register/unregister functions directly and
// unregistering what we registered rather than mocking the module, so the
// real implementation is exercised.
import {
  listViews,
  registerPluginViews,
  unregisterPluginViews,
  getView,
} from "../api/views-registry.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makePlugin(
  name: string,
  views: Plugin["views"],
  extra: Partial<Plugin> = {},
): Plugin {
  return {
    name,
    description: `Test plugin ${name}`,
    actions: [],
    views,
    ...extra,
  };
}

const WALLET_VIEW = {
  id: "wallet.inventory",
  label: "Wallet",
  description: "Manage your crypto wallet and assets",
  icon: "Wallet",
  path: "/wallet",
  order: 10,
  tags: ["finance", "crypto"],
};

const TRADING_VIEW = {
  id: "trading.dashboard",
  label: "Trading",
  description: "Buy and sell tokens on DEX markets",
  icon: "TrendingUp",
  path: "/trading",
  order: 20,
  tags: ["finance", "crypto", "dex"],
};

const CHAT_VIEW = {
  id: "chat.main",
  label: "Chat",
  description: "Conversation interface with the agent",
  icon: "MessageSquare",
  path: "/chat",
  order: 1,
  tags: ["communication"],
};

const SETTINGS_VIEW = {
  id: "settings.main",
  label: "Settings",
  description: "Configure the assistant and connected apps",
  icon: "Settings",
  path: "/settings",
  order: 99,
  tags: ["configuration"],
};

const DEV_VIEW = {
  id: "dev.logs",
  label: "Dev Logs",
  description: "Structured log viewer for developers",
  icon: "Terminal",
  path: "/dev/logs",
  order: 200,
  developerOnly: true,
  tags: ["developer"],
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const TEST_PLUGIN_NAMES = [
  "test-wallet-plugin",
  "test-trading-plugin",
  "test-chat-plugin",
  "test-settings-plugin",
  "test-dev-plugin",
];

beforeEach(async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  // Clean up all views registered by these tests.
  for (const name of TEST_PLUGIN_NAMES) {
    unregisterPluginViews(name);
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Scenario: "show me all views" → returns view list
// ---------------------------------------------------------------------------

describe('scenario: "show me all views"', () => {
  it("returns all registered views with label and description", async () => {
    await registerPluginViews(
      makePlugin("test-wallet-plugin", [WALLET_VIEW]),
      undefined,
    );
    await registerPluginViews(
      makePlugin("test-chat-plugin", [CHAT_VIEW]),
      undefined,
    );

    const views = listViews();

    expect(views.length).toBeGreaterThanOrEqual(2);
    const ids = views.map((v) => v.id);
    expect(ids).toContain("wallet.inventory");
    expect(ids).toContain("chat.main");

    for (const view of views) {
      expect(view.label).toBeTruthy();
      // description is optional on the type but our fixtures set it
      expect(view.id).toBeTruthy();
    }
  });

  it("returns views sorted by order field ascending", async () => {
    await registerPluginViews(
      makePlugin("test-settings-plugin", [SETTINGS_VIEW]),
      undefined,
    );
    await registerPluginViews(
      makePlugin("test-wallet-plugin", [WALLET_VIEW]),
      undefined,
    );
    await registerPluginViews(
      makePlugin("test-chat-plugin", [CHAT_VIEW]),
      undefined,
    );

    const views = listViews();
    const orders = views
      .filter((v) =>
        ["chat.main", "wallet.inventory", "settings.main"].includes(v.id),
      )
      .map((v) => v.order ?? 100);

    for (let i = 1; i < orders.length; i++) {
      expect(orders[i]).toBeGreaterThanOrEqual(orders[i - 1]!);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario: "open wallet" → wallet view is accessible by id
// ---------------------------------------------------------------------------

describe('scenario: "open wallet"', () => {
  it("wallet view can be retrieved by its stable id after registration", async () => {
    await registerPluginViews(
      makePlugin("test-wallet-plugin", [WALLET_VIEW]),
      undefined,
    );

    const view = getView("wallet.inventory");
    expect(view).toBeDefined();
    expect(view?.label).toBe("Wallet");
    expect(view?.path).toBe("/wallet");
    expect(view?.pluginName).toBe("test-wallet-plugin");
  });

  it("looking up an unknown view id returns undefined", () => {
    const view = getView("nonexistent.view");
    expect(view).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario: "find views for trading" → returns trading-tagged views
// ---------------------------------------------------------------------------

describe('scenario: "find views for trading / crypto"', () => {
  it("views tagged with finance/crypto appear in the registry", async () => {
    await registerPluginViews(
      makePlugin("test-wallet-plugin", [WALLET_VIEW]),
      undefined,
    );
    await registerPluginViews(
      makePlugin("test-trading-plugin", [TRADING_VIEW]),
      undefined,
    );
    await registerPluginViews(
      makePlugin("test-chat-plugin", [CHAT_VIEW]),
      undefined,
    );

    const views = listViews();
    const financeViews = views.filter((v) =>
      v.tags?.some((t) => ["finance", "crypto", "dex"].includes(t)),
    );

    expect(financeViews.length).toBeGreaterThanOrEqual(2);
    const financeIds = financeViews.map((v) => v.id);
    expect(financeIds).toContain("wallet.inventory");
    expect(financeIds).toContain("trading.dashboard");
    // chat should not be in finance-tagged results
    expect(financeIds).not.toContain("chat.main");
  });

  it("returns views matching a tag when filtered by the caller", async () => {
    await registerPluginViews(
      makePlugin("test-wallet-plugin", [WALLET_VIEW]),
      undefined,
    );
    await registerPluginViews(
      makePlugin("test-trading-plugin", [TRADING_VIEW]),
      undefined,
    );

    const views = listViews();
    const cryptoViews = views.filter((v) => v.tags?.includes("crypto"));
    expect(cryptoViews.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Scenario: developer-only view filtering
// ---------------------------------------------------------------------------

describe('scenario: "open view manager" — developer-only views hidden', () => {
  it("developer-only view is excluded from normal listing", async () => {
    await registerPluginViews(
      makePlugin("test-dev-plugin", [DEV_VIEW]),
      undefined,
    );
    await registerPluginViews(
      makePlugin("test-chat-plugin", [CHAT_VIEW]),
      undefined,
    );

    const normalViews = listViews({ developerMode: false });
    const devView = normalViews.find((v) => v.id === "dev.logs");
    expect(devView).toBeUndefined();
  });

  it("developer-only view appears when developerMode=true", async () => {
    await registerPluginViews(
      makePlugin("test-dev-plugin", [DEV_VIEW]),
      undefined,
    );

    const devViews = listViews({ developerMode: true });
    const devView = devViews.find((v) => v.id === "dev.logs");
    expect(devView).toBeDefined();
    expect(devView?.developerOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario: plugin unregistration removes views
// ---------------------------------------------------------------------------

describe('scenario: "close / uninstall plugin removes its views"', () => {
  it("unregistering a plugin removes all its views from the list", async () => {
    await registerPluginViews(
      makePlugin("test-wallet-plugin", [WALLET_VIEW]),
      undefined,
    );
    await registerPluginViews(
      makePlugin("test-chat-plugin", [CHAT_VIEW]),
      undefined,
    );

    // Confirm both are present.
    expect(listViews().map((v) => v.id)).toContain("wallet.inventory");
    expect(listViews().map((v) => v.id)).toContain("chat.main");

    unregisterPluginViews("test-wallet-plugin");

    const afterUnregister = listViews().map((v) => v.id);
    expect(afterUnregister).not.toContain("wallet.inventory");
    expect(afterUnregister).toContain("chat.main");
  });

  it("unregistering an unknown plugin name is a no-op", () => {
    expect(() => unregisterPluginViews("plugin-that-never-existed")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Scenario: re-registering a plugin updates its views
// ---------------------------------------------------------------------------

describe("scenario: plugin view update on re-registration", () => {
  it("re-registering the same plugin id overwrites existing view entry", async () => {
    await registerPluginViews(
      makePlugin("test-wallet-plugin", [WALLET_VIEW]),
      undefined,
    );

    const first = getView("wallet.inventory");
    expect(first?.label).toBe("Wallet");

    const updated = { ...WALLET_VIEW, label: "My Wallet Updated" };
    await registerPluginViews(
      makePlugin("test-wallet-plugin", [updated]),
      undefined,
    );

    const second = getView("wallet.inventory");
    expect(second?.label).toBe("My Wallet Updated");
  });
});

// ---------------------------------------------------------------------------
// Scenario: plugin with no views is a no-op
// ---------------------------------------------------------------------------

describe("scenario: plugin with no views declared", () => {
  it("registerPluginViews with empty views array is a no-op", async () => {
    const countBefore = listViews({ developerMode: true }).length;
    await registerPluginViews(
      makePlugin("test-wallet-plugin", []),
      undefined,
    );
    const countAfter = listViews({ developerMode: true }).length;
    expect(countAfter).toBe(countBefore);
  });

  it("registerPluginViews with undefined views is a no-op", async () => {
    const countBefore = listViews({ developerMode: true }).length;
    await registerPluginViews(
      makePlugin("test-wallet-plugin", undefined),
      undefined,
    );
    const countAfter = listViews({ developerMode: true }).length;
    expect(countAfter).toBe(countBefore);
  });
});

// ---------------------------------------------------------------------------
// Scenario: view metadata is fully preserved
// ---------------------------------------------------------------------------

describe("scenario: view metadata integrity", () => {
  it("all declared fields are preserved in the registry entry", async () => {
    const richView = {
      id: "wallet.inventory",
      label: "Wallet",
      description: "Manage your crypto wallet and assets",
      icon: "Wallet",
      path: "/wallet",
      order: 10,
      tags: ["finance", "crypto"],
      componentExport: "WalletView",
      desktopTabEnabled: true,
      visibleInManager: true,
      capabilities: [
        {
          id: "check-balance",
          description: "Read the current token balances",
        },
      ],
    };

    await registerPluginViews(
      makePlugin("test-wallet-plugin", [richView]),
      undefined,
    );

    const entry = getView("wallet.inventory");
    expect(entry).toBeDefined();
    expect(entry?.description).toBe(richView.description);
    expect(entry?.icon).toBe("Wallet");
    expect(entry?.tags).toEqual(["finance", "crypto"]);
    expect(entry?.capabilities).toHaveLength(1);
    expect(entry?.capabilities?.[0]?.id).toBe("check-balance");
    expect(entry?.componentExport).toBe("WalletView");
  });

  it("entry includes pluginName, available, and loadedAt metadata", async () => {
    const before = Date.now();
    await registerPluginViews(
      makePlugin("test-wallet-plugin", [WALLET_VIEW]),
      undefined,
    );
    const after = Date.now();

    const entry = getView("wallet.inventory");
    expect(entry?.pluginName).toBe("test-wallet-plugin");
    expect(entry?.available).toBe(false); // no pluginDir → no bundle on disk
    expect(entry?.loadedAt).toBeGreaterThanOrEqual(before);
    expect(entry?.loadedAt).toBeLessThanOrEqual(after);
  });
});
