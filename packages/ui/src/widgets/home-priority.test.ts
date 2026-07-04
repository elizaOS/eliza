/**
 * Unit coverage for home-widget priority scoring from activity signals. Pure
 * functions, no harness.
 */
import { describe, expect, it } from "vitest";
import {
  baseHomeScore,
  HOME_SIGNAL_WEIGHTS,
  type HomeWidgetSignal,
  homeSignalsFromEvents,
  homeSignalsFromNotifications,
  homeSignalWeight,
  NOTIFICATION_PRIORITY_RANK,
  type RankableHomeWidget,
  rankHomeWidgets,
  scoreHomeWidget,
  signalKindForEventType,
} from "./home-priority";

const NOW = 1_000_000_000_000;
const widget = (id: string, order?: number) => ({
  id,
  pluginId: "p",
  order,
});

describe("baseHomeScore", () => {
  it("maps lower order to higher base (pinned widgets rank first)", () => {
    expect(baseHomeScore(0)).toBe(1);
    expect(baseHomeScore(50)).toBeCloseTo(0.5);
    expect(baseHomeScore(100)).toBe(0);
  });

  it("defaults missing/invalid order to 100 (base 0)", () => {
    expect(baseHomeScore(undefined)).toBe(0);
    expect(baseHomeScore(Number.NaN)).toBe(0);
  });

  it("clamps order > 100 to a non-negative base", () => {
    expect(baseHomeScore(250)).toBe(0);
  });
});

describe("homeSignalWeight", () => {
  it("weights urgent event types above ambient ones", () => {
    expect(homeSignalWeight("blocked")).toBeGreaterThan(
      homeSignalWeight("activity"),
    );
    expect(homeSignalWeight("reminder")).toBeGreaterThan(
      homeSignalWeight("workflow"),
    );
  });

  it("falls back to the activity weight for unknown types", () => {
    expect(homeSignalWeight("totally-unknown")).toBe(
      HOME_SIGNAL_WEIGHTS.activity,
    );
  });
});

describe("scoreHomeWidget", () => {
  it("returns the base score when there are no signals", () => {
    expect(scoreHomeWidget(widget("a", 0), [], { now: NOW })).toBe(1);
  });

  it("adds a fresh signal's full weight on top of base", () => {
    const signals: HomeWidgetSignal[] = [
      { widgetKey: "p/a", weight: 10, timestamp: NOW },
    ];
    // base(order 100)=0 + 10 * decay(0)=10
    expect(scoreHomeWidget(widget("a", 100), signals, { now: NOW })).toBe(10);
  });

  it("decays a signal by recency (half-life)", () => {
    const halfLife = 30 * 60_000;
    const signals: HomeWidgetSignal[] = [
      { widgetKey: "p/a", weight: 8, timestamp: NOW - halfLife },
    ];
    // one half-life old → 8 * 0.5 = 4
    expect(
      scoreHomeWidget(widget("a", 100), signals, {
        now: NOW,
        signalHalfLifeMs: halfLife,
      }),
    ).toBeCloseTo(4);
  });

  it("ignores signals older than the max age", () => {
    const signals: HomeWidgetSignal[] = [
      { widgetKey: "p/a", weight: 100, timestamp: NOW - 7 * 60 * 60_000 },
    ];
    expect(
      scoreHomeWidget(widget("a", 0), signals, {
        now: NOW,
        signalMaxAgeMs: 6 * 60 * 60_000,
      }),
    ).toBe(1); // only base survives
  });

  it("only counts signals attributed to this widget", () => {
    const signals: HomeWidgetSignal[] = [
      { widgetKey: "p/other", weight: 99, timestamp: NOW },
    ];
    expect(scoreHomeWidget(widget("a", 100), signals, { now: NOW })).toBe(0);
  });
});

describe("rankHomeWidgets — dynamic importance, top-N", () => {
  it("a live attention signal floats a low-base widget to the top", () => {
    const decls = [widget("pinned", 0), widget("noisy", 100)];
    const signals: HomeWidgetSignal[] = [
      { widgetKey: "p/noisy", weight: 10, timestamp: NOW },
    ];
    const ranked = rankHomeWidgets(decls, signals, { now: NOW });
    expect(ranked.map((r) => r.declaration.id)).toEqual(["noisy", "pinned"]);
  });

  it("orders quiet widgets by base priority", () => {
    const decls = [widget("low", 100), widget("high", 10), widget("mid", 50)];
    const ranked = rankHomeWidgets(decls, [], { now: NOW });
    expect(ranked.map((r) => r.declaration.id)).toEqual(["high", "mid", "low"]);
  });

  it("caps the result to maxVisible (only the most important show)", () => {
    const decls = Array.from({ length: 10 }, (_, i) => widget(`w${i}`, i * 10));
    const ranked = rankHomeWidgets(decls, [], { now: NOW, maxVisible: 3 });
    expect(ranked).toHaveLength(3);
    expect(ranked.map((r) => r.declaration.id)).toEqual(["w0", "w1", "w2"]);
  });

  it("breaks ties deterministically by widget key (no reshuffle)", () => {
    const decls = [widget("b", 50), widget("a", 50)];
    const ranked = rankHomeWidgets(decls, [], { now: NOW });
    expect(ranked.map((r) => r.declaration.id)).toEqual(["a", "b"]);
  });

  it("minScore above base hides declared-but-quiet widgets, keeps active ones", () => {
    const decls = [widget("quiet", 0), widget("active", 100)];
    const signals: HomeWidgetSignal[] = [
      { widgetKey: "p/active", weight: 5, timestamp: NOW },
    ];
    // base max is 1; minScore 1.5 requires live attention to clear the bar.
    const ranked = rankHomeWidgets(decls, signals, { now: NOW, minScore: 1.5 });
    expect(ranked.map((r) => r.declaration.id)).toEqual(["active"]);
  });

  it("returns nothing for maxVisible 0", () => {
    expect(
      rankHomeWidgets([widget("a")], [], { now: NOW, maxVisible: 0 }),
    ).toEqual([]);
  });
});

