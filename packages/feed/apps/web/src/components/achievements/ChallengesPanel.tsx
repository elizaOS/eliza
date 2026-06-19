"use client";

import { POINTS } from "@feed/shared";
import {
  Calendar,
  CheckCircle2,
  Clock,
  Flame,
  Info,
  Target,
  Trophy,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/useAuth";

interface ChallengeWithProgress {
  id: string;
  name: string;
  description: string;
  hint: string;
  category: string;
  iconKey: string;
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

const CATEGORY_ICONS: Record<string, typeof Target> = {
  trading: Zap,
  social: Flame,
  exploration: Target,
  agents: Trophy,
};

function formatCountdown(resetsAt: string): string {
  const diff = new Date(resetsAt).getTime() - Date.now();
  if (diff <= 0) return "Resetting...";
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d remaining`;
  }
  return `${hours}h remaining`;
}

function ChallengeItem({ challenge }: { challenge: ChallengeWithProgress }) {
  const Icon = CATEGORY_ICONS[challenge.category] ?? Target;
  const progressPct = Math.min(
    100,
    (challenge.progress / challenge.threshold) * 100,
  );

  return (
    <div
      className={`rounded-lg border p-4 transition-all ${
        challenge.completed
          ? "border-green-500/20 bg-green-500/5"
          : "border-border"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">
          {challenge.completed ? (
            <CheckCircle2 className="h-5 w-5 text-green-500" />
          ) : (
            <Icon className="h-5 w-5 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <h4
                className={`font-semibold text-sm ${
                  challenge.completed
                    ? "text-green-600 dark:text-green-400"
                    : "text-foreground"
                }`}
              >
                {challenge.name}
              </h4>
              {challenge.hint && (
                <Tooltip
                  content={<span className="text-xs">{challenge.hint}</span>}
                >
                  <button
                    type="button"
                    aria-label={`Show hint for ${challenge.name}`}
                    className="shrink-0 text-muted-foreground/60 transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <Info className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
              )}
            </div>
            <span
              className={`shrink-0 font-bold text-sm ${
                challenge.completed ? "text-green-500" : "text-green-600"
              }`}
            >
              +{challenge.pointsReward}
            </span>
          </div>
          <p className="mt-0.5 text-muted-foreground text-xs">
            {challenge.description}
          </p>
          {!challenge.completed && challenge.threshold > 1 && (
            <div className="mt-2">
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  {challenge.progress} / {challenge.threshold}
                </span>
                <span className="text-muted-foreground">
                  {Math.round(progressPct)}%
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-muted">
                <div
                  className="h-1.5 rounded-full bg-primary transition-all"
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

/** Dot progress indicator (e.g., "Complete all 3 (1/3)" with filled/empty dots) */
function DotProgress({
  completed,
  total,
  bonus,
  allDone,
}: {
  completed: number;
  total: number;
  bonus: number;
  allDone: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between rounded-lg border p-3 ${
        allDone ? "border-green-500/20 bg-green-500/5" : "border-border"
      }`}
    >
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          {Array.from({ length: total }).map((_, i) => (
            <div
              key={i}
              className={`h-2 w-2 rounded-full ${
                i < completed ? "bg-primary" : "bg-muted-foreground/30"
              }`}
            />
          ))}
        </div>
        <span className="text-muted-foreground text-xs">
          Complete all {total} ({completed}/{total})
        </span>
      </div>
      <span
        className={`font-medium text-xs ${
          allDone ? "text-green-500" : "text-muted-foreground"
        }`}
      >
        +{bonus} bonus
      </span>
    </div>
  );
}

export function ChallengesPanel() {
  const { authenticated, getAccessToken } = useAuth();
  const [data, setData] = useState<ChallengesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [countdown, setCountdown] = useState({ daily: "", weekly: "" });

  const fetchChallenges = useCallback(async () => {
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
      setData(json.data ?? json);
    }
    setLoading(false);
  }, [authenticated, getAccessToken]);

  useEffect(() => {
    fetchChallenges();
  }, [fetchChallenges]);

  // Countdown timer
  useEffect(() => {
    if (!data) return;
    const update = () => {
      setCountdown({
        daily: formatCountdown(data.daily.resetsAt),
        weekly: formatCountdown(data.weekly.resetsAt),
      });
    };
    update();
    const interval = setInterval(update, 60_000);
    return () => clearInterval(interval);
  }, [data]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="mb-3 h-5 w-32 animate-pulse rounded bg-muted" />
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-lg border border-border bg-muted/30"
            />
          ))}
        </div>
      </div>
    );
  }

  if (!data) return null;

  const dailyCompleted = data.daily.challenges.filter(
    (c) => c.completed,
  ).length;
  const weeklyCompleted = data.weekly.challenges.filter(
    (c) => c.completed,
  ).length;

  return (
    <div className="space-y-6">
      {/* Daily Challenges */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-bold text-base text-foreground">
              Daily Challenges
            </h2>
          </div>
          <span className="text-muted-foreground text-xs">
            {countdown.daily}
          </span>
        </div>

        <div className="space-y-2">
          {data.daily.challenges.map((c) => (
            <ChallengeItem key={c.id} challenge={c} />
          ))}

          <DotProgress
            completed={dailyCompleted}
            total={3}
            bonus={POINTS.CHALLENGE_DAILY_ALL_BONUS}
            allDone={data.daily.allCompleted}
          />
        </div>
      </div>

      {/* Weekly Challenges */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-bold text-base text-foreground">
              Weekly Challenges
            </h2>
          </div>
          <span className="text-muted-foreground text-xs">
            {countdown.weekly}
          </span>
        </div>

        <div className="space-y-2">
          {data.weekly.challenges.map((c) => (
            <ChallengeItem key={c.id} challenge={c} />
          ))}

          <DotProgress
            completed={weeklyCompleted}
            total={2}
            bonus={POINTS.CHALLENGE_WEEKLY_ALL_BONUS}
            allDone={data.weekly.allCompleted}
          />
        </div>
      </div>
    </div>
  );
}
