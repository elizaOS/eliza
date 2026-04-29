import { client } from "@elizaos/app-core";
import {
  AppWindow,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  AtSign,
  CalendarRange,
  Eye,
  Globe2,
  Loader2,
  MessageSquareText,
  Monitor,
  PlaySquare,
  RefreshCw,
  Send,
  Share2,
  ShieldBan,
  Smartphone,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  LifeOpsScreenTimeBreakdown,
  LifeOpsSocialHabitSummary,
} from "../api/client-lifeops.js";
import type { LifeOpsSection } from "../hooks/useLifeOpsSection.js";
import {
  BucketBars,
  DonutChart,
  formatDurationSeconds,
  HabitPanel,
  MetricTile,
  StackedBar,
  startOfLocalDayIso,
} from "./LifeOpsHabitVisuals.js";

type RangeKey = "today" | "this-week" | "7d" | "30d";

const RANGE_OPTIONS: Array<{ key: RangeKey; label: string }> = [
  { key: "today", label: "Today" },
  { key: "this-week", label: "This Week" },
  { key: "7d", label: "Last 7d" },
  { key: "30d", label: "Last 30d" },
];

const CACHE_TTL_MS = 30_000;

type Period = { since: string; until: string };
type WebsiteBlockerStatus = Awaited<
  ReturnType<typeof client.getWebsiteBlockerStatus>
>;
type AppBlockerStatus = Awaited<ReturnType<typeof client.getAppBlockerStatus>>;
type SocialDataSource = LifeOpsSocialHabitSummary["dataSources"][number];

type UnifiedSocialBlockStatus = {
  active: boolean;
  label: string;
  details: string[];
};

function startOfLocalDay(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function computeRange(range: RangeKey): Period {
  const now = new Date();
  const until = now.toISOString();
  if (range === "today") {
    return { since: startOfLocalDay(now).toISOString(), until };
  }
  if (range === "this-week") {
    const startToday = startOfLocalDay(now);
    const dayOfWeek = startToday.getDay(); // Sunday = 0
    const since = addDays(startToday, -dayOfWeek);
    return { since: since.toISOString(), until };
  }
  if (range === "7d") {
    const since = addDays(startOfLocalDay(now), -6);
    return { since: since.toISOString(), until };
  }
  const since = addDays(startOfLocalDay(now), -29);
  return { since: since.toISOString(), until };
}

function computePriorRange(range: RangeKey): Period | null {
  if (range === "today") return null;
  const current = computeRange(range);
  const sinceMs = Date.parse(current.since);
  const untilMs = Date.parse(current.until);
  const span = untilMs - sinceMs;
  return {
    since: new Date(sinceMs - span).toISOString(),
    until: current.since,
  };
}

function enumerateDays(period: Period): Date[] {
  const days: Date[] = [];
  const start = startOfLocalDay(new Date(Date.parse(period.since)));
  const endMs = Date.parse(period.until);
  let cursor = start;
  while (cursor.getTime() <= endMs) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

function formatDayLabel(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
  }).format(date);
}

function socialServiceSeconds(
  summary: LifeOpsSocialHabitSummary | null,
  key: string,
): number {
  return summary?.services.find((item) => item.key === key)?.totalSeconds ?? 0;
}

