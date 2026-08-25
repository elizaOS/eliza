/**
 * Behavioral coverage for registry-client-queries: alias normalisation,
 * in-memory name/alias/route-slug lookup, relevance scoring (exact vs
 * substring, multi-term, extra names/terms, star bonuses, tie-break, empty
 * queue, single element, limit overflow), search/app/list DTO projection, and
 * hero-image URL resolution. Drives the real module — no mocks.
 */
import { describe, expect, it } from "vitest";
import {
  getPluginInfoFromRegistry,
  normalizePluginLookupAlias,
  resolveAppHeroImage,
  scoreEntries,
  toAppEntry,
  toAppInfo,
  toPluginListItem,
  toSearchResults,
} from "./registry-client-queries.ts";
import type {
  RegistryAppMeta,
  RegistryPluginInfo,
} from "./registry-client-types.ts";

function plugin(
  overrides: {
    name?: string;
    gitRepo?: string;
    description?: string;
    homepage?: string | null;
    topics?: string[];
    stars?: number;
    npmPackage?: string;
    v0Version?: string | null;
    v1Version?: string | null;
    v2Version?: string | null;
    directory?: string | null;
    kind?: string;
    origin?: string;
    source?: string;
    support?: string;
    builtIn?: boolean;
    firstParty?: boolean;
    thirdParty?: boolean;
    status?: string;
    registryKind?: string;
    appMeta?: RegistryAppMeta;
  } = {},
): RegistryPluginInfo {
  const info: RegistryPluginInfo = {
    name: overrides.name ?? "@elizaos/plugin-demo",
    gitRepo: overrides.gitRepo ?? "elizaos/plugin-demo",
    gitUrl: "https://github.com/elizaos/plugin-demo.git",
    directory: overrides.directory === undefined ? null : overrides.directory,
    description: overrides.description ?? "Demo plugin",
    homepage:
      overrides.homepage === undefined
        ? "https://example.test/demo"
        : overrides.homepage,
    topics: overrides.topics ?? ["demo"],
    stars: overrides.stars ?? 0,
    language: "TypeScript",
    npm: {
      package: overrides.npmPackage ?? overrides.name ?? "@elizaos/plugin-demo",
      v0Version: overrides.v0Version === undefined ? null : overrides.v0Version,
      v1Version: overrides.v1Version === undefined ? null : overrides.v1Version,
      v2Version:
        overrides.v2Version === undefined ? "2.0.0" : overrides.v2Version,
    },
    git: {
      v0Branch: null,
      v1Branch: null,
      v2Branch: null,
    },
    supports: { v0: false, v1: false, v2: true },
  };
  if (overrides.kind !== undefined) info.kind = overrides.kind;
  if (overrides.origin !== undefined) info.origin = overrides.origin;
  if (overrides.source !== undefined) info.source = overrides.source;
  if (overrides.support !== undefined) info.support = overrides.support;
  if (overrides.builtIn !== undefined) info.builtIn = overrides.builtIn;
  if (overrides.firstParty !== undefined)
    info.firstParty = overrides.firstParty;
  if (overrides.thirdParty !== undefined)
    info.thirdParty = overrides.thirdParty;
  if (overrides.status !== undefined) info.status = overrides.status;
  if (overrides.registryKind !== undefined) {
    info.registryKind = overrides.registryKind;
  }
  if (overrides.appMeta !== undefined) info.appMeta = overrides.appMeta;
  return info;
}

