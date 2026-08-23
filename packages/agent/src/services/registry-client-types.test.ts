/**
 * Behavioural coverage for registry-client-types: the type-only DTO surface
 * (RegistryAppMeta, RegistryPluginInfo, RegistrySearchResult,
 * RegistryPluginListItem) plus the real query/projection helpers that consume
 * those shapes — empty-map lookup, missing-key removal, exact and alias hits,
 * score ordering/ties/overflow, and search/list/app DTO mapping. No mocks of
 * the types module or of the projectors.
 */
import type {
  AppSessionConfig,
  AppSessionFeature,
  AppSessionMode,
  AppViewerConfig,
  AppUiExtensionConfig as SharedAppUiExtensionConfig,
  RegistryAppInfo as SharedRegistryAppInfo,
} from "@elizaos/shared";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  LOCAL_APP_DEFAULT_SANDBOX,
  resolveAppOverride,
  sanitizeSandbox,
} from "./registry-client-app-meta.ts";
import {
  getPluginInfoFromRegistry,
  scoreEntries,
  toAppEntry,
  toAppInfo,
  toPluginListItem,
  toSearchResults,
} from "./registry-client-queries.ts";
import type {
  AppUiExtensionConfig,
  RegistryAppInfo,
  RegistryAppMeta,
  RegistryAppSessionFeature,
  RegistryAppSessionMeta,
  RegistryAppSessionMode,
  RegistryAppViewerMeta,
  RegistryPluginInfo,
  RegistryPluginListItem,
  RegistrySearchResult,
} from "./registry-client-types.ts";

const SESSION_MODES = [
  "viewer",
  "spectate-and-steer",
  "external",
] as const satisfies readonly RegistryAppSessionMode[];

const SESSION_FEATURES = [
  "commands",
  "telemetry",
  "pause",
  "resume",
  "suggestions",
] as const satisfies readonly RegistryAppSessionFeature[];

function plugin(
  overrides: {
    name?: string;
    gitRepo?: string;
    gitUrl?: string;
    directory?: string | null;
    description?: string;
    homepage?: string | null;
    topics?: string[];
    stars?: number;
    language?: string;
    npm?: RegistryPluginInfo["npm"];
    git?: RegistryPluginInfo["git"];
    supports?: RegistryPluginInfo["supports"];
    localPath?: string;
    kind?: string;
    registryKind?: string;
    origin?: RegistryPluginInfo["origin"];
    source?: string;
    support?: RegistryPluginInfo["support"];
    builtIn?: boolean;
    firstParty?: boolean;
    thirdParty?: boolean;
    status?: string;
    appMeta?: RegistryAppMeta;
  } = {},
): RegistryPluginInfo {
  const name = overrides.name ?? "@elizaos/plugin-demo";
  const info: RegistryPluginInfo = {
    name,
    gitRepo: overrides.gitRepo ?? "elizaos/plugin-demo",
    gitUrl: overrides.gitUrl ?? "https://github.com/elizaos/plugin-demo",
    description: overrides.description ?? "Demo plugin",
    homepage: overrides.homepage === undefined ? null : overrides.homepage,
    topics: overrides.topics ?? [],
    stars: overrides.stars ?? 0,
    language: overrides.language ?? "TypeScript",
    npm: overrides.npm ?? {
      package: name,
      v0Version: null,
      v1Version: null,
      v2Version: "1.0.0",
    },
    git: overrides.git ?? {
      v0Branch: null,
      v1Branch: null,
      v2Branch: "main",
    },
    supports: overrides.supports ?? { v0: false, v1: false, v2: true },
  };
  if (overrides.directory !== undefined) {
    info.directory = overrides.directory;
  }
  if (overrides.localPath !== undefined) {
    info.localPath = overrides.localPath;
  }
  if (overrides.kind !== undefined) {
    info.kind = overrides.kind;
  }
  if (overrides.registryKind !== undefined) {
    info.registryKind = overrides.registryKind;
  }
  if (overrides.origin !== undefined) {
    info.origin = overrides.origin;
  }
  if (overrides.source !== undefined) {
    info.source = overrides.source;
  }
  if (overrides.support !== undefined) {
    info.support = overrides.support;
  }
  if (overrides.builtIn !== undefined) {
    info.builtIn = overrides.builtIn;
  }
  if (overrides.firstParty !== undefined) {
    info.firstParty = overrides.firstParty;
  }
  if (overrides.thirdParty !== undefined) {
    info.thirdParty = overrides.thirdParty;
  }
  if (overrides.status !== undefined) {
    info.status = overrides.status;
  }
  if (overrides.appMeta !== undefined) {
    info.appMeta = overrides.appMeta;
  }
  return info;
}

