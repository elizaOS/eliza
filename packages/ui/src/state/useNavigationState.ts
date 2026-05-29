/**
 * Navigation state — extracted from AppContext.
 *
 * Owns: setTab wrappers, switchShellView, switchUiShellMode, setUiShellMode,
 * deferred post-tab-commit work, uiShellMode persist, lastNativeTab persist,
 * and tabFromPath logic.
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
  type UiShellMode,
} from "./internal";
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
      } catch {
        // non-fatal: browser history update fails in restricted environments
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
      setTab(nextTab);
    },
    [lastNativeTab, setTab],
  );

  // ── Deferred post-tab-commit work ───────────────────────────────────

  const pendingPostTabCommitRef = useRef<(() => void)[]>([]);
  const [tabCommitFlushNonce, setTabCommitFlushNonce] = useState(0);

  const scheduleAfterTabCommit = useCallback((fn: () => void) => {
    pendingPostTabCommitRef.current.push(fn);
    if (pendingPostTabCommitRef.current.length === 1) {
      queueMicrotask(() => {
        setTabCommitFlushNonce((n) => n + 1);
      });
    }
  }, []);

  const navigation = useMemo(
    () => ({ scheduleAfterTabCommit }),
    [scheduleAfterTabCommit],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: tab/uiShellMode/tabCommitFlushNonce are intentional triggers — the flush must run after each tab/shell layout commit and after scheduleAfterTabCommit bumps the nonce.
  useLayoutEffect(() => {
    const pending = pendingPostTabCommitRef.current;
    pendingPostTabCommitRef.current = [];
    for (const task of pending) {
      try {
        task();
      } catch {
        // task errors must not block remaining scheduled work
      }
    }
  }, [tab, uiShellMode, tabCommitFlushNonce]);

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
