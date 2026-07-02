// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "../../api";
import type { ViewEntry } from "../../hooks/view-catalog";
import { runAnimationFramesImmediately } from "../../testing/run-animation-frames-immediately";
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

/** A single curated page holding every entry, in entry order. */
function singlePage(entries: ViewEntry[]): string[][] {
  return [entries.map((e) => e.id)];
}

const FEW = [entry("chat", "Chat"), entry("settings", "Settings")];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Launcher", () => {
  it("renders every curated view as a page tile (no dock)", () => {
    render(
      <Launcher
        entries={FEW}
        pageGroups={singlePage(FEW)}
        onLaunch={() => {}}
      />,
    );
    // The featured-views dock was removed: every view lives on the pages.
    expect(screen.queryByTestId("launcher-dock")).toBeNull();
    const page = within(screen.getByTestId("launcher-page-0"));
    expect(page.getByTestId("launcher-tile-chat")).toBeTruthy();
    expect(page.getByTestId("launcher-tile-settings")).toBeTruthy();
    // Label text is present (names below icons), no descriptions.
    expect(screen.getByText("Chat")).toBeTruthy();
  });

  it("renders all curated ids on the page in group order", () => {
    const entries = [
      entry("chat", "Chat"),
      entry("settings", "Settings"),
      entry("wallet", "Wallet"),
    ];
    render(
      <Launcher
        entries={entries}
        pageGroups={[["chat", "settings", "wallet"]]}
        onLaunch={() => {}}
      />,
    );

    expect(screen.queryByTestId("launcher-dock")).toBeNull();
    const page = screen.getByTestId("launcher-page-0");
    const tileIds = Array.from(
      page.querySelectorAll<HTMLElement>('[data-testid^="launcher-tile-"]'),
    ).map((node) =>
      node.getAttribute("data-testid")?.replace("launcher-tile-", ""),
    );
    // Tiles render in the exact pageGroups order.
    expect(tileIds).toEqual(["chat", "settings", "wallet"]);
  });

  it("renders tiles in the curated group order the caller supplies", () => {
    render(
      <Launcher
        entries={[entry("alpha", "Alpha"), entry("beta", "Beta")]}
        pageGroups={[["beta", "alpha"]]}
        onLaunch={() => {}}
      />,
    );

    const tileIds = Array.from(
      screen
        .getByTestId("launcher-page-0")
        .querySelectorAll<HTMLElement>('[data-testid^="launcher-tile-"]'),
    ).map((node) =>
      node.getAttribute("data-testid")?.replace("launcher-tile-", ""),
    );
    expect(tileIds).toEqual(["beta", "alpha"]);
  });

  it("drops curated ids with no live entry", () => {
    render(
      <Launcher
        entries={[entry("chat", "Chat")]}
        // "notes" is curated but no live entry exists for it.
        pageGroups={[["chat", "notes"]]}
        onLaunch={() => {}}
      />,
    );
    expect(screen.getByTestId("launcher-tile-chat")).toBeTruthy();
    expect(screen.queryByTestId("launcher-tile-notes")).toBeNull();
  });

  it("marks preview and developer tiles without changing release tiles", () => {
    const entries = [
      entry("settings", "Settings"),
      { ...entry("alpha", "Alpha"), viewKind: "preview" } as ViewEntry,
      { ...entry("trace", "Trace"), viewKind: "developer" } as ViewEntry,
    ];
    render(
      <Launcher
        entries={entries}
        pageGroups={[["settings", "alpha", "trace"]]}
        onLaunch={() => {}}
      />,
    );

    expect(screen.queryByTestId("launcher-kind-settings")).toBeNull();
    expect(screen.getByTestId("launcher-kind-alpha").textContent).toBe(
      "Preview",
    );
    expect(screen.getByTestId("launcher-kind-trace").textContent).toBe("Dev");
  });

  it("launches a view on tap", () => {
    const onLaunch = vi.fn();
    render(
      <Launcher
        entries={FEW}
        pageGroups={singlePage(FEW)}
        onLaunch={onLaunch}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onLaunch.mock.calls[0][0].id).toBe("chat");
  });

  it("shows page dots when there is more than one page", () => {
    const entries = [entry("a", "A"), entry("b", "B"), entry("c", "C")];
    render(
      <Launcher
        entries={entries}
        pageGroups={[["a", "b"], ["c"]]}
        onLaunch={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Page 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Page 2" })).toBeTruthy();
  });

  it("renders no page dots for a single curated page", () => {
    render(
      <Launcher
        entries={FEW}
        pageGroups={singlePage(FEW)}
        onLaunch={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Page 1" })).toBeNull();
  });

  it("navigates pages via the page dots", () => {
    const entries = [entry("a", "A"), entry("b", "B"), entry("c", "C")];
    render(
      <Launcher
        entries={entries}
        pageGroups={[["a", "b"], ["c"]]}
        onLaunch={() => {}}
      />,
    );
    // Page 1 shows the first page's views, not page 2's tile.
    expect(
      within(screen.getByTestId("launcher-page-0")).queryByTestId(
        "launcher-tile-c",
      ),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Page 2" }));
    const secondPage = screen.getByTestId("launcher-page-1");
    expect(secondPage.getAttribute("aria-hidden")).toBe("false");
    expect(within(secondPage).getByTestId("launcher-tile-c")).toBeTruthy();
  });

  it("slides adjacent pages with the finger before committing a page swipe", () => {
    runAnimationFramesImmediately();
    // Two curated pages so a forward swipe on page 0 has somewhere to go.
    render(
      <Launcher
        entries={[entry("a", "A"), entry("b", "B")]}
        pageGroups={[["a"], ["b"]]}
        onLaunch={() => {}}
      />,
    );

    const pageWindow = screen.getByTestId("launcher-page-window");
    Object.defineProperty(pageWindow, "clientWidth", {
      configurable: true,
      value: 390,
    });
    const rail = screen.getByTestId("launcher-page-rail");
    fireEvent.pointerDown(pageWindow, {
      isPrimary: true,
      pointerId: 3,
      clientX: 320,
      clientY: 300,
    });
    fireEvent.pointerMove(pageWindow, {
      isPrimary: true,
      pointerId: 3,
      clientX: 220,
      clientY: 304,
    });

    expect(rail.style.transform).toContain("-100px");
    expect(rail.style.transition).toBe("none");

    fireEvent.pointerUp(pageWindow, {
      isPrimary: true,
      pointerId: 3,
      clientX: 170,
      clientY: 304,
    });

    expect(
      screen
        .getByRole("button", { name: "Page 2" })
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(rail.style.transform).toContain("translate3d(-390px,0,0)");
  });

  it("rubber-bands at the last page edge instead of dead-stopping", () => {
    runAnimationFramesImmediately();
    // Three curated pages; page index 2 is the last, so a forward swipe there
    // rubber-bands back rather than advancing.
    render(
      <Launcher
        entries={[entry("a", "A"), entry("b", "B"), entry("c", "C")]}
        pageGroups={[["a"], ["b"], ["c"]]}
        onLaunch={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Page 3" }));
    const pageWindow = screen.getByTestId("launcher-page-window");
    Object.defineProperty(pageWindow, "clientWidth", {
      configurable: true,
      value: 390,
    });
    const rail = screen.getByTestId("launcher-page-rail");

    fireEvent.pointerDown(pageWindow, {
      isPrimary: true,
      pointerId: 4,
      clientX: 120,
      clientY: 300,
    });
    fireEvent.pointerMove(pageWindow, {
      isPrimary: true,
      pointerId: 4,
      clientX: 20,
      clientY: 304,
    });

    expect(rail.style.transform).toContain("-815px");
    expect(rail.style.transition).toBe("none");

    fireEvent.pointerUp(pageWindow, {
      isPrimary: true,
      pointerId: 4,
      clientX: 20,
      clientY: 304,
    });

    expect(rail.style.transform).toContain("translate3d(-780px,0,0)");
  });

  it("drops views that are no longer available on re-render", () => {
    const { rerender } = render(
      <Launcher
        entries={FEW}
        pageGroups={singlePage(FEW)}
        onLaunch={() => {}}
      />,
    );
    expect(screen.getByTestId("launcher-tile-settings")).toBeTruthy();
    rerender(
      <Launcher
        entries={[entry("chat", "Chat")]}
        pageGroups={[["chat", "settings"]]}
        onLaunch={() => {}}
      />,
    );
    expect(screen.queryByTestId("launcher-tile-settings")).toBeNull();
  });

  it("renders a newly-available view as a tile on re-render", () => {
    const { rerender } = render(
      <Launcher
        entries={[entry("chat", "Chat")]}
        pageGroups={[["chat", "notes"]]}
        onLaunch={() => {}}
      />,
    );
    expect(screen.queryByTestId("launcher-tile-notes")).toBeNull();
    rerender(
      <Launcher
        entries={[entry("chat", "Chat"), entry("notes", "Notes")]}
        pageGroups={[["chat", "notes"]]}
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
      <Launcher
        entries={entries}
        pageGroups={singlePage(entries)}
        onLaunch={() => {}}
      />,
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
      <Launcher
        entries={entries}
        pageGroups={singlePage(entries)}
        onLaunch={() => {}}
      />,
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
      <Launcher
        entries={entries}
        pageGroups={singlePage(entries)}
        onLaunch={() => {}}
      />,
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
      <Launcher
        entries={entries}
        pageGroups={singlePage(entries)}
        onLaunch={() => {}}
      />,
    );

    expect(screen.queryByTestId("launcher-image-notes")).toBeNull();
    const visual = container.querySelector<HTMLElement>(
      '[data-view-visual="notes"]',
    );
    expect(visual?.querySelector("svg")).toBeTruthy();
  });
});