function appMeta(
  overrides: {
    displayName?: string;
    category?: string;
    launchType?: string;
    launchUrl?: string | null;
    icon?: string | null;
    heroImage?: string | null;
    capabilities?: string[];
    minPlayers?: number | null;
    maxPlayers?: number | null;
    runtimePlugin?: string;
    bridgeExport?: string;
    uiExtension?: AppUiExtensionConfig;
    viewer?: RegistryAppViewerMeta;
    session?: RegistryAppSessionMeta;
    developerOnly?: boolean;
    visibleInAppStore?: boolean;
    mainTab?: boolean;
    catalogSection?: string;
    featured?: boolean;
    defaultHidden?: boolean;
    scope?: string;
  } = {},
): RegistryAppMeta {
  const meta: RegistryAppMeta = {
    displayName: overrides.displayName ?? "Demo App",
    category: overrides.category ?? "productivity",
    launchType: overrides.launchType ?? "url",
    launchUrl:
      overrides.launchUrl === undefined
        ? "https://example.test/app"
        : overrides.launchUrl,
    icon: overrides.icon === undefined ? null : overrides.icon,
    heroImage: overrides.heroImage === undefined ? null : overrides.heroImage,
    capabilities: overrides.capabilities ?? [],
    minPlayers:
      overrides.minPlayers === undefined ? null : overrides.minPlayers,
    maxPlayers:
      overrides.maxPlayers === undefined ? null : overrides.maxPlayers,
  };
  if (overrides.runtimePlugin !== undefined) {
    meta.runtimePlugin = overrides.runtimePlugin;
  }
  if (overrides.bridgeExport !== undefined) {
    meta.bridgeExport = overrides.bridgeExport;
  }
  if (overrides.uiExtension !== undefined) {
    meta.uiExtension = overrides.uiExtension;
  }
  if (overrides.viewer !== undefined) {
    meta.viewer = overrides.viewer;
  }
  if (overrides.session !== undefined) {
    meta.session = overrides.session;
  }
  if (overrides.developerOnly !== undefined) {
    meta.developerOnly = overrides.developerOnly;
  }
  if (overrides.visibleInAppStore !== undefined) {
    meta.visibleInAppStore = overrides.visibleInAppStore;
  }
  if (overrides.mainTab !== undefined) {
    meta.mainTab = overrides.mainTab;
  }
  if (overrides.catalogSection !== undefined) {
    meta.catalogSection = overrides.catalogSection;
  }
  if (overrides.featured !== undefined) {
    meta.featured = overrides.featured;
  }
  if (overrides.defaultHidden !== undefined) {
    meta.defaultHidden = overrides.defaultHidden;
  }
  if (overrides.scope !== undefined) {
    meta.scope = overrides.scope;
  }
  return meta;
}

