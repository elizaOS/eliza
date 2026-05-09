/**
 * Apps page — single-surface app browser with optional full-screen game mode.
 */

import type React from "react";
import { useEffect } from "react";
import {
  getWindowNavigationPath,
  shouldUseHashNavigation,
} from "../../navigation";
import { useApp } from "../../state";
import { GameView } from "../apps/GameView";
import { getAppSlug } from "../apps/helpers";
import { AppsView } from "./AppsView";

type AppsPageViewRenderer = () => React.ReactElement;

export function AppsPageView({
  inModal,
  appsView: AppsViewRenderer = AppsView as AppsPageViewRenderer,
  gameView: GameViewRenderer = GameView as AppsPageViewRenderer,
}: {
  inModal?: boolean;
  appsView?: AppsPageViewRenderer;
  gameView?: AppsPageViewRenderer;
} = {}) {
  const { appRuns, appsSubTab, activeGameRunId, setState } = useApp();
  const hasActiveGame = activeGameRunId.trim().length > 0;
  const activeGameRun = hasActiveGame
    ? appRuns.find((run) => run.runId === activeGameRunId)
    : undefined;

  // When the game view is active (including after refresh where sessionStorage
  // restores activeGameRunId + appsSubTab="games"), make sure the URL reflects
  // the app slug so bookmarks and further refreshes work.
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
          window.history.replaceState(null, "", expected);
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

  if (appsSubTab === "games" && hasActiveGame) {
    return <GameViewRenderer />;
  }

  if (inModal) {
    return (
      <div
        className="settings-content-area"
        style={
          {
            "--accent": "var(--section-accent-apps, #10b981)",
            "--surface": "rgba(255, 255, 255, 0.06)",
            "--s-accent": "#10b981",
            "--s-text-txt": "#10b981",
            "--s-accent-glow": "rgba(16, 185, 129, 0.35)",
            "--s-accent-subtle": "rgba(16, 185, 129, 0.12)",
            "--s-grid-line": "rgba(16, 185, 129, 0.02)",
            "--s-glow-edge": "rgba(16, 185, 129, 0.08)",
          } as React.CSSProperties
        }
      >
        <div className="settings-section-pane pt-4">
          <AppsViewRenderer />
        </div>
      </div>
    );
  }

  return <AppsViewRenderer />;
}
