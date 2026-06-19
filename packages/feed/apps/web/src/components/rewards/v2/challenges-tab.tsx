"use client";

import { POINTS } from "@feed/shared";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useSSEChannel } from "@/hooks/useSSE";
import { useAuthStore } from "@/stores/authStore";
import { ChallengeCard } from "./challenge-card";
import { useAnimatedCount } from "./use-animated-count";

interface ChallengeWithProgress {
  id: string;
  name: string;
  description: string;
  hint: string;
  category: string;
  pointsReward: number;
  threshold: number;
  progress: number;
  completed: boolean;
  completedAt: string | null;
}

interface ChallengesData {
  daily: {
    challenges: ChallengeWithProgress[];
    allCompletedBonus: number;
    allCompleted: boolean;
    resetsAt: string;
  };
  weekly: {
    challenges: ChallengeWithProgress[];
    allCompletedBonus: number;
    allCompleted: boolean;
    resetsAt: string;
  };
}

export function formatCountdown(resetsAt: string): string {
  const diff = new Date(resetsAt).getTime() - Date.now();
  if (diff <= 0) return "Resetting...";
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d remaining`;
  }
  return `${hours}h remaining`;
}

function BonusTracker({
  completed,
  total,
  bonus,
  allCompleted,
}: {
  completed: number;
  total: number;
  bonus: number;
  allCompleted: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between border border-border p-3 ${
        allCompleted ? "border-emerald-500/30 bg-emerald-500/10" : "bg-muted/30"
      }`}
    >
      <div className="flex items-center gap-2.5">
        <div className="flex gap-1">
          {Array.from({ length: total }).map((_, i) => (
            <div
              key={i}
              className={`h-2 w-2 rounded-full transition-colors ${
                i < completed ? "bg-emerald-500" : "bg-muted-foreground/20"
              }`}
            />
          ))}
        </div>
        <span
          className={`text-xs ${allCompleted ? "font-semibold text-emerald-500" : "text-muted-foreground"}`}
        >
          {completed}/{total} complete
        </span>
      </div>
      <span
        className={`font-semibold text-xs ${allCompleted ? "text-emerald-500" : "text-muted-foreground"}`}
      >
        +{bonus} reputation
      </span>
    </div>
  );
}

