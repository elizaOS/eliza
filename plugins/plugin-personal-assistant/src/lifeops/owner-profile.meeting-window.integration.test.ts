/**
 * Preferred meeting hours must form a same-day window (start < end); the
 * slot reader cannot match an overnight range. Real handlers, task storage and
 * PGlite read-back prove invalid windows are refused before any scheduler
 * state is written and that legacy overnight metadata resolves to defaults.
 */
import type { AgentRuntime, Memory, Task, UUID } from "@elizaos/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import { calendarAction } from "../actions/calendar.js";
import {
  normalizeLifeOpsMeetingPreferencesPatch,
  readLifeOpsMeetingPreferences,
  updateLifeOpsMeetingPreferences,
} from "./owner-profile.js";
import { LIFEOPS_TASK_TAGS } from "./scheduler-task.js";

function listLifeOpsTasks(runtime: AgentRuntime): Promise<Task[]> {
  return runtime.getTasks({
    agentIds: [runtime.agentId],
    tags: [...LIFEOPS_TASK_TAGS],
  });
}

function spyOnSchedulerWrites(runtime: AgentRuntime) {
  return {
    updateTask: vi.spyOn(runtime, "updateTask"),
    patchTaskMetadata: vi.spyOn(runtime, "patchTaskMetadata"),
    createTask: vi.spyOn(runtime, "createTask"),
  };
}

function expectNoSchedulerWrites(
  spies: ReturnType<typeof spyOnSchedulerWrites>,
): void {
  expect(spies.updateTask).not.toHaveBeenCalled();
  expect(spies.patchTaskMetadata).not.toHaveBeenCalled();
  expect(spies.createTask).not.toHaveBeenCalled();
}

describe("normalizeLifeOpsMeetingPreferencesPatch — preferred window", () => {
  it.each([
    { label: "overnight", start: "22:00", end: "06:00" },
    { label: "empty", start: "09:00", end: "09:00" },
  ])("drops an $label start/end pair", ({ start, end }) => {
    expect(
      normalizeLifeOpsMeetingPreferencesPatch({
        preferredStartLocal: start,
        preferredEndLocal: end,
        defaultDurationMinutes: 45,
      }),
    ).toEqual({ defaultDurationMinutes: 45 });
  });

  it("keeps a same-day pair and single-sided input", () => {
    expect(
      normalizeLifeOpsMeetingPreferencesPatch({
        preferredStartLocal: "08:30",
        preferredEndLocal: "16:00",
      }),
    ).toEqual({ preferredStartLocal: "08:30", preferredEndLocal: "16:00" });
    expect(
      normalizeLifeOpsMeetingPreferencesPatch({ preferredStartLocal: "22:00" }),
    ).toEqual({ preferredStartLocal: "22:00" });
    expect(
      normalizeLifeOpsMeetingPreferencesPatch({ preferredEndLocal: "06:00" }),
    ).toEqual({ preferredEndLocal: "06:00" });
  });
});

