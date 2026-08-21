/**
 * Exercises the tailnet path-outage detector's alarm, throttle, and recovery
 * logic deterministically with injected alert and clock deps (no network).
 */
import { describe, expect, test } from "bun:test";
import type { DaemonHealthAlert } from "./provisioning-worker-health-monitor";
import {
  TAILNET_ALARM_CONSECUTIVE_TIMEOUTS,
  TAILNET_ALARM_DEDUP_KEY,
  TAILNET_ALARM_MIN_DISTINCT_CONTAINERS,
  TAILNET_ALARM_REALERT_MS,
  TailnetPathMonitor,
} from "./tailnet-path-monitor";

function makeMonitor(startMs = 1_000_000) {
  const alerts: DaemonHealthAlert[] = [];
  let nowMs = startMs;
  const monitor = new TailnetPathMonitor({
    alert: async (alert) => {
      alerts.push(alert);
    },
    now: () => nowMs,
  });
  return {
    monitor,
    alerts,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

describe("TailnetPathMonitor", () => {
  test("fires once the timeout run spans enough distinct containers", async () => {
    const { monitor, alerts } = makeMonitor();

    await monitor.record({ containerName: "agent-a", outcome: "timed_out" });
    await monitor.record({ containerName: "agent-a", outcome: "timed_out" });
    expect(alerts).toHaveLength(0);
    expect(monitor.active).toBe(false);

    await monitor.record({ containerName: "agent-b", outcome: "timed_out" });
    expect(alerts).toHaveLength(1);
    expect(monitor.active).toBe(true);
    expect(alerts[0].dedupKey).toBe(TAILNET_ALARM_DEDUP_KEY);
    expect(alerts[0].details.code).toBe("TAILNET_AGENT_PATH_UNREACHABLE");
    expect(alerts[0].details.consecutiveTimeouts).toBe(TAILNET_ALARM_CONSECUTIVE_TIMEOUTS);
    expect(alerts[0].details.distinctContainers).toEqual(["agent-a", "agent-b"]);
  });

  test("a single sick container never fires the path alarm", async () => {
    const { monitor, alerts } = makeMonitor();

    for (let i = 0; i < TAILNET_ALARM_CONSECUTIVE_TIMEOUTS * 3; i++) {
      await monitor.record({ containerName: "agent-only", outcome: "timed_out" });
    }
    expect(TAILNET_ALARM_MIN_DISTINCT_CONTAINERS).toBeGreaterThan(1);
    expect(alerts).toHaveLength(0);
    expect(monitor.active).toBe(false);
  });

  test("throttles re-alerts while the outage persists, then re-fires after the window", async () => {
    const { monitor, alerts, advance } = makeMonitor();

    await monitor.record({ containerName: "agent-a", outcome: "timed_out" });
    await monitor.record({ containerName: "agent-b", outcome: "timed_out" });
    await monitor.record({ containerName: "agent-c", outcome: "timed_out" });
    expect(alerts).toHaveLength(1);

    advance(TAILNET_ALARM_REALERT_MS - 1);
    await monitor.record({ containerName: "agent-d", outcome: "timed_out" });
    expect(alerts).toHaveLength(1);

    advance(1);
    await monitor.record({ containerName: "agent-e", outcome: "timed_out" });
    expect(alerts).toHaveLength(2);
  });

  test("a pass resets the run and clears the alarm; the next outage pages again", async () => {
    const { monitor, alerts } = makeMonitor();

    await monitor.record({ containerName: "agent-a", outcome: "timed_out" });
    await monitor.record({ containerName: "agent-b", outcome: "timed_out" });
    await monitor.record({ containerName: "agent-c", outcome: "timed_out" });
    expect(monitor.active).toBe(true);

    await monitor.record({ containerName: "agent-a", outcome: "passed" });
    expect(monitor.active).toBe(false);

    // Interleaved passes keep it quiet: retries during a healthy path.
    await monitor.record({ containerName: "agent-b", outcome: "timed_out" });
    await monitor.record({ containerName: "agent-c", outcome: "timed_out" });
    await monitor.record({ containerName: "agent-d", outcome: "passed" });
    expect(alerts).toHaveLength(1);

    // A fresh outage pages immediately even inside the old throttle window.
    await monitor.record({ containerName: "agent-a", outcome: "timed_out" });
    await monitor.record({ containerName: "agent-b", outcome: "timed_out" });
    await monitor.record({ containerName: "agent-c", outcome: "timed_out" });
    expect(alerts).toHaveLength(2);
  });

  test("a throwing alert channel never propagates into the probe loop", async () => {
    let nowMs = 0;
    const monitor = new TailnetPathMonitor({
      alert: async () => {
        throw new Error("pagerduty down");
      },
      now: () => nowMs++,
    });

    await monitor.record({ containerName: "agent-a", outcome: "timed_out" });
    await monitor.record({ containerName: "agent-b", outcome: "timed_out" });
    await expect(
      monitor.record({ containerName: "agent-c", outcome: "timed_out" }),
    ).resolves.toBeUndefined();
    expect(monitor.active).toBe(true);
  });
});
