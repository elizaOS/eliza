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
  selectLatestRunForApp,
} from "@elizaos/app-core/ui-compat";
import { Button } from "@elizaos/ui";
// Imported via direct subpaths: the big `@elizaos/ui` root barrel doesn't
// resolve these newly-added members under the plugin's bundler tsconfig.
import { ChatEmptyStateWithRecommendations } from "@elizaos/ui/components/composites/chat/ChatEmptyStateWithRecommendations";
import { dispatchChatPrefill } from "@elizaos/ui/events";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { useAppSelector } from "@elizaos/ui/state";
import { LineChart } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  GameSurfaceHero,
  GameSurfaceShell,
  GameSurfaceStrip,
  GameSurfaceZone,
  HeroCta,
  type StatChip,
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

function StatLine({
  label,
  value,
  subtitle,
}: {
  label: string;
  value: string;
  subtitle?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="shrink-0 text-xs-tight text-muted">{label}</span>
        <span className="break-words text-right text-sm font-medium text-txt">
          {value}
        </span>
      </div>
      {subtitle ? (
        <span className="text-2xs text-muted">{subtitle}</span>
      ) : null}
    </div>
  );
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
    return (
      <div data-testid="feed-operator-ready">
        <ChatEmptyStateWithRecommendations
          icon={LineChart}
          title="Ready to trade?"
          recommendations={[
            "Spawn a Feed trading agent",
            "Which prediction markets are trending right now?",
            "Draft an autonomous trading strategy",
          ]}
          primaryAction={{
            label: "Spawn agent",
            onClick: () =>
              dispatchChatPrefill({
                text: "Spawn a Feed trading agent and start the prediction-market loop.",
                select: true,
              }),
          }}
        />
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
          <div className="flex items-center gap-2 text-xs-tight text-muted">
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={{
                background:
                  run.health.state === "healthy" ? FEED_ACCENT : "#ef4444",
              }}
            />
            <span className="text-txt">{run.health.state}</span>
            <span className="ml-auto">
              {matchingRuns.length} active run
              {matchingRuns.length === 1 ? "" : "s"}
            </span>
          </div>

          {showDashboard ? (
            <div className="flex flex-col gap-2">
              <StatLine
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
              <StatLine
                label="Focus"
                value={activeGoal?.description ?? "No active focus"}
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
              <StatLine
                label="Portfolio"
                value={
                  agentPortfolio
                    ? `${formatCurrency(agentPortfolio.totalAssets)} total assets`
                    : "No positions yet"
                }
                subtitle={
                  agentPortfolio
                    ? `${agentPortfolio.positions} positions · ${formatPnL(agentPortfolio.totalPnL)} total PnL`
                    : undefined
                }
              />
              <StatLine
                label="Team"
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
          ) : null}

          {showDashboard ? (
            <div className="flex flex-col gap-2">
              <StatLine
                label="Markets"
                value={listPreview(predictionMarkets)}
              />
              {recentTrades.slice(0, 3).map((trade) => (
                <div
                  key={trade.id}
                  className="flex items-baseline justify-between gap-3 text-xs-tight"
                >
                  <span className="min-w-0 truncate text-txt">
                    {summarizeFeedActivity(trade)}
                  </span>
                  <span className="shrink-0 text-muted">
                    {formatDetailTimestamp(trade.timestamp)}
                    {trade.pnl != null ? ` · PnL ${formatPnL(trade.pnl)}` : ""}
                  </span>
                </div>
              ))}
              {recentTrades.length === 0 ? (
                <div className="text-xs-tight text-muted">No recent trades</div>
              ) : null}
            </div>
          ) : null}

          {showChat ? (
            <div className="flex flex-col gap-2">
              <StatLine
                label="Conversations"
                value={
                  teamConversations.length > 0
                    ? teamConversations
                        .slice(0, 3)
                        .map((conversation) => conversation.name || "Untitled")
                        .join(" · ")
                    : "No team conversations"
                }
                subtitle={
                  teamConversations.length > 0
                    ? `${teamConversations.filter((conversation) => conversation.isActive).length} active`
                    : undefined
                }
              />
              <StatLine
                label="Operator channel"
                value={run.session?.canSendCommands ? "Ready" : "Reconnecting"}
                subtitle={formatDetailTimestamp(
                  run.lastHeartbeatAt ?? run.updatedAt,
                )}
              />
              {recentChatMessages.map((message) => (
                <div key={message.id}>
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
            </div>
          ) : null}

          {showChat ? (
            <div className="flex flex-col gap-2">
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
              <StatLine
                label="Autonomy"
                value={agentStatus?.autonomous ? "Active" : "Paused"}
                subtitle={
                  agentStatus
                    ? `${agentStatus.autonomousTrading ? "Trading" : "Trading paused"} · ${agentStatus.autonomousPosting ? "Posting" : "Posting paused"}`
                    : undefined
                }
              />
              <StatLine
                label="Wallet"
                value={wallet ? formatCurrency(wallet.balance) : "No wallet"}
                subtitle={
                  wallet
                    ? `${wallet.transactions.length} transactions · trading ${formatCurrency(tradingBalance)}`
                    : undefined
                }
              />
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
            </div>
          ) : null}

          {statusMessage ? (
            <div className="px-1 py-2 text-xs-tight leading-5 text-muted-strong">
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
