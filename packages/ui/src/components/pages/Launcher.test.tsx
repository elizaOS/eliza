// @vitest-environment jsdom
//
// Renders the real Launcher over deterministic mock ViewEntry catalogs to prove
// it is a single scrolling page of tiles (no dock, no page dots) in caller
// order, that tap emits exactly one launch telemetry event, that the tile set
// tracks catalog changes on re-render, and that image tiles fall back to a
// glyph (never probing API heroes) for dedicated cloud agents.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client, type RegistryAppInfo } from "../../api";
import { withBuiltinShellViews } from "../../hooks/useAvailableViews";
import {
  mergeViewCatalog,
  type ViewEntry,
  viewToEntry,
} from "../../hooks/view-catalog";
import { readViewInteractions } from "../../view-telemetry";
import { Launcher } from "./Launcher";
import { curateLauncherPages } from "./launcher-curation";

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

  it("scrolls vertically without visible scrollbar chrome and adapts narrow grids", () => {
    render(<Launcher entries={FEW} onLaunch={() => {}} />);
    const page = screen.getByTestId("launcher-page-window");
    expect(page.className).toContain("overflow-y-auto");
    expect(page.className).toContain("overscroll-y-contain");
    expect(page.className).toContain("scrollbar-hide");
    expect(page.className).toContain("[scrollbar-width:none]");
    expect(page.className).toContain("[&::-webkit-scrollbar]:hidden");
    expect(page.className).toContain("scroll-fade-b");
    expect(page.className).not.toContain("scroll-fade-t-");
    expect(page.className).toContain("[--scroll-fade-reveal:1px]");
    expect(page.className).toContain("scroll-fade-b-");
    expect(page.className).toContain("mb-[calc(");
    expect(page.className).toContain("--eliza-chat-clearance");
    const grid = page.querySelector(".grid");
    expect(grid?.className).toContain("grid-cols-3");
    expect(grid?.className).toContain("min-[360px]:grid-cols-4");
    expect(grid?.className).toContain("sm:grid-cols-5");
  });

  it("scales icons and labels from the launcher container while keeping short landscape compact", () => {
    render(<Launcher entries={FEW} onLaunch={() => {}} />);
    const css = [...document.querySelectorAll("style")]
      .map((style) => style.textContent ?? "")
      .find((value) => value.includes("[data-launcher-icon]"));

    expect(css).toContain("container-type: inline-size");
    expect(css).toContain("width: clamp(3.5rem, 16cqi, 4.5rem)");
    expect(css).toContain(
      "font-size: clamp(.75rem, calc(.68rem + .25cqi), .875rem)",
    );
    expect(css).toContain(
      "@media (orientation: landscape) and (max-height: 520px)",
    );
    expect(
      screen.getAllByText("Chat")[0].getAttribute("data-launcher-label"),
    ).toBe("");
  });

  it("compacts long unbroken labels without shrinking ordinary or wrapped labels", () => {
    render(
      <Launcher
        entries={[
          entry("automations", "Automations"),
          entry("settings", "Settings"),
          entry("memory", "Memory Viewer"),
        ]}
        onLaunch={() => {}}
      />,
    );

    expect(
      screen.getByText("Automations").getAttribute("data-compact-label"),
    ).toBe("true");
    expect(
      screen.getByText("Settings").getAttribute("data-compact-label"),
    ).toBeNull();
    expect(
      screen.getByText("Memory Viewer").getAttribute("data-compact-label"),
    ).toBeNull();
  });

  it("renders at natural height when embedded in Home's app scroller", () => {
    render(<Launcher entries={FEW} onLaunch={() => {}} embedded />);
    const page = screen.getByTestId("launcher-page-window");
    expect(page.className).toContain("overflow-visible");
    expect(page.className).not.toContain("overflow-y-auto");
    expect(page.className).not.toContain("scroll-fade");
    expect(page.className).not.toContain("mb-[calc(");
    expect(screen.getByTestId("launcher").className).not.toContain("flex-1");
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

  it("launches from the visible label and emits a single launch telemetry event", () => {
    const onLaunch = vi.fn();
    render(<Launcher entries={FEW} onLaunch={onLaunch} />);
    // The name and icon are one coherent button, so the visible label is part
    // of the same tap target instead of dead space beneath the icon.
    fireEvent.click(screen.getByText("Chat"));
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
    expect(screen.getByTestId("launcher").getAttribute("aria-busy")).toBe(
      "true",
    );
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

  it("renders the real Automations entry with its semantic clock glyph", () => {
    const registryEntry = withBuiltinShellViews([]).find(
      (candidate) => candidate.id === "automations",
    );
    expect(registryEntry).toBeDefined();
    if (!registryEntry) {
      throw new Error("builtin Automations view is missing");
    }

    const entries = curateLauncherPages([viewToEntry(registryEntry)], {
      isAosp: false,
      enabledKinds: { developer: false, preview: false },
      cloudActive: false,
    });
    render(<Launcher entries={entries} onLaunch={() => {}} />);

    const visual = document.querySelector('[data-view-visual="automations"]');
    expect(visual?.querySelector("svg.lucide-clock-3")).toBeTruthy();
    expect(visual?.querySelector("svg.lucide-layout-grid")).toBeNull();
  });

  it("keeps loaded Finances distinct from catalog Hyperliquid", () => {
    const enabledKinds = { developer: false, preview: false };
    const entries = curateLauncherPages(
      mergeViewCatalog({
        views: [
          {
            id: "finances",
            label: "Finances",
            icon: "CircleDollarSign",
            path: "/finances",
            available: true,
            pluginName: "@elizaos/plugin-finances",
            viewKind: "release",
          },
        ],
        catalog: [
          {
            name: "@elizaos/plugin-hyperliquid",
            displayName: "Hyperliquid",
            viewKind: "release",
          } as RegistryAppInfo,
        ],
        installed: [],
        activeModality: "gui",
        enabledKinds,
        visibilityScope: "routable",
      }),
      { isAosp: false, enabledKinds, cloudActive: false },
    );

    render(<Launcher entries={entries} onLaunch={() => {}} />);

    const finances = document.querySelector('[data-view-visual="finances"]');
    const hyperliquid = document.querySelector(
      '[data-view-visual="@elizaos/plugin-hyperliquid"]',
    );
    expect(
      finances?.querySelector("svg.lucide-circle-dollar-sign"),
    ).toBeTruthy();
    expect(hyperliquid?.querySelector("svg.lucide-trending-up")).toBeTruthy();
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
