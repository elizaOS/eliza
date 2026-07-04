/**
 * Unit coverage for the nav-lock gate (locking navigation during critical flows).
 * Pure state, no runtime.
 */
import { afterEach, describe, expect, it } from "vitest";
import { isNavAllowed, isNavLocked, setNavLock } from "./nav-lock";

afterEach(() => setNavLock(null));

describe("nav-lock", () => {
  it("allows every tab when unlocked", () => {
    setNavLock(null);
    expect(isNavLocked()).toBe(false);
    expect(isNavAllowed("chat")).toBe(true);
    expect(isNavAllowed("settings")).toBe(true);
    expect(isNavAllowed("camera")).toBe(true);
  });

  it("permits only the allowed tabs while locked", () => {
    setNavLock(["chat", "settings"]);
    expect(isNavLocked()).toBe(true);
    expect(isNavAllowed("chat")).toBe(true);
    expect(isNavAllowed("settings")).toBe(true);
    expect(isNavAllowed("camera")).toBe(false);
    expect(isNavAllowed("apps")).toBe(false);
  });

  it("clears back to fully open", () => {
    setNavLock(["chat"]);
    expect(isNavAllowed("settings")).toBe(false);
    setNavLock(null);
    expect(isNavLocked()).toBe(false);
    expect(isNavAllowed("settings")).toBe(true);
  });

  it("an empty allow-list blocks everything (locked, nothing permitted)", () => {
    setNavLock([]);
    expect(isNavLocked()).toBe(true);
    expect(isNavAllowed("chat")).toBe(false);
  });
});
