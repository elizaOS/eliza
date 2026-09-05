/**
 * HealthView — the GUI data wrapper for the owner sleep summary.
 *
 * It owns the live sleep data (the fetcher seam over the three read-only
 * endpoints the host serves, the quiet background poll, the window-range state,
 * and the wire->display projection) and renders the one presentational
 * {@link HealthSpatialView} inside a {@link SpatialSurface}. The browser DOM
 * surface ships today, while the retained modality contract stays available for
 * future adapters.
 *
 * Data source (three read-only sleep endpoints served by `src/routes/sleep.ts`):
 *   GET {base}/api/lifeops/sleep/history?windowDays&includeNaps   (primary)
 *   GET {base}/api/lifeops/sleep/regularity?windowDays            (enrich)
 *   GET {base}/api/lifeops/sleep/baseline?windowDays              (enrich)
 *
 * The view is read-only: the only owner actions are `retry` (reload after an
 * error) and `window:7|14|30` (change the look-back window). All durations,
 * times, and percentages are formatted to strings HERE (client displays, never
 * computes) and handed to the presentational view as a snapshot.
 *
 * The default fetchers build URLs from `client.getBaseUrl()`; tests inject the
 * fetcher seams so they stay offline.
 */

import { client } from "@elizaos/ui/api";
import { fetchWithDeadline } from "@elizaos/ui/utils";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  LifeOpsPersonalBaselineResponse,
  LifeOpsRegularityClass,
  LifeOpsSleepHistoryResponse,
  LifeOpsSleepRegularityResponse,
} from "../../contracts/health.js";
import {
  EMPTY_HEALTH_SNAPSHOT,
  type HealthSnapshot,
  HealthSpatialView,
  type StatRow,
  type WindowDays,
} from "./HealthSpatialView.tsx";

export type { WindowDays } from "./HealthSpatialView.tsx";

// ---------------------------------------------------------------------------
// Fetcher seams — default to real GETs; tests inject offline fakes.
// ---------------------------------------------------------------------------

export interface SleepFetchers {
  fetchHistory: (
    windowDays: number,
    signal?: AbortSignal,
  ) => Promise<LifeOpsSleepHistoryResponse>;
  fetchRegularity: (
    windowDays: number,
    signal?: AbortSignal,
  ) => Promise<LifeOpsSleepRegularityResponse>;
  fetchBaseline: (
    windowDays: number,
    signal?: AbortSignal,
  ) => Promise<LifeOpsPersonalBaselineResponse>;
}

/** Maximum time allowed for one sleep-data request. */
export const HEALTH_VIEW_JSON_TIMEOUT_MS = 15_000;

export async function getHealthJsonWithFetch<T>(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number = HEALTH_VIEW_JSON_TIMEOUT_MS,
  callerSignal?: AbortSignal,
): Promise<T> {
  return fetchWithDeadline(
    url,
    { method: "GET" },
    async (response) => {
      if (!response.ok) {
        throw new Error(`Sleep request failed (${response.status}): ${url}`);
      }
      return (await response.json()) as T;
    },
    { timeoutMs, fetchImpl, ...(callerSignal ? { signal: callerSignal } : {}) },
  );
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return getHealthJsonWithFetch<T>(
    `${client.getBaseUrl()}${path}`,
    globalThis.fetch,
    HEALTH_VIEW_JSON_TIMEOUT_MS,
    signal,
  );
}

const defaultFetchers: SleepFetchers = {
  fetchHistory: (windowDays, signal) =>
    getJson<LifeOpsSleepHistoryResponse>(
      `/api/lifeops/sleep/history?windowDays=${windowDays}&includeNaps=true`,
      signal,
    ),
  fetchRegularity: (windowDays, signal) =>
    getJson<LifeOpsSleepRegularityResponse>(
      `/api/lifeops/sleep/regularity?windowDays=${windowDays}`,
      signal,
    ),
  fetchBaseline: (windowDays, signal) =>
    getJson<LifeOpsPersonalBaselineResponse>(
      `/api/lifeops/sleep/baseline?windowDays=${windowDays}`,
      signal,
    ),
};

