'use client';

export const dynamic = 'force-dynamic';

import {
  formatCurrency,
  formatNumberWithSeparators,
  getProfileUrl,
  type LeaderboardMetric,
  type LeaderboardScope,
} from '@babylon/shared';
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Trophy,
} from 'lucide-react';
import nextDynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { LeaderboardUser } from '@/app/leaderboard/fetchLeaderboardData';
import {
  useLeaderboardQuery,
  useMyLeaderboardPosition,
  usePrefetchNextPage,
} from '@/app/leaderboard/useLeaderboardQuery';
import { FollowButton } from '@/components/interactions/FollowButton';
import type { SelectedUser } from '@/components/leaderboard/LeaderboardWidgetSidebar';
import { OnChainBadge } from '@/components/profile/OnChainBadge';
import { Avatar } from '@/components/shared/Avatar';
import { LeaderboardToggle } from '@/components/shared/LeaderboardToggle';
import { PageContainer } from '@/components/shared/PageContainer';
import { RankNumber } from '@/components/shared/RankBadge';
import { LeaderboardSkeleton } from '@/components/shared/Skeleton';
import { useAuth } from '@/hooks/useAuth';

const LeaderboardWidgetSidebar = nextDynamic(
  () =>
    import('@/components/leaderboard/LeaderboardWidgetSidebar').then((m) => ({
      default: m.LeaderboardWidgetSidebar,
    })),
  {
    ssr: false,
    loading: () => <div className="hidden w-96 flex-none xl:block" />,
  }
);

