/**
 * Regression for #29941: `ConnectionMonitor.stop()` must cancel an in-flight
 * `attemptReconnect()` loop so no lifecycle callback fires after teardown.
 *
 * The monitor runs a detached retry loop that awaits `client.provision()` and
 * inter-attempt backoff sleeps. Before the fix, `stop()` had no way to signal
 * that loop: a `provision()` that resolved after `stop()` still emitted
 * `onStatusChange("connected")` + `onReconnect()`, and an exhausted loop still
 * emitted `onStatusChange("disconnected")` + `onReconnectExhausted()`. Because
 * `CloudManager.disconnect()` calls `stop()` and nulls its proxy, those stale
 * callbacks fire a state-machine transition after teardown. These tests drive
 * the real `ConnectionMonitor` with a client whose `provision()` is a
 * test-controlled deferred, so `stop()` can be interleaved with the exact
 * await points inside the loop. Uses vitest fake timers; the client stub is the
 * only mock — the monitor under test is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionMonitor } from "../src/cloud/reconnect";

const HEARTBEAT_INTERVAL_MS = 1_000;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ConnectionMonitor.stop() cancels in-flight reconnect (#29941)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("suppresses onReconnect/onStatusChange when stop() runs during the provision await", async () => {
    // provision() hangs on a deferred the test controls, so we can call stop()
    // while the loop is parked inside `await client.provision()`.
    const provisionGate = deferred<void>();
    const client = {
      heartbeat: vi.fn().mockResolvedValue(false),
      provision: vi.fn().mockReturnValue(provisionGate.promise),
    } as unknown as ConstructorParameters<typeof ConnectionMonitor>[0];

    const onReconnect = vi.fn();
    const statusChanges: string[] = [];
    const monitor = new ConnectionMonitor(
      client,
      "agent-1",
      {
        onDisconnect: vi.fn(),
        onReconnect,
        onStatusChange: (s) => statusChanges.push(s),
      },
      HEARTBEAT_INTERVAL_MS,
      1 // maxFailures — a single failed heartbeat enters attemptReconnect
    );

    monitor.start();
    // One failed heartbeat → monitor enters attemptReconnect and awaits provision().
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

    // The loop is confirmed entered and parked on provision().
    expect((client.provision as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(statusChanges).toEqual(["reconnecting"]);

    // Tear down while the loop is awaiting provision().
    monitor.stop();
    expect(monitor.isMonitoring()).toBe(false);
    const reconnectCallsAtStop = onReconnect.mock.calls.length;
    const statusesAtStop = [...statusChanges];

    // provision() now resolves *after* stop(). The stale loop must abandon
    // itself: no "connected" status, no onReconnect().
    provisionGate.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(onReconnect.mock.calls.length).toBe(reconnectCallsAtStop);
    expect(statusChanges).toEqual(statusesAtStop);
    expect(statusChanges).not.toContain("connected");
  });

  it("suppresses onReconnectExhausted/disconnected when stop() runs during the backoff sleep", async () => {
    // provision() always rejects, so the loop falls through to the backoff
    // sleep. We call stop() while that sleep is pending, before exhaustion.
    const client = {
      heartbeat: vi.fn().mockResolvedValue(false),
      provision: vi.fn().mockRejectedValue(new Error("provision failed")),
    } as unknown as ConstructorParameters<typeof ConnectionMonitor>[0];

    const onReconnectExhausted = vi.fn();
    const statusChanges: string[] = [];
    const monitor = new ConnectionMonitor(
      client,
      "agent-2",
      {
        onDisconnect: vi.fn(),
        onReconnect: vi.fn(),
        onStatusChange: (s) => statusChanges.push(s),
        onReconnectExhausted,
      },
      HEARTBEAT_INTERVAL_MS,
      1
    );

    monitor.start();
    // Failed heartbeat → reconnect → first provision() rejects → parks on the
    // 3s backoff sleep before attempt 2.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(statusChanges).toEqual(["reconnecting"]);

    // Stop mid-backoff, then let all possible timers/microtasks flush. A live
    // loop would run 10 attempts (backoff capped at 60s) and then fire the
    // exhaustion callbacks; a cancelled one must not.
    monitor.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(onReconnectExhausted).not.toHaveBeenCalled();
    expect(statusChanges).not.toContain("disconnected");
    // provision() must not keep being retried after stop().
    expect((client.provision as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("regression: an un-stopped monitor still fires onReconnect exactly once on a recovered provision", async () => {
    // provision() succeeds on the first attempt; with no stop() the loop must
    // still emit the success path exactly once.
    const client = {
      heartbeat: vi.fn().mockResolvedValue(false),
      provision: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConstructorParameters<typeof ConnectionMonitor>[0];

    const onReconnect = vi.fn();
    const statusChanges: string[] = [];
    const monitor = new ConnectionMonitor(
      client,
      "agent-3",
      {
        onDisconnect: vi.fn(),
        onReconnect,
        onStatusChange: (s) => statusChanges.push(s),
      },
      HEARTBEAT_INTERVAL_MS,
      1
    );

    monitor.start();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    // Flush the resolved provision() microtask.
    await vi.advanceTimersByTimeAsync(0);

    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(statusChanges).toEqual(["reconnecting", "connected"]);

    monitor.stop();
  });

  it("a monitor restarted after a cancelled reconnect is not wedged by the reconnecting flag", async () => {
    // stop() cancelling a loop mid-provision leaves attemptReconnect() to bail
    // via the post-await token checkpoint, which returns *without* clearing
    // `reconnecting`. stop()'s own `reconnecting = false` is therefore the only
    // thing that stops a restarted monitor from wedging on tick()'s
    // `if (this.reconnecting) return` guard forever. First provision() hangs so
    // stop() lands mid-await; the second resolves so the restarted monitor must
    // recover normally.
    const firstProvision = deferred<void>();
    const client = {
      heartbeat: vi.fn().mockResolvedValue(false),
      provision: vi.fn().mockReturnValueOnce(firstProvision.promise).mockResolvedValue(undefined),
    } as unknown as ConstructorParameters<typeof ConnectionMonitor>[0];

    const onReconnect = vi.fn();
    const monitor = new ConnectionMonitor(
      client,
      "agent-4",
      { onDisconnect: vi.fn(), onReconnect, onStatusChange: vi.fn() },
      HEARTBEAT_INTERVAL_MS,
      1
    );

    // Enter attemptReconnect, park on the first (hanging) provision(), then
    // cancel. The stale loop must abandon itself and fire no onReconnect.
    monitor.start();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    monitor.stop();
    firstProvision.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(onReconnect).not.toHaveBeenCalled();

    // Restart: the monitor must not be wedged by a stale `reconnecting` flag.
    // The next failed heartbeat must re-enter the loop and recover on the
    // second (resolving) provision().
    monitor.start();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(onReconnect).toHaveBeenCalledTimes(1);

    monitor.stop();
  });
});
