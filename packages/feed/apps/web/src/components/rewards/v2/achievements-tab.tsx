'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useSSEChannel } from '@/hooks/useSSE';
import { useAuthStore } from '@/stores/authStore';
import { AchievementCard } from './achievement-card';
import { useAnimatedCount } from './use-animated-count';

export interface AchievementFromApi {
  id: string;
  name: string;
  description: string;
  category: string;
  tier: 'bronze' | 'silver' | 'gold';
  pointsReward: number;
  threshold: number;
  progress: number;
  unlocked: boolean;
  unlockedAt: string | null;
}

export function mapTier(tier: string): 'Bronze' | 'Silver' | 'Gold' {
  if (tier === 'silver') return 'Silver';
  if (tier === 'gold') return 'Gold';
  return 'Bronze';
}

export function mapStatus(
  a: AchievementFromApi
): 'completed' | 'in-progress' | 'locked' {
  if (a.unlocked) return 'completed';
  if (a.progress > 0) return 'in-progress';
  return 'locked';
}

type TierFilter = 'All' | 'Bronze' | 'Silver' | 'Gold';

export function AchievementsTab() {
  const { authenticated, getAccessToken } = useAuth();
  const { user } = useAuthStore();
  const [achievements, setAchievements] = useState<AchievementFromApi[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<TierFilter>('All');

  const fetchAchievements = useCallback(async () => {
    if (!authenticated) {
      setLoading(false);
      return;
    }
    const token = await getAccessToken();
    if (!token) {
      setLoading(false);
      return;
    }
    const res = await fetch('/api/achievements', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const json = await res.json();
      setAchievements(json.achievements ?? []);
    }
    setLoading(false);
  }, [authenticated, getAccessToken]);

  useEffect(() => {
    fetchAchievements();
  }, [fetchAchievements]);

  const handleSSE = useCallback(
    (data: Record<string, unknown>) => {
      const type = data.type as string;
      if (type === 'achievement_unlocked') {
        fetchAchievements();
      }
    },
    [fetchAchievements]
  );

  const channel =
    authenticated && user?.id ? (`notifications:${user.id}` as const) : null;
  useSSEChannel(channel, handleSSE);

  const filters: TierFilter[] = ['All', 'Gold', 'Silver', 'Bronze'];

  const filteredAchievements =
    filter === 'All'
      ? achievements
      : achievements.filter((a) => mapTier(a.tier) === filter);

  const completed = filteredAchievements.filter(
    (a) => mapStatus(a) === 'completed'
  );
  const inProgress = filteredAchievements.filter(
    (a) => mapStatus(a) === 'in-progress'
  );
  const locked = filteredAchievements.filter((a) => mapStatus(a) === 'locked');

  const unlockedCount = achievements.filter((a) => a.unlocked).length;
  const totalCount = achievements.length;
  const pointsEarned = achievements
    .filter((a) => a.unlocked)
    .reduce((sum, a) => sum + a.pointsReward, 0);
  const progressPercent =
    totalCount > 0 ? (unlockedCount / totalCount) * 100 : 0;

  const animUnlocked = useAnimatedCount(unlockedCount);
  const animPoints = useAnimatedCount(pointsEarned);

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-16 animate-pulse bg-muted" />
        ))}
      </div>
    );
  }

  return (
    <div>
      {/* Hero Stats */}
      <div className="-mx-4 -mt-4 bg-gradient-to-br from-amber-500/10 via-amber-500/5 to-transparent p-5 pb-5 dark:from-amber-500/15 dark:via-amber-500/5">
        <div className="flex items-center gap-8">
          <div>
            <p className="text-[11px] text-muted-foreground">Unlocked</p>
            <p className="font-bold text-2xl text-amber-500 tabular-nums">
              {animUnlocked}
              <span className="text-base text-muted-foreground">
                /{totalCount}
              </span>
            </p>
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground">
              Reputation earned
            </p>
            <p className="font-bold text-2xl text-foreground tabular-nums">
              {animPoints}
            </p>
          </div>
        </div>

        {/* Overall progress */}
        <div className="mt-3 h-2 w-full bg-muted/60">
          <div
            className="h-full bg-gradient-to-r from-amber-500 to-yellow-400 transition-all duration-500"
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        <p className="mt-2 text-muted-foreground text-xs">
          {unlockedCount === totalCount
            ? 'All achievements unlocked — legendary! 🏆'
            : unlockedCount === 0
              ? 'Start playing to unlock achievements'
              : `${totalCount - unlockedCount} more to discover — keep exploring!`}
        </p>
      </div>

      {/* Filter Pills */}
      <div className="mt-4 flex gap-2">
        {filters.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-3.5 py-1.5 font-medium text-xs transition-all ${
              filter === f
                ? 'bg-amber-500 text-white'
                : 'bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Achievement List — grouped by status */}
      <div className="mt-4 space-y-5">
        {completed.length > 0 && (
          <div>
            <p className="mb-2 font-semibold text-emerald-500 text-xs uppercase tracking-wide">
              Unlocked ({completed.length})
            </p>
            <div className="space-y-2">
              {completed.map((a, i) => (
                <div
                  key={a.id}
                  className="animate-fadeIn"
                  style={{
                    animationDelay: `${i * 40}ms`,
                    animationFillMode: 'backwards',
                  }}
                >
                  <AchievementCard
                    title={a.name}
                    description={a.description}
                    badge={mapTier(a.tier)}
                    points={a.pointsReward}
                    status="completed"
                    progress={undefined}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {inProgress.length > 0 && (
          <div>
            <p className="mb-2 font-semibold text-amber-500 text-xs uppercase tracking-wide">
              In Progress ({inProgress.length})
            </p>
            <div className="space-y-2">
              {inProgress.map((a, i) => (
                <div
                  key={a.id}
                  className="animate-fadeIn"
                  style={{
                    animationDelay: `${(completed.length + i) * 40}ms`,
                    animationFillMode: 'backwards',
                  }}
                >
                  <AchievementCard
                    title={a.name}
                    description={a.description}
                    badge={mapTier(a.tier)}
                    points={a.pointsReward}
                    status="in-progress"
                    progress={
                      a.threshold > 1
                        ? { current: a.progress, total: a.threshold }
                        : undefined
                    }
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {locked.length > 0 && (
          <div>
            <p className="mb-2 font-semibold text-muted-foreground text-xs uppercase tracking-wide">
              Locked ({locked.length})
            </p>
            <div className="space-y-2">
              {locked.map((a, i) => (
                <div
                  key={a.id}
                  className="animate-fadeIn"
                  style={{
                    animationDelay: `${(completed.length + inProgress.length + i) * 40}ms`,
                    animationFillMode: 'backwards',
                  }}
                >
                  <AchievementCard
                    title={a.name}
                    description={a.description}
                    badge={mapTier(a.tier)}
                    points={a.pointsReward}
                    status="locked"
                    progress={undefined}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
