'use client';

import { getProfileUrl, POINTS } from '@feed/shared';
import { ArrowRight, Award, TrendingUp, UserPlus, Users } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Avatar } from '@/components/shared/Avatar';
import { Skeleton } from '@/components/shared/Skeleton';
import { getAuthToken } from '@/lib/auth';
import { apiUrl } from '@/utils/api-url';

/**
 * Referred user structure for rewards widget.
 */
interface ReferredUser {
  id: string;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  createdAt: Date | string;
  reputationPoints: number;
  isFollowing: boolean;
  joinedAt: Date | string | null;
}

/**
 * Referral statistics structure.
 */
interface ReferralStats {
  totalReferrals: number;
  totalReputationEarned: number;
  pointsPerReferral: number;
  followingCount: number;
  weeklyReferralCount?: number;
  weeklyLimit?: number;
}

/**
 * Referral widget data structure from API.
 */
interface ReferralWidgetData {
  user: {
    id: string;
    username: string | null;
    displayName: string | null;
    profileImageUrl: string | null;
    referralCode: string | null;
    reputationPoints: number;
  };
  stats: ReferralStats;
  referredUsers: ReferredUser[];
  referralUrl: string | null;
}

/**
 * Rewards widget component for displaying referral program information.
 *
 * Displays referral statistics, referred users list, and referral code
 * sharing functionality. Shows total referrals, points earned, and
 * allows copying referral link. Auto-refreshes every 60 seconds.
 *
 * Features:
 * - Referral statistics display
 * - Referred users list
 * - Referral code sharing
 * - Copy referral link
 * - Auto-refresh (60s interval)
 * - Loading states
 * - Empty state handling
 *
 * @param props - RewardsWidget component props
 * @returns Rewards widget element
 *
 * @example
 * ```tsx
 * <RewardsWidget userId="user-123" />
 * ```
 */
interface RewardsWidgetProps {
  userId: string;
}

/**
 * Global fetch tracking to prevent duplicate calls.
 */
let rewardsWidgetFetchInFlight = false;
let rewardsWidgetIntervalId: ReturnType<typeof setInterval> | null = null;

