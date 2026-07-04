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
  "id" | "pluginId" | "order" | "signalKinds"
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
  // First-time-user guidance (#9959): outranks every cold widget so a fresh
  // account's welcome card sits at the top, but stays BELOW approval/escalation/
  // blocked so a real "act now" signal always wins. Retires via the sunset
  // lifecycle (home-dismissal-store) once the user engages or dismisses.
  welcome: 8,
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

// ---------------------------------------------------------------------------
// Live signal derivation — turn the app's activity-event stream and the
// notification inbox into {@link HomeWidgetSignal}s attributed to the home
// widgets that subscribe to each signal kind. This is the seam that makes the
// pure ranker live: the home WidgetHost calls these to feed `rankHomeWidgets`.
// Kept pure + deterministic (timestamps + `now` flow in from the caller).
// ---------------------------------------------------------------------------

/**
 * Raw activity-event `eventType` → canonical signal kind (a key of
 * {@link HOME_SIGNAL_WEIGHTS}). The activity stream uses a wider vocabulary than
 * the weight table; this reconciles it (e.g. `proactive-message → message`).
 * Unmapped types fall through to `activity` (weight 1).
 */
export const EVENT_TYPE_TO_SIGNAL_KIND: Readonly<Record<string, string>> = {
  blocked: "blocked",
  escalation: "escalation",
  approval: "approval",
  welcome: "welcome",
  reminder: "reminder",
  message: "message",
  "proactive-message": "message",
  "check-in": "check-in",
  nudge: "nudge",
  workflow: "workflow",
  // Orchestrator lifecycle/tool events are workflow signals so active runs can
  // lift the owning home widget without needing a separate attention publish.
  // `error` stays at workflow strength too: AcpService emits `error` SessionEvents
  // liberally for transient/recoverable failures (auth prompts, ENOENT, transport
  // hiccups, mid-stream ACP errors), so routing every one to the weight-10 blocked
  // escalation rail would manufacture false top-of-home alarms. Genuine "act now"
  // urgency is already carried by the orchestrator's dedicated `blocked` SessionEvent.
  task_registered: "workflow",
  task_complete: "workflow",
  stopped: "workflow",
  tool_running: "workflow",
  blocked_auto_resolved: "workflow",
  error: "workflow",
  warning: "workflow",
  run_start: "workflow",
  run_end: "workflow",
  step_start: "workflow",
  step_end: "workflow",
  context_loaded: "workflow",
  action_start: "workflow",
  action_complete: "workflow",
  action_error: "workflow",
  action_skipped: "workflow",
  tool_call: "workflow",
  tool_result: "workflow",
  tool_error: "workflow",
  evaluator_start: "workflow",
  evaluator_complete: "workflow",
  evaluator_error: "workflow",
  evaluator_skipped: "workflow",
  provider_start: "workflow",
  provider_complete: "workflow",
  provider_error: "workflow",
  provider_cached: "workflow",
  assistant_thought: "workflow",
  assistant_plan: "workflow",
  assistant_reflection: "workflow",
  message_received: "message",
  message_sent: "message",
  message_queued: "message",
  message_failed: "workflow",
  memory_create: "activity",
  memory_update: "activity",
  memory_delete: "activity",
  memory_search: "activity",
  memory_retrieved: "activity",
};

/** Map a raw activity-event type to its canonical signal kind. */
export function signalKindForEventType(eventType: string): string {
  return EVENT_TYPE_TO_SIGNAL_KIND[eventType] ?? "activity";
}

/** Notification inbox priority → signal kind (so urgent notifications rank like escalations). */
export const NOTIFICATION_PRIORITY_TO_SIGNAL_KIND: Readonly<
  Record<string, string>
> = {
  urgent: "escalation",
  high: "approval",
  normal: "message",
  low: "activity",
};

/**
 * Notification priority → numeric rank (higher = more urgent). The
 * content-level priority scale shared by every surface that orders
 * notifications (the dashboard notification center sorts on it).
 */
export const NOTIFICATION_PRIORITY_RANK: Readonly<Record<string, number>> = {
  urgent: 3,
  high: 2,
  normal: 1,
  low: 0,
};

/** Minimal activity-event shape the signal derivation needs. */
export interface RankableActivityEvent {
  eventType: string;
  timestamp: number;
}

/** Minimal notification shape the signal derivation needs. */
export interface RankableNotification {
  priority?: string;
  /** Epoch-ms the notification was created. */
  timestamp: number;
  /** Whether the user has already seen it — read items don't boost. */
  readAt?: string | number | null;
}

/**
 * Attribute each activity event to every home widget whose `signalKinds`
 * includes the event's canonical kind, producing recency-stamped signals the
 * ranker decays. A widget with no `signalKinds` is never boosted (ranks by
 * static `order` only).
 */
export function homeSignalsFromEvents(
  events: readonly RankableActivityEvent[],
  declarations: readonly RankableHomeWidget[],
): HomeWidgetSignal[] {
  const signals: HomeWidgetSignal[] = [];
  for (const event of events) {
    const kind = signalKindForEventType(event.eventType);
    const weight = homeSignalWeight(kind);
    for (const decl of declarations) {
      if (!decl.signalKinds?.includes(kind)) continue;
      signals.push({
        widgetKey: homeWidgetKey(decl),
        weight,
        timestamp: event.timestamp,
      });
    }
  }
  return signals;
}

/**
 * Attribute unread notifications to every home widget that subscribes to the
 * notification's priority-derived kind (always at least `notification`, so a
 * widget can opt in with `signalKinds: ["notification"]` to react to any
 * notification regardless of priority).
 */
export function homeSignalsFromNotifications(
  notifications: readonly RankableNotification[],
  declarations: readonly RankableHomeWidget[],
): HomeWidgetSignal[] {
  const signals: HomeWidgetSignal[] = [];
  for (const notification of notifications) {
    if (notification.readAt) continue;
    const priorityKind =
      NOTIFICATION_PRIORITY_TO_SIGNAL_KIND[notification.priority ?? "normal"] ??
      "message";
    const kinds = new Set([priorityKind, "notification"]);
    for (const decl of declarations) {
      // A widget can subscribe to both the generic `notification` kind and the
      // priority-specific kind; use the strongest matching weight so an urgent
      // notification ranks at escalation strength rather than the generic floor.
      let weight = 0;
      for (const k of decl.signalKinds ?? []) {
        if (kinds.has(k)) weight = Math.max(weight, homeSignalWeight(k));
      }
      if (weight === 0) continue;
      signals.push({
        widgetKey: homeWidgetKey(decl),
        weight,
        timestamp: notification.timestamp,
      });
    }
  }
  return signals;
}
