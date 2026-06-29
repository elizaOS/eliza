// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emitViewInteraction,
  readViewInteractions,
  VIEW_INTERACTION_RING_MAX,
  VIEW_INTERACTION_TELEMETRY_EVENT,
} from "./view-telemetry";

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
      action: "search",
      query: "q",
    });
    window.removeEventListener(VIEW_INTERACTION_TELEMETRY_EVENT, handler);
    expect(seen).toEqual(["search"]);
  });

  it("bounds the ring to VIEW_INTERACTION_RING_MAX, dropping the oldest", () => {
    for (let i = 0; i < VIEW_INTERACTION_RING_MAX + 25; i += 1) {
      emitViewInteraction({
        source: "launcher",
        action: "page-swipe",
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
});