describe("preferred meeting window mutation — real PGlite", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  let taskId: UUID;

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
  }, 180_000);
  beforeEach(async () => {
    const update = await updateLifeOpsMeetingPreferences(runtime, {
      preferredStartLocal: "09:00",
      preferredEndLocal: "17:00",
      defaultDurationMinutes: 45,
    });
    if (!update) throw new Error("Test preferences must be persisted");
    taskId = update.taskId;
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => runtimeResult?.cleanup());

  function message(): Memory {
    return {
      id: crypto.randomUUID() as UUID,
      agentId: runtime.agentId,
      entityId: runtime.agentId,
      roomId: crypto.randomUUID() as UUID,
      createdAt: Date.now(),
      content: { source: "autonomy", text: "Update my meeting hours" },
    } as Memory;
  }

  it("refuses an overnight pair through CALENDAR with INVALID_FIELDS", async () => {
    const before = await readLifeOpsMeetingPreferences(runtime);
    const spies = spyOnSchedulerWrites(runtime);

    const result = await calendarAction.handler(runtime, message(), undefined, {
      parameters: {
        action: "update_preferences",
        preferredStartLocal: "22:00",
        preferredEndLocal: "06:00",
      },
    });

    expect(result).toMatchObject({
      success: false,
      data: { error: "INVALID_FIELDS" },
    });
    expectNoSchedulerWrites(spies);
    expect(await readLifeOpsMeetingPreferences(runtime)).toEqual(before);
  });

  it.each([
    {
      label: "start after the saved end",
      patch: { preferredStartLocal: "18:00" },
    },
    {
      label: "end before the saved start",
      patch: { preferredEndLocal: "08:00" },
    },
    {
      label: "start equal to the saved end",
      patch: { preferredStartLocal: "17:00" },
    },
  ])(
    "rejects a one-field patch with $label before any scheduler write",
    async ({ patch }) => {
      const stored = await runtime.getTask(taskId);
      const spies = spyOnSchedulerWrites(runtime);

      await expect(
        updateLifeOpsMeetingPreferences(runtime, patch),
      ).rejects.toMatchObject({
        code: "LIFEOPS_MEETING_PREFERENCES_INVALID_RANGE",
      });

      expectNoSchedulerWrites(spies);
      expect(JSON.stringify(await runtime.getTask(taskId))).toBe(
        JSON.stringify(stored),
      );
    },
  );

  it("rejects an invalid pair together with other preference changes without partial writes", async () => {
    const stored = await runtime.getTask(taskId);
    const spies = spyOnSchedulerWrites(runtime);
    await expect(
      updateLifeOpsMeetingPreferences(runtime, {
        preferredStartLocal: "22:00",
        preferredEndLocal: "06:00",
        defaultDurationMinutes: 60,
      }),
    ).rejects.toMatchObject({
      code: "LIFEOPS_MEETING_PREFERENCES_INVALID_RANGE",
    });
    expectNoSchedulerWrites(spies);
    expect(await runtime.getTask(taskId)).toEqual(stored);
  });

  it("persists a valid one-field patch against the saved window", async () => {
    const update = await updateLifeOpsMeetingPreferences(runtime, {
      preferredStartLocal: "10:30",
    });
    expect(update?.preferences).toMatchObject({
      preferredStartLocal: "10:30",
      preferredEndLocal: "17:00",
      defaultDurationMinutes: 45,
    });
    expect(await readLifeOpsMeetingPreferences(runtime)).toMatchObject({
      preferredStartLocal: "10:30",
      preferredEndLocal: "17:00",
    });
  });

  it("resolves legacy overnight metadata to the default window without rewriting", async () => {
    const task = await runtime.getTask(taskId);
    if (!task) throw new Error("Test preference task must exist");
    await runtime.updateTask(taskId, {
      metadata: {
        ...task.metadata,
        meetingPreferences: {
          ...(task.metadata?.meetingPreferences as Record<string, unknown>),
          preferredStartLocal: "22:00",
          preferredEndLocal: "06:00",
        },
      },
    });
    const stored = await runtime.getTask(taskId);
    const spies = spyOnSchedulerWrites(runtime);

    expect(await readLifeOpsMeetingPreferences(runtime)).toMatchObject({
      preferredStartLocal: "09:00",
      preferredEndLocal: "17:00",
      defaultDurationMinutes: 45,
    });
    expectNoSchedulerWrites(spies);
    expect(await runtime.getTask(taskId)).toEqual(stored);
  });
});

describe("preferred meeting window before scheduler init — real PGlite", () => {
  it("rejects an invalid one-field patch without creating or touching scheduler tasks", async () => {
    // Keep the deferred boot ensure from creating the scheduler row so this
    // case starts with no LIFEOPS_SCHEDULER task at all.
    vi.stubEnv("ELIZA_DISABLE_LIFEOPS_SCHEDULER", "1");
    const fixture = await createLifeOpsTestRuntime();
    try {
      const runtime = fixture.runtime;
      expect(await listLifeOpsTasks(runtime)).toEqual([]);
      const spies = spyOnSchedulerWrites(runtime);

      // Defaults are 09:00-17:00, so a lone 18:00 start is an empty window.
      await expect(
        updateLifeOpsMeetingPreferences(runtime, {
          preferredStartLocal: "18:00",
        }),
      ).rejects.toMatchObject({
        code: "LIFEOPS_MEETING_PREFERENCES_INVALID_RANGE",
      });

      expectNoSchedulerWrites(spies);
      expect(await listLifeOpsTasks(runtime)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fixture.cleanup();
    }
  }, 180_000);
});
