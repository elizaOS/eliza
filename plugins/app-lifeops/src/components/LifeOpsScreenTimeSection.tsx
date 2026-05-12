import { client } from "@elizaos/ui";
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
  LifeOpsScreenTimeHistoryResponse,
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
} from "./LifeOpsHabitVisuals.js";

type RangeKey = "today" | "this-week" | "7d" | "30d";

const RANGE_OPTIONS: Array<{ key: RangeKey; label: string }> = [
  { key: "today", label: "Today" },
  { key: "this-week", label: "This Week" },
  { key: "7d", label: "Last 7d" },
  { key: "30d", label: "Last 30d" },
];

const CACHE_TTL_MS = 30_000;

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

type BlockStatusLoadResult<T> =
  | { status: T; error: null }
  | { status: null; error: string };

function errorLabel(cause: unknown): string {
  return cause instanceof Error && cause.message.trim().length > 0
    ? cause.message.trim()
    : "status failed to load";
}

function unavailableWebsiteBlockerStatus(reason: string): WebsiteBlockerStatus {
  return {
    active: false,
    available: false,
    canUnblockEarly: false,
    elevationPromptMethod: null,
    endsAt: null,
    engine: "hosts-file",
    hostsFilePath: null,
    platform: "unknown",
    requiresElevation: false,
    supportsElevationPrompt: false,
    websites: [],
    reason,
  };
}

function unavailableAppBlockerStatus(reason: string): AppBlockerStatus {
  return {
    active: false,
    available: false,
    blockedCount: 0,
    blockedPackageNames: [],
    endsAt: null,
    engine: "none",
    permissionStatus: "not-applicable",
    platform: "unknown",
    reason,
  };
}

async function loadStatus<T>(
  request: () => Promise<T>,
): Promise<BlockStatusLoadResult<T>> {
  try {
    return { status: await request(), error: null };
  } catch (cause) {
    return { status: null, error: errorLabel(cause) };
  }
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
  return endsAt
    ? `Websites: ${targetLabel} until ${endsAt}`
    : `Websites: ${targetLabel}`;
}

