import type {
  LifeOpsOverview,
  LifeOpsPersonalBaselineResponse,
  LifeOpsRegularityClass,
  LifeOpsScheduleInsight,
  LifeOpsSleepCycleEvidenceSource,
  LifeOpsSleepCycleType,
  LifeOpsSleepHistoryEpisode,
  LifeOpsSleepHistoryResponse,
  LifeOpsSleepHistorySummary,
  LifeOpsSleepRegularityResponse,
} from "@elizaos/shared";
import { client } from "@elizaos/ui";
import {
  Activity,
  AlarmClock,
  Heart,
  Loader2,
  Moon,
  RefreshCw,
  Sunrise,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  formatClockTime,
  formatDurationSeconds,
  HabitPanel,
  MetricTile,
} from "./LifeOpsHabitVisuals.js";

type SleepTab = "tonight" | "history" | "pattern";

type WindowDays = 30 | 90 | 365;

const HISTORY_WINDOWS: WindowDays[] = [30, 90, 365];
const DEFAULT_WINDOW: WindowDays = 365;

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

function sleepDurationSeconds(
  schedule: LifeOpsScheduleInsight | null,
): number | null {
  if (typeof schedule?.lastSleepDurationMinutes !== "number") {
    return null;
  }
  return Math.max(0, schedule.lastSleepDurationMinutes * 60);
}

/**
 * Format a numeric local hour in [0..36) into a 12h time string.
 * Hours >=24 wrap to the next day. Examples:
 *   23.5  -> "11:30 PM"
 *   7.25  -> "7:15 AM"
 *   24.5  -> "12:30 AM"
 */
export function formatLocalHour(h: number): string {
  if (!Number.isFinite(h)) return "—";
  const wrapped = ((h % 24) + 24) % 24;
  const hourFloat = wrapped;
  const hour = Math.floor(hourFloat);
  const minute = Math.round((hourFloat - hour) * 60);
  const minuteWrap = minute === 60 ? 0 : minute;
  const hourWrap = minute === 60 ? (hour + 1) % 24 : hour;
  const period = hourWrap >= 12 ? "PM" : "AM";
  const displayHour = hourWrap % 12 === 0 ? 12 : hourWrap % 12;
  const minuteStr = String(minuteWrap).padStart(2, "0");
  return `${displayHour}:${minuteStr} ${period}`;
}

function formatDurationMinutes(minutes: number | null | undefined): string {
  if (typeof minutes !== "number" || !Number.isFinite(minutes)) return "—";
  return formatDurationSeconds(minutes * 60) || "—";
}

function historyWindowLabel(days: WindowDays): string {
  return days === 365 ? "All year" : `${days} days`;
}

function formatStddev(stddevMin: number | null | undefined): string {
  if (typeof stddevMin !== "number" || !Number.isFinite(stddevMin)) return "";
  return `±${Math.round(stddevMin)} min`;
}

function formatEpisodeDateLabel(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "—";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(ts));
}

function cycleTypeLabel(type: LifeOpsSleepCycleType): string {
  switch (type) {
    case "overnight":
      return "Overnight";
    case "nap":
      return "Nap";
    case "unknown":
      return "Unknown";
  }
}

function cycleTypeBadgeClass(type: LifeOpsSleepCycleType): string {
  switch (type) {
    case "overnight":
      return "border-indigo-500/30 bg-indigo-500/10 text-indigo-200";
    case "nap":
      return "border-amber-400/30 bg-amber-400/10 text-amber-200";
    case "unknown":
      return "border-border/20 bg-bg/30 text-muted";
  }
}

type SourceMeta = {
  label: string;
  short: string;
  icon: typeof Heart;
};

function sourceMeta(
  source: LifeOpsSleepCycleEvidenceSource | "manual",
): SourceMeta {
  switch (source) {
    case "health":
      return { label: "Health sensor", short: "Sensor", icon: Heart };
    case "activity_gap":
      return {
        label: "Inferred from activity gap",
        short: "Inferred",
        icon: Activity,
      };
    case "manual":
      return { label: "Manual entry", short: "Manual", icon: AlarmClock };
  }
}

type ConfidenceTier = "high" | "med" | "low";

function confidenceTier(value: number): ConfidenceTier {
  if (value >= 0.8) return "high";
  if (value >= 0.6) return "med";
  return "low";
}

function confidenceDotClass(tier: ConfidenceTier): string {
  switch (tier) {
    case "high":
      return "bg-emerald-400";
    case "med":
      return "bg-amber-300";
    case "low":
      return "bg-rose-400";
  }
}

