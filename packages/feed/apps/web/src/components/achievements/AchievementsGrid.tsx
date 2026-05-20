"use client";

import { CheckCircle2, Lock } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";

interface AchievementWithProgress {
  id: string;
  name: string;
  description: string;
  category: string;
  tier: string;
  iconKey: string;
  pointsReward: number;
  threshold: number;
  progress: number;
  unlocked: boolean;
  unlockedAt: string | null;
}

const TIER_BADGE_STYLES: Record<string, { badge: string; progress: string }> = {
  bronze: {
    badge: "bg-amber-600/15 text-amber-600",
    progress: "bg-amber-600",
  },
  silver: {
    badge: "bg-slate-400/15 text-slate-400",
    progress: "bg-slate-400",
  },
  gold: {
    badge: "bg-yellow-500/15 text-yellow-500",
    progress: "bg-yellow-500",
  },
};

const DEFAULT_TIER_BADGE = {
  badge: "bg-amber-600/15 text-amber-600",
  progress: "bg-amber-600",
};

const TIER_LABELS = ["all", "bronze", "silver", "gold"] as const;

function StatusIcon({ achievement }: { achievement: AchievementWithProgress }) {
  if (achievement.unlocked) {
    return <CheckCircle2 className="h-5 w-5 text-green-500" />;
  }
  if (achievement.progress > 0) {
    return (
      <div className="flex h-5 w-5 items-center justify-center">
        <div className="h-3 w-3 rounded-full bg-amber-500" />
      </div>
    );
  }
  return <Lock className="h-5 w-5 text-muted-foreground" />;
}

function AchievementRow({
  achievement,
}: {
  achievement: AchievementWithProgress;
}) {
  const tierStyle = TIER_BADGE_STYLES[achievement.tier] ?? DEFAULT_TIER_BADGE;
  const progressPct = Math.min(
    100,
    (achievement.progress / achievement.threshold) * 100,
  );
  const isInProgress = !achievement.unlocked && achievement.progress > 0;

  return (
    <div
      className={`rounded-lg border p-4 transition-all ${
        achievement.unlocked
          ? "border-green-500/20 bg-green-500/5"
          : "border-border"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">
          <StatusIcon achievement={achievement} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h4
                className={`font-semibold text-sm ${
                  achievement.unlocked
                    ? "text-green-600 dark:text-green-400"
                    : "text-foreground"
                }`}
              >
                {achievement.name}
              </h4>
              <span
                className={`rounded-full px-2 py-0.5 font-medium text-[10px] capitalize ${tierStyle.badge}`}
              >
                {achievement.tier}
              </span>
            </div>
            <span
              className={`shrink-0 font-bold text-sm ${
                achievement.unlocked ? "text-green-500" : "text-foreground"
              }`}
            >
              +{achievement.pointsReward}
            </span>
          </div>
          <p className="mt-0.5 text-muted-foreground text-xs">
            {achievement.description}
          </p>
          {isInProgress && (
            <div className="mt-2">
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  {achievement.progress} / {achievement.threshold}
                </span>
                <span className="text-muted-foreground">
                  {Math.round(progressPct)}%
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-muted">
                <div
                  className={`h-1.5 rounded-full transition-all ${tierStyle.progress}`}
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function AchievementsGrid() {
  const { authenticated, getAccessToken } = useAuth();
  const [achievements, setAchievements] = useState<AchievementWithProgress[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");

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
    const res = await fetch("/api/achievements", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const json = await res.json();
      setAchievements(json.data?.achievements ?? json.achievements ?? []);
    }
    setLoading(false);
  }, [authenticated, getAccessToken]);

  useEffect(() => {
    fetchAchievements();
  }, [fetchAchievements]);

  if (loading) {
    return (
      <div>
        <div className="mb-4 flex items-center gap-6">
          <div className="h-8 w-20 animate-pulse rounded bg-muted" />
          <div className="h-8 w-20 animate-pulse rounded bg-muted" />
        </div>
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-lg border border-border bg-muted/30"
            />
          ))}
        </div>
      </div>
    );
  }

  const filtered =
    filter === "all"
      ? achievements
      : achievements.filter((a) => a.tier === filter);

  // Sort: unlocked first, then in-progress (progress > 0), then locked
  const sorted = [...filtered].sort((a, b) => {
    if (a.unlocked && !b.unlocked) return -1;
    if (!a.unlocked && b.unlocked) return 1;
    if (!a.unlocked && !b.unlocked) {
      if (a.progress > 0 && b.progress === 0) return -1;
      if (a.progress === 0 && b.progress > 0) return 1;
    }
    return 0;
  });

  const unlockedCount = achievements.filter((a) => a.unlocked).length;
  const pointsEarned = achievements
    .filter((a) => a.unlocked)
    .reduce((sum, a) => sum + a.pointsReward, 0);

  return (
    <div>
      {/* Summary stats */}
      <div className="mb-4 flex items-center gap-6">
        <div>
          <div className="font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
            Unlocked
          </div>
          <div className="font-bold text-foreground text-xl">
            {unlockedCount}
            <span className="font-normal text-muted-foreground text-sm">
              /{achievements.length}
            </span>
          </div>
        </div>
        <div>
          <div className="font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
            Points Earned
          </div>
          <div className="font-bold text-foreground text-xl">
            {pointsEarned}
          </div>
        </div>

        {/* Tier filter pills */}
        <div className="ml-auto flex gap-1.5">
          {TIER_LABELS.map((tier) => (
            <button
              key={tier}
              onClick={() => setFilter(tier)}
              className={`rounded-full px-3 py-1 font-medium text-xs capitalize transition-colors ${
                filter === tier
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {tier === "all" ? "All" : tier}
            </button>
          ))}
        </div>
      </div>

      {/* Single column list */}
      <div className="space-y-2">
        {sorted.map((a) => (
          <AchievementRow key={a.id} achievement={a} />
        ))}
      </div>

      {sorted.length === 0 && (
        <div className="py-8 text-center text-muted-foreground text-sm">
          No achievements in this tier
        </div>
      )}
    </div>
  );
}
