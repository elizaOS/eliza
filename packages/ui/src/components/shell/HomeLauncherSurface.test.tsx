// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { goHome, goLauncher } from "../../state/shell-surface-store";
import { HomeLauncherSurface } from "./HomeLauncherSurface";

function LauncherProbe() {
  return <div data-testid="launcher-probe">launcher</div>;
}

const originalMatchMedia = window.matchMedia;

function mockDesktopPagingMedia({
  finePointer,
}: {
  finePointer: boolean;
}): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches:
      finePointer &&
      query.includes("(hover: hover)") &&
      query.includes("(pointer: fine)"),
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
    expect(screen.getByTestId("launcher-probe")).toBeTruthy();

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

  it("accepts store navigation and a right flick on the launcher half rides the rail home", () => {
    render(
      <HomeLauncherSurface
        home={<div>home</div>}
        launcher={<LauncherProbe />}
      />,
    );

    act(() => goLauncher());
    expect(
      screen.getByTestId("home-launcher-surface").getAttribute("data-page"),
    ).toBe("launcher");

    // The rail owns the back gesture on the launcher half — a decisive right
    // flick commits home (no inner edge-swipe delegate anymore).
    const launcherPage = screen.getByTestId("home-launcher-launcher-page");
    fireEvent.pointerDown(launcherPage, {
      isPrimary: true,
      clientX: 120,
      clientY: 300,
    });
    fireEvent.pointerMove(launcherPage, {
      isPrimary: true,
      clientX: 260,
      clientY: 304,
    });
    fireEvent.pointerUp(launcherPage, {
      isPrimary: true,
      clientX: 260,
      clientY: 304,
    });

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

  it("shows rail edge buttons on any fine-pointer window — the gate has no min-width clause", () => {
    mockDesktopPagingMedia({ finePointer: true });
    render(
      <HomeLauncherSurface
        home={<div>home</div>}
        launcher={<LauncherProbe />}
      />,
    );

    // Fine pointer + hover is sufficient: a sub-1024px window still gets the
    // `>` control (there are no page dots in production, so without it a
    // narrow fine-pointer window would have no paging affordance at all).
    expect(screen.queryByTestId("rail-pager-edge-next")).not.toBeNull();
    expect(window.matchMedia).toHaveBeenCalledWith(
      expect.not.stringContaining("min-width"),
    );
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

  // -- Launcher-button visibility contract ----------------------------------
  // The right-side "Launcher" control must HIDE (unmount, not disable) while
  // the launcher surface is already active, and come back when the user
  // navigates away — including when the launcher was reached by deep link.
  it("HIDES the right-side Launcher button while on the launcher and restores it after navigating away", () => {
    mockDesktopPagingMedia({ finePointer: true });
    render(
      <HomeLauncherSurface
        home={<div>home</div>}
        launcher={<LauncherProbe />}
      />,
    );

    // Home: the Launcher button is present and is a real button (not disabled).
    const next = screen.getByTestId("rail-pager-edge-next");
    expect(next.getAttribute("aria-label")).toBe("Launcher");
    expect((next as HTMLButtonElement).disabled).toBe(false);

    // Navigate to the launcher via the store (the same intent the shell
    // controller drives): the button unmounts entirely.
    act(() => goLauncher());
    expect(screen.queryByTestId("rail-pager-edge-next")).toBeNull();
    // The way BACK (left "Home" chevron) is offered instead.
    expect(
      screen.getByTestId("rail-pager-edge-prev").getAttribute("aria-label"),
    ).toBe("Home");

    // Navigate away again: the Launcher button re-appears.
    act(() => goHome());
    expect(screen.queryByTestId("rail-pager-edge-next")).not.toBeNull();
  });

  it("HIDES the Launcher button when deep-linked straight into the launcher", () => {
    mockDesktopPagingMedia({ finePointer: true });
    // /views mounts the surface with initialPage="launcher" (App.tsx
    // HomeScreenMount) — the button must already be hidden on first paint.
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
    expect(screen.queryByTestId("rail-pager-edge-next")).toBeNull();
    expect(screen.queryByTestId("rail-pager-edge-prev")).not.toBeNull();
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
