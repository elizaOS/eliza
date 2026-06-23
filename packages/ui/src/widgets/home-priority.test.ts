import { describe, expect, it } from "vitest";
import {
  baseHomeScore,
  HOME_SIGNAL_WEIGHTS,
  type HomeWidgetSignal,
  homeSignalWeight,
  rankHomeWidgets,
  scoreHomeWidget,
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
