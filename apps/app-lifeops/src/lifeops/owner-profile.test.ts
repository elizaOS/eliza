import type { IAgentRuntime, Task, UUID } from "@elizaos/core";
import { describe, expect, test, vi } from "vitest";
import {
  ensureLifeOpsCalendarFeedIncludes,
  readLifeOpsMeetingPreferences,
  readLifeOpsOwnerProfile,
  setLifeOpsCalendarFeedIncluded,
  updateLifeOpsOwnerProfile,
} from "./owner-profile.js";
import { LIFEOPS_TASK_NAME, LIFEOPS_TASK_TAGS } from "./scheduler-task.js";

vi.mock("@elizaos/agent/config/config", () => ({
  loadElizaConfig: vi.fn(() => ({})),
  saveElizaConfig: vi.fn(),
}));

const agentId = "00000000-0000-0000-0000-000000000001" as UUID;

function makeRuntime(overrides: Partial<IAgentRuntime>): IAgentRuntime {
  return {
    agentId,
    character: { id: agentId, name: "Test", bio: [] },
    getAgent: vi.fn(async () => ({ id: agentId, name: "Test" })),
    createAgent: vi.fn(async () => true),
    getService: vi.fn(() => null),
    updateTask: vi.fn(async () => undefined),
    createTask: vi.fn(async () => "task-1" as UUID),
    ...overrides,
  } as unknown as IAgentRuntime;
}

describe("owner profile scheduler metadata reads", () => {
  test("readLifeOpsOwnerProfile propagates scheduler task read failures", async () => {
    const runtime = makeRuntime({
      getTasks: vi.fn(async () => {
        throw new Error("task store offline");
      }),
    });

    await expect(readLifeOpsOwnerProfile(runtime)).rejects.toThrow(
      "task store offline",
    );
  });

  test("readLifeOpsMeetingPreferences propagates scheduler task read failures", async () => {
    const runtime = makeRuntime({
      getTasks: vi.fn(async () => {
        throw new Error("task store offline");
      }),
    });

    await expect(readLifeOpsMeetingPreferences(runtime)).rejects.toThrow(
      "task store offline",
    );
  });

  test("updateLifeOpsOwnerProfile does not overwrite defaults after a post-ensure read failure", async () => {
    const schedulerTask = {
      id: "task-1" as UUID,
      name: LIFEOPS_TASK_NAME,
      tags: [...LIFEOPS_TASK_TAGS],
      metadata: {
        lifeopsScheduler: { kind: "runtime_runner", version: 1 },
        ownerProfile: { name: "Stored Owner", updatedAt: "2026-04-21T00:00:00.000Z" },
      },
    } as Task;
    let getTasksCall = 0;
    const updateTask = vi.fn(async () => undefined);
    const runtime = makeRuntime({
      updateTask,
      getTasks: vi.fn(async () => {
        getTasksCall += 1;
        if (getTasksCall === 1) {
          return [];
        }
        if (getTasksCall === 2) {
          return [schedulerTask];
        }
        throw new Error("task store offline after ensure");
      }),
    });

    await expect(
      updateLifeOpsOwnerProfile(runtime, { location: "Denver" }),
    ).rejects.toThrow("task store offline after ensure");

    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        description: "Process life-ops reminders and scheduled workflows",
      }),
    );
  });

  test("ensureLifeOpsCalendarFeedIncludes defaults unseen calendars to true without overwriting stored false values", async () => {
    const schedulerTask = {
      id: "task-1" as UUID,
      name: LIFEOPS_TASK_NAME,
      tags: [...LIFEOPS_TASK_TAGS],
      metadata: {
        lifeopsScheduler: { kind: "runtime_runner", version: 1 },
        calendarFeedPreferences: {
          calendarFeedIncludes: {
            primary: false,
          },
          updatedAt: "2026-04-21T00:00:00.000Z",
        },
      },
    } as Task;
    const updateTask = vi.fn(async () => undefined);
    const runtime = makeRuntime({
      updateTask,
      getTasks: vi.fn(async () => [schedulerTask]),
    });

    const next = await ensureLifeOpsCalendarFeedIncludes(runtime, [
      "primary",
      "family@example.com",
    ]);

    expect(next.calendarFeedIncludes).toEqual({
      primary: false,
      "family@example.com": true,
    });
    expect(updateTask).toHaveBeenLastCalledWith(
      "task-1",
      expect.objectContaining({
        metadata: expect.objectContaining({
          calendarFeedPreferences: expect.objectContaining({
            calendarFeedIncludes: {
              primary: false,
              "family@example.com": true,
            },
          }),
        }),
      }),
    );
  });

  test("setLifeOpsCalendarFeedIncluded persists an explicit include toggle", async () => {
    const schedulerTask = {
      id: "task-1" as UUID,
      name: LIFEOPS_TASK_NAME,
      tags: [...LIFEOPS_TASK_TAGS],
      metadata: {
        lifeopsScheduler: { kind: "runtime_runner", version: 1 },
        calendarFeedPreferences: {
          calendarFeedIncludes: {
            primary: true,
          },
          updatedAt: "2026-04-21T00:00:00.000Z",
        },
      },
    } as Task;
    const updateTask = vi.fn(async () => undefined);
    const runtime = makeRuntime({
      updateTask,
      getTasks: vi.fn(async () => [schedulerTask]),
    });

    const next = await setLifeOpsCalendarFeedIncluded(
      runtime,
      "primary",
      false,
    );

    expect(next.calendarFeedIncludes).toEqual({ primary: false });
    expect(updateTask).toHaveBeenLastCalledWith(
      "task-1",
      expect.objectContaining({
        metadata: expect.objectContaining({
          calendarFeedPreferences: expect.objectContaining({
            calendarFeedIncludes: { primary: false },
          }),
        }),
      }),
    );
  });
});
