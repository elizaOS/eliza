/**
 * A `once` check-in names an instant. A `dueAt` that states only a wall clock
 * must not be read in the host process zone, because the same stored goal is
 * reconciled by whatever host runs the agent. It is read in the owner's zone,
 * the same rule the `owner_local` cron slots of daily and weekly goals get.
 */
import type { LifeOpsGoalDefinition } from "@elizaos/contracts";
import { describe, expect, it } from "vitest";
import { checkinTriggersForGoal } from "./checkin.ts";

function goalWithCadence(cadence: Record<string, unknown>) {
  return {
    id: "goal-cadence-fixture",
    agentId: "agent-1",
    domain: "health",
    subjectType: "owner",
    subjectId: "owner-1",
    visibilityScope: "private",
    contextPolicy: "standard",
    title: "Morning check-in",
    description: "",
    cadence,
    supportStrategy: {},
    successCriteria: {},
    status: "active",
    reviewState: "pending",
    metadata: {},
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  } as unknown as LifeOpsGoalDefinition;
}

function onceAt(goal: LifeOpsGoalDefinition, ownerTimeZone?: string): string {
  const plan = checkinTriggersForGoal(goal, ownerTimeZone)[0];
  if (plan?.trigger.kind !== "once") {
    throw new Error("expected one once trigger");
  }
  return plan.trigger.atIso;
}

describe("checkin cadence once instant", () => {
  it("reads a zone-less dueAt in the owner's zone", () => {
    // 09:00 on 2026-11-01 is EST (UTC-5): DST ends that morning.
    expect(
      onceAt(
        goalWithCadence({ kind: "once", dueAt: "2026-11-01T09:00" }),
        "America/New_York",
      ),
    ).toBe("2026-11-01T14:00:00.000Z");
  });

  it("reads a zone-less dueAt as UTC when no owner zone is configured", () => {
    // Not the host zone: this assertion holds under any process TZ.
    expect(
      onceAt(goalWithCadence({ kind: "once", dueAt: "2026-11-01T09:00" })),
    ).toBe("2026-11-01T09:00:00.000Z");
  });

  it("keeps the instant a dueAt already states", () => {
    expect(
      onceAt(
        goalWithCadence({ kind: "once", dueAt: "2026-11-01T09:00:00+02:00" }),
        "Asia/Tokyo",
      ),
    ).toBe("2026-11-01T07:00:00.000Z");
  });

  it("leaves the owner-local cron slots of a recurring cadence unchanged", () => {
    const [plan] = checkinTriggersForGoal(
      goalWithCadence({ kind: "daily", windows: ["morning"] }),
      "Asia/Tokyo",
    );
    expect(plan?.trigger).toMatchObject({ kind: "cron", tz: "owner_local" });
  });
});
