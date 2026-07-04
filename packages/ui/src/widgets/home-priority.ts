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

// ---------------------------------------------------------------------------
// Content-item priority *within* a single home widget (#9143). A "default" home
// widget (notifications/messages/activity) shows a capped list, and the items
// themselves carry priority — so the widget must surface the most
// attention-worthy items first, not merely the most recent. This is the
// content-level analogue of the widget-level ranker above. Pure + stable
// (no clock; ties resolve by original order).
// ---------------------------------------------------------------------------

/** Notification priority → numeric rank (higher = more urgent). */
export const NOTIFICATION_PRIORITY_RANK: Readonly<Record<string, number>> = {
  urgent: 3,
  high: 2,
  normal: 1,
  low: 0,
};

/** Minimal notification shape the content ranker needs. */
export interface RankableContentNotification {
  priority?: string;
  /** Epoch-ms when created. */
  createdAt: number;
  /** Epoch-ms when read; unread (null/absent) ranks ahead of read. */
  readAt?: number | null;
}

/**
 * Order notifications inside a home widget by attention: unread before read,
 * then higher priority, then most-recent first. Stable (equal items keep their
 * original relative order) and pure (no `Date.now()`), so the home widget never
 * reshuffles equal-importance items between renders.
 */
export function rankHomeNotifications<T extends RankableContentNotification>(
  items: readonly T[],
): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aUnread = a.item.readAt ? 0 : 1;
      const bUnread = b.item.readAt ? 0 : 1;
      if (aUnread !== bUnread) return bUnread - aUnread;
      const aPriority =
        NOTIFICATION_PRIORITY_RANK[a.item.priority ?? "normal"] ?? 1;
      const bPriority =
        NOTIFICATION_PRIORITY_RANK[b.item.priority ?? "normal"] ?? 1;
      if (aPriority !== bPriority) return bPriority - aPriority;
      if (a.item.createdAt !== b.item.createdAt) {
        return b.item.createdAt - a.item.createdAt;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

// ---------------------------------------------------------------------------
// Home notification QUIET-THRESHOLD + GROUPING (signal, not noise).
//
// The frontpage notification widget was showing every recent notification, so
// a burst of low-value informational items read as a wall of noise. This layer
// makes the HOME surface aggressively quiet:
//   1. A relevance threshold — only unread, recent, and important-enough
//      notifications are eligible for home. Everything else still lives in the
//      full inbox/pull-down; it just never clutters home.
//   2. Category grouping — when several eligible notifications share a category,
//      they collapse into ONE grouped row ("N updates from X") instead of N
//      rows, so a chatty source can't dominate the surface.
// Pure + deterministic: `now` flows in from the caller (no Date.now in render).
// The inbox/pull-down is unaffected — only `selectHomeNotifications` applies
// this, and only the home widget calls it.
// ---------------------------------------------------------------------------

/**
 * Home quiet-threshold + grouping knobs. Exported so the home widget shares one
 * notion of "what deserves home" and Shadow can dial the aggressiveness later
 * without touching the algorithm.
 */
export interface HomeNotificationQuietOptions {
  /** Current time (epoch-ms). Passed in for determinism + testability. */
  now: number;
  /**
   * Minimum priority rank a notification must reach to be eligible for home.
   * Defaults to {@link HOME_MIN_SEVERITY}. Notifications below this never appear
   * on home (they remain in the full inbox).
   */
  minSeverity?: number;
  /**
   * Only notifications newer than this age (epoch-ms delta) are eligible.
   * Defaults to {@link HOME_NOTIFICATION_MAX_AGE_MS}. A stale notification —
   * however important it once was — isn't "act now" and shouldn't sit on home.
   */
  maxAgeMs?: number;
  /**
   * When true (default), only UNREAD notifications are eligible for home.
   * A read notification has already been acknowledged, so it's not signal.
   */
  unreadOnly?: boolean;
  /**
   * When true (default), collapse eligible notifications that share a category
   * into a single grouped row. Set false to keep every eligible notification as
   * its own row (grouping off).
   */
  groupByCategory?: boolean;
  /**
   * A category needs at least this many eligible notifications before it
   * collapses into a grouped row; below it, its notifications stay as single
   * rows. Defaults to {@link HOME_GROUP_MIN_SIZE}.
   */
  groupMinSize?: number;
}

/**
 * The default relevance floor for the home surface: only `high` and `urgent`
 * notifications are important enough to interrupt the home glance. `normal` and
 * `low` land silently in the inbox. Raise/lower to dial the quiet.
 * (2 === `high` in {@link NOTIFICATION_PRIORITY_RANK}.)
 */
export const HOME_MIN_SEVERITY = NOTIFICATION_PRIORITY_RANK.high; // 2

/**
 * How recent a notification must be to be eligible for home. Older than this
 * and it's history, not a live signal. 6h mirrors the widget attention window.
 */
export const HOME_NOTIFICATION_MAX_AGE_MS = 6 * 60 * 60_000;

/** Group a category into one row once it has at least this many eligible items. */
export const HOME_GROUP_MIN_SIZE = 2;

/** Group notifications by their category by default. */
export const GROUP_BY_CATEGORY = true;

/** Minimal notification shape the home quiet/grouping layer needs. */
export interface RankableHomeNotification extends RankableContentNotification {
  /** Producer category — the grouping key. */
  category?: string;
}

/** A single notification eligible for the home surface. */
export interface HomeSingleNotification<T> {
  kind: "single";
  notification: T;
}

/** A collapsed group of same-category notifications on the home surface. */
export interface HomeGroupedNotification<T> {
  kind: "group";
  /** The shared category the group collapses. */
  category: string;
  /** How many notifications this row stands in for. */
  count: number;
  /** The highest-attention member (drives icon/priority/deep-link of the row). */
  lead: T;
  /** Every member, ranked (lead first) — for expansion / a11y. */
  members: T[];
}

/** A home notification entry: either one notification or a collapsed group. */
export type HomeNotificationEntry<T> =
  | HomeSingleNotification<T>
  | HomeGroupedNotification<T>;

/** Numeric priority rank of a notification (higher = more urgent). */
function priorityRank(priority: string | undefined): number {
  return NOTIFICATION_PRIORITY_RANK[priority ?? "normal"] ?? 1;
}

/**
 * Whether a notification clears the home quiet threshold: important enough
 * (severity), fresh enough (recency), and unacknowledged (unread) to be worth
 * interrupting the home glance. Everything failing this stays in the full inbox.
 */
export function isHomeWorthy(
  notification: RankableHomeNotification,
  opts: HomeNotificationQuietOptions,
): boolean {
  const unreadOnly = opts.unreadOnly ?? true;
  if (unreadOnly && notification.readAt) return false;

  const minSeverity = opts.minSeverity ?? HOME_MIN_SEVERITY;
  if (priorityRank(notification.priority) < minSeverity) return false;

  const maxAgeMs = opts.maxAgeMs ?? HOME_NOTIFICATION_MAX_AGE_MS;
  // `now === 0` is the deterministic first-render sentinel (see useNow) — don't
  // age-gate against it, or the home surface flashes empty on first paint.
  if (opts.now > 0 && opts.now - notification.createdAt >= maxAgeMs) {
    return false;
  }
  return true;
}

/**
 * Aggressively reduce the notification list to a QUIET, GROUPED set for the
 * home surface:
 *   1. Drop everything below the quiet threshold ({@link isHomeWorthy}).
 *   2. Rank the survivors by attention ({@link rankHomeNotifications}).
 *   3. Collapse same-category runs into one grouped row once a category has
 *      `groupMinSize`+ survivors, so a chatty source contributes a single
 *      "N updates" row instead of N rows.
 * Returns home ENTRIES (single | group) in attention order — the lead of each
 * group is the highest-attention member, and groups sit where their lead ranks.
 *
 * The full inbox/pull-down does NOT call this — it's home-only. Pure + stable.
 */
export function selectHomeNotifications<T extends RankableHomeNotification>(
  notifications: readonly T[],
  opts: HomeNotificationQuietOptions,
): HomeNotificationEntry<T>[] {
  const eligible = notifications.filter((n) => isHomeWorthy(n, opts));
  const ranked = rankHomeNotifications(eligible);

  const groupByCategory = opts.groupByCategory ?? GROUP_BY_CATEGORY;
  if (!groupByCategory) {
    return ranked.map((notification) => ({ kind: "single", notification }));
  }

  const groupMinSize = opts.groupMinSize ?? HOME_GROUP_MIN_SIZE;

  // Count survivors per category so we know which categories are chatty enough
  // to collapse. A category below the threshold keeps its rows individual.
  const categoryCounts = new Map<string, number>();
  for (const n of ranked) {
    const cat = n.category ?? "general";
    categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1);
  }

  const entries: HomeNotificationEntry<T>[] = [];
  const seenGroupCategory = new Set<string>();
  for (const notification of ranked) {
    const category = notification.category ?? "general";
    const count = categoryCounts.get(category) ?? 1;
    if (count < groupMinSize) {
      entries.push({ kind: "single", notification });
      continue;
    }
    // Chatty category → one grouped row, placed where its lead (highest-
    // attention member) ranks. Since `ranked` is attention-ordered, the first
    // member we hit for this category is the lead.
    if (seenGroupCategory.has(category)) continue;
    seenGroupCategory.add(category);
    const members = ranked.filter((n) => (n.category ?? "general") === category);
    entries.push({
      kind: "group",
      category,
      count: members.length,
      lead: members[0],
      members,
    });
  }
  return entries;
}

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