function confidenceLabel(tier: ConfidenceTier, value: number): string {
  const pct = Math.round(value * 100);
  switch (tier) {
    case "high":
      return `High confidence (${pct}%)`;
    case "med":
      return `Medium confidence (${pct}%)`;
    case "low":
      return `Low confidence (${pct}%)`;
  }
}

function classificationLabel(c: LifeOpsRegularityClass): string {
  switch (c) {
    case "very_regular":
      return "Very regular";
    case "regular":
      return "Regular";
    case "irregular":
      return "Irregular";
    case "very_irregular":
      return "Very irregular";
    case "insufficient_data":
      return "Not enough data yet";
  }
}

type RegularityTone = {
  ring: string;
  text: string;
  bg: string;
};

function regularityTone(c: LifeOpsRegularityClass): RegularityTone {
  switch (c) {
    case "very_regular":
      return {
        ring: "ring-emerald-400/40",
        text: "text-emerald-300",
        bg: "bg-emerald-500/10",
      };
    case "regular":
      return {
        ring: "ring-green-400/40",
        text: "text-green-300",
        bg: "bg-green-500/10",
      };
    case "irregular":
      return {
        ring: "ring-amber-400/40",
        text: "text-amber-300",
        bg: "bg-amber-500/10",
      };
    case "very_irregular":
      return {
        ring: "ring-rose-400/40",
        text: "text-rose-300",
        bg: "bg-rose-500/10",
      };
    case "insufficient_data":
      return {
        ring: "ring-border/30",
        text: "text-muted",
        bg: "bg-bg/30",
      };
  }
}

function TabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={[
        "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-accent/20 text-txt"
          : "text-muted hover:bg-bg/30 hover:text-txt",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function NapToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-xs text-muted">
      <span>Show naps</span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={[
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
          value ? "bg-accent/60" : "bg-border/30",
        ].join(" ")}
      >
        <span
          className={[
            "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
            value ? "translate-x-4" : "translate-x-0.5",
          ].join(" ")}
        />
      </button>
    </label>
  );
}

function TonightTab({ schedule }: { schedule: LifeOpsScheduleInsight | null }) {
  const durationSeconds = sleepDurationSeconds(schedule);
  const bedtime = schedule?.relativeTime.bedtimeTargetAt ?? null;
  const wake = schedule?.wakeAt ?? schedule?.relativeTime.wakeAnchorAt ?? null;

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          icon={<Moon />}
          value={sleepStatusLabel(schedule)}
          label="Now"
        />
        <MetricTile
          icon={<Moon />}
          value={formatDurationSeconds(durationSeconds) || "-"}
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
    </>
  );
}

function HistoryEpisodeRow({
  episode,
}: {
  episode: LifeOpsSleepHistoryEpisode;
}) {
  const meta = sourceMeta(episode.source);
  const SourceIcon = meta.icon;
  const tier = confidenceTier(episode.confidence);
  const dotClass = confidenceDotClass(tier);
  const dotTitle = confidenceLabel(tier, episode.confidence);
  const dateLabel = formatEpisodeDateLabel(episode.startedAt);
  const startClock = formatClockTime(episode.startedAt) || "—";
  const endClock = episode.endedAt ? formatClockTime(episode.endedAt) : "—";
  const durationLabel = formatDurationMinutes(episode.durationMin);
  const typeLabel = cycleTypeLabel(episode.cycleType);
  const typeBadge = cycleTypeBadgeClass(episode.cycleType);
  const durationPct =
    typeof episode.durationMin === "number" &&
    Number.isFinite(episode.durationMin)
      ? Math.min(100, Math.max(6, (episode.durationMin / 600) * 100))
      : 0;

  return (
    <li
      className="flex items-center gap-3 rounded-lg border border-border/12 bg-bg/24 px-3 py-2.5"
      data-testid="sleep-history-row"
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`}
        title={dotTitle}
        role="img"
        aria-label={dotTitle}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs font-medium text-txt">
          <span className="truncate">{dateLabel}</span>
          <span
            className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${typeBadge}`}
          >
            {typeLabel}
          </span>
        </div>
        <div className="mt-0.5 truncate text-[11px] text-muted">
          {startClock} → {endClock}
        </div>
        {durationPct > 0 ? (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-muted/40">
            <div
              className={[
                "h-full rounded-full",
                episode.cycleType === "nap"
                  ? "bg-amber-300/80"
                  : episode.cycleType === "overnight"
                    ? "bg-indigo-300/80"
                    : "bg-muted/60",
              ].join(" ")}
              style={{ width: `${durationPct}%` }}
            />
          </div>
        ) : null}
      </div>
      <div className="shrink-0 text-right">
        <div className="text-sm font-semibold tabular-nums text-txt">
          {durationLabel}
        </div>
        <div
          className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-muted"
          title={meta.label}
        >
          <SourceIcon className="h-3 w-3" aria-hidden />
          <span>{meta.short}</span>
        </div>
      </div>
    </li>
  );
}

