/**
 * Apps surface — the launcher grid, or a full-screen game/app runtime when a
 * game run is active.
 */

import { useEffect } from "react";
import {
  getWindowNavigationPath,
  shouldUseHashNavigation,
} from "../../navigation";
import { useAppSelectorShallow } from "../../state";
import { shellHistory } from "../../surface-realm-channel";
import { FullscreenView } from "../apps/FullscreenView";
import { getAppSlug } from "../apps/helpers";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { LauncherSurface } from "./LauncherSurface";

export function AppsPageView() {
  const { appRuns, appsSubTab, activeGameRunId, setState } =
    useAppSelectorShallow((s) => ({
      appRuns: s.appRuns,
      appsSubTab: s.appsSubTab,
      activeGameRunId: s.activeGameRunId,
      setState: s.setState,
    }));
  const hasActiveGame = activeGameRunId.trim().length > 0;
  const activeGameRun = hasActiveGame
    ? appRuns.find((run) => run.runId === activeGameRunId)
    : undefined;

  // When the full-screen game view is active (including after refresh where
  // sessionStorage restores activeGameRunId + appsSubTab="games"), make sure the
  // URL reflects the app slug so bookmarks and further refreshes work.
  useEffect(() => {
    if (appsSubTab !== "games" || !activeGameRun) return;
    const slug = getAppSlug(activeGameRun.appName);
    try {
      const currentPath = getWindowNavigationPath();
      const expected = `/apps/${slug}`;
      if (currentPath !== expected) {
        if (shouldUseHashNavigation()) {
          window.location.hash = expected;
        } else {
          shellHistory.replaceState(null, "", expected);
        }
      }
    } catch {
      /* sandboxed */
    }
  }, [appsSubTab, activeGameRun]);

  useEffect(() => {
    if (appsSubTab === "games" && !hasActiveGame) {
      setState("appsSubTab", "browse");
    }
  }, [appsSubTab, hasActiveGame, setState]);

  return (
    <ShellViewAgentSurface viewId="apps">
      {appsSubTab === "games" && hasActiveGame ? (
        <FullscreenView />
      ) : (
        <LauncherSurface />
      )}
    </ShellViewAgentSurface>
  );
}
