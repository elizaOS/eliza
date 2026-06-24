/**
 * Activity-stream → home-widget signal attribution (#9143).
 *
 * {@link rankHomeWidgets} (home-priority.ts) ranks the home surface by base
 * priority plus decayed attention {@link HomeWidgetSignal}s, but it deliberately
 * does NOT know how those signals are sourced — its docstring (and the
 * `WidgetHost` home-ranking comment) defer "the signal→widget attribution and
 * event-stream wiring" to the consumer. This module is that missing seam: it
 * maps the live {@link ActivityEvent} stream (from `useActivityEvents`) onto the
 * specific home widget each event should boost, so an escalation lights up the
 * notifications widget, a proactive message lights up messages, and everything
 * else feeds the agent-orchestrator activity widget.
 *
 * It is pure and React-free (the `ActivityEvent` import is type-only) so it can
 * be unit-tested and called off the render path — the importance WEIGHT is left
 * to {@link homeSignalWeight} so there is exactly one notion of "how urgent is
 * this kind of event" across the home surface.
 */

import type { ActivityEvent } from "../hooks/useActivityEvents";
import { type HomeWidgetSignal, homeSignalWeight } from "./home-priority";

/**
 * The home widgets activity signals can be attributed to. Keys are the canonical
 * `${pluginId}/${id}` widget keys (see `homeWidgetKey`). Anything without an
 * explicit mapping falls through to the agent-orchestrator activity feed.
 */
export const ACTIVITY_SIGNAL_SINKS = {
  notifications: "notifications/notifications.recent",
  messages: "messages/messages.recent",
  activity: "agent-orchestrator/agent-orchestrator.activity",
} as const;

/**
 * Attention/blocking events that belong on the notifications widget — the
 * things that need a human to look or decide. Covers the blocking/decision
 * events emitted on the task stream (`blocked`, `escalation`, `error`,
 * `blocked_auto_resolved`) and the proactive attention nudges surfaced from the
 * assistant stream (`reminder`, `nudge`, `check-in`).
 */
export const ACTIVITY_EVENT_SINK: Readonly<Record<string, string>> = {
  blocked: ACTIVITY_SIGNAL_SINKS.notifications,
  blocked_auto_resolved: ACTIVITY_SIGNAL_SINKS.notifications,
  escalation: ACTIVITY_SIGNAL_SINKS.notifications,
  error: ACTIVITY_SIGNAL_SINKS.notifications,
  reminder: ACTIVITY_SIGNAL_SINKS.notifications,
  nudge: ACTIVITY_SIGNAL_SINKS.notifications,
  "check-in": ACTIVITY_SIGNAL_SINKS.notifications,
  "proactive-message": ACTIVITY_SIGNAL_SINKS.messages,
  message: ACTIVITY_SIGNAL_SINKS.messages,
};

/** Resolve the home widget an activity event should boost. */
export function activityEventSink(eventType: string): string {
  return ACTIVITY_EVENT_SINK[eventType] ?? ACTIVITY_SIGNAL_SINKS.activity;
}

/**
 * Map a live activity-event stream onto home-widget importance signals — one
 * signal per event, attributed to the widget {@link activityEventSink} resolves,
 * weighted by {@link homeSignalWeight}, stamped with the event's own timestamp
 * (so {@link rankHomeWidgets} can decay it by recency). Pure: same input → same
 * output, no clock read.
 */
export function activityEventsToHomeSignals(
  events: readonly ActivityEvent[],
): HomeWidgetSignal[] {
  return events.map((event) => ({
    widgetKey: activityEventSink(event.eventType),
    weight: homeSignalWeight(event.eventType),
    timestamp: event.timestamp,
  }));
}
