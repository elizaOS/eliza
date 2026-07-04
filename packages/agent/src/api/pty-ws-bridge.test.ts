/**
 * Unit tests for the WS-side PTY plumbing extracted from server.ts, run against
 * an in-memory EventEmitter bridge and fake timers (no real PTY).
 * attachPtySessionWsBridge bridges session_output/session_exit to the client as
 * pty-output/pty-exit frames, filtered per session, with both listeners
 * detaching together; schedulePtySessionStopAfterGrace /
 * cancelPendingPtySessionStop defer the session reap by a grace window so a
 * phone lock or network blip does not kill the client's sessions instantly.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachPtySessionWsBridge,
  cancelPendingPtySessionStop,
  DEFAULT_PTY_DISCONNECT_GRACE_MS,
  type PtyWsFrame,
  resolvePtyDisconnectGraceMs,
  schedulePtySessionStopAfterGrace,
} from "./pty-ws-bridge.ts";

function makeBridge() {
  const emitter = new EventEmitter();
  return {
    emitter,
    bridge: {
      on: (event: string, listener: (...args: unknown[]) => void) =>
        void emitter.on(event, listener),
      off: (event: string, listener: (...args: unknown[]) => void) =>
        void emitter.off(event, listener),
    },
  };
}

describe("attachPtySessionWsBridge", () => {
  it("forwards session_output as pty-output frames for the subscribed session only", () => {
    const { emitter, bridge } = makeBridge();
    const frames: PtyWsFrame[] = [];
    attachPtySessionWsBridge({
      bridge,
      sessionId: "sess-a",
      send: (frame) => frames.push(frame),
    });

    emitter.emit("session_output", { sessionId: "sess-a", data: "hello" });
    emitter.emit("session_output", { sessionId: "sess-other", data: "nope" });

    expect(frames).toEqual([
      { type: "pty-output", sessionId: "sess-a", data: "hello" },
    ]);
  });

  it("forwards session_exit as a pty-exit frame with the exit code", () => {
    const { emitter, bridge } = makeBridge();
    const frames: PtyWsFrame[] = [];
    attachPtySessionWsBridge({
      bridge,
      sessionId: "sess-a",
      send: (frame) => frames.push(frame),
    });

    emitter.emit("session_exit", { sessionId: "sess-other", exitCode: 1 });
    emitter.emit("session_exit", { sessionId: "sess-a", exitCode: 0 });

    expect(frames).toEqual([
      { type: "pty-exit", sessionId: "sess-a", exitCode: 0 },
    ]);
  });

  it("normalizes a missing/killed exit code to null", () => {
    const { emitter, bridge } = makeBridge();
    const frames: PtyWsFrame[] = [];
    attachPtySessionWsBridge({
      bridge,
      sessionId: "sess-a",
      send: (frame) => frames.push(frame),
    });

    emitter.emit("session_exit", { sessionId: "sess-a", exitCode: null });

    expect(frames).toEqual([
      { type: "pty-exit", sessionId: "sess-a", exitCode: null },
    ]);
  });

  it("detach removes BOTH listeners (pty-unsubscribe / ws close cleanup)", () => {
    const { emitter, bridge } = makeBridge();
    const frames: PtyWsFrame[] = [];
    const detach = attachPtySessionWsBridge({
      bridge,
      sessionId: "sess-a",
      send: (frame) => frames.push(frame),
    });

    detach();
    emitter.emit("session_output", { sessionId: "sess-a", data: "late" });
    emitter.emit("session_exit", { sessionId: "sess-a", exitCode: 0 });

    expect(frames).toEqual([]);
    expect(emitter.listenerCount("session_output")).toBe(0);
    expect(emitter.listenerCount("session_exit")).toBe(0);
  });

  it("ignores malformed bridge payloads instead of forwarding junk", () => {
    const { emitter, bridge } = makeBridge();
    const frames: PtyWsFrame[] = [];
    attachPtySessionWsBridge({
      bridge,
      sessionId: "sess-a",
      send: (frame) => frames.push(frame),
    });

    emitter.emit("session_output", null);
    emitter.emit("session_output", { sessionId: "sess-a", data: 42 });
    emitter.emit("session_exit", "sess-a");

    expect(frames).toEqual([]);
  });
});

describe("schedulePtySessionStopAfterGrace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT stop sessions before the grace window elapses", () => {
    const pendingStops = new Map<string, ReturnType<typeof setTimeout>>();
    const stop = vi.fn();
    schedulePtySessionStopAfterGrace({
      clientId: "client-1",
      graceMs: 30_000,
      pendingStops,
      clientHasLiveConnection: () => false,
      stopOwnedSessions: stop,
    });

    vi.advanceTimersByTime(29_999);
    expect(stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(pendingStops.size).toBe(0);
  });

  it("a reconnect within the window cancels the pending stop", () => {
    const pendingStops = new Map<string, ReturnType<typeof setTimeout>>();
    const stop = vi.fn();
    schedulePtySessionStopAfterGrace({
      clientId: "client-1",
      graceMs: 30_000,
      pendingStops,
      clientHasLiveConnection: () => false,
      stopOwnedSessions: stop,
    });

    vi.advanceTimersByTime(5_000);
    expect(cancelPendingPtySessionStop("client-1", pendingStops)).toBe(true);

    vi.advanceTimersByTime(60_000);
    expect(stop).not.toHaveBeenCalled();
    expect(pendingStops.size).toBe(0);
  });

  it("skips scheduling when another live socket shares the clientId (multi-tab)", () => {
    const pendingStops = new Map<string, ReturnType<typeof setTimeout>>();
    const stop = vi.fn();
    schedulePtySessionStopAfterGrace({
      clientId: "client-1",
      graceMs: 30_000,
      pendingStops,
      clientHasLiveConnection: () => true,
      stopOwnedSessions: stop,
    });

    expect(pendingStops.size).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(stop).not.toHaveBeenCalled();
  });

  it("re-checks liveness at fire time (cancel raced the timer)", () => {
    const pendingStops = new Map<string, ReturnType<typeof setTimeout>>();
    const stop = vi.fn();
    let live = false;
    schedulePtySessionStopAfterGrace({
      clientId: "client-1",
      graceMs: 30_000,
      pendingStops,
      clientHasLiveConnection: () => live,
      stopOwnedSessions: stop,
    });

    live = true; // client reconnected but the cancel path was missed
    vi.advanceTimersByTime(30_000);
    expect(stop).not.toHaveBeenCalled();
  });

  it("re-scheduling for the same clientId replaces the previous timer", () => {
    const pendingStops = new Map<string, ReturnType<typeof setTimeout>>();
    const stop = vi.fn();
    const schedule = () =>
      schedulePtySessionStopAfterGrace({
        clientId: "client-1",
        graceMs: 30_000,
        pendingStops,
        clientHasLiveConnection: () => false,
        stopOwnedSessions: stop,
      });

    schedule();
    vi.advanceTimersByTime(20_000);
    schedule(); // e.g. close fired again for a short-lived reconnect
    vi.advanceTimersByTime(20_000); // 40s after first schedule, 20s after second
    expect(stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("cancelPendingPtySessionStop returns false when nothing is pending", () => {
    const pendingStops = new Map<string, ReturnType<typeof setTimeout>>();
    expect(cancelPendingPtySessionStop("client-1", pendingStops)).toBe(false);
  });
});

describe("resolvePtyDisconnectGraceMs", () => {
  it("defaults when unset/blank/invalid/negative", () => {
    expect(resolvePtyDisconnectGraceMs(undefined)).toBe(
      DEFAULT_PTY_DISCONNECT_GRACE_MS,
    );
    expect(resolvePtyDisconnectGraceMs("")).toBe(
      DEFAULT_PTY_DISCONNECT_GRACE_MS,
    );
    expect(resolvePtyDisconnectGraceMs("nope")).toBe(
      DEFAULT_PTY_DISCONNECT_GRACE_MS,
    );
    expect(resolvePtyDisconnectGraceMs("-5")).toBe(
      DEFAULT_PTY_DISCONNECT_GRACE_MS,
    );
  });

  it("honors explicit values, including 0 (legacy stop-on-close)", () => {
    expect(resolvePtyDisconnectGraceMs("0")).toBe(0);
    expect(resolvePtyDisconnectGraceMs("15000")).toBe(15_000);
  });
});
