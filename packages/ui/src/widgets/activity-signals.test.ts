import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../hooks/useActivityEvents";
import {
  ACTIVITY_SIGNAL_SINKS,
  activityEventSink,
  activityEventsToHomeSignals,
} from "./activity-signals";
import { homeSignalWeight, rankHomeWidgets } from "./home-priority";

/**
 * Activity-stream → home-widget signal attribution (#9143). Pins the mapping
 * that bridges the live `ActivityEvent` stream into the `HomeWidgetSignal`s
 * `rankHomeWidgets` consumes: which widget each event boosts, that the weight
 * is delegated to `homeSignalWeight`, and that the result actually moves the
 * home ranking.
 */

const evt = (
  eventType: string,
  timestamp: number,
  overrides: Partial<ActivityEvent> = {},
): ActivityEvent => ({
  id: `evt-${eventType}-${timestamp}`,
  eventType,
  timestamp,
  summary: eventType,
  ...overrides,
});

describe("activityEventSink", () => {
  it("routes attention/blocking events to the notifications widget", () => {
    for (const type of [
      "blocked",
      "blocked_auto_resolved",
      "escalation",
      "error",
      "reminder",
      "nudge",
      "check-in",
    ]) {
      expect(activityEventSink(type)).toBe(ACTIVITY_SIGNAL_SINKS.notifications);
    }
  });

  it("routes conversational events to the messages widget", () => {
    expect(activityEventSink("proactive-message")).toBe(
      ACTIVITY_SIGNAL_SINKS.messages,
    );
    expect(activityEventSink("message")).toBe(ACTIVITY_SIGNAL_SINKS.messages);
  });

  it("falls back to the agent-orchestrator activity widget for unmapped types", () => {
    expect(activityEventSink("task_registered")).toBe(
      ACTIVITY_SIGNAL_SINKS.activity,
    );
    expect(activityEventSink("tool_running")).toBe(
      ACTIVITY_SIGNAL_SINKS.activity,
    );
    expect(activityEventSink("workflow")).toBe(ACTIVITY_SIGNAL_SINKS.activity);
    expect(activityEventSink("something-brand-new")).toBe(
      ACTIVITY_SIGNAL_SINKS.activity,
    );
  });
});

describe("activityEventsToHomeSignals", () => {
  it("maps one signal per event with the delegated weight and the event timestamp", () => {
    const events = [
      evt("escalation", 1000),
      evt("proactive-message", 2000),
      evt("tool_running", 3000),
    ];
    const signals = activityEventsToHomeSignals(events);

    expect(signals).toEqual([
      {
        widgetKey: ACTIVITY_SIGNAL_SINKS.notifications,
        weight: homeSignalWeight("escalation"),
        timestamp: 1000,
      },
      {
        widgetKey: ACTIVITY_SIGNAL_SINKS.messages,
        weight: homeSignalWeight("proactive-message"),
        timestamp: 2000,
      },
      {
        widgetKey: ACTIVITY_SIGNAL_SINKS.activity,
        weight: homeSignalWeight("tool_running"),
        timestamp: 3000,
      },
    ]);
  });

  it("returns an empty signal set for an empty stream (deterministic, no clock read)", () => {
    expect(activityEventsToHomeSignals([])).toEqual([]);
  });

  it("feeds rankHomeWidgets so a fresh escalation outranks a cold higher-base widget", () => {
    // notifications has a WORSE base order (lower priority) than activity, so
    // with no signals 'activity' would rank first. A fresh escalation signal
    // must flip notifications to the top.
    const declarations = [
      { id: "notifications.recent", pluginId: "notifications", order: 80 },
      {
        id: "agent-orchestrator.activity",
        pluginId: "agent-orchestrator",
        order: 10,
      },
    ];
    const now = 10_000;
    const signals = activityEventsToHomeSignals([evt("escalation", now)]);

    const ranked = rankHomeWidgets(declarations, signals, { now });
    expect(ranked[0]?.declaration.pluginId).toBe("notifications");
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
  });
});
