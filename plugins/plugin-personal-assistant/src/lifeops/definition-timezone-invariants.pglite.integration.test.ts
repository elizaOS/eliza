/**
 * Real-PGlite integration coverage for the LifeOps definition timezone
 * invariant at create and update boundaries.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { RealTestRuntimeResult } from "../../test/helpers/runtime.ts";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.ts";
import { LifeOpsService } from "./service.ts";

const MORNING_WINDOW = {
  name: "morning" as const,
  label: "Morning",
  startMinute: 480,
  endMinute: 720,
};

describe("LifeOps definition timezone invariants (real PGlite)", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;

  afterEach(async () => {
    await runtimeResult?.cleanup();
    runtimeResult = null;
  });

  it("rejects a mismatched window-policy timezone before create persistence", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const service = new LifeOpsService(runtimeResult.runtime);

    await expect(
      service.createDefinition({
        kind: "task",
        title: "Call the pharmacy",
        timezone: "America/Los_Angeles",
        cadence: { kind: "once", dueAt: "2026-11-04T18:00:00.000Z" },
        windowPolicy: {
          timezone: "UTC",
          windows: [MORNING_WINDOW],
        },
      }),
    ).rejects.toMatchObject({
      message: "windowPolicy.timezone must match timezone",
      status: 400,
    });

    await expect(service.listDefinitions()).resolves.toEqual([]);
  });

  it("rejects a mismatched update and preserves the persisted definition", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const service = new LifeOpsService(runtimeResult.runtime);
    const created = await service.createDefinition({
      kind: "task",
      title: "Call the pharmacy",
      timezone: "America/Los_Angeles",
      cadence: { kind: "once", dueAt: "2026-11-04T18:00:00.000Z" },
      windowPolicy: {
        timezone: "America/Los_Angeles",
        windows: [MORNING_WINDOW],
      },
    });

    await expect(
      service.updateDefinition(created.definition.id, {
        windowPolicy: {
          timezone: "UTC",
          windows: [MORNING_WINDOW],
        },
      }),
    ).rejects.toMatchObject({
      message: "windowPolicy.timezone must match timezone",
      status: 400,
    });

    await expect(service.getDefinition(created.definition.id)).resolves.toEqual(
      expect.objectContaining({
        definition: expect.objectContaining({
          id: created.definition.id,
          timezone: "America/Los_Angeles",
          windowPolicy: expect.objectContaining({
            timezone: "America/Los_Angeles",
          }),
        }),
      }),
    );

    const moved = await service.updateDefinition(created.definition.id, {
      timezone: "Asia/Tokyo",
    });
    expect(moved.definition).toMatchObject({
      timezone: "Asia/Tokyo",
      windowPolicy: { timezone: "Asia/Tokyo" },
    });
  });
});
