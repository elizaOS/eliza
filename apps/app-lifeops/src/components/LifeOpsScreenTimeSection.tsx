import { client } from "@elizaos/app-core";
import {
  AppWindow,
  Globe2,
  Loader2,
  Monitor,
  RefreshCw,
  Smartphone,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { LifeOpsScreenTimeBreakdown } from "../api/client-lifeops.js";
import {
  BucketBars,
  DonutChart,
  formatDurationSeconds,
  HabitPanel,
  MetricTile,
  StackedBar,
  startOfLocalDayIso,
} from "./LifeOpsHabitVisuals.js";

export function LifeOpsScreenTimeSection() {
  const [breakdown, setBreakdown] = useState<LifeOpsScreenTimeBreakdown | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBreakdown(
        await client.getLifeOpsScreenTimeBreakdown({
          since: startOfLocalDayIso(),
          until: new Date().toISOString(),
          topN: 16,
        }),
      );
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

  useEffect(() => {
    void load();
  }, [load]);

  const totalSeconds = breakdown?.totalSeconds ?? 0;
  const appSeconds =
    breakdown?.bySource.find((item) => item.key === "app")?.totalSeconds ?? 0;
  const webSeconds =
    breakdown?.bySource.find((item) => item.key === "website")?.totalSeconds ??
    0;
  const phoneSeconds =
    breakdown?.byDevice.find((item) => item.key === "phone")?.totalSeconds ?? 0;
  const topTargets =
    breakdown?.items.map((item) => ({
      key: `${item.source}:${item.identifier}`,
      label: item.displayName,
      totalSeconds: item.totalSeconds,
    })) ?? [];

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

      {loading && !breakdown ? (
        <div className="flex items-center gap-2 py-4 text-xs text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading screen time...
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          icon={<Monitor />}
          value={formatDurationSeconds(totalSeconds)}
          label="Today"
        />
        <MetricTile
          icon={<AppWindow />}
          value={formatDurationSeconds(appSeconds)}
          label="Apps"
        />
        <MetricTile
          icon={<Globe2 />}
          value={formatDurationSeconds(webSeconds)}
          label="Web"
        />
        <MetricTile
          icon={<Smartphone />}
          value={formatDurationSeconds(phoneSeconds)}
          label="Phone"
        />
      </div>

      <HabitPanel
        title="Categories"
        icon={<Monitor />}
        className="xl:col-span-2"
      >
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center">
          <DonutChart
            items={breakdown?.byCategory ?? []}
            totalSeconds={totalSeconds}
            label="Today"
          />
          <div className="min-w-0 flex-1">
            <StackedBar
              items={breakdown?.byCategory ?? []}
              totalSeconds={totalSeconds}
            />
            <div className="mt-4">
              <BucketBars
                items={breakdown?.byCategory ?? []}
                totalSeconds={totalSeconds}
              />
            </div>
          </div>
        </div>
      </HabitPanel>

      <div className="grid gap-4 xl:grid-cols-3">
        <HabitPanel title="Devices" icon={<Smartphone />}>
          <BucketBars
            items={breakdown?.byDevice ?? []}
            totalSeconds={totalSeconds}
          />
        </HabitPanel>
        <HabitPanel title="Browsers" icon={<Globe2 />}>
          <BucketBars
            items={breakdown?.byBrowser ?? []}
            totalSeconds={webSeconds}
            emptyLabel="No browser data"
          />
        </HabitPanel>
        <HabitPanel title="Apps and Sites" icon={<AppWindow />}>
          <BucketBars
            items={topTargets}
            totalSeconds={totalSeconds}
            emptyLabel="No activity"
            limit={8}
          />
        </HabitPanel>
      </div>
    </div>
  );
}
