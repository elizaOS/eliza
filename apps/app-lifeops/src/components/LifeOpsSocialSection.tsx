import { client } from "@elizaos/app-core";
import {
  AtSign,
  Eye,
  Globe2,
  Loader2,
  MessageSquareText,
  Monitor,
  PlaySquare,
  RefreshCw,
  Send,
  Share2,
  Smartphone,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { LifeOpsSocialHabitSummary } from "../api/client-lifeops.js";
import {
  BucketBars,
  DonutChart,
  formatDurationSeconds,
  HabitPanel,
  MetricTile,
  StackedBar,
  startOfLocalDayIso,
} from "./LifeOpsHabitVisuals.js";

function socialServiceSeconds(
  summary: LifeOpsSocialHabitSummary | null,
  key: string,
): number {
  return summary?.services.find((item) => item.key === key)?.totalSeconds ?? 0;
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

export function LifeOpsSocialSection() {
  const [summary, setSummary] = useState<LifeOpsSocialHabitSummary | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSummary(
        await client.getLifeOpsSocialHabitSummary({
          since: startOfLocalDayIso(),
          until: new Date().toISOString(),
          topN: 12,
        }),
      );
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : "Social habits failed to load.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const totalSeconds = summary?.totalSeconds ?? 0;
  const youtubeSeconds = socialServiceSeconds(summary, "youtube");
  const xSeconds = socialServiceSeconds(summary, "x");
  const services = (summary?.services ?? []).filter(
    (item) => item.totalSeconds > 0,
  );
  const devices = (summary?.devices ?? []).filter(
    (item) => item.totalSeconds > 0,
  );
  const browsers = (summary?.browsers ?? []).filter(
    (item) => item.totalSeconds > 0,
  );
  const surfaces = (summary?.surfaces ?? []).filter(
    (item) => item.totalSeconds > 0,
  );
  const sessionBuckets =
    summary?.sessions
      .filter((item) => item.totalSeconds > 0)
      .map((item) => ({
        key: `${item.source}:${item.identifier}`,
        label: item.serviceLabel ?? item.displayName,
        totalSeconds: item.totalSeconds,
      })) ?? [];
  const channels = (summary?.messages.channels ?? []).filter(
    (channel) =>
      channel.opened > 0 || channel.outbound > 0 || channel.inbound > 0,
  );
  const messageOpened = summary?.messages.opened ?? 0;
  const messageOutbound = summary?.messages.outbound ?? 0;
  const messageInbound = summary?.messages.inbound ?? 0;
  const hasMessageActivity =
    messageOpened > 0 || messageOutbound > 0 || messageInbound > 0;
  const hasUsage =
    totalSeconds > 0 ||
    hasMessageActivity ||
    services.length > 0 ||
    devices.length > 0 ||
    browsers.length > 0 ||
    surfaces.length > 0 ||
    sessionBuckets.length > 0 ||
    channels.length > 0;
  const metricTiles = [
    {
      key: "social",
      icon: <Share2 />,
      value: formatDurationSeconds(totalSeconds),
      label: "Social",
      visible: totalSeconds > 0,
    },
    {
      key: "youtube",
      icon: <PlaySquare />,
      value: formatDurationSeconds(youtubeSeconds),
      label: "YouTube",
      visible: youtubeSeconds > 0,
    },
    {
      key: "x",
      icon: <AtSign />,
      value: formatDurationSeconds(xSeconds),
      label: "X",
      visible: xSeconds > 0,
    },
    {
      key: "opened",
      icon: <MessageSquareText />,
      value: String(messageOpened),
      label: "Opened",
      visible: messageOpened > 0,
    },
  ].filter((item) => item.visible);

  return (
    <div className="space-y-4" data-testid="lifeops-social-section">
      <header className="flex items-center justify-between gap-3 border-b border-border/20 pb-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight text-txt">
            Social
          </h1>
        </div>
        <button
          type="button"
          aria-label="Refresh social habits"
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

      {loading && !summary ? (
        <div className="flex items-center gap-2 py-4 text-xs text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading social habits...
        </div>
      ) : null}

      {!loading && !error && summary && !hasUsage ? (
        <HabitPanel title="Social" icon={<Share2 />}>
          <div className="py-3 text-sm text-muted">
            No social activity today.
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
                <MetricTile
                  key={tile.key}
                  icon={tile.icon}
                  value={tile.value}
                  label={tile.label}
                />
              ))}
            </div>
          ) : null}

          <div className="grid gap-4 xl:grid-cols-12">
            <HabitPanel
              title="Platforms"
              icon={<Share2 />}
              className="xl:col-span-5"
            >
              <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
                <DonutChart
                  items={services}
                  totalSeconds={totalSeconds}
                  label="Social"
                />
                <div className="min-w-0 flex-1">
                  <StackedBar items={services} totalSeconds={totalSeconds} />
                  <div className="mt-4">
                    <BucketBars
                      items={services}
                      totalSeconds={totalSeconds}
                      emptyLabel="No social time"
                    />
                  </div>
                </div>
              </div>
            </HabitPanel>

            <HabitPanel
              title="Devices"
              icon={<Smartphone />}
              className="xl:col-span-3"
            >
              <BucketBars
                items={devices}
                totalSeconds={totalSeconds}
                emptyLabel="No device data"
              />
            </HabitPanel>

            {hasMessageActivity || channels.length > 0 ? (
              <HabitPanel
                title="Messages"
                icon={<MessageSquareText />}
                className="xl:col-span-4"
              >
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
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            {browsers.length > 0 ? (
              <HabitPanel title="Browser" icon={<Globe2 />}>
                <BucketBars items={browsers} totalSeconds={totalSeconds} />
              </HabitPanel>
            ) : null}
            {surfaces.length > 0 ? (
              <HabitPanel title="Surfaces" icon={<Monitor />}>
                <BucketBars items={surfaces} totalSeconds={totalSeconds} />
              </HabitPanel>
            ) : null}
            {sessionBuckets.length > 0 ? (
              <HabitPanel title="Sessions" icon={<Share2 />}>
                <BucketBars
                  items={sessionBuckets}
                  totalSeconds={totalSeconds}
                  limit={8}
                />
              </HabitPanel>
            ) : null}
          </div>
        </>
      )}

      <div className="flex flex-wrap gap-2">
        {(summary?.dataSources ?? []).map((source) => (
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
    </div>
  );
}