function appMeta(overrides: Partial<RegistryAppMeta> = {}): RegistryAppMeta {
  return {
    displayName: overrides.displayName ?? "Demo App",
    category: overrides.category ?? "productivity",
    launchType: overrides.launchType ?? "url",
    launchUrl:
      overrides.launchUrl === undefined
        ? "https://example.test/app"
        : overrides.launchUrl,
    icon: overrides.icon === undefined ? null : overrides.icon,
    heroImage: overrides.heroImage === undefined ? null : overrides.heroImage,
    capabilities: overrides.capabilities ?? ["chat"],
    minPlayers:
      overrides.minPlayers === undefined ? null : overrides.minPlayers,
    maxPlayers:
      overrides.maxPlayers === undefined ? null : overrides.maxPlayers,
    ...("runtimePlugin" in overrides
      ? { runtimePlugin: overrides.runtimePlugin }
      : {}),
    ...("bridgeExport" in overrides
      ? { bridgeExport: overrides.bridgeExport }
      : {}),
    ...("uiExtension" in overrides
      ? { uiExtension: overrides.uiExtension }
      : {}),
    ...("viewer" in overrides ? { viewer: overrides.viewer } : {}),
    ...("session" in overrides ? { session: overrides.session } : {}),
    ...("developerOnly" in overrides
      ? { developerOnly: overrides.developerOnly }
      : {}),
    ...("visibleInAppStore" in overrides
      ? { visibleInAppStore: overrides.visibleInAppStore }
      : {}),
    ...("mainTab" in overrides ? { mainTab: overrides.mainTab } : {}),
    ...("catalogSection" in overrides
      ? { catalogSection: overrides.catalogSection }
      : {}),
    ...("featured" in overrides ? { featured: overrides.featured } : {}),
    ...("defaultHidden" in overrides
      ? { defaultHidden: overrides.defaultHidden }
      : {}),
    ...("scope" in overrides ? { scope: overrides.scope } : {}),
  };
}

describe("normalizePluginLookupAlias", () => {
  it("returns empty input after trim", () => {
    expect(normalizePluginLookupAlias("")).toBe("");
    expect(normalizePluginLookupAlias("   \t")).toBe("");
  });

  it("rewrites the three obsidan misspellings and preserves other trimmed names", () => {
    expect(normalizePluginLookupAlias("Obsidan")).toBe("obsidian");
    expect(normalizePluginLookupAlias("PLUGIN-OBSIDAN")).toBe(
      "plugin-obsidian",
    );
    expect(normalizePluginLookupAlias("  @elizaos/plugin-obsidan  ")).toBe(
      "@elizaos/plugin-obsidian",
    );
    expect(normalizePluginLookupAlias(" Discord ")).toBe("Discord");
  });
});

