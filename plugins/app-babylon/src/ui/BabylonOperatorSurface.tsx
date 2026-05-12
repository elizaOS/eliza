import {
  type AppOperatorSurfaceProps,
  type BabylonActivityItem,
  type BabylonAgentGoal,
  type BabylonAgentStatus,
  type BabylonChatMessage,
  type BabylonPredictionMarket,
  type BabylonWallet,
  client,
  formatDetailTimestamp,
  SurfaceBadge,
  SurfaceCard,
  SurfaceEmptyState,
  SurfaceGrid,
  SurfaceSection,
  selectLatestRunForApp,
  toneForHealthState,
  toneForStatusText,
  toneForViewerAttachment,
} from "@elizaos/app-core";
import { Button, Input, useApp } from "@elizaos/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type BabylonAgentSummaryEnvelope,
  type BabylonTeamConversation,
  type BabylonTeamDashboard,
  extractAgentSummary,
  extractChatMessages,
  extractTeamConversations,
  extractTeamDashboard,
  extractTradingBalance,
  summarizeBabylonActivity,
} from "./babylon-data";

function extractWallet(value: unknown): BabylonWallet | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;

  const balance = asFiniteNumber(data.balance);
  const transactions = Array.isArray(data.transactions)
    ? (data.transactions as BabylonWallet["transactions"])
    : [];

  if (balance == null && !Array.isArray(data.transactions)) {
    return null;
  }

  return {
    balance: balance ?? 0,
    transactions,
  };
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatDecimal(value: unknown, digits: number): string | null {
  const parsed = asFiniteNumber(value);
  return parsed == null ? null : parsed.toFixed(digits);
}

function formatCurrency(value: unknown): string {
  const formatted = formatDecimal(value, 2);
  return formatted == null ? "n/a" : `$${formatted}`;
}

function formatPnL(value: unknown): string {
  const parsed = asFiniteNumber(value);
  if (parsed == null) return "n/a";
  const sign = parsed >= 0 ? "+" : "";
  return `${sign}$${parsed.toFixed(2)}`;
}

function listPreview(items: BabylonPredictionMarket[]): string {
  if (items.length === 0) return "Market data is not available yet.";
  return items
    .slice(0, 3)
    .map((market) => {
      const yesPrice = formatDecimal(market.yesPrice, 2);
      const noPrice = formatDecimal(market.noPrice, 2);
      if (!yesPrice || !noPrice) {
        return market.title;
      }
      return `${market.title} (${yesPrice}/${noPrice})`;
    })
    .join(" · ");
}

