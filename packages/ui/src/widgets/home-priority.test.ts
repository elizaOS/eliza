import { describe, expect, it } from "vitest";
import {
  baseHomeScore,
  HOME_MIN_SEVERITY,
  HOME_NOTIFICATION_MAX_AGE_MS,
  HOME_SIGNAL_WEIGHTS,
  type HomeGroupedNotification,
  type HomeWidgetSignal,
  homeSignalsFromEvents,
  homeSignalsFromNotifications,
  homeSignalWeight,
  isHomeWorthy,
  type RankableContentNotification,
  type RankableHomeNotification,
  type RankableHomeWidget,
  rankHomeNotifications,
  rankHomeWidgets,
  scoreHomeWidget,
  selectHomeNotifications,
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
      id: "notifications.recent",
      pluginId: "notifications",
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
      id: "notifications.recent",
      pluginId: "notifications",
      order: 90,
      signalKinds: ["notification", "approval", "escalation"],
    },
  ];

  it("an urgent notification floats the low-base notifications widget to the top", () => {
    const signals = homeSignalsFromNotifications(
      [{ priority: "urgent", timestamp: NOW }],
      decls,
    );
    const ranked = rankHomeWidgets(decls, signals, { now: NOW });
    expect(ranked[0].declaration.id).toBe("notifications.recent");
  });

  it("with no live signals, base order wins (the pinned widget leads)", () => {
    const ranked = rankHomeWidgets(decls, [], { now: NOW });
    expect(ranked[0].declaration.id).toBe("pinned");
  });
});

