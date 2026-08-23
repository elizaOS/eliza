/**
 * Behavioral coverage for createOngoingTasksProvider: workbench vs todo vs
 * trigger classification, active/completed ordering, automation schedule
 * formatting, empty-queue and load-failure degrade. The provider and its
 * helpers (readTaskCompleted, isWorkbenchTodoTask, readTriggerConfig,
 * listTriggerTasks) are real; only IAgentRuntime.getTasks / logger / getSetting
 * are stubbed.
 */
import type { IAgentRuntime, Memory, State, Task, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createOngoingTasksProvider } from "./tasks.ts";

const AGENT_ID = "00000000-0000-4000-8000-0000000000a0" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-0000000000b0" as UUID;
const ENTITY_ID = "00000000-0000-4000-8000-0000000000c0" as UUID;
const EMPTY_STATE: State = { values: {}, data: {}, text: "" };

function message(): Memory {
  return {
    id: "00000000-0000-4000-8000-0000000000d0" as UUID,
    entityId: ENTITY_ID,
    roomId: ROOM_ID,
    content: { text: "what is on my plate?" },
  } as Memory;
}

function makeTask(fields: {
  id?: UUID;
  name: string;
  description?: string;
  tags?: string[];
  metadata?: Task["metadata"];
}): Task {
  const task: Task = {
    name: fields.name,
    tags: fields.tags ?? [],
    metadata: fields.metadata ?? {},
  };
  if (fields.id !== undefined) {
    task.id = fields.id;
  }
  if (fields.description !== undefined) {
    task.description = fields.description;
  }
  return task;
}

function promptTrigger(fields: {
  triggerId: UUID;
  displayName: string;
  instructions: string;
  triggerType: "interval" | "once" | "cron" | "event";
  enabled: boolean;
  intervalMs?: number;
  cronExpression?: string;
}): Record<string, unknown> {
  const trigger: Record<string, unknown> = {
    version: 1,
    kind: "prompt",
    triggerId: fields.triggerId,
    displayName: fields.displayName,
    instructions: fields.instructions,
    triggerType: fields.triggerType,
    enabled: fields.enabled,
    wakeMode: "next_autonomy_cycle",
    createdBy: "test",
    runCount: 0,
  };
  if (fields.intervalMs !== undefined) {
    trigger.intervalMs = fields.intervalMs;
  }
  if (fields.cronExpression !== undefined) {
    trigger.cronExpression = fields.cronExpression;
  }
  return trigger;
}

function triggerTask(fields: {
  id?: UUID;
  name?: string;
  tags?: string[];
  trigger: Record<string, unknown>;
}): Task {
  return makeTask({
    id: fields.id,
    name: fields.name ?? "TRIGGER_DISPATCH",
    tags: fields.tags ?? ["queue", "repeat", "trigger"],
    metadata: { trigger: fields.trigger } as unknown as Task["metadata"],
  });
}

interface RuntimeStub {
  runtime: IAgentRuntime;
  getTasks: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
}

