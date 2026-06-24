import {
  type AppOperatorSurfaceProps,
  client,
  type FeedActivityItem,
  type FeedAgentGoal,
  type FeedAgentStatus,
  type FeedChatMessage,
  type FeedPredictionMarket,
  type FeedWallet,
  formatDetailTimestamp,
  SurfaceCard,
  SurfaceSection,
  selectLatestRunForApp,
} from "@elizaos/app-core/ui-compat";
import { Button } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { useAppSelector } from "@elizaos/ui/state";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  GameSurfaceHero,
  GameSurfaceShell,
  GameSurfaceStrip,
  GameSurfaceZone,
  HeroCta,
  type StatChip,
  WaitingForSession,
} from "./game-surface-shell";

const FEED_ACCENT = "#ff8a24";

import {
  extractAgentSummary,
  extractChatMessages,
  extractTeamConversations,
  extractTeamDashboard,
  extractTradingBalance,
  type FeedAgentSummaryEnvelope,
  type FeedTeamConversation,
  type FeedTeamDashboard,
  summarizeFeedActivity,
} from "./feed-data";

function extractWallet(value: unknown): FeedWallet | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;

  const balance = asFiniteNumber(data.balance);
  const transactions = Array.isArray(data.transactions)
    ? (data.transactions as FeedWallet["transactions"])
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

function listPreview(items: FeedPredictionMarket[]): string {
  if (items.length === 0) return "—";
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

function FeedSuggestedPromptButton({
  prompt,
  index,
  onSelect,
  disabled,
}: {
  prompt: string;
  index: number;
  onSelect: (prompt: string) => void;
  disabled: boolean;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `steering-suggested-prompt-${index}`,
    role: "button",
    label: prompt,
    group: "Steering",
    description: `Send the suggested prompt "${prompt}" to Feed`,
    onActivate: () => onSelect(prompt),
  });
  return (
    <Button
      ref={ref}
      type="button"
      variant="outline"
      size="sm"
      className="min-h-10 rounded-xl px-3"
      onClick={() => onSelect(prompt)}
      disabled={disabled}
      {...agentProps}
    >
      {prompt}
    </Button>
  );
}

