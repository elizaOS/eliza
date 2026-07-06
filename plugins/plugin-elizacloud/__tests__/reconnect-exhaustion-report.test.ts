/**
 * Coverage for #14415 (observability): when the cloud ConnectionMonitor
 * exhausts every reconnect attempt, the link is durably down — a failure that
 * previously vanished into a single `logger.error` line. This drives the
 * monitor to full exhaustion with a client whose heartbeat + provision always
 * fail and asserts:
 *   1. `onReconnectExhausted` fires exactly once (report-once, no per-attempt
 *      spam — the #14387 idempotency class of bug).
 *   2. It carries the attempt count so the host can wire it into
 *      `runtime.reportError` with structured context.
 *   3. A throwing exhaustion handler cannot break the monitor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionMonitor } from "../src/cloud/reconnect";

/** Minimal client stub: heartbeat + provision both always fail. */
function deadClient() {
  return {
    heartbeat: vi.fn().mockResolvedValue(false),
    provision: vi.fn().mockRejectedValue(new Error("provision failed")),
  } as unknown as ConstructorParameters<typeof ConnectionMonitor>[0];
}

describe("ConnectionMonitor reconnect-exhaustion observability (#14415)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("fires onReconnectExhausted exactly once with the attempt count", async () => {
    const onReconnectExhausted = vi.fn();
    // Tiny heartbeat interval + maxFailures=1 so a single failed tick trips
    // the reconnect loop immediately.
    const monitor = new ConnectionMonitor(
      deadClient(),
      "agent-1",
      {
        onDisconnect: vi.fn(),
        onReconnect: vi.fn(),
        onStatusChange: vi.fn(),
        onReconnectExhausted,
      },
      10, // heartbeatIntervalMs
      1 // maxFailures
    );

    monitor.start();
    // Fire the first heartbeat tick (heartbeat resolves false → reconnect).
    await vi.advanceTimersByTimeAsync(10);
    // Drive all 10 reconnect attempts + their exponential backoff sleeps to
    // completion. Backoff is capped at 60s/attempt; advancing well past the
    // worst-case total flushes the loop.
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(onReconnectExhausted).toHaveBeenCalledTimes(1);
    expect(onReconnectExhausted).toHaveBeenCalledWith({ attempts: 10 });

    monitor.stop();
  });

  it("a throwing onReconnectExhausted handler does not break the monitor", async () => {
    const onReconnectExhausted = vi.fn(() => {
      throw new Error("host handler blew up");
    });
    const onStatusChange = vi.fn();
    const monitor = new ConnectionMonitor(
      deadClient(),
      "agent-2",
      {
        onDisconnect: vi.fn(),
        onReconnect: vi.fn(),
        onStatusChange,
        onReconnectExhausted,
      },
      10,
      1
    );

    monitor.start();
    await vi.advanceTimersByTimeAsync(10);
    // Must not throw out of the monitor's own timer callback (the try/catch in
    // attemptReconnect absorbs the host handler's throw).
    let threw = false;
    try {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    expect(onReconnectExhausted).toHaveBeenCalledTimes(1);
    // The monitor still reached the terminal "disconnected" status despite the
    // handler throwing.
    expect(onStatusChange).toHaveBeenCalledWith("disconnected");

    monitor.stop();
  });
});
