// @vitest-environment jsdom

/**
 * Unit coverage for per-view runtime telemetry: the bounded event ring, its
 * install/reset, and the emit/read surface (#10202). In-memory ring, no runtime.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetViewRuntimeTelemetryForTests,
  emitViewRuntimeTelemetry,
  installViewRuntimeTelemetryRing,
  readViewRuntimeTelemetry,
  VIEW_RUNTIME_RING_MAX,
  VIEW_RUNTIME_TELEMETRY_EVENT,
  type ViewRuntimeTelemetryEvent,
  type ViewRuntimeTelemetryReason,
} from "./view-runtime-telemetry";

/**
 * Consumes the per-view runtime-telemetry ring (#10196 / #10202 criterion 5).
 * Before this the instrumentation that powers "is this view leaking / looping /
 * evicting correctly" was emitted and hand-wired but asserted by NO test, so the
 * bounded-memory + dispatch guarantees were unverified.
 */
type EmitInput = Omit<ViewRuntimeTelemetryEvent, "at" | "route">;

function sample(
  viewId: string,
  reason: ViewRuntimeTelemetryReason = "sample",
): EmitInput {
  return {
    viewId,
    phase: "active",
    reason,
    renderCount: 1,
    lastCommitMs: 2,
    commitDurationP95Ms: 3,
    activeSubscriptions: 0,
    pendingTimers: 0,
    heavyResources: { webgl: 0, audio: 0, video: 0 },
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __ELIZA_VIEW_RUNTIME_TELEMETRY__: ViewRuntimeTelemetryEvent[] | undefined;
}

describe("view-runtime-telemetry", () => {
  afterEach(() => {
    __resetViewRuntimeTelemetryForTests();
    delete globalThis.__ELIZA_VIEW_RUNTIME_TELEMETRY__;
  });

  it("reads empty before the ring is installed", () => {
    delete globalThis.__ELIZA_VIEW_RUNTIME_TELEMETRY__;
    expect(readViewRuntimeTelemetry()).toEqual([]);
  });

  it("emit stamps `at` + `route` and returns the detail", () => {
    installViewRuntimeTelemetryRing();
    const detail = emitViewRuntimeTelemetry(sample("chat"));
    expect(detail.viewId).toBe("chat");
    expect(typeof detail.at).toBe("number");
    expect(detail.route).toBe(window.location.pathname);
  });

  it("retains emitted events in the installed ring, in order", () => {
    installViewRuntimeTelemetryRing();
    emitViewRuntimeTelemetry(sample("a"));
    emitViewRuntimeTelemetry(sample("b"));
    expect(readViewRuntimeTelemetry().map((e) => e.viewId)).toEqual(["a", "b"]);
  });

  it("emit is a safe no-op for the ring when it is not installed", () => {
    delete globalThis.__ELIZA_VIEW_RUNTIME_TELEMETRY__;
    expect(() => emitViewRuntimeTelemetry(sample("x"))).not.toThrow();
    expect(readViewRuntimeTelemetry()).toEqual([]);
  });

  it("bounds the ring at VIEW_RUNTIME_RING_MAX, dropping the oldest", () => {
    installViewRuntimeTelemetryRing();
    const total = VIEW_RUNTIME_RING_MAX + 50;
    for (let i = 0; i < total; i += 1)
      emitViewRuntimeTelemetry(sample(`v${i}`));
    const ring = readViewRuntimeTelemetry();
    expect(ring).toHaveLength(VIEW_RUNTIME_RING_MAX);
    // the oldest 50 were dropped → first retained is v50, last is the newest
    expect(ring[0].viewId).toBe("v50");
    expect(ring[ring.length - 1].viewId).toBe(`v${total - 1}`);
  });

  it("dispatches the CustomEvent carrying the detail", () => {
    installViewRuntimeTelemetryRing();
    const handler = vi.fn();
    window.addEventListener(
      VIEW_RUNTIME_TELEMETRY_EVENT,
      handler as EventListener,
    );
    const detail = emitViewRuntimeTelemetry(sample("chat", "hide"));
    window.removeEventListener(
      VIEW_RUNTIME_TELEMETRY_EVENT,
      handler as EventListener,
    );
    expect(handler).toHaveBeenCalledTimes(1);
    const evt = handler.mock
      .calls[0][0] as CustomEvent<ViewRuntimeTelemetryEvent>;
    expect(evt.detail).toEqual(detail);
  });

  it("read returns a copy — mutating it does not corrupt the ring", () => {
    installViewRuntimeTelemetryRing();
    emitViewRuntimeTelemetry(sample("a"));
    const snapshot = readViewRuntimeTelemetry();
    snapshot.push(sample("injected") as ViewRuntimeTelemetryEvent);
    expect(readViewRuntimeTelemetry().map((e) => e.viewId)).toEqual(["a"]);
  });

  it("__resetViewRuntimeTelemetryForTests clears the ring", () => {
    installViewRuntimeTelemetryRing();
    emitViewRuntimeTelemetry(sample("a"));
    __resetViewRuntimeTelemetryForTests();
    expect(readViewRuntimeTelemetry()).toEqual([]);
  });

  it("installViewRuntimeTelemetryRing is idempotent — a second call preserves events", () => {
    installViewRuntimeTelemetryRing();
    emitViewRuntimeTelemetry(sample("a"));
    installViewRuntimeTelemetryRing();
    expect(readViewRuntimeTelemetry().map((e) => e.viewId)).toEqual(["a"]);
  });
});
