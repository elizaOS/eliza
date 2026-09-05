/**
 * Unit coverage for path→tab resolution against the app-shell registry. In-memory
 * registry, no runtime.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAppShellPage } from "../app-shell-registry";
import { resetUiRegistryHostForTests } from "../registry-host";
import {
  ALL_TAB_GROUPS,
  BUILTIN_ROUTE_IDS,
  LAUNCHER_AOSP_ONLY_VIEW_IDS,
  LEGACY_PREFIX_TAB_ALIASES,
  NATIVE_OS_VIEW_IDS,
  pathForTab,
  resolveBuiltinRouteDescriptor,
  resolveLegacyBuiltinRoute,
  TAB_PATHS,
  tabFromPath,
  titleForTab,
} from "./index";

beforeEach(() => {
  resetUiRegistryHostForTests();
});

afterEach(() => {
  resetUiRegistryHostForTests();
});

describe("navigation tabFromPath", () => {
  it.each(["/documents", "/knowledge", "/KNOWLEDGE/"])(
    "resolves the retired Knowledge route %s without falling into the views catalog",
    (path) => {
      expect(tabFromPath(path)).toBe("documents");
      expect(resolveLegacyBuiltinRoute(path)).toEqual({
        tab: "documents",
        canonicalPath: TAB_PATHS.documents,
      });
    },
  );

  it("does not treat the canonical Knowledge route as a legacy alias", () => {
    expect(resolveLegacyBuiltinRoute(TAB_PATHS.documents)).toBeNull();
  });

  it("uses app-shell tab affinity for registered plugin pages", () => {
    registerAppShellPage({
      id: "test.wallet.inventory",
      pluginId: "@elizaos/plugin-wallet:ui",
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

describe("navigation built-in route descriptors", () => {
  it("classifies every path exposed by the compatibility map", () => {
    expect(Object.keys(TAB_PATHS)).toEqual(BUILTIN_ROUTE_IDS);

    for (const id of BUILTIN_ROUTE_IDS) {
      const descriptor = resolveBuiltinRouteDescriptor(id);
      expect(descriptor, `missing route descriptor for ${id}`).not.toBeNull();
      expect(descriptor?.path).toBe(TAB_PATHS[id]);
    }
  });

  it("inherits route, surface, and layout classification through aliases", () => {
    const canonical = resolveBuiltinRouteDescriptor("automations");
    const alias = resolveBuiltinRouteDescriptor("triggers");

    expect(alias?.canonicalId).toBe("automations");
    expect(alias?.path).toBe(canonical?.path);
    expect(alias?.layout).toBe(canonical?.layout);
    expect(alias?.surface).toBe(canonical?.surface);
  });

  it("does not classify plugin-provided tab ids as built-ins", () => {
    expect(resolveBuiltinRouteDescriptor("some-plugin-tab")).toBeNull();
  });

  it.each(["database", "memories", "tasks", "automations"] as const)(
    "delegates %s width and gutter geometry to its FramedPage",
    (id) => {
      expect(resolveBuiltinRouteDescriptor(id)?.layout).toEqual({
        kind: "content",
        width: "standard",
        scroll: "view",
        gutter: "none",
      });
    },
  );

  it("matches scroll ownership to the current routed view architecture", () => {
    const shellScrolled = BUILTIN_ROUTE_IDS.filter(
      (id) => resolveBuiltinRouteDescriptor(id)?.layout.scroll === "shell",
    );
    expect(shellScrolled).toEqual(["inventory", "files"]);

    expect(resolveBuiltinRouteDescriptor("chat")?.layout).toEqual({
      kind: "immersive",
      topology: "ambient",
      width: "full",
      scroll: "view",
      gutter: "none",
    });
    expect(resolveBuiltinRouteDescriptor("background")?.layout).toEqual({
      kind: "immersive",
      width: "full",
      scroll: "view",
      gutter: "none",
    });
  });
});

describe("navigation prefix sub-tab resolution is registry-derived", () => {
  // Built-in `/apps/<sub>` and `/character/<sub>` routes must resolve to the
  // tab declared for that exact path in TAB_PATHS, so the routing table never
  // drifts from the canonical path registry. Every case below is derived from
  // TAB_PATHS, not from a second hand-maintained alias record.
  it("resolves /apps/<sub> tool routes from the TAB_PATHS registry", () => {
    expect(tabFromPath("/apps/plugins")).toBe("plugins");
    expect(tabFromPath("/apps/skills")).toBe("skills");
    expect(tabFromPath("/apps/trajectories")).toBe("trajectories");
    expect(tabFromPath("/apps/transcripts")).toBe("transcripts");
    expect(tabFromPath("/apps/relationships")).toBe("relationships");
    expect(tabFromPath("/apps/memories")).toBe("memories");
    expect(tabFromPath("/apps/files")).toBe("files");
    expect(tabFromPath("/apps/runtime")).toBe("runtime");
    expect(tabFromPath("/apps/database")).toBe("database");
    expect(tabFromPath("/apps/logs")).toBe("logs");
    expect(tabFromPath("/apps/tasks")).toBe("tasks");
  });

  it("resolves /character/<sub> hub routes from the TAB_PATHS registry", () => {
    expect(tabFromPath("/character/documents")).toBe("documents");
    expect(tabFromPath("/character/select")).toBe("character-select");
    expect(tabFromPath("/character/experience")).toBe("experience");
    expect(tabFromPath("/character/skills")).toBe("character-skills");
  });

  it("defaults unknown sub-paths to their prefix owner", () => {
    // Unknown /apps/<sub> is an app slug catch-all; unknown /character/<sub>
    // falls back to the character hub; a nested /apps/<sub>/<x> is a view.
    expect(tabFromPath("/apps/some-unknown-slug")).toBe("apps");
    expect(tabFromPath("/apps/plugins/nested")).toBe("views");
    expect(tabFromPath("/character/unknown-section")).toBe("character");
  });

  it("keeps only the two irreducible legacy prefix aliases", () => {
    // /apps/inventory (canonical tab path is /wallet) and
    // /character/relationships (canonical tab path is /apps/relationships) are
    // the ONLY paths whose target tab lives under a different prefix, so they
    // stay as an explicitly-marked host-owned fallback.
    expect(tabFromPath("/apps/inventory")).toBe("inventory");
    expect(tabFromPath("/character/relationships")).toBe("relationships");
  });

  it("legacy alias table holds no path already derivable from TAB_PATHS (drift guard)", () => {
    const canonicalPaths = new Set(Object.values(TAB_PATHS));
    for (const aliasPath of Object.keys(LEGACY_PREFIX_TAB_ALIASES)) {
      // If a legacy-alias path were also a canonical TAB_PATHS value, the
      // registry would already own it and the alias would be dead duplication.
      expect(canonicalPaths.has(aliasPath)).toBe(false);
    }
  });

  it("titles the tasks tab as Projects while the id and route stay stable", () => {
    // The coding-task orchestrator surface presents as "Projects"; renaming
    // the tab id or /apps/tasks route would break saved links + telemetry.
    expect(titleForTab("tasks")).toBe("Projects");
    expect(TAB_PATHS.tasks).toBe("/apps/tasks");
  });
});

describe("navigation index: no reintroduced hardcoded prefix alias record", () => {
  it("has no APPS_SUB_TABS record or inline /character/<sub> if-chain (grep guard)", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      "utf8",
    );
    // The old hand-maintained record declaration and the inline character sub
    // if-chain are gone from executable paths; resolution is registry-driven.
    expect(source).not.toMatch(/(?:const|let|var)\s+APPS_SUB_TABS\b/);
    expect(source).not.toMatch(/if\s*\(\s*sub\s*===\s*"documents"\s*\)/);
    expect(source).not.toMatch(/if\s*\(\s*sub\s*===\s*"select"\s*\)/);
  });
});

/**
 * `NATIVE_OS_VIEW_IDS` is a ROUTER-level filter: `App.tsx:1668` sends any tab
 * whose builtin id is in this list through the plugin-owned native-OS renderer
 * (`listAppShellPages()`), falling back to a legacy renderer. Membership is
 * therefore a claim about how a surface renders, not merely where it appears.
 *
 * `LAUNCHER_AOSP_ONLY_VIEW_IDS` composes that list plus `files`, and
 * `launcher-curation.ts:99` states the intent outright — it is sourced from the
 * canonical list "so this launcher gate and the router-level
 * `NATIVE_OS_VIEW_IDS` filter never drift."
 *
 * The launcher half of that claim is well covered by
 * `components/pages/launcher-curation.test.ts`. The router half is asserted
 * here, because the drift the launcher tests cannot see is the one that adds a
 * cross-platform view to the native-OS filter: the launcher keeps listing it
 * and stays green while the router quietly changes how it renders.
 */
