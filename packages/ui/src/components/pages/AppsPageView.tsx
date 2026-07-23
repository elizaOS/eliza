/**
 * Apps surface — the launcher grid, a full-screen game/app runtime when a game
 * run is active, or a designed not-found state when the routed `/apps/<slug>`
 * is claimed by nothing on this device (UI three-state rule: a dead deep link
 * must never render as the healthy grid — that masking is how #17020 shipped
 * invisible).
 */

import { logger } from "@elizaos/logger";
import { useEffect, useState } from "react";
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
    // Never offer a CTA into a dead route: an unavailable entry keeps its
    // canonical path in the registry, but navigating there would fail too.
    if (view.id !== slug || !view.available) continue;
    const path = view.path;
    if (typeof path === "string" && path.length > 0 && path !== `/apps/${slug}`)
      return { label: view.label, path };
  }
  return null;
}

// One structured warning per unknown slug per session — the observable signal
// for a dead deep link, without spamming on re-render or route re-entry.
const warnedUnknownSlugs = new Set<string>();

// registerAppShellPage registrations are idle-deferred until after first paint
// and plugin navTab claims populate asynchronously, so on a cold deep link the
// views fetch can settle BEFORE a valid claim registers. A slug observed
// settled-and-unclaimed must therefore survive this grace window before the
// route is asserted dead — otherwise a working route flashes not-found and
// burns its once-per-session warning.
const UNCLAIMED_SLUG_GRACE_MS = 1500;

export function AppsPageView({ appSlug = null }: AppsPageViewProps) {
  const { appRuns, appsSubTab, activeGameRunId, setState } =
    useAppSelectorShallow((s) => ({
      appRuns: s.appRuns,
      appsSubTab: s.appsSubTab,
      activeGameRunId: s.activeGameRunId,
      setState: s.setState,
    }));
  const { views, loading, error } = useRoutableViews();
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
  // An `available: false` entry keeps its declared path in the registry while
  // its bundle is unloadable (e.g. missing on disk) — it must never claim the
  // slug, or a deep link into a broken install renders as the healthy grid,
  // the exact masking class this gate exists to kill.
  const slugClaimed =
    views.some((view) => view.available && view.path === `/apps/${slug}`) ||
    appRuns.some((run) => getAppSlug(run.appName) === slug);
  // Three-state gate: asserting "nothing is mounted here" requires knowing
  // what IS mounted, so the not-found claim needs a SETTLED, SUCCESSFUL
  // registry read. While loading, render the grid rather than flashing
  // not-found; on a registry error, also render the grid and never warn — a
  // failed load must not read as not-found (three-state rule), and the claim
  // re-renders when the registry recovers.
  const settledUnclaimed =
    slug.length > 0 && !loading && !error && !slugClaimed && !gameFullscreen;

  // Grace window for the idle-registration race (see UNCLAIMED_SLUG_GRACE_MS):
  // the timer arms when the slug is first observed settled-and-unclaimed and
  // is cleared when a claim appears, the slug changes, or the view unmounts.
  // Keying the fired state on the slug means a slug change mid-grace restarts
  // the window instead of inheriting the previous slug's verdict.
  const [deadRouteSlug, setDeadRouteSlug] = useState<string | null>(null);
  useEffect(() => {
    if (!settledUnclaimed) {
      setDeadRouteSlug(null);
      return;
    }
    const timer = window.setTimeout(
      () => setDeadRouteSlug(slug),
      UNCLAIMED_SLUG_GRACE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [settledUnclaimed, slug]);

  const showNotFound = settledUnclaimed && deadRouteSlug === slug;
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
