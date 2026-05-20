"use client";

import { POINTS } from "@feed/shared";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useSSEChannel } from "@/hooks/useSSE";
import { useAuthStore } from "@/stores/authStore";
import type { AchievementFromApi } from "./achievements-tab";
import { formatCountdown } from "./challenges-tab";
import { useAnimatedCount } from "./use-animated-count";

interface StreakInfo {
  currentStreak: number;
  longestStreak: number;
  nextReward: number;
  daysUntilMilestone: number;
  nextMilestone: number;
  lastClaim: string | null;
  canClaim: boolean;
  totalDailyLogins: number;
}

interface ChallengeWithProgress {
  id: string;
  name: string;
  description: string;
  pointsReward: number;
  threshold: number;
  progress: number;
  completed: boolean;
}

interface DailyChallengesData {
  challenges: ChallengeWithProgress[];
  allCompletedBonus: number;
  allCompleted: boolean;
  resetsAt: string;
}

interface WeeklyChallengesData {
  challenges: ChallengeWithProgress[];
  allCompletedBonus: number;
  allCompleted: boolean;
  resetsAt: string;
}

interface OverviewTabProps {
  onViewAchievements: () => void;
  onViewChallenges: () => void;
}

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

/** Day checkpoints (1..n) along the bar; one marker per day for short milestones, subsampled for long ones. */
function milestoneMarkerDays(nextMilestone: number): number[] {
  if (nextMilestone <= 0) return [];
  if (nextMilestone <= 20) {
    return Array.from({ length: nextMilestone }, (_, i) => i + 1);
  }
  const maxMarkers = 10;
  const step = Math.max(1, Math.round(nextMilestone / maxMarkers));
  const days: number[] = [];
  for (let d = step; d < nextMilestone; d += step) {
    days.push(d);
  }
  days.push(nextMilestone);
  return [...new Set(days)].sort((a, b) => a - b);
}

