import { Button, Input, useIntervalWhenDocumentVisible } from "@elizaos/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client } from "../../api";
import type {
  BabylonActivityItem,
  BabylonAgentGoal,
  BabylonAgentStatus,
  BabylonChatMessage,
  BabylonLogEntry,
  BabylonPredictionMarket,
  BabylonTeamAgent,
  BabylonWallet,
} from "../../api/client-types-babylon";
import { useBabylonSSE } from "../../hooks/useBabylonSSE";
import { useTranslation } from "../../state/TranslationContext";
import { formatTime } from "../../utils/format";
import {
  type BabylonAgentSummaryEnvelope,
  type BabylonTeamConversation,
  type BabylonTeamDashboard,
  type BabylonTeamSummary,
  extractAgentSummary,
  extractChatMessages,
  extractTeamConversations,
  extractTeamDashboard,
  extractTradingBalance,
  summarizeBabylonActivity,
} from "./babylon-data";

type TabId = "overview" | "activity" | "team" | "wallet" | "logs";

type ActivityRow = BabylonActivityItem;

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "activity", label: "Activity" },
  { id: "team", label: "Team" },
  { id: "wallet", label: "Wallet" },
  { id: "logs", label: "Logs" },
];

const ACTIVITY_ICON: Record<string, string> = {
  trade: "\u{1F4C8}",
  post: "\u{1F4AC}",
  comment: "\u{1F4DD}",
  message: "\u{2709}\u{FE0F}",
  social: "\u{1F465}",
};

const LOG_TYPE_OPTIONS = [
  { value: "", label: "All" },
  { value: "trade", label: "Trade" },
  { value: "chat", label: "Chat" },
  { value: "post", label: "Post" },
  { value: "error", label: "Error" },
  { value: "system", label: "System" },
];

const LOG_LEVEL_OPTIONS = [
  { value: "", label: "All" },
  { value: "error", label: "Error" },
  { value: "warn", label: "Warn" },
  { value: "info", label: "Info" },
];

function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatPnL(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}$${value.toFixed(2)}`;
}

function StatTile({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "positive" | "negative";
}) {
  const toneClass =
    tone === "positive"
      ? "text-ok"
      : tone === "negative"
        ? "text-danger"
        : "text-txt";

  return (
    <div className="rounded-md border border-border bg-card/70 px-2 py-2">
      <div className="text-3xs uppercase tracking-[0.18em] text-muted">
        {label}
      </div>
      <div className={`mt-1 font-mono text-sm ${toneClass}`}>{value}</div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-border bg-card/60">
      <div className="px-3 py-2 text-2xs font-semibold uppercase tracking-[0.18em] text-muted">
        {title}
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}

function ActivityFeed({
  items,
  loading,
  emptyLabel,
}: {
  items: ActivityRow[];
  loading: boolean;
  emptyLabel: string;
}) {
  if (loading && items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs italic text-muted">
        Loading activity...
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs italic text-muted">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {items.map((item, index) => {
        const icon = ACTIVITY_ICON[item.type] ?? "\u{2022}";
        const key = item.id ?? `${item.timestamp}-${index}`;
        return (
          <div key={key} className="px-3 py-2 hover:bg-card/60">
            <div className="flex items-start gap-2">
              <span className="text-xs">{icon}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1 text-2xs">
                  <span className="text-muted">
                    {formatTime(new Date(item.timestamp).getTime(), {
                      fallback: "\u2014",
                    })}
                  </span>
                  <span className="uppercase text-muted">{item.type}</span>
                  {item.agent?.name ? (
                    <span className="truncate text-status-info">
                      @{item.agent.name}
                    </span>
                  ) : null}
                  {item.pnl != null ? (
                    <span
                      className={`font-mono ${
                        item.pnl >= 0 ? "text-ok" : "text-danger"
                      }`}
                    >
                      {formatPnL(item.pnl)}
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 break-words text-xs-tight text-txt">
                  {summarizeBabylonActivity(item)}
                </div>
                {item.reasoning ? (
                  <div className="mt-1 text-2xs italic text-muted">
                    {item.reasoning}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AgentStatusHeader({
  agent,
  liveConnected,
  onToggle,
}: {
  agent: BabylonAgentStatus | null;
  liveConnected: boolean;
  onToggle: () => void;
}) {
  if (!agent) {
    return (
      <div className="px-3 py-3">
        <div className="text-xs italic text-muted">
          Connecting to Babylon...
        </div>
      </div>
    );
  }

  const pnlTone =
    agent.lifetimePnL > 0
      ? "positive"
      : agent.lifetimePnL < 0
        ? "negative"
        : "default";

  return (
    <div className="space-y-2 px-3 py-3">
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 rounded-full ${
            liveConnected ? "bg-ok" : "bg-warn"
          }`}
          title={liveConnected ? "Live" : "Polling"}
        />
        <span className="truncate text-sm font-semibold text-txt">
          {agent.displayName ?? agent.name}
        </span>
        <span className="ml-auto text-2xs uppercase tracking-[0.18em] text-muted">
          {agent.agentStatus ?? "idle"}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-2">
        <StatTile label="Balance" value={formatCurrency(agent.balance)} />
        <StatTile
          label="PnL"
          value={formatPnL(agent.lifetimePnL)}
          tone={pnlTone}
        />
        <StatTile
          label="Win Rate"
          value={`${(agent.winRate * 100).toFixed(0)}%`}
        />
        <StatTile label="Trades" value={`${agent.totalTrades}`} />
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {[
          { label: "Trading", on: agent.autonomousTrading ?? agent.autonomous },
          { label: "Posting", on: agent.autonomousPosting ?? agent.autonomous },
          {
            label: "Comments",
            on: agent.autonomousCommenting ?? agent.autonomous,
          },
          { label: "DMs", on: agent.autonomousDMs ?? agent.autonomous },
        ].map((item) => (
          <span
            key={item.label}
            className={`rounded px-1.5 py-0.5 text-3xs ${
              item.on ? "bg-ok/15 text-ok" : "bg-muted/15 text-muted"
            }`}
          >
            {item.label}
          </span>
        ))}

        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-6 px-2 text-2xs"
          onClick={onToggle}
        >
          {agent.autonomous ? "Pause Agent" : "Resume Agent"}
        </Button>
      </div>
    </div>
  );
}