describe("rankHomeNotifications — content-item priority", () => {
  const n = (
    id: string,
    patch: Partial<RankableContentNotification> = {},
  ): RankableContentNotification & { id: string } => ({
    id,
    priority: "normal",
    createdAt: NOW,
    ...patch,
  });

  it("ranks unread ahead of read regardless of recency", () => {
    const ranked = rankHomeNotifications([
      n("read-new", { createdAt: NOW, readAt: NOW }),
      n("unread-old", { createdAt: NOW - 1_000 }),
    ]);
    expect(ranked.map((x) => x.id)).toEqual(["unread-old", "read-new"]);
  });

  it("ranks higher priority ahead of newer-but-lower priority (attention first)", () => {
    const ranked = rankHomeNotifications([
      n("low-new", { priority: "low", createdAt: NOW }),
      n("urgent-old", { priority: "urgent", createdAt: NOW - 5_000 }),
    ]);
    expect(ranked.map((x) => x.id)).toEqual(["urgent-old", "low-new"]);
  });

  it("breaks priority ties by recency (newest first)", () => {
    const ranked = rankHomeNotifications([
      n("older", { priority: "high", createdAt: NOW - 1_000 }),
      n("newer", { priority: "high", createdAt: NOW }),
    ]);
    expect(ranked.map((x) => x.id)).toEqual(["newer", "older"]);
  });

  it("is stable for fully-equal items (preserves input order)", () => {
    const ranked = rankHomeNotifications([n("a"), n("b"), n("c")]);
    expect(ranked.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});

// The home quiet-threshold + grouping layer (signal, not noise). The full inbox
// never calls these; only the home widget does.
describe("isHomeWorthy — home quiet threshold", () => {
  const hn = (
    patch: Partial<RankableHomeNotification> = {},
  ): RankableHomeNotification => ({
    priority: "high",
    category: "general",
    createdAt: NOW,
    readAt: null,
    ...patch,
  });

  it("admits an unread, recent, high-severity notification", () => {
    expect(isHomeWorthy(hn(), { now: NOW })).toBe(true);
  });

  it("rejects a read notification (already acknowledged = not signal)", () => {
    expect(isHomeWorthy(hn({ readAt: NOW }), { now: NOW })).toBe(false);
  });

  it("rejects below-threshold severity (normal/low stay in the inbox)", () => {
    expect(isHomeWorthy(hn({ priority: "normal" }), { now: NOW })).toBe(false);
    expect(isHomeWorthy(hn({ priority: "low" }), { now: NOW })).toBe(false);
  });

  it("admits urgent (>= HOME_MIN_SEVERITY)", () => {
    expect(isHomeWorthy(hn({ priority: "urgent" }), { now: NOW })).toBe(true);
  });

  it("rejects a stale notification past the recency window", () => {
    const old = hn({ createdAt: NOW - HOME_NOTIFICATION_MAX_AGE_MS - 1 });
    expect(isHomeWorthy(old, { now: NOW })).toBe(false);
  });

  it("does NOT age-filter on the deterministic first render (now === 0)", () => {
    // useNow returns 0 on first paint; a fresh high notification must still show.
    expect(isHomeWorthy(hn({ createdAt: NOW }), { now: 0 })).toBe(true);
  });

  it("HOME_MIN_SEVERITY is `high` (2) by default", () => {
    expect(HOME_MIN_SEVERITY).toBe(2);
  });

  it("a lowered minSeverity lets normal notifications through", () => {
    expect(
      isHomeWorthy(hn({ priority: "normal" }), { now: NOW, minSeverity: 1 }),
    ).toBe(true);
  });

  it("unreadOnly:false lets a read (but important, recent) notification through", () => {
    expect(
      isHomeWorthy(hn({ readAt: NOW }), { now: NOW, unreadOnly: false }),
    ).toBe(true);
  });
});

describe("selectHomeNotifications — quiet + category grouping", () => {
  const hn = (
    id: string,
    patch: Partial<RankableHomeNotification> = {},
  ): RankableHomeNotification & { id: string } => ({
    id,
    priority: "high",
    category: "general",
    createdAt: NOW,
    readAt: null,
    ...patch,
  });

  it("drops everything below the quiet threshold (near-empty unless it matters)", () => {
    const entries = selectHomeNotifications(
      [
        hn("normal", { priority: "normal" }),
        hn("low", { priority: "low" }),
        hn("read-urgent", { priority: "urgent", readAt: NOW }),
        hn("stale-high", { createdAt: NOW - HOME_NOTIFICATION_MAX_AGE_MS - 1 }),
      ],
      { now: NOW },
    );
    // All four fail the threshold (low severity / read / stale) → nothing surfaces.
    expect(entries).toEqual([]);
  });

  it("keeps a single home-worthy notification as a single entry", () => {
    const entries = selectHomeNotifications(
      [hn("a", { category: "health", priority: "urgent" })],
      { now: NOW },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("single");
  });

  it("collapses same-category notifications into ONE grouped row", () => {
    const entries = selectHomeNotifications(
      [
        hn("h1", { category: "health" }),
        hn("h2", { category: "health" }),
        hn("h3", { category: "health" }),
      ],
      { now: NOW },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("group");
    const group = entries[0] as HomeGroupedNotification<
      RankableHomeNotification & { id: string }
    >;
    expect(group.category).toBe("health");
    expect(group.count).toBe(3);
    expect(group.members).toHaveLength(3);
  });

  it("mixes singles and groups: a lone category stays single, a chatty one collapses", () => {
    const entries = selectHomeNotifications(
      [
        hn("lone", { category: "approval", priority: "urgent" }),
        hn("t1", { category: "task" }),
        hn("t2", { category: "task" }),
      ],
      { now: NOW },
    );
    const kinds = entries.map((e) => e.kind).sort();
    expect(kinds).toEqual(["group", "single"]);
    const group = entries.find((e) => e.kind === "group") as
      | HomeGroupedNotification<RankableHomeNotification & { id: string }>
      | undefined;
    expect(group?.category).toBe("task");
    expect(group?.count).toBe(2);
  });

  it("the group lead is the highest-attention member (urgent over high)", () => {
    const entries = selectHomeNotifications(
      [
        hn("high", { category: "task", priority: "high", createdAt: NOW }),
        hn("urgent", {
          category: "task",
          priority: "urgent",
          createdAt: NOW - 5_000,
        }),
      ],
      { now: NOW },
    );
    const group = entries[0] as HomeGroupedNotification<
      RankableHomeNotification & { id: string }
    >;
    expect(group.kind).toBe("group");
    expect(group.lead.id).toBe("urgent");
  });

  it("groupByCategory:false keeps every eligible notification as its own row", () => {
    const entries = selectHomeNotifications(
      [
        hn("h1", { category: "health" }),
        hn("h2", { category: "health" }),
      ],
      { now: NOW, groupByCategory: false },
    );
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.kind === "single")).toBe(true);
  });

  it("groupMinSize gates collapsing (raise it and a pair stays as singles)", () => {
    const entries = selectHomeNotifications(
      [
        hn("h1", { category: "health" }),
        hn("h2", { category: "health" }),
      ],
      { now: NOW, groupMinSize: 3 },
    );
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.kind === "single")).toBe(true);
  });
});
