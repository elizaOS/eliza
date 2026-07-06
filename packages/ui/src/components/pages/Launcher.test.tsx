// @vitest-environment jsdom
//
// Renders the real Launcher over deterministic mock ViewEntry catalogs to prove
// it is a single scrolling page of tiles (no dock, no page dots) in caller
// order, that tap emits exactly one launch telemetry event, that the tile set
// tracks catalog changes on re-render, and that image tiles fall back to a
// glyph (never probing API heroes) for dedicated cloud agents.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../../api";
import type { ViewEntry } from "../../hooks/view-catalog";
import { readViewInteractions } from "../../view-telemetry";
import { Launcher } from "./Launcher";
import { allAppsZone, type LauncherZone } from "./launcher-curation";

function entry(id: string, label: string): ViewEntry {
  return {
    key: `view:${id}`,
    id,
    label,
    icon: "LayoutGrid",
    hasHero: false,
    modality: "gui",
    state: "loaded",
    kind: "view",
    viewKind: "release",
  } as ViewEntry;
}

function imageEntry(id: string, label: string, imageUrl: string): ViewEntry {
  return { ...entry(id, label), imageUrl };
}

function zones(entries: ViewEntry[]): LauncherZone[] {
  return allAppsZone(entries);
}

function tileIds(): (string | undefined)[] {
  return Array.from(
    screen
      .getByTestId("launcher-page-window")
      .querySelectorAll<HTMLElement>('[data-testid^="launcher-tile-"]'),
  ).map((node) =>
    node.getAttribute("data-testid")?.replace("launcher-tile-", ""),
  );
}

const FEW = [entry("chat", "Chat"), entry("settings", "Settings")];

function clearTelemetry() {
  (
    globalThis as { __ELIZA_VIEW_INTERACTION_TELEMETRY__?: unknown[] }
  ).__ELIZA_VIEW_INTERACTION_TELEMETRY__ = [];
}

beforeEach(() => clearTelemetry());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Launcher", () => {
  it("renders every entry as a page tile (no dock)", () => {
    render(<Launcher zones={zones(FEW)} onLaunch={() => {}} />);
    // The featured-views dock was removed: every view lives on the single page.
    expect(screen.queryByTestId("launcher-dock")).toBeNull();
    expect(screen.getByTestId("launcher-tile-chat")).toBeTruthy();
    expect(screen.getByTestId("launcher-tile-settings")).toBeTruthy();
    // Label text is present (names below icons), no descriptions.
    expect(screen.getByText("Chat")).toBeTruthy();
  });

  it("renders tiles in the exact order the caller supplies", () => {
    render(
      <Launcher
        zones={zones([entry("beta", "Beta"), entry("alpha", "Alpha")])}
        onLaunch={() => {}}
      />,
    );
    expect(tileIds()).toEqual(["beta", "alpha"]);
  });

  it("renders no page dots — the launcher is a single scrolling page", () => {
    render(<Launcher zones={zones(FEW)} onLaunch={() => {}} />);
    expect(screen.queryByRole("button", { name: "Page 1" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Page 2" })).toBeNull();
    expect(document.querySelectorAll('[aria-label^="Page "]').length).toBe(0);
  });

  it("marks preview and developer tiles without changing release tiles", () => {
    const entries = [
      entry("settings", "Settings"),
      { ...entry("alpha", "Alpha"), viewKind: "preview" } as ViewEntry,
      { ...entry("trace", "Trace"), viewKind: "developer" } as ViewEntry,
    ];
    render(<Launcher zones={zones(entries)} onLaunch={() => {}} />);

    expect(screen.queryByTestId("launcher-kind-settings")).toBeNull();
    expect(screen.getByTestId("launcher-kind-alpha").textContent).toBe(
      "Preview",
    );
    expect(screen.getByTestId("launcher-kind-trace").textContent).toBe("Dev");
  });

  it("launches a view on tap and emits a single launch telemetry event", () => {
    const onLaunch = vi.fn();
    render(<Launcher zones={zones(FEW)} onLaunch={onLaunch} />);
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onLaunch.mock.calls[0][0].id).toBe("chat");

    const launches = readViewInteractions().filter(
      (e) => e.action === "launch",
    );
    expect(launches).toHaveLength(1);
    expect(launches[0].viewId).toBe("chat");
  });

  it("renders the loading skeleton while the catalog is empty", () => {
    render(<Launcher zones={zones([])} loading onLaunch={() => {}} />);
    // No real tiles while loading with an empty catalog.
    expect(
      screen
        .getByTestId("launcher-page-window")
        .querySelectorAll('[data-testid^="launcher-tile-"]').length,
    ).toBe(0);
  });

  it("drops a tile when its entry is removed on re-render", () => {
    const { rerender } = render(
      <Launcher zones={zones(FEW)} onLaunch={() => {}} />,
    );
    expect(screen.getByTestId("launcher-tile-settings")).toBeTruthy();
    rerender(
      <Launcher zones={zones([entry("chat", "Chat")])} onLaunch={() => {}} />,
    );
    expect(screen.queryByTestId("launcher-tile-settings")).toBeNull();
  });

  it("renders a newly-available entry as a tile on re-render", () => {
    const { rerender } = render(
      <Launcher zones={zones([entry("chat", "Chat")])} onLaunch={() => {}} />,
    );
    expect(screen.queryByTestId("launcher-tile-notes")).toBeNull();
    rerender(
      <Launcher
        zones={zones([entry("chat", "Chat"), entry("notes", "Notes")])}
        onLaunch={() => {}}
      />,
    );
    expect(screen.getByTestId("launcher-tile-notes")).toBeTruthy();
  });
});

