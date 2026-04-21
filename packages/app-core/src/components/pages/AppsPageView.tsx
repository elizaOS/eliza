/**
 * Apps page — single-surface app browser with optional full-screen game mode.
 */

import type React from "react";
import { useEffect } from "react";
import { useApp } from "../../state";
import { GameView } from "../apps/GameView";
import { getAppSlug } from "../apps/helpers";
import { PageScopedChat } from "../chat/PageScopedChat";
import { RightSideChatPanel } from "../chat/RightSideChatPanel";
import { AppsView } from "./AppsView";

const APPS_SYSTEM_ADDENDUM = `
You are scoped to controlling Milady's mini-apps on this page.
Tools available:
- LAUNCH_APP (aliases: OPEN_APP, START_APP, RUN_APP, LAUNCH_MINI_APP) — launch an app by name or slug.
- CLOSE_APP (aliases: STOP_APP, EXIT_APP, KILL_APP, QUIT_APP) — stop a running app by runId or name.
- LIST_RUNNING_APPS (aliases: LIST_APPS, WHATS_OPEN, SHOW_RUNNING_APPS) — list what is currently running.

When the user asks "what's open" or "what is running", call LIST_RUNNING_APPS.
When asked to launch/open/start an app, call LAUNCH_APP.
When asked to close/stop/quit an app, call CLOSE_APP — prefer runId if disambiguation is needed.
For unrelated requests, suggest the user switch to the main chat.
`;

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
  const {
    appRuns,
    appsSubTab,
    activeGameRunId,
    activeConversationId,
    setState,
  } = useApp();
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
      const currentPath =
        window.location.protocol === "file:"
          ? window.location.hash.replace(/^#/, "") || "/"
          : window.location.pathname;
      const expected = `/apps/${slug}`;
      if (currentPath !== expected) {
        if (window.location.protocol === "file:") {
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

  return (
    <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
      <div className="min-w-0 flex-1 overflow-auto">
        <AppsViewRenderer />
      </div>
      <RightSideChatPanel
        storageKey="milady:chat-panel:apps"
        defaultWidth={384}
        minWidth={300}
        maxWidth={720}
      >
        <PageScopedChat
          scope="page-apps"
          title="Apps assistant"
          placeholder="Ask to launch or close an app..."
          systemAddendum={APPS_SYSTEM_ADDENDUM}
          bridgeFromConversationId={activeConversationId}
        />
      </RightSideChatPanel>
    </div>
  );
}