describe("registry-client-types module", () => {
  it("is a type-only module with no runtime exports", async () => {
    const mod = await import("./registry-client-types.ts");
    expect(Object.keys(mod)).toEqual([]);
  });

  it("aliases viewer/session/app types onto the shared contracts without widening", () => {
    expectTypeOf<RegistryAppViewerMeta>().toEqualTypeOf<
      Omit<AppViewerConfig, "authMessage">
    >();
    expectTypeOf<RegistryAppViewerMeta>().not.toHaveProperty("authMessage");
    expectTypeOf<RegistryAppViewerMeta>().toHaveProperty("url");
    expectTypeOf<RegistryAppSessionMode>().toEqualTypeOf<AppSessionMode>();
    expectTypeOf<RegistryAppSessionMode>().toEqualTypeOf<
      (typeof SESSION_MODES)[number]
    >();
    expectTypeOf<RegistryAppSessionFeature>().toEqualTypeOf<AppSessionFeature>();
    expectTypeOf<RegistryAppSessionFeature>().toEqualTypeOf<
      (typeof SESSION_FEATURES)[number]
    >();
    expectTypeOf<RegistryAppSessionMeta>().toEqualTypeOf<AppSessionConfig>();
    expectTypeOf<AppUiExtensionConfig>().toEqualTypeOf<SharedAppUiExtensionConfig>();
    expectTypeOf<RegistryAppInfo>().toEqualTypeOf<SharedRegistryAppInfo>();
  });

  it("treats origin and support literal unions as open strings", () => {
    expectTypeOf<
      NonNullable<RegistryPluginInfo["origin"]>
    >().toEqualTypeOf<string>();
    expectTypeOf<
      NonNullable<RegistryPluginInfo["support"]>
    >().toEqualTypeOf<string>();
    expectTypeOf<
      NonNullable<RegistrySearchResult["origin"]>
    >().toEqualTypeOf<string>();
    expectTypeOf<
      NonNullable<RegistryPluginListItem["support"]>
    >().toEqualTypeOf<string>();
  });
});

describe("RegistryAppMeta and RegistryPluginInfo fixtures", () => {
  it("constructs a required-only app meta with empty capabilities and null urls", () => {
    const meta: RegistryAppMeta = appMeta({
      launchUrl: null,
      icon: null,
      heroImage: null,
      capabilities: [],
      minPlayers: null,
      maxPlayers: null,
    });
    expect(meta.displayName).toBe("Demo App");
    expect(meta.capabilities).toEqual([]);
    expect(meta.launchUrl).toBeNull();
    expect(meta.icon).toBeNull();
    expect(meta.heroImage).toBeNull();
    expect(meta.minPlayers).toBeNull();
    expect(meta.maxPlayers).toBeNull();
    expect(meta.runtimePlugin).toBeUndefined();
    expect(meta.viewer).toBeUndefined();
    expect(meta.session).toBeUndefined();
    expect(meta.developerOnly).toBeUndefined();
    expect(meta.visibleInAppStore).toBeUndefined();
    expect(meta.mainTab).toBeUndefined();
    expect(meta.featured).toBeUndefined();
    expect(meta.defaultHidden).toBeUndefined();
  });

  it("keeps optional catalog flags, nested viewer, and session features as given", () => {
    const viewer: RegistryAppViewerMeta = {
      url: "https://viewer.test",
      postMessageAuth: true,
      sandbox: "allow-scripts",
      embedParams: { theme: "dark" },
    };
    const session: RegistryAppSessionMeta = {
      mode: "spectate-and-steer",
      features: [...SESSION_FEATURES],
    };
    const meta = appMeta({
      runtimePlugin: "runtime-plugin",
      bridgeExport: "Bridge",
      uiExtension: { detailPanelId: "panel-1" },
      viewer,
      session,
      developerOnly: false,
      visibleInAppStore: false,
      mainTab: true,
      catalogSection: "games",
      featured: true,
      defaultHidden: true,
      scope: "wallet",
      capabilities: ["voice", "files"],
      minPlayers: 1,
      maxPlayers: 8,
    });
    expect(meta.viewer).toEqual(viewer);
    expect(meta.session).toEqual(session);
    expect(meta.session?.features).toEqual([...SESSION_FEATURES]);
    expect(meta.developerOnly).toBe(false);
    expect(meta.visibleInAppStore).toBe(false);
    expect(meta.mainTab).toBe(true);
    expect(meta.catalogSection).toBe("games");
    expect(meta.featured).toBe(true);
    expect(meta.defaultHidden).toBe(true);
    expect(meta.scope).toBe("wallet");
    expect(meta.uiExtension).toEqual({ detailPanelId: "panel-1" });
    expect("authMessage" in (meta.viewer ?? {})).toBe(false);
  });

  it("constructs a required-only plugin with empty topics and null homepage", () => {
    const info = plugin({ topics: [], homepage: null, stars: 0 });
    expect(info.topics).toEqual([]);
    expect(info.homepage).toBeNull();
    expect(info.stars).toBe(0);
    expect(info.npm).toEqual({
      package: "@elizaos/plugin-demo",
      v0Version: null,
      v1Version: null,
      v2Version: "1.0.0",
    });
    expect(info.git).toEqual({
      v0Branch: null,
      v1Branch: null,
      v2Branch: "main",
    });
    expect(info.supports).toEqual({ v0: false, v1: false, v2: true });
    expect(info.directory).toBeUndefined();
    expect(info.appMeta).toBeUndefined();
    expect(info.origin).toBeUndefined();
    expect(info.support).toBeUndefined();
    expect(info.builtIn).toBeUndefined();
    expect(info.firstParty).toBeUndefined();
    expect(info.thirdParty).toBeUndefined();
  });

  it("stores directory null distinctly from an omitted directory", () => {
    expect(plugin().directory).toBeUndefined();
    expect(plugin({ directory: null }).directory).toBeNull();
    expect(plugin({ directory: "packages/plugin-demo" }).directory).toBe(
      "packages/plugin-demo",
    );
  });

  it("accepts builtin, third-party, and arbitrary origin/support strings", () => {
    expect(plugin({ origin: "builtin" }).origin).toBe("builtin");
    expect(plugin({ origin: "third-party" }).origin).toBe("third-party");
    expect(plugin({ origin: "workspace" }).origin).toBe("workspace");
    expect(plugin({ support: "first-party" }).support).toBe("first-party");
    expect(plugin({ support: "community" }).support).toBe("community");
    expect(plugin({ support: "internal" }).support).toBe("internal");
  });
});