export function FeedOperatorSurface({
  appName,
  variant = "detail",
  focus = "all",
}: AppOperatorSurfaceProps) {
  const appRuns = useAppSelector((s) => s.appRuns);
  const { run, matchingRuns } = useMemo(
    () => selectLatestRunForApp(appName, appRuns),
    [appName, appRuns],
  );

  const [agentStatus, setAgentStatus] = useState<FeedAgentStatus | null>(null);
  const [agentSummary, setAgentSummary] =
    useState<FeedAgentSummaryEnvelope | null>(null);
  const [agentGoals, setAgentGoals] = useState<FeedAgentGoal[]>([]);
  const [recentTrades, setRecentTrades] = useState<FeedActivityItem[]>([]);
  const [predictionMarkets, setPredictionMarkets] = useState<
    FeedPredictionMarket[]
  >([]);
  const [teamDashboard, setTeamDashboard] = useState<FeedTeamDashboard>({
    agents: [],
    summary: null,
  });
  const [teamConversations, setTeamConversations] = useState<
    FeedTeamConversation[]
  >([]);
  const [agentChatMessages, setAgentChatMessages] = useState<FeedChatMessage[]>(
    [],
  );
  const [wallet, setWallet] = useState<FeedWallet | null>(null);
  const [tradingBalance, setTradingBalance] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const suggestedPrompts = (run?.session?.suggestedPrompts ?? []).slice(0, 2);
  const recentChatMessages = agentChatMessages.slice(-2);

  const activeGoal =
    agentGoals.find((goal) => goal.status === "active") ??
    agentGoals[0] ??
    null;
  const agentPortfolio = agentSummary?.portfolio ?? null;
  const teamTotals = teamDashboard.summary?.totals ?? null;
  const surfaceTitle = "Feed";
  const showDashboard = focus !== "chat";
  const showChat = focus !== "dashboard";
  const controlAction = run?.session?.controls?.includes("pause")
    ? "pause"
    : run?.session?.controls?.includes("resume")
      ? "resume"
      : agentStatus?.autonomous
        ? "pause"
        : "resume";

  const autonomyActive = controlAction === "pause";
  const toggleAgentButton = useAgentElement<HTMLButtonElement>({
    id: "steering-toggle-autonomy",
    role: "toggle",
    label: autonomyActive ? "Pause agent" : "Resume agent",
    group: "Steering",
    status: autonomyActive ? "active" : "inactive",
    description: "Pause or resume Feed autonomous play",
    onActivate: () => void handleToggleAgent(),
  });
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

  const handleToggleAgent = useCallback(async () => {
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

  const handleSuggestedPrompt = useCallback(
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

  if (!run) {
    const chips: StatChip[] = [
      { icon: "◉", label: "Agent", value: "Pending", state: "pending" },
      { icon: "◒", label: "Portfolio", value: "—", state: "idle" },
      { icon: "▲", label: "Markets", value: "—", state: "idle" },
      { icon: "◇", label: "Wallet", value: "—", state: "idle" },
    ];
    return (
      <div data-testid="feed-operator-ready">
        <GameSurfaceShell>
          <GameSurfaceHero
            title="Feed"
            statusLabel="No session yet"
            statusState="pending"
            cta={<HeroCta label="Spawn agent" accent={FEED_ACCENT} disabled />}
          />
          <GameSurfaceStrip chips={chips} />
          <WaitingForSession accent={FEED_ACCENT} message="" />
        </GameSurfaceShell>
      </div>
    );
  }

  const liveChips: StatChip[] = [
    {
      icon: "◉",
      label: "Agent",
      value: agentStatus?.autonomous ? "Autonomous" : "Operator-led",
      state: run.health.state === "healthy" ? "ready" : "pending",
    },
    {
      icon: "◒",
      label: "Portfolio",
      value: agentPortfolio ? formatCurrency(agentPortfolio.totalAssets) : "—",
      state: agentPortfolio ? "active" : "idle",
    },
    {
      icon: "▲",
      label: "Markets",
      value: `${predictionMarkets.length} live`,
      state: predictionMarkets.length > 0 ? "active" : "idle",
    },
    {
      icon: "◇",
      label: "Wallet",
      value: wallet ? formatCurrency(wallet.balance) : "—",
      state: wallet ? "ready" : "idle",
    },
  ];
  return (
    <div
      data-testid={
        variant === "live"
          ? "feed-live-operator-surface"
          : variant === "running"
            ? "feed-running-operator-surface"
            : "feed-detail-operator-surface"
      }
    >
      <GameSurfaceShell>
        <GameSurfaceHero
          title={surfaceTitle}
          statusLabel={`${run.status} · ${run.health.state}`}
          statusState={run.health.state === "healthy" ? "ready" : "pending"}
          cta={
            <HeroCta
              label={autonomyActive ? "Pause agent" : "Resume agent"}
              accent={FEED_ACCENT}
              onClick={() => void handleToggleAgent()}
            />
          }
        />
        <GameSurfaceStrip chips={liveChips} />
        <GameSurfaceZone>
          <div className="flex flex-wrap items-center gap-2 text-xs-tight text-muted">
            <span className="inline-flex items-center gap-2">
              <span
                aria-hidden
                className="size-2 rounded-full"
                style={{
                  background:
                    run.health.state === "healthy" ? FEED_ACCENT : "#ef4444",
                }}
              />
              <span className="text-txt">{run.status}</span>
              <span>{run.viewerAttachment}</span>
            </span>
            <span className="ml-auto">
              {matchingRuns.length} active run
              {matchingRuns.length === 1 ? "" : "s"}
            </span>
          </div>

          {showDashboard ? (
            <SurfaceSection title="Live Status">
              <div className="space-y-2">
                <SurfaceCard
                  label="Agent"
                  value={
                    agentStatus?.displayName ?? agentStatus?.name ?? "Waiting"
                  }
                  subtitle={
                    agentStatus
                      ? `${agentStatus.agentStatus ?? "idle"} · ${agentStatus.autonomous ? "autonomous" : "operator-led"}`
                      : "No status"
                  }
                />
                <SurfaceCard
                  label="Current Focus"
                  value={activeGoal?.description ?? "—"}
                  subtitle={
                    activeGoal
                      ? (() => {
                          const progress = formatDecimal(
                            activeGoal.progress,
                            0,
                          );
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
                      : "—"
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
                      : undefined
                  }
                />
              </div>
            </SurfaceSection>
          ) : null}

          {showDashboard ? (
            <SurfaceSection title="Market Watch">
              <SurfaceCard
                label="Markets"
                value={listPreview(predictionMarkets)}
              />
              <div className="space-y-2">
                {recentTrades.slice(0, 3).map((trade) => (
                  <SurfaceCard
                    key={trade.id}
                    label={summarizeFeedActivity(trade)}
                    value={formatDetailTimestamp(trade.timestamp)}
                    subtitle={
                      trade.pnl != null
                        ? `PnL ${formatPnL(trade.pnl)}`
                        : undefined
                    }
                  />
                ))}
                {recentTrades.length === 0 ? (
                  <SurfaceCard label="Trades" value="—" />
                ) : null}
              </div>
            </SurfaceSection>
          ) : null}

          {showChat ? (
            <SurfaceSection title="Team">
              <div className="space-y-2">
                <SurfaceCard
                  label="Team Conversations"
                  value={
                    teamConversations.length > 0
                      ? teamConversations
                          .slice(0, 3)
                          .map(
                            (conversation) => conversation.name || "Untitled",
                          )
                          .join(" · ")
                      : "—"
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
                    run.session?.canSendCommands ? "Ready" : "Reconnecting"
                  }
                  subtitle={formatDetailTimestamp(
                    run.lastHeartbeatAt ?? run.updatedAt,
                  )}
                />
              </div>
              <div className="space-y-2">
                {recentChatMessages.map((message) => (
                  <div key={message.id} className="px-1 py-1">
                    <div className="flex items-center gap-2 text-2xs text-muted">
                      <span>{message.senderName ?? message.senderId}</span>
                      <span className="ml-auto">
                        {formatDetailTimestamp(message.createdAt)}
                      </span>
                    </div>
                    <div className="mt-1 whitespace-pre-wrap text-xs-tight leading-5 text-txt">
                      {message.content}
                    </div>
                  </div>
                ))}
                {recentChatMessages.length === 0 ? (
                  <div className="px-1 py-1 text-xs-tight italic text-muted">
                    —
                  </div>
                ) : null}
              </div>
            </SurfaceSection>
          ) : null}

          {showChat ? (
            <SurfaceSection title="Steering">
              {suggestedPrompts.length ? (
                <div className="flex flex-wrap gap-2">
                  {suggestedPrompts.map((prompt, index) => (
                    <FeedSuggestedPromptButton
                      key={prompt}
                      prompt={prompt}
                      index={index}
                      onSelect={(value) => void handleSuggestedPrompt(value)}
                      disabled={sending}
                    />
                  ))}
                </div>
              ) : null}
              <div className="space-y-2">
                <SurfaceCard
                  label="Autonomy"
                  value={agentStatus?.autonomous ? "Active" : "Paused"}
                  subtitle={
                    agentStatus
                      ? `${agentStatus.autonomousTrading ? "Trading" : "Trading paused"} · ${agentStatus.autonomousPosting ? "Posting" : "Posting paused"}`
                      : undefined
                  }
                />
                <SurfaceCard
                  label="Wallet"
                  value={wallet ? formatCurrency(wallet.balance) : "—"}
                  subtitle={
                    wallet
                      ? `${wallet.transactions.length} transactions · trading ${formatCurrency(tradingBalance)}`
                      : undefined
                  }
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  ref={toggleAgentButton.ref}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-10 rounded-xl px-3"
                  aria-current={autonomyActive}
                  onClick={() => void handleToggleAgent()}
                  {...toggleAgentButton.agentProps}
                >
                  {controlAction === "pause" ? "Pause" : "Resume"}
                </Button>
              </div>
            </SurfaceSection>
          ) : null}

          {statusMessage ? (
            <div className="bg-card/70 px-1 py-2 text-xs-tight leading-5 text-muted-strong">
              {statusMessage}
            </div>
          ) : null}
          {loading ? (
            <div className="text-2xs text-muted">Refreshing…</div>
          ) : null}
        </GameSurfaceZone>
      </GameSurfaceShell>
    </div>
  );
}