function TeamAgentsPanel({
  agents,
  summary,
  conversations,
  loading,
  onInsertMention,
}: {
  agents: BabylonTeamAgent[];
  summary: BabylonTeamSummary | null;
  conversations: BabylonTeamConversation[];
  loading: boolean;
  onInsertMention: (name: string) => void;
}) {
  if (loading && agents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs italic text-muted">
        Loading team...
      </div>
    );
  }

  return (
    <div className="grid flex-1 min-h-0 gap-3 overflow-y-auto p-3">
      <Section title="Team Totals">
        {summary?.totals ? (
          <div className="grid grid-cols-2 gap-2">
            <StatTile
              label="Wallet"
              value={formatCurrency(summary.totals.walletBalance)}
            />
            <StatTile
              label="Current PnL"
              value={formatPnL(summary.totals.currentPnL)}
              tone={
                summary.totals.currentPnL > 0
                  ? "positive"
                  : summary.totals.currentPnL < 0
                    ? "negative"
                    : "default"
              }
            />
            <StatTile
              label="Lifetime PnL"
              value={formatPnL(summary.totals.lifetimePnL)}
              tone={
                summary.totals.lifetimePnL > 0
                  ? "positive"
                  : summary.totals.lifetimePnL < 0
                    ? "negative"
                    : "default"
              }
            />
            <StatTile
              label="Open Positions"
              value={`${summary.totals.openPositions}`}
            />
          </div>
        ) : (
          <div className="text-xs italic text-muted">
            Team summary is not available yet.
          </div>
        )}
      </Section>

      <Section title="Team Coordination">
        {conversations.length === 0 ? (
          <div className="text-xs italic text-muted">
            No team conversations yet.
          </div>
        ) : (
          <div className="space-y-2">
            {conversations.slice(0, 6).map((conversation) => (
              <div
                key={conversation.id}
                className="rounded border border-border/60 px-2 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-xs-tight font-semibold text-txt">
                    {conversation.name || "Untitled conversation"}
                  </span>
                  {conversation.isActive ? (
                    <span className="rounded bg-status-info/15 px-1.5 py-0.5 text-3xs text-status-info">
                      Active
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 text-2xs text-muted">
                  Updated{" "}
                  {formatTime(new Date(conversation.updatedAt).getTime(), {
                    fallback: "\u2014",
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Agents">
        {agents.length === 0 ? (
          <div className="text-xs italic text-muted">No team agents found.</div>
        ) : (
          <div className="space-y-2">
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className="w-full rounded border border-border/60 px-2 py-2 text-left hover:bg-card/60"
                onClick={() => onInsertMention(agent.name)}
                title={`Mention ${agent.name}`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      agent.autonomous ? "bg-ok" : "bg-muted"
                    }`}
                  />
                  <span className="truncate text-xs-tight font-semibold text-txt">
                    {agent.displayName ?? agent.name}
                  </span>
                  <span className="ml-auto text-2xs text-muted">
                    {agent.totalTrades} trades
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-muted">
                  <span className="font-mono">
                    {formatCurrency(agent.balance)}
                  </span>
                  <span
                    className={
                      agent.lifetimePnL >= 0
                        ? "font-mono text-ok"
                        : "font-mono text-danger"
                    }
                  >
                    {formatPnL(agent.lifetimePnL)}
                  </span>
                  <span>{(agent.winRate * 100).toFixed(0)}% win</span>
                  <span>{agent.agentStatus ?? "idle"}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function WalletPanel({
  wallet,
  tradingBalance,
  summary,
  loading,
}: {
  wallet: BabylonWallet | null;
  tradingBalance: number;
  summary: BabylonAgentSummaryEnvelope | null;
  loading: boolean;
}) {
  if (loading && !wallet) {
    return (
      <div className="flex h-full items-center justify-center text-xs italic text-muted">
        Loading wallet...
      </div>
    );
  }

  return (
    <div className="grid flex-1 min-h-0 gap-3 overflow-y-auto p-3">
      <Section title="Balances">
        <div className="grid grid-cols-2 gap-2">
          <StatTile
            label="Wallet"
            value={formatCurrency(wallet?.balance ?? 0)}
          />
          <StatTile label="Trading" value={formatCurrency(tradingBalance)} />
          <StatTile
            label="Deposited"
            value={formatCurrency(summary?.agent?.totalDeposited ?? 0)}
          />
          <StatTile
            label="Withdrawn"
            value={formatCurrency(summary?.agent?.totalWithdrawn ?? 0)}
          />
        </div>
      </Section>

      <Section title="Transactions">
        {!wallet || wallet.transactions.length === 0 ? (
          <div className="text-xs italic text-muted">
            No transactions available.
          </div>
        ) : (
          <div className="space-y-2">
            {wallet.transactions.slice(0, 20).map((transaction) => (
              <div
                key={transaction.id}
                className="rounded border border-border/60 px-2 py-2"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`font-mono text-xs-tight ${
                      transaction.amount >= 0 ? "text-ok" : "text-danger"
                    }`}
                  >
                    {transaction.amount >= 0 ? "+" : ""}
                    {transaction.amount.toFixed(2)}
                  </span>
                  <span className="truncate text-xs-tight text-txt">
                    {transaction.type}
                  </span>
                  <span className="ml-auto text-2xs text-muted">
                    {formatTime(new Date(transaction.timestamp).getTime(), {
                      fallback: "\u2014",
                    })}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function LogsPanel({
  logs,
  loading,
  logType,
  logLevel,
  onTypeChange,
  onLevelChange,
}: {
  logs: BabylonLogEntry[];
  loading: boolean;
  logType: string;
  logLevel: string;
  onTypeChange: (next: string) => void;
  onLevelChange: (next: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-3 py-2">
        <select
          value={logType}
          onChange={(event) => onTypeChange(event.target.value)}
          className="h-7 rounded border border-border bg-bg px-2 text-xs-tight text-txt"
        >
          {LOG_TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          value={logLevel}
          onChange={(event) => onLevelChange(event.target.value)}
          className="h-7 rounded border border-border bg-bg px-2 text-xs-tight text-txt"
        >
          {LOG_LEVEL_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex-1 overflow-y-auto p-3 font-mono text-2xs">
        {loading && logs.length === 0 ? (
          <div className="text-center italic text-muted">Loading logs...</div>
        ) : logs.length === 0 ? (
          <div className="text-center italic text-muted">No logs found.</div>
        ) : (
          logs.slice(0, 120).map((entry, index) => (
            <div
              key={entry.id ?? `${entry.timestamp}-${index}`}
              className="py-1"
            >
              <span className="text-muted">
                {formatTime(new Date(entry.timestamp).getTime(), {
                  fallback: "\u2014",
                })}
              </span>{" "}
              <span
                className={`uppercase ${
                  entry.level === "error"
                    ? "text-danger"
                    : entry.level === "warn"
                      ? "text-warn"
                      : "text-muted"
                }`}
              >
                {entry.level}
              </span>{" "}
              <span className="text-status-info">[{entry.type}]</span>{" "}
              <span className="text-txt">{entry.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function OverviewPanel({
  summary,
  dashboard,
  goals,
  recentTrades,
  markets,
  chatMessages,
  loading,
}: {
  summary: BabylonAgentSummaryEnvelope | null;
  dashboard: BabylonTeamDashboard;
  goals: BabylonAgentGoal[];
  recentTrades: BabylonActivityItem[];
  markets: BabylonPredictionMarket[];
  chatMessages: BabylonChatMessage[];
  loading: boolean;
}) {
  const portfolio = summary?.portfolio;
  const currentGoal =
    goals.find((goal) => goal.status === "active") ?? goals[0];
  const totals = dashboard.summary?.totals;

  if (loading && !summary && goals.length === 0 && markets.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs italic text-muted">
        Loading Babylon dashboard...
      </div>
    );
  }

  return (
    <div className="grid flex-1 min-h-0 gap-3 overflow-y-auto p-3">
      <Section title="Current Focus">
        <div className="space-y-3">
          <div className="text-sm font-semibold text-txt">
            {currentGoal?.description ?? "No active goal is set right now."}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <StatTile
              label="Available"
              value={formatCurrency(portfolio?.available ?? 0)}
            />
            <StatTile
              label="Total Assets"
              value={formatCurrency(portfolio?.totalAssets ?? 0)}
            />
            <StatTile
              label="Open Positions"
              value={`${portfolio?.positions ?? 0}`}
            />
            <StatTile
              label="Portfolio PnL"
              value={formatPnL(portfolio?.totalPnL ?? 0)}
              tone={
                (portfolio?.totalPnL ?? 0) > 0
                  ? "positive"
                  : (portfolio?.totalPnL ?? 0) < 0
                    ? "negative"
                    : "default"
              }
            />
          </div>
        </div>
      </Section>

      <Section title="Team Snapshot">
        {totals ? (
          <div className="grid grid-cols-2 gap-2">
            <StatTile
              label="Wallet"
              value={formatCurrency(totals.walletBalance)}
            />
            <StatTile
              label="Live PnL"
              value={formatPnL(totals.currentPnL)}
              tone={
                totals.currentPnL > 0
                  ? "positive"
                  : totals.currentPnL < 0
                    ? "negative"
                    : "default"
              }
            />
            <StatTile
              label="Unrealized"
              value={formatPnL(totals.unrealizedPnL)}
              tone={
                totals.unrealizedPnL > 0
                  ? "positive"
                  : totals.unrealizedPnL < 0
                    ? "negative"
                    : "default"
              }
            />
            <StatTile
              label="Open Positions"
              value={`${totals.openPositions}`}
            />
          </div>
        ) : (
          <div className="text-xs italic text-muted">
            Team summary is not available yet.
          </div>
        )}
      </Section>

      <Section title="Current Market">
        {markets.length === 0 ? (
          <div className="text-xs italic text-muted">
            Market data is not available.
          </div>
        ) : (
          <div className="space-y-2">
            {markets.slice(0, 5).map((market) => (
              <div
                key={market.id}
                className="rounded border border-border/60 px-2 py-2"
              >
                <div className="line-clamp-2 text-xs-tight font-semibold text-txt">
                  {market.title}
                </div>
                <div className="mt-1 flex flex-wrap gap-2 text-2xs text-muted">
                  <span>YES {market.yesPrice.toFixed(2)}</span>
                  <span>NO {market.noPrice.toFixed(2)}</span>
                  <span>Vol {formatCurrency(market.volume)}</span>
                  <span>{market.status}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Recent Trades">
        {recentTrades.length === 0 ? (
          <div className="text-xs italic text-muted">No recent trades yet.</div>
        ) : (
          <div className="space-y-2">
            {recentTrades.slice(0, 6).map((trade) => (
              <div
                key={trade.id}
                className="rounded border border-border/60 px-2 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs-tight font-semibold text-txt">
                    {summarizeBabylonActivity(trade)}
                  </span>
                  {trade.pnl != null ? (
                    <span
                      className={`ml-auto font-mono text-2xs ${
                        trade.pnl >= 0 ? "text-ok" : "text-danger"
                      }`}
                    >
                      {formatPnL(trade.pnl)}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 text-2xs text-muted">
                  {formatTime(new Date(trade.timestamp).getTime(), {
                    fallback: "\u2014",
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Operator Chat">
        {chatMessages.length === 0 ? (
          <div className="text-xs italic text-muted">
            No agent chat history yet.
          </div>
        ) : (
          <div className="space-y-2">
            {chatMessages.slice(-6).map((message) => (
              <div
                key={message.id}
                className="rounded border border-border/60 px-2 py-2"
              >
                <div className="flex items-center gap-2 text-2xs text-muted">
                  <span className="uppercase">
                    {message.senderName ?? message.senderId}
                  </span>
                  <span className="ml-auto">
                    {formatTime(new Date(message.createdAt).getTime(), {
                      fallback: "\u2014",
                    })}
                  </span>
                </div>
                <div className="mt-1 whitespace-pre-wrap text-xs-tight text-txt">
                  {message.content}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

export interface BabylonTerminalProps {
  appName: string;
}

export function BabylonTerminal({ appName: _appName }: BabylonTerminalProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [agentStatus, setAgentStatus] = useState<BabylonAgentStatus | null>(
    null,
  );
  const [teamActivity, setTeamActivity] = useState<BabylonActivityItem[]>([]);
  const [teamAgents, setTeamAgents] = useState<BabylonTeamAgent[]>([]);
  const [teamDashboard, setTeamDashboard] = useState<BabylonTeamDashboard>({
    agents: [],
    summary: null,
  });
  const [teamConversations, setTeamConversations] = useState<
    BabylonTeamConversation[]
  >([]);
  const [agentSummary, setAgentSummary] =
    useState<BabylonAgentSummaryEnvelope | null>(null);
  const [agentGoals, setAgentGoals] = useState<BabylonAgentGoal[]>([]);
  const [recentTrades, setRecentTrades] = useState<BabylonActivityItem[]>([]);
  const [markets, setMarkets] = useState<BabylonPredictionMarket[]>([]);
  const [agentChatMessages, setAgentChatMessages] = useState<
    BabylonChatMessage[]
  >([]);
  const [wallet, setWallet] = useState<BabylonWallet | null>(null);
  const [tradingBalance, setTradingBalance] = useState(0);
  const [logs, setLogs] = useState<BabylonLogEntry[]>([]);
  const [logType, setLogType] = useState("");
  const [logLevel, setLogLevel] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [loadingActivity, setLoadingActivity] = useState(false);
  const [loadingTeam, setLoadingTeam] = useState(false);
  const [loadingWallet, setLoadingWallet] = useState(false);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [sending, setSending] = useState(false);
  const composerRef = useRef<HTMLInputElement>(null);

  const apiBase = useMemo(() => {
    const location = window.location;
    return `${location.protocol}//${location.host}`;
  }, []);
  const sse = useBabylonSSE(apiBase, true);

  const liveActivity = useMemo(() => {
    if (sse.items.length === 0) {
      return teamActivity;
    }

    const seenIds = new Set(
      sse.items
        .map((item) => item.id)
        .filter((id): id is string => typeof id === "string"),
    );
    const remainder = teamActivity.filter(
      (item) => !item.id || !seenIds.has(item.id),
    );
    return [...sse.items, ...remainder].slice(0, 100);
  }, [sse.items, teamActivity]);

  const fetchOverview = useCallback(async () => {
    setLoadingOverview(true);
    setStatusMessage(null);

    try {
      const [
        status,
        summary,
        goals,
        tradeFeed,
        predictionMarkets,
        dashboardRaw,
        conversationsRaw,
        chatRaw,
      ] = await Promise.all([
        client.getBabylonAgentStatus(),
        client.getBabylonAgentSummary(),
        client.getBabylonAgentGoals(),
        client.getBabylonAgentRecentTrades(),
        client.getBabylonPredictionMarkets({ pageSize: 5 }),
        client.getBabylonTeamDashboard(),
        client.getBabylonTeamConversations(),
        client.getBabylonAgentChat(),
      ]);

      setAgentStatus(status);
      setAgentSummary(extractAgentSummary(summary));
      setAgentGoals(goals);
      setRecentTrades(Array.isArray(tradeFeed.items) ? tradeFeed.items : []);
      setMarkets(
        Array.isArray(predictionMarkets.markets)
          ? predictionMarkets.markets
          : [],
      );

      const nextDashboard = extractTeamDashboard(dashboardRaw);
      setTeamDashboard(nextDashboard);
      setTeamAgents(nextDashboard.agents);
      setTeamConversations(
        extractTeamConversations(conversationsRaw).conversations,
      );
      setAgentChatMessages(extractChatMessages(chatRaw));
    } catch (error) {
      setStatusMessage(
        error instanceof Error
          ? error.message
          : "Failed to load Babylon overview.",
      );
    } finally {
      setLoadingOverview(false);
    }
  }, []);

  const fetchActivity = useCallback(async () => {
    setLoadingActivity(true);
    setStatusMessage(null);

    try {
      const feed = await client.getBabylonTrades();
      setTeamActivity(Array.isArray(feed.items) ? feed.items : []);
    } catch (error) {
      setStatusMessage(
        error instanceof Error
          ? error.message
          : "Failed to load Babylon activity.",
      );
    } finally {
      setLoadingActivity(false);
    }
  }, []);

  const fetchTeam = useCallback(async () => {
    setLoadingTeam(true);
    setStatusMessage(null);

    try {
      const [team, dashboardRaw, conversationsRaw] = await Promise.all([
        client.getBabylonTeam(),
        client.getBabylonTeamDashboard(),
        client.getBabylonTeamConversations(),
      ]);

      const nextDashboard = extractTeamDashboard(dashboardRaw);
      setTeamAgents(
        Array.isArray(team.agents) ? team.agents : nextDashboard.agents,
      );
      setTeamDashboard(nextDashboard);
      setTeamConversations(
        extractTeamConversations(conversationsRaw).conversations,
      );
    } catch (error) {
      setStatusMessage(
        error instanceof Error
          ? error.message
          : "Failed to load Babylon team data.",
      );
    } finally {
      setLoadingTeam(false);
    }
  }, []);

  const fetchWallet = useCallback(async () => {
    setLoadingWallet(true);
    setStatusMessage(null);

    try {
      const [walletResponse, tradingBalanceResponse] = await Promise.all([
        client.getBabylonAgentWallet(),
        client.getBabylonAgentTradingBalance(),
      ]);

      setWallet(walletResponse);
      setTradingBalance(extractTradingBalance(tradingBalanceResponse));
    } catch (error) {
      setStatusMessage(
        error instanceof Error
          ? error.message
          : "Failed to load Babylon wallet data.",
      );
    } finally {
      setLoadingWallet(false);
    }
  }, []);

  const fetchLogs = useCallback(async () => {
    setLoadingLogs(true);
    setStatusMessage(null);

    try {
      const entries = await client.getBabylonAgentLogs({
        type: logType || undefined,
        level: logLevel || undefined,
      });
      setLogs(Array.isArray(entries) ? entries : []);
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Failed to load Babylon logs.",
      );
    } finally {
      setLoadingLogs(false);
    }
  }, [logLevel, logType]);

  useEffect(() => {
    void Promise.all([fetchOverview(), fetchActivity()]);
  }, [fetchOverview, fetchActivity]);

  useEffect(() => {
    if (activeTab === "team") {
      void fetchTeam();
    }
    if (activeTab === "wallet") {
      void fetchWallet();
    }
    if (activeTab === "logs") {
      void fetchLogs();
    }
  }, [activeTab, fetchLogs, fetchTeam, fetchWallet]);

  useIntervalWhenDocumentVisible(
    () => {
      void fetchOverview();
      if (activeTab === "activity") {
        void fetchActivity();
      }
      if (activeTab === "team") {
        void fetchTeam();
      }
      if (activeTab === "wallet") {
        void fetchWallet();
      }
      if (activeTab === "logs") {
        void fetchLogs();
      }
    },
    8_000,
    true,
  );

  useEffect(() => {
    if (activeTab === "logs") {
      void fetchLogs();
    }
  }, [activeTab, fetchLogs]);

  const handleToggleAgent = useCallback(async () => {
    setStatusMessage(null);
    try {
      await client.toggleBabylonAgent(
        agentStatus?.autonomous ? "pause" : "resume",
      );
      await fetchOverview();
      await fetchActivity();
    } catch (error) {
      setStatusMessage(
        error instanceof Error
          ? error.message
          : "Failed to update agent autonomy.",
      );
    }
  }, [agentStatus?.autonomous, fetchActivity, fetchOverview]);

  const handleInsertMention = useCallback((name: string) => {
    setChatInput((current) =>
      current.trim().length > 0 ? `${current} @${name}` : `@${name} `,
    );
    composerRef.current?.focus();
  }, []);

  const handleSendChat = useCallback(async () => {
    const content = chatInput.trim();
    if (!content || sending) {
      return;
    }

    setSending(true);
    setStatusMessage(null);
    try {
      const result = await client.sendBabylonAgentChat(content);
      setChatInput("");
      setStatusMessage(result.message ?? "Suggestion sent to the agent.");
      await Promise.all([fetchOverview(), fetchActivity(), fetchLogs()]);
    } catch (error) {
      setStatusMessage(
        error instanceof Error
          ? error.message
          : "Failed to send the operator message.",
      );
    } finally {
      setSending(false);
    }
  }, [chatInput, fetchActivity, fetchLogs, fetchOverview, sending]);

  const content = (() => {
    switch (activeTab) {
      case "overview":
        return (
          <OverviewPanel
            summary={agentSummary}
            dashboard={teamDashboard}
            goals={agentGoals}
            recentTrades={recentTrades}
            markets={markets}
            chatMessages={agentChatMessages}
            loading={loadingOverview}
          />
        );
      case "activity":
        return (
          <ActivityFeed
            items={liveActivity}
            loading={loadingActivity}
            emptyLabel="No team activity yet."
          />
        );
      case "team":
        return (
          <TeamAgentsPanel
            agents={teamAgents}
            summary={teamDashboard.summary}
            conversations={teamConversations}
            loading={loadingTeam}
            onInsertMention={handleInsertMention}
          />
        );
      case "wallet":
        return (
          <WalletPanel
            wallet={wallet}
            tradingBalance={tradingBalance}
            summary={agentSummary}
            loading={loadingWallet}
          />
        );
      case "logs":
        return (
          <LogsPanel
            logs={logs}
            loading={loadingLogs}
            logType={logType}
            logLevel={logLevel}
            onTypeChange={setLogType}
            onLevelChange={setLogLevel}
          />
        );
      default:
        return null;
    }
  })();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <AgentStatusHeader
        agent={agentStatus}
        liveConnected={sse.connected}
        onToggle={handleToggleAgent}
      />

      <div className="flex items-center gap-1 px-2 py-2">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`rounded px-2 py-1 text-2xs uppercase tracking-[0.18em] ${
              activeTab === tab.id
                ? "bg-card text-txt"
                : "text-muted hover:bg-card/50"
            }`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {statusMessage ? (
        <div className="bg-card/70 px-3 py-2 text-xs-tight text-muted">
          {statusMessage}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">{content}</div>

      <div className="px-3 py-3">
        <div className="mb-2 text-2xs uppercase tracking-[0.18em] text-muted">
          Guide The Agent
        </div>
        <div className="flex items-center gap-2">
          <Input
            ref={composerRef}
            value={chatInput}
            onChange={(event) => setChatInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void handleSendChat();
              }
            }}
            placeholder={t("babylon.tellTheAgentWhatToDoWhatToAvoidOrWhatToExplain")}
            className="h-9 flex-1 text-xs"
          />
          <Button
            size="sm"
            className="h-9 px-3 text-xs-tight"
            onClick={() => void handleSendChat()}
            disabled={sending || chatInput.trim().length === 0}
          >
            {sending ? "Sending" : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}
