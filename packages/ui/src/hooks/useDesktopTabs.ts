/**
 * useDesktopTabs — persisted desktop tab state for the Electrobun shell.
 *
 * Tabs are stored in localStorage under "elizaos.desktop.pinned-tabs" so they
 * survive app restarts. Only the Electrobun desktop shell uses this hook; on
 * web and mobile it is inactive (empty list, inert methods).
 */

import { useCallback, useEffect, useState } from "react";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";
import { LAUNCHER_DOCK_LIMIT } from "../state/launcher-layout";
import type { ViewRegistryEntry } from "./useAvailableViews";

export interface DesktopTab {
  viewId: string;
  label: string;
  path: string;
  icon?: string;
  /** Pinned tabs persist to localStorage and survive restarts. */
  pinned: boolean;
}

const STORAGE_KEY = "elizaos.desktop.pinned-tabs";

function loadPersistedTabs(): DesktopTab[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is DesktopTab =>
        item !== null &&
        typeof item === "object" &&
        typeof (item as DesktopTab).viewId === "string" &&
        typeof (item as DesktopTab).label === "string" &&
        typeof (item as DesktopTab).path === "string",
    );
  } catch {
    return [];
  }
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

function tabFromView(view: ViewRegistryEntry, pinned: boolean): DesktopTab {
  return {
    viewId: view.id,
    label: view.label,
    path: view.path ?? `/apps/${view.id}`,
    icon: view.icon,
    pinned,
  };
}

/**
 * iOS-style dock cap: at most LAUNCHER_DOCK_LIMIT pinned tabs. Pinning past
 * the limit evicts (unpins) the oldest pinned tabs first, never the one the user
 * just pinned (`keepId`). Unpinned tabs stay open; they just leave the dock.
 */
function capPinnedTabs(tabs: DesktopTab[], keepId: string): DesktopTab[] {
  const pinnedCount = tabs.filter((t) => t.pinned).length;
  if (pinnedCount <= LAUNCHER_DOCK_LIMIT) return tabs;
  let toEvict = pinnedCount - LAUNCHER_DOCK_LIMIT;
  return tabs.map((tab) => {
    if (toEvict > 0 && tab.pinned && tab.viewId !== keepId) {
      toEvict -= 1;
      return { ...tab, pinned: false };
    }
    return tab;
  });
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
      setTabs((current) => {
        const exists = current.find((t) => t.viewId === view.id);
        const nextPinned = options?.pinned === true;
        const next = exists
          ? current.map((tab) =>
              tab.viewId === view.id
                ? { ...tabFromView(view, tab.pinned || nextPinned) }
                : tab,
            )
          : [...current, tabFromView(view, nextPinned)];
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
    setTabs((current) => {
      const exists = current.find((t) => t.viewId === viewId);
      if (!exists) return current;
      const next = current.map((t) =>
        t.viewId === viewId ? { ...t, pinned: true } : t,
      );
      return capPinnedTabs(next, viewId);
    });
  }, []);

  return { tabs, openTab, closeTab, pinTab };
}