function formatInlineList(values: string[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

function formatEndsAt(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

function summarizeWebsiteBlock(status: WebsiteBlockerStatus): string {
  const count = status.websites.length;
  const targetLabel =
    count === 0
      ? "websites"
      : count === 1
        ? status.websites[0]
        : `${count} websites`;
  const endsAt = formatEndsAt(status.endsAt);
  return endsAt ? `Websites: ${targetLabel} until ${endsAt}` : `Websites: ${targetLabel}`;
}

function summarizeAppBlock(status: AppBlockerStatus): string {
  const count = status.blockedCount;
  const platform = status.platform ? ` on ${status.platform.toUpperCase()}` : "";
  const endsAt = formatEndsAt(status.endsAt);
  const countLabel = `${count} app${count === 1 ? "" : "s"}`;
  return endsAt
    ? `Apps: ${countLabel}${platform} until ${endsAt}`
    : `Apps: ${countLabel}${platform}`;
}

function buildUnifiedSocialBlockStatus(
  website: WebsiteBlockerStatus,
  app: AppBlockerStatus,
): UnifiedSocialBlockStatus {
  const websiteActive = website.available && website.active;
  const appActive = app.available && app.active;
  if (websiteActive && appActive) {
    return {
      active: true,
      label: "Websites and apps blocked",
      details: [summarizeWebsiteBlock(website), summarizeAppBlock(app)],
    };
  }
  if (websiteActive) {
    return {
      active: true,
      label: "Websites blocked",
      details: [summarizeWebsiteBlock(website)],
    };
  }
  if (appActive) {
    return {
      active: true,
      label: "Apps blocked",
      details: [summarizeAppBlock(app)],
    };
  }

  const idleDetails: string[] = [];
  if (website.available) {
    idleDetails.push("Website blocker idle");
  }
  if (app.available) {
    idleDetails.push("App blocker idle");
  }
  if (idleDetails.length === 0) {
    idleDetails.push("No website or app blocker is available on this platform");
  }
  return {
    active: false,
    label: "No active social block",
    details: idleDetails,
  };
}

function setupWarningLabel(sources: SocialDataSource[]): string {
  return formatInlineList(sources.map((source) => source.label));
}

function sourceTone(state: "live" | "partial" | "unwired"): string {
  switch (state) {
    case "live":
      return "bg-emerald-400";
    case "partial":
      return "bg-amber-300";
    default:
      return "bg-muted";
  }
}

function deltaPercent(current: number, prior: number): number | null {
  if (prior <= 0) {
    return current > 0 ? null : 0;
  }
  return Math.round(((current - prior) / prior) * 100);
}

function DeltaBadge({ percent }: { percent: number | null }) {
  if (percent === null) {
    return (
      <div className="mt-1 inline-flex items-center gap-1 text-[10px] font-medium text-muted">
        <ArrowRight className="h-3 w-3" aria-hidden />
        new
      </div>
    );
  }
  const Icon = percent > 0 ? ArrowUp : percent < 0 ? ArrowDown : ArrowRight;
  const magnitude = Math.abs(percent);
  return (
    <div className="mt-1 inline-flex items-center gap-1 text-[10px] font-medium text-muted">
      <Icon className="h-3 w-3" aria-hidden />
      {magnitude}% vs prior
    </div>
  );
}

function HistoryStrip({
  days,
}: {
  days: Array<{ date: Date; totalSeconds: number }>;
}) {
  const maxSeconds = days.reduce(
    (max, day) => (day.totalSeconds > max ? day.totalSeconds : max),
    0,
  );
  return (
    <div className="flex items-end gap-1.5 overflow-x-auto py-2">
      {days.map((day) => {
        const ratio = maxSeconds > 0 ? day.totalSeconds / maxSeconds : 0;
        const heightPct = Math.max(2, Math.round(ratio * 100));
        return (
          <div
            key={day.date.toISOString()}
            className="flex min-w-[18px] flex-1 flex-col items-center gap-1"
            title={`${formatDayLabel(day.date)} - ${formatDurationSeconds(day.totalSeconds)}`}
          >
            <div className="flex h-20 w-full items-end">
              <div
                className="w-full rounded-sm bg-cyan-400/70"
                style={{ height: `${heightPct}%` }}
              />
            </div>
            <div className="text-[10px] font-medium tabular-nums text-muted">
              {formatDayLabel(day.date)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

type CacheEntry<T> = { value: T; fetchedAt: number };

type RangeData = {
  breakdown: LifeOpsScreenTimeBreakdown;
  social: LifeOpsSocialHabitSummary;
};

type PriorData = {
  breakdown: LifeOpsScreenTimeBreakdown;
  social: LifeOpsSocialHabitSummary;
};

type HistoryData = Array<{ date: Date; totalSeconds: number }>;

async function fetchRangeData(period: Period): Promise<RangeData> {
  const [breakdown, social] = await Promise.all([
    client.getLifeOpsScreenTimeBreakdown({
      since: period.since,
      until: period.until,
      topN: 16,
    }),
    client.getLifeOpsSocialHabitSummary({
      since: period.since,
      until: period.until,
      topN: 12,
    }),
  ]);
  return { breakdown, social };
}

async function fetchHistoryData(period: Period): Promise<HistoryData> {
  const days = enumerateDays(period);
  const now = Date.now();
  const results = await Promise.all(
    days.map(async (date) => {
      const dayStart = startOfLocalDay(date);
      const dayEnd = addDays(dayStart, 1);
      const sinceIso = dayStart.toISOString();
      const untilIso = new Date(
        Math.min(dayEnd.getTime(), now),
      ).toISOString();
      const breakdown = await client.getLifeOpsScreenTimeBreakdown({
        since: sinceIso,
        until: untilIso,
        topN: 1,
      });
      return { date: dayStart, totalSeconds: breakdown.totalSeconds };
    }),
  );
  return results;
}

export function LifeOpsScreenTimeSection({
  onNavigate,
}: {
  onNavigate?: (section: LifeOpsSection) => void;
}) {
  const [range, setRange] = useState<RangeKey>("today");
  const [data, setData] = useState<RangeData | null>(null);
  const [priorData, setPriorData] = useState<PriorData | null>(null);
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [blockStatus, setBlockStatus] =
    useState<UnifiedSocialBlockStatus | null>(null);
  const [blockStatusError, setBlockStatusError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dataCache = useRef<Map<RangeKey, CacheEntry<RangeData>>>(new Map());
  const priorCache = useRef<Map<RangeKey, CacheEntry<PriorData>>>(new Map());
  const historyCache = useRef<Map<RangeKey, CacheEntry<HistoryData>>>(
    new Map(),
  );

  const load = useCallback(
    async (key: RangeKey, force = false) => {
      setLoading(true);
      setError(null);
      const now = Date.now();
      const cached = dataCache.current.get(key);
      const cachedPrior = priorCache.current.get(key);
      const cachedHistory = historyCache.current.get(key);
      const fresh = (entry: CacheEntry<unknown> | undefined) =>
        entry !== undefined && now - entry.fetchedAt < CACHE_TTL_MS;

      if (
        !force &&
        fresh(cached) &&
        (key === "today" || fresh(cachedPrior)) &&
        (key === "today" || fresh(cachedHistory))
      ) {
        setData(cached!.value);
        setPriorData(cachedPrior?.value ?? null);
        setHistory(cachedHistory?.value ?? null);
        setLoading(false);
        return;
      }

      try {
        const period = computeRange(key);
        const priorPeriod = computePriorRange(key);
        const [rangeData, priorRangeData, historyData] = await Promise.all([
          fetchRangeData(period),
          priorPeriod ? fetchRangeData(priorPeriod) : Promise.resolve(null),
          key === "today"
            ? Promise.resolve(null)
            : fetchHistoryData(period),
        ]);
        const stamp = Date.now();
        dataCache.current.set(key, { value: rangeData, fetchedAt: stamp });
        if (priorRangeData) {
          priorCache.current.set(key, {
            value: priorRangeData,
            fetchedAt: stamp,
          });
        } else {
          priorCache.current.delete(key);
        }
        if (historyData) {
          historyCache.current.set(key, {
            value: historyData,
            fetchedAt: stamp,
          });
        } else {
          historyCache.current.delete(key);
        }
        setData(rangeData);
        setPriorData(priorRangeData);
        setHistory(historyData);
      } catch (cause) {
        setError(
          cause instanceof Error && cause.message.trim().length > 0
            ? cause.message.trim()
            : "Screen time failed to load.",
        );
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const loadBlockStatus = useCallback(async () => {
    try {
      const [website, app] = await Promise.all([
        client.getWebsiteBlockerStatus(),
        client.getAppBlockerStatus(),
      ]);
      setBlockStatus(buildUnifiedSocialBlockStatus(website, app));
      setBlockStatusError(null);
    } catch (cause) {
      setBlockStatus(null);
      setBlockStatusError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : "Block status failed to load.",
      );
    }
  }, []);

  useEffect(() => {
    void load(range);
  }, [load, range]);

  useEffect(() => {
    void loadBlockStatus();
  }, [loadBlockStatus]);

  const breakdown = data?.breakdown ?? null;
  const social = data?.social ?? null;
  const priorBreakdown = priorData?.breakdown ?? null;
  const priorSocial = priorData?.social ?? null;

  const totalSeconds = breakdown?.totalSeconds ?? 0;
  const appSeconds =
    breakdown?.bySource.find((item) => item.key === "app")?.totalSeconds ?? 0;
  const webSeconds =
    breakdown?.bySource.find((item) => item.key === "website")?.totalSeconds ??
    0;
  const phoneSeconds =
    breakdown?.byDevice.find((item) => item.key === "phone")?.totalSeconds ?? 0;
  const categories = (breakdown?.byCategory ?? []).filter(
    (item) => item.totalSeconds > 0,
  );
  const devices = (breakdown?.byDevice ?? []).filter(
    (item) => item.totalSeconds > 0,
  );
  const browsers = (breakdown?.byBrowser ?? []).filter(
    (item) => item.totalSeconds > 0,
  );
  const topTargets =
    breakdown?.items
      .filter((item) => item.totalSeconds > 0)
      .map((item) => ({
        key: `${item.source}:${item.identifier}`,
        label: item.displayName,
        totalSeconds: item.totalSeconds,
      })) ?? [];

  const socialSeconds = social?.totalSeconds ?? 0;
  const youtubeSeconds = socialServiceSeconds(social, "youtube");
  const xSeconds = socialServiceSeconds(social, "x");
  const services = (social?.services ?? []).filter(
    (item) => item.totalSeconds > 0,
  );
  const surfaces = (social?.surfaces ?? []).filter(
    (item) => item.totalSeconds > 0,
  );
  const sessionBuckets =
    social?.sessions
      .filter((item) => item.totalSeconds > 0)
      .map((item) => ({
        key: `${item.source}:${item.identifier}`,
        label: item.serviceLabel ?? item.displayName,
        totalSeconds: item.totalSeconds,
      })) ?? [];
  const channels = (social?.messages.channels ?? []).filter(
    (channel) =>
      channel.opened > 0 || channel.outbound > 0 || channel.inbound > 0,
  );
  const messageOpened = social?.messages.opened ?? 0;
  const messageOutbound = social?.messages.outbound ?? 0;
  const messageInbound = social?.messages.inbound ?? 0;
  const hasMessageActivity =
    messageOpened > 0 || messageOutbound > 0 || messageInbound > 0;
  const setupSources = (social?.dataSources ?? []).filter(
    (source) => source.state !== "live",
  );

  const hasUsage =
    totalSeconds > 0 ||
    categories.length > 0 ||
    devices.length > 0 ||
    browsers.length > 0 ||
    topTargets.length > 0 ||
    socialSeconds > 0 ||
    services.length > 0 ||
    surfaces.length > 0 ||
    sessionBuckets.length > 0 ||
    hasMessageActivity;

  const showDeltas = range !== "today" && priorData !== null;
  const priorTotalSeconds = priorBreakdown?.totalSeconds ?? 0;
  const priorAppSeconds =
    priorBreakdown?.bySource.find((item) => item.key === "app")
      ?.totalSeconds ?? 0;
  const priorWebSeconds =
    priorBreakdown?.bySource.find((item) => item.key === "website")
      ?.totalSeconds ?? 0;
  const priorPhoneSeconds =
    priorBreakdown?.byDevice.find((item) => item.key === "phone")
      ?.totalSeconds ?? 0;
  const priorSocialSeconds = priorSocial?.totalSeconds ?? 0;
  const priorYoutubeSeconds = socialServiceSeconds(priorSocial, "youtube");
  const priorXSeconds = socialServiceSeconds(priorSocial, "x");
  const priorMessageOpened = priorSocial?.messages.opened ?? 0;

  const totalLabel = useMemo(() => {
    switch (range) {
      case "today":
        return "Today";
      case "this-week":
        return "This Week";
      case "7d":
        return "Last 7d";
      case "30d":
        return "Last 30d";
    }
  }, [range]);

  const metricTiles = [
    {
      key: "total",
      icon: <Monitor />,
      value: formatDurationSeconds(totalSeconds),
      label: totalLabel,
      visible: totalSeconds > 0,
      delta: showDeltas
        ? deltaPercent(totalSeconds, priorTotalSeconds)
        : undefined,
    },
    {
      key: "apps",
      icon: <AppWindow />,
      value: formatDurationSeconds(appSeconds),
      label: "Apps",
      visible: appSeconds > 0,
      delta: showDeltas
        ? deltaPercent(appSeconds, priorAppSeconds)
        : undefined,
    },
    {
      key: "web",
      icon: <Globe2 />,
      value: formatDurationSeconds(webSeconds),
      label: "Web",
      visible: webSeconds > 0,
      delta: showDeltas
        ? deltaPercent(webSeconds, priorWebSeconds)
        : undefined,
    },
    {
      key: "phone",
      icon: <Smartphone />,
      value: formatDurationSeconds(phoneSeconds),
      label: "Phone",
      visible: phoneSeconds > 0,
      delta: showDeltas
        ? deltaPercent(phoneSeconds, priorPhoneSeconds)
        : undefined,
    },
    {
      key: "social",
      icon: <Share2 />,
      value: formatDurationSeconds(socialSeconds),
      label: "Social",
      visible: socialSeconds > 0,
      delta: showDeltas
        ? deltaPercent(socialSeconds, priorSocialSeconds)
        : undefined,
    },
    {
      key: "youtube",
      icon: <PlaySquare />,
      value: formatDurationSeconds(youtubeSeconds),
      label: "YouTube",
      visible: youtubeSeconds > 0,
      delta: showDeltas
        ? deltaPercent(youtubeSeconds, priorYoutubeSeconds)
        : undefined,
    },
    {
      key: "x",
      icon: <AtSign />,
      value: formatDurationSeconds(xSeconds),
      label: "X",
      visible: xSeconds > 0,
      delta: showDeltas
        ? deltaPercent(xSeconds, priorXSeconds)
        : undefined,
    },
    {
      key: "opened",
      icon: <MessageSquareText />,
      value: String(messageOpened),
      label: "Opened",
      visible: messageOpened > 0,
      delta: showDeltas
        ? deltaPercent(messageOpened, priorMessageOpened)
        : undefined,
    },
  ].filter((item) => item.visible);

  const showHistory = range !== "today" && history !== null && history.length > 0;

  return (
    <div className="space-y-4" data-testid="lifeops-screen-time-section">
      <header className="flex items-center justify-between gap-3 border-b border-border/20 pb-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight text-txt">
            Screen Time
          </h1>
        </div>
        <button
          type="button"
          aria-label="Refresh screen time"
          title="Refresh"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border/20 bg-bg/30 text-muted transition-colors hover:border-accent/30 hover:text-txt disabled:opacity-40"
          onClick={() => {
            void load(range, true);
            void loadBlockStatus();
          }}
          disabled={loading}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            aria-hidden
          />
        </button>
      </header>

      <div
        className="flex flex-wrap gap-2"
        role="tablist"
        aria-label="Date range"
      >
        {RANGE_OPTIONS.map((option) => {
          const active = option.key === range;
          return (
            <button
              key={option.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setRange(option.key)}
              className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors ${
                active
                  ? "border-accent/40 bg-accent/15 text-txt"
                  : "border-border/20 bg-bg/30 text-muted hover:border-accent/30 hover:text-txt"
              }`}
            >
              {option.key === range ? (
                <CalendarRange className="h-3 w-3" aria-hidden />
              ) : null}
              {option.label}
            </button>
          );
        })}
      </div>

      {error ? (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {error}
        </div>
      ) : null}

      {loading && !breakdown && !social ? (
        <div className="flex items-center gap-2 py-4 text-xs text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading screen time...
        </div>
      ) : null}

      {!loading && !error && (breakdown || social) && !hasUsage ? (
        <HabitPanel title="Screen Time" icon={<Monitor />}>
          <div className="py-3 text-sm text-muted">
            No screen activity in this range.
          </div>
        </HabitPanel>
      ) : (
        <>
          {metricTiles.length > 0 ? (
            <div
              className={
                metricTiles.length === 1
                  ? "grid gap-3"
                  : "grid grid-cols-2 gap-3 xl:grid-cols-4"
              }
            >
              {metricTiles.map((tile) => (
                <div key={tile.key} className="min-w-0">
                  <MetricTile
                    icon={tile.icon}
                    value={tile.value}
                    label={tile.label}
                  />
                  {tile.delta !== undefined ? (
                    <div className="px-3">
                      <DeltaBadge percent={tile.delta} />
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {showHistory ? (
            <HabitPanel title="Daily History" icon={<CalendarRange />}>
              <HistoryStrip days={history!} />
            </HabitPanel>
          ) : null}

          {categories.length > 0 ? (
            <HabitPanel
              title="Categories"
              icon={<Monitor />}
              className="xl:col-span-2"
            >
              <div className="flex flex-col gap-5 lg:flex-row lg:items-center">
                <DonutChart
                  items={categories}
                  totalSeconds={totalSeconds}
                  label={totalLabel}
                />
                <div className="min-w-0 flex-1">
                  <StackedBar items={categories} totalSeconds={totalSeconds} />
                  <div className="mt-4">
                    <BucketBars
                      items={categories}
                      totalSeconds={totalSeconds}
                    />
                  </div>
                </div>
              </div>
            </HabitPanel>
          ) : null}

          <div className="grid gap-4 xl:grid-cols-3">
            {devices.length > 0 ? (
              <HabitPanel title="Devices" icon={<Smartphone />}>
                <BucketBars items={devices} totalSeconds={totalSeconds} />
              </HabitPanel>
            ) : null}
            {browsers.length > 0 ? (
              <HabitPanel title="Browsers" icon={<Globe2 />}>
                <BucketBars items={browsers} totalSeconds={webSeconds} />
              </HabitPanel>
            ) : null}
            {topTargets.length > 0 ? (
              <HabitPanel title="Apps and Sites" icon={<AppWindow />}>
                <BucketBars
                  items={topTargets}
                  totalSeconds={totalSeconds}
                  limit={8}
                />
              </HabitPanel>
            ) : null}
          </div>

          {services.length > 0 ? (
            <HabitPanel title="Social Platforms" icon={<Share2 />}>
              <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
                <DonutChart
                  items={services}
                  totalSeconds={socialSeconds}
                  label="Social"
                />
                <div className="min-w-0 flex-1">
                  <StackedBar items={services} totalSeconds={socialSeconds} />
                  <div className="mt-4">
                    <BucketBars
                      items={services}
                      totalSeconds={socialSeconds}
                      emptyLabel="No social time"
                    />
                  </div>
                </div>
              </div>
            </HabitPanel>
          ) : null}

          {hasMessageActivity || channels.length > 0 ? (
            <HabitPanel title="Messages" icon={<MessageSquareText />}>
              <div className="grid grid-cols-3 gap-2">
                <MetricTile
                  icon={<Eye />}
                  value={String(messageOpened)}
                  label="Opened"
                />
                <MetricTile
                  icon={<Send />}
                  value={String(messageOutbound)}
                  label="Sent"
                />
                <MetricTile
                  icon={<MessageSquareText />}
                  value={String(messageInbound)}
                  label="Received"
                />
              </div>
              <div className="mt-3">
                {channels.map((channel) => (
                  <div
                    key={channel.channel}
                    className="flex items-center justify-between gap-3 border-t border-border/10 py-2 text-xs"
                  >
                    <span className="font-medium text-txt/90">
                      {channel.label}
                    </span>
                    <span className="inline-flex items-center gap-2 tabular-nums text-muted">
                      <span className="inline-flex items-center gap-1">
                        <Eye className="h-3 w-3" aria-hidden />
                        {channel.opened}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Send className="h-3 w-3" aria-hidden />
                        {channel.outbound}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </HabitPanel>
          ) : null}

          {surfaces.length > 0 || sessionBuckets.length > 0 ? (
            <div className="grid gap-4 xl:grid-cols-2">
              {surfaces.length > 0 ? (
                <HabitPanel title="Surfaces" icon={<Monitor />}>
                  <BucketBars items={surfaces} totalSeconds={socialSeconds} />
                </HabitPanel>
              ) : null}
              {sessionBuckets.length > 0 ? (
                <HabitPanel title="Sessions" icon={<Share2 />}>
                  <BucketBars
                    items={sessionBuckets}
                    totalSeconds={socialSeconds}
                    limit={8}
                  />
                </HabitPanel>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      {(social?.dataSources ?? []).length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {(social?.dataSources ?? []).map((source) => (
            <span
              key={source.id}
              title={source.label}
              className="inline-flex h-8 items-center gap-2 rounded-lg border border-border/12 bg-bg/24 px-2 text-xs font-medium text-muted"
            >
              <span
                className={`h-2 w-2 rounded-full ${sourceTone(source.state)}`}
              />
              {source.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