describe("getPluginInfoFromRegistry over RegistryPluginInfo", () => {
  it("returns null for an empty registry and for a missing name", () => {
    const registry = new Map<string, RegistryPluginInfo>();
    expect(
      getPluginInfoFromRegistry(registry, "@elizaos/plugin-demo"),
    ).toBeNull();
    expect(getPluginInfoFromRegistry(registry, "demo")).toBeNull();
    expect(getPluginInfoFromRegistry(registry, "")).toBeNull();
    registry.set("@elizaos/plugin-demo", plugin());
    registry.delete("not-present");
    expect(getPluginInfoFromRegistry(registry, "not-present")).toBeNull();
    expect(
      getPluginInfoFromRegistry(registry, "@elizaos/plugin-missing"),
    ).toBeNull();
  });

  it("returns the exact-key hit without walking aliases", () => {
    const exact = plugin({ name: "@elizaos/plugin-demo" });
    const other = plugin({ name: "@elizaos/plugin-other" });
    const registry = new Map<string, RegistryPluginInfo>([
      [exact.name, exact],
      [other.name, other],
    ]);
    expect(getPluginInfoFromRegistry(registry, exact.name)).toBe(exact);
  });

  it("resolves a bare name through @elizaos, plugin-, then app- prefixes", () => {
    const prefixed = plugin({ name: "@elizaos/sql" });
    const pluginPrefixed = plugin({ name: "@elizaos/plugin-wallet" });
    const appPrefixed = plugin({ name: "@elizaos/app-calendar", kind: "app" });
    const registry = new Map<string, RegistryPluginInfo>([
      [prefixed.name, prefixed],
      [pluginPrefixed.name, pluginPrefixed],
      [appPrefixed.name, appPrefixed],
    ]);
    expect(getPluginInfoFromRegistry(registry, "sql")).toBe(prefixed);
    expect(getPluginInfoFromRegistry(registry, "wallet")).toBe(pluginPrefixed);
    expect(getPluginInfoFromRegistry(registry, "calendar")).toBe(appPrefixed);
  });

  it("reserves insertion-order suffix matching for unscoped input", () => {
    const first = plugin({ name: "@aaa/sql", gitRepo: "aaa/sql" });
    const second = plugin({ name: "@bbb/sql", gitRepo: "bbb/sql" });
    const registry = new Map<string, RegistryPluginInfo>([
      [first.name, first],
      [second.name, second],
    ]);
    expect(getPluginInfoFromRegistry(registry, "@foo/sql")).toBeNull();
    expect(getPluginInfoFromRegistry(registry, "sql")).toBe(first);
  });

  it("matches a npm.package alias after prefix tries miss", () => {
    const aliased = plugin({
      name: "@vendor/other",
      npm: {
        package: "@elizaos/plugin-alias",
        v0Version: null,
        v1Version: null,
        v2Version: "2.0.0",
      },
    });
    const registry = new Map<string, RegistryPluginInfo>([
      [aliased.name, aliased],
    ]);
    expect(getPluginInfoFromRegistry(registry, "plugin-alias")).toBe(aliased);
    expect(getPluginInfoFromRegistry(registry, "missing-alias")).toBeNull();
  });

  it("matches an app route slug only when the entry has an app interface", () => {
    const app = plugin({
      name: "@vendor/app-calendar",
      kind: "app",
    });
    const notApp = plugin({
      name: "@vendor/app-notes",
    });
    const registry = new Map<string, RegistryPluginInfo>([
      [app.name, app],
      [notApp.name, notApp],
    ]);
    expect(getPluginInfoFromRegistry(registry, "calendar")).toBe(app);
    expect(getPluginInfoFromRegistry(registry, "notes")).toBeNull();
  });
});

