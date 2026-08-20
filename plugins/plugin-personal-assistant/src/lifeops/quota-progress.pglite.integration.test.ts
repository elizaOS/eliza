/**
 * Real-PGlite coverage for count-per-day quota progress (#17025): the
 * append-only `life_task_progress_events` store, owner/occurrence-scoped
 * idempotency, concurrent increments that can neither lose nor exceed the
 * daily target, terminal completion exactly at the target, and refusal from
 * skipped/terminal states. The harness is a real AgentRuntime with the
 * personal-assistant schema migrated into PGlite — no mocked repository.
 */
import type { LifeOpsDefinitionRecord } from "@elizaos/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import { LifeOpsRepository } from "./repository.js";
import { LifeOpsService } from "./service.js";

describe("count-per-day quota progress — real store", () => {
  let runtimeResult: RealTestRuntimeResult;
  let repository: LifeOpsRepository;
  let service: LifeOpsService;
  let agentId: string;

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    agentId = runtimeResult.runtime.agentId;
    repository = new LifeOpsRepository(runtimeResult.runtime);
    service = new LifeOpsService(runtimeResult.runtime);
  });

  afterAll(async () => {
    await runtimeResult.cleanup();
  });

  async function createQuotaDefinition(
    title: string,
  ): Promise<{ record: LifeOpsDefinitionRecord; occurrenceId: string }> {
    const record = await service.createDefinition({
      kind: "habit",
      title,
      description: "",
      originalIntent: `${title} 3 times a day, any time`,
      timezone: "UTC",
      priority: 3,
      cadence: {
        kind: "count_per_day",
        targetCount: 3,
        unit: "set",
        perOccurrenceWork: "25 pushups",
        timing: { kind: "anytime" },
      },
    });
    const occurrences = await repository.listOccurrencesForDefinition(
      agentId,
      record.definition.id,
    );
    const active = occurrences.find(
      (occurrence) =>
        occurrence.state === "visible" || occurrence.state === "pending",
    );
    expect(active).toBeDefined();
    if (!active) throw new Error("no active quota occurrence materialized");
    expect(active.occurrenceKey).toMatch(/^quota:\d{4}-\d{2}-\d{2}:day$/);
    // Exactly one occurrence per local date — no fabricated slots.
    const perDay = new Map<string, number>();
    for (const occurrence of occurrences) {
      const day = occurrence.occurrenceKey.split(":")[1];
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    for (const count of perDay.values()) {
      expect(count).toBe(1);
    }
    return { record, occurrenceId: active.id };
  }

  it("counts increments toward the target, dedupes replays, and completes exactly at target", async () => {
    const { occurrenceId } = await createQuotaDefinition("pushups");

    const first = await service.recordOccurrenceProgress(occurrenceId, {
      idempotencyKey: "msg-1",
    });
    expect(first.applied).toBe(true);
    expect(first.progress).toMatchObject({
      completedCount: 1,
      targetCount: 3,
      remainingCount: 2,
      unit: "set",
      perOccurrenceWork: "25 pushups",
    });
    expect(first.completed).toBe(false);
    expect(first.occurrence.state).not.toBe("completed");
    expect(first.progressEventId).not.toBeNull();

    // Replaying the same idempotency key is a no-op, never a double count.
    const replay = await service.recordOccurrenceProgress(occurrenceId, {
      idempotencyKey: "msg-1",
    });
    expect(replay.applied).toBe(false);
    expect(replay.progressEventId).toBeNull();
    expect(replay.progress.completedCount).toBe(1);

    const second = await service.recordOccurrenceProgress(occurrenceId, {
      idempotencyKey: "msg-2",
    });
    expect(second.progress.completedCount).toBe(2);
    expect(second.completed).toBe(false);

    const third = await service.recordOccurrenceProgress(occurrenceId, {
      idempotencyKey: "msg-3",
      note: "last one",
    });
    expect(third.completed).toBe(true);
    expect(third.progress).toMatchObject({
      completedCount: 3,
      remainingCount: 0,
    });
    expect(third.occurrence.state).toBe("completed");

    // A post-completion increment is refused structurally: no event lands.
    const overshoot = await service.recordOccurrenceProgress(occurrenceId, {
      idempotencyKey: "msg-4",
    });
    expect(overshoot.applied).toBe(false);
    expect(overshoot.completed).toBe(true);
    expect(overshoot.progress.completedCount).toBe(3);
    const events = await repository.listProgressEvents(agentId, occurrenceId);
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.idempotencyKey)).toEqual([
      "msg-1",
      "msg-2",
      "msg-3",
    ]);
  });

  it("never exceeds or loses the target under concurrent increments", async () => {
    const { occurrenceId } = await createQuotaDefinition("situps");
    const results = await Promise.all(
      ["c1", "c2", "c3", "c4", "c5"].map((key) =>
        service.recordOccurrenceProgress(occurrenceId, {
          idempotencyKey: key,
        }),
      ),
    );
    for (const result of results) {
      expect(result.progress.completedCount).toBeLessThanOrEqual(3);
      expect(result.progress.remainingCount).toBeGreaterThanOrEqual(0);
    }
    const view = await repository.getOccurrenceView(agentId, occurrenceId);
    expect(view?.state).toBe("completed");
    const finalRead = await service.recordOccurrenceProgress(occurrenceId, {
      idempotencyKey: "after",
    });
    expect(finalRead.progress.completedCount).toBe(3);
    expect(finalRead.completed).toBe(true);
  });

  it("refuses increments from a skipped occurrence and on non-quota cadences", async () => {
    const { occurrenceId } = await createQuotaDefinition("plank");
    await service.skipOccurrence(occurrenceId);
    await expect(
      service.recordOccurrenceProgress(occurrenceId, {
        idempotencyKey: "after-skip",
      }),
    ).rejects.toThrowError(/skipped/);

    const fixed = await service.createDefinition({
      kind: "task",
      title: "one-off",
      description: "",
      originalIntent: "one-off",
      timezone: "UTC",
      priority: 3,
      cadence: { kind: "once", dueAt: "2027-01-05T09:00:00.000Z" },
    });
    const occurrences = await repository.listOccurrencesForDefinition(
      agentId,
      fixed.definition.id,
    );
    expect(occurrences.length).toBeGreaterThan(0);
    await expect(
      service.recordOccurrenceProgress(occurrences[0].id, {
        idempotencyKey: "wrong-kind",
      }),
    ).rejects.toThrowError(/count-per-day/);
  });

  it("rejects invalid quantities and blank idempotency keys", async () => {
    const { occurrenceId } = await createQuotaDefinition("squats");
    await expect(
      service.recordOccurrenceProgress(occurrenceId, {
        idempotencyKey: " ",
      }),
    ).rejects.toThrowError(/idempotencyKey/);
    await expect(
      service.recordOccurrenceProgress(occurrenceId, {
        idempotencyKey: "q",
        quantity: 0,
      }),
    ).rejects.toThrowError(/quantity/);
  });
});
