/**
 * FeedSpatialView - the Feed prediction-market operator dashboard authored with
 * the spatial vocabulary and mounted in `<SpatialSurface>` for the GUI surface.
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives plus type-only views of
 * the Feed API shapes (no browser/runtime import).
 */

import type {
  FeedActivityItem,
  FeedAgentGoal,
  FeedAgentStatus,
  FeedChatMessage,
  FeedPredictionMarket,
  FeedWallet,
} from "@elizaos/ui/api";
import {
  Button,
  Card,
  HStack,
  List,
  type SpatialTone,
  Text,
  VStack,
} from "@elizaos/ui/spatial";

/** Portfolio summary derived from the Feed `/agent/summary` envelope. */
export interface FeedPortfolioSnapshot {
  totalAssets: number;
  totalPnL: number;
  positions: number;
  available: number;
  wallet: number;
  agents: number;
  totalPoints: number;
}

/** Team coordination totals from the Feed team dashboard summary. */
export interface FeedTeamTotalsSnapshot {
  walletBalance: number;
  lifetimePnL: number;
  unrealizedPnL: number;
  currentPnL: number;
  openPositions: number;
}

export interface FeedTeamSnapshot {
  ownerName?: string;
  agentCount: number;
  totals: FeedTeamTotalsSnapshot | null;
}

export interface FeedConversationSnapshot {
  id: string;
  name: string;
  isActive: boolean;
}

