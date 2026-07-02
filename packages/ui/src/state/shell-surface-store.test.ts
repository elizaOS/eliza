import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatchHomeLauncherNavigation } from "../components/shell/home-launcher-events";
import {
  getShellSurface,
  goHome,
  goLauncher,
  resetShellSurfaceForTests,
  setLauncherPage,
  setLauncherPageCount,
  setShellSurfacePage,
} from "./shell-surface-store";

beforeEach(() => resetShellSurfaceForTests());
afterEach(() => resetShellSurfaceForTests());

describe("shell-surface-store", () => {
  it("starts on home, page 0", () => {
    expect(getShellSurface()).toEqual({
      page: "home",
      launcherPage: 0,
      launcherPageCount: 1,
    });
  });

  it("navigates home ↔ launcher", () => {
    goLauncher();
    expect(getShellSurface().page).toBe("launcher");
    goHome();
    expect(getShellSurface().page).toBe("home");
  });

  // THE invariant that makes the 'swipe-back re-enters a stale inner page' class
  // of bug structurally impossible: leaving the launcher ALWAYS resets the
  // transient sub-state, no matter how it is left.
  it("resets the page index whenever the surface leaves the launcher", () => {
    goLauncher();
    setLauncherPageCount(3);
    setLauncherPage(2);
    expect(getShellSurface()).toMatchObject({
      launcherPage: 2,
    });

    goHome();
    expect(getShellSurface()).toMatchObject({
      page: "home",
      launcherPage: 0,
    });

    // Re-entering the launcher starts clean — never on a stale inner page.
    goLauncher();
    expect(getShellSurface().launcherPage).toBe(0);
  });

  it("clamps the active page into [0, pageCount)", () => {
    goLauncher();
    setLauncherPageCount(2);
    setLauncherPage(5);
    expect(getShellSurface().launcherPage).toBe(1);
    setLauncherPage(-3);
    expect(getShellSurface().launcherPage).toBe(0);
  });

  it("re-clamps the active page when the page count shrinks", () => {
    goLauncher();
    setLauncherPageCount(4);
    setLauncherPage(3);
    expect(getShellSurface().launcherPage).toBe(3);
    setLauncherPageCount(2);
    expect(getShellSurface().launcherPage).toBe(1);
  });

  // The legacy window event is the bridge the chat controller still uses to
  // navigate — it must drive the same single source of truth.
  it("bridges the legacy home-launcher navigation event into the store", () => {
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
      dispatchHomeLauncherNavigation("launcher");
      expect(getShellSurface().page).toBe("launcher");
      dispatchHomeLauncherNavigation("home");
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
    setLauncherPageCount(0);
    expect(getShellSurface().launcherPageCount).toBe(1);
  });

  it("setShellSurfacePage('home') is equivalent to goHome (resets sub-state)", () => {
    goLauncher();
    setLauncherPageCount(3);
    setLauncherPage(2);
    setShellSurfacePage("home");
    expect(getShellSurface()).toMatchObject({
      page: "home",
      launcherPage: 0,
    });
  });
});
