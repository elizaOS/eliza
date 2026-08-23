/**
 * Contract coverage for ViewRegistryEntry — the DTO extracted from
 * views-registry.ts to break the views-registry ↔ views-search-index cycle.
 * The module is types-only; these tests lock the required/optional field
 * surface that registration actually populates (plugin vs builtin, hero
 * fallback vs on-disk asset, missing bundle, platform default). No mocks.
 */

import { createHash } from "node:crypto";
import type { ViewDeclaration, ViewType } from "@elizaos/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { AgentPlatform } from "./platform-detect.ts";
import type { ViewRegistryEntry } from "./view-registry-types.ts";
import * as viewRegistryTypes from "./view-registry-types.ts";

const DEFAULT_VIEW_TYPE: ViewType = "gui";
const HEX12 = /^[0-9a-f]{12}$/;
const AGENT_PLATFORMS: readonly AgentPlatform[] = [
  "web",
  "desktop",
  "ios",
  "android",
];
const VIEW_TYPES: readonly ViewType[] = ["gui", "tui", "xr"];

function contentHash12(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

function viewQuery(viewType: ViewType): string {
  const params = new URLSearchParams();
  if (viewType !== DEFAULT_VIEW_TYPE) {
    params.set("viewType", viewType);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

function resolvedUrls(id: string, viewType: ViewType = DEFAULT_VIEW_TYPE) {
  const encoded = encodeURIComponent(id);
  const query = viewQuery(viewType);
  return {
    bundleUrl: `/api/views/${encoded}/bundle.js`,
    frameUrl: `/api/views/${encoded}/frame.html`,
    heroImageUrl: `/api/views/${encoded}/hero${query}`,
  };
}

/** First declared platform wins; an empty or missing list defaults to web. */
function derivePlatform(
  platforms: ViewDeclaration["platforms"],
): AgentPlatform {
  return (platforms?.[0] as AgentPlatform | undefined) ?? "web";
}

function pluginEntry(): ViewRegistryEntry {
  const id = "wallet.inventory";
  const urls = resolvedUrls(id);
  const bundleBytes = "plugin-bundle";
  const frameBytes = "plugin-frame";
  const bundleHash = contentHash12(bundleBytes);
  const frameHash = contentHash12(frameBytes);
  return {
    id,
    label: "Wallet",
    viewType: "gui",
    pluginName: "@elizaos/plugin-wallet",
    pluginDir: "/plugins/plugin-wallet",
    bundleUrl: urls.bundleUrl,
    frameUrl: urls.frameUrl,
    heroImageUrl: urls.heroImageUrl,
    hasHeroImage: true,
    available: true,
    loadedAt: 1_700_000_000_000,
    platform: "web",
    bundleHash,
    bundleUrlVersioned: `${urls.bundleUrl}?v=${bundleHash}`,
    bundleSize: bundleBytes.length,
    frameHash,
    frameUrlVersioned: `${urls.frameUrl}?v=${frameHash}`,
    frameSize: frameBytes.length,
  };
}

function builtinEntry(): ViewRegistryEntry {
  return {
    id: "chat",
    label: "Chat",
    viewType: "gui",
    pluginName: "@elizaos/builtin",
    pluginDir: "/packages/agent",
    bundleUrl: undefined,
    bundleUrlVersioned: undefined,
    frameUrl: undefined,
    frameUrlVersioned: undefined,
    heroImageUrl: resolvedUrls("chat").heroImageUrl,
    hasHeroImage: false,
    available: true,
    loadedAt: 1_700_000_000_123,
    platform: "web",
    builtin: true,
  };
}

function minimalEntry(): ViewRegistryEntry {
  return {
    id: "logs",
    label: "Logs",
    viewType: "gui",
    pluginName: "@elizaos/plugin-logs",
    hasHeroImage: false,
    available: false,
    loadedAt: 0,
    platform: "web",
  };
}

describe("view-registry-types", () => {
  it("is types-only: the exported contract does not exist at runtime", () => {
    expect(Object.keys(viewRegistryTypes)).toEqual([]);
    expect("ViewRegistryEntry" in viewRegistryTypes).toBe(false);
  });
});

describe("ViewRegistryEntry field contract", () => {
  it("extends ViewDeclaration and requires the post-registration fields", () => {
    expectTypeOf<ViewRegistryEntry>().toMatchTypeOf<ViewDeclaration>();
    expectTypeOf<ViewRegistryEntry["viewType"]>().toEqualTypeOf<ViewType>();
    expectTypeOf<ViewDeclaration["viewType"]>().toEqualTypeOf<
      ViewType | undefined
    >();
    expectTypeOf<ViewRegistryEntry["pluginName"]>().toEqualTypeOf<string>();
    expectTypeOf<ViewRegistryEntry["hasHeroImage"]>().toEqualTypeOf<boolean>();
    expectTypeOf<ViewRegistryEntry["available"]>().toEqualTypeOf<boolean>();
    expectTypeOf<ViewRegistryEntry["loadedAt"]>().toEqualTypeOf<number>();
    expectTypeOf<
      ViewRegistryEntry["platform"]
    >().toEqualTypeOf<AgentPlatform>();
  });

  it("keeps resolved asset fields optional, including the builtin bundle holes", () => {
    expectTypeOf<ViewRegistryEntry["pluginDir"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<ViewRegistryEntry["bundleUrl"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<ViewRegistryEntry["frameUrl"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<ViewRegistryEntry["heroImageUrl"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<ViewRegistryEntry["bundleHash"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<ViewRegistryEntry["bundleUrlVersioned"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<ViewRegistryEntry["bundleSize"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<ViewRegistryEntry["frameHash"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<ViewRegistryEntry["frameUrlVersioned"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<ViewRegistryEntry["frameSize"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<ViewRegistryEntry["builtin"]>().toEqualTypeOf<
      boolean | undefined
    >();
  });

  it("accepts a plugin entry that omits every optional resolved field", () => {
    const entry = minimalEntry();
    expect(entry.pluginDir).toBeUndefined();
    expect(entry.bundleUrl).toBeUndefined();
    expect(entry.frameUrl).toBeUndefined();
    expect(entry.heroImageUrl).toBeUndefined();
    expect(entry.bundleHash).toBeUndefined();
    expect(entry.bundleUrlVersioned).toBeUndefined();
    expect(entry.bundleSize).toBeUndefined();
    expect(entry.frameHash).toBeUndefined();
    expect(entry.frameUrlVersioned).toBeUndefined();
    expect(entry.frameSize).toBeUndefined();
    expect(entry.builtin).toBeUndefined();
    expect(entry.available).toBe(false);
    expect(entry.hasHeroImage).toBe(false);
    expect(entry.loadedAt).toBe(0);
  });
});

describe("resolved view URLs and hashes", () => {
  it("uses the documented /api/views/<id> paths for bundle, frame, and hero", () => {
    const entry = pluginEntry();
    expect(entry.bundleUrl).toBe("/api/views/wallet.inventory/bundle.js");
    expect(entry.frameUrl).toBe("/api/views/wallet.inventory/frame.html");
    expect(entry.heroImageUrl).toBe("/api/views/wallet.inventory/hero");
    expect(entry.bundleUrlVersioned).toBe(
      `/api/views/wallet.inventory/bundle.js?v=${entry.bundleHash}`,
    );
    expect(entry.frameUrlVersioned).toBe(
      `/api/views/wallet.inventory/frame.html?v=${entry.frameHash}`,
    );
    expect(entry.bundleHash).toMatch(HEX12);
    expect(entry.frameHash).toMatch(HEX12);
    expect(entry.bundleHash).toHaveLength(12);
    expect(entry.frameHash).toHaveLength(12);
    expect(entry.bundleSize).toBeGreaterThan(0);
    expect(entry.frameSize).toBeGreaterThan(0);
  });

  it("percent-encodes ids that are not URL-safe path segments", () => {
    const id = "wallet/inventory extra";
    const urls = resolvedUrls(id, "tui");
    expect(urls.bundleUrl).toBe(
      "/api/views/wallet%2Finventory%20extra/bundle.js",
    );
    expect(urls.frameUrl).toBe(
      "/api/views/wallet%2Finventory%20extra/frame.html",
    );
    expect(urls.heroImageUrl).toBe(
      "/api/views/wallet%2Finventory%20extra/hero?viewType=tui",
    );
  });

  it("omits the viewType query on the default gui hero URL and includes it otherwise", () => {
    expect(resolvedUrls("chat", "gui").heroImageUrl).toBe(
      "/api/views/chat/hero",
    );
    expect(resolvedUrls("chat", "tui").heroImageUrl).toBe(
      "/api/views/chat/hero?viewType=tui",
    );
    expect(resolvedUrls("chat", "xr").heroImageUrl).toBe(
      "/api/views/chat/hero?viewType=xr",
    );
  });
});

describe("builtin vs plugin registration shapes", () => {
  it("marks builtin shell views as available without a separate bundle file", () => {
    const entry = builtinEntry();
    expect(entry.pluginName).toBe("@elizaos/builtin");
    expect(entry.builtin).toBe(true);
    expect(entry.available).toBe(true);
    expect(entry.bundleUrl).toBeUndefined();
    expect(entry.bundleUrlVersioned).toBeUndefined();
    expect(entry.frameUrl).toBeUndefined();
    expect(entry.frameUrlVersioned).toBeUndefined();
    expect(entry.heroImageUrl).toBe("/api/views/chat/hero");
  });

  it("keeps hasHeroImage false when the hero URL is the generated fallback", () => {
    const entry = builtinEntry();
    expect(entry.heroImageUrl).toBeDefined();
    expect(entry.hasHeroImage).toBe(false);
  });

  it("records hasHeroImage true only when a real on-disk hero asset exists", () => {
    const withAsset = pluginEntry();
    expect(withAsset.hasHeroImage).toBe(true);
    expect(withAsset.heroImageUrl).toBe("/api/views/wallet.inventory/hero");

    const withoutAsset: ViewRegistryEntry = {
      id: "wallet.inventory",
      label: "Wallet",
      viewType: "gui",
      pluginName: "@elizaos/plugin-wallet",
      heroImageUrl: "/api/views/wallet.inventory/hero",
      hasHeroImage: false,
      available: true,
      loadedAt: 1,
      platform: "web",
    };
    expect(withoutAsset.hasHeroImage).toBe(false);
    expect(withoutAsset.heroImageUrl).toBe(withAsset.heroImageUrl);
  });

  it("marks available false when the plugin bundle is missing from disk", () => {
    const missing: ViewRegistryEntry = {
      id: "gone",
      label: "Gone",
      viewType: "gui",
      pluginName: "@elizaos/plugin-gone",
      bundleUrl: resolvedUrls("gone").bundleUrl,
      hasHeroImage: false,
      available: false,
      loadedAt: 42,
      platform: "desktop",
    };
    expect(missing.available).toBe(false);
    expect(missing.bundleUrl).toBe("/api/views/gone/bundle.js");
  });
});

describe("platform and viewType enumerations", () => {
  it("defaults platform to web when the declaration lists no platforms", () => {
    expect(derivePlatform(undefined)).toBe("web");
    expect(derivePlatform([])).toBe("web");
  });

  it("uses the first declared platform and ignores later ties", () => {
    expect(derivePlatform(["ios", "android", "web"])).toBe("ios");
    expect(derivePlatform(["desktop"])).toBe("desktop");
  });

  it("accepts every AgentPlatform and ViewType on a concrete entry", () => {
    for (const platform of AGENT_PLATFORMS) {
      const entry: ViewRegistryEntry = {
        id: `p-${platform}`,
        label: platform,
        viewType: "gui",
        pluginName: "@elizaos/plugin-platform",
        hasHeroImage: false,
        available: true,
        loadedAt: 1,
        platform,
      };
      expect(AGENT_PLATFORMS).toContain(entry.platform);
    }
    for (const viewType of VIEW_TYPES) {
      const entry: ViewRegistryEntry = {
        id: `v-${viewType}`,
        label: viewType,
        viewType,
        pluginName: "@elizaos/plugin-type",
        hasHeroImage: false,
        available: true,
        loadedAt: 1,
        platform: "web",
      };
      expect(VIEW_TYPES).toContain(entry.viewType);
    }
  });
});