describe("getPluginInfoFromRegistry", () => {
  it("returns the exact-key hit without scanning aliases", () => {
    const exact = plugin({ name: "@elizaos/plugin-discord" });
    const other = plugin({ name: "@elizaos/plugin-slack" });
    const registry = new Map<string, RegistryPluginInfo>([
      [exact.name, exact],
      [other.name, other],
    ]);
    expect(getPluginInfoFromRegistry(registry, exact.name)).toBe(exact);
  });

  it("resolves a bare name through @elizaos/, plugin-, then app- prefixes", () => {
    const scoped = plugin({ name: "@elizaos/discord" });
    const prefixed = plugin({ name: "@elizaos/plugin-slack" });
    const app = plugin({ name: "@elizaos/app-chess", kind: "app" });

    expect(
      getPluginInfoFromRegistry(new Map([[scoped.name, scoped]]), "discord"),
    ).toBe(scoped);
    expect(
      getPluginInfoFromRegistry(new Map([[prefixed.name, prefixed]]), "slack"),
    ).toBe(prefixed);
    expect(getPluginInfoFromRegistry(new Map([[app.name, app]]), "chess")).toBe(
      app,
    );
  });

  it("does not cross scopes when the lookup already starts with @", () => {
    const elizaos = plugin({ name: "@elizaos/plugin-discord" });
    const registry = new Map([[elizaos.name, elizaos]]);

    expect(
      getPluginInfoFromRegistry(registry, "@other/plugin-discord"),
    ).toBeNull();
    expect(getPluginInfoFromRegistry(registry, "plugin-discord")).toBe(elizaos);
  });

  it("matches a case-insensitive key suffix and npm.package / name aliases", () => {
    const cased = plugin({ name: "@Other/Plugin-Foo" });
    const aliased = plugin({
      name: "@elizaos/plugin-alpha",
      npmPackage: "@elizaos/plugin-beta",
    });
    const blankAlias = plugin({
      name: "  ",
      npmPackage: "   ",
    });

    expect(
      getPluginInfoFromRegistry(new Map([[cased.name, cased]]), "plugin-foo"),
    ).toBe(cased);
    expect(
      getPluginInfoFromRegistry(
        new Map([[aliased.name, aliased]]),
        "plugin-beta",
      ),
    ).toBe(aliased);
    expect(
      getPluginInfoFromRegistry(
        new Map([[blankAlias.name, blankAlias]]),
        "missing",
      ),
    ).toBeNull();
  });

  it("resolves an app route-slug alias only when the entry has an app interface", () => {
    // Keys are deliberately not `@elizaos/{,plugin-,app-}chess` so prefix
    // tries miss and the scan has to use route-slug aliases.
    const app = plugin({
      name: "@elizaos/app-chess",
      kind: "app",
    });
    const pluginOnly = plugin({
      name: "@elizaos/plugin-chess",
    });

    expect(
      getPluginInfoFromRegistry(new Map([["local-app", app]]), "chess"),
    ).toBe(app);
    expect(
      getPluginInfoFromRegistry(
        new Map([["local-plugin", pluginOnly]]),
        "chess",
      ),
    ).toBeNull();
  });

  it("returns null for an empty registry, a missing name, and a leading-space miss", () => {
    const discord = plugin({ name: "@elizaos/plugin-discord" });
    const registry = new Map<string, RegistryPluginInfo>([
      [discord.name, discord],
    ]);
    expect(getPluginInfoFromRegistry(new Map(), "discord")).toBeNull();
    expect(getPluginInfoFromRegistry(registry, "no-such-plugin")).toBeNull();
    expect(getPluginInfoFromRegistry(registry, " discord")).toBeNull();
  });
});

