/**
 * Icon-first home Sleep widget: shows last night's sleep duration plus an
 * "Irregular" status badge when the rhythm is off, and self-hides when the
 * sleep pattern is healthy or there is no episode yet. Polls the health sleep
 * feed only while the document is visible and the session is authenticated.
 * Registered as `HEALTH_HOME_WIDGET`; tapping navigates to the health surface.
 */
import { Moon } from "lucide-react";
import type { ComponentType } from "react";
import { useCallback, useEffect, useState } from "react";
import { client } from "../../../api";
import { supportsFullAppShellRoutes } from "../../../api/app-shell-capabilities";
import { useIntervalWhenDocumentVisible } from "../../../hooks";
import { useIsAuthenticated } from "../../../hooks/useAuthStatus";
import { usePublishHomeAttention } from "../../../widgets/home-attention-store";
import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import type { WidgetProps } from "../../../widgets/types";
import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";

const HEALTH_SLEEP_WIDGET_KEY = "health/health.sleep";
// HealthView polls the same `/api/lifeops/sleep/*` endpoints every 20s
// (POLL_INTERVAL_MS in plugins/plugin-health/src/components/health/HealthView.tsx).
const SLEEP_REFRESH_INTERVAL_MS = 20_000;
const WINDOW_DAYS = 14;

// ---------------------------------------------------------------------------
// Wire shapes — mirror the JSON HealthView fetches from the read-only sleep
// routes (plugins/plugin-health/src/routes/sleep.ts) and parses in
// plugins/plugin-health/src/components/health/HealthView.tsx. The canonical
// contract types live in plugins/plugin-health/src/contracts/lifeops.ts:
//   LifeOpsSleepHistoryEpisode   (lifeops.ts:3715)
//   LifeOpsSleepHistoryResponse  (lifeops.ts:3733)
//   LifeOpsRegularityClass       (lifeops.ts:1629)
//   LifeOpsSleepRegularityResponse (lifeops.ts:3745)
// The @elizaos/ui package does not depend on @elizaos/plugin-health, so only
// the subset of fields this glanceable widget renders is re-declared here.
// ---------------------------------------------------------------------------

/** Mirror of LifeOpsRegularityClass. */
type SleepRegularityClass =
  | "very_regular"
  | "regular"
  | "irregular"
  | "very_irregular"
  | "insufficient_data";

/** Mirror of the LifeOpsSleepHistoryEpisode fields this widget reads. */
interface SleepHistoryEpisode {
  startedAt: string;
  endedAt: string | null;
  durationMin: number | null;
}

/** Mirror of LifeOpsSleepHistoryResponse (the history endpoint payload). */
interface SleepHistoryResponse {
  episodes: SleepHistoryEpisode[];
}

/** Mirror of the LifeOpsSleepRegularityResponse fields this widget reads. */
interface SleepRegularityResponse {
  classification: SleepRegularityClass;
}

interface SleepWidgetData {
  latest: SleepHistoryEpisode | null;
  classification: SleepRegularityClass | null;
}

const REGULARITY_CLASSES: ReadonlySet<string> = new Set<SleepRegularityClass>([
  "very_regular",
  "regular",
  "irregular",
  "very_irregular",
  "insufficient_data",
]);

const OFF_RHYTHM_LABELS: Record<"irregular" | "very_irregular", string> = {
  irregular: "Irregular",
  very_irregular: "Very irregular",
};

// HealthView's `sleepProactiveLine` only speaks up for these two classes — the
// same "needs attention" threshold drives this widget's home-attention signal.
function isOffRhythm(
  classification: SleepRegularityClass | null,
): classification is "irregular" | "very_irregular" {
  return classification === "irregular" || classification === "very_irregular";
}

// ---------------------------------------------------------------------------
// Boundary validation — the fetched JSON is untrusted network input, so narrow
// it to the wire shapes before reading any field.
// ---------------------------------------------------------------------------

function isEpisode(value: unknown): value is SleepHistoryEpisode {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.startedAt === "string" &&
    (record.endedAt === null || typeof record.endedAt === "string") &&
    (record.durationMin === null || typeof record.durationMin === "number")
  );
}

function isHistoryResponse(value: unknown): value is SleepHistoryResponse {
  if (typeof value !== "object" || value === null) return false;
  const episodes = (value as Record<string, unknown>).episodes;
  return Array.isArray(episodes) && episodes.every(isEpisode);
}

function isRegularityResponse(
  value: unknown,
): value is SleepRegularityResponse {
  if (typeof value !== "object" || value === null) return false;
  const classification = (value as Record<string, unknown>).classification;
  return (
    typeof classification === "string" && REGULARITY_CLASSES.has(classification)
  );
}

/** Validated latest sleep episode in the window, or null when absent/malformed. */
function parseHistory(value: unknown): SleepHistoryEpisode | null {
  if (!isHistoryResponse(value)) return null;
  return value.episodes[0] ?? null;
}