function HistorySummaryStrip({
  summary,
}: {
  summary: LifeOpsSleepHistorySummary;
}) {
  return (
    <div
      className="grid gap-2 sm:grid-cols-4"
      data-testid="sleep-history-summary"
    >
      <MetricTile
        icon={<Moon />}
        value={String(summary.cycleCount)}
        label="Cycles"
      />
      <MetricTile
        icon={<Moon />}
        value={formatDurationMinutes(summary.averageDurationMin)}
        label="Avg"
      />
      <MetricTile
        icon={<Activity />}
        value={`${summary.overnightCount}/${summary.napCount}`}
        label="Night/Nap"
      />
      <MetricTile
        icon={<AlarmClock />}
        value={String(summary.openCount)}
        label="Open"
      />
    </div>
  );
}

function HistoryCycleMap({
  episodes,
}: {
  episodes: readonly LifeOpsSleepHistoryEpisode[];
}) {
  const visible = episodes.slice(0, 42).reverse();
  if (visible.length === 0) return null;

  return (
    <div
      className="grid min-h-16 grid-cols-[repeat(auto-fit,minmax(8px,1fr))] items-end gap-1 rounded-lg border border-border/12 bg-bg/24 px-3 py-3"
      data-testid="sleep-history-cycle-map"
    >
      {visible.map((episode) => {
        const height =
          typeof episode.durationMin === "number" &&
          Number.isFinite(episode.durationMin)
            ? Math.min(100, Math.max(16, (episode.durationMin / 600) * 100))
            : 16;
        const tone =
          episode.cycleType === "nap"
            ? "bg-amber-300/75"
            : episode.cycleType === "overnight"
              ? "bg-indigo-300/80"
              : "bg-muted/60";
        return (
          <span
            key={episode.id}
            className={`block rounded-sm ${tone}`}
            style={{ height: `${height}%` }}
            title={`${formatEpisodeDateLabel(episode.startedAt)} · ${formatDurationMinutes(
              episode.durationMin,
            )}`}
          />
        );
      })}
    </div>
  );
}

