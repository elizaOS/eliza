/**
 * useDesktopTabs — persisted desktop tab state for the Electrobun shell.
 *
 * Tabs are stored in localStorage under "elizaos.desktop.pinned-tabs" so they
 * survive app restarts. Only the Electrobun desktop shell uses this hook; on
 * web and mobile it is a no-op (empty list, inert methods).
 */

import { useCallback, useEffect, useState } from "react";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";
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

export interface UseDesktopTabsResult {
  tabs: DesktopTab[];
  openTab(view: ViewRegistryEntry): void;
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

  const openTab = useCallback((view: ViewRegistryEntry) => {
    if (!isElectrobunRuntime()) return;
    setTabs((current) => {
      const exists = current.find((t) => t.viewId === view.id);
      if (exists) {
        // Tab already open — nothing to add, but promote to pinned if not yet.
        return current;
      }
      return [...current, tabFromView(view, false)];
    });
  }, []);

  const closeTab = useCallback((viewId: string) => {
    if (!isElectrobunRuntime()) return;
    setTabs((current) => current.filter((t) => t.viewId !== viewId));
  }, []);

  const pinTab = useCallback((viewId: string) => {
    if (!isElectrobunRuntime()) return;
    setTabs((current) => {
      const exists = current.find((t) => t.viewId === viewId);
      if (!exists) return current;
      return current.map((t) =>
        t.viewId === viewId ? { ...t, pinned: true } : t,
      );
    });
  }, []);

  return { tabs, openTab, closeTab, pinTab };
}
