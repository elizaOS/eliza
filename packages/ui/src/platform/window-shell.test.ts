/**
 * Unit coverage for detached-window shell route parsing and target resolution.
 * Pure functions, no real window.
 */
import { describe, expect, it } from "vitest";
import {
  parseWindowShellRoute,
  resolveDetachedShellPathname,
  resolveDetachedShellTarget,
} from "./window-shell";

describe("parseWindowShellRoute", () => {
  it("parses the connectors surface window (?shell=surface&tab=connectors)", () => {
    // The desktop "New Connectors Window" opens with this query
    // (packages/app-core .../surface-windows.ts buildSurfaceShellQuery). It must
    // resolve to a scoped surface route, NOT fall through to `{ mode: "main" }`
    // (which renders a full second dashboard).
    expect(parseWindowShellRoute("?shell=surface&tab=connectors")).toEqual({
      mode: "surface",
      tab: "connectors",
    });
  });

  it("still parses the other scoped surface windows", () => {
    for (const tab of [
      "browser",
      "chat",
      "release",
      "triggers",
      "plugins",
      "cloud",
    ] as const) {
      expect(parseWindowShellRoute(`?shell=surface&tab=${tab}`)).toEqual({
        mode: "surface",
        tab,
      });
    }
  });

  it("falls back to main for an unknown surface tab", () => {
    expect(parseWindowShellRoute("?shell=surface&tab=bogus")).toEqual({
      mode: "main",
    });
  });
});

describe("resolveDetachedShellTarget", () => {
  it("scopes the connectors window to the Connectors settings section", () => {
    const target = resolveDetachedShellTarget({
      mode: "surface",
      tab: "connectors",
    });
    expect(target).toEqual({ tab: "settings", settingsSection: "connectors" });
  });

  it("resolves the connectors window pathname to /settings", () => {
    expect(
      resolveDetachedShellPathname({ mode: "surface", tab: "connectors" }),
    ).toBe("/settings");
  });
});
