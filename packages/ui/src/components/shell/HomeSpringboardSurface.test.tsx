// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HomeSpringboardSurface } from "./HomeSpringboardSurface";
import { dispatchHomeSpringboardNavigation } from "./home-springboard-events";

function SpringboardProbe({
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

afterEach(() => cleanup());

describe("HomeSpringboardSurface", () => {
  it("keeps both pages mounted and flips to Springboard on a left flick", () => {
    render(
      <HomeSpringboardSurface
        home={<div data-testid="home-pane">home</div>}
        springboard={<SpringboardProbe />}
      />,
    );

    expect(screen.getByTestId("home-pane")).toBeTruthy();
    expect(screen.getByText("edge home")).toBeTruthy();

    const homePage = screen.getByTestId("home-springboard-home-page");
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
      screen.getByTestId("home-springboard-surface").getAttribute("data-page"),
    ).toBe("springboard");
  });

  it("accepts navigation events and lets Springboard edge-swipe back home", () => {
    render(
      <HomeSpringboardSurface
        home={<div>home</div>}
        springboard={<SpringboardProbe />}
      />,
    );

    act(() => dispatchHomeSpringboardNavigation("springboard"));
    expect(
      screen.getByTestId("home-springboard-surface").getAttribute("data-page"),
    ).toBe("springboard");

    fireEvent.click(screen.getByText("edge home"));

    expect(
      screen.getByTestId("home-springboard-surface").getAttribute("data-page"),
    ).toBe("home");
  });

  it("honors initialPage so the launcher route opens on the Springboard", () => {
    render(
      <HomeSpringboardSurface
        home={<div>home</div>}
        springboard={<SpringboardProbe />}
        initialPage="springboard"
      />,
    );
    expect(
      screen.getByTestId("home-springboard-surface").getAttribute("data-page"),
    ).toBe("springboard");
  });

  // -- Gesture disambiguation (reliability) ---------------------------------
  // The home page hosts a vertically-scrollable widget list, so the swipe
  // detector must NOT mistake a scroll / short drag / rightward drag for a
  // home→springboard page flip. These guard that disambiguation.
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
      <HomeSpringboardSurface
        home={<div data-testid="home-pane">home</div>}
        springboard={<SpringboardProbe />}
      />,
    );
    return screen.getByTestId("home-springboard-surface");
  }

  it("does NOT flip on a vertical scroll (dy dominates) — widget scroll is safe", () => {
    const surface = renderSurface();
    // dx past the distance threshold but the drag is mostly vertical.
    flick(screen.getByTestId("home-springboard-home-page"), {
      dx: -110,
      dy: 220,
    });
    expect(surface.getAttribute("data-page")).toBe("home");
  });

  it("does NOT flip on a short left drag below the distance threshold", () => {
    const surface = renderSurface();
    flick(screen.getByTestId("home-springboard-home-page"), { dx: -40, dy: 2 });
    expect(surface.getAttribute("data-page")).toBe("home");
  });

  it("does NOT flip on a rightward drag (only left opens the Springboard)", () => {
    const surface = renderSurface();
    flick(screen.getByTestId("home-springboard-home-page"), { dx: 140, dy: 2 });
    expect(surface.getAttribute("data-page")).toBe("home");
  });

  it("ignores a non-primary pointer (e.g. multi-touch / secondary button)", () => {
    const surface = renderSurface();
    flick(screen.getByTestId("home-springboard-home-page"), {
      dx: -140,
      dy: 2,
      isPrimary: false,
    });
    expect(surface.getAttribute("data-page")).toBe("home");
  });

  it("flips on a decisive, mostly-horizontal left flick", () => {
    const surface = renderSurface();
    flick(screen.getByTestId("home-springboard-home-page"), {
      dx: -140,
      dy: 10,
    });
    expect(surface.getAttribute("data-page")).toBe("springboard");
  });
});
