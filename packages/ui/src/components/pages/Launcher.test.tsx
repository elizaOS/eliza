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
    render(<Launcher entries={FEW} onLaunch={() => {}} />);
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
        entries={[entry("beta", "Beta"), entry("alpha", "Alpha")]}
        onLaunch={() => {}}
      />,
    );
    expect(tileIds()).toEqual(["beta", "alpha"]);
  });

  it("renders no page dots — the launcher is a single scrolling page", () => {
    render(<Launcher entries={FEW} onLaunch={() => {}} />);
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
    render(<Launcher entries={entries} onLaunch={() => {}} />);

    expect(screen.queryByTestId("launcher-kind-settings")).toBeNull();
    expect(screen.getByTestId("launcher-kind-alpha").textContent).toBe(
      "Preview",
    );
    expect(screen.getByTestId("launcher-kind-trace").textContent).toBe("Dev");
  });

  it("launches a view on tap and emits a single launch telemetry event", () => {
    const onLaunch = vi.fn();
    render(<Launcher entries={FEW} onLaunch={onLaunch} />);
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
    render(<Launcher entries={[]} loading onLaunch={() => {}} />);
    // No real tiles while loading with an empty catalog.
    expect(
      screen
        .getByTestId("launcher-page-window")
        .querySelectorAll('[data-testid^="launcher-tile-"]').length,
    ).toBe(0);
  });

  it("drops a tile when its entry is removed on re-render", () => {
    const { rerender } = render(<Launcher entries={FEW} onLaunch={() => {}} />);
    expect(screen.getByTestId("launcher-tile-settings")).toBeTruthy();
    rerender(
      <Launcher entries={[entry("chat", "Chat")]} onLaunch={() => {}} />,
    );
    expect(screen.queryByTestId("launcher-tile-settings")).toBeNull();
  });

  it("renders a newly-available entry as a tile on re-render", () => {
    const { rerender } = render(
      <Launcher entries={[entry("chat", "Chat")]} onLaunch={() => {}} />,
    );
    expect(screen.queryByTestId("launcher-tile-notes")).toBeNull();
    rerender(
      <Launcher
        entries={[entry("chat", "Chat"), entry("notes", "Notes")]}
        onLaunch={() => {}}
      />,
    );
    expect(screen.getByTestId("launcher-tile-notes")).toBeTruthy();
  });
});

describe("Launcher tile imagery (glyph-only)", () => {
  // The launcher deslop (#13453): a launcher tile is a clean app icon, the
  // branded gradient plate + the crisp Lucide glyph, and NEVER composites a
  // generated hero <img> on top (that painted a cartoon virus over Settings,
  // etc: the "icons are slop" report). Hero images stay on the catalog card
  // surface, not here.
  it("renders the glyph only and never a hero <img>, even when imageUrl is set", () => {
    const entries = [imageEntry("notes", "Notes", "/api/views/notes/hero")];
    const { container } = render(
      <Launcher entries={entries} onLaunch={() => {}} />,
    );
    // No hero image is composited on the launcher surface.
    expect(screen.queryByTestId("launcher-image-notes")).toBeNull();
    const visual = container.querySelector<HTMLElement>(
      '[data-view-visual="notes"]',
    );
    expect(visual).toBeTruthy();
    expect(visual?.querySelector("img")).toBeNull();
    // The crisp Lucide glyph is what the tile shows.
    expect(visual?.querySelector("svg")).toBeTruthy();
    // The launch button is still labelled for a11y + tap.
    expect(screen.getByRole("button", { name: "Notes" })).toBeTruthy();
  });

  it("renders the icon glyph when imageUrl is absent", () => {
    const entries = [entry("notes", "Notes")];
    const { container } = render(
      <Launcher entries={entries} onLaunch={() => {}} />,
    );
    expect(screen.queryByTestId("launcher-image-notes")).toBeNull();
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("renders the glyph regardless of the API base (no hero probe on any agent)", () => {
    vi.spyOn(client, "getBaseUrl").mockReturnValue(
      "https://23766030-c096-4a14-932a-a4e43c562432.elizacloud.ai",
    );

    const entries = [imageEntry("notes", "Notes", "/api/views/notes/hero")];
    const { container } = render(
      <Launcher entries={entries} onLaunch={() => {}} />,
    );

    expect(screen.queryByTestId("launcher-image-notes")).toBeNull();
    const visual = container.querySelector<HTMLElement>(
      '[data-view-visual="notes"]',
    );
    expect(visual?.querySelector("img")).toBeNull();
    expect(visual?.querySelector("svg")).toBeTruthy();
  });
});
