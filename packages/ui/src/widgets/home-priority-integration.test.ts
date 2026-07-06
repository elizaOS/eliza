// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
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
 * widgets that need attention FIRST - "the priority decides what shows up and
 * when". This guards the declaration↔ranker contract (not individual widget
 * rendering, which the per-widget suites cover): if a future edit drops a
 * widget's `signalKinds` or mis-weights a signal, this scenario fails.
 */

const NOW = 1_700_000_000_000;

// A runtime plugin snapshot with the per-plugin home widgets enabled + active,
// so resolveWidgetsForSlot("home", …) returns their real declarations.
const PLUGINS: WidgetPluginState[] = [
  { id: "agent-orchestrator", enabled: true, isActive: true },
  { id: "calendar", enabled: true, isActive: true },
  { id: "feed", enabled: true, isActive: true },
  { id: "finances", enabled: true, isActive: true },
  { id: "goals", enabled: true, isActive: true },
  { id: "health", enabled: true, isActive: true },
  { id: "inbox", enabled: true, isActive: true },
  { id: "relationships", enabled: true, isActive: true },
  { id: "todo", enabled: true, isActive: true },
  { id: "workflow", enabled: true, isActive: true },
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

describe("home priority - real declarations + ranker scenario (#9143)", () => {
  it("registers only the kept home widgets with attention signalKinds", () => {
    const byKey = new Map(homeDeclarations().map((d) => [homeWidgetKey(d), d]));
    // Kept cards resolve on the home slot (spec §B target resident set)…
    for (const key of [
      "calendar/calendar.upcoming",
      "needs-attention/needs-attention.pending",
      "todo/todo.items",
    ]) {
      expect(byKey.has(key), `${key} should resolve on home`).toBe(true);
    }
    // …while the demoted/merged residents no longer hold a home declaration:
    // goals.attention merges into the Today (todo) card and health.sleep +
    // wallet.balance move to their routed dashboards (spec §E items 3-5).
    for (const key of [
      "goals/goals.attention",
      "health/health.sleep",
      "wallet/wallet.balance",
      "agent-orchestrator/agent-orchestrator.activity",
      "agent-orchestrator/agent-orchestrator.apps",
      "feed/feed.agent-activity",
      "workflow/workflow.running",
      "finances/finances.alerts",
      "relationships/relationships.attention",
      "inbox/inbox.unread",
    ]) {
      expect(byKey.has(key), `${key} should not resolve on home`).toBe(false);
    }
    // The kept calendar card still subscribes to signal kinds so it floats up.
    expect(byKey.get("calendar/calendar.upcoming")?.signalKinds).toContain(
      "reminder",
    );
  });

  it("floats the widgets that need attention to the front", () => {
    // Realistic moment: an urgent notification arrived and a goal is at-risk.
    // The at-risk goal now lives INSIDE the Today (todo) card (spec §E item 5),
    // so the card self-publishes the goals escalation weight under its OWN key
    // (`todo/todo.items`) - the merged resident, not a separate goals card.
    const signals: HomeWidgetSignal[] = [
      ...homeSignalsFromNotifications(
        [{ priority: "urgent", timestamp: NOW }],
        homeDeclarations(),
      ),
      { widgetKey: "todo/todo.items", weight: 10, timestamp: NOW },
    ];

    const order = rankedKeys(signals);
    const top3 = order.slice(0, 3);

    // The two attention-worthy widgets occupy the front, ahead of every
    // quiet widget (which rank by static base order only). Needs-attention
    // floats via the urgent-notification derivation (urgent → escalation);
    // the Today card rides its merged goal's self-published escalation signal.
    expect(top3).toContain("needs-attention/needs-attention.pending");
    expect(top3).toContain("todo/todo.items");

    // A quiet widget (calendar with no upcoming-event signal) ranks behind them.
    const calendarRank = order.indexOf("calendar/calendar.upcoming");
    const todoRank = order.indexOf("todo/todo.items");
    expect(todoRank).toBeLessThan(calendarRank);

    // The demoted goals card no longer appears as a standalone resident.
    expect(order).not.toContain("goals/goals.attention");
  });

  it("does not route workflow lifecycle events to removed home cards", () => {
    const signals = homeSignalsFromEvents(
      [{ eventType: "tool_running", timestamp: NOW }],
      homeDeclarations(),
    );

    expect(signals.map((s) => s.widgetKey)).not.toEqual(
      expect.arrayContaining([
        "agent-orchestrator/agent-orchestrator.activity",
        "feed/feed.agent-activity",
        "workflow/workflow.running",
      ]),
    );

    const order = rankedKeys(signals);
    expect(order).not.toEqual(
      expect.arrayContaining([
        "agent-orchestrator/agent-orchestrator.activity",
        "feed/feed.agent-activity",
        "workflow/workflow.running",
      ]),
    );
  });

  it("does not route orchestrator errors to a resident home card", () => {
    const signals = homeSignalsFromEvents(
      [{ eventType: "error", timestamp: NOW }],
      homeDeclarations(),
    );

    expect(
      signals.find(
        (s) => s.widgetKey === "agent-orchestrator/agent-orchestrator.activity",
      ),
    ).toBeUndefined();
    const order = rankedKeys(signals);
    expect(order).not.toContain(
      "agent-orchestrator/agent-orchestrator.activity",
    );
  });

  it("with no live signals, ranks purely by base order (quiet home)", () => {
    const order = rankedKeys([]);
    // needs-attention (order 60) outranks the per-plugin cards (order ≥ 110).
    expect(
      order.indexOf("needs-attention/needs-attention.pending"),
    ).toBeLessThan(order.indexOf("calendar/calendar.upcoming"));
  });
});
