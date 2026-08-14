/**
 * Regression test for bug #19325: onboarding completion can remount chat collapsed
 * during auth probe.
 *
 * Async race condition — auth probe remounts shell while onboarding completion
 * transitions chat to half detent, causing chat to reset to collapsed. The fix
 * persists shell surface state to localStorage to survive remounts.
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getShellSurface,
  goLauncher,
  resetShellSurfaceForTests,
  setShellSurfacePage,
} from "./shell-surface-store";

beforeEach(() => {
  resetShellSurfaceForTests();
});

afterEach(() => {
  resetShellSurfaceForTests();
});

describe("shell-surface-store persistence across remount (#19325)", () => {
  it("initializes to home when nothing is persisted", () => {
    expect(getShellSurface().page).toBe("home");
  });

  it("transitions to launcher and back to home", () => {
    goLauncher();
    expect(getShellSurface().page).toBe("launcher");
    setShellSurfacePage("home");
    expect(getShellSurface().page).toBe("home");
  });

  it("localStorage is available and works", () => {
    // Verify localStorage is working
    window.localStorage.setItem("test-persist", "test-value");
    expect(window.localStorage.getItem("test-persist")).toBe("test-value");
    window.localStorage.removeItem("test-persist");
  });

  it("race condition fix: shell surface state survives module-level store reset", () => {
    // Step 1: Onboarding completes, transitions shell surface to launcher
    setShellSurfacePage("launcher");
    expect(getShellSurface().page).toBe("launcher");

    // Verify localStorage has the value before remount
    const stored = window.localStorage.getItem("eliza:shell-surface-page");
    expect(stored).toBe("launcher");

    // Step 2: Auth probe completes and remounts shell
    // The global store is cleared (simulating a React remount). In the bug,
    // the state would reset to "home" because the store initialization didn't
    // check localStorage. With the fix, store() now loads persisted state.
    const g = globalThis as Record<PropertyKey, unknown>;
    const k = Symbol.for("elizaos.ui.shell-surface-store");

    // Clear the in-memory store but keep localStorage intact
    delete g[k];

    // Step 3: When getShellSurface() is called again (on next navigation access),
    // it calls store(), which now restores from localStorage instead of resetting
    expect(getShellSurface().page).toBe("launcher");
  });

  it("multiple store resets preserve state across remounts", () => {
    // Test multiple cycles of remount — simulating several auth probe cycles
    setShellSurfacePage("launcher");
    expect(getShellSurface().page).toBe("launcher");

    const g = globalThis as Record<PropertyKey, unknown>;
    const k = Symbol.for("elizaos.ui.shell-surface-store");

    // First remount
    delete g[k];
    expect(getShellSurface().page).toBe("launcher");

    // Navigate back to home
    setShellSurfacePage("home");
    expect(getShellSurface().page).toBe("home");

    // Second remount
    delete g[k];
    expect(getShellSurface().page).toBe("home");

    // Navigate to launcher again
    setShellSurfacePage("launcher");
    expect(getShellSurface().page).toBe("launcher");

    // Third remount
    delete g[k];
    expect(getShellSurface().page).toBe("launcher");
  });
});
