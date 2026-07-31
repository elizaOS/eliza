/**
 * Exercises reconnect exhaustion, heartbeat serialization, and cancellation
 * with virtual time. The client boundary is deterministic so the monitor's
 * asynchronous lifecycle can be verified without waiting through backoff.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionMonitor } from "../src/cloud/reconnect";

/** Minimal client stub: heartbeat + provision both always fail. */
function deadClient() {
  return {
    heartbeat: vi.fn().mockResolvedValue(false),
    provision: vi.fn().mockRejectedValue(new Error("provision failed")),
  };
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
    let monitor: ConnectionMonitor;
    // Tiny heartbeat interval + maxFailures=1 so a single failed tick trips
    // the reconnect loop immediately.
    monitor = new ConnectionMonitor(
      deadClient(),
      "agent-1",
      {
        onDisconnect: vi.fn(),
        onReconnect: vi.fn(),
        onStatusChange: vi.fn(),
        onReconnectExhausted: (context) => {
          onReconnectExhausted(context);
          monitor.stop();
        },
      },
      10, // heartbeatIntervalMs
      1 // maxFailures
    );

    monitor.start();
    // Fire the first heartbeat tick (heartbeat resolves false → reconnect).
    await vi.advanceTimersByTimeAsync(10);
    // Drive all reconnect attempts and their backoff to completion. The
    // exhaustion callback stops the monitor so another cycle cannot start.
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(onReconnectExhausted).toHaveBeenCalledTimes(1);
    expect(onReconnectExhausted).toHaveBeenCalledWith({ attempts: 10 });
  });

  it("a throwing onReconnectExhausted handler does not break the monitor", async () => {
    let monitor: ConnectionMonitor;
    const onReconnectExhausted = vi.fn(() => {
      monitor.stop();
      throw new Error("host handler blew up");
    });
    const onStatusChange = vi.fn();
    monitor = new ConnectionMonitor(
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
  });

  it("does not overlap heartbeat requests", async () => {
    let resolveHeartbeat: ((alive: boolean) => void) | undefined;
    const heartbeat = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveHeartbeat = resolve;
        })
    );
    const monitor = new ConnectionMonitor(
      {
        heartbeat,
        provision: vi.fn().mockResolvedValue(undefined),
      },
      "agent-3",
      {
        onDisconnect: vi.fn(),
        onReconnect: vi.fn(),
      },
      10,
      1
    );

    monitor.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(heartbeat).toHaveBeenCalledTimes(1);

    resolveHeartbeat?.(true);
    await vi.advanceTimersByTimeAsync(9);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(heartbeat).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it("keeps scheduling health checks after a callback throws", async () => {
    const heartbeat = vi.fn().mockResolvedValue(false);
    const monitor = new ConnectionMonitor(
      {
        heartbeat,
        provision: vi.fn().mockResolvedValue(undefined),
      },
      "agent-4",
      {
        onDisconnect: vi.fn(() => {
          throw new Error("host callback failed");
        }),
        onReconnect: vi.fn(),
      },
      10,
      1
    );

    monitor.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(heartbeat).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it("stops an in-flight reconnect without waiting for its backoff", async () => {
    const client = deadClient();
    const onReconnectExhausted = vi.fn();
    const monitor = new ConnectionMonitor(
      client,
      "agent-5",
      {
        onDisconnect: vi.fn(),
        onReconnect: vi.fn(),
        onReconnectExhausted,
      },
      10,
      1
    );

    monitor.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(client.provision).toHaveBeenCalledTimes(1);

    monitor.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(client.provision).toHaveBeenCalledTimes(1);
    expect(onReconnectExhausted).not.toHaveBeenCalled();
  });
});