export function ChallengesTab() {
  const { authenticated, getAccessToken } = useAuth();
  const { user } = useAuthStore();
  const [challengesData, setChallengesData] = useState<ChallengesData | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [countdown, setCountdown] = useState({ daily: "", weekly: "" });

  const fetchData = useCallback(async () => {
    if (!authenticated) {
      setLoading(false);
      return;
    }
    const token = await getAccessToken();
    if (!token) {
      setLoading(false);
      return;
    }

    const res = await fetch("/api/challenges", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.ok) {
      const json = await res.json();
      setChallengesData(json);
    }

    setLoading(false);
  }, [authenticated, getAccessToken]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSSE = useCallback(
    (data: Record<string, unknown>) => {
      const type = data.type as string;
      if (
        type === "challenge_completed" ||
        type === "challenge_bonus" ||
        type === "achievement_unlocked"
      ) {
        fetchData();
      }
    },
    [fetchData],
  );

  const channel =
    authenticated && user?.id ? (`notifications:${user.id}` as const) : null;
  useSSEChannel(channel, handleSSE);

  useEffect(() => {
    if (!challengesData) return;
    const update = () => {
      setCountdown({
        daily: formatCountdown(challengesData.daily.resetsAt),
        weekly: formatCountdown(challengesData.weekly.resetsAt),
      });
    };
    update();
    const interval = setInterval(update, 60_000);
    return () => clearInterval(interval);
  }, [challengesData]);

  const dailyCompleted =
    challengesData?.daily.challenges.filter((c) => c.completed).length ?? 0;
  const weeklyCompleted =
    challengesData?.weekly.challenges.filter((c) => c.completed).length ?? 0;

  const totalCompleted = dailyCompleted + weeklyCompleted;
  const totalChallenges =
    (challengesData?.daily.challenges.length ?? 0) +
    (challengesData?.weekly.challenges.length ?? 0);
  const overallPercent =
    totalChallenges > 0 ? (totalCompleted / totalChallenges) * 100 : 0;

  const animTotal = useAnimatedCount(totalCompleted);
  const animDaily = useAnimatedCount(dailyCompleted);
  const animWeekly = useAnimatedCount(weeklyCompleted);

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-16 animate-pulse bg-muted" />
        ))}
      </div>
    );
  }

  if (!challengesData) return null;

  return (
    <div className="space-y-6">
      {/* Hero Stats */}
      <div className="-mx-4 -mt-4 bg-gradient-to-br from-emerald-500/10 via-emerald-500/5 to-transparent p-5 pb-5 dark:from-emerald-500/15 dark:via-emerald-500/5">
        <div className="flex items-center gap-8">
          <div>
            <p className="text-[11px] text-muted-foreground">Completed</p>
            <p className="font-bold text-2xl text-emerald-500 tabular-nums">
              {animTotal}
              <span className="text-base text-muted-foreground">
                /{totalChallenges}
              </span>
            </p>
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground">Daily</p>
            <p className="font-bold text-2xl text-foreground tabular-nums">
              {animDaily}
              <span className="text-base text-muted-foreground">
                /{challengesData.daily.challenges.length}
              </span>
            </p>
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground">Weekly</p>
            <p className="font-bold text-2xl text-foreground tabular-nums">
              {animWeekly}
              <span className="text-base text-muted-foreground">
                /{challengesData.weekly.challenges.length}
              </span>
            </p>
          </div>
        </div>

        <div className="mt-3 h-2 w-full bg-muted/60">
          <div
            className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-500"
            style={{ width: `${overallPercent}%` }}
          />
        </div>

        <p className="mt-2 text-muted-foreground text-xs">
          {totalCompleted === totalChallenges
            ? "All challenges complete — nice work! 🎉"
            : totalCompleted === 0
              ? "Complete challenges to earn bonus reputation"
              : `${totalChallenges - totalCompleted} more to go — keep it up!`}
        </p>
      </div>

      {/* Daily Challenges */}
      <div
        className="animate-fadeIn"
        style={{ animationDelay: "0ms", animationFillMode: "backwards" }}
      >
        <div className="mb-2 flex items-center justify-between">
          <span className="font-semibold text-foreground text-sm">
            Daily Challenges
          </span>
          <span className="text-muted-foreground text-xs">
            {countdown.daily}
          </span>
        </div>

        <div className="space-y-2">
          {challengesData.daily.challenges.map((c, i) => (
            <div
              key={c.id}
              className="animate-fadeIn"
              style={{
                animationDelay: `${(i + 1) * 60}ms`,
                animationFillMode: "backwards",
              }}
            >
              <ChallengeCard
                title={c.name}
                description={c.description}
                hint={c.hint}
                points={c.pointsReward}
                completed={c.completed}
                variant="daily"
                progress={
                  !c.completed && c.threshold > 1
                    ? { current: c.progress, total: c.threshold }
                    : undefined
                }
              />
            </div>
          ))}
          <BonusTracker
            completed={dailyCompleted}
            total={challengesData.daily.challenges.length}
            bonus={POINTS.CHALLENGE_DAILY_ALL_BONUS}
            allCompleted={challengesData.daily.allCompleted}
          />
        </div>
      </div>

      {/* Weekly Challenges */}
      <div
        className="animate-fadeIn"
        style={{ animationDelay: "200ms", animationFillMode: "backwards" }}
      >
        <div className="mb-2 flex items-center justify-between">
          <span className="font-semibold text-foreground text-sm">
            Weekly Challenges
          </span>
          <span className="text-muted-foreground text-xs">
            {countdown.weekly}
          </span>
        </div>

        <div className="space-y-2">
          {challengesData.weekly.challenges.map((c, i) => (
            <div
              key={c.id}
              className="animate-fadeIn"
              style={{
                animationDelay: `${250 + (i + 1) * 60}ms`,
                animationFillMode: "backwards",
              }}
            >
              <ChallengeCard
                title={c.name}
                description={c.description}
                hint={c.hint}
                points={c.pointsReward}
                completed={c.completed}
                variant="weekly"
                progress={
                  !c.completed && c.threshold > 1
                    ? { current: c.progress, total: c.threshold }
                    : undefined
                }
              />
            </div>
          ))}
          <BonusTracker
            completed={weeklyCompleted}
            total={challengesData.weekly.challenges.length}
            bonus={POINTS.CHALLENGE_WEEKLY_ALL_BONUS}
            allCompleted={challengesData.weekly.allCompleted}
          />
        </div>
      </div>

      {/* Footer */}
      <p className="text-muted-foreground text-xs">
        Challenges rotate automatically — daily at midnight UTC and weekly on
        Monday.
      </p>
    </div>
  );
}
