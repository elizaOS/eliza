'use client';

import { Award, CheckCircle2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';

interface AchievementBrief {
  id: string;
  name: string;
  tier: string;
  iconKey: string;
  unlocked: boolean;
}

const TIER_COLORS: Record<string, string> = {
  bronze: 'bg-amber-600/15 border-amber-600/30',
  silver: 'bg-slate-400/15 border-slate-400/30',
  gold: 'bg-yellow-500/15 border-yellow-500/30',
};

export function AchievementPreview({ onViewAll }: { onViewAll?: () => void }) {
  const { authenticated, getAccessToken } = useAuth();
  const [achievements, setAchievements] = useState<AchievementBrief[]>([]);
  const [loading, setLoading] = useState(true);

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
      const data = json.data?.achievements ?? json.achievements ?? [];
      setAchievements(data);
    }
    setLoading(false);
  }, [authenticated, getAccessToken]);

  useEffect(() => {
    fetchAchievements();
  }, [fetchAchievements]);

  if (loading) {
    return (
      <div className="flex gap-3 overflow-x-auto">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-16 w-16 shrink-0 animate-pulse rounded-lg bg-muted"
          />
        ))}
      </div>
    );
  }

  if (achievements.length === 0) return null;

  // Show first ~6 achievements sorted by unlocked first
  const sorted = [...achievements]
    .sort((a, b) => (a.unlocked === b.unlocked ? 0 : a.unlocked ? -1 : 1))
    .slice(0, 6);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Award className="h-4 w-4 text-yellow-500" />
          <h2 className="font-bold text-base text-foreground">Achievements</h2>
        </div>
        {onViewAll && (
          <button
            onClick={onViewAll}
            className="font-medium text-primary text-xs hover:underline"
          >
            View all &rarr;
          </button>
        )}
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {sorted.map((a) => {
          const tierColor = TIER_COLORS[a.tier] ?? TIER_COLORS.bronze;
          return (
            <div
              key={a.id}
              className={`relative flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border ${
                a.unlocked ? tierColor : 'border-border bg-muted/30'
              }`}
            >
              {a.unlocked ? (
                <CheckCircle2 className="h-6 w-6 text-green-500" />
              ) : (
                <Award className="h-6 w-6 text-muted-foreground/40" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
