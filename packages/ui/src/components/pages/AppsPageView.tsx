/**
 * Apps surface — the launcher grid, a full-screen game/app runtime when a game
 * run is active, or a designed not-found state when the routed `/apps/<slug>`
 * is claimed by nothing on this device (UI three-state rule: a dead deep link
 * must never render as the healthy grid — that masking is how #17020 shipped
 * invisible).
 */

import { logger } from "@elizaos/logger";
import { useEffect } from "react";
import { useRoutableViews } from "../../hooks/useAvailableViews";
import {
  getWindowNavigationPath,
  shouldUseHashNavigation,
} from "../../navigation";
import { useAppSelectorShallow } from "../../state";
import { shellHistory } from "../../surface-realm-channel";
import { FullscreenView } from "../apps/FullscreenView";
import { getAppSlug } from "../apps/helpers";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import type { AppRouteNotFoundMatchedView } from "./AppRouteNotFound";
import { AppRouteNotFound } from "./AppRouteNotFound";
import { LauncherSurface } from "./LauncherSurface";

export interface AppsPageViewProps {
  /** Slug from the routed `/apps/<slug>` path; null on the bare grid. */
  appSlug?: string | null;
}

/**
 * A routable view whose id equals the slug but whose canonical path is
 * elsewhere — a stale `/apps/<id>` bookmark for a view mounted at its own
 * route (e.g. `/apps/settings` → `/settings`).
 */
function findMatchedViewElsewhere(
  views: ReturnType<typeof useRoutableViews>["views"],
  slug: string,
): AppRouteNotFoundMatchedView | null {
  for (const view of views) {
    if (view.id !== slug) continue;
    const path = view.path;
    if (typeof path === "string" && path.length > 0 && path !== `/apps/${slug}`)
      return { label: view.label, path };
  }
  return null;
}

// One structured warning per unknown slug per session — the observable signal
// for a dead deep link, without spamming on re-render or route re-entry.
const warnedUnknownSlugs = new Set<string>();

export function AppsPageView({ appSlug = null }: AppsPageViewProps) {
  const { appRuns, appsSubTab, activeGameRunId, setState } =
    useAppSelectorShallow((s) => ({
      appRuns: s.appRuns,
      appsSubTab: s.appsSubTab,
      activeGameRunId: s.activeGameRunId,
      setState: s.setState,
    }));
  const { views, loading } = useRoutableViews();
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

  const slug = appSlug?.trim() ?? "";
  const gameFullscreen = appsSubTab === "games" && hasActiveGame;
  // Three-state gate: while the view registry is still loading, a cold deep
  // link renders the grid rather than flashing not-found — the registry claim
  // upstream (App.tsx remote-view/app-shell routing) re-renders when it lands.
  // Only a settled registry with no claimant is a real dead route.
  const slugClaimed =
    views.some((view) => view.path === `/apps/${slug}`) ||
    appRuns.some((run) => getAppSlug(run.appName) === slug);
  const showNotFound =
    slug.length > 0 && !loading && !slugClaimed && !gameFullscreen;
  const matchedView = showNotFound
    ? findMatchedViewElsewhere(views, slug)
    : null;

  useEffect(() => {
    if (!showNotFound || warnedUnknownSlugs.has(slug)) return;
    warnedUnknownSlugs.add(slug);
    logger.warn(
      { slug },
      "[AppsPageView] no registered page, view, or app run claims /apps route — rendering not-found",
    );
  }, [showNotFound, slug]);

  return (
    <ShellViewAgentSurface viewId="apps">
      {gameFullscreen ? (
        <FullscreenView />
      ) : showNotFound ? (
        <AppRouteNotFound slug={slug} matchedView={matchedView} />
      ) : (
        <LauncherSurface />
      )}
    </ShellViewAgentSurface>
  );
}