describe("the native-OS / launcher view seam", () => {
  it("routes exactly the four native-OS surfaces", () => {
    expect([...NATIVE_OS_VIEW_IDS]).toEqual([
      "phone",
      "messages",
      "contacts",
      "camera",
    ]);
  });

  it("adds exactly Files to the launcher list, and appends it last", () => {
    expect([...LAUNCHER_AOSP_ONLY_VIEW_IDS]).toEqual([
      ...NATIVE_OS_VIEW_IDS,
      "files",
    ]);
  });

  /**
   * Pinned by SUBTRACTION rather than as a second hand-written list, so adding
   * a genuinely new native-OS surface does not need this assertion edited,
   * while promoting a launcher-only view into the router filter still fails.
   */
  it("keeps Files launcher-only and out of the router filter", () => {
    const nativeOs = new Set<string>(NATIVE_OS_VIEW_IDS);
    const launcherOnly = LAUNCHER_AOSP_ONLY_VIEW_IDS.filter(
      (id) => !nativeOs.has(id),
    );
    expect(launcherOnly).toEqual(["files"]);
    expect(nativeOs.has("files")).toBe(false);
  });

  /**
   * The reason the asymmetry exists, made concrete: the native-OS surfaces are
   * root-path shells, whereas Files is an `/apps/` view that stays routable on
   * web, desktop and iOS. Putting it in the router filter would send
   * `/apps/files` down the native-OS renderer path wherever that surface is
   * enabled.
   */
  it("separates root-path native shells from the /apps view", () => {
    expect(NATIVE_OS_VIEW_IDS.map((id) => pathForTab(id))).toEqual([
      "/phone",
      "/messages",
      "/contacts",
      "/camera",
    ]);
    expect(pathForTab("files")).toBe("/apps/files");
  });

  it("lists no id twice in either list", () => {
    expect([...new Set(NATIVE_OS_VIEW_IDS)]).toEqual([...NATIVE_OS_VIEW_IDS]);
    expect([...new Set(LAUNCHER_AOSP_ONLY_VIEW_IDS)]).toEqual([
      ...LAUNCHER_AOSP_ONLY_VIEW_IDS,
    ]);
  });

  // A generated table over an empty list registers zero cases and reports
  // green, so pin the arity the tables below are generated from.
  it("covers every launcher-gated view", () => {
    expect(NATIVE_OS_VIEW_IDS).toHaveLength(4);
    expect(LAUNCHER_AOSP_ONLY_VIEW_IDS).toHaveLength(5);
  });

  it.each(LAUNCHER_AOSP_ONLY_VIEW_IDS)(
    "%s is a builtin route with a tab path, so the gate cannot list a dead id",
    (id) => {
      expect(BUILTIN_ROUTE_IDS as readonly string[]).toContain(id);
      expect((TAB_PATHS as Record<string, string>)[id]).toBe(pathForTab(id));
    },
  );
});