function StreakCalendar({
  currentStreak,
  canClaim,
}: {
  currentStreak: number;
  canClaim: boolean;
}) {
  const todayDow = new Date().getDay();
  const streakDays = Math.min(currentStreak, 7);

  return (
    <div className="flex items-end justify-between gap-1.5 sm:gap-2">
      {Array.from({ length: 7 }).map((_, i) => {
        const daysAgo = 6 - i;
        const dow = (((todayDow - daysAgo) % 7) + 7) % 7;
        const day = DAY_LABELS[dow];
        const isToday = daysAgo === 0;
        const isCompleted = canClaim
          ? daysAgo >= 1 && daysAgo <= streakDays
          : daysAgo < streakDays;

        return (
          <div key={i}>
            <div
              className={`flex items-center justify-center transition-all duration-300 ${
                isToday ? "h-9 w-9 sm:h-10 sm:w-10" : "h-8 w-8 sm:h-9 sm:w-9"
              } rounded-full ${
                isCompleted
                  ? "bg-primary text-primary-foreground shadow-[0_0_12px_rgba(0,102,255,0.3)]"
                  : "border border-border bg-transparent text-muted-foreground"
              } ${isToday && !isCompleted ? "border-2 border-primary/50" : ""}`}
            >
              {isCompleted ? (
                <svg
                  className="h-3.5 w-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <span className="font-medium text-[11px]">{day}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function OverviewTab({
  onViewAchievements,
  onViewChallenges,
}: OverviewTabProps) {
  const { authenticated, getAccessToken } = useAuth();
  const { user } = useAuthStore();
  const [streak, setStreak] = useState<StreakInfo | null>(null);
  const [dailyData, setDailyData] = useState<DailyChallengesData | null>(null);
  const [weeklyData, setWeeklyData] = useState<WeeklyChallengesData | null>(
    null,
  );
  const [achievements, setAchievements] = useState<AchievementFromApi[]>([]);
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

    const [streakRes, challengesRes, achievementsRes] = await Promise.all([
      fetch("/api/users/daily-login", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      fetch("/api/challenges", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      fetch("/api/achievements", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);

    if (streakRes.ok) {
      const json = await streakRes.json();
      setStreak(json);
    }

    if (challengesRes.ok) {
      const json = await challengesRes.json();
      setDailyData(json.daily);
      setWeeklyData(json.weekly);
    }

    if (achievementsRes.ok) {
      const json = await achievementsRes.json();
      setAchievements(json.achievements ?? []);
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
    if (!dailyData && !weeklyData) return;
    const update = () => {
      setCountdown({
        daily: dailyData ? formatCountdown(dailyData.resetsAt) : "",
        weekly: weeklyData ? formatCountdown(weeklyData.resetsAt) : "",
      });
    };
    update();
    const interval = setInterval(update, 60_000);
    return () => clearInterval(interval);
  }, [dailyData, weeklyData]);

  const nextReward = streak?.nextReward ?? POINTS.DAILY_LOGIN_DAY_1;
  const dailyCompleted =
    dailyData?.challenges.filter((c) => c.completed).length ?? 0;
  const dailyTotal = dailyData?.challenges.length ?? 0;
  const weeklyCompleted =
    weeklyData?.challenges.filter((c) => c.completed).length ?? 0;
  const weeklyTotal = weeklyData?.challenges.length ?? 0;
  const progressPercent = streak
    ? (Math.min(streak.currentStreak, streak.nextMilestone) /
        streak.nextMilestone) *
      100
    : 0;

  const unlockedCount = achievements.filter((a) => a.unlocked).length;
  const totalAchievements = achievements.length;
  const pointsEarned = achievements
    .filter((a) => a.unlocked)
    .reduce((sum, a) => sum + a.pointsReward, 0);
  const achievementProgressPercent =
    totalAchievements > 0 ? (unlockedCount / totalAchievements) * 100 : 0;
  const challengePercent =
    dailyTotal + weeklyTotal > 0
      ? ((dailyCompleted + weeklyCompleted) / (dailyTotal + weeklyTotal)) * 100
      : 0;

  const animNextReward = useAnimatedCount(nextReward);
  const animBestStreak = useAnimatedCount(streak?.longestStreak ?? 0);
  const animTotalClaims = useAnimatedCount(streak?.totalDailyLogins ?? 0);
  const animPointsEarned = useAnimatedCount(pointsEarned);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-52 animate-pulse bg-muted" />
        <div className="h-28 animate-pulse bg-muted" />
        <div className="h-24 animate-pulse bg-muted" />
      </div>
    );
  }

  return (
    <div className="min-w-0">
      {/* ── Hero: Daily Rewards ── */}
      <div className="-mx-4 -mt-4 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-5 pb-6 dark:from-primary/15 dark:via-primary/5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-base text-foreground">
            Daily Rewards
          </h2>
          <span className="rounded-full bg-primary/15 px-2.5 py-1 font-bold text-primary text-xs tabular-nums">
            {streak?.currentStreak ?? 0} day streak
          </span>
        </div>

        {/* Streak Calendar */}
        <div className="mt-4">
          <StreakCalendar
            currentStreak={streak?.currentStreak ?? 0}
            canClaim={streak?.canClaim ?? false}
          />
        </div>

        {/* Stats Row */}
        <div className="mt-5 flex gap-4 sm:gap-6">
          <div className="flex-1 bg-background/60 p-3 backdrop-blur-sm dark:bg-background/40">
            <p className="text-[11px] text-muted-foreground">Next reward</p>
            <p className="font-bold text-foreground text-lg tabular-nums">
              +{animNextReward}
            </p>
          </div>
          <div className="flex-1 bg-background/60 p-3 backdrop-blur-sm dark:bg-background/40">
            <p className="text-[11px] text-muted-foreground">Best streak</p>
            <p className="font-bold text-foreground text-lg tabular-nums">
              {animBestStreak}
              <span className="ml-0.5 font-normal text-muted-foreground text-xs">
                d
              </span>
            </p>
          </div>
          <div className="flex-1 bg-background/60 p-3 backdrop-blur-sm dark:bg-background/40">
            <p className="text-[11px] text-muted-foreground">Total claims</p>
            <p className="font-bold text-foreground text-lg tabular-nums">
              {animTotalClaims}
            </p>
          </div>
        </div>

        {/* Milestone Progress */}
        {streak && streak.nextMilestone > 0 && (
          <div className="mt-4">
            <div className="flex items-center justify-between">
              <p className="text-foreground text-xs">
                {streak.nextMilestone}-day milestone
              </p>
              <span className="text-muted-foreground text-xs tabular-nums">
                {streak.daysUntilMilestone} days left
              </span>
            </div>
            <div className="relative mt-2 h-2 w-full overflow-visible bg-muted/60 backdrop-blur-sm">
              <div
                className="h-full bg-gradient-to-r from-primary to-blue-400 transition-all duration-500"
                style={{ width: `${progressPercent}%` }}
              />
              {milestoneMarkerDays(streak.nextMilestone).map((day) => {
                const pct = (day / streak.nextMilestone) * 100;
                return (
                  <div
                    key={day}
                    className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background ${
                      progressPercent >= pct
                        ? "bg-primary"
                        : "bg-muted-foreground/30"
                    }`}
                    style={{ left: `${pct}%` }}
                  />
                );
              })}
            </div>
          </div>
        )}

        {/* Streak status */}
        <div className="mt-5 flex w-full items-center justify-center bg-emerald-500/10 py-3.5 font-semibold text-emerald-600 text-sm dark:text-emerald-400">
          {streak?.canClaim
            ? `+${nextReward} Reputation on next login`
            : "Claimed Today ✓"}
        </div>
      </div>

      {/* ── Summaries: Challenges + Achievements ── */}
      <div className="mt-6 space-y-3">
        {/* Challenges Summary */}
        {(dailyData || weeklyData) && (
          <button
            onClick={onViewChallenges}
            className="block w-full animate-fadeIn border border-border bg-card p-4 text-left transition-all hover:border-emerald-500/30"
            style={{ animationDelay: "80ms", animationFillMode: "backwards" }}
          >
            <div className="flex items-center justify-between">
              <p className="font-semibold text-foreground text-sm">
                Challenges
              </p>
              <span className="shrink-0 text-primary text-xs">View all →</span>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="font-semibold text-emerald-500 text-sm tabular-nums">
                {dailyCompleted + weeklyCompleted}/{dailyTotal + weeklyTotal}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {countdown.daily}
              </span>
            </div>
            <div className="mt-2 h-1.5 w-full bg-muted">
              <div
                className={`h-full transition-all duration-500 ${
                  challengePercent === 100
                    ? "bg-emerald-500"
                    : "bg-gradient-to-r from-emerald-500 to-emerald-400"
                }`}
                style={{ width: `${challengePercent}%` }}
              />
            </div>
          </button>
        )}

        {/* Achievements Summary */}
        {achievements.length > 0 && (
          <button
            onClick={onViewAchievements}
            className="block w-full animate-fadeIn border border-border bg-card p-4 text-left transition-all hover:border-amber-500/30"
            style={{ animationDelay: "160ms", animationFillMode: "backwards" }}
          >
            <div className="flex items-center justify-between">
              <p className="font-semibold text-foreground text-sm">
                Achievements
              </p>
              <span className="shrink-0 text-primary text-xs">View all →</span>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="font-semibold text-amber-500 text-sm tabular-nums">
                {unlockedCount}/{totalAchievements}
              </span>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {animPointsEarned} reputation earned
              </span>
            </div>
            <div className="mt-2 h-1.5 w-full bg-muted">
              <div
                className="h-full bg-gradient-to-r from-amber-500 to-yellow-400 transition-all duration-500"
                style={{ width: `${achievementProgressPercent}%` }}
              />
            </div>
          </button>
        )}
      </div>
    </div>
  );
}
