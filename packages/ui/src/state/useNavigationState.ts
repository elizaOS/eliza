/**
 * Navigation state, one of the domain hooks AppContext composes.
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
import { isNavAllowed } from "../navigation/nav-lock";
import {
  loadLastNativeTab,
  type ShellView,
  saveLastNativeTab,
  saveUiShellMode,
  type UiShellMode,
} from "./internal";
import { getTabForShellView } from "./shell-routing";

function pathWithCurrentShellMode(path: string): string {
  if (typeof window === "undefined") return path;
  const html = window.document?.documentElement;
  const body = window.document?.body;
  const isDetachedShell =
    html?.classList.contains("eliza-chat-overlay-shell") === true ||
    body?.classList.contains("eliza-chat-overlay-shell") === true;
  if (!isDetachedShell) return path;
  const params = new URLSearchParams(window.location.search);
  const shellMode = params.get("shellMode") ?? params.get("shell-mode");
  if (!shellMode) return path;
  const nextParams = new URLSearchParams();
  nextParams.set("shellMode", shellMode);
  return `${path}?${nextParams.toString()}`;
}

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
      // A guided flow (the tour) can restrict navigation to the tabs the current
      // step expects, so nothing drifts the app into a state it doesn't expect.
      if (!isNavAllowed(newTab)) return;
      setTabRaw(newTab);
      if (newTab === "apps") {
        setAppsSubTab(hasActiveGameRun ? "games" : "browse");
      }
      const path = pathForTab(newTab);
      try {
        if (shouldUseHashNavigation()) {
          window.location.hash = path;
        } else {
          window.history.pushState(null, "", pathWithCurrentShellMode(path));
        }
      } catch {
        // non-fatal: browser history update fails in restricted environments
      }
    },
    [hasActiveGameRun, setTabRaw, setAppsSubTab],
  );

  // ── Shell mode toggles ──────────────────────────────────────────────

  const setUiShellMode = useCallback(
    (_mode: UiShellMode) => {
      setTab(lastNativeTab);
    },
    [lastNativeTab, setTab],
  );

  useEffect(() => {
    setLastNativeTabState((prev) => (prev === tab ? prev : tab));
  }, [tab]);

  const switchUiShellMode = useCallback((_mode: UiShellMode) => {
    // Only one shell mode remains ("native"); nothing to switch.
  }, []);

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
