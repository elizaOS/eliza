/**
 * Unit coverage for projecting scheduled-task views into automation-feed rows
 * (title, schedule label, merge). Pure functions, no harness.
 */
import { describe, expect, it } from "vitest";
import type { ScheduledTaskView } from "../api/client-types-core";
import { mergeUnifiedTasks } from "./merge-unified-tasks";
import {
  scheduledTaskScheduleLabel,
  scheduledTaskTitle,
  scheduledTaskToAutomationItem,
} from "./scheduled-task-to-automation";

function task(overrides: Partial<ScheduledTaskView> = {}): ScheduledTaskView {
  return {
    taskId: "t-1",
    kind: "reminder",
    promptInstructions: "Say good morning",
    trigger: {
      kind: "relative_to_anchor",
      anchorKey: "wake.confirmed",
      offsetMinutes: 0,
    },
    priority: "low",
    respectsGlobalPause: true,
    state: { status: "scheduled", followupCount: 0 },
    source: "default_pack",
    createdBy: "daily-rhythm",
    ownerVisible: true,
    metadata: { recordKey: "gm" },
    ...overrides,
  };
}

describe("scheduledTaskTitle", () => {
  it("maps seeded default-pack records to friendly labels", () => {
    expect(scheduledTaskTitle(task({ metadata: { recordKey: "gm" } }))).toBe(
      "Good morning",
    );
    expect(scheduledTaskTitle(task({ metadata: { recordKey: "gn" } }))).toBe(
      "Good night",
    );
    expect(
      scheduledTaskTitle(task({ metadata: { recordKey: "checkin" } })),
    ).toBe("Daily check-in");
    expect(
      scheduledTaskTitle(task({ metadata: { recordKey: "weekly-review" } })),
    ).toBe("Weekly review");
  });

  it("falls back to kind-derived labels", () => {
    expect(
      scheduledTaskTitle(task({ kind: "watcher", metadata: undefined })),
    ).toBe("Watcher");
  });
});

describe("scheduledTaskScheduleLabel", () => {
  it("formats cron and anchor triggers", () => {
    expect(
      scheduledTaskScheduleLabel({
        kind: "cron",
        expression: "0 9 * * 1-5",
        tz: "UTC",
      }),
    ).toBe("Every weekday at 9am");
    expect(
      scheduledTaskScheduleLabel({
        kind: "relative_to_anchor",
        anchorKey: "wake.confirmed",
        offsetMinutes: 0,
      }),
    ).toBe("On wake.confirmed");
    expect(scheduledTaskScheduleLabel({ kind: "manual" })).toBe("Manual");
  });
});

describe("scheduledTaskToAutomationItem", () => {
  it("surfaces a scheduled (non-manual) task as an active, owner-visible row", () => {
    const item = scheduledTaskToAutomationItem(task());
    expect(item.id).toBe("scheduled:t-1");
    expect(item.source).toBe("scheduled_task");
    expect(item.status).toBe("active");
    expect(item.enabled).toBe(true);
    expect(item.system).toBe(false);
    expect(item.scheduledTask?.taskId).toBe("t-1");
  });

  it("maps a manual trigger to paused / not-enabled (seeded weekly review)", () => {
    const item = scheduledTaskToAutomationItem(
      task({
        taskId: "weekly",
        kind: "recap",
        trigger: { kind: "manual" },
        metadata: { recordKey: "weekly-review" },
      }),
    );
    expect(item.status).toBe("paused");
    expect(item.enabled).toBe(false);
    expect(item.title).toBe("Weekly review");
  });

  it("maps a terminal state to completed", () => {
    const item = scheduledTaskToAutomationItem(
      task({ state: { status: "completed", followupCount: 0 } }),
    );
    expect(item.status).toBe("completed");
    expect(item.enabled).toBe(false);
  });
});

describe("mergeUnifiedTasks", () => {
  const automation = {
    id: "workflow:w-1",
    type: "workflow" as const,
    source: "workflow" as const,
    title: "Daily digest",
    description: "",
    status: "active" as const,
    enabled: true,
    system: false,
    isDraft: false,
    hasBackingWorkflow: true,
    updatedAt: null,
    schedules: [],
  };

  it("concatenates automations with adapted scheduled tasks", () => {
    const merged = mergeUnifiedTasks([automation], [task()]);
    expect(merged).toHaveLength(2);
    expect(merged.map((m) => m.id)).toContain("scheduled:t-1");
    expect(merged.map((m) => m.id)).toContain("workflow:w-1");
  });

  it("de-dupes by id, automations winning on collision", () => {
    const collide = {
      ...automation,
      id: "scheduled:t-1",
      title: "Pre-existing",
    };
    const merged = mergeUnifiedTasks([collide], [task()]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.title).toBe("Pre-existing");
  });

  it("sorts system first, then enabled, then by title", () => {
    const merged = mergeUnifiedTasks(
      [{ ...automation, id: "workflow:z", title: "Zebra" }],
      [
        task({ taskId: "a", metadata: { recordKey: "checkin" } }),
        task({
          taskId: "m",
          trigger: { kind: "manual" },
          metadata: { recordKey: "weekly-review" },
        }),
      ],
    );
    // The paused (manual) item sorts last (disabled group).
    expect(merged[merged.length - 1]?.title).toBe("Weekly review");
  });
});
