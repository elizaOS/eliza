import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatchHomeSpringboardNavigation } from "../components/shell/home-springboard-events";
import {
  enterSpringboardEdit,
  getShellSurface,
  goHome,
  goSpringboard,
  resetShellSurfaceForTests,
  setShellSurfacePage,
  setSpringboardEditing,
  setSpringboardPage,
  setSpringboardPageCount,
  toggleSpringboardEdit,
} from "./shell-surface-store";

beforeEach(() => resetShellSurfaceForTests());
afterEach(() => resetShellSurfaceForTests());

describe("shell-surface-store", () => {
  it("starts on home, page 0, not editing", () => {
    expect(getShellSurface()).toEqual({
      page: "home",
      springboardPage: 0,
      springboardPageCount: 1,
      springboardEditing: false,
    });
  });

  it("navigates home ↔ springboard", () => {
    goSpringboard();
    expect(getShellSurface().page).toBe("springboard");
    goHome();
    expect(getShellSurface().page).toBe("home");
  });

  // THE invariant that makes the 'swipe-back lands in edit mode / re-entering is
  // still jiggling' class of bug structurally impossible: leaving the
  // springboard ALWAYS resets the transient sub-state, no matter how it is left.
  it("resets edit mode AND page index whenever the surface leaves the springboard", () => {
    goSpringboard();
    setSpringboardPageCount(3);
    setSpringboardPage(2);
    enterSpringboardEdit();
    expect(getShellSurface()).toMatchObject({
      springboardPage: 2,
      springboardEditing: true,
    });

    goHome();
    expect(getShellSurface()).toMatchObject({
      page: "home",
      springboardPage: 0,
      springboardEditing: false,
    });

    // Re-entering the springboard starts clean — never in stale jiggle mode.
    goSpringboard();
    expect(getShellSurface().springboardEditing).toBe(false);
    expect(getShellSurface().springboardPage).toBe(0);
  });

  it("never lets edit mode be true while off the springboard", () => {
    setSpringboardEditing(true); // off the springboard (page === 'home')
    expect(getShellSurface().springboardEditing).toBe(false);
  });

  it("clamps the active page into [0, pageCount)", () => {
    goSpringboard();
    setSpringboardPageCount(2);
    setSpringboardPage(5);
    expect(getShellSurface().springboardPage).toBe(1);
    setSpringboardPage(-3);
    expect(getShellSurface().springboardPage).toBe(0);
  });

  it("re-clamps the active page when the page count shrinks", () => {
    goSpringboard();
    setSpringboardPageCount(4);
    setSpringboardPage(3);
    expect(getShellSurface().springboardPage).toBe(3);
    setSpringboardPageCount(2);
    expect(getShellSurface().springboardPage).toBe(1);
  });

  it("toggles edit mode only while on the springboard", () => {
    goSpringboard();
    toggleSpringboardEdit();
    expect(getShellSurface().springboardEditing).toBe(true);
    toggleSpringboardEdit();
    expect(getShellSurface().springboardEditing).toBe(false);
  });

  // The legacy window event is the bridge the chat controller still uses to
  // navigate — it must drive the same single source of truth.
  it("bridges the legacy home-springboard navigation event into the store", () => {
    const globals = globalThis as typeof globalThis & {
      window?: EventTarget;
    };
    const originalWindow = globals.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: new EventTarget(),
    });

    try {
      resetShellSurfaceForTests();
      dispatchHomeSpringboardNavigation("springboard");
      expect(getShellSurface().page).toBe("springboard");
      dispatchHomeSpringboardNavigation("home");
      expect(getShellSurface().page).toBe("home");
    } finally {
      if (originalWindow) {
        Object.defineProperty(globalThis, "window", {
          configurable: true,
          value: originalWindow,
        });
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });

  it("keeps page count at least 1", () => {
    setSpringboardPageCount(0);
    expect(getShellSurface().springboardPageCount).toBe(1);
  });

  it("setShellSurfacePage('home') is equivalent to goHome (resets sub-state)", () => {
    goSpringboard();
    setSpringboardPageCount(3);
    setSpringboardPage(2);
    enterSpringboardEdit();
    setShellSurfacePage("home");
    expect(getShellSurface()).toMatchObject({
      page: "home",
      springboardPage: 0,
      springboardEditing: false,
    });
  });
});
