// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  HOME_SIGNAL_WEIGHTS,
  type HomeWidgetSignal,
  homeSignalsFromEvents,
  homeSignalsFromNotifications,
  homeWidgetKey,
  rankHomeWidgets,
} from "./home-priority";
import { resolveWidgetsForSlot, type WidgetPluginState } from "./registry";

/**
 * End-to-end wiring scenario (#9143): the REAL home widget declarations (their
 * `signalKinds`) + the REAL ranker, fed realistic attention, must surface the
 * widgets that need attention FIRST — "the priority decides what shows up and
 * when". This guards the declaration↔ranker contract (not individual widget
 * rendering, which the per-widget suites cover): if a future edit drops a
 * widget's `signalKinds` or mis-weights a signal, this scenario fails.
 */

const NOW = 1_700_000_000_000;

// A runtime plugin snapshot with the per-plugin home widgets enabled + active,
// so resolveWidgetsForSlot("home", …) returns their real declarations.
const PLUGINS: WidgetPluginState[] = [
  { id: "calendar", enabled: true, isActive: true },
  { id: "goals", enabled: true, isActive: true },
  { id: "finances", enabled: true, isActive: true },
  { id: "health", enabled: true, isActive: true },
  { id: "relationships", enabled: true, isActive: true },
  { id: "agent-orchestrator", enabled: true, isActive: true },
  { id: "todo", enabled: true, isActive: true },
];

function homeDeclarations() {
  return resolveWidgetsForSlot("home", PLUGINS).map((r) => r.declaration);
}

function rankedKeys(signals: HomeWidgetSignal[]): string[] {
  // Match WidgetHost: it ranks and renders all home widgets (capped only as a
  // safety bound), relying on each to self-hide when empty.
  return rankHomeWidgets(homeDeclarations(), signals, {
    now: NOW,
    maxVisible: 20,
  }).map((r) => homeWidgetKey(r.declaration));
}

describe("home priority — real declarations + ranker scenario (#9143)", () => {
  it("registers the per-plugin home widgets with attention signalKinds", () => {
    const byKey = new Map(homeDeclarations().map((d) => [homeWidgetKey(d), d]));
    // The five real per-plugin cards resolve on the home slot…
    for (const key of [
      "calendar/calendar.upcoming",
      "goals/goals.attention",
      "finances/finances.alerts",
      "health/health.sleep",
      "relationships/relationships.attention",
    ]) {
      expect(byKey.has(key), `${key} should resolve on home`).toBe(true);
    }
    // …and each subscribes to at least one attention kind so it can float up.
    expect(byKey.get("finances/finances.alerts")?.signalKinds).toContain(
      "escalation",
    );
    expect(byKey.get("goals/goals.attention")?.signalKinds).toContain(
      "escalation",
    );
    expect(byKey.get("calendar/calendar.upcoming")?.signalKinds).toContain(
      "reminder",
    );
  });

  it("floats the widgets that need attention to the front", () => {
    // Realistic moment: an urgent notification arrived, finances is overdrawn,
    // and a goal is at-risk — each contributes a high-weight signal (the urgent
    // notification via the inbox derivation, finances + goals via their own
    // self-published attention, exactly as WidgetHost merges them).
    const signals: HomeWidgetSignal[] = [
      ...homeSignalsFromNotifications(
        [{ priority: "urgent", timestamp: NOW }],
        homeDeclarations(),
      ),
      { widgetKey: "finances/finances.alerts", weight: 10, timestamp: NOW },
      { widgetKey: "goals/goals.attention", weight: 10, timestamp: NOW },
    ];

    const order = rankedKeys(signals);
    const top3 = order.slice(0, 3);

    // The three attention-worthy widgets occupy the front, ahead of every
    // quiet widget (which rank by static base order only). Needs-attention
    // floats purely via the urgent-notification derivation (urgent →
    // escalation, which it subscribes to); finances/goals ride their own
    // self-published signals.
    expect(top3).toContain("needs-attention/needs-attention.pending");
    expect(top3).toContain("finances/finances.alerts");
    expect(top3).toContain("goals/goals.attention");

    // A quiet widget (calendar with no upcoming-event signal) ranks behind them.
    const calendarRank = order.indexOf("calendar/calendar.upcoming");
    const financesRank = order.indexOf("finances/finances.alerts");
    expect(financesRank).toBeLessThan(calendarRank);
  });

  it("floats orchestrator activity for workflow lifecycle events", () => {
    const signals = homeSignalsFromEvents(
      [{ eventType: "tool_running", timestamp: NOW }],
      homeDeclarations(),
    );

    // A workflow event boosts every workflow-subscribed home widget: the
    // orchestrator activity card and the curated agent-activity feed tile. Both
    // float to workflow strength.
    expect(signals).toContainEqual({
      widgetKey: "agent-orchestrator/agent-orchestrator.activity",
      weight: HOME_SIGNAL_WEIGHTS.workflow,
      timestamp: NOW,
    });
    expect(signals).toContainEqual({
      widgetKey: "feed/feed.agent-activity",
      weight: HOME_SIGNAL_WEIGHTS.workflow,
      timestamp: NOW,
    });

    const order = rankedKeys(signals);
    // The workflow-boosted widgets sit at the very front, ahead of a quiet
    // card (needs-attention has no workflow subscription, so it ranks by its
    // static base order only).
    expect(order.slice(0, 2)).toEqual(
      expect.arrayContaining([
        "agent-orchestrator/agent-orchestrator.activity",
        "feed/feed.agent-activity",
      ]),
    );
    expect(
      order.indexOf("agent-orchestrator/agent-orchestrator.activity"),
    ).toBeLessThan(order.indexOf("needs-attention/needs-attention.pending"));
  });

  it("floats orchestrator errors via workflow, not the escalation rail", () => {
    const signals = homeSignalsFromEvents(
      [{ eventType: "error", timestamp: NOW }],
      homeDeclarations(),
    );

    // An error lifts the orchestrator card to the top of a quiet home, but at
    // workflow strength — NOT the weight-10 blocked rail. Transient/recoverable
    // orchestrator errors are common, so escalation-strength routing would
    // manufacture false alarms; genuine urgency rides the `blocked` SessionEvent.
    expect(signals).toContainEqual({
      widgetKey: "agent-orchestrator/agent-orchestrator.activity",
      weight: HOME_SIGNAL_WEIGHTS.workflow,
      timestamp: NOW,
    });
    expect(
      signals.find(
        (s) => s.widgetKey === "agent-orchestrator/agent-orchestrator.activity",
      )?.weight,
    ).toBeLessThan(HOME_SIGNAL_WEIGHTS.blocked);
    // The error lifts the orchestrator card to the front of a quiet home (the
    // curated agent-activity feed tile, also workflow-subscribed, floats with
    // it), both ahead of the quiet needs-attention baseline.
    const order = rankedKeys(signals);
    expect(order.slice(0, 2)).toContain(
      "agent-orchestrator/agent-orchestrator.activity",
    );
    expect(
      order.indexOf("agent-orchestrator/agent-orchestrator.activity"),
    ).toBeLessThan(order.indexOf("needs-attention/needs-attention.pending"));
  });

  it("with no live signals, ranks purely by base order (quiet home)", () => {
    const order = rankedKeys([]);
    // needs-attention (order 60) outranks the per-plugin cards (order ≥ 110).
    expect(
      order.indexOf("needs-attention/needs-attention.pending"),
    ).toBeLessThan(order.indexOf("finances/finances.alerts"));
  });
});