export interface HealthViewProps {
  /** Owner display name shown in the header subtitle. */
  ownerName?: string;
  /** Test/host injection seam. Defaults to real `/api/lifeops/sleep/*` GETs. */
  fetchers?: SleepFetchers;
  /** Initial look-back window in days. Defaults to 14. */
  initialWindowDays?: WindowDays;
}

/** Quiet background-poll cadence that keeps the view fresh. */
const POLL_INTERVAL_MS = 20_000;

// ---------------------------------------------------------------------------
// Formatting helpers (display-only; no business computation).
// ---------------------------------------------------------------------------

function formatDateTime(value: string | null): string {
  if (!value) return "in progress";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDuration(minutes: number | null): string {
  if (minutes === null) return "—";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins}m`;
  return `${hours}h ${mins}m`;
}

function formatLocalHour(hour: number | null): string {
  if (hour === null) return "—";
  const normalized = ((hour % 24) + 24) % 24;
  const whole = Math.floor(normalized);
  const mins = Math.round((normalized - whole) * 60);
  return `${String(whole).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

const REGULARITY_LABELS: Record<LifeOpsRegularityClass, string> = {
  very_regular: "Very regular",
  regular: "Regular",
  irregular: "Irregular",
  very_irregular: "Very irregular",
  insufficient_data: "Insufficient data",
};

/**
 * Quiet proactive line: the agent only speaks up when the loaded regularity
 * classification reads as off-rhythm. Returns "" (render nothing) for
 * regular/very-regular nights and when there isn't enough data to judge — no
 * placeholder, no "all good" banner.
 */
function sleepProactiveLine(
  regularity: LifeOpsSleepRegularityResponse,
): string {
  if (regularity.classification === "very_irregular") {
    return "Sleep was very irregular this window — bedtime and wake times drifted a lot.";
  }
  if (regularity.classification === "irregular") {
    return "Sleep was irregular this window — bedtime and wake times varied.";
  }
  return "";
}

// ---------------------------------------------------------------------------
// Wire -> display snapshot projection (all formatting happens here).
// ---------------------------------------------------------------------------

interface SleepData {
  history: LifeOpsSleepHistoryResponse;
  regularity: LifeOpsSleepRegularityResponse;
  baseline: LifeOpsPersonalBaselineResponse;
}

function lastSleepRows(data: SleepData): StatRow[] {
  const [latest] = data.history.episodes;
  if (!latest) return [];
  return [
    { label: "Duration", value: formatDuration(latest.durationMin) },
    { label: "Bedtime", value: formatDateTime(latest.startedAt) },
    { label: "Wake", value: formatDateTime(latest.endedAt) },
    { label: "Type", value: latest.cycleType },
    { label: "Source", value: latest.source },
    { label: "Confidence", value: `${Math.round(latest.confidence * 100)}%` },
  ];
}

function regularityRows(regularity: LifeOpsSleepRegularityResponse): StatRow[] {
  return [
    {
      label: "Classification",
      value: REGULARITY_LABELS[regularity.classification],
    },
    { label: "SRI", value: `${Math.round(regularity.sri)}` },
    {
      label: "Bedtime spread",
      value: formatDuration(Math.round(regularity.bedtimeStddevMin)),
    },
    {
      label: "Wake spread",
      value: formatDuration(Math.round(regularity.wakeStddevMin)),
    },
    { label: "Samples", value: `${regularity.sampleSize}` },
  ];
}

function baselineRows(baseline: LifeOpsPersonalBaselineResponse): StatRow[] {
  return [
    {
      label: "Typical bedtime",
      value: formatLocalHour(baseline.medianBedtimeLocalHour),
    },
    {
      label: "Typical wake",
      value: formatLocalHour(baseline.medianWakeLocalHour),
    },
    {
      label: "Typical duration",
      value: formatDuration(baseline.medianSleepDurationMin),
    },
    { label: "Samples", value: `${baseline.sampleSize}` },
  ];
}

function windowSummaryRows(history: LifeOpsSleepHistoryResponse): StatRow[] {
  return [
    { label: "Nights recorded", value: `${history.summary.cycleCount}` },
    {
      label: "Average duration",
      value: formatDuration(history.summary.averageDurationMin),
    },
    { label: "Overnight", value: `${history.summary.overnightCount}` },
    { label: "Naps", value: `${history.summary.napCount}` },
  ];
}

// ---------------------------------------------------------------------------
// Fetch-driven state machine.
// ---------------------------------------------------------------------------

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: SleepData };

export function HealthView(props: HealthViewProps = {}): ReactNode {
  const fetchers = props.fetchers ?? defaultFetchers;
  const [windowDays, setWindowDays] = useState<WindowDays>(
    props.initialWindowDays ?? 14,
  );
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const fetchersRef = useRef(fetchers);
  fetchersRef.current = fetchers;
  const activeLoadRef = useRef<AbortController | null>(null);

  const load = useCallback((days: WindowDays, background = false) => {
    activeLoadRef.current?.abort();
    const controller = new AbortController();
    activeLoadRef.current = controller;
    if (!background) setState({ kind: "loading" });
    Promise.all([
      fetchersRef.current.fetchHistory(days, controller.signal),
      fetchersRef.current.fetchRegularity(days, controller.signal),
      fetchersRef.current.fetchBaseline(days, controller.signal),
    ])
      .then(([history, regularity, baseline]) => {
        if (!controller.signal.aborted) {
          setState({ kind: "ready", data: { history, regularity, baseline } });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || background) return;
        setState({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not load sleep data.",
        });
      })
      .finally(() => {
        if (activeLoadRef.current === controller) {
          activeLoadRef.current = null;
        }
      });
  }, []);

  // Initial load + reload on window change.
  useEffect(() => {
    load(windowDays);
  }, [load, windowDays]);

  // Quiet background poll keeps the view fresh without a manual refresh control:
  // it swaps in newer data on success and never flashes the loading state or
  // clobbers a populated view with a transient fetch error.
  useEffect(() => {
    const id = setInterval(() => load(windowDays, true), POLL_INTERVAL_MS);
    return () => {
      clearInterval(id);
      activeLoadRef.current?.abort();
    };
  }, [load, windowDays]);

  const snapshot = useMemo<HealthSnapshot>(() => {
    if (state.kind === "loading") {
      return { ...EMPTY_HEALTH_SNAPSHOT, state: "loading", windowDays };
    }
    if (state.kind === "error") {
      return {
        ...EMPTY_HEALTH_SNAPSHOT,
        state: "error",
        windowDays,
        error: state.message,
      };
    }
    const { history, regularity, baseline } = state.data;
    const [latest] = history.episodes;
    if (!latest) {
      return {
        ...EMPTY_HEALTH_SNAPSHOT,
        state: "empty",
        windowDays,
        emptyDetail: `${history.windowDays}d empty`,
      };
    }
    return {
      state: "ready",
      windowDays,
      proactive: sleepProactiveLine(regularity),
      lastSleep: lastSleepRows(state.data),
      regularity: regularityRows(regularity),
      baseline: baselineRows(baseline),
      windowSummary: windowSummaryRows(history),
      emptyDetail: "",
    };
  }, [state, windowDays]);

  const onAction = useCallback(
    (action: string) => {
      switch (action) {
        case "retry":
          load(windowDays);
          return;
        case "window:7":
          setWindowDays(7);
          return;
        case "window:14":
          setWindowDays(14);
          return;
        case "window:30":
          setWindowDays(30);
          return;
      }
    },
    [load, windowDays],
  );

  return <HealthSpatialView snapshot={snapshot} onAction={onAction} />;
}

export default HealthView;
