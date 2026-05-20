'use client';

import { cn, formatCompactCurrency } from '@feed/shared';
import { ExternalLink, MoreVertical, Settings, Square } from 'lucide-react';
import Link from 'next/link';
import { Avatar } from '@/components/shared/Avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** Agent info for member list */
export interface TeamChatAgent {
  id: string;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  isAgent: boolean;
  modelTier: 'free' | 'pro';
  virtualBalance: number;
}

/** Agent stats from /api/agents */
export interface AgentStats {
  lifetimePnL: number;
  totalTrades: number;
  profitableTrades: number;
  winRate: number;
  lastTickAt: string | null;
  lastChatAt: string | null;
  isActive: boolean;
  status: string;
  openPositions: number;
}

/** Team chat info for member list */
interface TeamChatInfo {
  agents: TeamChatAgent[];
  agentCount: number;
}

interface MemberListProps {
  teamChat: TeamChatInfo | null | undefined;
  onClose?: () => void;
  processingAgentIds?: Set<string>;
  onTagAgent?: (agent: TeamChatAgent) => void;
  onStopAgent?: (agentId: string) => void;
  onViewSettings?: (agentId: string) => void;
  onSelectAgent?: (agentId: string) => void;
  selectedAgentId?: string | null;
  viewMode?: 'list' | 'cards';
  agentStatsMap?: ReadonlyMap<string, AgentStats>;
}

function formatTimeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function MemberList({
  teamChat,
  onClose,
  processingAgentIds = new Set(),
  onTagAgent,
  onStopAgent,
  onViewSettings,
  onSelectAgent,
  selectedAgentId,
  viewMode = 'list',
  agentStatsMap,
}: MemberListProps) {
  if (!teamChat?.agents.length) return null;

  if (viewMode === 'cards') {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <div className="space-y-3">
          {teamChat.agents.map((agent) => {
            const agentName = agent.displayName || agent.username || 'Agent';
            const isSelected = selectedAgentId === agent.id;
            const isProcessing = processingAgentIds.has(agent.id);
            const stats = agentStatsMap?.get(agent.id);
            const hasStats = stats !== undefined;

            // Determine last active time (most recent of lastTickAt or lastChatAt)
            const lastActive =
              stats?.lastTickAt && stats?.lastChatAt
                ? new Date(stats.lastTickAt) > new Date(stats.lastChatAt)
                  ? stats.lastTickAt
                  : stats.lastChatAt
                : stats?.lastTickAt || stats?.lastChatAt || null;

            return (
              <div
                key={agent.id}
                role="button"
                tabIndex={0}
                onClick={() => {
                  onTagAgent?.(agent);
                  onSelectAgent?.(agent.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onTagAgent?.(agent);
                    onSelectAgent?.(agent.id);
                  }
                }}
                className={cn(
                  'w-full cursor-pointer rounded-xl border p-3 text-left transition-all',
                  isSelected
                    ? 'border-primary/40 bg-primary/5'
                    : 'border-border bg-muted/30 hover:border-border/80 hover:bg-muted/50'
                )}
              >
                {/* Top: Avatar + Name + Status + Gear */}
                <div className="mb-3 flex items-start gap-3">
                  <div className="relative shrink-0">
                    <Avatar
                      src={agent.profileImageUrl ?? undefined}
                      name={agentName}
                      size="md"
                    />
                    {isProcessing && (
                      <div className="absolute -top-0.5 -right-0.5 h-3 w-3 animate-pulse rounded-full bg-amber-500 ring-2 ring-background" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-semibold text-foreground text-sm">
                        {agentName}
                      </span>
                      {agent.username && (
                        <span className="truncate text-muted-foreground text-xs">
                          @{agent.username}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {hasStats && (
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-[10px]',
                            stats.isActive
                              ? 'bg-green-500/15 text-green-500'
                              : 'bg-muted text-muted-foreground'
                          )}
                        >
                          <span
                            className={cn(
                              'h-1.5 w-1.5 rounded-full',
                              stats.isActive
                                ? 'bg-green-500'
                                : 'bg-muted-foreground'
                            )}
                          />
                          {stats.isActive ? 'Active' : 'Idle'}
                        </span>
                      )}
                      {agent.modelTier === 'pro' && (
                        <span className="rounded bg-primary/20 px-1.5 py-0.5 font-medium text-[10px] text-primary">
                          PRO
                        </span>
                      )}
                      {hasStats && stats.openPositions > 0 && (
                        <span className="rounded bg-blue-500/15 px-1.5 py-0.5 font-medium text-[10px] text-blue-500">
                          {stats.openPositions} open
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onViewSettings?.(agent.id);
                    }}
                    className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label="Agent settings"
                  >
                    <Settings className="h-4 w-4" />
                  </button>
                </div>

                {/* Stats row */}
                <div className="mb-3 flex items-stretch rounded-lg border border-border/60 bg-background/50">
                  <div className="flex flex-1 flex-col items-center justify-center px-1 py-2">
                    <span className="font-semibold text-foreground text-xs">
                      {formatCompactCurrency(agent.virtualBalance)}
                    </span>
                    <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
                      Wallet
                    </span>
                  </div>
                  <div className="w-px bg-border/60" />
                  <div className="flex flex-1 flex-col items-center justify-center px-1 py-2">
                    <span
                      className={cn(
                        'font-semibold text-xs',
                        hasStats
                          ? stats.lifetimePnL >= 0
                            ? 'text-green-600'
                            : 'text-red-600'
                          : 'text-foreground'
                      )}
                    >
                      {hasStats
                        ? `${stats.lifetimePnL >= 0 ? '+' : ''}${formatCompactCurrency(stats.lifetimePnL)}`
                        : '—'}
                    </span>
                    <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
                      P&L
                    </span>
                  </div>
                  <div className="w-px bg-border/60" />
                  <div className="flex flex-1 flex-col items-center justify-center px-1 py-2">
                    <span className="font-semibold text-foreground text-xs">
                      {hasStats ? `${(stats.winRate * 100).toFixed(0)}%` : '—'}
                    </span>
                    <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
                      Win Rate
                    </span>
                  </div>
                  <div className="w-px bg-border/60" />
                  <div className="flex flex-1 flex-col items-center justify-center px-1 py-2">
                    <span className="font-semibold text-foreground text-xs">
                      {hasStats ? stats.totalTrades : '—'}
                    </span>
                    <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
                      Trades
                    </span>
                  </div>
                </div>

                {/* Bottom: Last active + actions */}
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    {hasStats && lastActive ? (
                      <>
                        <span
                          className={cn(
                            'h-1.5 w-1.5 rounded-full',
                            stats.isActive
                              ? 'bg-green-500'
                              : 'bg-muted-foreground'
                          )}
                        />
                        Last active {formatTimeAgo(lastActive)}
                      </>
                    ) : hasStats ? (
                      <>
                        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
                        No activity yet
                      </>
                    ) : (
                      <>
                        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
                        Loading...
                      </>
                    )}
                  </span>
                  {agent.username && (
                    <Link
                      href={`/profile/${agent.username}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                    >
                      View Profile
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // List view (default)
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <nav role="list" aria-label="Team agents" className="space-y-1">
        {teamChat.agents.map((agent) => {
          const isProcessing = processingAgentIds.has(agent.id);
          const agentName = agent.displayName || agent.username || 'Agent';

          return (
            <div
              key={agent.id}
              className={cn(
                'group flex min-w-0 items-center gap-2 rounded-lg p-2 transition-colors',
                'hover:bg-muted/50 has-[[data-state=open]]:bg-muted/50',
                isProcessing && 'opacity-70'
              )}
            >
              <button
                type="button"
                onClick={() => {
                  onTagAgent?.(agent);
                  onSelectAgent?.(agent.id);
                }}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-3 text-left',
                  'cursor-pointer'
                )}
                aria-label={`Open ${agentName}`}
              >
                <div className="relative">
                  <Avatar
                    src={agent.profileImageUrl ?? undefined}
                    name={agentName}
                    size="sm"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate font-medium text-foreground text-sm">
                      {agentName}
                    </p>
                    {agent.modelTier === 'pro' && (
                      <span className="shrink-0 rounded bg-primary/20 px-1.5 py-0.5 font-medium text-[10px] text-primary">
                        PRO
                      </span>
                    )}
                  </div>
                  {agent.username && (
                    <p className="truncate text-muted-foreground text-xs">
                      @{agent.username}
                    </p>
                  )}
                </div>
              </button>

              {isProcessing ? (
                <button
                  type="button"
                  className="relative flex h-7 w-7 flex-shrink-0 items-center justify-center rounded transition-colors hover:bg-primary/10"
                  onClick={() => onStopAgent?.(agent.id)}
                  aria-label={`Stop ${agentName}`}
                >
                  <div className="absolute inset-0.5 animate-spin rounded-full border-2 border-transparent border-t-primary" />
                  <Square className="relative h-3 w-3 fill-primary text-primary" />
                </button>
              ) : (
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded transition-colors',
                        'text-muted-foreground hover:bg-muted hover:text-foreground',
                        'focus:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 lg:opacity-0'
                      )}
                      aria-label={`More options for ${agentName}`}
                    >
                      <MoreVertical className="h-4 w-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {agent.username && (
                      <DropdownMenuItem asChild>
                        <Link
                          href={`/profile/${agent.username}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <ExternalLink className="mr-2 h-4 w-4" />
                          <span>View Profile</span>
                        </Link>
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      onClick={() => {
                        onViewSettings?.(agent.id);
                        onClose?.();
                      }}
                    >
                      <Settings className="mr-2 h-4 w-4" />
                      <span>Settings</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          );
        })}
      </nav>
    </div>
  );
}