/** Single source of truth for the Feed operator surface across all modalities. */
export interface FeedSnapshot {
  /**
   * Whether a live Feed session/run is attached. When false the surface renders
   * the waiting state (no dashboard data, autonomy controls disabled) instead of
   * the operator dashboard.
   */
  hasSession: boolean;
  agentStatus: FeedAgentStatus | null;
  portfolio: FeedPortfolioSnapshot | null;
  goal: FeedAgentGoal | null;
  recentTrades: FeedActivityItem[];
  predictionMarkets: FeedPredictionMarket[];
  team: FeedTeamSnapshot;
  conversations: FeedConversationSnapshot[];
  chatMessages: FeedChatMessage[];
  wallet: FeedWallet | null;
  tradingBalance: number;
  /** "pause" if autonomy is active and can be paused, else "resume". */
  controlAction: "pause" | "resume";
  suggestedPrompts: string[];
  statusMessage?: string | null;
  loading?: boolean;
  sending?: boolean;
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatPnL(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}$${value.toFixed(2)}`;
}

function pnlTone(value: number): SpatialTone {
  if (value > 0) return "success";
  if (value < 0) return "danger";
  return "muted";
}

function tradeSide(trade: FeedActivityItem): string {
  return (trade.side ?? trade.action ?? trade.type).toUpperCase();
}

function tradeLabel(trade: FeedActivityItem): string {
  if (trade.summary) return trade.summary;
  const ticker = trade.ticker ?? trade.marketId ?? "market";
  const amount = trade.amount != null ? formatCurrency(trade.amount) : "";
  return [tradeSide(trade), ticker, amount]
    .filter((p) => p.length > 0)
    .join(" ");
}

export interface FeedSpatialViewProps {
  snapshot: FeedSnapshot;
  /** Dispatch by agent id: `toggle-autonomy`, `refresh`, `prompt:<index>`. */
  onAction?: (action: string) => void;
}

export function FeedSpatialView({ snapshot, onAction }: FeedSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);
  const {
    hasSession,
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
  } = snapshot;

  if (!hasSession) {
    return (
      <Card gap={1} padding={1}>
        <Text bold>Ready to trade?</Text>
        <Text style="caption" tone="muted">
          Spawn a Feed agent to watch prediction markets and trade autonomously.
        </Text>
        <Button grow={1} agent="spawn-agent" onPress={dispatch("spawn")}>
          Spawn agent
        </Button>
        {statusMessage ? (
          <Text style="caption" tone="muted" wrap={false}>
            {statusMessage}
          </Text>
        ) : null}
      </Card>
    );
  }

  const autonomyActive = controlAction === "pause";
  const displayName =
    agentStatus?.displayName ?? agentStatus?.name ?? "Waiting";
  const recentChat = chatMessages.slice(-2);

  return (
    <Card gap={1} padding={1}>
      <HStack gap={1} align="center">
        <Text
          style="caption"
          tone={autonomyActive ? "success" : "warning"}
          grow={1}
        >
          {autonomyActive ? "autonomous" : "operator-led"}
        </Text>
        <Text style="caption" tone="muted">
          {loading ? "refreshing" : (agentStatus?.agentStatus ?? "idle")}
        </Text>
      </HStack>

      <Text bold wrap={false}>
        {displayName}
      </Text>
      {agentStatus ? (
        <HStack gap={1} align="center">
          <Text
            style="caption"
            tone={pnlTone(agentStatus.lifetimePnL)}
            grow={1}
          >
            {`${formatPnL(agentStatus.lifetimePnL)} lifetime`}
          </Text>
          <Text style="caption" tone="muted">
            {`win ${(agentStatus.winRate * 100).toFixed(0)}%`}
          </Text>
        </HStack>
      ) : null}
      {agentStatus ? (
        <Text style="caption" tone="muted" wrap={false}>
          {`${agentStatus.totalTrades} trades · rep ${agentStatus.reputationScore}`}
        </Text>
      ) : null}

      {portfolio ? (
        <VStack gap={0}>
          <HStack gap={1} align="center">
            <Text grow={1}>{formatCurrency(portfolio.totalAssets)} assets</Text>
            <Text tone={pnlTone(portfolio.totalPnL)}>
              {formatPnL(portfolio.totalPnL)}
            </Text>
          </HStack>
          <Text style="caption" tone="muted">
            {`${portfolio.positions} positions · ${formatCurrency(portfolio.available)} available · ${portfolio.totalPoints} pts`}
          </Text>
        </VStack>
      ) : (
        <Text tone="muted" style="caption">
          No open positions yet
        </Text>
      )}

      {goal ? (
        <VStack gap={0}>
          <Text style="caption" tone="primary" wrap={false}>
            {goal.description}
          </Text>
          <Text style="caption" tone="muted">
            {goal.progress != null
              ? `${goal.status} · ${goal.progress.toFixed(0)}%`
              : goal.status}
          </Text>
        </VStack>
      ) : null}

      {predictionMarkets.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          No live markets
        </Text>
      ) : (
        <List gap={0}>
          {predictionMarkets.slice(0, 3).map((market) => (
            <HStack key={market.id} gap={1} align="center">
              <Text grow={1} wrap={false}>
                {market.title}
              </Text>
              <Text style="caption" tone="success">
                {market.yesPrice.toFixed(2)}
              </Text>
              <Text style="caption" tone="danger">
                {market.noPrice.toFixed(2)}
              </Text>
            </HStack>
          ))}
        </List>
      )}

      {recentTrades.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          No recent trades
        </Text>
      ) : (
        <List gap={0}>
          {recentTrades.slice(0, 4).map((trade) => (
            <HStack
              key={trade.id}
              gap={1}
              align="center"
              agent={`trade-${trade.id}`}
            >
              <Text grow={1} wrap={false}>
                {tradeLabel(trade)}
              </Text>
              {trade.pnl != null ? (
                <Text style="caption" tone={pnlTone(trade.pnl)}>
                  {formatPnL(trade.pnl)}
                </Text>
              ) : null}
            </HStack>
          ))}
        </List>
      )}

      <HStack gap={1} align="center">
        <Text grow={1} wrap={false}>
          {team.ownerName ?? `${team.agentCount} agents`}
        </Text>
        {team.totals ? (
          <Text style="caption" tone={pnlTone(team.totals.currentPnL)}>
            {formatPnL(team.totals.currentPnL)} now
          </Text>
        ) : null}
      </HStack>
      {team.totals ? (
        <Text style="caption" tone="muted">
          {`${formatCurrency(team.totals.walletBalance)} wallet · ${team.totals.openPositions} open · ${formatPnL(team.totals.unrealizedPnL)} unreal`}
        </Text>
      ) : null}
      {conversations.length > 0 ? (
        <Text style="caption" tone="muted" wrap={false}>
          {`${conversations.filter((c) => c.isActive).length} active · ${conversations
            .slice(0, 3)
            .map((c) => c.name || "Untitled")
            .join(", ")}`}
        </Text>
      ) : null}

      {recentChat.length > 0 ? (
        <List gap={0}>
          {recentChat.map((message) => (
            <VStack key={message.id} gap={0}>
              <Text style="caption" tone="muted" wrap={false}>
                {message.senderName ?? message.senderId}
              </Text>
              <Text style="caption" wrap={false}>
                {message.content}
              </Text>
            </VStack>
          ))}
        </List>
      ) : null}

      <HStack gap={1} align="center">
        <Text grow={1}>
          {wallet ? formatCurrency(wallet.balance) : "No wallet"}
        </Text>
        <Text style="caption" tone="muted">
          {`trading ${formatCurrency(tradingBalance)}`}
        </Text>
      </HStack>

      {suggestedPrompts.length > 0 ? (
        <HStack gap={1} wrap>
          {suggestedPrompts.slice(0, 2).map((prompt, index) => (
            <Button
              key={prompt}
              variant="outline"
              tone="default"
              grow={1}
              disabled={sending}
              agent={`prompt-${index}`}
              onPress={dispatch(`prompt:${index}`)}
            >
              {prompt}
            </Button>
          ))}
        </HStack>
      ) : null}
      <HStack gap={1} wrap>
        <Button
          grow={1}
          tone={autonomyActive ? "danger" : "success"}
          agent="toggle-autonomy"
          onPress={dispatch("toggle-autonomy")}
        >
          {autonomyActive ? "Pause" : "Resume"}
        </Button>
        <Button
          variant="outline"
          tone="default"
          agent="refresh"
          onPress={dispatch("refresh")}
        >
          Refresh
        </Button>
      </HStack>

      {statusMessage ? (
        <Text style="caption" tone="muted" wrap={false}>
          {statusMessage}
        </Text>
      ) : null}
    </Card>
  );
}
