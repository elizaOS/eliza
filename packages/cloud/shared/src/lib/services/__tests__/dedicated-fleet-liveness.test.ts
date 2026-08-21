/**
 * Unit coverage for the dedicated-fleet liveness monitor (#22548): the serving
 * contract that decides which (tier, lifecycle) rows may raise the alarm, the
 * alarm shape "agents that should be reachable exist and none is serving", the
 * jobs-ledger provisioning success rate, and the no-data-is-not-100% rule.
 * Deterministic: repositories and the alert channel are injected; no database.
 * The repository-level SQL contract this consumes is proven separately in
 * `db/repositories/agent-sandboxes.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import type { AgentExecutionTier, AgentSandboxStatus } from "../../../db/schemas/agent-sandboxes";
import {
  DEDICATED_FLEET_UNREACHABLE_DEDUP_KEY,
  type FleetCensusRow,
  isFleetRowExpectedReachable,
  monitorDedicatedFleetLiveness,
  PROVISION_SUCCESS_WINDOW_MS,
} from "../dedicated-fleet-liveness";
import type { DaemonHealthAlert } from "../provisioning-worker-health-monitor";

const ALL_TIERS: AgentExecutionTier[] = ["shared", "dedicated-lazy", "dedicated-always", "custom"];

const ALL_STATUSES: AgentSandboxStatus[] = [
  "pending",
  "provisioning",
  "running",
  "stopped",
  "sleeping",
  "disconnected",
  "error",
  "deletion_pending",
  "deletion_failed",
];

/** The statuses in which a row asserts that a live container should exist. */
const REACHABLE_STATUSES = new Set<string>(["running", "disconnected", "error"]);

function row(
  execution_tier: AgentExecutionTier,
  status: AgentSandboxStatus,
  count: number,
): FleetCensusRow {
  return { execution_tier, status, count };
}

function harness(overrides: {
  fleet?: FleetCensusRow[];
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

describe("isFleetRowExpectedReachable", () => {
  test("the serving contract is exhaustive over every tier x lifecycle pair", () => {
    for (const tier of ALL_TIERS) {
      for (const status of ALL_STATUSES) {
        const expected = tier !== "shared" && REACHABLE_STATUSES.has(status);
        expect({ tier, status, live: isFleetRowExpectedReachable(tier, status) }).toEqual({
          tier,
          status,
          live: expected,
        });
      }
    }
  });

  test("a sleeping dedicated-lazy agent is contractually off, not unreachable", () => {
    expect(isFleetRowExpectedReachable("dedicated-lazy", "sleeping")).toBe(false);
    expect(isFleetRowExpectedReachable("dedicated-lazy", "stopped")).toBe(false);
    // But once woken it holds a live container like any other tier.
    expect(isFleetRowExpectedReachable("dedicated-lazy", "running")).toBe(true);
    expect(isFleetRowExpectedReachable("dedicated-lazy", "error")).toBe(true);
  });

  test("an unknown tier cannot enroll itself in the paging census", () => {
    expect(isFleetRowExpectedReachable("dedicated-burst", "error")).toBe(false);
  });
});

describe("monitorDedicatedFleetLiveness", () => {
  test("alerts when agents that should be reachable exist and none is running (the 36h-outage shape)", async () => {
    const h = harness({ fleet: [row("dedicated-always", "error", 26)] });
    const result = await h.run();

    expect(result.unreachable).toBe(true);
    expect(result.expectedReachableTotal).toBe(26);
    expect(result.expectedReachableRunning).toBe(0);
    expect(h.alerts).toHaveLength(1);
    const alert = h.alerts[0];
    if (!alert) throw new Error("expected an alert");
    expect(alert.dedupKey).toBe(DEDICATED_FLEET_UNREACHABLE_DEDUP_KEY);
    expect(alert.details.code).toBe("DEDICATED_FLEET_UNREACHABLE");
    expect(alert.details.expectedReachableTotal).toBe(26);
  });

  test("a fleet of healthy SLEEPING dedicated-lazy agents never pages", async () => {
    const h = harness({
      fleet: [row("dedicated-lazy", "sleeping", 40), row("dedicated-lazy", "stopped", 5)],
    });
    const result = await h.run();

    // The rows exist and none is `running` — the old predicate paged here.
    expect(result.fleetTotal).toBe(45);
    expect(result.expectedReachableTotal).toBe(0);
    expect(result.offContractTotal).toBe(45);
    expect(result.unreachable).toBe(false);
    expect(h.alerts).toHaveLength(0);
  });

  test("stopped, deletion-bound, and not-yet-provisioned rows are all off-contract", async () => {
    const h = harness({
      fleet: [
        row("dedicated-always", "stopped", 3),
        row("custom", "deletion_pending", 2),
        row("custom", "deletion_failed", 1),
        row("dedicated-always", "pending", 4),
        row("dedicated-always", "provisioning", 6),
      ],
    });
    const result = await h.run();

    expect(result.fleetTotal).toBe(16);
    expect(result.expectedReachableTotal).toBe(0);
    expect(result.unreachable).toBe(false);
    expect(h.alerts).toHaveLength(0);
  });

  test("an always-on fleet in error pages even while lazy agents sleep healthily beside it", async () => {
    const h = harness({
      fleet: [
        row("dedicated-lazy", "sleeping", 100),
        row("dedicated-always", "error", 4),
        row("custom", "disconnected", 2),
      ],
    });
    const result = await h.run();

    expect(result.unreachable).toBe(true);
    expect(result.expectedReachableTotal).toBe(6);
    expect(result.offContractTotal).toBe(100);
    expect(result.fleetByTierStatus["dedicated-lazy:sleeping"]).toBe(100);
    expect(h.alerts).toHaveLength(1);
    // The operator must be able to see the sleeping majority is NOT the alarm.
    expect(h.alerts[0]?.details.offContractTotal).toBe(100);
  });

  test("one serving row anywhere in the live census silences the alarm", async () => {
    const h = harness({
      fleet: [row("dedicated-always", "error", 25), row("dedicated-lazy", "running", 1)],
    });
    const result = await h.run();

    expect(result.unreachable).toBe(false);
    expect(result.expectedReachableRunning).toBe(1);
    expect(h.alerts).toHaveLength(0);
  });

  test("an empty dedicated fleet is not an outage", async () => {
    const h = harness({ fleet: [] });
    const result = await h.run();

    expect(result.unreachable).toBe(false);
    expect(result.fleetTotal).toBe(0);
    expect(result.expectedReachableTotal).toBe(0);
    expect(h.alerts).toHaveLength(0);
  });

  test("provisioning success is measured on the jobs ledger over the trailing window", async () => {
    const h = harness({
      fleet: [row("dedicated-always", "running", 3)],
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
      fleet: [row("dedicated-always", "running", 1)],
      jobs: [{ status: "in_progress", count: 2 }],
    });
    const result = await h.run();

    expect(result.provisionSuccessRate).toBeNull();
  });

  test("a census failure propagates instead of reporting a fabricated healthy fleet", async () => {
    await expect(
      monitorDedicatedFleetLiveness({
        summarizeFleet: async () => {
          throw new Error("census query failed");
        },
        summarizeProvisionJobs: async () => [],
        alert: () => {},
      }),
    ).rejects.toThrow("census query failed");
  });
});