export function RewardsWidget({ userId }: RewardsWidgetProps) {
  const [data, setData] = useState<ReferralWidgetData | null>(null);
  const [loading, setLoading] = useState(true);
  const lastFetchedUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!userId) return;

    // Don't refetch if userId hasn't changed
    if (lastFetchedUserIdRef.current === userId) {
      return;
    }

    const fetchData = async () => {
      if (!userId) return;

      // Prevent duplicate fetches globally
      if (rewardsWidgetFetchInFlight) return;
      rewardsWidgetFetchInFlight = true;

      setLoading(true);

      const token = getAuthToken();
      if (!token) {
        setLoading(false);
        rewardsWidgetFetchInFlight = false;
        return;
      }

      const response = await fetch(
        apiUrl(`/api/users/${encodeURIComponent(userId)}/referrals`),
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (!response.ok) {
        setLoading(false);
        rewardsWidgetFetchInFlight = false;
        throw new Error('Failed to fetch referral data');
      }

      const result = await response.json();
      setData(result);
      setLoading(false);
      lastFetchedUserIdRef.current = userId;
      rewardsWidgetFetchInFlight = false;
    };

    // Clear any existing interval
    if (rewardsWidgetIntervalId) {
      clearInterval(rewardsWidgetIntervalId);
      rewardsWidgetIntervalId = null;
    }

    fetchData();

    // Refresh every 30 seconds
    rewardsWidgetIntervalId = setInterval(fetchData, 30000);

    return () => {
      if (rewardsWidgetIntervalId) {
        clearInterval(rewardsWidgetIntervalId);
        rewardsWidgetIntervalId = null;
      }
    };
  }, [userId]);

  if (loading) {
    return (
      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-sidebar-accent/30 p-4">
        <div className="flex items-center gap-2">
          <Award className="h-5 w-5 text-[#0066FF]" />
          <h3 className="font-semibold text-foreground">Rewards</h3>
        </div>
        <div className="flex items-center justify-center py-8">
          <div className="w-full space-y-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-sidebar-accent/30 p-4">
        <div className="flex items-center gap-2">
          <Award className="h-5 w-5 text-[#0066FF]" />
          <h3 className="font-semibold text-foreground">Rewards</h3>
        </div>
        <p className="text-muted-foreground text-sm">
          Unable to load rewards data
        </p>
      </div>
    );
  }

  // Get recent referrals (last 5)
  const recentReferrals = data.referredUsers.slice(0, 5);

  return (
    <div className="flex flex-col gap-4">
      {/* Stats Summary */}
      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-sidebar-accent/30 p-4">
        <div className="flex items-center gap-2">
          <Award className="h-5 w-5 text-[#0066FF]" />
          <h3 className="font-semibold text-foreground">Rewards</h3>
        </div>

        {/* Total Referrals */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground text-sm">Total</span>
            </div>
            <span className="font-bold text-foreground text-lg">
              {data.stats.totalReferrals}
            </span>
          </div>
          {data.stats.weeklyReferralCount !== undefined &&
            data.stats.weeklyLimit !== undefined && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">This Week</span>
                <span
                  className={`font-semibold ${
                    data.stats.weeklyReferralCount >= data.stats.weeklyLimit
                      ? 'text-red-500'
                      : data.stats.weeklyReferralCount >=
                          data.stats.weeklyLimit * 0.8
                        ? 'text-yellow-500'
                        : 'text-foreground'
                  }`}
                >
                  {data.stats.weeklyReferralCount}/{data.stats.weeklyLimit}
                </span>
              </div>
            )}
        </div>

        {/* Reputation Earned */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-yellow-500" />
            <span className="text-muted-foreground text-sm">
              Reputation Earned
            </span>
          </div>
          <span className="font-bold text-lg text-yellow-500">
            {data.stats.totalReputationEarned.toLocaleString()}
          </span>
        </div>

        {/* Following */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-[#0066FF]" />
            <span className="text-muted-foreground text-sm">Following</span>
          </div>
          <span className="font-bold text-[#0066FF] text-lg">
            {data.stats.followingCount}
          </span>
        </div>
      </div>

      {/* Recent Referrals */}
      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-sidebar-accent/30 p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-foreground text-sm">
            Recent Referrals
          </h3>
          {data.stats.totalReferrals > 5 && (
            <Link
              href="/rewards"
              className="flex items-center gap-1 text-[#0066FF] text-xs transition-colors hover:text-[#2952d9]"
            >
              View All
              <ArrowRight className="h-3 w-3" />
            </Link>
          )}
        </div>

        {recentReferrals.length === 0 ? (
          <div className="py-6 text-center">
            <Users className="mx-auto mb-2 h-8 w-8 text-muted-foreground opacity-50" />
            <p className="text-muted-foreground text-xs">No referrals yet</p>
            <p className="mt-1 text-muted-foreground text-xs">
              Share your referral link to start earning!
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {recentReferrals.map((referredUser) => (
              <Link
                key={referredUser.id}
                href={getProfileUrl(referredUser.id, referredUser.username)}
                className="group flex items-center gap-2 rounded-lg p-2 transition-colors hover:bg-sidebar-accent/50"
              >
                <Avatar
                  src={referredUser.profileImageUrl || undefined}
                  alt={
                    referredUser.displayName || referredUser.username || 'User'
                  }
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-foreground text-sm transition-colors group-hover:text-[#0066FF]">
                    {referredUser.displayName ||
                      referredUser.username ||
                      'Anonymous'}
                  </p>
                  {referredUser.username && (
                    <p className="truncate text-muted-foreground text-xs">
                      @{referredUser.username}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <span className="font-semibold text-xs text-yellow-500">
                    +{POINTS.REFERRAL_SIGNUP} rep
                  </span>
                  {referredUser.isFollowing && (
                    <UserPlus className="h-3 w-3 text-[#0066FF]" />
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
