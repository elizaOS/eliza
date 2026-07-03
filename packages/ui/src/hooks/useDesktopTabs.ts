/**
 * useDesktopTabs — persisted desktop tab state for the Electrobun shell.
 *
 * Tabs are stored in localStorage under "elizaos.desktop.pinned-tabs" so they
 * survive app restarts. Only the Electrobun desktop shell uses this hook; on
 * web and mobile it is inactive (empty list, inert methods).
 */

import { useCallback, useEffect, useState } from "react";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";
import type { ViewRegistryEntry } from "./useAvailableViews";

/**
 * iOS-dock-style pin cap: at most this many pinned tabs in the desktop dock.
 * Pinning past the cap evicts the oldest pinned tab (see `capPinnedTabs`).
 */
export const LAUNCHER_DOCK_LIMIT = 4;

export interface DesktopTab {
  viewId: string;
  label: string;
  path: string;
  icon?: string;
  /** Pinned tabs persist to localStorage and survive restarts. */
  pinned: boolean;
  /**
   * When the tab was pinned (epoch ms, strictly monotonic within a session).
   * Drives the dock's oldest-pinned-first eviction and persists so pin age
   * survives restarts. Absent on legacy persisted entries (treated as oldest,
   * ties broken by tab order — the pre-`pinnedAt` behavior).
   */
  pinnedAt?: number;
}

const STORAGE_KEY = "elizaos.desktop.pinned-tabs";

function loadPersistedTabs(): DesktopTab[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is DesktopTab =>
          item !== null &&
          typeof item === "object" &&
          typeof (item as DesktopTab).viewId === "string" &&
          typeof (item as DesktopTab).label === "string" &&
          typeof (item as DesktopTab).path === "string",
      )
      .map((item) =>
        typeof item.pinnedAt === "number" && Number.isFinite(item.pinnedAt)
          ? item
          : { ...item, pinnedAt: undefined },
      );
  } catch {
    return [];
  }
}

/**
 * Strictly-monotonic pin timestamp: wall-clock when it advances, +1 otherwise,
 * so two pins in the same millisecond still order deterministically.
 */
let lastPinStamp = 0;
function nextPinStamp(): number {
  const now = Date.now();
  lastPinStamp = now > lastPinStamp ? now : lastPinStamp + 1;
  return lastPinStamp;
}

function persistPinnedTabs(tabs: DesktopTab[]): void {
  if (typeof window === "undefined") return;
  const pinned = tabs.filter((t) => t.pinned);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pinned));
  } catch {
    // localStorage unavailable in sandboxed environments — non-fatal.
  }
}

function tabFromView(
  view: ViewRegistryEntry,
  pinned: boolean,
  pinnedAt?: number,
): DesktopTab {
  return {
    viewId: view.id,
    label: view.label,
    path: view.path ?? `/apps/${view.id}`,
    icon: view.icon,
    pinned,
    ...(pinned && pinnedAt !== undefined ? { pinnedAt } : {}),
  };
}

/**
 * iOS-style dock cap: at most LAUNCHER_DOCK_LIMIT pinned tabs. Pinning past
 * the limit evicts (unpins) the oldest pinned tabs first, never the one the user
 * just pinned (`keepId`). Unpinned tabs stay open; they just leave the dock.
 *
 * "Oldest pinned" is PIN age (`pinnedAt`), not tab order: the tab array is the
 * visual open order, and walking it (the old implementation) unpinned whichever
 * pinned tab happened to be OPENED first — when pin order differed from open
 * order that was often the most recently pinned tab, so the dock popped the tab
 * the user had just deliberately pinned moments earlier. Legacy entries without
 * `pinnedAt` sort oldest; ties break by tab order (the old behavior).
 */
function capPinnedTabs(tabs: DesktopTab[], keepId: string): DesktopTab[] {
  const pinned = tabs.filter((t) => t.pinned);
  const overflow = pinned.length - LAUNCHER_DOCK_LIMIT;
  if (overflow <= 0) return tabs;
  const evict = new Set(
    pinned
      .map((tab, index) => ({ tab, index }))
      .filter(({ tab }) => tab.viewId !== keepId)
      .sort(
        (a, b) =>
          (a.tab.pinnedAt ?? 0) - (b.tab.pinnedAt ?? 0) || a.index - b.index,
      )
      .slice(0, overflow)
      .map(({ tab }) => tab.viewId),
  );
  return tabs.map((tab) =>
    evict.has(tab.viewId) ? { ...tab, pinned: false } : tab,
  );
}

export interface UseDesktopTabsResult {
  tabs: DesktopTab[];
  openTab(view: ViewRegistryEntry, options?: { pinned?: boolean }): void;
  closeTab(viewId: string): void;
  pinTab(viewId: string): void;
}

export function useDesktopTabs(): UseDesktopTabsResult {
  const [tabs, setTabs] = useState<DesktopTab[]>(() => {
    if (!isElectrobunRuntime()) return [];
    return loadPersistedTabs();
  });

  // Persist pinned tabs whenever state changes.
  useEffect(() => {
    if (!isElectrobunRuntime()) return;
    persistPinnedTabs(tabs);
  }, [tabs]);

  const openTab = useCallback(
    (view: ViewRegistryEntry, options?: { pinned?: boolean }) => {
      if (!isElectrobunRuntime()) return;
      const nextPinned = options?.pinned === true;
      // Stamped outside the updater so a re-run (StrictMode) reuses one stamp.
      const stamp = nextPinned ? nextPinStamp() : undefined;
      setTabs((current) => {
        const exists = current.find((t) => t.viewId === view.id);
        const next = exists
          ? current.map((tab) =>
              tab.viewId === view.id
                ? // An already-pinned tab keeps its original pin age; only a
                  // fresh pin gets stamped.
                  tabFromView(
                    view,
                    tab.pinned || nextPinned,
                    tab.pinned ? tab.pinnedAt : stamp,
                  )
                : tab,
            )
          : [...current, tabFromView(view, nextPinned, stamp)];
        return nextPinned ? capPinnedTabs(next, view.id) : next;
      });
    },
    [],
  );

  const closeTab = useCallback((viewId: string) => {
    if (!isElectrobunRuntime()) return;
    setTabs((current) => current.filter((t) => t.viewId !== viewId));
  }, []);

  const pinTab = useCallback((viewId: string) => {
    if (!isElectrobunRuntime()) return;
    const stamp = nextPinStamp();
    setTabs((current) => {
      const exists = current.find((t) => t.viewId === viewId);
      if (!exists) return current;
      const next = current.map((t) =>
        t.viewId === viewId
          ? t.pinned
            ? t
            : { ...t, pinned: true, pinnedAt: stamp }
          : t,
      );
      return capPinnedTabs(next, viewId);
    });
  }, []);

  return { tabs, openTab, closeTab, pinTab };
}
