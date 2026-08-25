/**
 * Tests for scheduleOnceTriggerTask (plugin-personal-assistant lifeops).
 *
 * Materiality: the exported one-shot scheduling API. Two real defects:
 * 1. The draft is built with kind:"workflow" but NO workflowId, and
 *    normalizeTriggerDraft rejects workflow-kind without a workflowId
 *    ("workflowId is required for workflow triggers"). Every call therefore
 *    throws before creating anything — the one-shot reminder path is dead.
 * 2. The duplicate scan matches on dedupeKey alone. The dedupeKey derivation
 *    (buildTriggerDedupeKey) does NOT include the creator, so a different
 *    user's identical one-shot reminder is reported as "duplicate" and the
 *    second user's reminder is silently never created. The main TRIGGER
 *    create machinery treats createdBy equality as load-bearing for exactly
 *    this reason ("a cross-recipient false match here silently swallows a
 *    distinct recipient's delivery").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleOnceTriggerTask } from "./schedule-once.js";

const agentMocks = vi.hoisted(() => {
  let taskList = [];
  let triggerLimit = 10;
  let featureEnabled = true;
  return {
    TRIGGER_TASK_NAME: "TRIGGER_DISPATCH",
    TRIGGER_TASK_TAGS: ["queue", "repeat", "trigger"],
    __setTasks: (v) => {
      taskList = v;
    },
    __setTriggerLimit: (v) => {
      triggerLimit = v;
    },
    __setFeatureEnabled: (v) => {
      featureEnabled = v;
    },
    triggersFeatureEnabled: vi.fn(() => featureEnabled),
    getTriggerLimit: vi.fn(() => triggerLimit),
    listTriggerTasks: vi.fn(async () => taskList),
    taskToTriggerSummary: vi.fn((task) => {
      if (!task) return null;
      const cfg = task.metadata?.trigger;
      return {
        id: task.id,
        triggerId: cfg?.triggerId,
        displayName: cfg?.displayName,
        triggerType: cfg?.triggerType,
      };
    }),
    readTriggerConfig: vi.fn((task) => task?.metadata?.trigger ?? null),
    normalizeTriggerDraft: vi.fn((params) => {
      const kind = params.input.kind ?? "workflow";
      const workflowId =
        kind === "workflow" ? params.input.workflowId?.trim() : undefined;
      const displayName =
        (params.input.displayName ?? "").trim() ||
        (params.fallback.displayName ?? "").trim();
      if (kind === "workflow" && !workflowId) {
        return { error: "workflowId is required for workflow triggers" };
      }
      if (!displayName) {
        return { error: "displayName is required" };
      }
      const instructions =
        (params.input.instructions ?? "").trim() ||
        (params.fallback.instructions ?? "").trim();
      if (!instructions) {
        return { error: "instructions is required" };
      }
      const triggerType =
        params.input.triggerType ?? params.fallback.triggerType;
      const wakeMode = params.input.wakeMode ?? params.fallback.wakeMode;
      const scheduledAtIso = params.input.scheduledAtIso?.trim();
      if (triggerType === "once") {
        if (!scheduledAtIso || Number.isNaN(Date.parse(scheduledAtIso))) {
          return { error: "scheduledAtIso must be a valid ISO timestamp" };
        }
      }
      return {
        draft: {
          displayName,
          instructions,
          triggerType,
          wakeMode,
          enabled: params.input.enabled ?? params.fallback.enabled,
          createdBy: params.input.createdBy ?? params.fallback.createdBy,
          maxRuns: params.input.maxRuns,
          kind,
          workflowId,
          scheduledAtIso,
        },
      };
    }),
    buildTriggerConfig: vi.fn((params) => {
      const draft = params.draft;
      if (draft.kind === "workflow" && !draft.workflowId) {
        throw new Error(
          "buildTriggerConfig: workflow-kind trigger requires a workflowId",
        );
      }
      // Mirrors real buildTriggerDedupeKey: hashes trigger type, instructions,
      // schedule, wakeMode, kind, workflowId — NOT the creator.
      let h = 5381;
      const input = [
        draft.triggerType,
        draft.instructions.toLowerCase(),
        draft.scheduledAtIso ?? "",
        draft.wakeMode,
        draft.kind,
        draft.workflowId ?? "",
      ].join("|");
      for (const c of input) h = (h * 33) ^ c.charCodeAt(0);
      return {
        version: 1,
        triggerId: params.triggerId,
        displayName: draft.displayName,
        instructions: draft.instructions,
        triggerType: draft.triggerType,
        enabled: draft.enabled,
        wakeMode: draft.wakeMode,
        createdBy: draft.createdBy,
        scheduledAtIso:
          draft.triggerType === "once" ? draft.scheduledAtIso : undefined,
        maxRuns: draft.maxRuns,
        dedupeKey: `trigger-${Math.abs(h >>> 0).toString(16)}`,
        kind: draft.kind,
        workflowId: draft.kind === "workflow" ? draft.workflowId : undefined,
      };
    }),
    buildTriggerMetadata: vi.fn(() => ({
      trigger: { nextRunAtMs: Date.now() + 60000 },
    })),
  };
});

vi.mock("@elizaos/agent", () => ({
  TRIGGER_TASK_NAME: agentMocks.TRIGGER_TASK_NAME,
  TRIGGER_TASK_TAGS: agentMocks.TRIGGER_TASK_TAGS,
  triggersFeatureEnabled: agentMocks.triggersFeatureEnabled,
  getTriggerLimit: agentMocks.getTriggerLimit,
  listTriggerTasks: agentMocks.listTriggerTasks,
  taskToTriggerSummary: agentMocks.taskToTriggerSummary,
  readTriggerConfig: agentMocks.readTriggerConfig,
  normalizeTriggerDraft: agentMocks.normalizeTriggerDraft,
  buildTriggerConfig: agentMocks.buildTriggerConfig,
  buildTriggerMetadata: agentMocks.buildTriggerMetadata,
}));

const FUTURE_ISO = "2099-01-01T12:00:00.000Z";

function baseArgs(overrides = {}) {
  return {
    runtime: {
      entityId: "user-A",
      getService: vi.fn(() => null),
      createTask: vi.fn(async (input) => `task-${input.name}`),
      getTask: vi.fn(async (id) => ({
        id,
        metadata: { trigger: { triggerId: "t-1", displayName: "Reminder" } },
      })),
    },
    message: { entityId: "user-A", roomId: "room-1" },
    displayName: "Take meds",
    instructions: "Remind me to take meds",
    scheduledAtIso: FUTURE_ISO,
    ...overrides,
  };
}

function taskWith(id, cfg) {
  return { id, metadata: { trigger: cfg } };
}

beforeEach(() => {
  agentMocks.__setTasks([]);
  agentMocks.__setTriggerLimit(10);
  agentMocks.__setFeatureEnabled(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scheduleOnceTriggerTask", () => {
  it("creates a single-fire task for a valid request (no workflow involved)", async () => {
    const args = baseArgs();
    const result = await scheduleOnceTriggerTask(args);

    expect(result.taskId).toBeDefined();
    expect(result.triggerId).toBeDefined();
    expect(args.runtime.createTask).toHaveBeenCalledTimes(1);
    expect(args.runtime.getTask).toHaveBeenCalledTimes(1);
  });

  it("delivers the task to the autonomy room when the service provides one", async () => {
    const args = baseArgs({
      runtime: {
        entityId: "user-A",
        getService: vi.fn(() => ({ getAutonomousRoomId: () => "auto-room" })),
        createTask: vi.fn(async (input) => `task-${input.name}`),
        getTask: vi.fn(async (id) => ({
          id,
          metadata: { trigger: { triggerId: "t-1", displayName: "Reminder" } },
        })),
      },
    });
    await scheduleOnceTriggerTask(args);
    expect(args.runtime.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: "auto-room" }),
    );
  });

  it("does not suppress one user's reminder because ANOTHER user has an identical one", async () => {
    // Existing enabled once-trigger owned by user-B with the same dedupeKey
    // (identical instructions + schedule). The dedupeKey derivation does not
    // include the creator.
    agentMocks.__setTasks([
      taskWith("task-B", {
        version: 1,
        triggerId: "t-b",
        displayName: "Take meds",
        instructions: "Remind me to take meds",
        triggerType: "once",
        enabled: true,
        createdBy: "user-B",
        scheduledAtIso: FUTURE_ISO,
        kind: "prompt",
        dedupeKey: "same-key",
      }),
    ]);

    const args = baseArgs({
      message: { entityId: "user-A", roomId: "room-1" },
    });
    const result = await scheduleOnceTriggerTask(args);

    // user-A's reminder must be created, not reported as user-B's duplicate.
    expect(result.duplicateTaskId).toBeUndefined();
    expect(result.taskId).toBeDefined();
    expect(args.runtime.createTask).toHaveBeenCalledTimes(1);
  });

  it("reports the existing task as duplicate for the SAME creator re-asking", async () => {
    agentMocks.__setTasks([
      taskWith("task-A", {
        version: 1,
        triggerId: "t-a",
        displayName: "Take meds",
        instructions: "Remind me to take meds",
        triggerType: "once",
        enabled: true,
        createdBy: "user-A",
        scheduledAtIso: FUTURE_ISO,
        kind: "prompt",
        dedupeKey: "same-key",
      }),
    ]);

    const args = baseArgs();
    // Force the same dedupeKey by passing an explicit one.
    const result = await scheduleOnceTriggerTask({
      ...args,
      dedupeKey: "same-key",
    });

    expect(result.duplicateTaskId).toBe("task-A");
    expect(args.runtime.createTask).not.toHaveBeenCalled();
  });

  it("throws when triggers are disabled by configuration", async () => {
    agentMocks.__setFeatureEnabled(false);
    await expect(scheduleOnceTriggerTask(baseArgs())).rejects.toThrow(
      "Triggers are disabled by configuration.",
    );
  });

  it("throws when the trigger limit is reached", async () => {
    agentMocks.__setTasks([
      taskWith("task-A", {
        version: 1,
        triggerId: "t-a",
        displayName: "A",
        instructions: "a",
        triggerType: "once",
        enabled: true,
        createdBy: "user-A",
        scheduledAtIso: FUTURE_ISO,
        kind: "prompt",
        dedupeKey: "k-a",
      }),
    ]);
    agentMocks.__setTriggerLimit(1);
    await expect(scheduleOnceTriggerTask(baseArgs())).rejects.toThrow(
      /Trigger limit reached/,
    );
  });
});
