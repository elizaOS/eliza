/**
 * Calendar preference updates use real handlers, task storage, and PGlite
 * read-back. Invalid blackout requests must preserve every stored preference;
 * the standard test runtime supplies deterministic reply/provider collaborators.
 */
import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import { CalendarService } from "@elizaos/plugin-calendar";
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
  readLifeOpsMeetingPreferences,
  updateLifeOpsMeetingPreferences,
} from "./owner-profile.js";

const initialWindows = [
  { label: "Lunch", startLocal: "12:00", endLocal: "13:00" },
  {
    label: "Travel",
    startLocal: "17:00",
    endLocal: "18:00",
    daysOfWeek: [1, 3, 5],
  },
];

describe("blackout preference mutation — real PGlite", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
  }, 180_000);
  beforeEach(async () => {
    await updateLifeOpsMeetingPreferences(runtime, {
      blackoutWindows: initialWindows,
      defaultDurationMinutes: 45,
    });
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
      content: { source: "autonomy", text: "Update my scheduling preferences" },
    } as Memory;
  }

  it.each([
    {
      label: "all invalid",
      windows: [{ label: "Travel", startLocal: "13", endLocal: "14" }],
    },
    {
      label: "mixed invalid",
      windows: [
        initialWindows[0],
        { label: "Travel", startLocal: "13", endLocal: "14" },
      ],
    },
    {
      label: "invalid weekday",
      windows: [{ ...initialWindows[0], daysOfWeek: [1, 9] }],
    },
  ])(
    "rejects $label through CALENDAR before any task write",
    async ({ windows }) => {
      const before = await readLifeOpsMeetingPreferences(runtime);
      const updateTask = vi.spyOn(runtime, "updateTask");
      const createTask = vi.spyOn(runtime, "createTask");
      const callback = vi.fn(async () => []);

      await expect(
        calendarAction.handler(
          runtime,
          message(),
          undefined,
          {
            parameters: {
              subaction: "update_preferences",
              blackoutWindows: windows,
              defaultDurationMinutes: 60,
            },
          },
          callback,
        ),
      ).rejects.toMatchObject({ code: "LIFEOPS_BLACKOUT_WINDOWS_INVALID" });

      expect(updateTask).not.toHaveBeenCalled();
      expect(createTask).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();
      expect(await readLifeOpsMeetingPreferences(runtime)).toEqual(before);
    },
  );

  it("rejects a direct store update before partial preferences can be persisted", async () => {
    const before = await readLifeOpsMeetingPreferences(runtime);
    const updateTask = vi.spyOn(runtime, "updateTask");
    await expect(
      updateLifeOpsMeetingPreferences(runtime, {
        blackoutWindows: [
          initialWindows[0],
          { label: "Travel", startLocal: "13", endLocal: "14" },
        ],
        defaultDurationMinutes: 60,
      }),
    ).rejects.toMatchObject({ code: "LIFEOPS_BLACKOUT_WINDOWS_INVALID" });
    expect(updateTask).not.toHaveBeenCalled();
    expect(await readLifeOpsMeetingPreferences(runtime)).toEqual(before);
  });

  it("does not apply irrelevant malformed preferences while searching the calendar", async () => {
    const before = await readLifeOpsMeetingPreferences(runtime);
    const service = runtime.getService<CalendarService>(
      CalendarService.serviceType,
    );
    if (!service) throw new Error("Test runtime must provide CalendarService");
    // Only the provider feed is a fixture: the umbrella and calendar search
    // handler are real, and preference task writes/read-back remain real.
    const readFeed = vi.spyOn(service, "getCalendarFeed").mockResolvedValue({
      calendarId: "primary",
      events: [],
      source: "synced",
      state: "complete",
      sources: [],
      timeMin: "2026-09-08T00:00:00.000Z",
      timeMax: "2026-09-09T00:00:00.000Z",
      syncedAt: "2026-09-05T00:00:00.000Z",
    });
    const updateTask = vi.spyOn(runtime, "updateTask");
    const result = await calendarAction.handler(runtime, message(), undefined, {
      parameters: {
        subaction: "search_events",
        query: "Lunch",
        timeMin: "2026-09-08T00:00:00.000Z",
        timeMax: "2026-09-09T00:00:00.000Z",
        blackoutWindows: [{ startLocal: "00", endLocal: "00" }],
      },
    });
    expect(result).toMatchObject({ success: true });
    expect(readFeed).toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(await readLifeOpsMeetingPreferences(runtime)).toEqual(before);
  });

  it("reads legacy malformed stored windows without rewriting the task", async () => {
    const update = await updateLifeOpsMeetingPreferences(runtime, {
      blackoutWindows: initialWindows,
    });
    if (!update) throw new Error("Test preferences must be persisted");
    const task = await runtime.getTask(update.taskId);
    if (!task) throw new Error("Test preference task must exist");
    await runtime.updateTask(update.taskId, {
      metadata: {
        ...task.metadata,
        meetingPreferences: {
          ...update.preferences,
          blackoutWindows: [
            initialWindows[0],
            { startLocal: "00", endLocal: "00" },
          ],
        },
      },
    });
    const stored = await runtime.getTask(update.taskId);
    const updateTask = vi.spyOn(runtime, "updateTask");
    expect(await readLifeOpsMeetingPreferences(runtime)).toMatchObject({
      blackoutWindows: [initialWindows[0]],
    });
    expect(updateTask).not.toHaveBeenCalled();
    expect(await runtime.getTask(update.taskId)).toEqual(stored);
  });

  it.each([
    {
      label: "valid replacement",
      windows: [
        {
          label: " Focus ",
          startLocal: " 09:00 ",
          endLocal: "11:00",
          daysOfWeek: [2, 4],
        },
      ],
      expected: [
        {
          label: "Focus",
          startLocal: "09:00",
          endLocal: "11:00",
          daysOfWeek: [2, 4],
        },
      ],
    },
    { label: "explicit clear", windows: [], expected: [] },
  ])(
    "persists $label and keeps the other preferences",
    async ({ windows, expected }) => {
      const result = await calendarAction.handler(
        runtime,
        message(),
        undefined,
        {
          parameters: {
            subaction: "update_preferences",
            blackoutWindows: windows,
          },
        },
      );
      expect(result).toMatchObject({
        success: true,
        effectReceipts: [{ outcome: "applied" }],
      });
      expect(await readLifeOpsMeetingPreferences(runtime)).toMatchObject({
        blackoutWindows: expected,
        defaultDurationMinutes: 45,
      });
    },
  );
});
