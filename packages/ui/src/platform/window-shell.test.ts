/**
 * Unit coverage for detached-window shell route parsing and target resolution.
 * Pure functions, no real window.
 */
import { describe, expect, it } from "vitest";
import {
  isPrimaryAppRenderer,
  parseWindowShellRoute,
  type PrimaryRendererLocationLike,
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

describe("isPrimaryAppRenderer", () => {
  function at(
    overrides: Partial<PrimaryRendererLocationLike>,
  ): PrimaryRendererLocationLike {
    return {
      search: "",
      pathname: "/",
      hash: "",
      protocol: "https:",
      ...overrides,
    };
  }

  it("accepts the plain main window", () => {
    expect(isPrimaryAppRenderer(at({}))).toBe(true);
    expect(isPrimaryAppRenderer(at({ pathname: "/chat" }))).toBe(true);
    // Unrelated params must not disqualify the main window.
    expect(isPrimaryAppRenderer(at({ search: "?tab=chat" }))).toBe(true);
  });

  it("rejects every standalone window-shell mode", () => {
    for (const search of [
      "?shell=settings",
      "?shell=settings&tab=connectors",
      "?shell=surface&tab=browser",
      "?shellMode=chat-overlay",
      "?shell-mode=chat-overlay",
      "?shellMode=tray-popover",
    ]) {
      expect(isPrimaryAppRenderer(at({ search }))).toBe(false);
    }
  });

  it("rejects popout, phone-companion, and app-window renderers", () => {
    expect(isPrimaryAppRenderer(at({ search: "?popout" }))).toBe(false);
    expect(isPrimaryAppRenderer(at({ search: "?popout=1" }))).toBe(false);
    expect(isPrimaryAppRenderer(at({ search: "?mode=companion" }))).toBe(
      false,
    );
    expect(
      isPrimaryAppRenderer(
        at({ search: "?appWindow=1", pathname: "/apps/plugins" }),
      ),
    ).toBe(false);
  });

  it("rejects the model-tester shell on both path styles", () => {
    expect(isPrimaryAppRenderer(at({ pathname: "/model-tester" }))).toBe(
      false,
    );
    // Packaged desktop shells navigate by hash under file: protocol.
    expect(
      isPrimaryAppRenderer(
        at({ protocol: "file:", pathname: "/index.html", hash: "#/model-tester" }),
      ),
    ).toBe(false);
    expect(
      isPrimaryAppRenderer(
        at({ protocol: "file:", pathname: "/index.html", hash: "" }),
      ),
    ).toBe(true);
  });

  it("returns false with no window/location", () => {
    expect(isPrimaryAppRenderer(undefined)).toBe(false);
  });
});
