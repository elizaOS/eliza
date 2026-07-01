import { describe, expect, it } from "vitest";
import type { ViewEntry } from "../../hooks/view-catalog";
import {
  canonicalLauncherId,
  curateLauncherPages,
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

describe("curateLauncherPages", () => {
  it("splits everyday apps (page 1) from developer tools (page 2)", () => {
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
      { isAosp: false, enabledKinds: ENABLED },
    );

    expect(ids(pages)).toEqual([
      ["wallet", "browser", "settings"],
      ["trajectories", "database", "runtime", "logs", "skills", "plugins"],
    ]);
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
      { isAosp: false, enabledKinds: ENABLED },
    );

    expect(ids(pages)).toEqual([["wallet"]]);
  });

  it("keeps hyperliquid/polymarket out of the launcher (wallet sub-views)", () => {
    const pages = curateLauncherPages(
      [entry("wallet"), entry("hyperliquid"), entry("polymarket")],
      { isAosp: false, enabledKinds: ENABLED },
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

    expect(ids(curateLauncherPages(views, { isAosp: false, enabledKinds: ENABLED }))).toEqual([
      ["wallet"],
    ]);
    expect(ids(curateLauncherPages(views, { isAosp: true, enabledKinds: ENABLED }))).toEqual([
      ["wallet", "phone", "messages", "contacts", "camera", "files"],
    ]);
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
      { isAosp: false, enabledKinds: ENABLED },
    );
    expect(ids(pages)).toEqual([["wallet", "automations"]]);
  });

  it("appends other loaded apps after the curated order on page 1", () => {
    const pages = curateLauncherPages(
      [entry("browser"), entry("zebra-app"), entry("wallet"), entry("alpha-app")],
      { isAosp: false, enabledKinds: ENABLED },
    );
    expect(ids(pages)).toEqual([["wallet", "browser", "alpha-app", "zebra-app"]]);
  });

  it("hides uncurated preview/developer views unless their kind is enabled", () => {
    const views = [entry("wallet"), entry("secret", { viewKind: "developer" })];
    expect(
      ids(
        curateLauncherPages(views, {
          isAosp: false,
          enabledKinds: { developer: false, preview: false },
        }),
      ),
    ).toEqual([["wallet"]]);
    // vector-browser-style dev views join the developer page when enabled.
    expect(
      ids(curateLauncherPages(views, { isAosp: false, enabledKinds: ENABLED })),
    ).toEqual([["wallet"], ["secret"]]);
  });
});

describe("curateLauncherPages — full realistic view set", () => {
  // Mirrors what /api/views + builtin shell views + loaded plugins return so the
  // asserted layout is the actual launcher a user sees, not a toy subset.
  const REAL_VIEWS: ViewEntry[] = [
    // Shell surfaces that must never tile.
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

  it("produces the exact off-fork two-page layout", () => {
    expect(
      ids(curateLauncherPages(REAL_VIEWS, { isAosp: false, enabledKinds: ENABLED })),
    ).toEqual([
      [
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
        "settings",
      ],
      ["trajectories", "database", "runtime", "logs", "skills", "plugins"],
    ]);
  });

  it("appends the native-OS tiles to page 1 on the AOSP fork", () => {
    const [appsPage] = ids(
      curateLauncherPages(REAL_VIEWS, { isAosp: true, enabledKinds: ENABLED }),
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