export default function LeaderboardPage() {
  const { authenticated, getAccessToken, user } = useAuth();
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedMetric, setSelectedMetric] =
    useState<LeaderboardMetric>('reputation');
  const [selectedScope, setSelectedScope] =
    useState<LeaderboardScope>('wallet');
  const [selectedUser, setSelectedUser] = useState<SelectedUser | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const scrollToUserRef = useRef(false);

  const pageSize = 100;
  const authenticatedUserId = authenticated ? user?.id : undefined;

  // Resolve auth token when authentication state changes
  useEffect(() => {
    let cancelled = false;

    if (authenticated) {
      getAccessToken()
        .then((token) => {
          if (!cancelled) {
            setAuthToken(token);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setAuthToken(null);
          }
        });
    } else {
      setAuthToken(null);
    }

    return () => {
      cancelled = true;
    };
  }, [authenticated, getAccessToken]);

  // WI-L1: React Query for client-side cached leaderboard pages.
  // Returns stale data instantly on back-navigation, revalidates in background.
  const {
    data: leaderboardData,
    isLoading,
    isFetching,
    error: queryError,
  } = useLeaderboardQuery({
    metric: selectedMetric,
    page: currentPage,
    pageSize,
    scope: selectedScope,
    userId: authenticatedUserId,
    authToken,
  });

  // WI-L3: Separate user position query — cached across page/tab changes.
  // "Jump to My Position" reads from this, so it's instant.
  const { data: myPosition } = useMyLeaderboardPosition({
    metric: selectedMetric,
    scope: selectedScope,
    pageSize,
    userId: authenticatedUserId,
    authToken,
  });

  // WI-L2: Prefetch next page in background for instant pagination
  usePrefetchNextPage({
    currentPage,
    totalPages: leaderboardData?.pagination.totalPages,
    metric: selectedMetric,
    pageSize,
    scope: selectedScope,
    userId: authenticatedUserId,
    authToken,
  });

  // Use position from the dedicated query, falling back to the one bundled in page data
  const currentUserPosition =
    myPosition ?? leaderboardData?.currentUser ?? null;

  // isLoading = true only on first load (no cached data). isFetching = true during any fetch.
  const loading = isLoading;
  const error =
    queryError && !leaderboardData ? 'Failed to fetch leaderboard' : null;

  useEffect(() => {
    if (scrollToUserRef.current && !loading) {
      scrollToUserRef.current = false;
      setTimeout(() => {
        document
          .querySelector('[data-current-user="true"]')
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }
  }, [loading]);

  const resetLeaderboardView = () => {
    setCurrentPage(1);
    setSelectedUser(null);
  };

  const handleMetricChange = (metric: LeaderboardMetric) => {
    if (metric === selectedMetric) return;
    setSelectedMetric(metric);
    resetLeaderboardView();
  };

  const handleScopeChange = (scope: LeaderboardScope) => {
    if (scope === selectedScope) return;
    setSelectedScope(scope);
    resetLeaderboardView();
  };

  const handlePreviousPage = () => {
    if (currentPage > 1) {
      setCurrentPage(currentPage - 1);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const handleNextPage = () => {
    if (
      leaderboardData &&
      currentPage < leaderboardData.pagination.totalPages
    ) {
      setCurrentPage(currentPage + 1);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const handleJumpToPosition = () => {
    if (currentUserPosition) {
      setCurrentPage(currentUserPosition.page);
      scrollToUserRef.current = true;
    }
  };

  const handleUserClick = (player: LeaderboardUser) => {
    setSelectedUser({
      id: player.id,
      username: player.username,
      displayName: player.displayName,
      profileImageUrl: player.profileImageUrl,
      reputationPoints: player.reputationPoints,
      balance: player.balance,
      lifetimePnL: player.lifetimePnL,
      capitalBase: player.capitalBase,
      effectiveCapitalBase: player.effectiveCapitalBase,
      tradingReturn: player.tradingReturn,
      rank: player.rank,
      isAgent: player.isAgent,
      managedBy: player.managedBy,
      nftTokenId: player.nftTokenId,
      teamReputationPoints: player.teamReputationPoints,
      userReputationPoints: player.userReputationPoints,
      agentReputationPoints: player.agentReputationPoints,
      teamLifetimePnL: player.teamLifetimePnL,
      teamCapitalBase: player.teamCapitalBase,
      teamEffectiveCapitalBase: player.teamEffectiveCapitalBase,
      teamTradingReturn: player.teamTradingReturn,
      userLifetimePnL: player.userLifetimePnL,
      agentLifetimePnL: player.agentLifetimePnL,
      agentCount: player.agentCount,
    });
  };

  const isTeamView = selectedScope === 'team';
  const currentUserRowId =
    authenticated && user
      ? isTeamView && currentUserPosition
        ? currentUserPosition.entry.id
        : user.id
      : null;
  const isCurrentUserOnPage = currentUserRowId
    ? leaderboardData?.leaderboard.some((p) => p.id === currentUserRowId)
    : false;
  const followedUserIds = new Set(leaderboardData?.followingUserIds ?? []);

  const leaderboardDescriptions: Record<
    LeaderboardMetric,
    Record<LeaderboardScope, string>
  > = {
    reputation: {
      wallet: 'Individual wallets ranked by reputation',
      team: 'Users + their AI agents combined, ranked by team reputation',
    },
    trading: {
      wallet:
        'Individual wallets ranked by realized trading return: lifetime P&L divided by capital base',
      team: 'Teams ranked by combined realized return, with owner-agent transfers excluded from team capital base',
    },
  };

  const formatRelativeTime = (iso: string): string => {
    const seconds = Math.max(
      0,
      Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    );
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  };

  const formatTradingPnL = (value: number): string => {
    if (value > 0) {
      return `+${formatCurrency(value, {
        decimals: 0,
        useThousandsSeparator: true,
      })}`;
    }
    return formatCurrency(value, { decimals: 0, useThousandsSeparator: true });
  };

  const formatTradingReturn = (value: number): string => {
    const percent = value * 100;
    const formatted = `${Math.abs(percent).toFixed(1)}%`;
    if (percent > 0) return `+${formatted}`;
    if (percent < 0) return `-${formatted}`;
    return '0.0%';
  };

  const getTradingReturn = (player: LeaderboardUser): number =>
    isTeamView
      ? (player.teamTradingReturn ?? player.tradingReturn ?? 0)
      : (player.tradingReturn ?? 0);

  const getTradingLifetimePnL = (player: LeaderboardUser): number =>
    isTeamView
      ? (player.teamLifetimePnL ?? player.lifetimePnL)
      : player.lifetimePnL;

  const getDisplayValue = (player: LeaderboardUser): number => {
    if (selectedMetric === 'trading') {
      return getTradingReturn(player);
    }

    if (isTeamView && player.teamReputationPoints !== undefined) {
      return player.teamReputationPoints;
    }

    return player.reputationPoints;
  };

  const formatDisplayValue = (value: number): string => {
    if (selectedMetric === 'trading') {
      return formatTradingReturn(value);
    }
    return formatNumberWithSeparators(value);
  };

  const getDisplayLabel = (): string => {
    if (selectedMetric === 'trading') {
      return isTeamView ? 'Team Trading Return' : 'Trading Return';
    }
    return isTeamView ? 'Team Reputation' : 'Reputation';
  };

  const renderPlayerRow = (
    player: LeaderboardUser,
    variant: 'desktop' | 'mobile' | 'pinned'
  ) => {
    const isCurrentUser = currentUserRowId
      ? player.id === currentUserRowId
      : false;
    const displayValue = getDisplayValue(player);
    const formattedValue = formatDisplayValue(displayValue ?? 0);
    const secondaryTradingPnL =
      selectedMetric === 'trading'
        ? formatTradingPnL(getTradingLifetimePnL(player))
        : null;
    const isPinned = variant === 'pinned';

    const content = (
      <div
        className={`flex items-center ${variant === 'mobile' ? 'gap-2 sm:gap-4' : 'gap-4'}`}
      >
        <div className="shrink-0">
          <RankNumber rank={player.rank} size="md" />
        </div>
        <div className="relative shrink-0">
          <Avatar
            id={player.id}
            name={player.displayName || player.username || 'User'}
            size="md"
            src={player.profileImageUrl || undefined}
          />
          {authenticated && !isCurrentUser && !isPinned && (
            <div
              className={`absolute -right-1 -bottom-0.5 ${variant === 'mobile' ? '' : ''}`}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <FollowButton
                userId={player.id}
                variant="circle"
                initialFollowing={
                  leaderboardData?.followingUserIdsResolved
                    ? followedUserIds.has(player.id)
                    : undefined
                }
              />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3
              className={`truncate font-semibold text-foreground ${variant === 'mobile' ? 'text-sm sm:text-base' : ''}`}
            >
              {player.displayName || player.username || 'Anonymous'}
            </h3>
            {player.isAgent ? (
              <span className="flex shrink-0 items-center gap-0.5 rounded bg-blue-500/10 px-1.5 py-0.5 text-blue-500 text-xs">
                <Bot className="h-3 w-3" />
                AI
              </span>
            ) : (
              <OnChainBadge
                isRegistered={Boolean(player.nftTokenId)}
                nftTokenId={player.nftTokenId ?? null}
                size="sm"
              />
            )}
            {(isCurrentUser || isPinned) && (
              <span className="shrink-0 rounded bg-foreground px-2 py-0.5 font-semibold text-background text-xs">
                YOU
              </span>
            )}
          </div>
          {variant !== 'mobile' && player.username && (
            <p className="truncate text-muted-foreground text-sm">
              @{player.username}
            </p>
          )}
          {variant === 'mobile' && (
            <div className="space-y-0.5 text-xs sm:text-sm">
              <div className="flex items-center gap-2">
                <span className="font-bold text-foreground">
                  {formattedValue} {getDisplayLabel()}
                </span>
                {isTeamView &&
                  player.agentCount !== undefined &&
                  player.agentCount > 0 && (
                    <span className="text-muted-foreground">
                      {player.agentCount}{' '}
                      {player.agentCount === 1 ? 'agent' : 'agents'}
                    </span>
                  )}
              </div>
              {secondaryTradingPnL && (
                <div className="text-muted-foreground text-xs">
                  Lifetime P&amp;L {secondaryTradingPnL}
                </div>
              )}
            </div>
          )}
        </div>
        {variant !== 'mobile' && (
          <div className="shrink-0 text-right">
            <div className="font-bold text-foreground text-lg">
              {formattedValue}
            </div>
            {selectedMetric === 'trading' ? (
              <div className="space-y-0.5 text-right">
                <div className="text-muted-foreground text-xs">
                  {getDisplayLabel()}
                  {isTeamView &&
                    player.agentCount !== undefined &&
                    player.agentCount > 0 &&
                    ` (${player.agentCount} ${player.agentCount === 1 ? 'agent' : 'agents'})`}
                </div>
                <div className="text-muted-foreground text-xs">
                  Lifetime P&amp;L {secondaryTradingPnL}
                </div>
              </div>
            ) : (
              <div className="text-muted-foreground text-xs">
                {getDisplayLabel()}
                {isTeamView &&
                  player.agentCount !== undefined &&
                  player.agentCount > 0 &&
                  ` (${player.agentCount} ${player.agentCount === 1 ? 'agent' : 'agents'})`}
              </div>
            )}
          </div>
        )}
      </div>
    );

    return content;
  };

  const renderEmptyState = () => {
    if (!leaderboardData) return null;
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="text-center text-muted-foreground">
          <Trophy className="mx-auto mb-4 h-16 w-16 opacity-50" />
          <p className="mb-2 font-semibold text-foreground text-lg">
            No Results Yet
          </p>
          <p className="text-sm">
            {selectedMetric === 'trading'
              ? isTeamView
                ? 'No teams have realized trading return yet. Start trading to appear here!'
                : 'No wallets have realized trading return yet. Start trading to appear here!'
              : isTeamView
                ? 'No teams have reputation yet. Start playing to appear here!'
                : 'No wallets have reputation yet. Start playing to appear here!'}
          </p>
        </div>
      </div>
    );
  };

  const renderLeaderboardContent = () => {
    if (loading) {
      return (
        <div className="flex-1 overflow-y-auto p-4">
          <LeaderboardSkeleton count={15} />
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="text-center">
            <p className="mb-2 font-semibold text-foreground text-lg">
              Failed to load leaderboard
            </p>
            <p className="text-muted-foreground text-sm">{error}</p>
          </div>
        </div>
      );
    }

    if (!leaderboardData || leaderboardData.leaderboard.length === 0) {
      return renderEmptyState();
    }

    return (
      <div className="flex-1 overflow-y-auto">
        <div className="space-y-0">
          {leaderboardData.leaderboard.map((player) => {
            const isCurrentUser = currentUserRowId
              ? player.id === currentUserRowId
              : false;
            const isPlayerSelected = selectedUser?.id === player.id;

            return (
              <div key={player.id} className="flex items-stretch">
                {/* Desktop: clickable for sidebar widget */}
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={`View profile for ${player.displayName || player.username || 'Anonymous'}`}
                  onClick={(e) => {
                    e.preventDefault();
                    handleUserClick(player);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleUserClick(player);
                    }
                  }}
                  data-current-user={isCurrentUser ? 'true' : undefined}
                  className={`hidden flex-1 cursor-pointer px-4 py-3 text-left transition-colors xl:block ${
                    isPlayerSelected
                      ? 'border-l-4 border-l-foreground bg-muted/30'
                      : isCurrentUser
                        ? 'border-l-4 border-l-foreground bg-muted/20 hover:bg-muted/30'
                        : 'border-l-4 border-l-transparent hover:bg-muted/30'
                  }`}
                >
                  {renderPlayerRow(player, 'desktop')}
                </div>

                {/* Mobile/Tablet: direct link to profile */}
                <Link
                  href={getProfileUrl(player.id, player.username) || '#'}
                  data-current-user={isCurrentUser ? 'true' : undefined}
                  className={`block flex-1 px-4 py-1.5 transition-colors xl:hidden ${
                    isCurrentUser
                      ? 'border-l-4 border-l-foreground bg-muted/20'
                      : 'hover:bg-muted/30'
                  }`}
                >
                  {renderPlayerRow(player, 'mobile')}
                </Link>
              </div>
            );
          })}
        </div>

        {/* Pinned current user row (when not on current page) */}
        {authenticated && currentUserPosition && !isCurrentUserOnPage && (
          <div className="sticky bottom-14 border-border border-t bg-muted/40 px-4 py-3 backdrop-blur-sm">
            <div className="mb-1 text-muted-foreground text-xs">
              Your position
            </div>
            {renderPlayerRow(currentUserPosition.entry, 'pinned')}
          </div>
        )}

        {/* Pagination */}
        {leaderboardData.pagination.totalPages > 1 && (
          <div className="sticky bottom-0 bg-background/95 px-4 py-3 backdrop-blur-sm">
            <div className="flex items-center justify-between">
              <button
                onClick={handlePreviousPage}
                disabled={currentPage === 1}
                className="flex items-center gap-3 rounded-lg bg-sidebar-accent px-4 py-3 text-foreground transition-colors hover:bg-sidebar-accent/80 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ChevronLeft className="h-4 w-4" />
                Previous
              </button>

              <div className="text-muted-foreground text-sm">
                Page {currentPage} of {leaderboardData.pagination.totalPages}
              </div>

              <button
                onClick={handleNextPage}
                disabled={currentPage === leaderboardData.pagination.totalPages}
                className="flex items-center gap-3 rounded-lg bg-sidebar-accent px-4 py-3 text-foreground transition-colors hover:bg-sidebar-accent/80 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <PageContainer noPadding className="overflow-visible! flex w-full flex-col">
      {/* Desktop: Content + Widgets layout */}
      <div className="hidden flex-1 overflow-hidden xl:flex">
        {/* Main content */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-border lg:border-r lg:border-l">
          {/* Header with tabs */}
          <div className="sticky top-0 z-10 shrink-0 bg-background shadow-sm">
            <LeaderboardToggle
              activeMetric={selectedMetric}
              activeScope={selectedScope}
              onMetricChange={handleMetricChange}
              onScopeChange={handleScopeChange}
            />
            <div className="flex items-center justify-between px-3 py-3 sm:px-4 lg:px-6">
              <div className="flex items-center gap-2">
                <p className="text-muted-foreground text-sm">
                  {leaderboardDescriptions[selectedMetric][selectedScope]}
                </p>
                {isFetching && !isLoading && (
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary/60" />
                )}
                {leaderboardData?.generatedAt && !isFetching && (
                  <span className="text-muted-foreground/60 text-xs">
                    {formatRelativeTime(leaderboardData.generatedAt)}
                  </span>
                )}
              </div>
              {authenticated && currentUserPosition && (
                <button
                  onClick={handleJumpToPosition}
                  className="flex shrink-0 items-center gap-1.5 rounded-md bg-primary/10 px-3 py-1.5 font-medium text-primary text-sm transition-colors hover:bg-primary/20"
                >
                  <Crosshair className="h-3.5 w-3.5" />#
                  {currentUserPosition.rank.toLocaleString()}
                </button>
              )}
            </div>
          </div>

          {renderLeaderboardContent()}
        </div>

        {/* Widget Sidebar */}
        <LeaderboardWidgetSidebar
          selectedUser={selectedUser}
          leaderboardMetric={selectedMetric}
          leaderboardScope={selectedScope}
        />
      </div>

      {/* Mobile/Tablet: Full width content */}
      <div className="flex flex-1 flex-col overflow-hidden xl:hidden">
        {/* Header with tabs */}
        <div className="sticky top-0 z-10 shrink-0 bg-background shadow-sm">
          <LeaderboardToggle
            activeMetric={selectedMetric}
            activeScope={selectedScope}
            onMetricChange={handleMetricChange}
            onScopeChange={handleScopeChange}
          />
          <div className="flex items-center justify-between px-3 py-2 sm:px-4">
            <div className="flex items-center gap-1.5">
              <p className="text-muted-foreground text-xs sm:text-sm">
                {leaderboardDescriptions[selectedMetric][selectedScope]}
              </p>
              {isFetching && !isLoading && (
                <span className="h-1 w-1 animate-pulse rounded-full bg-primary/60" />
              )}
              {leaderboardData?.generatedAt && !isFetching && (
                <span className="text-muted-foreground/60 text-xs">
                  {formatRelativeTime(leaderboardData.generatedAt)}
                </span>
              )}
            </div>
            {authenticated && currentUserPosition && (
              <button
                onClick={handleJumpToPosition}
                className="flex shrink-0 items-center gap-1 rounded-md bg-primary/10 px-2.5 py-1 font-medium text-primary text-xs transition-colors hover:bg-primary/20"
              >
                <Crosshair className="h-3 w-3" />#
                {currentUserPosition.rank.toLocaleString()}
              </button>
            )}
          </div>
        </div>

        {renderLeaderboardContent()}
      </div>
    </PageContainer>
  );
}
