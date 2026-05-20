'use client';

import {
  formatCurrency,
  formatNumberWithSeparators,
  getProfileUrl,
  type LeaderboardMetric,
  type LeaderboardScope,
} from '@babylon/shared';
import { Bot, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { FollowButton } from '@/components/interactions/FollowButton';
import { OnChainBadge } from '@/components/profile/OnChainBadge';
import { OverviewTab } from '@/components/rewards/v2/overview-tab';
import { Avatar } from '@/components/shared/Avatar';
import { useAuth } from '@/hooks/useAuth';

export interface SelectedUser {
  id: string;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  reputationPoints: number;
  balance: number;
  lifetimePnL: number;
  capitalBase?: number;
  effectiveCapitalBase?: number;
  tradingReturn?: number;
  rank: number;
  isAgent?: boolean;
  managedBy?: string | null;
  nftTokenId?: number | null;
  teamReputationPoints?: number;
  userReputationPoints?: number;
  agentReputationPoints?: number;
  teamLifetimePnL?: number;
  teamCapitalBase?: number;
  teamEffectiveCapitalBase?: number;
  teamTradingReturn?: number;
  userLifetimePnL?: number;
  agentLifetimePnL?: number;
  agentCount?: number;
}

interface LeaderboardWidgetSidebarProps {
  selectedUser: SelectedUser | null;
  leaderboardMetric: LeaderboardMetric;
  leaderboardScope: LeaderboardScope;
}

export function LeaderboardWidgetSidebar({
  selectedUser,
  leaderboardMetric,
  leaderboardScope,
}: LeaderboardWidgetSidebarProps) {
  const { authenticated, user } = useAuth();
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const inner = innerRef.current;
    if (!container || !inner) return;

    if (window.innerWidth < 1280) return;

    let lastScrollTop = 0;
    let direction: 'up' | 'down' = 'down';
    let translateY = 0;
    let ticking = false;

    const updateSidebar = () => {
      const scrollTop = document.scrollingElement?.scrollTop || 0;
      const viewportHeight = window.innerHeight;
      const sidebarHeight = inner.offsetHeight;
      const containerTop = container.getBoundingClientRect().top;
      const topOffset = Math.max(0, containerTop);

      if (scrollTop > lastScrollTop) {
        direction = 'down';
      } else if (scrollTop < lastScrollTop) {
        direction = 'up';
      }
      lastScrollTop = scrollTop;

      const fitsInViewport = sidebarHeight <= viewportHeight - topOffset;

      if (fitsInViewport) {
        inner.style.position = 'fixed';
        inner.style.top = `${topOffset}px`;
        inner.style.transform = '';
      } else {
        const maxTranslate = sidebarHeight - (viewportHeight - topOffset);

        if (direction === 'down') {
          translateY = Math.min(scrollTop, maxTranslate);
        } else {
          translateY = Math.max(0, Math.min(scrollTop, maxTranslate));
        }

        inner.style.position = 'fixed';
        inner.style.top = `${topOffset}px`;
        inner.style.transform = `translateY(-${translateY}px)`;
      }

      ticking = false;
    };

    const handleScroll = () => {
      if (!ticking) {
        requestAnimationFrame(updateSidebar);
        ticking = true;
      }
    };

    const handleResize = () => {
      if (window.innerWidth < 1280) {
        if (inner) {
          inner.style.position = '';
          inner.style.top = '';
          inner.style.transform = '';
        }
        return;
      }
      updateSidebar();
    };

    updateSidebar();

    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleResize, { passive: true });

    return () => {
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  const isTeamView = leaderboardScope === 'team';
  const isTradingView = leaderboardMetric === 'trading';
  const formatLeaderboardValue = (value: number) =>
    formatNumberWithSeparators(value);
  const formatLeaderboardPnL = (value: number) =>
    formatCurrency(value, { decimals: 0, useThousandsSeparator: true });
  const formatLeaderboardReturn = (value: number) => {
    const percent = value * 100;
    const formatted = `${Math.abs(percent).toFixed(1)}%`;
    if (percent > 0) return `+${formatted}`;
    if (percent < 0) return `-${formatted}`;
    return '0.0%';
  };
  const formatSignedLeaderboardPnL = (value: number) =>
    value > 0 ? `+${formatLeaderboardPnL(value)}` : formatLeaderboardPnL(value);

  const metricLabel =
    leaderboardMetric === 'trading'
      ? isTeamView
        ? 'Team Trading Return'
        : 'Trading Return'
      : isTeamView
        ? 'Team Reputation'
        : 'Reputation';

  const metricValue =
    leaderboardMetric === 'trading'
      ? isTeamView
        ? (selectedUser?.teamTradingReturn ?? selectedUser?.tradingReturn ?? 0)
        : (selectedUser?.tradingReturn ?? 0)
      : isTeamView
        ? (selectedUser?.teamReputationPoints ??
          selectedUser?.reputationPoints ??
          0)
        : (selectedUser?.reputationPoints ?? 0);

  const capitalBase = isTradingView
    ? isTeamView
      ? (selectedUser?.teamCapitalBase ?? selectedUser?.capitalBase ?? 0)
      : (selectedUser?.capitalBase ?? 0)
    : 0;

  const effectiveCapitalBase = isTradingView
    ? isTeamView
      ? (selectedUser?.teamEffectiveCapitalBase ??
        selectedUser?.effectiveCapitalBase ??
        0)
      : (selectedUser?.effectiveCapitalBase ?? 0)
    : 0;

  const primaryLifetimePnL = isTradingView
    ? isTeamView
      ? (selectedUser?.teamLifetimePnL ?? selectedUser?.lifetimePnL ?? 0)
      : (selectedUser?.lifetimePnL ?? 0)
    : 0;

  return (
    <div ref={containerRef} className="hidden w-96 shrink-0 flex-col xl:flex">
      <div ref={innerRef} className="mr-28 flex flex-col gap-6 px-4 py-6">
        {/* Rewards + Challenges */}
        <OverviewTab
          onViewAchievements={() => router.push('/rewards?tab=achievements')}
          onViewChallenges={() => router.push('/rewards?tab=challenges')}
        />

        {/* Selected User Detail */}
        {selectedUser && (
          <div className="space-y-4 border-border border-t pt-6">
            <div className="flex items-center gap-3">
              <Avatar
                id={selectedUser.id}
                name={
                  selectedUser.displayName || selectedUser.username || 'User'
                }
                size="md"
                src={selectedUser.profileImageUrl || undefined}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h4 className="truncate font-semibold text-foreground">
                    {selectedUser.displayName ||
                      selectedUser.username ||
                      'Anonymous'}
                  </h4>
                  {selectedUser.isAgent ? (
                    <span className="flex items-center gap-0.5 rounded bg-blue-500/10 px-1.5 py-0.5 text-blue-500 text-xs">
                      <Bot className="h-3 w-3" />
                      AI
                    </span>
                  ) : (
                    <OnChainBadge
                      isRegistered={Boolean(selectedUser.nftTokenId)}
                      nftTokenId={selectedUser.nftTokenId ?? null}
                      size="sm"
                    />
                  )}
                </div>
                {selectedUser.username && (
                  <p className="truncate text-muted-foreground text-sm">
                    @{selectedUser.username}
                  </p>
                )}
              </div>
              {authenticated && user && selectedUser.id !== user.id && (
                <FollowButton
                  userId={selectedUser.id}
                  size="sm"
                  variant="button"
                  className="w-20"
                />
              )}
            </div>

            <div className="border-border border-b pb-3">
              <div className="text-muted-foreground text-xs">{metricLabel}</div>
              <div
                className={`font-bold text-xl ${
                  isTradingView
                    ? metricValue === 0
                      ? 'text-foreground'
                      : metricValue > 0
                        ? 'text-green-500'
                        : 'text-red-500'
                    : 'text-foreground'
                }`}
              >
                {isTradingView
                  ? formatLeaderboardReturn(metricValue)
                  : formatLeaderboardValue(metricValue)}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-muted-foreground text-xs">
                  {isTeamView && isTradingView
                    ? 'Team Lifetime P&L'
                    : 'Lifetime P&L'}
                </div>
                <div
                  className={`font-bold ${
                    primaryLifetimePnL === 0
                      ? 'text-muted-foreground'
                      : primaryLifetimePnL > 0
                        ? 'text-green-500'
                        : 'text-red-500'
                  }`}
                >
                  {primaryLifetimePnL === 0
                    ? formatLeaderboardPnL(0)
                    : `${primaryLifetimePnL > 0 ? '+' : '-'}${formatLeaderboardPnL(Math.abs(primaryLifetimePnL))}`}
                </div>
              </div>

              <div>
                <div className="text-muted-foreground text-xs">
                  {isTradingView ? 'Capital Base' : 'Trading Balance'}
                </div>
                <div className="font-bold text-foreground">
                  {isTradingView
                    ? formatLeaderboardValue(capitalBase)
                    : formatLeaderboardValue(selectedUser.balance)}
                </div>
              </div>

              {isTradingView && (
                <div>
                  <div className="text-muted-foreground text-xs">
                    Effective Capital
                  </div>
                  <div className="font-bold text-foreground">
                    {formatLeaderboardValue(effectiveCapitalBase)}
                  </div>
                </div>
              )}

              {isTradingView && (
                <div>
                  <div className="text-muted-foreground text-xs">
                    Trading Balance
                  </div>
                  <div className="font-bold text-foreground">
                    {formatLeaderboardValue(selectedUser.balance)}
                  </div>
                </div>
              )}

              {isTeamView &&
                selectedUser.agentCount !== undefined &&
                selectedUser.agentCount > 0 && (
                  <div className="col-span-2 border-border border-t pt-3">
                    <div className="mb-2 text-muted-foreground text-xs">
                      Team Breakdown
                    </div>
                    <div className="space-y-1 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">
                          {isTradingView
                            ? 'User Lifetime P&L'
                            : 'User Reputation'}
                        </span>
                        <span
                          className={`font-semibold ${
                            isTradingView &&
                            (selectedUser.userLifetimePnL ?? 0) !== 0
                              ? (selectedUser.userLifetimePnL ?? 0) > 0
                                ? 'text-green-500'
                                : 'text-red-500'
                              : 'text-foreground'
                          }`}
                        >
                          {isTradingView
                            ? formatSignedLeaderboardPnL(
                                selectedUser.userLifetimePnL ?? 0
                              )
                            : formatLeaderboardValue(
                                selectedUser.userReputationPoints ?? 0
                              )}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">
                          {isTradingView
                            ? 'Agent Lifetime P&L'
                            : 'Agent Reputation'}{' '}
                          ({selectedUser.agentCount}{' '}
                          {selectedUser.agentCount === 1 ? 'agent' : 'agents'})
                        </span>
                        <span
                          className={`font-semibold ${
                            isTradingView &&
                            (selectedUser.agentLifetimePnL ?? 0) !== 0
                              ? (selectedUser.agentLifetimePnL ?? 0) > 0
                                ? 'text-green-500'
                                : 'text-red-500'
                              : 'text-foreground'
                          }`}
                        >
                          {isTradingView
                            ? formatSignedLeaderboardPnL(
                                selectedUser.agentLifetimePnL ?? 0
                              )
                            : formatLeaderboardValue(
                                selectedUser.agentReputationPoints ?? 0
                              )}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
            </div>

            <div className="flex flex-col gap-2">
              <Link
                href={getProfileUrl(selectedUser.id, selectedUser.username)}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
              >
                View Profile
                <ExternalLink className="h-4 w-4" />
              </Link>
            </div>
          </div>
        )}

        <div>
          <h3 className="mb-3 font-semibold text-foreground">
            How Ranking Works
          </h3>
          <div className="space-y-2 text-muted-foreground text-sm">
            <p>
              <span className="font-semibold text-foreground">Reputation:</span>{' '}
              Your progression score for trust, rewards, and the general
              leaderboard
            </p>
            <p>
              <span className="font-semibold text-foreground">Trading:</span>{' '}
              Ranked by realized return: lifetime P&amp;L divided by `
              max(capitalBase, 1000) `
            </p>
            {isTeamView && (
              <p>
                <span className="font-semibold text-foreground">
                  {isTradingView ? 'Team Trading:' : 'Team Reputation:'}
                </span>{' '}
                {isTradingView
                  ? 'Combined team lifetime P&L over external capital injected into the team, without double counting owner-agent transfers'
                  : "Your reputation combined with all your AI agents' reputation"}
              </p>
            )}
            {isTradingView && effectiveCapitalBase > capitalBase && (
              <p>
                <span className="font-semibold text-foreground">
                  Capital floor:
                </span>{' '}
                Rankings use at least 1,000 of capital base to avoid inflated
                returns on tiny balances.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