describe("signalKindForEventType", () => {
  it("passes through known kinds and normalizes aliases", () => {
    expect(signalKindForEventType("blocked")).toBe("blocked");
    expect(signalKindForEventType("proactive-message")).toBe("message");
    expect(signalKindForEventType("task_complete")).toBe("workflow");
    expect(signalKindForEventType("tool_running")).toBe("workflow");
    expect(signalKindForEventType("error")).toBe("workflow");
  });

  it("normalizes typed AgentEventService streams to home signal kinds", () => {
    expect(signalKindForEventType("action_complete")).toBe("workflow");
    expect(signalKindForEventType("tool_result")).toBe("workflow");
    expect(signalKindForEventType("provider_cached")).toBe("workflow");
    expect(signalKindForEventType("message_received")).toBe("message");
    expect(signalKindForEventType("memory_search")).toBe("activity");
  });

  it("falls back to activity for unknown event types", () => {
    expect(signalKindForEventType("nonsense")).toBe("activity");
  });

  it("maps the welcome event type to the welcome signal kind (#9959)", () => {
    expect(signalKindForEventType("welcome")).toBe("welcome");
  });
});

// #9959 — the FTU `welcome` card must outrank every cold/ambient widget for a
// brand-new account, yet always lose to a real "act now" signal so it never
// buries an approval/escalation/blocked card the moment real activity exists.
describe("welcome (FTU) signal weight ordering — #9959", () => {
  it("ranks above every cold/ambient kind", () => {
    const w = HOME_SIGNAL_WEIGHTS;
    for (const cold of [
      "reminder",
      "message",
      "check-in",
      "nudge",
      "workflow",
      "activity",
    ]) {
      expect(w.welcome).toBeGreaterThan(w[cold]);
    }
  });

  it("stays strictly below every act-now signal", () => {
    const w = HOME_SIGNAL_WEIGHTS;
    for (const actNow of ["approval", "escalation", "blocked"]) {
      expect(w.welcome).toBeLessThan(w[actNow]);
    }
  });

  it("floats a cold welcome widget to the top yet yields to a fresh approval", () => {
    const now = NOW;
    const welcomeCard = { id: "ftu", pluginId: "welcome", order: 5 };
    const inboxCard = { id: "inbox", pluginId: "p", order: 5 };
    const decls = [inboxCard, welcomeCard];
    // Cold account: only the welcome signal is live → welcome card ranks first.
    const cold = rankHomeWidgets(
      decls,
      [
        {
          widgetKey: "welcome/ftu",
          weight: HOME_SIGNAL_WEIGHTS.welcome,
          timestamp: now,
        },
      ],
      { now },
    );
    expect(cold[0].declaration.id).toBe("ftu");
    // A real approval lands on the inbox card → it must outrank the welcome card.
    const active = rankHomeWidgets(
      decls,
      [
        {
          widgetKey: "welcome/ftu",
          weight: HOME_SIGNAL_WEIGHTS.welcome,
          timestamp: now,
        },
        {
          widgetKey: "p/inbox",
          weight: HOME_SIGNAL_WEIGHTS.approval,
          timestamp: now,
        },
      ],
      { now },
    );
    expect(active[0].declaration.id).toBe("inbox");
  });
});

