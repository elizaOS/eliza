/** Verifies useDesktopTabs through the package's configured test harness. */
// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewRegistryEntry } from "./useAvailableViews";
import { LAUNCHER_DOCK_LIMIT, useDesktopTabs } from "./useDesktopTabs";

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
        pinnedAt: expect.any(Number),
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
        pinnedAt: expect.any(Number),
      },
    ]);
  });

  it("caps pinned tabs at the iOS-style dock limit, evicting the oldest pinned", () => {
    const { result } = renderHook(() => useDesktopTabs());

    // Pin six views in order; the dock caps at LAUNCHER_DOCK_LIMIT (4), so the
    // two oldest pinned (a, b) get unpinned — never the one just pinned.
    act(() => {
      for (const id of ["a", "b", "c", "d", "e", "f"]) {
        result.current.openTab(view(id), { pinned: true });
      }
    });

    const pinned = result.current.tabs
      .filter((t) => t.pinned)
      .map((t) => t.viewId);
    expect(pinned).toHaveLength(LAUNCHER_DOCK_LIMIT);
    expect(pinned).toEqual(["c", "d", "e", "f"]);
    // Evicted tabs stay open (just unpinned), so they leave the dock, not the app.
    expect(result.current.tabs.map((t) => t.viewId)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
    // Only the four pinned tabs persist.
    expect(
      JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]").map(
        (t: { viewId: string }) => t.viewId,
      ),
    ).toEqual(["c", "d", "e", "f"]);
  });

  it("evicts by PIN age, not open order, when pin order differs from open order", () => {
    const { result } = renderHook(() => useDesktopTabs());

    // Open five tabs unpinned (open order a..e), then pin them in REVERSE
    // order: e, d, c, b — the dock is now full and "e" holds the oldest pin.
    act(() => {
      for (const id of ["a", "b", "c", "d", "e"]) {
        result.current.openTab(view(id));
      }
    });
    act(() => {
      for (const id of ["e", "d", "c", "b"]) {
        result.current.pinTab(id);
      }
    });
    expect(
      result.current.tabs.filter((t) => t.pinned).map((t) => t.viewId),
    ).toEqual(["b", "c", "d", "e"]);

    // Pinning "a" overflows the dock. The OLDEST pin ("e") must pop off —
    // the old array-order walk instead unpinned "b", the tab the user had
    // pinned most recently before "a".
    act(() => {
      result.current.pinTab("a");
    });

    const pinned = result.current.tabs
      .filter((t) => t.pinned)
      .map((t) => t.viewId);
    expect(pinned).toHaveLength(LAUNCHER_DOCK_LIMIT);
    expect(pinned).toEqual(["a", "b", "c", "d"]);
    // "e" stays open — it just leaves the dock.
    expect(result.current.tabs.map((t) => t.viewId)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("evicts by pin age through openTab({ pinned: true }) as well", () => {
    const { result } = renderHook(() => useDesktopTabs());

    act(() => {
      for (const id of ["a", "b", "c", "d", "e"]) {
        result.current.openTab(view(id));
      }
      for (const id of ["e", "d", "c", "b"]) {
        result.current.pinTab(id);
      }
    });

    // Re-opening "a" with pinned:true is the same overflow: oldest pin "e" pops.
    act(() => {
      result.current.openTab(view("a"), { pinned: true });
    });

    expect(
      result.current.tabs.filter((t) => t.pinned).map((t) => t.viewId),
    ).toEqual(["a", "b", "c", "d"]);
  });

  it("re-opening an already-pinned tab preserves its original pin age", () => {
    const { result } = renderHook(() => useDesktopTabs());

    act(() => {
      for (const id of ["a", "b", "c", "d"]) {
        result.current.openTab(view(id), { pinned: true });
      }
    });
    // Re-open "a" (oldest pin). Its pin age must NOT refresh…
    act(() => {
      result.current.openTab(view("a"), { pinned: true });
    });
    // …so pinning a fifth tab still evicts "a", not "b".
    act(() => {
      result.current.openTab(view("e"), { pinned: true });
    });

    expect(
      result.current.tabs.filter((t) => t.pinned).map((t) => t.viewId),
    ).toEqual(["b", "c", "d", "e"]);
  });

  it("caps pinned tabs when promoting an open tab via pinTab", () => {
    const { result } = renderHook(() => useDesktopTabs());
    act(() => {
      for (const id of ["a", "b", "c", "d"]) {
        result.current.openTab(view(id), { pinned: true });
      }
      result.current.openTab(view("e")); // open, unpinned
    });
    act(() => {
      result.current.pinTab("e");
    });
    const pinned = result.current.tabs
      .filter((t) => t.pinned)
      .map((t) => t.viewId);
    expect(pinned).toHaveLength(LAUNCHER_DOCK_LIMIT);
    expect(pinned).toEqual(["b", "c", "d", "e"]);
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

  it("starts with an empty dock when persisted state is corrupt or not an array", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    const corrupted = renderHook(() => useDesktopTabs());
    expect(corrupted.result.current.tabs).toEqual([]);
    cleanup();

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ viewId: "not-an-array" }),
    );
    const nonArray = renderHook(() => useDesktopTabs());
    expect(nonArray.result.current.tabs).toEqual([]);
  });

  it("drops malformed persisted entries and restores only well-formed tabs", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        null,
        "junk-string",
        { label: "Missing ViewId", path: "/apps/missing-view-id" },
        { viewId: "missing.label", path: "/apps/missing-label" },
        { viewId: "missing.path", label: "Missing Path" },
        {
          viewId: "remote.ledger",
          label: "Remote Ledger",
          path: "/apps/remote-ledger",
          pinned: true,
          pinnedAt: 100,
        },
      ]),
    );

    const { result } = renderHook(() => useDesktopTabs());

    expect(result.current.tabs).toEqual([
      {
        viewId: "remote.ledger",
        label: "Remote Ledger",
        path: "/apps/remote-ledger",
        pinned: true,
        pinnedAt: 100,
      },
    ]);
  });

  it("treats legacy persisted tabs without pinnedAt as holding the oldest pins, ties broken by open order", () => {
    // Pre-pinnedAt persisted data: two pinned tabs carrying no pin timestamp.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          viewId: "legacy.a",
          label: "Legacy A",
          path: "/apps/legacy-a",
          pinned: true,
        },
        {
          viewId: "legacy.b",
          label: "Legacy B",
          path: "/apps/legacy-b",
          pinned: true,
        },
      ]),
    );

    const { result } = renderHook(() => useDesktopTabs());
    expect(result.current.tabs.map((tab) => tab.viewId)).toEqual([
      "legacy.a",
      "legacy.b",
    ]);
    expect(
      result.current.tabs.every(
        (tab) => !("pinnedAt" in tab) || tab.pinnedAt === undefined,
      ),
    ).toBe(true);

    act(() => {
      for (const id of ["new.c", "new.d"]) {
        result.current.openTab(view(id), { pinned: true });
      }
    });
    expect(
      result.current.tabs.filter((tab) => tab.pinned).map((tab) => tab.viewId),
    ).toHaveLength(4);

    // Fifth pin overflows the dock. Both legacy entries lack pinnedAt so both
    // sort as oldest; the tie breaks by open order, so legacy.a pops first.
    act(() => {
      result.current.openTab(view("new.e"), { pinned: true });
    });

    expect(
      result.current.tabs.filter((tab) => tab.pinned).map((tab) => tab.viewId),
    ).toEqual(["legacy.b", "new.c", "new.d", "new.e"]);
  });

  it("derives /apps/<viewId> for registry entries without an explicit path", () => {
    const { result } = renderHook(() => useDesktopTabs());

    act(() => {
      result.current.openTab(view("notes"));
    });

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0]?.path).toBe("/apps/notes");
  });

  it("ignores closing an unknown tab and drops a closed pinned tab from persistence", () => {
    const { result } = renderHook(() => useDesktopTabs());

    act(() => {
      result.current.openTab(view("local.notes"), { pinned: true });
      result.current.openTab(view("remote.ledger"));
    });

    act(() => {
      result.current.closeTab("does.not.exist");
    });
    expect(result.current.tabs.map((tab) => tab.viewId)).toEqual([
      "local.notes",
      "remote.ledger",
    ]);

    act(() => {
      result.current.closeTab("local.notes");
    });
    expect(result.current.tabs.map((tab) => tab.viewId)).toEqual([
      "remote.ledger",
    ]);
    expect(
      JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]"),
    ).toEqual([]);
  });

  it("ignores pinning a view that is not open", () => {
    const { result } = renderHook(() => useDesktopTabs());

    act(() => {
      result.current.openTab(view("local.notes"));
      result.current.pinTab("does.not.exist");
    });

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0]?.pinned).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("[]");
  });

  it("re-pinning an already-pinned tab does not refresh its pin age", () => {
    const { result } = renderHook(() => useDesktopTabs());

    act(() => {
      for (const id of ["a", "b", "c", "d"]) {
        result.current.openTab(view(id));
      }
      for (const id of ["a", "b", "c", "d"]) {
        result.current.pinTab(id);
      }
      // Duplicate pin: if it restamped, "a" would become the newest pin…
      result.current.pinTab("a");
    });
    // …so filling the dock must still evict "a" as the oldest pin, not "b".
    act(() => {
      result.current.openTab(view("e"));
      result.current.pinTab("e");
    });

    expect(
      result.current.tabs.filter((tab) => tab.pinned).map((tab) => tab.viewId),
    ).toEqual(["b", "c", "d", "e"]);
  });
});