function summarizeAppBlock(status: AppBlockerStatus): string {
  const count = status.blockedCount;
  const platform = status.platform
    ? ` on ${status.platform.toUpperCase()}`
    : "";
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
  days: Array<{ date: string; label: string; totalSeconds: number }>;
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
            key={day.date}
            className="flex min-w-[18px] flex-1 flex-col items-center gap-1"
            title={`${day.label} - ${formatDurationSeconds(day.totalSeconds)}`}
          >
            <div className="flex h-20 w-full items-end">
              <div
                className="w-full rounded-sm bg-cyan-400/70"
                style={{ height: `${heightPct}%` }}
              />
            </div>
            <div className="text-[10px] font-medium tabular-nums text-muted">
              {day.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}

type CacheEntry<T> = { value: T; fetchedAt: number };

type RangeData = LifeOpsScreenTimeHistoryResponse;

async function fetchRangeData(range: RangeKey): Promise<RangeData> {
  return client.getLifeOpsScreenTimeHistory({
    range,
    topN: 16,
    socialTopN: 12,
  });
}

export function LifeOpsScreenTimeSection({
  onNavigate,
}: {
  onNavigate?: (section: LifeOpsSection) => void;
}) {
  const [range, setRange] = useState<RangeKey>("today");
  const [data, setData] = useState<RangeData | null>(null);
  const [blockStatus, setBlockStatus] =
    useState<UnifiedSocialBlockStatus | null>(null);
  const [blockStatusError, setBlockStatusError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dataCache = useRef<Map<RangeKey, CacheEntry<RangeData>>>(new Map());

  const load = useCallback(async (key: RangeKey, force = false) => {
    setLoading(true);
    setError(null);
    const now = Date.now();
    const cached = dataCache.current.get(key);
    const fresh = (entry: CacheEntry<unknown> | undefined) =>
      entry !== undefined && now - entry.fetchedAt < CACHE_TTL_MS;

    if (!force && cached && fresh(cached)) {
      setData(cached.value);
      setLoading(false);
      return;
    }

    try {
      const rangeData = await fetchRangeData(key);
      const stamp = Date.now();
      dataCache.current.set(key, { value: rangeData, fetchedAt: stamp });
      setData(rangeData);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : "Screen time failed to load.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const loadBlockStatus = useCallback(async () => {
    const [websiteResult, appResult] = await Promise.all([
      loadStatus(() => client.getWebsiteBlockerStatus()),
      loadStatus(() => client.getAppBlockerStatus()),
    ]);

    if (!websiteResult.status && !appResult.status) {
      setBlockStatus(null);
      setBlockStatusError(
        [
          `Website blocker: ${websiteResult.error}`,
          `App blocker: ${appResult.error}`,
        ].join(" "),
      );
      return;
    }

    const website =
      websiteResult.status ??
      unavailableWebsiteBlockerStatus(websiteResult.error);
    const app =
      appResult.status ?? unavailableAppBlockerStatus(appResult.error);
    setBlockStatus(buildUnifiedSocialBlockStatus(website, app));
    setBlockStatusError(
      [websiteResult, appResult]
        .filter((result) => result.error)
        .map((result) => result.error)
        .join(" ") || null,
    );
  }, []);

  useEffect(() => {
    void load(range);
  }, [load, range]);

  useEffect(() => {
    void loadBlockStatus();
  }, [loadBlockStatus]);

  const breakdown = data?.breakdown ?? null;
  const social = data?.social ?? null;
  const metrics = data?.metrics ?? null;
  const visible = data?.visible ?? null;
  const totalSeconds = metrics?.totalSeconds ?? 0;
  const appSeconds = metrics?.appSeconds ?? 0;
  const webSeconds = metrics?.webSeconds ?? 0;
  const phoneSeconds = metrics?.phoneSeconds ?? 0;
  const socialSeconds = metrics?.socialSeconds ?? 0;
  const youtubeSeconds = metrics?.youtubeSeconds ?? 0;
  const xSeconds = metrics?.xSeconds ?? 0;
  const messageOpened = metrics?.messageOpened ?? 0;
  const messageOutbound = metrics?.messageOutbound ?? 0;
  const messageInbound = metrics?.messageInbound ?? 0;
  const categories = visible?.categories ?? [];
  const devices = visible?.devices ?? [];
  const browsers = visible?.browsers ?? [];
  const topTargets = visible?.topTargets ?? [];
  const services = visible?.services ?? [];
  const surfaces = visible?.surfaces ?? [];
  const sessionBuckets = visible?.sessionBuckets ?? [];
  const channels = visible?.channels ?? [];
  const setupSources = visible?.setupSources ?? [];
  const hasMessageActivity = visible?.hasMessageActivity ?? false;
  const hasUsage = visible?.hasUsage ?? false;
  const showDeltas = metrics?.deltas !== null && metrics?.deltas !== undefined;

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
      delta: showDeltas ? metrics?.deltas?.totalPercent : undefined,
    },
    {
      key: "apps",
      icon: <AppWindow />,
      value: formatDurationSeconds(appSeconds),
      label: "Apps",
      visible: appSeconds > 0,
      delta: showDeltas ? metrics?.deltas?.appPercent : undefined,
    },
    {
      key: "web",
      icon: <Globe2 />,
      value: formatDurationSeconds(webSeconds),
      label: "Web",
      visible: webSeconds > 0,
      delta: showDeltas ? metrics?.deltas?.webPercent : undefined,
    },
    {
      key: "phone",
      icon: <Smartphone />,
      value: formatDurationSeconds(phoneSeconds),
      label: "Phone",
      visible: phoneSeconds > 0,
      delta: showDeltas ? metrics?.deltas?.phonePercent : undefined,
    },
    {
      key: "social",
      icon: <Share2 />,
      value: formatDurationSeconds(socialSeconds),
      label: "Social",
      visible: socialSeconds > 0,
      delta: showDeltas ? metrics?.deltas?.socialPercent : undefined,
    },
    {
      key: "youtube",
      icon: <PlaySquare />,
      value: formatDurationSeconds(youtubeSeconds),
      label: "YouTube",
      visible: youtubeSeconds > 0,
      delta: showDeltas ? metrics?.deltas?.youtubePercent : undefined,
    },
    {
      key: "x",
      icon: <AtSign />,
      value: formatDurationSeconds(xSeconds),
      label: "X",
      visible: xSeconds > 0,
      delta: showDeltas ? metrics?.deltas?.xPercent : undefined,
    },
    {
      key: "opened",
      icon: <MessageSquareText />,
      value: String(messageOpened),
      label: "Opened",
      visible: messageOpened > 0,
      delta: showDeltas ? metrics?.deltas?.messageOpenedPercent : undefined,
    },
  ].filter((item) => item.visible);

  const history = data?.history ?? [];
  const showHistory = range !== "today" && history.length > 0;

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

      {blockStatus ? (
        <HabitPanel title="Social Block Status" icon={<ShieldBan />}>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div
                className={`text-sm font-semibold ${
                  blockStatus.active ? "text-amber-200" : "text-txt"
                }`}
              >
                {blockStatus.label}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                {blockStatus.details.map((detail) => (
                  <span key={detail}>{detail}</span>
                ))}
              </div>
            </div>
          </div>
        </HabitPanel>
      ) : null}

      {blockStatusError ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Block status unavailable: {blockStatusError}
        </div>
      ) : null}

      {!loading && !error && !hasUsage && setupSources.length > 0 ? (
        <div
          className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3"
          data-testid="lifeops-screen-time-setup-warning"
        >
          <div className="flex min-w-0 items-start gap-3">
            <TriangleAlert
              className="mt-0.5 h-4 w-4 shrink-0 text-amber-300"
              aria-hidden
            />
            <div className="min-w-0">
              <div className="text-sm font-medium text-txt">
                Tracking setup incomplete
              </div>
              <div className="mt-1 text-xs leading-5 text-muted">
                Check {setupWarningLabel(setupSources)}.
              </div>
            </div>
          </div>
          {onNavigate ? (
            <button
              type="button"
              aria-label="Open LifeOps setup"
              title="Open setup"
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-border/16 bg-bg/50 px-3 text-xs font-medium text-txt transition-colors hover:border-accent/30 hover:text-accent"
              onClick={() => onNavigate("setup")}
            >
              Open setup
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}

      {!loading && !error && (breakdown || social) && !hasUsage ? (
        <HabitPanel title="Screen Time" icon={<Monitor />}>
          <div className="py-3 text-sm text-muted">
            {setupSources.length > 0
              ? `No screen activity in this range. Finish setup for ${setupWarningLabel(
                  setupSources,
                )}.`
              : "No screen activity in this range."}
          </div>
          {onNavigate && setupSources.length > 0 ? (
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1 rounded-md border border-border/16 bg-bg/50 px-3 text-xs font-medium text-txt transition-colors hover:border-accent/30 hover:text-accent"
              onClick={() => onNavigate("setup")}
            >
              Open setup
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null}
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
              <HistoryStrip days={history} />
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
