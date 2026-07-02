import { describe, expect, it } from "vitest";
import type { ViewEntry } from "../../hooks/view-catalog";
import {
  canonicalLauncherId,
  curateLauncherPages,
  LAUNCHER_HIDDEN_IDS,
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

function ids(pages: ViewEntry[][]): string[][] {
  return pages.map((page) => page.map((e) => e.id));
}

const APPS_ONLY = { developer: false, preview: false } as const;

describe("curateLauncherPages", () => {
  it("puts apps then developer tools on ONE page when Developer Mode is on", () => {
    const pages = curateLauncherPages(
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
    expect(ids(pages)).toEqual([
      [
        "settings",
        "wallet",
        "browser",
        "trajectories",
        "database",
        "runtime",
        "logs",
        "skills",
        "plugins",
      ],
    ]);
  });

  it("hides ALL developer tools when Developer Mode is off (default)", () => {
    // runtime/skills/plugins carry no viewKind here, but DEVELOPER_INDEX
    // membership makes them developer-kind, so the whole set hides together.
    const pages = curateLauncherPages(
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
    expect(ids(pages)).toEqual([["settings", "wallet"]]);
  });

  it("drops removed apps and non-launcher shell surfaces", () => {
    const pages = curateLauncherPages(
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

    expect(ids(pages)).toEqual([["chat", "wallet"]]);
  });

  it("keeps hyperliquid/polymarket out of the launcher (wallet sub-views)", () => {
    const pages = curateLauncherPages(
      [entry("wallet"), entry("hyperliquid"), entry("polymarket")],
      { isAosp: false, enabledKinds: ENABLED, cloudActive: true },
    );
    expect(ids(pages)).toEqual([["wallet"]]);
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
    ).toEqual([["wallet"]]);
    expect(
      ids(
        curateLauncherPages(views, {
          isAosp: true,
          enabledKinds: ENABLED,
          cloudActive: true,
        }),
      ),
    ).toEqual([["wallet", "phone", "messages", "contacts", "camera", "files"]]);
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
    ).toEqual([["wallet"]]);
    // Signed in: it surfaces on the apps page.
    expect(
      ids(
        curateLauncherPages(views, {
          isAosp: false,
          enabledKinds: ENABLED,
          cloudActive: true,
        }),
      ),
    ).toEqual([["wallet", "cloud-apps"]]);
  });

  it("collapses duplicate wallet + automations registrations to one tile", () => {
    const pages = curateLauncherPages(
      [
        entry("inventory", { builtin: true }),
        entry("wallet.inventory", { kind: "view", state: "loaded" }),
        entry("wallet", { kind: "view", state: "loaded" }),
        entry("automations"),
        entry("triggers"),
        entry("tasks"),
        entry("todos"),
      ],
      { isAosp: false, enabledKinds: ENABLED, cloudActive: true },
    );
    expect(ids(pages)).toEqual([["wallet", "automations"]]);
  });

  it("drops the alias path when an alias wins the tile, so launch/telemetry agree", () => {
    // Only an aliased registration (todos → automations) is present, no canonical
    // `automations`. The tile must carry the canonical id AND no alias path, so
    // handleLaunch falls back to /apps/automations rather than /todos.
    const pages = curateLauncherPages([entry("todos", { path: "/todos" })], {
      isAosp: false,
      enabledKinds: ENABLED,
      cloudActive: true,
    });
    const tile = pages[0][0];
    expect(tile.id).toBe("automations");
    expect(tile.path).toBeUndefined();
  });

  it("keeps a non-aliased winner's real path intact", () => {
    const pages = curateLauncherPages(
      [entry("wallet", { path: "/wallet", kind: "view", state: "loaded" })],
      { isAosp: false, enabledKinds: ENABLED, cloudActive: true },
    );
    const tile = pages[0][0];
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
    ).toEqual([["wallet"]]);
    expect(
      ids(
        curateLauncherPages(views, {
          isAosp: false,
          enabledKinds: { developer: false, preview: true },
          cloudActive: true,
        }),
      ),
    ).toEqual([["wallet", "labs"]]);
  });

  it("appends other loaded apps after the curated order on the page", () => {
    const pages = curateLauncherPages(
      [
        entry("browser"),
        entry("zebra-app"),
        entry("wallet"),
        entry("alpha-app"),
      ],
      { isAosp: false, enabledKinds: ENABLED, cloudActive: true },
    );
    expect(ids(pages)).toEqual([
      ["wallet", "browser", "alpha-app", "zebra-app"],
    ]);
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
    ).toEqual([["wallet"]]);
    // vector-browser-style dev views join the single page (after apps) when on.
    expect(
      ids(
        curateLauncherPages(views, {
          isAosp: false,
          enabledKinds: ENABLED,
          cloudActive: true,
        }),
      ),
    ).toEqual([["wallet", "secret"]]);
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
    // Wallet + duplicate registrations + sub-views.
    entry("wallet", { viewKind: "system" }),
    entry("inventory", { builtin: true, viewKind: "system" }),
    entry("wallet.inventory"),
    entry("hyperliquid"),
    entry("polymarket"),
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
      [
        "chat",
        "settings",
        "wallet",
        "automations",
        "browser",
        "character",
        "documents",
        "transcripts",
        "relationships",
        "memories",
        "feed",
        "stream",
        "trajectories",
        "database",
        "runtime",
        "logs",
        "skills",
        "plugins",
      ],
    ]);
  });

  it("hides the developer tools in the default (production) profile — apps only", () => {
    expect(
      ids(
        curateLauncherPages(REAL_VIEWS, {
          isAosp: false,
          enabledKinds: { developer: false, preview: false },
          cloudActive: true,
        }),
      ),
    ).toEqual([
      [
        "chat",
        "settings",
        "wallet",
        "automations",
        "browser",
        "character",
        "documents",
        "transcripts",
        "relationships",
        "memories",
        "feed",
        "stream",
      ],
    ]);
  });

  it("appends the native-OS tiles to the single page on the AOSP fork", () => {
    const [appsPage] = ids(
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
  it("hides the legacy 'rolodex' alias (no directViews branch → would land on the fallback)", () => {
    // rolodex is a routable tab with a launcher tile but no renderStaticViewRouterTab
    // branch, so tapping it bounced the user back to the launcher fallback. The
    // real contact surface is `relationships`.
    expect(LAUNCHER_HIDDEN_IDS.has("rolodex")).toBe(true);
    const pages = curateLauncherPages(
      [entry("chat"), entry("rolodex"), entry("relationships")],
      { isAosp: false, enabledKinds: ENABLED, cloudActive: true },
    );
    expect(pages.flat().map((e) => e.id)).not.toContain("rolodex");
    expect(pages.flat().map((e) => e.id)).toContain("relationships");
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