describe("homeSignalsFromEvents", () => {
  const decls: RankableHomeWidget[] = [
    {
      id: "act",
      pluginId: "p",
      order: 100,
      signalKinds: ["blocked", "activity"],
    },
    { id: "workflow", pluginId: "p", order: 80, signalKinds: ["workflow"] },
    { id: "msg", pluginId: "p", order: 60, signalKinds: ["message"] },
    { id: "static", pluginId: "p", order: 50 }, // no signalKinds → never boosted
  ];

  it("attributes an event to every widget whose signalKinds match its kind", () => {
    const signals = homeSignalsFromEvents(
      [{ eventType: "blocked", timestamp: NOW }],
      decls,
    );
    expect(signals).toEqual([
      {
        widgetKey: "p/act",
        weight: HOME_SIGNAL_WEIGHTS.blocked,
        timestamp: NOW,
      },
    ]);
  });

  it("normalizes the event vocabulary before matching (proactive-message → message)", () => {
    const signals = homeSignalsFromEvents(
      [{ eventType: "proactive-message", timestamp: NOW }],
      decls,
    );
    expect(signals.map((s) => s.widgetKey)).toEqual(["p/msg"]);
    expect(signals[0].weight).toBe(HOME_SIGNAL_WEIGHTS.message);
  });

  it("routes orchestrator lifecycle events through workflow", () => {
    const signals = homeSignalsFromEvents(
      [{ eventType: "tool_running", timestamp: NOW }],
      decls,
    );
    expect(signals).toEqual([
      {
        widgetKey: "p/workflow",
        weight: HOME_SIGNAL_WEIGHTS.workflow,
        timestamp: NOW,
      },
    ]);
  });

  it("routes orchestrator errors through workflow (not the escalation rail)", () => {
    const signals = homeSignalsFromEvents(
      [{ eventType: "error", timestamp: NOW }],
      decls,
    );
    expect(signals).toEqual([
      {
        widgetKey: "p/workflow",
        weight: HOME_SIGNAL_WEIGHTS.workflow,
        timestamp: NOW,
      },
    ]);
    // Guardrail: a transient orchestrator error must never reach blocked weight,
    // so liberal `error` SessionEvents cannot manufacture false top-of-home alarms.
    expect(signals[0].weight).toBeLessThan(HOME_SIGNAL_WEIGHTS.blocked);
  });

  it("never boosts a widget without signalKinds", () => {
    const signals = homeSignalsFromEvents(
      [{ eventType: "activity", timestamp: NOW }],
      decls,
    );
    expect(signals.every((s) => s.widgetKey !== "p/static")).toBe(true);
  });
});

describe("homeSignalsFromNotifications", () => {
  const notifDecl: RankableHomeWidget[] = [
    {
      id: "inbox",
      pluginId: "p",
      order: 50,
      signalKinds: ["notification", "approval", "escalation"],
    },
  ];

  it("maps an urgent notification to the escalation-weight signal", () => {
    const signals = homeSignalsFromNotifications(
      [{ priority: "urgent", timestamp: NOW }],
      notifDecl,
    );
    expect(signals).toHaveLength(1);
    // urgent → escalation kind, and the widget subscribes to escalation.
    expect(signals[0].weight).toBe(HOME_SIGNAL_WEIGHTS.escalation);
  });

  it("ignores notifications the user has already read", () => {
    const signals = homeSignalsFromNotifications(
      [{ priority: "urgent", timestamp: NOW, readAt: NOW }],
      notifDecl,
    );
    expect(signals).toEqual([]);
  });

  it("matches any-priority notifications via the generic 'notification' kind", () => {
    const signals = homeSignalsFromNotifications(
      [{ priority: "low", timestamp: NOW }],
      notifDecl,
    );
    // low → activity kind (not subscribed) but the generic 'notification' kind is.
    expect(signals).toHaveLength(1);
    expect(signals[0].weight).toBe(HOME_SIGNAL_WEIGHTS.activity);
  });
});

describe("rankHomeWidgets — end-to-end with derived signals", () => {
  const decls: RankableHomeWidget[] = [
    { id: "pinned", pluginId: "p", order: 0 }, // highest base, no signals
    {
      id: "inbox",
      pluginId: "p",
      order: 90,
      signalKinds: ["notification", "approval", "escalation"],
    },
  ];

  it("an urgent notification floats a low-base subscribed widget to the top", () => {
    const signals = homeSignalsFromNotifications(
      [{ priority: "urgent", timestamp: NOW }],
      decls,
    );
    const ranked = rankHomeWidgets(decls, signals, { now: NOW });
    expect(ranked[0].declaration.id).toBe("inbox");
  });

  it("with no live signals, base order wins (the pinned widget leads)", () => {
    const ranked = rankHomeWidgets(decls, [], { now: NOW });
    expect(ranked[0].declaration.id).toBe("pinned");
  });
});

describe("NOTIFICATION_PRIORITY_RANK — the shared content-priority scale", () => {
  it("orders urgent > high > normal > low", () => {
    // The dashboard notification center sorts rows on this scale; every
    // notification-ordering surface must agree on the same total order.
    expect(NOTIFICATION_PRIORITY_RANK.urgent).toBeGreaterThan(
      NOTIFICATION_PRIORITY_RANK.high,
    );
    expect(NOTIFICATION_PRIORITY_RANK.high).toBeGreaterThan(
      NOTIFICATION_PRIORITY_RANK.normal,
    );
    expect(NOTIFICATION_PRIORITY_RANK.normal).toBeGreaterThan(
      NOTIFICATION_PRIORITY_RANK.low,
    );
  });
});
