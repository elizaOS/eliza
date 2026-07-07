/**
 * FeedView — the GUI wrapper the view bundle exports (`componentExport:
 * "FeedView"`).
 *
 * With a live run viewer it embeds the full Feed web app, authenticated as the
 * agent: the run's `viewer` carries the `FEED_AUTH` session token, and
 * {@link EmbeddedAppViewer} performs the `*_READY` → auth postMessage handshake
 * so the real product UI loads signed in. Without one, this wrapper owns the
 * live Feed data (the ten `getFeed*` loaders, the 12s refresh poll, the
 * pause/resume autonomy control, the suggested-prompt send) feeding the one
 * presentational {@link FeedSpatialView} operator dashboard.
 */

import {
  client,
  type FeedActivityItem,
  type FeedAgentGoal,
  type FeedAgentStatus,
  type FeedChatMessage,
  type FeedPredictionMarket,
  type FeedWallet,
  selectLatestRunForApp,
} from "@elizaos/app-core/ui-compat";

import { EmbeddedAppViewer } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { Button } from "@elizaos/ui/components/ui/button";
import { getActiveViewModality } from "@elizaos/ui/platform";
import { useAppSelector } from "@elizaos/ui/state";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  extractAgentSummary,
  extractChatMessages,
  extractTeamConversations,
  extractTeamDashboard,
  extractTradingBalance,
} from "../ui/feed-data.ts";
import {
  type FeedConversationSnapshot,
  type FeedSnapshot,
  FeedSpatialView,
  type FeedTeamSnapshot,
} from "./FeedSpatialView.tsx";

const FEED_APP_NAME = "@elizaos/plugin-feed";

function extractWallet(value: unknown): FeedWallet | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const balance =
    typeof data.balance === "number" && Number.isFinite(data.balance)
      ? data.balance
      : null;
  const transactions = Array.isArray(data.transactions)
    ? (data.transactions as FeedWallet["transactions"])
    : [];
  if (balance == null && !Array.isArray(data.transactions)) return null;
  return { balance: balance ?? 0, transactions };
}

