/** Unit coverage for the fused-wake window-event seam between the native runtime and useWakeController. */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitFusedWake,
  FUSED_WAKE_EVENT,
  type FusedWakeEvent,
  probeFusedWake,
  subscribeFusedWake,
} from "./fused-wake-bridge";

describe("fused-wake-bridge", () => {
  afterEach(() => {
    delete window.__ELIZA_FUSED_WAKE__;
    vi.restoreAllMocks();
  });

  describe("probeFusedWake", () => {
    it("reports unavailable while the host flag is unset", () => {
      expect(probeFusedWake()).toBe(false);
    });

    it("reports available once the native host sets the flag", () => {
      window.__ELIZA_FUSED_WAKE__ = true;
      expect(probeFusedWake()).toBe(true);
    });

    it("stays unavailable for truthy non-true flags", () => {
      window.__ELIZA_FUSED_WAKE__ = "yes" as unknown as boolean;
      expect(probeFusedWake()).toBe(false);
    });
  });

  describe("emit + subscribe round trip", () => {
    it("delivers a head-fired stage to a subscribed listener", () => {
      const listener = vi.fn();
      const unsubscribe = subscribeFusedWake(listener);

      const detail: FusedWakeEvent = { stage: "head-fired", confidence: 0.87 };
      emitFusedWake(detail);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(detail);
      unsubscribe();
    });

    it("delivers stage-b transcripts verbatim for two-stage confirmation", () => {
      const received: FusedWakeEvent[] = [];
      const unsubscribe = subscribeFusedWake((event) => received.push(event));

      emitFusedWake({ stage: "stage-b-transcript", transcript: "hey eliza" });

      expect(received).toEqual([
        { stage: "stage-b-transcript", transcript: "hey eliza" },
      ]);
      unsubscribe();
    });

    it("notifies every current subscriber", () => {
      const first = vi.fn();
      const second = vi.fn();
      const unsubFirst = subscribeFusedWake(first);
      const unsubSecond = subscribeFusedWake(second);

      emitFusedWake({ stage: "stage-a-candidate" });

      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
      unsubFirst();
      unsubSecond();
    });
  });

  describe("unsubscribe", () => {
    it("stops delivery after the cleanup runs", () => {
      const listener = vi.fn();
      const unsubscribe = subscribeFusedWake(listener);

      emitFusedWake({ stage: "head-fired" });
      unsubscribe();
      emitFusedWake({ stage: "head-fired" });

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("leaves other subscribers active after one unsubscribes", () => {
      const kept = vi.fn();
      const dropped = vi.fn();
      const unsubDropped = subscribeFusedWake(dropped);
      const unsubKept = subscribeFusedWake(kept);
      unsubDropped();

      emitFusedWake({ stage: "head-fired" });

      expect(dropped).not.toHaveBeenCalled();
      expect(kept).toHaveBeenCalledTimes(1);
      unsubKept();
    });
  });

  it("ignores same-name events that carry no detail", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFusedWake(listener);

    window.dispatchEvent(new CustomEvent(FUSED_WAKE_EVENT));

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