describe("Launcher image tiles", () => {
  it("renders a compact image icon over a glyph fallback when imageUrl is set", () => {
    const entries = [imageEntry("notes", "Notes", "/api/views/notes/hero")];
    const { container } = render(
      <Launcher zones={zones(entries)} onLaunch={() => {}} />,
    );
    const image = screen.getByTestId("launcher-image-notes");
    expect(image.getAttribute("src")).toBe("/api/views/notes/hero");
    const visual = container.querySelector<HTMLElement>(
      '[data-view-visual="notes"]',
    );
    expect(visual).toBeTruthy();
    expect(visual?.querySelector("img")).toBeTruthy();
    expect(visual?.querySelector("svg")).toBeTruthy();
    // The launch button is still labelled for a11y + tap.
    expect(screen.getByRole("button", { name: "Notes" })).toBeTruthy();
  });

  it("renders the icon glyph when imageUrl is absent", () => {
    const entries = [entry("notes", "Notes")];
    const { container } = render(
      <Launcher zones={zones(entries)} onLaunch={() => {}} />,
    );
    expect(screen.queryByTestId("launcher-image-notes")).toBeNull();
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("falls back to a glyph instead of probing API heroes on dedicated cloud agents", () => {
    vi.spyOn(client, "getBaseUrl").mockReturnValue(
      "https://23766030-c096-4a14-932a-a4e43c562432.elizacloud.ai",
    );

    const entries = [imageEntry("notes", "Notes", "/api/views/notes/hero")];
    const { container } = render(
      <Launcher zones={zones(entries)} onLaunch={() => {}} />,
    );

    expect(screen.queryByTestId("launcher-image-notes")).toBeNull();
    const visual = container.querySelector<HTMLElement>(
      '[data-view-visual="notes"]',
    );
    expect(visual?.querySelector("svg")).toBeTruthy();
  });

  it("falls back to a glyph for already-resolved dedicated cloud API heroes", () => {
    const entries = [
      imageEntry(
        "notes",
        "Notes",
        "https://23766030-c096-4a14-932a-a4e43c562432.elizacloud.ai/api/views/notes/hero",
      ),
    ];
    const { container } = render(
      <Launcher zones={zones(entries)} onLaunch={() => {}} />,
    );

    expect(screen.queryByTestId("launcher-image-notes")).toBeNull();
    const visual = container.querySelector<HTMLElement>(
      '[data-view-visual="notes"]',
    );
    expect(visual?.querySelector("svg")).toBeTruthy();
  });
});

describe("Launcher zones", () => {
  const chat = entry("chat", "Chat");
  const wallet = entry("wallet", "Wallet");
  const settings = entry("settings", "Settings");

  it("renders no zone headers and no empty top strip when only All Apps is present", () => {
    render(<Launcher zones={zones([chat, wallet])} onLaunch={() => {}} />);
    // The single default zone renders as a plain grid — no dock, no section
    // heading, no other zone container above the tiles.
    expect(screen.queryByTestId("launcher-dock")).toBeNull();
    expect(screen.queryByTestId("launcher-zone-recents")).toBeNull();
    expect(screen.queryByTestId("launcher-zone-favorites")).toBeNull();
    expect(screen.getByTestId("launcher-zone-all")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "All Apps" })).toBeNull();
  });

  it("renders Recents/Favorites headers and All Apps once the projection zones are populated", () => {
    render(
      <Launcher
        zones={[
          { key: "recents", label: "Recents", entries: [wallet] },
          { key: "favorites", label: "Favorites", entries: [settings] },
          { key: "all", label: "All Apps", entries: [chat, wallet, settings] },
        ]}
        onLaunch={() => {}}
      />,
    );
    expect(screen.getByRole("heading", { name: "Recents" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Favorites" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "All Apps" })).toBeTruthy();
  });

  it("keeps one canonical launcher-tile-<id> per id even when a tile is also in Recents/Favorites", () => {
    render(
      <Launcher
        zones={[
          { key: "recents", label: "Recents", entries: [wallet] },
          { key: "favorites", label: "Favorites", entries: [wallet] },
          { key: "all", label: "All Apps", entries: [chat, wallet] },
        ]}
        onLaunch={() => {}}
      />,
    );
    // The exhaustive zone owns the canonical testid; projections use zone-scoped
    // prefixes, so the "one tile per id" contract the collapse test relies on
    // still holds even for a thrice-shown tile.
    expect(screen.getAllByTestId("launcher-tile-wallet")).toHaveLength(1);
    expect(screen.getByTestId("launcher-recents-tile-wallet")).toBeTruthy();
    expect(screen.getByTestId("launcher-favorites-tile-wallet")).toBeTruthy();
  });

  it("toggles a favorite only from the All Apps zone", () => {
    const onLaunch = vi.fn();
    const onToggleFavorite = vi.fn();
    render(
      <Launcher
        zones={[
          { key: "favorites", label: "Favorites", entries: [wallet] },
          { key: "all", label: "All Apps", entries: [chat, wallet] },
        ]}
        favoriteIds={new Set(["wallet"])}
        onToggleFavorite={onToggleFavorite}
        onLaunch={onLaunch}
      />,
    );
    // The pin lives in the exhaustive grid (one per id), not on the read-only
    // Favorites projection. It is a touch-first 44px target and clicking it does
    // not also launch the app tile.
    expect(screen.getAllByTestId("launcher-favorite-wallet")).toHaveLength(1);
    const pin = screen.getByTestId("launcher-favorite-wallet");
    expect(pin.getAttribute("aria-pressed")).toBe("true");
    expect(pin.className).toContain("h-11");
    expect(pin.className).toContain("w-11");
    fireEvent.click(pin);
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    expect(onToggleFavorite.mock.calls[0][0].id).toBe("wallet");
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("keeps unpinned favorite targets visible on coarse pointers", () => {
    render(
      <Launcher
        zones={zones([wallet])}
        favoriteIds={new Set()}
        onToggleFavorite={() => {}}
        onLaunch={() => {}}
      />,
    );

    const pin = screen.getByTestId("launcher-favorite-wallet");
    expect(pin.className).toContain("h-11");
    expect(pin.className).toContain("w-11");
    expect(pin.className).toContain("opacity-0");
    expect(pin.className).toContain("pointer-coarse:opacity-100");
  });

  it("omits the favorite pin affordance when no toggle handler is supplied", () => {
    render(<Launcher zones={zones([wallet])} onLaunch={() => {}} />);
    expect(screen.queryByTestId("launcher-favorite-wallet")).toBeNull();
  });
});