function HistoryTab({
  data,
  loading,
  error,
  windowDays,
  onWindowChange,
}: {
  data: LifeOpsSleepHistoryResponse | null;
  loading: boolean;
  error: string | null;
  windowDays: WindowDays;
  onWindowChange: (w: WindowDays) => void;
}) {
  const sortedEpisodes = useMemo(() => {
    if (!data) return [] as LifeOpsSleepHistoryEpisode[];
    return [...data.episodes].sort((a, b) => {
      const aTs = Date.parse(a.startedAt);
      const bTs = Date.parse(b.startedAt);
      return (
        (Number.isFinite(bTs) ? bTs : 0) - (Number.isFinite(aTs) ? aTs : 0)
      );
    });
  }, [data]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        {HISTORY_WINDOWS.map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => onWindowChange(w)}
            className={[
              "rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
              w === windowDays
                ? "border-accent/40 bg-accent/10 text-txt"
                : "border-border/20 bg-bg/30 text-muted hover:border-accent/30 hover:text-txt",
            ].join(" ")}
            aria-pressed={w === windowDays}
          >
            {historyWindowLabel(w)}
          </button>
        ))}
      </div>

      {error ? (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {error}
        </div>
      ) : null}

      {loading && !data ? (
        <div className="flex items-center gap-2 py-4 text-xs text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading history...
        </div>
      ) : null}

      {!loading && data && sortedEpisodes.length === 0 ? (
        <div className="rounded-lg border border-border/20 bg-bg/24 px-3 py-6 text-center text-xs text-muted">
          No sleep data in the last {windowDays} days. Connect a health source
          from Settings.
        </div>
      ) : null}

      {data && sortedEpisodes.length > 0 ? (
        <>
          <HistorySummaryStrip summary={data.summary} />
          <HistoryCycleMap episodes={sortedEpisodes} />
          <ul className="space-y-2" data-testid="sleep-history-list">
            {sortedEpisodes.map((ep) => (
              <HistoryEpisodeRow key={ep.id} episode={ep} />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function SriGauge({
  sri,
  classification,
}: {
  sri: number;
  classification: LifeOpsRegularityClass;
}) {
  const tone = regularityTone(classification);
  const display = Number.isFinite(sri) ? Math.round(sri) : 0;
  const pct = Math.max(0, Math.min(100, display));
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - pct / 100);

  return (
    <div className={`flex items-center gap-4 rounded-lg ${tone.bg} p-4`}>
      <div
        className={`relative h-32 w-32 shrink-0 ring-2 ${tone.ring} rounded-full`}
      >
        <svg
          viewBox="0 0 120 120"
          className="h-full w-full -rotate-90"
          role="img"
          aria-label={`Sleep Regularity Index ${classification === "insufficient_data" ? "unavailable" : display}`}
        >
          <title>Sleep Regularity Index</title>
          <circle
            cx="60"
            cy="60"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="10"
            className="text-bg-muted/40"
          />
          <circle
            cx="60"
            cy="60"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="10"
            strokeLinecap="round"
            className={tone.text}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className={`text-3xl font-semibold leading-none ${tone.text}`}>
            {classification === "insufficient_data" ? "—" : display}
          </div>
          <div className="mt-1 text-[10px] font-medium uppercase tracking-wide text-muted">
            SRI
          </div>
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className={`text-base font-semibold ${tone.text}`}>
          {classificationLabel(classification)}
        </div>
        <div className="mt-1 text-xs text-muted">
          Sleep Regularity Index measures how consistent your bedtime and wake
          time are night to night.
        </div>
      </div>
    </div>
  );
}

function PatternTab({
  regularity,
  baseline,
  loading,
  error,
}: {
  regularity: LifeOpsSleepRegularityResponse | null;
  baseline: LifeOpsPersonalBaselineResponse | null;
  loading: boolean;
  error: string | null;
}) {
  const noBaseline =
    !baseline ||
    (baseline.medianBedtimeLocalHour === null &&
      baseline.medianWakeLocalHour === null &&
      baseline.medianSleepDurationMin === null);

  return (
    <div className="space-y-4">
      {error ? (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {error}
        </div>
      ) : null}

      {loading && !regularity && !baseline ? (
        <div className="flex items-center gap-2 py-4 text-xs text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading pattern...
        </div>
      ) : null}

      {regularity ? (
        <SriGauge
          sri={regularity.sri}
          classification={regularity.classification}
        />
      ) : null}

      {noBaseline ? (
        <div className="rounded-lg border border-border/20 bg-bg/24 px-3 py-6 text-center text-xs text-muted">
          Not enough data yet — keep tracking sleep for a week to see your
          pattern.
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricTile
              icon={<AlarmClock />}
              value={
                baseline.medianBedtimeLocalHour !== null
                  ? `${formatLocalHour(baseline.medianBedtimeLocalHour)} ${formatStddev(baseline.bedtimeStddevMin)}`.trim()
                  : "—"
              }
              label="Typical bedtime"
            />
            <MetricTile
              icon={<Sunrise />}
              value={
                baseline.medianWakeLocalHour !== null
                  ? `${formatLocalHour(baseline.medianWakeLocalHour)} ${formatStddev(baseline.wakeStddevMin)}`.trim()
                  : "—"
              }
              label="Typical wake"
            />
            <MetricTile
              icon={<Moon />}
              value={formatDurationMinutes(baseline.medianSleepDurationMin)}
              label="Typical duration"
            />
          </div>
          <div className="text-[11px] text-muted">
            Based on {baseline.sampleSize}{" "}
            {baseline.sampleSize === 1 ? "night" : "nights"} over the last{" "}
            {baseline.windowDays} days
            {regularity && regularity.sampleSize !== baseline.sampleSize
              ? ` (regularity from ${regularity.sampleSize} ${regularity.sampleSize === 1 ? "night" : "nights"})`
              : ""}
            .
          </div>
        </>
      )}
    </div>
  );
}

export function LifeOpsSleepSection() {
  const [tab, setTab] = useState<SleepTab>("tonight");
  const [includeNaps, setIncludeNaps] = useState(false);
  const [historyWindow, setHistoryWindow] =
    useState<WindowDays>(DEFAULT_WINDOW);

  const [overview, setOverview] = useState<LifeOpsOverview | null>(null);
  const [tonightLoading, setTonightLoading] = useState(false);
  const [tonightError, setTonightError] = useState<string | null>(null);

  const [history, setHistory] = useState<LifeOpsSleepHistoryResponse | null>(
    null,
  );
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const [regularity, setRegularity] =
    useState<LifeOpsSleepRegularityResponse | null>(null);
  const [baseline, setBaseline] =
    useState<LifeOpsPersonalBaselineResponse | null>(null);
  const [patternLoading, setPatternLoading] = useState(false);
  const [patternError, setPatternError] = useState<string | null>(null);

  const loadTonight = useCallback(async () => {
    setTonightLoading(true);
    setTonightError(null);
    try {
      setOverview(await client.getLifeOpsOverview());
    } catch (cause) {
      setTonightError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : "Sleep failed to load.",
      );
    } finally {
      setTonightLoading(false);
    }
  }, []);

  const loadHistory = useCallback(
    async (windowDays: WindowDays, naps: boolean) => {
      setHistoryLoading(true);
      setHistoryError(null);
      try {
        setHistory(
          await client.getLifeOpsSleepHistory({
            windowDays,
            includeNaps: naps,
          }),
        );
      } catch (cause) {
        setHistoryError(
          cause instanceof Error && cause.message.trim().length > 0
            ? cause.message.trim()
            : "Sleep history failed to load.",
        );
      } finally {
        setHistoryLoading(false);
      }
    },
    [],
  );

  const loadPattern = useCallback(async () => {
    setPatternLoading(true);
    setPatternError(null);
    try {
      const [reg, base] = await Promise.all([
        client.getLifeOpsSleepRegularity(),
        client.getLifeOpsPersonalBaseline(),
      ]);
      setRegularity(reg);
      setBaseline(base);
    } catch (cause) {
      setPatternError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : "Sleep pattern failed to load.",
      );
    } finally {
      setPatternLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTonight();
  }, [loadTonight]);

  useEffect(() => {
    if (tab === "history") {
      void loadHistory(historyWindow, includeNaps);
    }
  }, [tab, historyWindow, includeNaps, loadHistory]);

  useEffect(() => {
    if (tab === "pattern") {
      void loadPattern();
    }
  }, [tab, loadPattern]);

  const refreshActiveTab = useCallback(() => {
    if (tab === "tonight") {
      void loadTonight();
      return;
    }
    if (tab === "history") {
      void loadHistory(historyWindow, includeNaps);
      return;
    }
    void loadPattern();
  }, [tab, historyWindow, includeNaps, loadTonight, loadHistory, loadPattern]);

  const refreshing =
    (tab === "tonight" && tonightLoading) ||
    (tab === "history" && historyLoading) ||
    (tab === "pattern" && patternLoading);

  const schedule = overview?.schedule ?? null;

  return (
    <div className="space-y-4" data-testid="lifeops-sleep-section">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/20 pb-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight text-txt">
            Sleep
          </h1>
        </div>
        <div className="flex items-center gap-3">
          {tab === "history" ? (
            <NapToggle value={includeNaps} onChange={setIncludeNaps} />
          ) : null}
          <button
            type="button"
            aria-label="Refresh sleep"
            title="Refresh"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border/20 bg-bg/30 text-muted transition-colors hover:border-accent/30 hover:text-txt disabled:opacity-40"
            onClick={refreshActiveTab}
            disabled={refreshing}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
              aria-hidden
            />
          </button>
        </div>
      </header>

      <div
        className="inline-flex items-center gap-1 rounded-lg border border-border/20 bg-bg/30 p-1"
        role="tablist"
        aria-label="Sleep view"
      >
        <TabButton
          active={tab === "tonight"}
          label="Tonight"
          onClick={() => setTab("tonight")}
        />
        <TabButton
          active={tab === "history"}
          label="History"
          onClick={() => setTab("history")}
        />
        <TabButton
          active={tab === "pattern"}
          label="Pattern"
          onClick={() => setTab("pattern")}
        />
      </div>

      {tab === "tonight" ? (
        <>
          {tonightError ? (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
              {tonightError}
            </div>
          ) : null}
          {tonightLoading && !overview ? (
            <div className="flex items-center gap-2 py-4 text-xs text-muted">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Loading sleep...
            </div>
          ) : null}
          <TonightTab schedule={schedule} />
        </>
      ) : null}

      {tab === "history" ? (
        <HistoryTab
          data={history}
          loading={historyLoading}
          error={historyError}
          windowDays={historyWindow}
          onWindowChange={setHistoryWindow}
        />
      ) : null}

      {tab === "pattern" ? (
        <PatternTab
          regularity={regularity}
          baseline={baseline}
          loading={patternLoading}
          error={patternError}
        />
      ) : null}
    </div>
  );
}