export function BabylonOperatorSurface({
  appName,
  variant = "detail",
  focus = "all",
}: AppOperatorSurfaceProps) {
  const { appRuns } = useApp();
  const { run, matchingRuns } = useMemo(
    () => selectLatestRunForApp(appName, appRuns),
    [appName, appRuns],
  );

  const [agentStatus, setAgentStatus] = useState<BabylonAgentStatus | null>(
    null,
  );
  const [agentSummary, setAgentSummary] =
    useState<BabylonAgentSummaryEnvelope | null>(null);
  const [agentGoals, setAgentGoals] = useState<BabylonAgentGoal[]>([]);
  const [recentTrades, setRecentTrades] = useState<BabylonActivityItem[]>([]);
  const [predictionMarkets, setPredictionMarkets] = useState<
    BabylonPredictionMarket[]
  >([]);
  const [teamDashboard, setTeamDashboard] = useState<BabylonTeamDashboard>({
    agents: [],
    summary: null,
  });
  const [teamConversations, setTeamConversations] = useState<
    BabylonTeamConversation[]
  >([]);
  const [agentChatMessages, setAgentChatMessages] = useState<
    BabylonChatMessage[]
  >([]);
  const [wallet, setWallet] = useState<BabylonWallet | null>(null);
  const [tradingBalance, setTradingBalance] = useState(0);
  const [chatInput, setChatInput] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);

  const activeGoal =
    agentGoals.find((goal) => goal.status === "active") ??
    agentGoals[0] ??
    null;
  const agentPortfolio = agentSummary?.portfolio ?? null;
  const teamTotals = teamDashboard.summary?.totals ?? null;
  const surfaceTitle =
    variant === "live"
      ? "Babylon Live Dashboard"
      : variant === "running"
        ? "Babylon Run Dashboard"
        : "Babylon Operator Dashboard";
  const showDashboard = focus !== "chat";
  const showChat = focus !== "dashboard";
  const controlAction = run?.session?.controls?.includes("pause")
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
        client.getBabylonAgentStatus(),
        client.getBabylonAgentSummary(),
        client.getBabylonAgentGoals(),
        client.getBabylonAgentRecentTrades(),
        client.getBabylonPredictionMarkets({ pageSize: 3 }),
        client.getBabylonTeamDashboard(),
        client.getBabylonTeamConversations(),
        client.getBabylonAgentChat(),
        client.getBabylonAgentWallet(),
        client.getBabylonAgentTradingBalance(),
      ]);

      setAgentStatus(status);
      setAgentSummary(extractAgentSummary(summary));
      setAgentGoals(Array.isArray(goals) ? goals : []);
      setRecentTrades(Array.isArray(tradeFeed.items) ? tradeFeed.items : []);
      setPredictionMarkets(
        Array.isArray(marketFeed.markets) ? marketFeed.markets : [],
      );
      const nextDashboard = extractTeamDashboard(dashboardRaw);
      setTeamDashboard(nextDashboard);
      setTeamConversations(
        extractTeamConversations(conversationsRaw).conversations,
      );
      setAgentChatMessages(extractChatMessages(chatRaw));
      setWallet(extractWallet(walletResponse));
      setTradingBalance(extractTradingBalance(tradingBalanceResponse));
      setStatusMessage(
        status.agentStatus
          ? `Babylon agent status: ${status.agentStatus}`
          : "Babylon operator dashboard refreshed.",
      );
    } catch (error) {
      setStatusMessage(
        error instanceof Error
          ? error.message
          : "Failed to load the Babylon operator surface.",
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

  const handleToggleAgent = useCallback(async () => {
    if (!run) return;
    setStatusMessage(null);
    try {
      const response = await client.controlAppRun(run.runId, controlAction);
      await loadDashboard();
      setStatusMessage(
        response.message ??
          (controlAction === "pause"
            ? "Babylon autonomy paused."
            : "Babylon autonomy resumed."),
      );
    } catch (error) {
      setStatusMessage(
        error instanceof Error
          ? error.message
          : "Failed to update Babylon autonomy.",
      );
    }
  }, [controlAction, loadDashboard, run]);

  const handleSendChat = useCallback(async () => {
    const content = chatInput.trim();
    if (!run || content.length === 0 || sending) return;

    setSending(true);
    setStatusMessage(null);
    try {
      const result = await client.sendAppRunMessage(run.runId, content);
      setChatInput("");
      setStatusMessage(result.message ?? "Suggestion sent to Babylon.");
      await loadDashboard();
    } catch (error) {
      setStatusMessage(
        error instanceof Error
          ? error.message
          : "Failed to send the Babylon operator message.",
      );
    } finally {
      setSending(false);
    }
  }, [chatInput, loadDashboard, run, sending]);

  const handleSuggestedPrompt = useCallback(
    async (prompt: string) => {
      const content = prompt.trim();
      if (!run || content.length === 0 || sending) return;

      setSending(true);
      setStatusMessage(null);
      try {
        const result = await client.sendAppRunMessage(run.runId, content);
        setStatusMessage(result.message ?? "Suggestion sent to Babylon.");
        await loadDashboard();
      } catch (error) {
        setStatusMessage(
          error instanceof Error
            ? error.message
            : "Failed to send the Babylon operator message.",
        );
      } finally {
        setSending(false);
      }
    },
    [loadDashboard, run, sending],
  );

  if (!run) {
    return (
      <SurfaceEmptyState
        title="Babylon operator surface"
        body="Launch Babylon to see live team coordination, market activity, and the agent chat stream here."
      />
    );
  }

  return (
    <section
      className={`space-y-3 ${variant === "live" ? "p-3" : ""}`}
      data-testid={
        variant === "live"
          ? "babylon-live-operator-surface"
          : variant === "running"
            ? "babylon-running-operator-surface"
            : "babylon-detail-operator-surface"
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-xs-tight font-semibold uppercase tracking-[0.18em] text-muted">
          {surfaceTitle}
        </div>
        <SurfaceBadge tone={toneForStatusText(run.status)}>
          {run.status}
        </SurfaceBadge>
        <SurfaceBadge tone={toneForViewerAttachment(run.viewerAttachment)}>
          {run.viewerAttachment}
        </SurfaceBadge>
        <SurfaceBadge tone={toneForHealthState(run.health.state)}>
          {run.health.state}
        </SurfaceBadge>
        <span className="ml-auto text-2xs uppercase tracking-[0.18em] text-muted">
          {matchingRuns.length} active run{matchingRuns.length === 1 ? "" : "s"}
        </span>
      </div>

      {showDashboard ? (
        <SurfaceSection title="Live Status">
          <SurfaceGrid>
            <SurfaceCard
              label="Agent"
              value={agentStatus?.displayName ?? agentStatus?.name ?? "Waiting"}
              subtitle={
                agentStatus
                  ? `${agentStatus.agentStatus ?? "idle"} · ${agentStatus.autonomous ? "autonomous" : "operator-led"}`
                  : "The Babylon agent has not published status yet."
              }
            />
            <SurfaceCard
              label="Current Focus"
              value={activeGoal?.description ?? "No active goal recorded."}
              subtitle={
                activeGoal
                  ? (() => {
                      const progress = formatDecimal(activeGoal.progress, 0);
                      return progress
                        ? `${activeGoal.status} · ${progress}%`
                        : activeGoal.status;
                    })()
                  : undefined
              }
            />
            <SurfaceCard
              label="Portfolio"
              value={
                agentPortfolio
                  ? `${formatCurrency(agentPortfolio.totalAssets)} total assets`
                  : "Portfolio not available yet."
              }
              subtitle={
                agentPortfolio
                  ? `${agentPortfolio.positions} positions · ${formatPnL(agentPortfolio.totalPnL)} total PnL`
                  : undefined
              }
            />
            <SurfaceCard
              label="Team Coordination"
              value={
                teamDashboard.summary?.ownerName ??
                `${teamDashboard.agents.length} team agents observed`
              }
              subtitle={
                teamTotals
                  ? `${formatCurrency(teamTotals.walletBalance)} wallet${
                      asFiniteNumber(teamTotals.openPositions) != null
                        ? ` · ${teamTotals.openPositions} open positions`
                        : ""
                    }`
                  : "Team summary is not available yet."
              }
            />
          </SurfaceGrid>
        </SurfaceSection>
      ) : null}

      {showDashboard ? (
        <SurfaceSection title="Market Watch">
          <SurfaceCard
            label="Prediction Markets"
            value={listPreview(predictionMarkets)}
          />
          <div className="grid gap-2 md:grid-cols-3">
            {recentTrades.slice(0, 3).map((trade) => (
              <SurfaceCard
                key={trade.id}
                label={summarizeBabylonActivity(trade)}
                value={formatDetailTimestamp(trade.timestamp)}
                subtitle={
                  trade.pnl != null ? `PnL ${formatPnL(trade.pnl)}` : undefined
                }
              />
            ))}
            {recentTrades.length === 0 ? (
              <SurfaceCard
                label="Recent Trades"
                value="No recent trades recorded."
              />
            ) : null}
          </div>
        </SurfaceSection>
      ) : null}

      {showChat ? (
        <SurfaceSection title="Team & Chat">
          <div className="grid gap-2 md:grid-cols-2">
            <SurfaceCard
              label="Team Conversations"
              value={
                teamConversations.length > 0
                  ? teamConversations
                      .slice(0, 3)
                      .map((conversation) => conversation.name || "Untitled")
                      .join(" · ")
                  : "No team conversations yet."
              }
              subtitle={
                teamConversations.length > 0
                  ? `${teamConversations.filter((conversation) => conversation.isActive).length} active`
                  : undefined
              }
            />
            <SurfaceCard
              label="Operator Channel"
              value={
                run.session?.canSendCommands
                  ? "Ready for live suggestions."
                  : "Command bridge reconnecting."
              }
              subtitle={formatDetailTimestamp(
                run.lastHeartbeatAt ?? run.updatedAt,
              )}
            />
          </div>
          <div className="space-y-2">
            {agentChatMessages.slice(-3).map((message) => (
              <div
                key={message.id}
                className="rounded-xl border border-border/30 bg-bg/60 px-3 py-2"
              >
                <div className="flex items-center gap-2 text-2xs text-muted">
                  <span className="uppercase">
                    {message.senderName ?? message.senderId}
                  </span>
                  <span className="ml-auto">
                    {formatDetailTimestamp(message.createdAt)}
                  </span>
                </div>
                <div className="mt-1 whitespace-pre-wrap text-xs-tight leading-5 text-txt">
                  {message.content}
                </div>
              </div>
            ))}
            {agentChatMessages.length === 0 ? (
              <div className="rounded-xl border border-border/30 bg-bg/60 px-3 py-2 text-xs-tight italic text-muted">
                No agent chat history yet.
              </div>
            ) : null}
          </div>
        </SurfaceSection>
      ) : null}

      {showChat ? (
        <SurfaceSection title="Steering">
          {run.session?.suggestedPrompts?.length ? (
            <div className="flex flex-wrap gap-2">
              {run.session.suggestedPrompts.slice(0, 4).map((prompt) => (
                <Button
                  key={prompt}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-10 rounded-xl px-3 shadow-sm"
                  onClick={() => void handleSuggestedPrompt(prompt)}
                >
                  {prompt}
                </Button>
              ))}
            </div>
          ) : null}
          <div className="grid gap-2 md:grid-cols-2">
            <SurfaceCard
              label="Autonomy"
              value={
                agentStatus?.autonomous
                  ? "Autonomous play is active."
                  : "Agent is paused or operator-led."
              }
              subtitle={
                agentStatus
                  ? `${agentStatus.autonomousTrading ? "Trading" : "Trading paused"} · ${agentStatus.autonomousPosting ? "Posting" : "Posting paused"}`
                  : undefined
              }
            />
            <SurfaceCard
              label="Wallet"
              value={
                wallet ? formatCurrency(wallet.balance) : "Waiting for wallet"
              }
              subtitle={
                wallet
                  ? `${wallet.transactions.length} transactions · trading ${formatCurrency(tradingBalance)}`
                  : undefined
              }
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-10 rounded-xl px-3 shadow-sm"
              onClick={() => void handleToggleAgent()}
            >
              {controlAction === "pause" ? "Pause agent" : "Resume agent"}
            </Button>
          </div>
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
            <Input
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder="Tell Babylon what to prioritize, avoid, or explain."
              className="min-h-11 rounded-xl"
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSendChat();
                }
              }}
            />
            <Button
              type="button"
              className="min-h-11 rounded-xl px-4 shadow-sm"
              onClick={() => void handleSendChat()}
              disabled={sending || chatInput.trim().length === 0}
            >
              {sending ? "Sending" : "Send"}
            </Button>
          </div>
        </SurfaceSection>
      ) : null}

      {statusMessage ? (
        <div className="rounded-2xl border border-border/35 bg-card/70 px-4 py-3 text-xs-tight leading-5 text-muted-strong">
          {statusMessage}
        </div>
      ) : null}
      <div className="text-2xs uppercase tracking-[0.18em] text-muted">
        {loading ? "Refreshing Babylon surface..." : "Babylon surface ready."}
      </div>
    </section>
  );
}