describe("scoreEntries over RegistryPluginInfo", () => {
  it("returns an empty result for an empty iterable", () => {
    expect(scoreEntries([], "demo", 10)).toEqual([]);
    expect(
      scoreEntries(new Map<string, RegistryPluginInfo>().values(), "demo", 10),
    ).toEqual([]);
  });

  it("excludes a single entry whose name, description, and topics miss the query", () => {
    const miss = plugin({
      name: "@elizaos/plugin-wallet",
      description: "payments",
      topics: ["finance"],
    });
    expect(scoreEntries([miss], "calendar", 10)).toEqual([]);
  });

  it("scores an exact name match plus the overlapping term bonus", () => {
    const exact = plugin({ name: "wallet", description: "x", topics: [] });
    const scored = scoreEntries([exact], "wallet", 1);
    expect(scored).toHaveLength(1);
    expect(scored[0]?.p).toBe(exact);
    // exact name (+100) and the same token in the terms loop (+15).
    expect(scored[0]?.s).toBe(115);
  });

  it("breaks score ties by stars descending and keeps insertion order on equal stars", () => {
    const low = plugin({
      name: "@elizaos/plugin-wallet-low",
      description: "wallet helper",
      stars: 1,
    });
    const high = plugin({
      name: "@elizaos/plugin-wallet-high",
      description: "wallet helper",
      stars: 50,
    });
    const tiedA = plugin({
      name: "@elizaos/plugin-wallet-a",
      description: "wallet helper",
      stars: 10,
    });
    const tiedB = plugin({
      name: "@elizaos/plugin-wallet-b",
      description: "wallet helper",
      stars: 10,
    });
    const tied = scoreEntries([tiedA, tiedB], "wallet helper", 10);
    expect(tied.map((row) => row.p.name)).toEqual([tiedA.name, tiedB.name]);
    const byStars = scoreEntries([low, high], "wallet helper", 10);
    expect(byStars.map((row) => row.p.name)).toEqual([high.name, low.name]);
  });

  it("slices overflow past the requested capacity", () => {
    const a = plugin({ name: "@elizaos/alpha", description: "search" });
    const b = plugin({ name: "@elizaos/beta", description: "search" });
    const c = plugin({ name: "@elizaos/gamma", description: "search" });
    const scored = scoreEntries([a, b, c], "search", 2);
    expect(scored).toHaveLength(2);
    expect(scoreEntries([a, b, c], "search", 0)).toEqual([]);
  });

  it("adds star bonuses only after a positive relevance score", () => {
    const popularMiss = plugin({
      name: "@elizaos/plugin-other",
      description: "unrelated",
      stars: 5000,
    });
    const popularHit = plugin({
      name: "@elizaos/plugin-search",
      description: "search tool",
      stars: 1001,
    });
    expect(scoreEntries([popularMiss], "wallet", 10)).toEqual([]);
    const hit = scoreEntries([popularHit], "search", 10);
    // name includes query (+50), description includes query (+30), the same
    // token in the terms loop (+15 name, +10 description), and star tiers
    // >100 (+3), >500 (+3), >1000 (+4).
    expect(hit[0]?.s).toBe(50 + 30 + 15 + 10 + 3 + 3 + 4);
  });

  it("treats an empty query as a substring of every name and description", () => {
    const only = plugin({ name: "@elizaos/plugin-demo", description: "x" });
    const scored = scoreEntries([only], "", 10);
    expect(scored).toHaveLength(1);
    expect(scored[0]?.p).toBe(only);
    expect(scored[0]?.s).toBeGreaterThan(0);
  });
});

