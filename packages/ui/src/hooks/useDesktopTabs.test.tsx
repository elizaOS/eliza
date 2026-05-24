// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewRegistryEntry } from "./useAvailableViews";
import { useDesktopTabs } from "./useDesktopTabs";

const runtimeMock = vi.hoisted(() => ({
  isElectrobunRuntime: vi.fn(),
}));

vi.mock("../bridge/electrobun-runtime", () => runtimeMock);

const STORAGE_KEY = "elizaos.desktop.pinned-tabs";

function view(
  id: string,
  overrides: Partial<ViewRegistryEntry> = {},
): ViewRegistryEntry {
  return {
    id,
    label: id,
    available: true,
    pluginName: "test-plugin",
    ...overrides,
  };
}

describe("useDesktopTabs", () => {
  beforeEach(() => {
    runtimeMock.isElectrobunRuntime.mockReturnValue(true);
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("opens local and remote view tabs, switches their metadata on update, and closes by id", () => {
    const localView = view("local.notes", {
      label: "Local Notes",
      path: "/apps/local-notes",
      icon: "N",
    });
    const remoteView = view("remote.ledger", {
      label: "Remote Ledger",
      path: "/apps/remote-ledger",
      bundleUrl: "/api/views/remote.ledger/bundle.js",
      icon: "R",
    });

    const { result } = renderHook(() => useDesktopTabs());

    act(() => {
      result.current.openTab(localView);
      result.current.openTab(remoteView);
    });

    expect(result.current.tabs).toEqual([
      {
        viewId: "local.notes",
        label: "Local Notes",
        path: "/apps/local-notes",
        icon: "N",
        pinned: false,
      },
      {
        viewId: "remote.ledger",
        label: "Remote Ledger",
        path: "/apps/remote-ledger",
        icon: "R",
        pinned: false,
      },
    ]);

    act(() => {
      result.current.openTab(
        view("remote.ledger", {
          label: "Remote Ledger v2",
          path: "/apps/remote-ledger-v2",
          bundleUrl: "/api/views/remote.ledger/v2.js",
          icon: "L",
        }),
      );
    });

    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.tabs[1]).toEqual({
      viewId: "remote.ledger",
      label: "Remote Ledger v2",
      path: "/apps/remote-ledger-v2",
      icon: "L",
      pinned: false,
    });

    act(() => {
      result.current.closeTab("local.notes");
    });

    expect(result.current.tabs.map((tab) => tab.viewId)).toEqual([
      "remote.ledger",
    ]);
  });

  it("persists only pinned tabs and promotes an already-open tab when pinning it later", () => {
    const { result, unmount } = renderHook(() => useDesktopTabs());

    act(() => {
      result.current.openTab(
        view("remote.ledger", {
          label: "Remote Ledger",
          path: "/apps/remote-ledger",
        }),
      );
    });

    expect(result.current.tabs[0]?.pinned).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("[]");

    act(() => {
      result.current.openTab(
        view("remote.ledger", {
          label: "Remote Ledger",
          path: "/apps/remote-ledger",
        }),
        { pinned: true },
      );
    });

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0]?.pinned).toBe(true);
    expect(
      JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]"),
    ).toEqual([
      {
        viewId: "remote.ledger",
        label: "Remote Ledger",
        path: "/apps/remote-ledger",
        pinned: true,
      },
    ]);

    unmount();
    const next = renderHook(() => useDesktopTabs());

    expect(next.result.current.tabs).toEqual([
      {
        viewId: "remote.ledger",
        label: "Remote Ledger",
        path: "/apps/remote-ledger",
        pinned: true,
      },
    ]);
  });

  it("is inert outside the Electrobun runtime", () => {
    runtimeMock.isElectrobunRuntime.mockReturnValue(false);
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          viewId: "remote.ledger",
          label: "Remote Ledger",
          path: "/apps/remote-ledger",
          pinned: true,
        },
      ]),
    );

    const { result } = renderHook(() => useDesktopTabs());

    act(() => {
      result.current.openTab(view("local.notes"));
      result.current.pinTab("remote.ledger");
      result.current.closeTab("remote.ledger");
    });

    expect(result.current.tabs).toEqual([]);
  });
});
