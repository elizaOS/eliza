// @vitest-environment jsdom

/**
 * Unit coverage for view-launcher interaction telemetry: the bounded event ring
 * and the emit/read surface (including conversation-swipe jank). In-memory ring,
 * no runtime.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FrameBudgetSummary } from "./hooks/frame-budget";
import {
  emitConversationSwipeJank,
  emitViewInteraction,
  readViewInteractions,
  VIEW_INTERACTION_RING_MAX,
  VIEW_INTERACTION_TELEMETRY_EVENT,
  type ViewInteractionEvent,
} from "./view-telemetry";

const SAMPLE_SUMMARY: FrameBudgetSummary = {
  sampleCount: 8,
  fps: 42,
  meanFrameMs: 23.8,
  p95FrameMs: 48,
  worstFrameMs: 120,
  droppedFrames: 3,
  longTasks: 1,
  budgetMs: 16.67,
};

function clearRing() {
  (
    globalThis as { __ELIZA_VIEW_INTERACTION_TELEMETRY__?: unknown[] }
  ).__ELIZA_VIEW_INTERACTION_TELEMETRY__ = [];
}

beforeEach(() => clearRing());
afterEach(() => clearRing());

describe("view-telemetry", () => {
  it("retains emitted events in the ring with stamped at/route", () => {
    emitViewInteraction({
      source: "launcher",
      action: "launch",
      viewId: "x",
    });
    const events = readViewInteractions();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "launcher",
      action: "launch",
      viewId: "x",
    });
    expect(typeof events[0].at).toBe("number");
    // jsdom env configures a concrete url, so route resolves.
    expect(events[0].route).toBe("/");
  });

  it("dispatches a window CustomEvent that listeners can observe", () => {
    const seen: string[] = [];
    const handler = (e: Event) => {
      seen.push((e as CustomEvent).detail.action);
    };
    window.addEventListener(VIEW_INTERACTION_TELEMETRY_EVENT, handler);
    emitViewInteraction({
      source: "view-catalog",
      action: "hero-image-error",
      viewId: "notes",
    });
    window.removeEventListener(VIEW_INTERACTION_TELEMETRY_EVENT, handler);
    expect(seen).toEqual(["hero-image-error"]);
  });

  it("bounds the ring to VIEW_INTERACTION_RING_MAX, dropping the oldest", () => {
    for (let i = 0; i < VIEW_INTERACTION_RING_MAX + 25; i += 1) {
      emitViewInteraction({
        source: "conversation-swipe",
        action: "conversation-swipe-jank",
        count: i,
      });
    }
    const events = readViewInteractions();
    expect(events).toHaveLength(VIEW_INTERACTION_RING_MAX);
    // Oldest (count 0..24) dropped; newest retained.
    expect(events[0].count).toBe(25);
    expect(events[events.length - 1].count).toBe(
      VIEW_INTERACTION_RING_MAX + 24,
    );
  });

  it("retains a conversation-swipe-jank summary + direction into the ring and CustomEvent", () => {
    const seen: ViewInteractionEvent[] = [];
    const handler = (e: Event) => {
      seen.push((e as CustomEvent<ViewInteractionEvent>).detail);
    };
    window.addEventListener(VIEW_INTERACTION_TELEMETRY_EVENT, handler);

    emitConversationSwipeJank(SAMPLE_SUMMARY, "next");

    window.removeEventListener(VIEW_INTERACTION_TELEMETRY_EVENT, handler);

    const latest = readViewInteractions().at(-1);
    expect(latest).toMatchObject({
      source: "conversation-swipe",
      action: "conversation-swipe-jank",
      direction: "next",
      // Headline dropped-frame count is surfaced on `count` for ring scanners.
      count: SAMPLE_SUMMARY.droppedFrames,
    });
    // The full frame-budget summary survives intact into the ring…
    expect(latest?.frameBudget?.droppedFrames).toBe(3);
    expect(latest?.frameBudget?.p95FrameMs).toBe(48);
    // …and the dispatched CustomEvent carries the same payload.
    expect(seen).toHaveLength(1);
    expect(seen[0].direction).toBe("next");
    expect(seen[0].frameBudget?.worstFrameMs).toBe(120);
  });

  it("omits direction for a cancelled (uncommitted) swipe window", () => {
    emitConversationSwipeJank(SAMPLE_SUMMARY);
    expect(readViewInteractions().at(-1)?.direction).toBeUndefined();
  });
});
