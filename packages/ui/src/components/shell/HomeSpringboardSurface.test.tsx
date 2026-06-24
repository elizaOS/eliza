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
});