describe("scoreEntries", () => {
  it("returns an empty array for an empty iterable and for a zero-score miss", () => {
    expect(scoreEntries([], "discord", 10)).toEqual([]);
    expect(
      scoreEntries(
        [
          plugin({
            name: "@elizaos/plugin-slack",
            description: "Slack",
            topics: [],
          }),
        ],
        "discord",
        10,
      ),
    ).toEqual([]);
  });

  it("scores a single substring hit and truncates to the limit", () => {
    const discord = plugin({
      name: "@elizaos/plugin-discord",
      description: "Discord connector",
      topics: ["chat", "discord"],
      stars: 150,
    });
    const discordApp = plugin({
      name: "@elizaos/app-discord",
      description: "Discord app",
      topics: ["discord"],
      stars: 10,
    });
    const slack = plugin({
      name: "@elizaos/plugin-slack",
      description: "Slack connector",
      topics: ["chat"],
      stars: 2000,
    });

    const scored = scoreEntries([discord, discordApp, slack], "discord", 1);
    expect(scored).toHaveLength(1);
    expect(scored[0]?.p).toBe(discord);
    // substring name 50 + description 30 + matching topic 25 + term name 15 +
    // term description 10 + term topic 8 + stars>100 bonus 3
    expect(scored[0]?.s).toBe(141);
  });

  it("prefers an exact / @elizaos-prefixed / extra-name match over substring", () => {
    const exact = plugin({ name: "discord", description: "x", topics: [] });
    const prefixed = plugin({
      name: "@elizaos/discord",
      description: "x",
      topics: [],
    });
    const aliased = plugin({
      name: "@elizaos/plugin-chat",
      description: "x",
      topics: [],
    });
    const substring = plugin({
      name: "@elizaos/plugin-discord",
      description: "x",
      topics: [],
    });

    expect(scoreEntries([exact], "discord", 1)[0]?.s).toBe(115);
    expect(scoreEntries([prefixed], "discord", 1)[0]?.s).toBe(115);
    expect(scoreEntries([aliased], "discord", 1, () => ["discord"])[0]?.s).toBe(
      115,
    );
    expect(scoreEntries([substring], "discord", 1)[0]?.s).toBe(65);
  });

  it("adds extra-term and extra-name substring points and the three star bonuses", () => {
    const p = plugin({
      name: "other",
      description: "none",
      topics: [],
      stars: 1001,
    });
    const scored = scoreEntries(
      [p],
      "voice",
      1,
      () => ["voice-box"],
      () => ["voice"],
    );
    // extra-name substring 50 + extra-term 25 + term extra-name 15 +
    // stars>100/500/1000 bonuses 3+3+4
    expect(scored[0]?.s).toBe(100);
  });

  it("orders by score then stars, keeps equal ties stable, and honors limit 0", () => {
    const lowStars = plugin({
      name: "alpha-search",
      description: "search",
      topics: [],
      stars: 1,
    });
    const highStars = plugin({
      name: "beta-search",
      description: "search",
      topics: [],
      stars: 50,
    });
    const tiedA = plugin({
      name: "gamma-search",
      description: "search",
      topics: [],
      stars: 10,
    });
    const tiedB = plugin({
      name: "delta-search",
      description: "search",
      topics: [],
      stars: 10,
    });

    const byStars = scoreEntries([lowStars, highStars], "search", 2);
    expect(byStars.map((row) => row.p.name)).toEqual([
      "beta-search",
      "alpha-search",
    ]);

    const tied = scoreEntries([tiedA, tiedB], "search", 10);
    expect(tied.map((row) => row.p.name)).toEqual([
      "gamma-search",
      "delta-search",
    ]);

    expect(scoreEntries([lowStars, highStars], "search", 0)).toEqual([]);
  });

  it("does not split single-character query terms and still matches via includes", () => {
    const p = plugin({
      name: "a",
      description: "x",
      topics: [],
    });
    expect(scoreEntries([p], "a", 1)[0]?.s).toBe(100);
  });
});

describe("toSearchResults", () => {
  it("returns an empty list when the scored queue is empty", () => {
    expect(toSearchResults([])).toEqual([]);
  });

  it("normalises scores against the first entry and maps DTO fields", () => {
    const top = plugin({
      name: "@elizaos/plugin-discord",
      description: "Discord connector",
      topics: ["chat"],
      stars: 12,
      origin: "builtin",
      support: "first-party",
      builtIn: true,
      firstParty: true,
      thirdParty: false,
      v2Version: "2.1.0",
      npmPackage: "@elizaos/plugin-discord",
    });
    const lower = plugin({
      name: "@elizaos/plugin-slack",
      description: "Slack",
      topics: [],
      stars: 3,
      v2Version: null,
      v1Version: "1.4.0",
      npmPackage: "@elizaos/plugin-slack",
    });

    const results = toSearchResults([
      { p: top, s: 200 },
      { p: lower, s: 50 },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      name: top.name,
      description: top.description,
      score: 1,
      tags: ["chat"],
      latestVersion: "2.1.0",
      stars: 12,
      supports: top.supports,
      repository: "https://github.com/elizaos/plugin-demo",
      origin: "builtin",
      support: "first-party",
      builtIn: true,
      firstParty: true,
      thirdParty: false,
    });
    expect(results[1]?.score).toBe(0.25);
    expect(results[1]?.latestVersion).toBe("1.4.0");
    expect(
      (results[0] as { version?: string | null; npmPackage?: string }).version,
    ).toBe("2.1.0");
    expect(
      (results[0] as { version?: string | null; npmPackage?: string })
        .npmPackage,
    ).toBe("@elizaos/plugin-discord");
  });

  it("treats a leading score of 0 as max 1 and falls back through v0", () => {
    const p = plugin({
      v2Version: null,
      v1Version: null,
      v0Version: "0.9.0",
    });
    const results = toSearchResults([{ p, s: 0 }]);
    expect(results[0]?.score).toBe(0);
    expect(results[0]?.latestVersion).toBe("0.9.0");
  });
});

