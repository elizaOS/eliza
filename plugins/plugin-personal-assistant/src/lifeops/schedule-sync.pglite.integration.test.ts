/** Device row times and labels cross real admission, PGlite and service restart. */
import { TaskService } from "@elizaos/core";
import { expect, it } from "vitest";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import { LifeOpsService } from "./service.js";

it("persists original row times without turning a wake forecast into a meal", async () => {
  const fixture = await createLifeOpsTestRuntime();
  try {
    await TaskService.stop(fixture.runtime);
    const service = new LifeOpsService(fixture.runtime);
    const sent = "2026-10-01T14:00:00.000Z";
    const sleep = "2026-10-01T07:00:00.000Z";
    const wake = "2026-10-01T13:30:00.000Z";
    const input = {
      deviceId: "persisted-device",
      deviceKind: "mac" as const,
      timezone: "UTC",
      observedAt: sent,
      observations: [
        {
          observedAt: sleep,
          circadianState: "sleeping" as const,
          stateConfidence: 0.98,
          windowStartAt: sleep,
          snapshot: {
            circadianState: "sleeping" as const,
            currentSleepStartedAt: sleep,
          },
        },
        {
          observedAt: wake,
          circadianState: "waking" as const,
          stateConfidence: 0.98,
          windowStartAt: wake,
          snapshot: {
            circadianState: "waking" as const,
            lastSleepEndedAt: wake,
            nextMealLabel: "breakfast" as const,
          },
        },
      ],
    };
    expect(await service.ingestScheduleObservations(input)).toMatchObject({
      acceptedCount: 2,
      mergedState: { circadianState: "waking", currentSleepStartedAt: null },
    });
    const restarted = new LifeOpsService(fixture.runtime);
    const saved = await restarted.repository.listScheduleObservations(
      fixture.runtime.agentId,
      sleep,
    );
    const deviceRows = saved.filter((row) => row.deviceId === input.deviceId);
    expect(deviceRows).toHaveLength(2);
    expect(deviceRows.map((row) => Date.parse(row.observedAt)).sort()).toEqual([
      Date.parse(sleep),
      Date.parse(wake),
    ]);
    expect(deviceRows.map((row) => row.mealLabel)).toEqual([null, null]);
    expect(
      await restarted.repository.getScheduleMergedState(
        fixture.runtime.agentId,
        "cloud",
        "UTC",
      ),
    ).toMatchObject({ circadianState: "waking", currentSleepStartedAt: null });
    // Persisted records travel through the production sender serialization too.
    const replay = {
      ...input,
      observations: deviceRows.map((row) =>
        restarted.serializeScheduleObservationForSync(row),
      ),
    };
    expect(await restarted.ingestScheduleObservations(replay)).toMatchObject({
      acceptedCount: 2,
      mergedState: { circadianState: "waking" },
    });
    await expect(
      restarted.ingestScheduleObservations({
        ...input,
        observations: [{ ...input.observations[0], observedAt: "not-a-date" }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  } finally {
    await fixture.cleanup();
  }
}, 120_000);
