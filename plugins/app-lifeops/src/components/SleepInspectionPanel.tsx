import { Moon, Sunrise } from "lucide-react";
import type { JSX } from "react";
import { useMemo } from "react";
import { useLifeOpsScheduleInspection } from "../hooks/useLifeOpsScheduleInspection.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

function parseIsoMs(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

interface EpisodeRow {
  startIso: string;
  endIso: string | null;
  startMs: number;
  endMs: number | null;
  durationMinutes: number;
  isNap: boolean;
  current: boolean;
  source: string;
  confidence: number;
}

/**
 * 7-day sleep/wake episode browser. Reads from
 * `GET /api/lifeops/schedule/inspection` so the timeline matches exactly
 * what the scorer saw this tick.
 */
export function SleepInspectionPanel(): JSX.Element {
  const { inspection, loading, error, refresh } =
    useLifeOpsScheduleInspection();

  const episodes = useMemo<EpisodeRow[]>(() => {
    if (!inspection) return [];
    const cutoffMs = Date.now() - 7 * DAY_MS;
    const rows: EpisodeRow[] = [];
    for (const episode of inspection.sleepEpisodes) {
      const startMs = parseIsoMs(episode.startAt);
      if (startMs === null || startMs < cutoffMs) continue;
      const endMs = parseIsoMs(episode.endAt);
      rows.push({
        startIso: episode.startAt,
        endIso: episode.endAt,
        startMs,
        endMs,
        durationMinutes: episode.durationMinutes,
        // Naps are <4h and non-current; the server exposes the raw episode
        // so we classify client-side to avoid teaching the inspection type
        // about cycle semantics.
        isNap: !episode.current && episode.durationMinutes < 240,
        current: episode.current,
        source: episode.source,
        confidence: episode.confidence,
      });
    }
    rows.sort((left, right) => right.startMs - left.startMs);
    return rows;
  }, [inspection]);

  if (loading && !inspection) {
    return (
      <div className="rounded-2xl border border-border/20 bg-bg/36 px-3 py-2 text-xs text-muted">
        Loading sleep inspection…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
        {error}
        <button
          type="button"
          onClick={() => void refresh()}
          className="ml-2 rounded-md border border-rose-400/40 px-2 py-0.5 text-[11px]"
        >
          Retry
        </button>
      </div>
    );
  }
  if (!inspection?.insight) {
    return (
      <div className="rounded-2xl border border-border/20 bg-bg/36 px-3 py-2 text-xs text-muted">
        No schedule inspection available yet.
      </div>
    );
  }

  const { insight } = inspection;
  const regularity = insight.regularity;

  return (
    <div className="space-y-3 rounded-2xl border border-border/20 bg-bg/36 px-3 py-3">
      <div className="flex items-baseline justify-between">
        <div className="text-[11px] uppercase tracking-wide text-muted">
          Sleep inspection · last 7 days
        </div>
        <div className="text-[11px] text-muted">
          SRI {Math.round(regularity.sri)} ·{" "}
          {regularity.regularityClass.replace(/_/g, " ")} · n
          {regularity.sampleCount}
        </div>
      </div>
      {episodes.length === 0 ? (
        <div className="text-xs text-muted">
          No sleep episodes recorded in the last 7 days.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {episodes.map((episode) => (
            <li
              key={`${episode.startIso}:${episode.endIso ?? "open"}`}
              className="flex items-center gap-2 text-xs"
            >
              {episode.isNap ? (
                <Sunrise className="h-3.5 w-3.5 text-amber-300" />
              ) : (
                <Moon className="h-3.5 w-3.5 text-violet-300" />
              )}
              <span className="flex-1">
                {new Date(episode.startMs).toLocaleString()}
                {episode.endMs !== null ? (
                  <>
                    {" → "}
                    {new Date(episode.endMs).toLocaleString()}
                  </>
                ) : (
                  <span className="text-amber-300"> · in progress</span>
                )}
              </span>
              <span className="text-muted">
                {`${Math.floor(episode.durationMinutes / 60)}h${
                  episode.durationMinutes % 60
                }m`}
              </span>
              <span className="text-[11px] text-muted">
                {episode.source} · {Math.round(episode.confidence * 100)}%
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-1.5 pt-2">
        <span className="text-[11px] uppercase tracking-wide text-muted">
          Bedtime stddev {Math.round(regularity.bedtimeStddevMin)}m · wake
          stddev {Math.round(regularity.wakeStddevMin)}m
        </span>
      </div>
    </div>
  );
}
