/**
 * Unit coverage for the home↔launcher shell-surface store transitions. In-memory
 * store, no harness.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getShellSurface,
  goHome,
  goLauncher,
  resetShellSurfaceForTests,
  setShellSurfacePage,
} from "./shell-surface-store";

beforeEach(() => resetShellSurfaceForTests());
afterEach(() => resetShellSurfaceForTests());

describe("shell-surface-store", () => {
  it("starts on home", () => {
    expect(getShellSurface()).toEqual({ page: "home" });
  });

  it("navigates home ↔ launcher", () => {
    goLauncher();
    expect(getShellSurface().page).toBe("launcher");
    goHome();
    expect(getShellSurface().page).toBe("home");
  });

  it("setShellSurfacePage is equivalent to the imperative actions", () => {
    setShellSurfacePage("launcher");
    expect(getShellSurface().page).toBe("launcher");
    setShellSurfacePage("home");
    expect(getShellSurface().page).toBe("home");
  });

  it("keeps the same state object on a no-op transition (no re-render churn)", () => {
    goLauncher();
    const before = getShellSurface();
    goLauncher();
    expect(getShellSurface()).toBe(before);
  });
});
