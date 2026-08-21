/** Verifies useBarSurfaceWindows through the package's configured test harness. */
// @vitest-environment jsdom
//
// Phase 3 of #9953: the chromeless bottom bar summons views / the launcher as
// on-demand desktop windows (it has no inline tab system).

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NavigateViewDetail } from "../../../app-navigate-view";
import { DESKTOP_CONTENT_WORKSPACE_HANDOFF_EVENT } from "../../../events";
import { useBarSurfaceWindows } from "../useBarSurfaceWindows";

afterEach(() => cleanup());

function dispatchNavigate(detail?: NavigateViewDetail) {
  const event = new CustomEvent("eliza:navigate:view", {
    detail,
    cancelable: true,
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
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
    (options?: {
      routePath?: string;
      maximize?: boolean;
      presentation?: "standard" | "content";
    }) => Promise<void>
  >(async () => undefined);
  const dismissWorkspace = vi.fn(async () => ({
    closed: true,
    reason: "closed" as const,
  }));
  renderHook(() =>
    useBarSurfaceWindows({
      openWindow,
      openWorkspace,
      dismissWorkspace,
      isDesktop: () => isDesktop,
    }),
  );
  return { dismissWorkspace, openWindow, openWorkspace };
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

  it("opens launcher/views ids inside the maximized Workspace", async () => {
    const { openWindow, openWorkspace } = setup();
    await dispatchNavigate({ viewId: "launcher" });
    await dispatchNavigate({ viewId: "views-manager" });
    expect(openWindow).not.toHaveBeenCalled();
    expect(openWorkspace).toHaveBeenCalledTimes(2);
    expect(openWorkspace).toHaveBeenLastCalledWith({
      routePath: "/views",
      maximize: true,
      presentation: "content",
    });
  });

  it("opens a normal view path inside the maximized Workspace", async () => {
    const { openWindow, openWorkspace } = setup();
    const contentHandoff = vi.fn();
    window.addEventListener(
      DESKTOP_CONTENT_WORKSPACE_HANDOFF_EVENT,
      contentHandoff,
      { once: true },
    );
    const event = await dispatchNavigate({
      viewId: "notes",
      viewPath: "/notes",
    });
    expect(openWindow).not.toHaveBeenCalled();
    expect(openWorkspace).toHaveBeenCalledWith({
      routePath: "/notes",
      maximize: true,
      presentation: "content",
    });
    expect(event.defaultPrevented).toBe(true);
    expect(contentHandoff).toHaveBeenCalledTimes(1);
  });

  it("dismisses the Workspace for close actions and ignores detail-less events", async () => {
    const { dismissWorkspace, openWindow, openWorkspace } = setup();
    const event = await dispatchNavigate({
      action: "close",
      viewId: "calendar",
    });
    await dispatchNavigate({ action: "close-all", viewId: "__all__" });
    await dispatchNavigate(undefined);
    expect(openWindow).not.toHaveBeenCalled();
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(dismissWorkspace).toHaveBeenCalledTimes(2);
    expect(event.defaultPrevented).toBe(true);
  });

  it("is inert off the desktop runtime", async () => {
    const { openWindow, openWorkspace } = setup(false);
    await dispatchNavigate({ viewId: "calendar", action: "open-window" });
    await dispatchNavigate({ viewId: "launcher" });
    expect(openWindow).not.toHaveBeenCalled();
    expect(openWorkspace).not.toHaveBeenCalled();
  });
});