/** Validated regularity classification, or null when absent/malformed. */
function parseRegularity(value: unknown): SleepRegularityClass | null {
  return isRegularityResponse(value) ? value.classification : null;
}

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${client.getBaseUrl()}${path}`);
  if (!response.ok) {
    throw new Error(`Sleep request failed (${response.status}): ${path}`);
  }
  return (await response.json()) as unknown;
}

async function fetchSleep(): Promise<SleepWidgetData> {
  const [historyRaw, regularityRaw] = await Promise.all([
    getJson(
      `/api/lifeops/sleep/history?windowDays=${WINDOW_DAYS}&includeNaps=true`,
    ),
    getJson(`/api/lifeops/sleep/regularity?windowDays=${WINDOW_DAYS}`),
  ]);
  return {
    latest: parseHistory(historyRaw),
    classification: parseRegularity(regularityRaw),
  };
}

// Display-only formatting (client displays, never computes) — mirrors
// HealthView's formatDuration helper.
function formatDuration(minutes: number | null): string {
  if (minutes === null) return "—";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return hours === 0 ? `${mins}m` : `${hours}h ${mins}m`;
}

/** Shallow content equality so an unchanged 20s poll doesn't re-render. */
function sleepEqual(a: SleepWidgetData | null, b: SleepWidgetData): boolean {
  if (!a) return false;
  if (a.classification !== b.classification) return false;
  if (a.latest === b.latest) return true;
  if (a.latest === null || b.latest === null) return false;
  return (
    a.latest.startedAt === b.latest.startedAt &&
    a.latest.endedAt === b.latest.endedAt &&
    a.latest.durationMin === b.latest.durationMin
  );
}

/**
 * Frontpage Sleep widget (#9143). Glanceable, home-only, icon-first: a single
 * high-priority datum — the latest sleep duration — on one whole-card-clickable
 * tile that opens the Health view. When sleep reads off-rhythm it carries an
 * "Irregular"/"Very irregular" badge (warn tone) and floats itself up via the
 * home-attention store. Fetches the same `/api/lifeops/sleep/*` endpoints
 * HealthView reads, polling quietly while the document is visible.
 */
export function HealthSleepWidget({
  spanClassName = "col-span-2 row-span-1",
}: Partial<WidgetProps>) {
  // `null` = first load still pending; a value (with `latest: null`) = loaded
  // but no episode. This keeps the home surface blank until we actually know
  // there's data, and a transient fetch error never clobbers a populated card.
  const [data, setData] = useState<SleepWidgetData | null>(null);
  const nav = useWidgetNavigation();
  // Auth gate (#11084): the widget mounts before the auth probe resolves, so
  // the 20s sleep poll must stay dormant until the session is authenticated.
  const authenticated = useIsAuthenticated();

  const load = useCallback(async () => {
    if (!authenticated || !supportsFullAppShellRoutes(client.getBaseUrl())) {
      setData({ latest: null, classification: null });
      return;
    }

    try {
      const next = await fetchSleep();
      // Skip the state update (and the re-render) when the poll is unchanged.
      setData((prev) => (sleepEqual(prev, next) ? prev : next));
    } catch {
      // Silent fallback to the last good render (matches todo.tsx); never log.
    }
  }, [authenticated]);

  useEffect(() => {
    void load();
  }, [load]);
  // Poll only while the document is visible, at HealthView's 20s cadence.
  useIntervalWhenDocumentVisible(() => void load(), SLEEP_REFRESH_INTERVAL_MS);

  const offRhythm = isOffRhythm(data?.classification ?? null);
  // Float the home card up while sleep regularity reads as off-rhythm; clear it
  // otherwise (sustained-state self-signal — see home-attention-store.ts).
  usePublishHomeAttention(
    HEALTH_SLEEP_WIDGET_KEY,
    offRhythm ? HOME_SIGNAL_WEIGHTS["check-in"] : null,
  );

  // Render nothing until the first load resolves, and nothing once loaded if
  // there is no sleep episode in the window — the home surface must not show
  // empty placeholders (#9143).
  if (data == null || !data.latest) return null;

  // One high-priority datum, icon-first: the latest sleep duration. The
  // off-rhythm regularity becomes a warn badge; tapping opens the Health view.
  const duration = formatDuration(data.latest.durationMin);
  const badge =
    data.classification && isOffRhythm(data.classification)
      ? OFF_RHYTHM_LABELS[data.classification]
      : undefined;
  const ariaLabel = badge
    ? `Sleep: last ${duration}, regularity ${badge.toLowerCase()}. Open Health.`
    : `Sleep: last ${duration}. Open Health.`;

  return (
    <div className={`min-w-0 ${spanClassName}`}>
      <HomeWidgetCard
        icon={<Moon />}
        label="Sleep"
        value={duration}
        badge={badge}
        tone={badge ? "warn" : "default"}
        testId="widget-health-sleep"
        ariaLabel={ariaLabel}
        onActivate={() => nav.openView("/health", "health")}
      />
    </div>
  );
}

export const HEALTH_HOME_WIDGET = {
  pluginId: "health",
  id: "health.sleep",
  order: 140,
  signalKinds: ["check-in"],
  Component: HealthSleepWidget satisfies ComponentType<WidgetProps>,
} as const;
