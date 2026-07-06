/**
 * Unit tests for `curateLauncherPages` / `canonicalLauncherId` — the pure
 * launcher-page composition (system + release always, developer + preview gated
 * by their toggles) that `LauncherSurface` feeds into `Launcher`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ViewEntry } from "../../hooks/view-catalog";
import {
  getInternalToolAppDescriptors,
  getInternalToolAppTargetTab,
} from "../apps/internal-tool-apps";
import {
  canonicalLauncherId,
  curateLauncherPages,
  curateLauncherZones,
  LAUNCHER_RECENTS_ZONE_LIMIT,
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

const APPS_ONLY = { developer: false, preview: false } as const;

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
        entry("facewear", { viewKind: "preview" }),
        entry("smartglasses", { viewKind: "preview" }),
      ],
      { isAosp: false, enabledKinds: ENABLED, cloudActive: true },
    );

    // chat is the home surface — never a launcher tile (#14479).
    expect(ids(page)).toEqual(["wallet"]);
  });

  it("never shows a chat launcher tile, even with Developer Mode on (#14479)", () => {
    const page = curateLauncherPages(
      [entry("chat"), entry("settings"), entry("wallet")],
      { isAosp: false, enabledKinds: ENABLED, cloudActive: true },
    );
    expect(ids(page)).not.toContain("chat");
    expect(ids(page)).toEqual(["settings", "wallet"]);
  });

  it("hides relationships by default, shows it only in Developer Mode (#14479)", () => {
    const views = [entry("wallet"), entry("relationships"), entry("settings")];
    // Default (no developer/preview): relationships is developer-gated → hidden.
    expect(
      ids(
        curateLauncherPages(views, {
          isAosp: false,
          enabledKinds: APPS_ONLY,
          cloudActive: true,
        }),
      ),
    ).toEqual(["settings", "wallet"]);
    // Developer Mode on: relationships reappears (kept, not deleted).
    expect(
      ids(
        curateLauncherPages(views, {
          isAosp: false,
          enabledKinds: ENABLED,
          cloudActive: true,
        }),
      ),
    ).toContain("relationships");
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
    // cloud-apps is viewKind:"release", so without the gate it would show as an
    // "Apps" tile regardless of cloud state.
    const views = [entry("wallet"), entry("cloud-apps", { label: "Apps" })];
    // Signed out of cloud: the cloud dashboard tile is hidden.
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
    ).toEqual(["wallet", "cloud-apps"]);
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
    entry("facewear", { viewKind: "preview" }),
    entry("smartglasses", { viewKind: "preview" }),
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
    // Everyday apps.
    entry("browser"),
    entry("character", { viewKind: "system" }),
    entry("documents", { viewKind: "system" }),
    entry("character-skills", { viewKind: "system" }),
    entry("experience", { viewKind: "system" }),
    entry("transcripts", { viewKind: "system" }),
    entry("relationships", { viewKind: "system" }),
    entry("memories", { viewKind: "system" }),
    entry("feed", { viewKind: "system" }),
    entry("stream"),
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
    // Training UI — declared release, forced developer by curation.
    entry("fine-tuning"),
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
      // chat is the home surface — no launcher tile (#14479).
      "settings",
      "wallet",
      "tasks",
      "automations",
      "browser",
      "character",
      "documents",
      "character-skills",
      "experience",
      "memories",
      "feed",
      "stream",
      "trajectories",
      "database",
      "runtime",
      "logs",
      "skills",
      "plugins",
      "fine-tuning",
      // relationships is developer-gated (#14479) — shows in the dev section.
      "relationships",
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
      "automations",
      "browser",
      "character",
      "documents",
      "character-skills",
      "experience",
      "memories",
    ]);
  });

  it("forces feed/stream to preview and fine-tuning + relationships to developer regardless of declared kind", () => {
    // Preview on, developer off: the preview surfaces come back, the training UI
    // and relationships stay hidden (they are developer-gated, not preview).
    const previewOnly = ids(
      curateLauncherPages(REAL_VIEWS, {
        isAosp: false,
        enabledKinds: { developer: false, preview: true },
        cloudActive: true,
      }),
    );
    for (const id of ["feed", "stream"]) {
      expect(previewOnly).toContain(id);
    }
    expect(previewOnly).not.toContain("fine-tuning");
    expect(previewOnly).not.toContain("trajectories");
    expect(previewOnly).not.toContain("relationships");

    // Developer on, preview off: the training UI + relationships show with the
    // dev tools, the preview surfaces (feed/stream) stay hidden.
    const developerOnly = ids(
      curateLauncherPages(REAL_VIEWS, {
        isAosp: false,
        enabledKinds: { developer: true, preview: false },
        cloudActive: true,
      }),
    );
    expect(developerOnly).toContain("fine-tuning");
    expect(developerOnly).toContain("relationships");
    for (const id of ["feed", "stream"]) {
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
  it("collapses the legacy 'rolodex' alias into relationships (no standalone dead tile)", () => {
    // `rolodex` is a routable tab with a launcher tile but no
    // renderStaticViewRouterTab branch, so a standalone tile bounced the user
    // back to the launcher fallback. The canonical dedup rewrites it onto
    // `relationships` (the real contact surface) before it can tile on its own.
    expect(canonicalLauncherId("rolodex")).toBe("relationships");
    const page = curateLauncherPages(
      [entry("chat"), entry("rolodex"), entry("relationships")],
      { isAosp: false, enabledKinds: ENABLED, cloudActive: true },
    );
    expect(ids(page)).not.toContain("rolodex");
    expect(ids(page)).toContain("relationships");
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
    // Live case: the fine-tuning surface used to require a literal
    // `["@elizaos/plugin-training", "fine-tuning"]` row in launcher-curation.
    expect(getInternalToolAppTargetTab("@elizaos/plugin-training")).toBe(
      "fine-tuning",
    );
    expect(canonicalLauncherId("@elizaos/plugin-training")).toBe("fine-tuning");

    // The task-coordinator PACKAGE NAME collapses onto the tasks tile via its
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
    const targetTab = getInternalToolAppTargetTab("@elizaos/plugin-training");
    expect(targetTab).toBe("fine-tuning");
    const page = curateLauncherPages(
      [
        entry("chat"),
        entry("fine-tuning", { viewKind: "developer" }),
        // Catalog card for the same surface, keyed by package name.
        entry("@elizaos/plugin-training", {
          kind: "app",
          state: "available",
          viewKind: "developer",
        }),
      ],
      { isAosp: false, enabledKinds: ENABLED, cloudActive: true },
    );
    // One "fine-tuning" tile, no stray `@elizaos/...` package-name tile.
    expect(ids(page).filter((id) => id === "fine-tuning")).toHaveLength(1);
    expect(ids(page)).not.toContain("@elizaos/plugin-training");
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
    expect(normalizeLauncherLabel("Fine-Tuning")).toBe(
      normalizeLauncherLabel("Fine - Tuning"),
    );
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
      entry("browser", { label: "Browser" }),
      entry("automations", { label: "Automations", viewKind: "system" }),
      entry("tasks", { label: "Tasks", builtin: true }),
      entry("character", { label: "Character", viewKind: "system" }),
      entry("relationships", { label: "Relationships", viewKind: "system" }),
      entry("documents", { label: "Documents", viewKind: "system" }),
      entry("memories", { label: "Memories", viewKind: "system" }),
      // Every internal-tool declaration keyed by its own targetTab + declared
      // label — the real fine-tuning/plugins/skills/… tiles.
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

  it("collapses the historical triple 'Fine-Tuning' registrations to a single labelled tile", () => {
    // `advanced` + `fine-tuning` builtin tabs + the `training` plugin view all
    // route to /apps/fine-tuning; with per-registration label drift they read as
    // `Fin Tuning` / `Fine-Tuning` / `Fine-Tuning`. Curation folds them to one
    // canonical tile, and the surviving label is normalized.
    const page = curateLauncherPages(
      [
        entry("advanced", { label: "Fin Tuning" }),
        entry("fine-tuning", { label: "Fine - Tuning", viewKind: "developer" }),
        entry("training", { label: "Fine-Tuning" }),
      ],
      { isAosp: false, enabledKinds: ENABLED, cloudActive: true },
    );
    const fineTuning = page.filter((e) => e.id === "fine-tuning");
    expect(fineTuning).toHaveLength(1);
    expect(fineTuning[0].label).toBe("Fine-Tuning");
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

describe("curateLauncherZones", () => {
  const PAGE = curateLauncherPages(
    [
      entry("chat"),
      entry("settings"),
      entry("wallet"),
      entry("browser"),
      entry("documents", { viewKind: "system" }),
    ],
    { isAosp: false, enabledKinds: ENABLED, cloudActive: true },
  );

  it("projects Recents and Favorites over the curated page and keeps All Apps exhaustive", () => {
    const zones = curateLauncherZones(PAGE, {
      recentIds: ["browser", "wallet"],
      favoriteIds: ["settings"],
      recentsLimit: LAUNCHER_RECENTS_ZONE_LIMIT,
    });
    expect(zones.map((z) => z.key)).toEqual(["recents", "favorites", "all"]);
    expect(zones[0].entries.map((e) => e.id)).toEqual(["browser", "wallet"]);
    expect(zones[1].entries.map((e) => e.id)).toEqual(["settings"]);
    // All Apps is the whole page (a tile is not removed for being recent/pinned).
    expect(zones[2].entries).toBe(PAGE);
    expect(zones[2].entries.map((e) => e.id)).toContain("browser");
  });

  it("returns empty Recents/Favorites zones for a first-run launcher", () => {
    const zones = curateLauncherZones(PAGE, {
      recentIds: [],
      favoriteIds: [],
      recentsLimit: LAUNCHER_RECENTS_ZONE_LIMIT,
    });
    expect(zones[0].entries).toEqual([]);
    expect(zones[1].entries).toEqual([]);
    expect(zones[2].entries).toBe(PAGE);
  });

  it("skips recent/favorite ids that are no longer visible tiles (no resurrection)", () => {
    // A stale recent for a now-hidden/uninstalled surface must not add a tile
    // the curated page dropped.
    const zones = curateLauncherZones(PAGE, {
      recentIds: ["uninstalled-app", "wallet"],
      favoriteIds: ["also-gone"],
      recentsLimit: LAUNCHER_RECENTS_ZONE_LIMIT,
    });
    expect(zones[0].entries.map((e) => e.id)).toEqual(["wallet"]);
    expect(zones[1].entries).toEqual([]);
  });

  it("canonicalizes + de-dupes recent ids and caps the Recents zone", () => {
    const zones = curateLauncherZones(PAGE, {
      // `inventory` canonicalizes to `wallet`; the duplicate must collapse.
      recentIds: ["inventory", "wallet", "browser"],
      favoriteIds: [],
      recentsLimit: 2,
    });
    expect(zones[0].entries.map((e) => e.id)).toEqual(["wallet", "browser"]);
  });
});
