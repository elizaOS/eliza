/**
 * Home-widget priority ranking (#9143).
 *
 * The frontpage/home surface must NOT render every `home`-slot widget — it
 * should surface only the highest-importance widgets *right now*, the way a
 * phone home screen bubbles up what needs attention. This module is the pure
 * ranking core: it scores each home widget by a stable base priority plus any
 * recent attention/activity signals (decayed by recency), then returns the
 * top-N ordered by current importance.
 *
 * It is deliberately decoupled from React and from how signals are sourced:
 * callers (the home WidgetHost) map their live `ActivityEvent` stream into
 * {@link HomeWidgetSignal}s and pass `now` in, so the function is pure and
 * deterministic (no `Date.now()` in a render path — see the UI determinism
 * gate). The signal→widget attribution and event-stream wiring live in the
 * consumer, not here.
 */

import type { PluginWidgetDeclaration } from "./types";

/** Minimal declaration shape the ranking needs (decoupled from the full type). */
export type RankableHomeWidget = Pick<
  PluginWidgetDeclaration,
  "id" | "pluginId" | "order"
>;

/** A live importance signal attributed to a single home widget. */
export interface HomeWidgetSignal {
  /** `${pluginId}/${id}` of the widget this signal boosts. */
  widgetKey: string;
  /** Raw importance weight (higher = more urgent). */
  weight: number;
  /** Epoch-ms when the signal occurred — used for recency decay. */
  timestamp: number;
}

export interface RankHomeWidgetsOptions {
  /** Current time (epoch-ms). Passed in for determinism + testability. */
  now: number;
  /** Maximum widgets the home surface shows. Default 6. */
  maxVisible?: number;
  /** Half-life of an attention signal's boost, in ms. Default 30 min. */
  signalHalfLifeMs?: number;
  /** Signals at or beyond this age contribute nothing. Default 6 h. */
  signalMaxAgeMs?: number;
  /**
   * Minimum score a widget must reach to be shown. Default 0 (keep every
   * declared widget, capped to `maxVisible`). Raise it above the maximum base
   * score (1) to require live attention — i.e. hide widgets that are merely
   * declared but have no recent activity.
   */
  minScore?: number;
}

export interface RankedHomeWidget<D extends RankableHomeWidget> {
  declaration: D;
  /** Combined base-priority + decayed-attention score (higher = shown first). */
  score: number;
}

const DEFAULT_MAX_VISIBLE = 6;
const DEFAULT_HALF_LIFE_MS = 30 * 60_000;
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60_000;

/**
 * Default importance weights for the common activity/attention event types a
 * consumer maps into {@link HomeWidgetSignal}s. Exported so the home WidgetHost
 * (and tests) share one notion of "how urgent is this kind of event" rather
 * than re-deriving it. Unknown event types should fall back to `activity`.
 */
export const HOME_SIGNAL_WEIGHTS: Readonly<Record<string, number>> = {
  blocked: 10,
  escalation: 10,
  approval: 9,
  reminder: 6,
  message: 5,
  "check-in": 4,
  nudge: 3,
  workflow: 2,
  activity: 1,
};

/** Resolve an event type to its importance weight (falls back to `activity`). */
export function homeSignalWeight(eventType: string): number {
  return HOME_SIGNAL_WEIGHTS[eventType] ?? HOME_SIGNAL_WEIGHTS.activity;
}

/** The stable widget key used to attribute signals to a declaration. */
export function homeWidgetKey(decl: RankableHomeWidget): string {
  return `${decl.pluginId}/${decl.id}`;
}

/**
 * Stable base importance derived from the declaration `order` (lower order =
 * higher base), normalized to roughly `[0, 1]` so a single fresh attention
 * signal outranks base ordering but base still breaks ties between cold
 * widgets. `order` defaults to 100 (the registry default).
 */
export function baseHomeScore(order: number | undefined): number {
  const resolved =
    typeof order === "number" && Number.isFinite(order) ? order : 100;
  return Math.max(0, 100 - resolved) / 100;
}

function recencyMultiplier(
  ageMs: number,
  halfLifeMs: number,
  maxAgeMs: number,
): number {
  const age = ageMs < 0 ? 0 : ageMs; // a future-stamped signal counts as "now"
  if (age >= maxAgeMs) return 0;
  return 0.5 ** (age / halfLifeMs);
}

/**
 * Current importance of one home widget: stable base priority plus the sum of
 * its recent attention signals, each decayed by how long ago it fired.
 */
export function scoreHomeWidget(
  decl: RankableHomeWidget,
  signals: readonly HomeWidgetSignal[],
  opts: RankHomeWidgetsOptions,
): number {
  const halfLife = opts.signalHalfLifeMs ?? DEFAULT_HALF_LIFE_MS;
  const maxAge = opts.signalMaxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const key = homeWidgetKey(decl);
  let attention = 0;
  for (const signal of signals) {
    if (signal.widgetKey !== key) continue;
    attention +=
      signal.weight *
      recencyMultiplier(opts.now - signal.timestamp, halfLife, maxAge);
  }
  return baseHomeScore(decl.order) + attention;
}

/**
 * Rank home widgets by current importance and return only the top-N. Ordering
 * is descending by score; ties break deterministically by widget key so the
 * home surface never reshuffles equal-importance widgets between renders.
 */
export function rankHomeWidgets<D extends RankableHomeWidget>(
  declarations: readonly D[],
  signals: readonly HomeWidgetSignal[],
  opts: RankHomeWidgetsOptions,
): RankedHomeWidget<D>[] {
  const maxVisible = opts.maxVisible ?? DEFAULT_MAX_VISIBLE;
  const minScore = opts.minScore ?? 0;
  return declarations
    .map((declaration) => ({
      declaration,
      key: homeWidgetKey(declaration),
      score: scoreHomeWidget(declaration, signals, opts),
    }))
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .slice(0, Math.max(0, maxVisible))
    .map(({ declaration, score }) => ({ declaration, score }));
}