describe("toSearchResults and toPluginListItem", () => {
  it("maps an empty scored queue to an empty search result list", () => {
    const results: RegistrySearchResult[] = toSearchResults([]);
    expect(results).toEqual([]);
  });

  it("normalizes a single element's score to 1 and copies DTO fields", () => {
    const p = plugin({
      name: "@elizaos/plugin-demo",
      description: "Demo plugin",
      topics: ["core"],
      stars: 12,
      gitRepo: "elizaos/plugin-demo",
      origin: "builtin",
      support: "first-party",
      builtIn: true,
      firstParty: true,
      thirdParty: false,
    });
    const results = toSearchResults([{ p, s: 40 }]);
    expect(results).toHaveLength(1);
    const row: RegistrySearchResult = results[0] as RegistrySearchResult;
    expect(row.name).toBe(p.name);
    expect(row.description).toBe(p.description);
    expect(row.score).toBe(1);
    expect(row.tags).toEqual(["core"]);
    expect(row.tags).toBe(p.topics);
    expect(row.latestVersion).toBe("1.0.0");
    expect(row.stars).toBe(12);
    expect(row.supports).toEqual({ v0: false, v1: false, v2: true });
    expect(row.repository).toBe("https://github.com/elizaos/plugin-demo");
    expect(row.origin).toBe("builtin");
    expect(row.support).toBe("first-party");
    expect(row.builtIn).toBe(true);
    expect(row.firstParty).toBe(true);
    expect(row.thirdParty).toBe(false);
  });

  it("divides scores by the first element's score and falls through version fields", () => {
    const v2 = plugin({
      name: "a",
      npm: {
        package: "a",
        v0Version: "0.1.0",
        v1Version: "0.9.0",
        v2Version: "2.0.0",
      },
    });
    const v1 = plugin({
      name: "b",
      npm: {
        package: "b",
        v0Version: "0.1.0",
        v1Version: "0.9.0",
        v2Version: null,
      },
    });
    const emptyV2 = plugin({
      name: "c",
      npm: {
        package: "c",
        v0Version: "0.1.0",
        v1Version: "0.9.0",
        v2Version: "",
      },
    });
    const none = plugin({
      name: "d",
      npm: {
        package: "d",
        v0Version: null,
        v1Version: null,
        v2Version: null,
      },
    });
    const rows = toSearchResults([
      { p: v2, s: 100 },
      { p: v1, s: 50 },
      { p: emptyV2, s: 25 },
      { p: none, s: 0 },
    ]);
    expect(rows.map((row) => row.score)).toEqual([1, 0.5, 0.25, 0]);
    expect(rows[0]?.latestVersion).toBe("2.0.0");
    expect(rows[1]?.latestVersion).toBe("0.9.0");
    expect(rows[2]?.latestVersion).toBe("0.9.0");
    expect(rows[3]?.latestVersion).toBeNull();
  });

  it("projects a plugin list item and preserves empty topics", () => {
    const p = plugin({
      topics: [],
      stars: 0,
      origin: "third-party",
      support: "community",
    });
    const item: RegistryPluginListItem = toPluginListItem(p);
    expect(item).toEqual({
      name: p.name,
      description: p.description,
      stars: 0,
      repository: "https://github.com/elizaos/plugin-demo",
      topics: [],
      latestVersion: "1.0.0",
      supports: p.supports,
      npm: p.npm,
      origin: "third-party",
      support: "community",
      builtIn: undefined,
      firstParty: undefined,
      thirdParty: undefined,
    });
  });

  it("round-trips a list item through JSON without inventing optional flags", () => {
    const item = toPluginListItem(plugin({ topics: ["sql"] }));
    const parsed = JSON.parse(JSON.stringify(item)) as RegistryPluginListItem;
    expect(parsed.name).toBe(item.name);
    expect(parsed.topics).toEqual(["sql"]);
    expect(parsed.npm).toEqual(item.npm);
    expect("builtIn" in parsed).toBe(false);
    expect("firstParty" in parsed).toBe(false);
    expect("thirdParty" in parsed).toBe(false);
  });
});

