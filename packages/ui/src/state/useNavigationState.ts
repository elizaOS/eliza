/**
 * Navigation state — extracted from AppContext.
 *
 * Owns: setTab wrappers, switchShellView, switchUiShellMode, setUiShellMode,
 * tab commit effects, uiShellMode persist, lastNativeTab persist,
 * tabFromPath logic, and the NavigationEventHub.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { pathForTab, shouldUseHashNavigation, type Tab } from "../navigation";
import {
  loadLastNativeTab,
  normalizeUiShellMode,
  type ShellView,
  saveLastNativeTab,
  saveUiShellMode,
  type TabCommittedDetail,
  type UiShellMode,
} from "./internal";
import { NavigationEventHub } from "./navigation-events";
import { getTabForShellView } from "./shell-routing";

// ── Hook deps ─────────────────────────────────────────────────────────────

export interface NavigationStateDeps {
  tab: Tab;
  setTabRaw: (t: Tab) => void;
  uiShellMode: UiShellMode;
  hasActiveGameRun: boolean;
  setAppsSubTab: (value: "browse" | "running" | "games") => void;
}

// ── Hook ──────────────────────────────────────────────────────────────────

export function useNavigationState(deps: NavigationStateDeps) {
  const { tab, setTabRaw, uiShellMode, hasActiveGameRun, setAppsSubTab } = deps;

  const [lastNativeTab, setLastNativeTabState] =
    useState<Tab>(loadLastNativeTab);

  // ── Persist side effects ────────────────────────────────────────────

  useEffect(() => {
    saveUiShellMode(uiShellMode);
  }, [uiShellMode]);

  useEffect(() => {
    saveLastNativeTab(lastNativeTab);
  }, [lastNativeTab]);

  // ── setTab (with URL sync) ──────────────────────────────────────────

  const setTab = useCallback(
    (newTab: Tab) => {
      setTabRaw(newTab);
      if (newTab === "apps") {
        setAppsSubTab(hasActiveGameRun ? "games" : "browse");
      }
      const path = pathForTab(newTab);
      try {
        if (shouldUseHashNavigation()) {
          window.location.hash = path;
        } else {
          window.history.pushState(null, "", path);
        }
      } catch (err) {
        console.warn("[eliza][nav] failed to update browser location", err);
      }
    },
    [hasActiveGameRun, setTabRaw, setAppsSubTab],
  );

  // ── Shell mode toggles ──────────────────────────────────────────────

  const setUiShellMode = useCallback(
    (mode: UiShellMode) => {
      const nextMode = normalizeUiShellMode(mode);
      if (nextMode === "companion") {
        setTab("companion");
        return;
      }
      setTab(lastNativeTab);
    },
    [lastNativeTab, setTab],
  );

  useEffect(() => {
    // Remember all tabs except companion (which is now an app overlay, not a nav tab).
    if (tab === "companion") {
      return;
    }
    setLastNativeTabState((prev) => (prev === tab ? prev : tab));
  }, [tab]);

  const switchUiShellMode = useCallback(
    (mode: UiShellMode) => {
      const nextMode = normalizeUiShellMode(mode);
      if (nextMode === uiShellMode) {
        return;
      }
      if (nextMode === "native") {
        setTab(lastNativeTab);
        return;
      }
      setTab("companion");
    },
    [lastNativeTab, setTab, uiShellMode],
  );

  const switchShellView = useCallback(
    (view: ShellView) => {
      const nextTab = getTabForShellView(view, lastNativeTab);
      console.log(
        `[shell] switchShellView: ${view} → tab=${nextTab}, lastNativeTab=${lastNativeTab}`,
      );
      setTab(nextTab);
    },
    [lastNativeTab, setTab],
  );

  // ── Tab commit events ───────────────────────────────────────────────

  const navigationHubRef = useRef(new NavigationEventHub());
  const pendingPostTabCommitRef = useRef<(() => void)[]>([]);
  const prevTabCommittedRef = useRef<Tab | null>(null);
  const prevUiShellCommittedRef = useRef<UiShellMode | null>(null);
  const [_tabCommitFlushNonce, setTabCommitFlushNonce] = useState(0);

  const scheduleAfterTabCommit = useCallback((fn: () => void) => {
    pendingPostTabCommitRef.current.push(fn);
    if (pendingPostTabCommitRef.current.length === 1) {
      queueMicrotask(() => {
        setTabCommitFlushNonce((n) => n + 1);
      });
    }
  }, []);

  const navigation = useMemo(
    () => ({
      subscribeTabCommitted: (
        listener: (detail: TabCommittedDetail) => void,
      ): (() => void) => navigationHubRef.current.subscribe(listener),
      scheduleAfterTabCommit,
    }),
    [scheduleAfterTabCommit],
  );

  useLayoutEffect(() => {
    const tabChanged = prevTabCommittedRef.current !== tab;
    const shellChanged = prevUiShellCommittedRef.current !== uiShellMode;
    const pending = pendingPostTabCommitRef.current;
    pendingPostTabCommitRef.current = [];

    if (tabChanged || shellChanged) {
      const previousTab = prevTabCommittedRef.current;
      prevTabCommittedRef.current = tab;
      prevUiShellCommittedRef.current = uiShellMode;
      navigationHubRef.current.emit({ tab, previousTab, uiShellMode });
    }

    for (const task of pending) {
      try {
        task();
      } catch (err) {
        console.warn(
          "[eliza][navigation] scheduleAfterTabCommit task failed",
          err,
        );
      }
    }
  }, [tab, uiShellMode]);

  return {
    lastNativeTab,
    setLastNativeTabState,
    setTab,
    setUiShellMode,
    switchUiShellMode,
    switchShellView,
    navigation,
  };
}
