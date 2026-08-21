/** Verifies useBarSurfaceWindows through the package's configured test harness. */
// @vitest-environment jsdom
//
// Phase 3 of #9953: the chromeless bottom bar summons views / the launcher as
// on-demand desktop windows (it has no inline tab system).

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NavigateViewDetail } from "../../../app-navigate-view";
import { useBarSurfaceWindows } from "../useBarSurfaceWindows";

afterEach(() => cleanup());

function dispatchNavigate(detail?: NavigateViewDetail) {
  return act(() => {
    window.dispatchEvent(new CustomEvent("eliza:navigate:view", { detail }));
  });
}

type OpenWindowArg = {
  slug?: string;
  title: string;
  path: string;
  alwaysOnTop?: boolean;
};

function setup(isDesktop = true) {
  const openWindow = vi.fn<
    (opts: OpenWindowArg) => Promise<{ id: string } | null>
  >(async () => ({ id: "w1" }));
  const openWorkspace = vi.fn<
    (options?: { routePath?: string; fullScreen?: boolean }) => Promise<void>
  >(async () => undefined);
  renderHook(() =>
    useBarSurfaceWindows({
      openWindow,
      openWorkspace,
      isDesktop: () => isDesktop,
    }),
  );
  return { openWindow, openWorkspace };
}

describe("useBarSurfaceWindows", () => {
  it("opens a dedicated window for a view navigation", async () => {
    const { openWindow, openWorkspace } = setup();
    await dispatchNavigate({
      viewId: "calendar",
      viewLabel: "Calendar",
      action: "open-window",
    });
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(openWindow.mock.calls[0][0]).toMatchObject({
      slug: "calendar",
      title: "Calendar",
      path: "/apps/calendar",
    });
  });

  it("opens launcher/views ids inside the fullscreen Workspace", async () => {
    const { openWindow, openWorkspace } = setup();
    await dispatchNavigate({ viewId: "launcher" });
    await dispatchNavigate({ viewId: "views-manager" });
    expect(openWindow).not.toHaveBeenCalled();
    expect(openWorkspace).toHaveBeenCalledTimes(2);
    expect(openWorkspace).toHaveBeenLastCalledWith({
      routePath: "/views",
      fullScreen: true,
    });
  });

  it("opens a normal view path inside the fullscreen Workspace", async () => {
    const { openWindow, openWorkspace } = setup();
    await dispatchNavigate({
      viewId: "notes",
      viewPath: "/notes",
    });
    expect(openWindow).not.toHaveBeenCalled();
    expect(openWorkspace).toHaveBeenCalledWith({
      routePath: "/notes",
      fullScreen: true,
    });
  });

  it("ignores close actions and detail-less events", async () => {
    const { openWindow, openWorkspace } = setup();
    await dispatchNavigate({ action: "close", viewId: "calendar" });
    await dispatchNavigate(undefined);
    expect(openWindow).not.toHaveBeenCalled();
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("is inert off the desktop runtime", async () => {
    const { openWindow, openWorkspace } = setup(false);
    await dispatchNavigate({ viewId: "calendar", action: "open-window" });
    await dispatchNavigate({ viewId: "launcher" });
    expect(openWindow).not.toHaveBeenCalled();
    expect(openWorkspace).not.toHaveBeenCalled();
  });
});
