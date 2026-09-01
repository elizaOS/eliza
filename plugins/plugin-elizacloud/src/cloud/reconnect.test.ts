/**
 * Lifecycle tests for ConnectionMonitor's reconnect ladder. A monitor the host
 * has stopped must abandon an in-flight ladder: no further provision calls, no
 * status or reconnect callbacks, and no timer left behind to keep the process
 * alive. Deterministic harness — real ConnectionMonitor, fake timers, a stub
 * client, and the core logger mocked out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { ConnectionMonitor } from "./reconnect.ts";

type Outcome = "ok" | "fail";

function makeClient(outcomes: Outcome[]) {
  let calls = 0;
  const provision = vi.fn(async () => {
    const outcome = outcomes[Math.min(calls, outcomes.length - 1)];
    calls += 1;
    if (outcome === "fail") throw new Error("cloud unreachable");
    return {};
  });
  return {
    heartbeat: vi.fn(async () => false),
    provision,
  };
}

function makeCallbacks() {
  return {
    onDisconnect: vi.fn(),
    onReconnect: vi.fn(),
    onStatusChange: vi.fn(),
    onReconnectExhausted: vi.fn(),
  };
}

const HEARTBEAT_MS = 10;
const FIRST_BACKOFF_MS = 3_000;

describe("ConnectionMonitor stop() fences the reconnect ladder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("completes the ladder and reconnects when never stopped (harness control)", async () => {
    const client = makeClient(["fail", "ok"]);
    const callbacks = makeCallbacks();
    const monitor = new ConnectionMonitor(client as never, "agent-1", callbacks, HEARTBEAT_MS, 1);

    monitor.start();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await vi.advanceTimersByTimeAsync(FIRST_BACKOFF_MS);

    expect(client.provision).toHaveBeenCalledTimes(2);
    expect(callbacks.onReconnect).toHaveBeenCalledTimes(1);
    expect(callbacks.onStatusChange).toHaveBeenLastCalledWith("connected");
    monitor.stop();
  });

  it("abandons an in-flight ladder after stop(): no more provisioning, no callbacks", async () => {
    const client = makeClient(["fail", "ok"]);
    const callbacks = makeCallbacks();
    const monitor = new ConnectionMonitor(client as never, "agent-1", callbacks, HEARTBEAT_MS, 1);

    monitor.start();
    // First tick: heartbeat fails, ladder starts, attempt 1 rejects, backoff sleep armed.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(client.provision).toHaveBeenCalledTimes(1);
    expect(callbacks.onStatusChange).toHaveBeenLastCalledWith("reconnecting");

    monitor.stop();
    expect(monitor.isMonitoring()).toBe(false);
    callbacks.onStatusChange.mockClear();

    // Everything the ladder could still do must not happen once stopped.
    await vi.advanceTimersByTimeAsync(FIRST_BACKOFF_MS * 4);

    expect(client.provision).toHaveBeenCalledTimes(1);
    expect(callbacks.onReconnect).not.toHaveBeenCalled();
    expect(callbacks.onStatusChange).not.toHaveBeenCalled();
  });

  it("leaves no backoff timer pending after stop()", async () => {
    const client = makeClient(["fail"]);
    const callbacks = makeCallbacks();
    const monitor = new ConnectionMonitor(client as never, "agent-1", callbacks, HEARTBEAT_MS, 1);

    monitor.start();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a provision call that resolves after stop() was called mid-flight", async () => {
    let resolveProvision: (() => void) | undefined;
    const client = {
      heartbeat: vi.fn(async () => false),
      provision: vi.fn(
        () =>
          new Promise<unknown>((resolve) => {
            resolveProvision = () => resolve({});
          }),
      ),
    };
    const callbacks = makeCallbacks();
    const monitor = new ConnectionMonitor(client as never, "agent-1", callbacks, HEARTBEAT_MS, 1);

    monitor.start();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(client.provision).toHaveBeenCalledTimes(1);

    // The host tears the monitor down while the network call is still out.
    monitor.stop();
    callbacks.onStatusChange.mockClear();
    resolveProvision?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(callbacks.onReconnect).not.toHaveBeenCalled();
    expect(callbacks.onStatusChange).not.toHaveBeenCalledWith("connected");
  });

  it("does not report exhaustion for a ladder that was stopped mid-backoff", async () => {
    const client = makeClient(["fail"]);
    const callbacks = makeCallbacks();
    const monitor = new ConnectionMonitor(client as never, "agent-1", callbacks, HEARTBEAT_MS, 1);

    monitor.start();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    monitor.stop();
    callbacks.onStatusChange.mockClear();

    // Longer than the whole 10-attempt backoff schedule (3s doubling, capped at 60s).
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(client.provision).toHaveBeenCalledTimes(1);
    expect(callbacks.onReconnectExhausted).not.toHaveBeenCalled();
    expect(callbacks.onStatusChange).not.toHaveBeenCalledWith("disconnected");
  });
});
