'use client';

import { Award } from 'lucide-react';
import { useEffect, useState } from 'react';

interface Achievement {
  id: string;
  name: string;
  tier: string;
  iconKey: string;
  pointsReward: number;
  unlockedAt: string | null;
}

const TIER_COLORS: Record<string, string> = {
  bronze: 'border-amber-600/40 bg-amber-600/10 text-amber-600',
  silver: 'border-slate-400/40 bg-slate-400/10 text-slate-400',
  gold: 'border-yellow-500/40 bg-yellow-500/10 text-yellow-500',
};

/**
 * Compact display of a user's recent achievements for profile pages.
 * Shows up to 5 most recently unlocked achievements as small badges.
 */
export function RecentAchievements({ userId }: { userId: string }) {
  const [achievements, setAchievements] = useState<Achievement[]>([]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    async function fetchAchievements() {
      const res = await fetch(`/api/users/${userId}/achievements`);
      if (res.ok && !cancelled) {
        const json = await res.json();
        const all: Achievement[] = json.achievements ?? [];
        setAchievements(all);
      }
    }

    fetchAchievements();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (achievements.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5">
      <Award className="h-3.5 w-3.5 text-muted-foreground" />
      {achievements.map((a) => (
        <div
          key={a.id}
          title={`${a.name} (+${a.pointsReward} pts)`}
          className={`rounded-full border px-2 py-0.5 font-medium text-xs ${TIER_COLORS[a.tier] ?? TIER_COLORS.bronze}`}
        >
          {a.name}
        </div>
      ))}
    </div>
  );
}
