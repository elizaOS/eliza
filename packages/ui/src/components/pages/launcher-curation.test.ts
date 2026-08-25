/**
 * Unit tests for `curateLauncherPages` / `canonicalLauncherId` — the pure
 * launcher-page composition (system + release always, developer + preview gated
 * by their toggles) that `LauncherSurface` feeds into `Launcher`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ViewRegistryEntry } from "../../hooks/useAvailableViews";
import { mergeViewCatalog, type ViewEntry } from "../../hooks/view-catalog";
import {
  getInternalToolAppDescriptors,
  getInternalToolAppTargetTab,
} from "../apps/internal-tool-apps";
import {
  canonicalLauncherId,
  curateLauncherPages,
  normalizeLauncherLabel,
} from "./launcher-curation";

const ENABLED = { developer: true, preview: true } as const;

function entry(id: string, over: Partial<ViewEntry> = {}): ViewEntry {
  return {
    key: `view:${id}`,
    id,
    label: id.charAt(0).toUpperCase() + id.slice(1),
    hasHero: false,
    modality: "gui",
    state: "loaded",
    kind: "view",
    viewKind: "release",
    path: `/${id}`,
    ...over,
  };
}

function ids(page: ViewEntry[]): string[] {
  return page.map((e) => e.id);
}

function registeredView(
  id: string,
  { bundleUrl, path = `/${id}` }: { bundleUrl?: string; path?: string } = {},
): ViewRegistryEntry {
  return {
    id,
    label: id === "simple-calendar" ? "Calendar" : id,
    viewType: "gui",
    path,
    bundleUrl,
    available: true,
    pluginName:
      id === "simple-calendar"
        ? "@elizaos/plugin-simple-views"
        : "@elizaos/plugin-calendar",
    visibleInManager: true,
  };
}

const APPS_ONLY = { developer: false, preview: false } as const;

function registryEntry(
  id: string,
  over: Partial<ViewRegistryEntry> = {},
): ViewRegistryEntry {
  return {
    id,
    label: id,
    available: true,
    pluginName: `@elizaos/plugin-${id}`,
    viewType: "gui",
    path: `/${id}`,
    ...over,
  };
}

describe("routable launcher catalog pipeline", () => {
  it("surfaces shell destinations without leaking manager-hidden or curated-out views", () => {
    const merged = mergeViewCatalog({
      views: [
        registryEntry("settings", {
          builtin: true,
          pluginName: "@elizaos/builtin",
          visibleInManager: false,
        }),
        registryEntry("my-apps", {
          builtin: true,
          pluginName: "@elizaos/builtin",
          visibleInManager: false,
        }),
        registryEntry("views", {
          builtin: true,
          pluginName: "@elizaos/builtin",
          visibleInManager: false,
        }),
        registryEntry("database", {
          builtin: true,
          pluginName: "@elizaos/builtin",
          visibleInManager: false,
        }),
        registryEntry("hidden-plugin", { visibleInManager: false }),
        registryEntry("wallet", { visibleInManager: true }),
      ],
      catalog: [],
      installed: [],
      activeModality: "gui",
      enabledKinds: APPS_ONLY,
      visibilityScope: "routable",
    });

    const page = curateLauncherPages(merged, {
      isAosp: false,
      enabledKinds: APPS_ONLY,
      cloudActive: false,
    });

    // The stale builtin `my-apps` registration collapses onto the consolidated
    // Projects tile (#17031) instead of resurrecting the retired view.
    expect(ids(page)).toEqual(["settings", "wallet", "tasks"]);
    expect(ids(page)).not.toContain("views");
    expect(ids(page)).not.toContain("database");
    expect(ids(page)).not.toContain("hidden-plugin");
  });
});

describe("curateLauncherPages", () => {
  it("puts apps then developer tools on ONE page when Developer Mode is on", () => {
    const page = curateLauncherPages(
      [
        entry("wallet"),
        entry("browser"),
        entry("settings"),
        entry("trajectories", { viewKind: "developer" }),
        entry("database", { viewKind: "developer" }),
        entry("runtime"),
        entry("logs", { viewKind: "developer" }),
        entry("skills"),
        entry("plugins"),
      ],
      { isAosp: false, enabledKinds: ENABLED, cloudActive: true },
    );

    // Single page: curated apps first, then the developer tools in their order.
    expect(ids(page)).toEqual([
      "settings",
      "wallet",
      "browser",
      "trajectories",
      "database",
      "runtime",
      "logs",
      "skills",
      "plugins",
    ]);
  });

  it("hides ALL developer tools when Developer Mode is off (default)", () => {
    // runtime/skills/plugins carry no viewKind here, but DEVELOPER_INDEX
    // membership makes them developer-kind, so the whole set hides together.
    const page = curateLauncherPages(
      [
        entry("wallet"),
        entry("settings"),
        entry("trajectories", { viewKind: "developer" }),
        entry("database", { viewKind: "developer" }),
        entry("runtime"),
        entry("logs", { viewKind: "developer" }),
        entry("skills"),
        entry("plugins"),
      ],
      { isAosp: false, enabledKinds: APPS_ONLY, cloudActive: true },
    );
    expect(ids(page)).toEqual(["settings", "wallet"]);
  });

  it("drops removed apps and non-launcher shell surfaces (incl. chat)", () => {
    const page = curateLauncherPages(
      [
        entry("wallet"),
        entry("chat"),
        entry("views"),
        entry("views-manager"),
        entry("apps"),
        entry("background"),
        entry("companion"),
        entry("model-tester"),
        entry("shopify"),
      ],
      { isAosp: false, enabledKinds: ENABLED, cloudActive: true },
    );

    // chat is the home surface — never a launcher tile (#14479).
    expect(ids(page)).toEqual(["wallet"]);
  });

  it("never tiles the headless device-control capability surface, on or off AOSP", () => {
    for (const isAosp of [false, true]) {
      const page = curateLauncherPages(
        [entry("device-control"), entry("settings"), entry("wallet")],
        { isAosp, enabledKinds: ENABLED, cloudActive: true },
      );
      expect(ids(page)).toEqual(["settings", "wallet"]);
    }
  });

  it("never shows a chat launcher tile, even with Developer Mode on (#14479)", () => {
    const page = curateLauncherPages(
      [entry("chat"), entry("settings"), entry("wallet")],
      { isAosp: false, enabledKinds: ENABLED, cloudActive: true },
    );
    expect(ids(page)).not.toContain("chat");
    expect(ids(page)).toEqual(["settings", "wallet"]);
  });

  it("never tiles relationships — it is a Character section, not an app", () => {
    const views = [entry("wallet"), entry("relationships"), entry("settings")];
    // The character family is ONE launcher tile; Relationships is reached via
    // the Character section strip (CharacterSectionNav), so no standalone tile
    // in any profile — including Developer Mode.
    expect(
      ids(
        curateLauncherPages(views, {
          isAosp: false,
          enabledKinds: APPS_ONLY,
          cloudActive: true,
        }),
      ),
    ).toEqual(["settings", "wallet"]);
    expect(
      ids(
        curateLauncherPages(views, {
          isAosp: false,
          enabledKinds: ENABLED,
          cloudActive: true,
        }),
      ),
    ).not.toContain("relationships");
  });

  it("keeps wallet-group sub-pages out of the launcher", () => {
    const page = curateLauncherPages(
      [
        entry("wallet"),
        entry("perps", { group: "wallet" }),
        entry("predictions", { group: "wallet" }),
      ],
      { isAosp: false, enabledKinds: ENABLED, cloudActive: true },
    );
    expect(ids(page)).toEqual(["wallet"]);
  });

  it("shows the same pages as ordinary apps when they do not declare a group", () => {
    const page = curateLauncherPages(
      [entry("wallet"), entry("perps"), entry("predictions")],
      { isAosp: false, enabledKinds: ENABLED, cloudActive: true },
    );
    expect(ids(page)).toEqual(["wallet", "perps", "predictions"]);
  });

  it("gates native-OS tiles to the AOSP fork", () => {
    const views = [
      entry("wallet"),
      entry("phone"),
      entry("messages"),
      entry("contacts"),
      entry("camera", { viewKind: "preview" }),
      entry("files"),
    ];

    expect(
      ids(
        curateLauncherPages(views, {
          isAosp: false,
          enabledKinds: ENABLED,
          cloudActive: true,
        }),
      ),
    ).toEqual(["wallet"]);
    expect(
      ids(
        curateLauncherPages(views, {
          isAosp: true,
          enabledKinds: ENABLED,
          cloudActive: true,
        }),
      ),
    ).toEqual(["wallet", "phone", "messages", "contacts", "camera", "files"]);
  });

  it("gates cloud-only tiles behind an active Eliza Cloud connection (#10725)", () => {
    // The cloud account app is viewKind:"release", so without the gate it would
    // tile regardless of cloud state.
    const views = [entry("wallet"), entry("cloud", { label: "Cloud" })];
    // Signed out of cloud: the cloud account tile is hidden.
    expect(
      ids(
        curateLauncherPages(views, {
          isAosp: false,
          enabledKinds: ENABLED,
          cloudActive: false,
        }),
      ),
    ).toEqual(["wallet"]);
    // Signed in: it surfaces on the apps page.
    expect(
      ids(
        curateLauncherPages(views, {
          isAosp: false,
          enabledKinds: ENABLED,
          cloudActive: true,
        }),
      ),
    ).toEqual(["wallet", "cloud"]);
  });

  it("never tiles the Cloud Applications studio — Projects is the one apps tile", () => {
    // Consolidation (#17031): `cloud-apps` (the native Cloud Applications
    // studio, label "Cloud Apps") is reached from the Projects view's Apps
    // segment and by /cloud-apps deep link; the launcher must show exactly one
    // apps destination whether or not cloud is signed in, and a stale
    // `my-apps` registration folds onto that same tile.
    const views = [
      entry("wallet"),
      entry("tasks", { label: "Projects", builtin: true }),
      entry("my-apps", { label: "My Apps", builtin: true }),
      entry("cloud-apps", { label: "Cloud Apps" }),
    ];
    for (const cloudActive of [false, true]) {
      const page = curateLauncherPages(views, {
        isAosp: false,
        enabledKinds: ENABLED,
        cloudActive,
      });
      expect(ids(page)).toEqual(["wallet", "tasks"]);
      expect(page.find((e) => e.id === "tasks")?.label).toBe("Projects");
    }
  });

  it("shows registered Notes and Calendar views without requiring Cloud auth", () => {
    const views = [
      entry("notes", { label: "Notes" }),
      entry("calendar", { label: "Calendar" }),
    ];

    expect(
      ids(
        curateLauncherPages(views, {
          isAosp: false,
          enabledKinds: APPS_ONLY,
          cloudActive: false,
        }),
      ),
    ).toEqual(["calendar", "notes"]);
    expect(
      ids(
        curateLauncherPages(views, {
          isAosp: false,
          enabledKinds: APPS_ONLY,
          cloudActive: true,
        }),
      ),
    ).toEqual(["calendar", "notes"]);
  });

  it("shows only Simple Views Calendar when connected Calendar is also registered", () => {
    const page = curateLauncherPages(
      [
        entry("calendar", {
          label: "Calendar",
          path: "/calendar",
          builtin: true,
        }),
        entry("simple-calendar", {
          label: "Calendar",
          path: "/simple-calendar",
          view: registeredView("simple-calendar", {
            bundleUrl: "/api/views/simple-calendar/bundle.js",
            path: "/simple-calendar",
          }),
        }),
      ],
      { isAosp: false, enabledKinds: APPS_ONLY, cloudActive: false },
    );

    expect(ids(page)).toEqual(["simple-calendar"]);
    expect(page[0]?.path).toBe("/simple-calendar");
  });

  it("keeps connected Calendar as a fallback when Simple Views is absent", () => {
    const page = curateLauncherPages(
      [
        entry("calendar", {
          label: "Calendar",
          path: "/calendar",
          builtin: true,
        }),
      ],
      { isAosp: false, enabledKinds: APPS_ONLY, cloudActive: false },
    );

    expect(ids(page)).toEqual(["calendar"]);
    expect(page[0]?.path).toBe("/calendar");
  });

  it("prefers the native app-shell Simple Calendar when remote bundle URLs are stripped", () => {
    const page = curateLauncherPages(
      [
        entry("calendar", {
          label: "Calendar",
          path: "/calendar",
          builtin: true,
        }),
        entry("simple-calendar", {
          label: "Calendar",
          path: "/simple-calendar",
          view: registeredView("simple-calendar", {
            path: "/simple-calendar",
          }),
        }),
      ],
      { isAosp: true, enabledKinds: APPS_ONLY, cloudActive: false },
    );

    expect(ids(page)).toEqual(["simple-calendar"]);
    expect(page[0]?.path).toBe("/simple-calendar");
  });

  it("collapses duplicate wallet + automations registrations, keeping Tasks its own tile", () => {
    const page = curateLauncherPages(
      [
        entry("inventory", { builtin: true }),
        entry("wallet.inventory", { kind: "view", state: "loaded" }),
        entry("wallet", { kind: "view", state: "loaded" }),
        entry("automations"),
        entry("triggers"),
        entry("tasks"),
        entry("task-coordinator"),
        entry("todos"),
      ],
      { isAosp: false, enabledKinds: ENABLED, cloudActive: true },
    );
    // `triggers`/`todos` fold into `automations`; `tasks`/`task-coordinator`
    // collapse to the standalone Tasks orchestrator tile (no longer folded into
    // automations). Order follows LAUNCHER_APPS_ORDER: wallet, tasks, automations.
    expect(ids(page)).toEqual(["wallet", "tasks", "automations"]);
  });

  it("re-points an alias-winning tile at the canonical route (not the alias path)", () => {
    // Only an aliased registration (todos → automations) is present, no canonical
    // `automations`. The tile carries the canonical id AND the canonical tab's
    // route, so handleLaunch navigates to /automations — never /todos and never
    // the bogus /apps/automations fallback that used to open the old apps view.
    const page = curateLauncherPages([entry("todos", { path: "/todos" })], {
      isAosp: false,
      enabledKinds: ENABLED,
      cloudActive: true,
    });
    const tile = page[0];
    expect(tile.id).toBe("automations");
    expect(tile.path).toBe("/automations");
  });

  it("keeps a non-aliased winner's real path intact", () => {
    const page = curateLauncherPages(
      [entry("wallet", { path: "/wallet", kind: "view", state: "loaded" })],
      { isAosp: false, enabledKinds: ENABLED, cloudActive: true },
    );
    const tile = page[0];
    expect(tile.id).toBe("wallet");
    expect(tile.path).toBe("/wallet");
  });

  it("hides preview views by default and shows them when Preview Mode is on", () => {
    const views = [entry("wallet"), entry("labs", { viewKind: "preview" })];
    expect(
      ids(
        curateLauncherPages(views, {
          isAosp: false,
          enabledKinds: APPS_ONLY,
          cloudActive: true,
        }),
      ),
    ).toEqual(["wallet"]);
    expect(
      ids(
        curateLauncherPages(views, {
          isAosp: false,
          enabledKinds: { developer: false, preview: true },
          cloudActive: true,
        }),
      ),
    ).toEqual(["wallet", "labs"]);
  });

  it("appends other loaded apps after the curated order on the page", () => {
    const page = curateLauncherPages(
      [
        entry("browser"),
        entry("zebra-app"),
        entry("wallet"),
        entry("alpha-app"),
      ],
      { isAosp: false, enabledKinds: ENABLED, cloudActive: true },
    );
    expect(ids(page)).toEqual(["wallet", "browser", "alpha-app", "zebra-app"]);
  });

  it("hides uncurated developer views unless Developer Mode is enabled", () => {
    const views = [entry("wallet"), entry("secret", { viewKind: "developer" })];
    expect(
      ids(
        curateLauncherPages(views, {
          isAosp: false,
          enabledKinds: APPS_ONLY,
          cloudActive: true,
        }),
      ),
    ).toEqual(["wallet"]);
    // vector-browser-style dev views join the single page (after apps) when on.
    expect(
      ids(
        curateLauncherPages(views, {
          isAosp: false,
          enabledKinds: ENABLED,
          cloudActive: true,
        }),
      ),
    ).toEqual(["wallet", "secret"]);
  });
});

describe("curateLauncherPages — full realistic view set", () => {
  // Mirrors what /api/views + builtin shell views + loaded plugins return so the
  // asserted layout is the actual launcher a user sees, not a toy subset.
  const REAL_VIEWS: ViewEntry[] = [
    // Shell surfaces that must never tile, except Chat which is launchable from
    // the seeded dock.
    entry("chat"),
    entry("views"),
    entry("views-manager"),
    entry("apps"),
    entry("background", { viewKind: "preview" }),
    entry("voice"),
    entry("character-select"),
    entry("desktop"),
    // Removed apps.
    entry("companion"),
    entry("model-tester"),
    entry("shopify"),
    // Wallet + duplicate registrations + grouped sub-views.
    entry("wallet", { viewKind: "system" }),
    entry("inventory", { builtin: true, viewKind: "system" }),
    entry("wallet.inventory"),
    entry("perps", { group: "wallet" }),
    entry("predictions", { group: "wallet" }),
    // Automations + duplicates folded to one.
    entry("automations", { viewKind: "system" }),
    entry("triggers", { builtin: true }),
    entry("tasks", { builtin: true }),
    entry("todos"),
    entry("task-coordinator", { viewKind: "preview" }),
    // Stale everyday-apps registration — folds onto the Projects tile (#17031).
    entry("my-apps", { label: "My Apps", builtin: true }),
    // The native Cloud Applications studio — folded into Projects, never a tile.
    entry("cloud-apps", { label: "Cloud Apps" }),
    entry("calendar", {
      label: "Calendar",
      view: registeredView("calendar", { path: "/calendar" }),
    }),
    entry("simple-calendar", {
      label: "Calendar",
      view: registeredView("simple-calendar", {
        bundleUrl: "/api/views/simple-calendar/bundle.js",
        path: "/simple-calendar",
      }),
    }),
    entry("notes", { label: "Notes" }),
    entry("browser"),
    entry("character", { viewKind: "system" }),
    entry("documents", { viewKind: "system" }),
    entry("character-skills", { viewKind: "system" }),
    entry("experience", { viewKind: "system" }),
    entry("transcripts", { viewKind: "system" }),
    entry("relationships", { viewKind: "system" }),
    entry("memories", { viewKind: "system" }),
    entry("stream"),
    // Builtin tab with no declared kind — curation must still force preview.
    entry("pendant-transcript", { builtin: true, label: "Pendant Transcript" }),
    entry("settings", { viewKind: "system" }),
    // Native-OS (AOSP fork only).
    entry("phone", { builtin: true }),
    entry("messages", { builtin: true }),
    entry("contacts", { builtin: true }),
    entry("camera", { viewKind: "preview" }),
    entry("files", { builtin: true }),
    // Developer tools.
    entry("trajectories", { viewKind: "developer" }),
    entry("trajectory-logger", { viewKind: "developer" }),
    entry("database", { viewKind: "developer" }),
    entry("runtime", { builtin: true }),
    entry("logs", { viewKind: "developer" }),
    entry("skills", { builtin: true }),
    entry("plugins", { viewKind: "system" }),
    entry("plugins-page", { viewKind: "system" }),
  ];

  it("produces the exact off-fork ONE-page layout (developer on → tools after apps)", () => {
    expect(
      ids(
        curateLauncherPages(REAL_VIEWS, {
          isAosp: false,
          enabledKinds: ENABLED,
          cloudActive: true,
        }),
      ),
    ).toEqual([
      // chat is the home surface — no launcher tile (#14479); cloud-apps and
      // the stale my-apps registration fold into the Projects (tasks) tile.
      "settings",
      "wallet",
      "tasks",
      "simple-calendar",
      "notes",
      "automations",
      "browser",
      "character",
      "documents",
      "memories",
      "stream",
      "pendant-transcript",
      "trajectories",
      "database",
      "runtime",
      "logs",
      "skills",
      "plugins",
    ]);
  });

  it("hides the developer tools AND the forced-preview surfaces in the default (production) profile", () => {
    expect(
      ids(
        curateLauncherPages(REAL_VIEWS, {
          isAosp: false,
          enabledKinds: { developer: false, preview: false },
          cloudActive: true,
        }),
      ),
    ).toEqual([
      // chat + relationships are not everyday grid tiles (#14479).
      "settings",
      "wallet",
      "tasks",
      "simple-calendar",
      "notes",
      "automations",
      "browser",
      "character",
      "documents",
      "memories",
    ]);
  });

  it("forces stream/pendant to preview while relationships stays inside Character", () => {
    // Preview on, developer off: the preview surfaces return while developer
    // tools remain hidden and relationships stays inside Character.
    const previewOnly = ids(
      curateLauncherPages(REAL_VIEWS, {
        isAosp: false,
        enabledKinds: { developer: false, preview: true },
        cloudActive: true,
      }),
    );
    for (const id of ["stream", "pendant-transcript"]) {
      expect(previewOnly).toContain(id);
    }
    expect(previewOnly).not.toContain("trajectories");
    expect(previewOnly).not.toContain("relationships");

    // Developer on, preview off: developer tools return, relationships remains
    // a Character section, and preview surfaces stay hidden.
    const developerOnly = ids(
      curateLauncherPages(REAL_VIEWS, {
        isAosp: false,
        enabledKinds: { developer: true, preview: false },
        cloudActive: true,
      }),
    );
    // relationships is a Character section, never a tile — even developer-on.
    expect(developerOnly).not.toContain("relationships");
    for (const id of ["stream", "pendant-transcript"]) {
      expect(developerOnly).not.toContain(id);
    }
  });

  it("appends the native-OS tiles to the single page on the AOSP fork", () => {
    const appsPage = ids(
      curateLauncherPages(REAL_VIEWS, {
        isAosp: true,
        enabledKinds: ENABLED,
        cloudActive: true,
      }),
    );
    expect(appsPage.slice(-5)).toEqual([
      "phone",
      "messages",
      "contacts",
      "camera",
      "files",
    ]);
  });
});

describe("launcher dead-tile guard", () => {
  it("collapses the legacy 'rolodex' alias into relationships and neither tiles", () => {
    // `rolodex` canonicalizes onto `relationships`, and relationships itself
    // is hidden (a Character section, not an app) — so the alias produces NO
    // tile at all instead of a dead standalone one.
    expect(canonicalLauncherId("rolodex")).toBe("relationships");
    const page = curateLauncherPages(
      [entry("chat"), entry("rolodex"), entry("relationships")],
      { isAosp: false, enabledKinds: ENABLED, cloudActive: true },
    );
    expect(ids(page)).not.toContain("rolodex");
    expect(ids(page)).not.toContain("relationships");
  });
});

describe("canonicalLauncherId", () => {
  it("maps duplicate/alias ids to their canonical launcher id", () => {
    expect(canonicalLauncherId("inventory")).toBe("wallet");
    expect(canonicalLauncherId("wallet.inventory")).toBe("wallet");
    expect(canonicalLauncherId("triggers")).toBe("automations");
    expect(canonicalLauncherId("todos")).toBe("automations");
    expect(canonicalLauncherId("plugins-page")).toBe("plugins");
    expect(canonicalLauncherId("trajectory-logger")).toBe("trajectories");
    expect(canonicalLauncherId("browser")).toBe("browser");
  });
});

describe("canonicalLauncherId derives package-name mapping from owner declarations", () => {
  // #12641: the `@elizaos/...` package-name -> canonical switch used to be a
  // hand-kept literal map inside launcher-curation that silently drifted from
  // the internal-tool app declarations. It now derives from each declaration's
  // own `targetTab`, so a package rename/add flows through with no edit here.
  it("canonicalizes an internal-tool app package name to its declared targetTab", () => {
    // The task-coordinator package name collapses onto the tasks tile via its
    // declaration (the short `task-coordinator` alias keeps its legacy row).
    expect(canonicalLauncherId("@elizaos/plugin-task-coordinator")).toBe(
      "tasks",
    );
    expect(canonicalLauncherId("task-coordinator")).toBe("tasks");
  });

  it("collapses an internal-tool app catalog card onto its canonical tile without a curation edit", () => {
    // An internal-tool app surfaces in the launcher as a catalog card whose id
    // IS the package name (appToEntry uses `id: app.name`). Curation must fold
    // it onto the owning tab tile from the declaration alone.
    const targetTab = getInternalToolAppTargetTab(
      "@elizaos/plugin-task-coordinator",
    );
    expect(targetTab).toBe("tasks");
    const page = curateLauncherPages(
      [
        entry("chat"),
        entry("tasks", { viewKind: "system" }),
        // Catalog card for the same surface, keyed by package name.
        entry("@elizaos/plugin-task-coordinator", {
          kind: "app",
          state: "available",
          viewKind: "system",
        }),
      ],
      { isAosp: false, enabledKinds: ENABLED, cloudActive: true },
    );
    // One tasks tile, no stray package-name tile.
    expect(ids(page).filter((id) => id === "tasks")).toHaveLength(1);
    expect(ids(page)).not.toContain("@elizaos/plugin-task-coordinator");
  });
});

describe("launcher-curation brittle-package-name grep guard (#12641)", () => {
  const sourcePath = fileURLToPath(
    new URL("./launcher-curation.ts", import.meta.url),
  );
  const source = readFileSync(sourcePath, "utf8");

  it("no plugin/app package-name literal survives as a curation switch", () => {
    // The audit finding: launcher curation hardcodes plugin package names. Any
    // `@elizaos/plugin-*` / `@elizaos/app-*` literal reintroduced into this
    // module is a regression — the package-name -> canonical mapping must come
    // from owner declarations. (Strip line/block comments so the doc references
    // above don't false-fail; the `@elizaos/core` runtime import is not a
    // package-name SWITCH so the guard targets plugin/app package literals.)
    const executable = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // The `@elizaos/core` framework import is a dependency, not a curation
    // switch. The regression the audit flagged is plugin/app PACKAGE-NAME
    // literals (`@elizaos/plugin-*`, `@elizaos/app-*`) being hand-mapped to a
    // canonical id here; those must come from the owner declarations instead.
    expect(executable).not.toMatch(/@elizaos\/(?:plugin|app)-/);
  });

  it("reads package-name canonicalization from the internal-tool declarations", () => {
    // Proves the coupling is inverted: curation imports the owner metadata
    // helper instead of re-listing package names.
    expect(source).toContain("getInternalToolAppTargetTab");
  });
});

describe("normalizeLauncherLabel", () => {
  it("collapses the whitespace/hyphenation variants of one label to a single form", () => {
    // The audit's `Fin Tuning` / `Fine-Tuning` / `Fine - Tuning` sloppiness: all
    // three must normalize to one canonical label so they can never render as
    // visually different tiles.
    expect(normalizeLauncherLabel("Fine-Tuning")).toBe("Fine-Tuning");
    expect(normalizeLauncherLabel("Fine - Tuning")).toBe("Fine-Tuning");
    expect(normalizeLauncherLabel("  Fine-Tuning  ")).toBe("Fine-Tuning");
  });

  it("normalizes slash spacing and collapses internal runs of whitespace", () => {
    expect(normalizeLauncherLabel("Games / Fun")).toBe("Games/Fun");
    expect(normalizeLauncherLabel("A   B")).toBe("A B");
  });

  it("is applied to curated tile labels so a spaced registration renders normalized", () => {
    const page = curateLauncherPages(
      [
        entry("settings", { label: "  Settings  " }),
        entry("wallet", { label: "Wallet" }),
      ],
      { isAosp: false, enabledKinds: ENABLED, cloudActive: true },
    );
    const settings = page.find((e) => e.id === "settings");
    expect(settings?.label).toBe("Settings");
  });
});

describe("launcher label-duplication lint", () => {
  // Fails when two DISTINCT visible launcher tiles resolve to the same
  // normalized label — the audit's "Duplicate and inconsistent labels make the
  // launcher look sloppy". Duplicate registrations for the SAME surface are
  // collapsed by canonical-id dedup before they reach here; a collision that
  // survives means two genuinely different surfaces share a label and one must
  // be renamed.
  function assertNoDuplicateVisibleLabels(page: ViewEntry[]): void {
    const byLabel = new Map<string, string>();
    for (const tile of page) {
      const label = normalizeLauncherLabel(tile.label);
      const existing = byLabel.get(label);
      if (existing && existing !== tile.id) {
        throw new Error(
          `Duplicate launcher label "${label}" on tiles "${existing}" and "${tile.id}"`,
        );
      }
      byLabel.set(label, tile.id);
    }
  }

  it("has no duplicate visible labels across the full realistic curated set", () => {
    // The registry's own labels: derive one entry per curated/internal-tool id
    // and prove the curated page carries no two-different-surface label clash.
    const declarations = getInternalToolAppDescriptors();
    const views: ViewEntry[] = [
      entry("chat", { label: "Chat", viewKind: "system" }),
      entry("settings", { label: "Settings", viewKind: "system" }),
      entry("wallet", { label: "Wallet", viewKind: "system" }),
      entry("calendar", {
        label: "Calendar",
        view: registeredView("calendar", { path: "/calendar" }),
      }),
      entry("simple-calendar", {
        label: "Calendar",
        view: registeredView("simple-calendar", {
          bundleUrl: "/api/views/simple-calendar/bundle.js",
          path: "/simple-calendar",
        }),
      }),
      entry("notes", { label: "Notes" }),
      entry("browser", { label: "Browser" }),
      entry("automations", { label: "Automations", viewKind: "system" }),
      entry("tasks", { label: "Projects", builtin: true }),
      entry("character", { label: "Character", viewKind: "system" }),
      entry("relationships", { label: "Relationships", viewKind: "system" }),
      entry("documents", { label: "Documents", viewKind: "system" }),
      entry("memories", { label: "Memories", viewKind: "system" }),
      // Every internal-tool declaration keyed by its own targetTab + declared
      // label — the real plugins/skills/trajectory/etc. tiles.
      ...declarations.map((d) =>
        entry(getInternalToolAppTargetTab(d.name) ?? d.name, {
          label: d.displayName,
          viewKind: "developer",
        }),
      ),
    ];
    const page = curateLauncherPages(views, {
      isAosp: false,
      enabledKinds: ENABLED,
      cloudActive: true,
    });
    expect(() => assertNoDuplicateVisibleLabels(page)).not.toThrow();
  });

  it("detects a genuine two-surface label clash (guard is not vacuous)", () => {
    // Two DIFFERENT ids with the same label must trip the lint — proves the
    // assertion actually fires and is not a no-op that always passes.
    const clash = [
      entry("wallet", { label: "Money" }),
      entry("browser", { label: "Money" }),
    ];
    expect(() => assertNoDuplicateVisibleLabels(clash)).toThrow(
      /Duplicate launcher label/,
    );
  });
});
