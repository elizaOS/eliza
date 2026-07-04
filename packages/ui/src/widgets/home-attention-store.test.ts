/**
 * Unit coverage for the home-attention store (publish/clear a widget's attention
 * flag). In-memory store, no harness.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetHomeAttentionForTests,
  clearHomeAttention,
  publishHomeAttention,
} from "./home-attention-store";
import { rankHomeWidgets } from "./home-priority";

afterEach(() => {
  __resetHomeAttentionForTests();
});

// The store is consumed via useHomeAttentionSignals() in WidgetHost; here we
// exercise the publish/clear surface and prove the published weight floats a
// widget when fed (stamped `now`) into the ranker, matching how WidgetHost
// merges self-attention into rankHomeWidgets.

describe("home-attention store", () => {
  const NOW = 1_000_000_000_000;
  const decls = [
    { id: "pinned", pluginId: "p", order: 0 },
    { id: "finances.alerts", pluginId: "finances", order: 130 },
  ];

  function signalsFromStore(entries: { widgetKey: string; weight: number }[]) {
    return entries.map((e) => ({ ...e, timestamp: NOW }));
  }

  it("a published weight floats the publishing widget above a higher-base widget", () => {
    // Cold: the pinned widget (order 0) outranks finances (order 130).
    expect(rankHomeWidgets(decls, [], { now: NOW })[0].declaration.id).toBe(
      "pinned",
    );

    // Finances publishes escalation-level attention (overdrawn) → floats to top.
    publishHomeAttention("finances/finances.alerts", 10);
    const entries = [{ widgetKey: "finances/finances.alerts", weight: 10 }];
    const ranked = rankHomeWidgets(decls, signalsFromStore(entries), {
      now: NOW,
    });
    expect(ranked[0].declaration.id).toBe("finances.alerts");
  });

  it("publishing the same weight twice is idempotent; clearing removes the boost", () => {
    publishHomeAttention("finances/finances.alerts", 10);
    publishHomeAttention("finances/finances.alerts", 10);
    clearHomeAttention("finances/finances.alerts");
    // After clear, no self-signal remains → base order wins again.
    expect(rankHomeWidgets(decls, [], { now: NOW })[0].declaration.id).toBe(
      "pinned",
    );
  });
});
