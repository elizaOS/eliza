import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatchHomeLauncherNavigation } from "../components/shell/home-launcher-events";
import {
  enterLauncherEdit,
  getShellSurface,
  goHome,
  goLauncher,
  resetShellSurfaceForTests,
  setLauncherEditing,
  setLauncherPage,
  setLauncherPageCount,
  setShellSurfacePage,
  toggleLauncherEdit,
} from "./shell-surface-store";

beforeEach(() => resetShellSurfaceForTests());
afterEach(() => resetShellSurfaceForTests());

describe("shell-surface-store", () => {
  it("starts on home, page 0, not editing", () => {
    expect(getShellSurface()).toEqual({
      page: "home",
      launcherPage: 0,
      launcherPageCount: 1,
      launcherEditing: false,
    });
  });

  it("navigates home ↔ launcher", () => {
    goLauncher();
    expect(getShellSurface().page).toBe("launcher");
    goHome();
    expect(getShellSurface().page).toBe("home");
  });

  // THE invariant that makes the 'swipe-back lands in edit mode / re-entering is
  // still jiggling' class of bug structurally impossible: leaving the
  // launcher ALWAYS resets the transient sub-state, no matter how it is left.
  it("resets edit mode AND page index whenever the surface leaves the launcher", () => {
    goLauncher();
    setLauncherPageCount(3);
    setLauncherPage(2);
    enterLauncherEdit();
    expect(getShellSurface()).toMatchObject({
      launcherPage: 2,
      launcherEditing: true,
    });

    goHome();
    expect(getShellSurface()).toMatchObject({
      page: "home",
      launcherPage: 0,
      launcherEditing: false,
    });

    // Re-entering the launcher starts clean — never in stale jiggle mode.
    goLauncher();
    expect(getShellSurface().launcherEditing).toBe(false);
    expect(getShellSurface().launcherPage).toBe(0);
  });

  it("never lets edit mode be true while off the launcher", () => {
    setLauncherEditing(true); // off the launcher (page === 'home')
    expect(getShellSurface().launcherEditing).toBe(false);
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

  it("toggles edit mode only while on the launcher", () => {
    goLauncher();
    toggleLauncherEdit();
    expect(getShellSurface().launcherEditing).toBe(true);
    toggleLauncherEdit();
    expect(getShellSurface().launcherEditing).toBe(false);
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
    enterLauncherEdit();
    setShellSurfacePage("home");
    expect(getShellSurface()).toMatchObject({
      page: "home",
      launcherPage: 0,
      launcherEditing: false,
    });
  });
});
