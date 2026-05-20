'use client';

import { logger } from '@babylon/shared';
import {
  Calendar,
  FileText,
  Heart,
  MessageSquare,
  TrendingUp,
  Trophy,
  User,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import Image from 'next/image';
import { useEffect, useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { apiUrl } from '@/utils/api-url';

interface UserProfile {
  id: string;
  username: string | null;
  displayName: string | null;
  bio: string | null;
  profileImageUrl: string | null;
  coverImageUrl: string | null;
  walletAddress: string | null;
  virtualBalance: number;
  lifetimePnL: number;
  reputationPoints: number;
  referralCount: number;
  invitePoints: number;
  createdAt: string;
  stats: {
    positions: number;
    comments: number;
    reactions: number;
    followers: number;
    following: number;
    posts: number;
  };
}

interface PlayerStatsModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string | null;
}

export function PlayerStatsModal({
  isOpen,
  onClose,
  userId,
}: PlayerStatsModalProps) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !userId) {
      setProfile(null);
      setError(null);
      return;
    }

    const fetchProfile = async () => {
      setLoading(true);
      setError(null);

      const response = await fetch(apiUrl(`/api/users/${userId}/profile`));

      if (!response.ok) {
        const errorMessage = 'Failed to fetch profile';
        setError(errorMessage);
        logger.error(
          'Failed to fetch user profile',
          { userId, status: response.status },
          'PlayerStatsModal'
        );
        setLoading(false);
        return;
      }

      const data = await response.json();

      if (!data.user) {
        const errorMessage = 'User not found';
        setError(errorMessage);
        logger.error(
          'User not found in profile response',
          { userId },
          'PlayerStatsModal'
        );
        setLoading(false);
        return;
      }

      setProfile(data.user);
      setLoading(false);
    };

    fetchProfile();
  }, [isOpen, userId]);

  if (!isOpen) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="mx-auto max-h-[90vh] w-full max-w-2xl overflow-y-auto p-0">
        <div className="p-4 sm:p-5">
          {/* Header with close button */}
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-bold text-lg sm:text-xl">Player Stats</h2>
            <button
              onClick={onClose}
              className="flex min-h-[36px] min-w-[36px] touch-manipulation items-center justify-center rounded-lg p-1.5 transition-colors hover:bg-background/50"
              aria-label="Close modal"
            >
              <X className="h-4 w-4 sm:h-5 sm:w-5" />
            </button>
          </div>

          {loading && (
            <div className="flex items-center justify-center py-8">
              <div className="h-6 w-6 animate-spin rounded-full border-primary border-b-2 sm:h-8 sm:w-8"></div>
            </div>
          )}

          {error && (
            <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
              <p className="mb-3 text-red-500 text-sm">{error}</p>
              <button
                onClick={onClose}
                className="min-h-[44px] touch-manipulation rounded-lg bg-primary px-4 py-2 font-semibold text-primary-foreground text-sm transition-colors hover:bg-primary/90"
              >
                Close
              </button>
            </div>
          )}

          {profile && !loading && !error && (
            <div className="space-y-4 sm:space-y-5">
              {/* Profile Header */}
              <div className="relative">
                {/* Cover Image */}
                {profile.coverImageUrl && (
                  <div className="relative mb-3 h-20 w-full overflow-hidden rounded-lg sm:h-28">
                    <Image
                      src={profile.coverImageUrl}
                      alt="Cover"
                      fill
                      className="rounded-lg object-cover"
                    />
                  </div>
                )}

                {/* Profile Info */}
                <div className="flex items-start gap-3">
                  {/* Profile Image */}
                  <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-full border-2 border-background sm:h-16 sm:w-16">
                    {profile.profileImageUrl ? (
                      <Image
                        src={profile.profileImageUrl}
                        alt={profile.displayName || profile.username || 'User'}
                        fill
                        className="object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-primary/20">
                        <User className="h-7 w-7 text-primary sm:h-8 sm:w-8" />
                      </div>
                    )}
                  </div>

                  {/* Name and Username */}
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-bold text-base sm:text-lg">
                      {profile.displayName || profile.username || 'Anonymous'}
                    </h3>
                    {profile.username && (
                      <p className="mt-0.5 text-muted-foreground text-xs sm:text-sm">
                        @{profile.username}
                      </p>
                    )}
                    {profile.bio && (
                      <p className="mt-1.5 line-clamp-2 whitespace-pre-wrap break-words text-xs">
                        {profile.bio}
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {/* Stats Grid */}
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3">
                {/* Reputation */}
                <div className="rounded-lg border border-[#0066FF]/30 bg-[#0066FF]/10 p-2.5 sm:p-3">
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <Trophy className="h-3.5 w-3.5 shrink-0 text-[#0066FF]" />
                    <span className="truncate text-[#0066FF] text-xs">
                      Reputation
                    </span>
                  </div>
                  <p className="break-words font-bold text-[#0066FF] text-lg sm:text-xl">
                    {profile.reputationPoints.toLocaleString()}
                  </p>
                </div>

                {/* Trading Balance */}
                <div className="rounded-lg border border-border bg-background/50 p-2.5 sm:p-3">
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <Wallet className="h-3.5 w-3.5 shrink-0 text-primary" />
                    <span className="truncate text-muted-foreground text-xs">
                      Trading Balance
                    </span>
                  </div>
                  <p className="break-words font-bold text-lg sm:text-xl">
                    ${profile.virtualBalance.toLocaleString()}
                  </p>
                </div>

                {/* Lifetime PnL */}
                <div className="rounded-lg border border-border bg-background/50 p-2.5 sm:p-3">
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <TrendingUp
                      className={`h-3.5 w-3.5 shrink-0 ${profile.lifetimePnL >= 0 ? 'text-green-500' : 'text-red-500'}`}
                    />
                    <span className="truncate text-muted-foreground text-xs">
                      Lifetime PnL
                    </span>
                  </div>
                  <p
                    className={`break-words font-bold text-lg sm:text-xl ${profile.lifetimePnL >= 0 ? 'text-green-500' : 'text-red-500'}`}
                  >
                    ${profile.lifetimePnL >= 0 ? '+' : ''}
                    {profile.lifetimePnL.toLocaleString()}
                  </p>
                </div>

                {/* Referral Count */}
                <div className="rounded-lg border border-border bg-background/50 p-2.5 sm:p-3">
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <Users className="h-3.5 w-3.5 shrink-0 text-primary" />
                    <span className="truncate text-muted-foreground text-xs">
                      Referrals
                    </span>
                  </div>
                  <p className="font-bold text-lg sm:text-xl">
                    {profile.referralCount}
                  </p>
                </div>

                {/* Referral Rewards */}
                <div className="rounded-lg border border-border bg-background/50 p-2.5 sm:p-3">
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <Trophy className="h-3.5 w-3.5 shrink-0 text-primary" />
                    <span className="truncate text-muted-foreground text-xs">
                      Referral Rewards
                    </span>
                  </div>
                  <p className="break-words font-bold text-lg sm:text-xl">
                    {profile.invitePoints.toLocaleString()}
                  </p>
                </div>

                {/* Positions */}
                <div className="rounded-lg border border-border bg-background/50 p-2.5 sm:p-3">
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <TrendingUp className="h-3.5 w-3.5 shrink-0 text-primary" />
                    <span className="truncate text-muted-foreground text-xs">
                      Positions
                    </span>
                  </div>
                  <p className="font-bold text-lg sm:text-xl">
                    {profile.stats.positions}
                  </p>
                </div>
              </div>

              {/* Activity Stats */}
              <div className="border-border border-t pt-4">
                <h4 className="mb-3 font-semibold text-sm sm:text-base">
                  Activity
                </h4>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3">
                  <div className="p-2 text-center">
                    <div className="mb-1 flex items-center justify-center gap-1">
                      <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                    <p className="font-bold text-lg sm:text-xl">
                      {profile.stats.posts}
                    </p>
                    <p className="mt-0.5 text-muted-foreground text-xs">
                      Posts
                    </p>
                  </div>
                  <div className="p-2 text-center">
                    <div className="mb-1 flex items-center justify-center gap-1">
                      <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                    <p className="font-bold text-lg sm:text-xl">
                      {profile.stats.comments}
                    </p>
                    <p className="mt-0.5 text-muted-foreground text-xs">
                      Comments
                    </p>
                  </div>
                  <div className="p-2 text-center">
                    <div className="mb-1 flex items-center justify-center gap-1">
                      <Heart className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                    <p className="font-bold text-lg sm:text-xl">
                      {profile.stats.reactions}
                    </p>
                    <p className="mt-0.5 text-muted-foreground text-xs">
                      Reactions
                    </p>
                  </div>
                  <div className="p-2 text-center">
                    <div className="mb-1 flex items-center justify-center gap-1">
                      <Users className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                    <p className="font-bold text-lg sm:text-xl">
                      {profile.stats.followers}
                    </p>
                    <p className="mt-0.5 text-muted-foreground text-xs">
                      Followers
                    </p>
                  </div>
                </div>
              </div>

              {/* Additional Info */}
              <div className="space-y-1.5 border-border border-t pt-4">
                <div className="flex items-start gap-2 text-muted-foreground text-xs">
                  <Calendar className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="break-words">
                    Joined{' '}
                    {new Date(profile.createdAt).toLocaleDateString('en-US', {
                      month: 'long',
                      year: 'numeric',
                      day: 'numeric',
                    })}
                  </span>
                </div>
                {profile.walletAddress && (
                  <div className="flex items-start gap-2 text-muted-foreground text-xs">
                    <Wallet className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="break-all font-mono">
                      {profile.walletAddress}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
