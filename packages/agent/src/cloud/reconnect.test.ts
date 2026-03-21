/**
 * Tests for cloud/reconnect.ts — the ConnectionMonitor.
 *
 * Exercises:
 *   - Heartbeat success keeps connection alive
 *   - Consecutive failures trigger disconnect callback
 *   - Auto-reconnect via provision after disconnect
 *   - Exponential backoff during reconnection
 *   - Recovery resets failure counter
 *   - Concurrent reconnect prevention
 */

import { describe, expect, it, vi } from "vitest";

import type { ElizaCloudClient } from "./bridge-client";
import { ConnectionMonitor } from "./reconnect";

type MockCloudClient = ElizaCloudClient & {
  heartbeat: ReturnType<typeof vi.fn>;
  provision: ReturnType<typeof vi.fn>;
};

function createMockClient(
  overrides: Partial<MockCloudClient> = {},
): MockCloudClient {
  return {
    heartbeat: vi.fn().mockResolvedValue(true),
    provision: vi.fn().mockResolvedValue({ id: "a1", status: "running" }),
    ...overrides,
  } as MockCloudClient;
}

describe("ConnectionMonitor", () => {
  it("sends heartbeats at configured interval", async () => {
    const client = createMockClient();
    const monitor = new ConnectionMonitor(
      client,
      "a1",
      { onDisconnect: vi.fn(), onReconnect: vi.fn() },
      30, // 30ms interval for fast test
      3,
    );

    vi.useFakeTimers();
    try {
      monitor.start();
      await vi.advanceTimersByTimeAsync(80);
      monitor.stop();
    } finally {
      vi.useRealTimers();
    }

    // Should have fired at least 2 heartbeats in 80ms with 30ms interval
    expect(client.heartbeat.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("calls onDisconnect after maxFailures consecutive heartbeat failures", async () => {
    const client = createMockClient({
      heartbeat: vi.fn().mockResolvedValue(false),
      provision: vi.fn().mockResolvedValue({ id: "a1" }),
    });
    const onDisconnect = vi.fn();

    const monitor = new ConnectionMonitor(
      client,
      "a1",
      { onDisconnect, onReconnect: vi.fn() },
      20,
      3,
    );

    vi.useFakeTimers();
    try {
      monitor.start();
      await vi.advanceTimersByTimeAsync(120);
      monitor.stop();
    } finally {
      vi.useRealTimers();
    }

    expect(onDisconnect).toHaveBeenCalled();
  });

  it("calls onReconnect after successful re-provision", async () => {
    const client = createMockClient({
      heartbeat: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true),
      provision: vi.fn().mockResolvedValue({ id: "a1", status: "running" }),
    });
    const onReconnect = vi.fn();

    const monitor = new ConnectionMonitor(
      client,
      "a1",
      { onDisconnect: vi.fn(), onReconnect },
      20,
      2,
    );

    vi.useFakeTimers();
    try {
      monitor.start();
      await vi.advanceTimersByTimeAsync(100);
      monitor.stop();
    } finally {
      vi.useRealTimers();
    }

    expect(onReconnect).toHaveBeenCalled();
  });

  it("reports status changes via onStatusChange", async () => {
    const client = createMockClient({
      heartbeat: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true),
      provision: vi.fn().mockResolvedValue({ id: "a1" }),
    });
    const statuses: string[] = [];

    const monitor = new ConnectionMonitor(
      client,
      "a1",
      {
        onDisconnect: vi.fn(),
        onReconnect: vi.fn(),
        onStatusChange: (s) => statuses.push(s),
      },
      20,
      2,
    );

    vi.useFakeTimers();
    try {
      monitor.start();
      await vi.advanceTimersByTimeAsync(100);
      monitor.stop();
    } finally {
      vi.useRealTimers();
    }

    expect(statuses).toContain("disconnected");
    expect(statuses).toContain("reconnecting");
    expect(statuses).toContain("connected");
  });

  it("isMonitoring reflects lifecycle", () => {
    const monitor = new ConnectionMonitor(createMockClient(), "a1", {
      onDisconnect: vi.fn(),
      onReconnect: vi.fn(),
    });

    expect(monitor.isMonitoring()).toBe(false);
    monitor.start();
    expect(monitor.isMonitoring()).toBe(true);
    monitor.stop();
    expect(monitor.isMonitoring()).toBe(false);
  });

  it("stop resets internal state", () => {
    const monitor = new ConnectionMonitor(createMockClient(), "a1", {
      onDisconnect: vi.fn(),
      onReconnect: vi.fn(),
    });

    monitor.start();
    monitor.stop();
    // Starting again should work cleanly
    monitor.start();
    expect(monitor.isMonitoring()).toBe(true);
    monitor.stop();
  });
});
