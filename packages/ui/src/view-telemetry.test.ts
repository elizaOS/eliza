// @vitest-environment jsdom

/**
 * Unit coverage for view-launcher interaction telemetry: the bounded event ring
 * and the emit/read surface. In-memory ring, no runtime.
 */

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
      action: "hero-image-error",
      viewId: "notes",
    });
    window.removeEventListener(VIEW_INTERACTION_TELEMETRY_EVENT, handler);
    expect(seen).toEqual(["hero-image-error"]);
  });

  it("bounds the ring to VIEW_INTERACTION_RING_MAX, dropping the oldest", () => {
    for (let i = 0; i < VIEW_INTERACTION_RING_MAX + 25; i += 1) {
      emitViewInteraction({
        source: "launcher",
        action: "launch",
        viewId: `view-${i}`,
      });
    }
    const events = readViewInteractions();
    expect(events).toHaveLength(VIEW_INTERACTION_RING_MAX);
    // Oldest (view-0..view-24) dropped; newest retained.
    expect(events[0].viewId).toBe("view-25");
    expect(events[events.length - 1].viewId).toBe(
      `view-${VIEW_INTERACTION_RING_MAX + 24}`,
    );
  });
});