function makeRuntime(options: {
  allTasks?: Task[];
  triggerTasks?: Task[];
  heartbeatTasks?: Task[];
  throwOn?: "all" | "trigger" | "heartbeat";
  settings?: Record<string, unknown>;
}): RuntimeStub {
  const allTasks = options.allTasks ?? [];
  const triggerTasks = options.triggerTasks ?? [];
  const heartbeatTasks = options.heartbeatTasks ?? [];
  const settings = options.settings ?? {};
  const debug = vi.fn();
  const getTasks = vi.fn(async (filter?: { tags?: string[] }) => {
    const tags = filter?.tags ?? [];
    if (tags.includes("trigger")) {
      if (options.throwOn === "trigger") {
        throw new Error("trigger store unavailable");
      }
      return triggerTasks;
    }
    if (tags.includes("heartbeat")) {
      if (options.throwOn === "heartbeat") {
        throw new Error("heartbeat store unavailable");
      }
      return heartbeatTasks;
    }
    if (options.throwOn === "all") {
      throw new Error("task store unavailable");
    }
    return allTasks;
  });

  const runtime = {
    agentId: AGENT_ID,
    getTasks,
    getSetting: (name: string) => settings[name],
    logger: {
      debug,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as IAgentRuntime;

  return { runtime, getTasks, debug };
}

async function getText(options: Parameters<typeof makeRuntime>[0]): Promise<{
  text: string;
  values: Record<string, unknown> | undefined;
  getTasks: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
}> {
  const { runtime, getTasks, debug } = makeRuntime(options);
  const result = await createOngoingTasksProvider().get(
    runtime,
    message(),
    EMPTY_STATE,
  );
  return {
    text: result.text ?? "",
    values: result.values as Record<string, unknown> | undefined,
    getTasks,
    debug,
  };
}

describe("createOngoingTasksProvider registration", () => {
  it("exposes the tasks/automation context gate, turn cache, and USER role floor", () => {
    const provider = createOngoingTasksProvider();
    expect(provider.name).toBe("ongoingTasks");
    expect(provider.description).toBe(
      "Provides context about the user's active tasks and scheduled tasks.",
    );
    expect(provider.position).toBe(20);
    expect(provider.contexts).toEqual(["tasks", "automation"]);
    expect(provider.contextGate).toEqual({ anyOf: ["tasks", "automation"] });
    expect(provider.cacheStable).toBe(false);
    expect(provider.cacheScope).toBe("turn");
    expect(provider.roleGate).toEqual({ minRole: "USER" });
  });
});

describe("createOngoingTasksProvider workbench listing", () => {
  it("returns empty text when the queue has no workbench tasks or automations", async () => {
    const result = await getText({ allTasks: [] });
    expect(result.text).toBe("");
    expect(result.values).toBeUndefined();
    expect(result.getTasks).toHaveBeenCalledWith({ agentIds: [AGENT_ID] });
  });

  it("formats a single active workbench task and sets hasActiveTasks", async () => {
    const task = makeTask({
      id: "00000000-0000-4000-8000-000000000001" as UUID,
      name: "Ship coverage",
      description: "write the suite",
    });
    const result = await getText({ allTasks: [task] });
    expect(result.text).toBe(
      [
        "## Active Tasks",
        "- [active] Ship coverage — write the suite (id: 00000000-0000-4000-8000-000000000001)",
      ].join("\n"),
    );
    expect(result.values).toEqual({ hasActiveTasks: true });
  });

  it("still emits the Active Tasks heading when the only workbench item is completed", async () => {
    const task = makeTask({
      id: "00000000-0000-4000-8000-000000000002" as UUID,
      name: "Done already",
      metadata: { isCompleted: true },
    });
    const result = await getText({ allTasks: [task] });
    expect(result.text).toBe(
      [
        "## Active Tasks",
        "",
        "## Recently Completed Tasks",
        "- [completed] Done already (id: 00000000-0000-4000-8000-000000000002)",
      ].join("\n"),
    );
  });

  it("lists active tasks before completed ones and keeps source order inside each group", async () => {
    const completedA = makeTask({
      id: "00000000-0000-4000-8000-000000000011" as UUID,
      name: "Completed A",
      metadata: { isCompleted: true },
    });
    const activeA = makeTask({
      id: "00000000-0000-4000-8000-000000000012" as UUID,
      name: "Active A",
    });
    const completedB = makeTask({
      id: "00000000-0000-4000-8000-000000000013" as UUID,
      name: "Completed B",
      metadata: { isCompleted: true },
    });
    const activeB = makeTask({
      id: "00000000-0000-4000-8000-000000000014" as UUID,
      name: "Active B",
    });
    const result = await getText({
      allTasks: [completedA, activeA, completedB, activeB],
    });
    expect(result.text).toBe(
      [
        "## Active Tasks",
        "- [active] Active A (id: 00000000-0000-4000-8000-000000000012)",
        "- [active] Active B (id: 00000000-0000-4000-8000-000000000014)",
        "",
        "## Recently Completed Tasks",
        "- [completed] Completed A (id: 00000000-0000-4000-8000-000000000011)",
        "- [completed] Completed B (id: 00000000-0000-4000-8000-000000000013)",
      ].join("\n"),
    );
  });

  it("keeps two identically named tasks as separate rows (no tie-break collapse)", async () => {
    const left = makeTask({
      id: "00000000-0000-4000-8000-000000000021" as UUID,
      name: "Same name",
    });
    const right = makeTask({
      id: "00000000-0000-4000-8000-000000000022" as UUID,
      name: "Same name",
    });
    const result = await getText({ allTasks: [left, right] });
    expect(result.text).toContain(
      "- [active] Same name (id: 00000000-0000-4000-8000-000000000021)",
    );
    expect(result.text).toContain(
      "- [active] Same name (id: 00000000-0000-4000-8000-000000000022)",
    );
  });

  it("omits blank, whitespace-only, and non-string descriptions", async () => {
    const blank = makeTask({
      id: "00000000-0000-4000-8000-000000000031" as UUID,
      name: "Blank desc",
      description: "",
    });
    const whitespace = makeTask({
      id: "00000000-0000-4000-8000-000000000032" as UUID,
      name: "Whitespace desc",
      description: "   ",
    });
    const missing = makeTask({
      id: "00000000-0000-4000-8000-000000000033" as UUID,
      name: "No desc",
    });
    const numeric = makeTask({
      id: "00000000-0000-4000-8000-000000000034" as UUID,
      name: "Nonstring desc",
    });
    (numeric as { description?: unknown }).description = 42;
    const result = await getText({
      allTasks: [blank, whitespace, missing, numeric],
    });
    expect(result.text).toContain(
      "- [active] Blank desc (id: 00000000-0000-4000-8000-000000000031)",
    );
    expect(result.text).toContain(
      "- [active] Whitespace desc (id: 00000000-0000-4000-8000-000000000032)",
    );
    expect(result.text).toContain(
      "- [active] No desc (id: 00000000-0000-4000-8000-000000000033)",
    );
    expect(result.text).toContain(
      "- [active] Nonstring desc (id: 00000000-0000-4000-8000-000000000034)",
    );
    expect(result.text).not.toContain(" — ");
  });

  it("trims surrounding whitespace on a workbench description", async () => {
    const task = makeTask({
      id: "00000000-0000-4000-8000-000000000035" as UUID,
      name: "Trim me",
      description: "  padded  ",
    });
    const result = await getText({ allTasks: [task] });
    expect(result.text).toContain(
      "- [active] Trim me — padded (id: 00000000-0000-4000-8000-000000000035)",
    );
  });

  it("renders a missing task id as the literal undefined token", async () => {
    const task = makeTask({ name: "No id" });
    const result = await getText({ allTasks: [task] });
    expect(result.text).toContain("- [active] No id (id: undefined)");
  });

  it("does not treat a string isCompleted flag as completed", async () => {
    const task = makeTask({
      id: "00000000-0000-4000-8000-000000000036" as UUID,
      name: "String flag",
      metadata: { isCompleted: "true" } as unknown as Task["metadata"],
    });
    const result = await getText({ allTasks: [task] });
    expect(result.text).toContain(
      "- [active] String flag (id: 00000000-0000-4000-8000-000000000036)",
    );
    expect(result.text).not.toContain("## Recently Completed Tasks");
  });
});

describe("createOngoingTasksProvider classification", () => {
  it("skips trigger-configured tasks from the workbench list", async () => {
    const trigger = triggerTask({
      id: "00000000-0000-4000-8000-000000000041" as UUID,
      trigger: promptTrigger({
        triggerId: "00000000-0000-4000-8000-0000000000e1" as UUID,
        displayName: "Inbox sweep",
        instructions: "scan mail",
        triggerType: "interval",
        enabled: true,
        intervalMs: 300_000,
      }),
    });
    const result = await getText({ allTasks: [trigger] });
    expect(result.text).toBe("");
    expect(result.text).not.toContain("Inbox sweep");
  });

  it("skips workbench-todo tagged tasks and todo-tagged tasks", async () => {
    const taggedTodo = makeTask({
      id: "00000000-0000-4000-8000-000000000042" as UUID,
      name: "Tagged todo",
      tags: ["workbench-todo"],
    });
    const looseTodo = makeTask({
      id: "00000000-0000-4000-8000-000000000043" as UUID,
      name: "Loose todo",
      tags: ["todo"],
    });
    const result = await getText({ allTasks: [taggedTodo, looseTodo] });
    expect(result.text).toBe("");
  });

  it("skips tasks whose metadata carries a workbenchTodo or todo object", async () => {
    const nestedWorkbench = makeTask({
      id: "00000000-0000-4000-8000-000000000044" as UUID,
      name: "Nested workbench todo",
      metadata: { workbenchTodo: { isCompleted: false } },
    });
    const nestedTodo = makeTask({
      id: "00000000-0000-4000-8000-000000000045" as UUID,
      name: "Nested todo",
      metadata: { todo: { isCompleted: true } },
    });
    const result = await getText({
      allTasks: [nestedWorkbench, nestedTodo],
    });
    expect(result.text).toBe("");
  });

  it("does not treat a trigger-shaped metadata blob without triggerId as a trigger", async () => {
    const incomplete = makeTask({
      id: "00000000-0000-4000-8000-000000000046" as UUID,
      name: "Almost a trigger",
      metadata: {
        trigger: {
          displayName: "Nope",
          enabled: true,
          triggerType: "interval",
        },
      } as unknown as Task["metadata"],
    });
    const result = await getText({ allTasks: [incomplete] });
    expect(result.text).toContain(
      "- [active] Almost a trigger (id: 00000000-0000-4000-8000-000000000046)",
    );
  });

  it("includes untagged generic tasks as workbench items", async () => {
    const generic = makeTask({
      id: "00000000-0000-4000-8000-000000000047" as UUID,
      name: "Loose work item",
    });
    const result = await getText({ allTasks: [generic] });
    expect(result.text).toContain(
      "- [active] Loose work item (id: 00000000-0000-4000-8000-000000000047)",
    );
  });
});

describe("createOngoingTasksProvider automations", () => {
  it("formats an enabled interval trigger under 60 minutes", async () => {
    const automation = triggerTask({
      id: "00000000-0000-4000-8000-000000000051" as UUID,
      trigger: promptTrigger({
        triggerId: "00000000-0000-4000-8000-0000000000e2" as UUID,
        displayName: "Inbox sweep",
        instructions: "scan mail",
        triggerType: "interval",
        enabled: true,
        intervalMs: 300_000,
      }),
    });
    const result = await getText({ triggerTasks: [automation] });
    expect(result.text).toBe(
      [
        "## Active Automations",
        "- [active] Inbox sweep (every 5m) — scan mail (id: 00000000-0000-4000-8000-000000000051)",
      ].join("\n"),
    );
    expect(result.values).toEqual({ hasActiveTasks: true });
  });

  it("rounds a 90-second interval up to every 2m", async () => {
    const automation = triggerTask({
      id: "00000000-0000-4000-8000-000000000052" as UUID,
      trigger: promptTrigger({
        triggerId: "00000000-0000-4000-8000-0000000000e3" as UUID,
        displayName: "Fast tick",
        instructions: "nudge",
        triggerType: "interval",
        enabled: true,
        intervalMs: 90_000,
      }),
    });
    const result = await getText({ triggerTasks: [automation] });
    expect(result.text).toContain("(every 2m)");
  });

  it("switches to hours once the rounded minute count reaches 60", async () => {
    const hourly = triggerTask({
      id: "00000000-0000-4000-8000-000000000053" as UUID,
      trigger: promptTrigger({
        triggerId: "00000000-0000-4000-8000-0000000000e4" as UUID,
        displayName: "Hourly",
        instructions: "check calendar",
        triggerType: "interval",
        enabled: true,
        intervalMs: 3_600_000,
      }),
    });
    const ninety = triggerTask({
      id: "00000000-0000-4000-8000-000000000054" as UUID,
      trigger: promptTrigger({
        triggerId: "00000000-0000-4000-8000-0000000000e5" as UUID,
        displayName: "Ninety",
        instructions: "stretch",
        triggerType: "interval",
        enabled: true,
        intervalMs: 5_400_000,
      }),
    });
    const result = await getText({ triggerTasks: [hourly, ninety] });
    expect(result.text).toContain(
      "- [active] Hourly (every 1h) — check calendar (id: 00000000-0000-4000-8000-000000000053)",
    );
    expect(result.text).toContain(
      "- [active] Ninety (every 2h) — stretch (id: 00000000-0000-4000-8000-000000000054)",
    );
  });

  it("formats cron and one-time schedules and leaves event/missing interval empty", async () => {
    const cron = triggerTask({
      id: "00000000-0000-4000-8000-000000000055" as UUID,
      trigger: promptTrigger({
        triggerId: "00000000-0000-4000-8000-0000000000e6" as UUID,
        displayName: "Morning",
        instructions: "brief me",
        triggerType: "cron",
        enabled: true,
        cronExpression: "0 9 * * *",
      }),
    });
    const once = triggerTask({
      id: "00000000-0000-4000-8000-000000000056" as UUID,
      trigger: promptTrigger({
        triggerId: "00000000-0000-4000-8000-0000000000e7" as UUID,
        displayName: "One shot",
        instructions: "remind later",
        triggerType: "once",
        enabled: true,
      }),
    });
    const event = triggerTask({
      id: "00000000-0000-4000-8000-000000000057" as UUID,
      trigger: promptTrigger({
        triggerId: "00000000-0000-4000-8000-0000000000e8" as UUID,
        displayName: "On workflow",
        instructions: "react",
        triggerType: "event",
        enabled: true,
      }),
    });
    const intervalNoMs = triggerTask({
      id: "00000000-0000-4000-8000-000000000058" as UUID,
      trigger: promptTrigger({
        triggerId: "00000000-0000-4000-8000-0000000000e9" as UUID,
        displayName: "Broken interval",
        instructions: "tick",
        triggerType: "interval",
        enabled: true,
      }),
    });
    const result = await getText({
      triggerTasks: [cron, once, event, intervalNoMs],
    });
    expect(result.text).toContain(
      "- [active] Morning (cron: 0 9 * * *) — brief me (id: 00000000-0000-4000-8000-000000000055)",
    );
    expect(result.text).toContain(
      "- [active] One shot (one-time) — remind later (id: 00000000-0000-4000-8000-000000000056)",
    );
    expect(result.text).toContain(
      "- [active] On workflow () — react (id: 00000000-0000-4000-8000-000000000057)",
    );
    expect(result.text).toContain(
      "- [active] Broken interval () — tick (id: 00000000-0000-4000-8000-000000000058)",
    );
  });

  it("omits disabled automations rather than listing them as paused", async () => {
    const paused = triggerTask({
      id: "00000000-0000-4000-8000-000000000059" as UUID,
      trigger: promptTrigger({
        triggerId: "00000000-0000-4000-8000-0000000000ea" as UUID,
        displayName: "Paused sweep",
        instructions: "do not run",
        triggerType: "interval",
        enabled: false,
        intervalMs: 600_000,
      }),
    });
    const result = await getText({ triggerTasks: [paused] });
    expect(result.text).toBe("");
  });

  it("does not invent automations from an untagged trigger sitting only in the workbench query", async () => {
    const orphan = triggerTask({
      id: "00000000-0000-4000-8000-00000000005a" as UUID,
      trigger: promptTrigger({
        triggerId: "00000000-0000-4000-8000-0000000000eb" as UUID,
        displayName: "Orphan",
        instructions: "should not surface",
        triggerType: "interval",
        enabled: true,
        intervalMs: 120_000,
      }),
    });
    const result = await getText({ allTasks: [orphan], triggerTasks: [] });
    expect(result.text).toBe("");
  });

  it("surfaces an enabled trigger discovered only on the heartbeat query", async () => {
    const heartbeat = triggerTask({
      id: "00000000-0000-4000-8000-00000000005b" as UUID,
      tags: ["queue", "repeat", "heartbeat"],
      trigger: promptTrigger({
        triggerId: "00000000-0000-4000-8000-0000000000ec" as UUID,
        displayName: "Heartbeat",
        instructions: "pulse",
        triggerType: "interval",
        enabled: true,
        intervalMs: 60_000,
      }),
    });
    const result = await getText({ heartbeatTasks: [heartbeat] });
    expect(result.text).toContain(
      "- [active] Heartbeat (every 1m) — pulse (id: 00000000-0000-4000-8000-00000000005b)",
    );
  });

  it("dedupes the same trigger id across trigger and heartbeat queries", async () => {
    const shared = triggerTask({
      id: "00000000-0000-4000-8000-00000000005c" as UUID,
      trigger: promptTrigger({
        triggerId: "00000000-0000-4000-8000-0000000000ed" as UUID,
        displayName: "Shared",
        instructions: "once only",
        triggerType: "interval",
        enabled: true,
        intervalMs: 180_000,
      }),
    });
    const result = await getText({
      triggerTasks: [shared],
      heartbeatTasks: [shared],
    });
    expect(result.text.match(/Shared/g)?.length).toBe(1);
  });

  it("collapses id-less triggers that share name, description, and tags", async () => {
    const left = triggerTask({
      trigger: promptTrigger({
        triggerId: "00000000-0000-4000-8000-0000000000ee" as UUID,
        displayName: "Left",
        instructions: "a",
        triggerType: "once",
        enabled: true,
      }),
    });
    const right = triggerTask({
      trigger: promptTrigger({
        triggerId: "00000000-0000-4000-8000-0000000000ef" as UUID,
        displayName: "Right",
        instructions: "b",
        triggerType: "once",
        enabled: true,
      }),
    });
    const result = await getText({ triggerTasks: [left, right] });
    expect(result.text).toContain(
      "- [active] Left (one-time) — a (id: undefined)",
    );
    expect(result.text).not.toContain("Right");
  });

  it("returns no automations when the triggers feature is disabled", async () => {
    const automation = triggerTask({
      id: "00000000-0000-4000-8000-00000000005d" as UUID,
      trigger: promptTrigger({
        triggerId: "00000000-0000-4000-8000-0000000000f0" as UUID,
        displayName: "Disabled feature",
        instructions: "hidden",
        triggerType: "once",
        enabled: true,
      }),
    });
    const result = await getText({
      triggerTasks: [automation],
      settings: { ELIZA_TRIGGERS_ENABLED: false },
    });
    expect(result.text).toBe("");
  });
});

describe("createOngoingTasksProvider composition and failures", () => {
  it("separates workbench and automation sections with a blank line", async () => {
    const workbench = makeTask({
      id: "00000000-0000-4000-8000-000000000061" as UUID,
      name: "Workbench item",
    });
    const automation = triggerTask({
      id: "00000000-0000-4000-8000-000000000062" as UUID,
      trigger: promptTrigger({
        triggerId: "00000000-0000-4000-8000-0000000000f1" as UUID,
        displayName: "Nightly",
        instructions: "backup",
        triggerType: "cron",
        enabled: true,
        cronExpression: "0 0 * * *",
      }),
    });
    const result = await getText({
      allTasks: [workbench],
      triggerTasks: [automation],
    });
    expect(result.text).toBe(
      [
        "## Active Tasks",
        "- [active] Workbench item (id: 00000000-0000-4000-8000-000000000061)",
        "",
        "## Active Automations",
        "- [active] Nightly (cron: 0 0 * * *) — backup (id: 00000000-0000-4000-8000-000000000062)",
      ].join("\n"),
    );
  });

  it("degrades to empty text when the untagged task read throws", async () => {
    const result = await getText({ throwOn: "all" });
    expect(result.text).toBe("");
    expect(result.values).toBeUndefined();
    expect(result.debug).toHaveBeenCalledWith(
      { src: "tasks-provider", error: "Error: task store unavailable" },
      "Failed to load tasks for context",
    );
  });

  it("swallows a later trigger-query failure even after workbench rows were collected", async () => {
    const workbench = makeTask({
      id: "00000000-0000-4000-8000-000000000063" as UUID,
      name: "Should vanish",
    });
    const result = await getText({
      allTasks: [workbench],
      throwOn: "trigger",
    });
    expect(result.text).toBe("");
    expect(result.debug).toHaveBeenCalledWith(
      {
        src: "tasks-provider",
        error: "Error: trigger store unavailable",
      },
      "Failed to load tasks for context",
    );
  });
});
