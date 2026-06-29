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
  const openLauncher = vi.fn<() => Promise<{ id: string } | null>>(
    async () => ({
      id: "launcher",
    }),
  );
  renderHook(() =>
    useBarSurfaceWindows({
      openWindow,
      openLauncher,
      isDesktop: () => isDesktop,
    }),
  );
  return { openWindow, openLauncher };
}

describe("useBarSurfaceWindows", () => {
  it("opens a dedicated window for a view navigation", async () => {
    const { openWindow, openLauncher } = setup();
    await dispatchNavigate({
      viewId: "calendar",
      viewLabel: "Calendar",
      action: "open-window",
    });
    expect(openLauncher).not.toHaveBeenCalled();
    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(openWindow.mock.calls[0][0]).toMatchObject({
      slug: "calendar",
      title: "Calendar",
      path: "/apps/calendar",
    });
  });

  it("summons the launcher for launcher/views ids", async () => {
    const { openWindow, openLauncher } = setup();
    await dispatchNavigate({ viewId: "launcher" });
    await dispatchNavigate({ viewId: "views-manager" });
    expect(openWindow).not.toHaveBeenCalled();
    expect(openLauncher).toHaveBeenCalledTimes(2);
  });

  it("honours an explicit view path and alwaysOnTop", async () => {
    const { openWindow } = setup();
    await dispatchNavigate({
      viewId: "phone",
      viewPath: "/phone",
      alwaysOnTop: true,
    });
    expect(openWindow.mock.calls[0][0]).toMatchObject({
      path: "/phone",
      alwaysOnTop: true,
    });
  });

  it("ignores close actions and detail-less events", async () => {
    const { openWindow, openLauncher } = setup();
    await dispatchNavigate({ action: "close", viewId: "calendar" });
    await dispatchNavigate(undefined);
    expect(openWindow).not.toHaveBeenCalled();
    expect(openLauncher).not.toHaveBeenCalled();
  });

  it("is inert off the desktop runtime", async () => {
    const { openWindow, openLauncher } = setup(false);
    await dispatchNavigate({ viewId: "calendar", action: "open-window" });
    await dispatchNavigate({ viewId: "launcher" });
    expect(openWindow).not.toHaveBeenCalled();
    expect(openLauncher).not.toHaveBeenCalled();
  });
});
