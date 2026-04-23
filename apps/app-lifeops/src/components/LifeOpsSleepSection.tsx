import { client } from "@elizaos/app-core";
import type {
  LifeOpsOverview,
  LifeOpsScheduleInsight,
} from "@elizaos/shared/contracts/lifeops";
import { AlarmClock, Loader2, Moon, RefreshCw, Sunrise } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  formatClockTime,
  formatDurationSeconds,
  HabitPanel,
  MetricTile,
} from "./LifeOpsHabitVisuals.js";

function sleepStatusLabel(schedule: LifeOpsScheduleInsight | null): string {
  if (!schedule) return "No signal";
  switch (schedule.sleepStatus) {
    case "sleeping_now":
      return "Sleeping";
    case "slept":
      return "Slept";
    case "likely_missed":
      return "Likely missed";
    case "unknown":
      return "Unknown";
  }
}

function minutesFromDayStart(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const date = new Date(iso);
  const parsed = date.getTime();
  if (!Number.isFinite(parsed)) return null;
  return date.getHours() * 60 + date.getMinutes();
}

function markerStyle(
  iso: string | null | undefined,
): { left: string } | undefined {
  const minutes = minutesFromDayStart(iso);
  if (minutes === null) return undefined;
  return { left: `${Math.min(100, Math.max(0, (minutes / 1440) * 100))}%` };
}

function sleepDurationSeconds(schedule: LifeOpsScheduleInsight | null): number {
  return Math.max(0, (schedule?.lastSleepDurationMinutes ?? 0) * 60);
}

export function LifeOpsSleepSection() {
  const [overview, setOverview] = useState<LifeOpsOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOverview(await client.getLifeOpsOverview());
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : "Sleep failed to load.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const schedule = overview?.schedule ?? null;
  const durationSeconds = sleepDurationSeconds(schedule);
  const bedtime = schedule?.relativeTime.bedtimeTargetAt ?? null;
  const wake = schedule?.wakeAt ?? schedule?.relativeTime.wakeAnchorAt ?? null;

  return (
    <div className="space-y-4" data-testid="lifeops-sleep-section">
      <header className="flex items-center justify-between gap-3 border-b border-border/20 pb-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight text-txt">
            Sleep
          </h1>
        </div>
        <button
          type="button"
          aria-label="Refresh sleep"
          title="Refresh"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border/20 bg-bg/30 text-muted transition-colors hover:border-accent/30 hover:text-txt disabled:opacity-40"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            aria-hidden
          />
        </button>
      </header>

      {error ? (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {error}
        </div>
      ) : null}

      {loading && !overview ? (
        <div className="flex items-center gap-2 py-4 text-xs text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading sleep...
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          icon={<Moon />}
          value={sleepStatusLabel(schedule)}
          label="Now"
        />
        <MetricTile
          icon={<Moon />}
          value={formatDurationSeconds(durationSeconds)}
          label="Last Sleep"
        />
        <MetricTile
          icon={<AlarmClock />}
          value={formatClockTime(bedtime) || "-"}
          label="Bed"
        />
        <MetricTile
          icon={<Sunrise />}
          value={formatClockTime(wake) || "-"}
          label="Wake"
        />
      </div>

      <HabitPanel title="Cycle" icon={<Moon />}>
        <div className="relative h-24 rounded-lg border border-border/12 bg-bg/24 p-4">
          <div className="absolute left-4 right-4 top-1/2 h-2 -translate-y-1/2 rounded-full bg-gradient-to-r from-indigo-500/70 via-blue-400/50 to-amber-300/70" />
          {markerStyle(bedtime) ? (
            <div
              className="absolute top-5 h-14 w-px bg-blue-300"
              style={markerStyle(bedtime)}
              title="Bed"
            />
          ) : null}
          {markerStyle(wake) ? (
            <div
              className="absolute top-5 h-14 w-px bg-amber-300"
              style={markerStyle(wake)}
              title="Wake"
            />
          ) : null}
          <div className="absolute bottom-3 left-4 text-[10px] font-medium text-muted">
            12a
          </div>
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-[10px] font-medium text-muted">
            12p
          </div>
          <div className="absolute bottom-3 right-4 text-[10px] font-medium text-muted">
            12a
          </div>
        </div>
      </HabitPanel>
    </div>
  );
}
