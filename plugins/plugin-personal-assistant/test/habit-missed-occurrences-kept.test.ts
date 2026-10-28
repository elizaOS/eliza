/**
 * Habit history on a real PGlite runtime: a missed (expired) occurrence is a
 * terminal record, like a completed one. The scheduler refresh must not delete
 * it when it leaves the materialize window, or streaks and completion rates
 * count only the completed days.
 */

import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app/test/helpers/real-runtime.ts";
import { LifeOpsRepository } from "../src/lifeops/repository.ts";
import { LifeOpsService } from "../src/lifeops/service.ts";
import { computeDefinitionPerformance } from "../src/lifeops/service-helpers-occurrence.ts";

let runtimeResult: RealTestRuntimeResult | null = null;

beforeEach(async () => {
  runtimeResult = await createRealTestRuntime();
  await LifeOpsRepository.bootstrapSchema(runtimeResult.runtime);
});

afterEach(async () => {
  await runtimeResult?.cleanup();
  runtimeResult = null;
});

it("keeps missed days so the streak and completion rate stay true", async () => {
  const runtime = runtimeResult?.runtime;
  if (!runtime) throw new Error("runtime not started");
  const repository = new LifeOpsRepository(runtime);
  const service = new LifeOpsService(runtime);
  const { definition } = await service.createDefinition({
    title: "Pushups",
    kind: "habit",
    cadence: { kind: "daily", windows: ["morning"] },
    timezone: "UTC",
    priority: 3,
    metadata: {},
  });
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const at = (day: number, hour: number) =>
    new Date(start.getTime() + day * 86_400_000 + hour * 3_600_000);
  // Done on days 1-3, missed on days 4-10, done on days 11-14.
  const doneDays = new Set([1, 2, 3, 11, 12, 13, 14]);
  for (let day = 1; day <= 14; day += 1) {
    for (const hour of [1, 9, 18]) {
      await service.refreshDefinitionOccurrences(definition, at(day, hour));
      if (hour === 9 && doneDays.has(day)) {
        const visible = (
          await repository.listOccurrencesForDefinition(
            runtime.agentId,
            definition.id,
          )
        ).find((occurrence) => occurrence.state === "visible");
        if (!visible) throw new Error(`no visible occurrence on day ${day}`);
        await service.completeOccurrence(visible.id, {}, at(day, hour));
      }
    }
  }

  const now = at(14, 20);
  const occurrences = await repository.listOccurrencesForDefinition(
    runtime.agentId,
    definition.id,
  );
  // The simulated days only; the first refresh also projects its look-back days.
  const simulated = occurrences.filter((occurrence) => {
    const dueMs = Date.parse(occurrence.dueAt ?? occurrence.scheduledAt);
    return dueMs >= at(1, 0).getTime() && dueMs <= now.getTime();
  });
  expect(simulated.map((occurrence) => occurrence.state)).toEqual([
    ...Array(3).fill("completed"),
    ...Array(7).fill("expired"),
    ...Array(4).fill("completed"),
  ]);

  const performance = computeDefinitionPerformance(
    definition,
    occurrences,
    now,
  );
  expect(performance.currentOccurrenceStreak).toBe(4);
  expect(performance.bestOccurrenceStreak).toBe(4);
}, 120_000);
