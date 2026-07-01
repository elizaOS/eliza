// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeLauncherSurface } from "./HomeLauncherSurface";
import { dispatchHomeLauncherNavigation } from "./home-launcher-events";

function LauncherProbe({
  onNavigateHomeFromEdge,
}: {
  onNavigateHomeFromEdge?: () => void;
}) {
  return (
    <button type="button" onClick={onNavigateHomeFromEdge}>
      edge home
    </button>
  );
}

const originalMatchMedia = window.matchMedia;

function mockDesktopPagingMedia({
  finePointer,
  desktopWidth = true,
}: {
  finePointer: boolean;
  desktopWidth?: boolean;
}): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches:
      finePointer &&
      desktopWidth &&
      query.includes("(hover: hover)") &&
      query.includes("(pointer: fine)") &&
      query.includes("(min-width: 1024px)"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});

describe("HomeLauncherSurface", () => {
  it("keeps both pages mounted and flips to Launcher on a left flick", () => {
    render(
      <HomeLauncherSurface
        home={<div data-testid="home-pane">home</div>}
        launcher={<LauncherProbe />}
      />,
    );

    expect(screen.getByTestId("home-pane")).toBeTruthy();
    expect(screen.getByText("edge home")).toBeTruthy();

    const homePage = screen.getByTestId("home-launcher-home-page");
    fireEvent.pointerDown(homePage, {
      isPrimary: true,
      clientX: 260,
      clientY: 100,
    });
    fireEvent.pointerMove(homePage, {
      isPrimary: true,
      clientX: 150,
      clientY: 104,
    });
    fireEvent.pointerUp(homePage, {
      isPrimary: true,
      clientX: 150,
      clientY: 104,
    });

    expect(
      screen.getByTestId("home-launcher-surface").getAttribute("data-page"),
    ).toBe("launcher");
  });

  it("accepts navigation events and lets Launcher edge-swipe back home", () => {
    render(
      <HomeLauncherSurface
        home={<div>home</div>}
        launcher={<LauncherProbe />}
      />,
    );

    act(() => dispatchHomeLauncherNavigation("launcher"));
    expect(
      screen.getByTestId("home-launcher-surface").getAttribute("data-page"),
    ).toBe("launcher");

    fireEvent.click(screen.getByText("edge home"));

    expect(
      screen.getByTestId("home-launcher-surface").getAttribute("data-page"),
    ).toBe("home");
  });

  it("honors initialPage so the launcher route opens on the Launcher", () => {
    render(
      <HomeLauncherSurface
        home={<div>home</div>}
        launcher={<LauncherProbe />}
        initialPage="launcher"
      />,
    );
    expect(
      screen.getByTestId("home-launcher-surface").getAttribute("data-page"),
    ).toBe("launcher");
  });

  it("hides rail edge buttons when the pointer is coarse", () => {
    mockDesktopPagingMedia({ finePointer: false });
    render(
      <HomeLauncherSurface
        home={<div>home</div>}
        launcher={<LauncherProbe />}
      />,
    );

    expect(screen.queryByTestId("rail-pager-edge-prev")).toBeNull();
    expect(screen.queryByTestId("rail-pager-edge-next")).toBeNull();
  });

  it("hides rail edge buttons at phone width even when the browser reports a fine pointer", () => {
    mockDesktopPagingMedia({ finePointer: true, desktopWidth: false });
    render(
      <HomeLauncherSurface
        home={<div>home</div>}
        launcher={<LauncherProbe />}
      />,
    );

    expect(screen.queryByTestId("rail-pager-edge-prev")).toBeNull();
    expect(screen.queryByTestId("rail-pager-edge-next")).toBeNull();
  });

  it("shows desktop rail edge buttons and moves one rail page per click", () => {
    mockDesktopPagingMedia({ finePointer: true });
    render(
      <HomeLauncherSurface
        home={<div>home</div>}
        launcher={<LauncherProbe />}
      />,
    );

    const surface = screen.getByTestId("home-launcher-surface");
    expect(surface.getAttribute("data-page")).toBe("home");
    expect(screen.queryByTestId("rail-pager-edge-prev")).toBeNull();

    fireEvent.click(screen.getByTestId("rail-pager-edge-next"));
    expect(surface.getAttribute("data-page")).toBe("launcher");
    expect(screen.queryByTestId("rail-pager-edge-next")).toBeNull();

    fireEvent.click(screen.getByTestId("rail-pager-edge-prev"));
    expect(surface.getAttribute("data-page")).toBe("home");
  });

  // -- Gesture disambiguation (reliability) ---------------------------------
  // The home page hosts a vertically-scrollable widget list, so the swipe
  // detector must NOT mistake a scroll / short drag / rightward drag for a
  // home→launcher page flip. These guard that disambiguation.
  function flick(
    page: HTMLElement,
    {
      dx,
      dy,
      isPrimary = true,
    }: { dx: number; dy: number; isPrimary?: boolean },
  ): void {
    const startX = 260;
    const startY = 300;
    fireEvent.pointerDown(page, {
      isPrimary,
      clientX: startX,
      clientY: startY,
    });
    fireEvent.pointerMove(page, {
      isPrimary,
      clientX: startX + dx,
      clientY: startY + dy,
    });
    fireEvent.pointerUp(page, {
      isPrimary,
      clientX: startX + dx,
      clientY: startY + dy,
    });
  }

  function renderSurface() {
    render(
      <HomeLauncherSurface
        home={<div data-testid="home-pane">home</div>}
        launcher={<LauncherProbe />}
      />,
    );
    return screen.getByTestId("home-launcher-surface");
  }

  it("does NOT flip on a vertical scroll (dy dominates) — widget scroll is safe", () => {
    const surface = renderSurface();
    // dx past the distance threshold but the drag is mostly vertical.
    flick(screen.getByTestId("home-launcher-home-page"), {
      dx: -110,
      dy: 220,
    });
    expect(surface.getAttribute("data-page")).toBe("home");
  });

  it("does NOT flip on a short left drag below the distance threshold", () => {
    const surface = renderSurface();
    flick(screen.getByTestId("home-launcher-home-page"), { dx: -40, dy: 2 });
    expect(surface.getAttribute("data-page")).toBe("home");
  });

  it("does NOT flip on a rightward drag (only left opens the Launcher)", () => {
    const surface = renderSurface();
    flick(screen.getByTestId("home-launcher-home-page"), { dx: 140, dy: 2 });
    expect(surface.getAttribute("data-page")).toBe("home");
  });

  it("ignores a non-primary pointer (e.g. multi-touch / secondary button)", () => {
    const surface = renderSurface();
    flick(screen.getByTestId("home-launcher-home-page"), {
      dx: -140,
      dy: 2,
      isPrimary: false,
    });
    expect(surface.getAttribute("data-page")).toBe("home");
  });

  it("flips on a decisive, mostly-horizontal left flick", () => {
    const surface = renderSurface();
    flick(screen.getByTestId("home-launcher-home-page"), {
      dx: -140,
      dy: 10,
    });
    expect(surface.getAttribute("data-page")).toBe("launcher");
  });
});
