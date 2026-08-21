/**
 * Unit coverage for the dedicated-fleet liveness monitor (#22548): the alarm
 * shape "dedicated agents exist and none is serving", the jobs-ledger
 * provisioning success rate, and the no-data-is-not-100% rule. Deterministic:
 * repositories and the alert channel are injected; no database.
 */
import { describe, expect, test } from "bun:test";
import {
  DEDICATED_FLEET_UNREACHABLE_DEDUP_KEY,
  monitorDedicatedFleetLiveness,
  PROVISION_SUCCESS_WINDOW_MS,
} from "../dedicated-fleet-liveness";
import type { DaemonHealthAlert } from "../provisioning-worker-health-monitor";

function harness(overrides: {
  fleet?: Array<{ status: string; count: number }>;
  jobs?: Array<{ status: string; count: number }>;
}) {
  const alerts: DaemonHealthAlert[] = [];
  const sinceSeen: Date[] = [];
  const nowMs = Date.parse("2026-08-20T12:00:00.000Z");
  const run = () =>
    monitorDedicatedFleetLiveness({
      summarizeFleet: async () => overrides.fleet ?? [],
      summarizeProvisionJobs: async (since) => {
        sinceSeen.push(since);
        return overrides.jobs ?? [];
      },
      alert: (a) => {
        alerts.push(a);
      },
      now: () => nowMs,
    });
  return { run, alerts, sinceSeen, nowMs };
}

describe("monitorDedicatedFleetLiveness", () => {
  test("alerts when dedicated agents exist and none is running (the 36h-outage shape)", async () => {
    const h = harness({ fleet: [{ status: "error", count: 26 }] });
    const result = await h.run();

    expect(result.unreachable).toBe(true);
    expect(result.fleetTotal).toBe(26);
    expect(result.fleetRunning).toBe(0);
    expect(h.alerts).toHaveLength(1);
    const alert = h.alerts[0];
    if (!alert) throw new Error("expected an alert");
    expect(alert.dedupKey).toBe(DEDICATED_FLEET_UNREACHABLE_DEDUP_KEY);
    expect(alert.details.code).toBe("DEDICATED_FLEET_UNREACHABLE");
    expect(alert.details.fleetTotal).toBe(26);
  });

  test("stays quiet while at least one dedicated agent serves", async () => {
    const h = harness({
      fleet: [
        { status: "error", count: 25 },
        { status: "running", count: 1 },
      ],
    });
    const result = await h.run();

    expect(result.unreachable).toBe(false);
    expect(result.fleetRunning).toBe(1);
    expect(h.alerts).toHaveLength(0);
  });

  test("an empty dedicated fleet is not an outage", async () => {
    const h = harness({ fleet: [] });
    const result = await h.run();

    expect(result.unreachable).toBe(false);
    expect(result.fleetTotal).toBe(0);
    expect(h.alerts).toHaveLength(0);
  });

  test("provisioning success is measured on the jobs ledger over the trailing window", async () => {
    const h = harness({
      fleet: [{ status: "running", count: 3 }],
      jobs: [
        { status: "completed", count: 6 },
        { status: "failed", count: 2 },
        { status: "in_progress", count: 1 },
      ],
    });
    const result = await h.run();

    expect(result.provisionCompleted).toBe(6);
    expect(result.provisionFailed).toBe(2);
    expect(result.provisionSuccessRate).toBe(0.75);
    expect(result.provisionJobsByStatus.in_progress).toBe(1);
    // The window must be anchored to the injected clock, not the wall clock.
    expect(h.sinceSeen[0]?.getTime()).toBe(h.nowMs - PROVISION_SUCCESS_WINDOW_MS);
  });

  test("no settled provision jobs yields null success rate, not a healthy-looking 100%", async () => {
    const h = harness({
      fleet: [{ status: "running", count: 1 }],
      jobs: [{ status: "in_progress", count: 2 }],
    });
    const result = await h.run();

    expect(result.provisionSuccessRate).toBeNull();
  });
});
