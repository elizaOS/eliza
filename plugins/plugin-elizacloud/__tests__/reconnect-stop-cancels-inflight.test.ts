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
 * callbacks fire a state-machine transition after teardown. The earliest await
 * is `tick()`'s own `client.heartbeat()`; a `stop()` there must also abandon
 * the tick before it reaches `onDisconnect()`/`attemptReconnect()`, since the
 * loop inherits its lifecycle token from that pre-heartbeat capture. These
 * tests drive the real `ConnectionMonitor` with a client whose `heartbeat()`
 * and `provision()` are test-controlled deferreds, so `stop()` can be
 * interleaved with the exact await points. Uses vitest fake timers; the client
 * stub is the only mock — the monitor under test is real.
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

  it("suppresses onDisconnect/onReconnect when stop() runs during the heartbeat await", async () => {
    // The earliest await in a tick is `client.heartbeat()`. If stop() lands
    // while a tick is parked there, the stale continuation must not fire
    // onDisconnect() or enter attemptReconnect() after teardown — and even a
    // successful provision() that follows must emit nothing. Before threading
    // the lifecycle token from tick() (captured *before* the heartbeat await)
    // into attemptReconnect(), the loop captured the already-incremented token
    // as its own baseline, so this exact interleaving reconnected after stop().
    const heartbeatGate = deferred<boolean>();
    const client = {
      heartbeat: vi.fn().mockReturnValue(heartbeatGate.promise),
      provision: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConstructorParameters<typeof ConnectionMonitor>[0];

    const onDisconnect = vi.fn();
    const onReconnect = vi.fn();
    const statusChanges: string[] = [];
    const monitor = new ConnectionMonitor(
      client,
      "agent-hb",
      {
        onDisconnect,
        onReconnect,
        onStatusChange: (s) => statusChanges.push(s),
      },
      HEARTBEAT_INTERVAL_MS,
      1
    );

    monitor.start();
    // Fire the interval so tick() runs and parks inside `await heartbeat()`.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect((client.heartbeat as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((client.provision as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);

    // Tear down while the tick is still awaiting the heartbeat.
    monitor.stop();
    expect(monitor.isMonitoring()).toBe(false);

    // The heartbeat now resolves "dead" *after* stop(). The stale tick must
    // abandon itself: no onDisconnect(), no provision(), no onReconnect(), and
    // no status transition at all.
    heartbeatGate.resolve(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(onDisconnect).not.toHaveBeenCalled();
    expect(onReconnect).not.toHaveBeenCalled();
    expect((client.provision as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect(statusChanges).toEqual([]);
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

  it("suppresses reconnect work when stop() runs synchronously inside onDisconnect()", async () => {
    // onDisconnect() is a public synchronous callback that may tear the monitor
    // down. If it calls stop(), runToken advances synchronously; the reconnect
    // loop must not start — no "reconnecting" status, no provision(). Before the
    // token re-check between onDisconnect() and attemptReconnect(), the loop ran
    // up to its first post-await check, firing both side effects on a stopped
    // monitor.
    const client = {
      heartbeat: vi.fn().mockResolvedValue(false),
      provision: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConstructorParameters<typeof ConnectionMonitor>[0];

    const statusChanges: string[] = [];
    const onReconnect = vi.fn();
    let monitor!: ConnectionMonitor;
    const onDisconnect = vi.fn(() => {
      // Tear the monitor down from within the disconnect callback.
      monitor.stop();
    });
    monitor = new ConnectionMonitor(
      client,
      "agent-sync-stop",
      {
        onDisconnect,
        onReconnect,
        onStatusChange: (s) => statusChanges.push(s),
      },
      HEARTBEAT_INTERVAL_MS,
      1
    );

    monitor.start();
    // One failed heartbeat → tick() calls onDisconnect(), which stops the
    // monitor synchronously before attemptReconnect() would run.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(monitor.isMonitoring()).toBe(false);
    // The reconnect loop must never have started.
    expect((client.provision as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect(onReconnect).not.toHaveBeenCalled();
    expect(statusChanges).toEqual([]);
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

  it('suppresses provision() when stop() runs synchronously inside onStatusChange("reconnecting")', async () => {
    // onStatusChange is public and synchronous, exactly like onDisconnect. A
    // caller may tear the monitor down from inside the "reconnecting" emit.
    // Without the loop-top token recheck, attemptReconnect() still issues one
    // provision() request on a stopped monitor.
    const client = {
      heartbeat: vi.fn().mockResolvedValue(false),
      provision: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConstructorParameters<typeof ConnectionMonitor>[0];

    const statusChanges: string[] = [];
    const onReconnect = vi.fn();
    let monitor!: ConnectionMonitor;
    const onStatusChange = vi.fn((s: string) => {
      statusChanges.push(s);
      if (s === "reconnecting") monitor.stop();
    });
    monitor = new ConnectionMonitor(
      client,
      "agent-sc-reconnecting",
      { onDisconnect: vi.fn(), onReconnect, onStatusChange },
      HEARTBEAT_INTERVAL_MS,
      1
    );

    monitor.start();
    // Failed heartbeat → attemptReconnect → emits "reconnecting" → caller stops.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(monitor.isMonitoring()).toBe(false);
    expect(statusChanges).toEqual(["reconnecting"]);
    // A torn-down monitor must issue no provision() request.
    expect((client.provision as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('suppresses onReconnect() when stop() runs synchronously inside onStatusChange("connected")', async () => {
    // The success branch emits "connected" then onReconnect(). If the caller
    // stops from inside the "connected" callback, onReconnect() must not fire
    // into a torn-down manager.
    const client = {
      heartbeat: vi.fn().mockResolvedValue(false),
      provision: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConstructorParameters<typeof ConnectionMonitor>[0];

    const statusChanges: string[] = [];
    const onReconnect = vi.fn();
    let monitor!: ConnectionMonitor;
    const onStatusChange = vi.fn((s: string) => {
      statusChanges.push(s);
      if (s === "connected") monitor.stop();
    });
    monitor = new ConnectionMonitor(
      client,
      "agent-sc-connected",
      { onDisconnect: vi.fn(), onReconnect, onStatusChange },
      HEARTBEAT_INTERVAL_MS,
      1
    );

    monitor.start();
    // Failed heartbeat → reconnect → provision() succeeds → emits "connected"
    // → caller stops before onReconnect() would fire.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(monitor.isMonitoring()).toBe(false);
    expect(statusChanges).toEqual(["reconnecting", "connected"]);
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('suppresses onReconnectExhausted() when stop() runs synchronously inside onStatusChange("disconnected")', async () => {
    // The exhaustion branch emits "disconnected" then onReconnectExhausted(). A
    // caller may stop from inside the "disconnected" callback; the exhaustion
    // callback must not fire after teardown. maxFailures + a single attempt
    // budget is not configurable, so drive real exhaustion with a rejecting
    // provision() and flush all backoff timers.
    const client = {
      heartbeat: vi.fn().mockResolvedValue(false),
      provision: vi.fn().mockRejectedValue(new Error("provision failed")),
    } as unknown as ConstructorParameters<typeof ConnectionMonitor>[0];

    const statusChanges: string[] = [];
    const onReconnectExhausted = vi.fn();
    let monitor!: ConnectionMonitor;
    const onStatusChange = vi.fn((s: string) => {
      statusChanges.push(s);
      if (s === "disconnected") monitor.stop();
    });
    monitor = new ConnectionMonitor(
      client,
      "agent-sc-disconnected",
      {
        onDisconnect: vi.fn(),
        onReconnect: vi.fn(),
        onStatusChange,
        onReconnectExhausted,
      },
      HEARTBEAT_INTERVAL_MS,
      1
    );

    monitor.start();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    // Flush all 10 attempts and their capped backoff sleeps to reach exhaustion.
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(statusChanges).toContain("disconnected");
    expect(monitor.isMonitoring()).toBe(false);
    // stop() ran inside the "disconnected" callback; the exhaustion callback
    // must not fire after teardown.
    expect(onReconnectExhausted).not.toHaveBeenCalled();
  });
});
