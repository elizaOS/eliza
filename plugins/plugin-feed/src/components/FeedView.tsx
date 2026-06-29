/**
 * FeedView — the single GUI/XR data wrapper for the Feed operator surface.
 *
 * It owns the live Feed data (the ten `getFeed*` loaders, the 12s refresh poll,
 * the pause/resume autonomy control, and the suggested-prompt send) and renders
 * the one presentational {@link FeedSpatialView} inside a {@link SpatialSurface}.
 * Omitting the `modality` prop lets `SpatialSurface` auto-detect GUI vs XR via
 * `window.__elizaXRContext`, so the SAME component serves both surfaces. The TUI
 * surface renders the same `FeedSpatialView` through the terminal registry (see
 * `register-terminal-view.tsx`).
 *
 * This is the single GUI/XR surface the view bundle exports (`componentExport:
 * "FeedView"`); there is no separate operator-surface component.
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
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    if (!run) return;
    const timer = window.setInterval(() => {
      void loadDashboard();
    }, 12_000);
    return () => window.clearInterval(timer);
  }, [loadDashboard, run]);

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

  return <FeedSpatialView snapshot={snapshot} onAction={onAction} />;
}