describe("resolveAppHeroImage", () => {
  it("returns absolute, data, blob, file, and already-rooted URLs unchanged", () => {
    const passThrough = [
      "https://cdn.example/hero.png",
      "HTTP://cdn.example/hero.png",
      "data:image/png;base64,abc",
      "blob:https://example.test/1",
      "file:///tmp/hero.png",
      "capacitor://localhost/hero.png",
      "electrobun://app/hero.png",
      "app://localhost/hero.png",
      "/api/apps/hero/chess",
      "/assets/hero.png",
    ];
    for (const value of passThrough) {
      expect(resolveAppHeroImage("@elizaos/app-chess", value)).toBe(value);
    }
  });

  it("rewrites relative paths and nullish/blank values to the slug fallback", () => {
    expect(resolveAppHeroImage("@elizaos/app-chess", "assets/hero.png")).toBe(
      "/api/apps/hero/chess",
    );
    expect(resolveAppHeroImage("@elizaos/app-chess", null)).toBe(
      "/api/apps/hero/chess",
    );
    expect(resolveAppHeroImage("@elizaos/app-chess", undefined)).toBe(
      "/api/apps/hero/chess",
    );
    expect(resolveAppHeroImage("@elizaos/app-chess", "   ")).toBe(
      "/api/apps/hero/chess",
    );
  });

  it("returns null when the package name has no route slug", () => {
    expect(resolveAppHeroImage("", "assets/hero.png")).toBeNull();
    expect(resolveAppHeroImage("@scope/", null)).toBeNull();
  });
});

describe("toAppInfo", () => {
  const defaultSandbox = "allow-scripts allow-same-origin";
  const sanitize = (value?: string) => `sanitized:${value ?? "<none>"}`;

  it("derives display defaults when appMeta is absent", () => {
    const info = toAppInfo(
      plugin({
        name: "@elizaos/plugin-discord",
        homepage: "https://example.test/discord",
      }),
      sanitize,
      defaultSandbox,
    );
    expect(info.displayName).toBe("Discord");
    expect(info.category).toBe("game");
    expect(info.launchType).toBe("url");
    expect(info.launchUrl).toBe("https://example.test/discord");
    expect(info.icon).toBeNull();
    expect(info.heroImage).toBe("/api/apps/hero/discord");
    expect(info.capabilities).toEqual([]);
    expect(info.directory).toBeNull();
    expect(info.viewer).toBeUndefined();
  });

  it("projects viewer metadata through sanitizeSandbox and copies catalog flags", () => {
    const meta = appMeta({
      displayName: "Chess",
      category: "game",
      launchType: "url",
      launchUrl: "https://example.test/chess",
      icon: "icon.png",
      heroImage: "https://cdn.example/chess.webp",
      capabilities: ["board"],
      viewer: {
        url: "https://example.test/embed",
        embedParams: { theme: "dark" },
        postMessageAuth: true,
        sandbox: "allow-scripts",
      },
      session: { mode: "viewer" },
      developerOnly: true,
      visibleInAppStore: false,
      mainTab: true,
      catalogSection: "games",
      featured: true,
      defaultHidden: true,
      scope: "wallet",
      uiExtension: { detailPanelId: "chess-panel" },
    });
    const p = plugin({
      name: "@elizaos/app-chess",
      kind: "app",
      directory: "apps/chess",
      registryKind: "app",
      origin: "builtin",
      source: "local",
      support: "first-party",
      builtIn: true,
      firstParty: true,
      thirdParty: false,
      status: "active",
      appMeta: meta,
    });
    const info = toAppInfo(p, sanitize, defaultSandbox);
    expect(info.displayName).toBe("Chess");
    expect(info.icon).toBe("icon.png");
    expect(info.heroImage).toBe("https://cdn.example/chess.webp");
    expect(info.viewer).toEqual({
      url: "https://example.test/embed",
      embedParams: { theme: "dark" },
      postMessageAuth: true,
      sandbox: "sanitized:allow-scripts",
    });
    expect(info.session).toEqual({ mode: "viewer" });
    expect(info.developerOnly).toBe(true);
    expect(info.visibleInAppStore).toBe(false);
    expect(info.mainTab).toBe(true);
    expect(info.catalogSection).toBe("games");
    expect(info.featured).toBe(true);
    expect(info.defaultHidden).toBe(true);
    expect(info.scope).toBe("wallet");
    expect(info.uiExtension).toEqual({ detailPanelId: "chess-panel" });
    expect(info.directory).toBe("apps/chess");
  });

  it("synthesises a connect/local viewer when no viewer block is declared", () => {
    const connect = toAppInfo(
      plugin({
        appMeta: appMeta({
          launchType: "connect",
          launchUrl: "https://x.test",
        }),
      }),
      sanitize,
      defaultSandbox,
    );
    expect(connect.viewer).toEqual({
      url: "https://x.test",
      sandbox: defaultSandbox,
    });

    const localNullUrl = toAppInfo(
      plugin({
        appMeta: appMeta({ launchType: "local", launchUrl: null }),
      }),
      sanitize,
      defaultSandbox,
    );
    expect(localNullUrl.viewer).toEqual({
      url: "",
      sandbox: defaultSandbox,
    });
  });
});