export function FeedView() {
  const appRuns = useAppSelector((s) => s.appRuns);
  const { run } = useMemo(
    () => selectLatestRunForApp(FEED_APP_NAME, appRuns),
    [appRuns],
  );

  // With a live run viewer on the GUI surface, open the full Feed web app
  // authenticated as the agent (the run's viewer carries the FEED_AUTH session
  // token) instead of the operator dashboard.
  const viewerUrl = run?.viewer?.url ?? "";
  const viewerAuthMessage = run?.viewer?.authMessage ?? null;
  const showEmbeddedApp =
    getActiveViewModality() === "gui" && viewerUrl.length > 0;

  const [agentStatus, setAgentStatus] = useState<FeedAgentStatus | null>(null);
  const [portfolio, setPortfolio] = useState<FeedSnapshot["portfolio"]>(null);
  const [goal, setGoal] = useState<FeedAgentGoal | null>(null);
  const [recentTrades, setRecentTrades] = useState<FeedActivityItem[]>([]);
  const [predictionMarkets, setPredictionMarkets] = useState<
    FeedPredictionMarket[]
  >([]);
  const [team, setTeam] = useState<FeedTeamSnapshot>({
    agentCount: 0,
    totals: null,
  });
  const [conversations, setConversations] = useState<
    FeedConversationSnapshot[]
  >([]);
  const [chatMessages, setChatMessages] = useState<FeedChatMessage[]>([]);
  const [wallet, setWallet] = useState<FeedWallet | null>(null);
  const [tradingBalance, setTradingBalance] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);

  const suggestedPrompts = (run?.session?.suggestedPrompts ?? []).slice(0, 2);
  const controlAction: "pause" | "resume" = run?.session?.controls?.includes(
    "pause",
  )
    ? "pause"
    : run?.session?.controls?.includes("resume")
      ? "resume"
      : agentStatus?.autonomous
        ? "pause"
        : "resume";

  const loadDashboard = useCallback(async () => {
    if (!run) return;
    setLoading(true);
    setStatusMessage(null);
    try {
      const [
        status,
        summary,
        goals,
        tradeFeed,
        marketFeed,
        dashboardRaw,
        conversationsRaw,
        chatRaw,
        walletResponse,
        tradingBalanceResponse,
      ] = await Promise.all([
        client.getFeedAgentStatus(),
        client.getFeedAgentSummary(),
        client.getFeedAgentGoals(),
        client.getFeedAgentRecentTrades(),
        client.getFeedPredictionMarkets({ pageSize: 3 }),
        client.getFeedTeamDashboard(),
        client.getFeedTeamConversations(),
        client.getFeedAgentChat(),
        client.getFeedAgentWallet(),
        client.getFeedAgentTradingBalance(),
      ]);

      setAgentStatus(status);
      setPortfolio(extractAgentSummary(summary).portfolio ?? null);
      const goalList = Array.isArray(goals) ? goals : [];
      setGoal(
        goalList.find((entry) => entry.status === "active") ??
          goalList[0] ??
          null,
      );
      setRecentTrades(Array.isArray(tradeFeed.items) ? tradeFeed.items : []);
      setPredictionMarkets(
        Array.isArray(marketFeed.markets) ? marketFeed.markets : [],
      );
      const dashboard = extractTeamDashboard(dashboardRaw);
      setTeam({
        ownerName: dashboard.summary?.ownerName,
        agentCount: dashboard.agents.length,
        totals: dashboard.summary?.totals ?? null,
      });
      setConversations(
        extractTeamConversations(conversationsRaw).conversations.map(
          (conversation) => ({
            id: conversation.id,
            name: conversation.name,
            isActive: conversation.isActive,
          }),
        ),
      );
      setChatMessages(extractChatMessages(chatRaw));
      setWallet(extractWallet(walletResponse));
      setTradingBalance(extractTradingBalance(tradingBalanceResponse));
      setStatusMessage(
        status.agentStatus
          ? `Feed agent status: ${status.agentStatus}`
          : "Feed operator dashboard refreshed.",
      );
    } catch (error) {
      setStatusMessage(
        error instanceof Error
          ? error.message
          : "Failed to load the Feed operator surface.",
      );
    } finally {
      setLoading(false);
    }
  }, [run]);

  useEffect(() => {
    // The embedded full app loads its own data — only the operator dashboard
    // (XR/TUI) needs these loaders.
    if (showEmbeddedApp) return;
    void loadDashboard();
  }, [loadDashboard, showEmbeddedApp]);

  useEffect(() => {
    if (showEmbeddedApp || !run) return;
    const timer = window.setInterval(() => {
      void loadDashboard();
    }, 12_000);
    return () => window.clearInterval(timer);
  }, [loadDashboard, run, showEmbeddedApp]);

  const toggleAutonomy = useCallback(async () => {
    if (!run) return;
    setStatusMessage(null);
    try {
      const response = await client.controlAppRun(run.runId, controlAction);
      await loadDashboard();
      setStatusMessage(
        response.message ??
          (controlAction === "pause"
            ? "Feed autonomy paused."
            : "Feed autonomy resumed."),
      );
    } catch (error) {
      setStatusMessage(
        error instanceof Error
          ? error.message
          : "Failed to update Feed autonomy.",
      );
    }
  }, [controlAction, loadDashboard, run]);

  const sendPrompt = useCallback(
    async (prompt: string) => {
      const content = prompt.trim();
      if (!run || content.length === 0 || sending) return;
      setSending(true);
      setStatusMessage(null);
      try {
        const result = await client.sendAppRunMessage(run.runId, content);
        setStatusMessage(result.message ?? "Suggestion sent to Feed.");
        await loadDashboard();
      } catch (error) {
        setStatusMessage(
          error instanceof Error
            ? error.message
            : "Failed to send the Feed operator message.",
        );
      } finally {
        setSending(false);
      }
    },
    [loadDashboard, run, sending],
  );

  const onAction = useCallback(
    (action: string) => {
      if (action.startsWith("prompt:")) {
        const index = Number.parseInt(action.slice("prompt:".length), 10);
        const prompt = suggestedPrompts[index];
        if (prompt) void sendPrompt(prompt);
        return;
      }
      switch (action) {
        case "toggle-autonomy":
          void toggleAutonomy();
          return;
        case "refresh":
          void loadDashboard();
          return;
      }
    },
    [loadDashboard, sendPrompt, suggestedPrompts, toggleAutonomy],
  );

  const snapshot: FeedSnapshot = {
    hasSession: Boolean(run),
    agentStatus,
    portfolio,
    goal,
    recentTrades,
    predictionMarkets,
    team,
    conversations,
    chatMessages,
    wallet,
    tradingBalance,
    controlAction,
    suggestedPrompts,
    statusMessage,
    loading,
    sending,
  };

  // Surface the two primary operator actions to the agent surface. Both reuse
  // the live data-layer handlers this wrapper already owns (the same handlers
  // the spatial Refresh / Pause-Resume buttons dispatch through `onAction`), so
  // the agent can address them directly on the GUI/XR surface.
  const refreshControl = useAgentElement<HTMLButtonElement>({
    id: "feed-refresh",
    role: "button",
    label: "Refresh feed",
    group: "feed",
    description: "Reload the Feed operator dashboard",
    status: loading ? "active" : "inactive",
  });
  const autonomyControl = useAgentElement<HTMLButtonElement>({
    id: "feed-toggle-autonomy",
    role: "button",
    label: controlAction === "pause" ? "Pause autonomy" : "Resume autonomy",
    group: "feed",
    description:
      "Pause or resume the Feed agent's autonomous prediction-market trading",
    status: run
      ? controlAction === "pause"
        ? "active"
        : "inactive"
      : "disabled",
  });

  // GUI: render the full Feed web app, authenticated as the agent via the
  // viewer's FEED_AUTH postMessage handshake.
  if (showEmbeddedApp) {
    return (
      <EmbeddedAppViewer
        viewerUrl={viewerUrl}
        authMessage={viewerAuthMessage}
        sandbox={run?.viewer?.sandbox ?? undefined}
        title="Feed"
      />
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          padding: "0.5rem",
          flexShrink: 0,
        }}
      >
        <Button
          ref={refreshControl.ref}
          {...refreshControl.agentProps}
          variant="outline"
          size="sm"
          onClick={() => void loadDashboard()}
          disabled={loading}
        >
          Refresh
        </Button>
        <Button
          ref={autonomyControl.ref}
          {...autonomyControl.agentProps}
          variant="outline"
          size="sm"
          onClick={() => void toggleAutonomy()}
          disabled={!run}
        >
          {controlAction === "pause" ? "Pause" : "Resume"}
        </Button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <FeedSpatialView snapshot={snapshot} onAction={onAction} />
      </div>
    </div>
  );
}