describe("toAppInfo and toAppEntry over RegistryAppMeta", () => {
  it("fills app-info defaults when appMeta is missing", () => {
    const p = plugin({
      name: "@elizaos/plugin-demo",
      homepage: "https://github.com/elizaos/plugin-demo",
    });
    const info: RegistryAppInfo = toAppInfo(
      p,
      sanitizeSandbox,
      LOCAL_APP_DEFAULT_SANDBOX,
    );
    expect(info.displayName).toBe("Demo");
    expect(info.category).toBe("game");
    expect(info.launchType).toBe("url");
    expect(info.launchUrl).toBe("https://github.com/elizaos/plugin-demo");
    expect(info.icon).toBeNull();
    expect(info.heroImage).toBe("/api/apps/hero/demo");
    expect(info.capabilities).toEqual([]);
    expect(info.viewer).toBeUndefined();
    expect(info.session).toBeUndefined();
  });

  it("synthesizes a viewer for connect/local launch types without a viewer block", () => {
    const connect = plugin({
      appMeta: appMeta({
        launchType: "connect",
        launchUrl: "http://localhost:3003",
      }),
    });
    const local = plugin({
      appMeta: appMeta({ launchType: "local", launchUrl: null }),
    });
    expect(
      toAppInfo(connect, sanitizeSandbox, LOCAL_APP_DEFAULT_SANDBOX).viewer,
    ).toEqual({
      url: "http://localhost:3003",
      sandbox: LOCAL_APP_DEFAULT_SANDBOX,
    });
    expect(
      toAppInfo(local, sanitizeSandbox, LOCAL_APP_DEFAULT_SANDBOX).viewer,
    ).toEqual({
      url: "",
      sandbox: LOCAL_APP_DEFAULT_SANDBOX,
    });
  });

  it("sanitizes an untrusted viewer sandbox through the real allowlist", () => {
    const p = plugin({
      appMeta: appMeta({
        viewer: {
          url: "https://viewer.test",
          sandbox: "allow-scripts allow-top-navigation",
        },
      }),
    });
    const info = toAppInfo(p, sanitizeSandbox, LOCAL_APP_DEFAULT_SANDBOX);
    expect(info.viewer?.url).toBe("https://viewer.test");
    expect(info.viewer?.sandbox).toBe(LOCAL_APP_DEFAULT_SANDBOX);
  });

  it("keeps an absolute hero URL and rewrites a package-relative path", () => {
    const absolute = plugin({
      name: "@elizaos/app-demo",
      appMeta: appMeta({ heroImage: "https://cdn.example/hero.png" }),
    });
    const relative = plugin({
      name: "@elizaos/app-demo",
      appMeta: appMeta({ heroImage: "assets/hero.png" }),
    });
    expect(
      toAppInfo(absolute, sanitizeSandbox, LOCAL_APP_DEFAULT_SANDBOX).heroImage,
    ).toBe("https://cdn.example/hero.png");
    expect(
      toAppInfo(relative, sanitizeSandbox, LOCAL_APP_DEFAULT_SANDBOX).heroImage,
    ).toBe("/api/apps/hero/demo");
  });

  it("returns null for a plugin that is not an app and has no override", () => {
    expect(toAppEntry(plugin(), resolveAppOverride)).toBeNull();
  });

  it("returns the same appMeta when kind is already app", () => {
    const meta = appMeta({ displayName: "Already App" });
    const p = plugin({ kind: "app", appMeta: meta });
    const entry = toAppEntry(p, resolveAppOverride);
    expect(entry?.kind).toBe("app");
    expect(entry?.appMeta).toBe(meta);
  });

  it("applies the real hyperfy local override when appMeta is missing", () => {
    const p = plugin({ name: "@elizaos/app-hyperfy" });
    const entry = toAppEntry(p, resolveAppOverride);
    expect(entry?.kind).toBe("app");
    expect(entry?.appMeta?.displayName).toBe("Hyperfy");
    expect(entry?.appMeta?.launchType).toBe("connect");
    expect(entry?.appMeta?.launchUrl).toBe("http://localhost:3003");
  });
});