describe("toAppEntry", () => {
  const overrideMeta = appMeta({ displayName: "Override" });

  it("returns the entry as an app when kind is app or appMeta is present", () => {
    const kindApp = plugin({ kind: "app" });
    const withMeta = plugin({
      kind: "plugin",
      appMeta: appMeta({ displayName: "Present" }),
    });
    let overrideCalls = 0;
    const resolve = () => {
      overrideCalls += 1;
      return overrideMeta;
    };

    expect(toAppEntry(kindApp, resolve)).toEqual({
      ...kindApp,
      kind: "app",
      appMeta: undefined,
    });
    expect(toAppEntry(withMeta, resolve)?.kind).toBe("app");
    expect(toAppEntry(withMeta, resolve)?.appMeta?.displayName).toBe("Present");
    expect(overrideCalls).toBe(0);
  });

  it("applies a successful override and returns null when the override is missing", () => {
    const p = plugin({ kind: "plugin" });
    expect(toAppEntry(p, () => overrideMeta)).toEqual({
      ...p,
      kind: "app",
      appMeta: overrideMeta,
    });
    expect(toAppEntry(p, () => undefined)).toBeNull();
  });
});

describe("toPluginListItem", () => {
  it("maps list DTO fields and falls back through npm versions", () => {
    const p = plugin({
      name: "@elizaos/plugin-discord",
      description: "Discord connector",
      topics: ["chat"],
      stars: 9,
      gitRepo: "elizaos/plugin-discord",
      origin: "third-party",
      support: "community",
      builtIn: false,
      firstParty: false,
      thirdParty: true,
      v2Version: null,
      v1Version: null,
      v0Version: "0.1.0",
    });
    expect(toPluginListItem(p)).toEqual({
      name: p.name,
      description: p.description,
      stars: 9,
      repository: "https://github.com/elizaos/plugin-discord",
      topics: ["chat"],
      latestVersion: "0.1.0",
      supports: p.supports,
      npm: p.npm,
      origin: "third-party",
      support: "community",
      builtIn: false,
      firstParty: false,
      thirdParty: true,
    });
  });
});
