/**
 * Exercises owner-definition reviews through the real action boundary with a
 * mixed in-memory LifeOps service so surface, domain, and target isolation are
 * proven in both rendered text and structured action data.
 */

import type {
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LifeOpsDefinitionRecord,
  LifeOpsDefinitionStatus,
  LifeOpsDomain,
  LifeOpsTaskDefinition,
} from "../contracts/index.js";
import { runLifeOperationHandler } from "./life.js";

const serviceState = vi.hoisted(() => ({
  createCalls: [] as Array<Record<string, unknown>>,
  definitions: [] as LifeOpsDefinitionRecord[],
}));

vi.mock("../lifeops/service.js", () => {
  class LifeOpsServiceError extends Error {
    status: number;

    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  }

  class LifeOpsService {
    agentId() {
      return "00000000-0000-0000-0000-000000000003";
    }

    ownerEntityId() {
      return "00000000-0000-0000-0000-000000000002";
    }

    async listDefinitions() {
      return serviceState.definitions;
    }

    async createDefinition(request: Record<string, unknown>) {
      serviceState.createCalls.push(request);
      return {
        definition: {
          ...request,
          id: "created-definition",
        },
        reminderPlan: null,
      };
    }
  }

  return { LifeOpsService, LifeOpsServiceError };
});

const PERFORMANCE = {
  lastCompletedAt: null,
  lastSkippedAt: null,
  lastActivityAt: null,
  totalScheduledCount: 0,
  totalCompletedCount: 0,
  totalSkippedCount: 0,
  totalPendingCount: 0,
  currentOccurrenceStreak: 0,
  bestOccurrenceStreak: 0,
  currentPerfectDayStreak: 0,
  bestPerfectDayStreak: 0,
  last7Days: {
    scheduledCount: 0,
    completedCount: 0,
    skippedCount: 0,
    pendingCount: 0,
    completionRate: 0,
    perfectDayCount: 0,
  },
  last30Days: {
    scheduledCount: 0,
    completedCount: 0,
    skippedCount: 0,
    pendingCount: 0,
    completionRate: 0,
    perfectDayCount: 0,
  },
} satisfies LifeOpsDefinitionRecord["performance"];

function definitionRecord(args: {
  domain?: LifeOpsDomain;
  id: string;
  kind: LifeOpsTaskDefinition["kind"];
  metadata?: Record<string, unknown>;
  ownerSurface?: string;
  status?: LifeOpsDefinitionStatus;
  title: string;
}): LifeOpsDefinitionRecord {
  const now = "2026-08-15T00:00:00.000Z";
  const definition = {
    id: args.id,
    agentId: "00000000-0000-0000-0000-000000000003",
    domain: args.domain ?? "user_lifeops",
    subjectType: "owner",
    subjectId: "00000000-0000-0000-0000-000000000002",
    visibilityScope: "owner_only",
    contextPolicy: "allowed_in_private_chat",
    kind: args.kind,
    title: args.title,
    description: "",
    originalIntent: args.title,
    timezone: "UTC",
    status: args.status ?? "active",
    priority: 5,
    cadence: { kind: "unscheduled" },
    windowPolicy: { timezone: "UTC", windows: [] },
    progressionRule: { kind: "manual" },
    websiteAccess: null,
    reminderPlanId: null,
    goalId: null,
    source: "chat",
    metadata: {
      ...args.metadata,
      ...(args.ownerSurface ? { ownerSurface: args.ownerSurface } : {}),
    },
    createdAt: now,
    updatedAt: now,
  } satisfies LifeOpsTaskDefinition;
  return { definition, reminderPlan: null, performance: PERFORMANCE };
}

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000003" as UUID,
    getRoom: vi.fn(async () => null),
    useModel: vi.fn(async () => ""),
    getCache: vi.fn(async () => null),
    setCache: vi.fn(async () => true),
    deleteCache: vi.fn(async () => true),
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  } as unknown as IAgentRuntime;
}

function makeMessage(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    entityId: "00000000-0000-0000-0000-000000000002",
    agentId: "00000000-0000-0000-0000-000000000003",
    roomId: "00000000-0000-0000-0000-000000000004",
    content: { text },
  } as Memory;
}

async function review(args: {
  domain?: LifeOpsDomain;
  ownerSurface: string;
  target?: string;
}) {
  return runLifeOperationHandler(
    makeRuntime(),
    makeMessage(`review ${args.target ?? args.ownerSurface}`),
    undefined,
    {
      parameters: {
        subaction: "review",
        intent: `review ${args.target ?? args.ownerSurface}`,
        ownerSurface: args.ownerSurface,
        target: args.target,
        details: args.domain ? { domain: args.domain } : undefined,
      },
    } as HandlerOptions,
  );
}

function definitionTitles(
  result: Awaited<ReturnType<typeof review>>,
): string[] {
  return (
    (result.data as { definitions?: Array<{ title: string }> }).definitions ??
    []
  ).map((definition) => definition.title);
}

describe("LifeOps definition review isolation", () => {
  beforeEach(() => {
    serviceState.createCalls.length = 0;
    serviceState.definitions = [
      definitionRecord({
        id: "todo-active",
        kind: "task",
        title: "File taxes",
      }),
      definitionRecord({
        id: "todo-paused",
        kind: "task",
        ownerSurface: "OWNER_TODOS",
        status: "paused",
        title: "Renew passport",
      }),
      definitionRecord({
        id: "reminder-active",
        kind: "task",
        metadata: {
          nativeAppleReminder: {
            kind: "reminder",
            provider: "apple_reminders",
            source: "heuristic",
          },
        },
        title: "Call dentist",
      }),
      definitionRecord({
        id: "alarm-active",
        kind: "task",
        metadata: {
          nativeAppleReminder: {
            kind: "alarm",
            provider: "apple_reminders",
            source: "heuristic",
          },
        },
        title: "Wake up",
      }),
      definitionRecord({
        id: "habit-active",
        kind: "habit",
        title: "Drink water",
      }),
      definitionRecord({
        id: "routine-active",
        kind: "routine",
        ownerSurface: "OWNER_ROUTINES",
        title: "Morning reset",
      }),
      definitionRecord({
        domain: "agent_ops",
        id: "agent-todo",
        kind: "task",
        ownerSurface: "OWNER_TODOS",
        title: "Rotate service key",
      }),
      definitionRecord({
        id: "project-alpha-plan",
        kind: "task",
        ownerSurface: "OWNER_TODOS",
        title: "Project Alpha plan",
      }),
      definitionRecord({
        id: "project-alpha-review",
        kind: "task",
        ownerSurface: "OWNER_TODOS",
        title: "Project Alpha review",
      }),
    ];
  });

  it.each([
    [
      "OWNER_TODOS",
      ["File taxes", "Project Alpha plan", "Project Alpha review"],
    ],
    ["OWNER_REMINDERS", ["Call dentist"]],
    ["OWNER_ALARMS", ["Wake up"]],
    ["OWNER_ROUTINES", ["Drink water", "Morning reset"]],
  ])(
    "keeps %s reviews on their owning surface",
    async (ownerSurface, titles) => {
      const result = await review({ ownerSurface });

      expect(result.success).toBe(true);
      expect(definitionTitles(result)).toEqual(titles);
      for (const title of titles) expect(result.text).toContain(title);
      for (const unrelated of [
        "Renew passport",
        "Call dentist",
        "Wake up",
        "Drink water",
        "Morning reset",
        "Rotate service key",
      ].filter((title) => !titles.includes(title))) {
        expect(result.text).not.toContain(unrelated);
      }
    },
  );

  it("applies the requested domain before rendering or returning definitions", async () => {
    const result = await review({
      domain: "agent_ops",
      ownerSurface: "OWNER_TODOS",
    });

    expect(result.success).toBe(true);
    expect(definitionTitles(result)).toEqual(["Rotate service key"]);
    expect(result.text).toContain("Rotate service key");
    expect(result.text).not.toContain("File taxes");
  });

  it("returns exactly one structurally allowed target", async () => {
    const result = await review({
      ownerSurface: "OWNER_TODOS",
      target: "File taxes",
    });

    expect(result.success).toBe(true);
    expect(definitionTitles(result)).toEqual(["File taxes"]);
    expect(result.text).toContain("File taxes");
    expect(result.text).not.toContain("Project Alpha");
  });

  it("rejects ambiguous and missing targets without leaking unrelated definitions", async () => {
    const ambiguous = await review({
      ownerSurface: "OWNER_TODOS",
      target: "Project Alpha",
    });
    expect(ambiguous).toMatchObject({
      success: false,
      data: {
        definitions: [],
        error: "LIFEOPS_DEFINITION_AMBIGUOUS",
      },
    });
    expect(ambiguous.text).toContain("Project Alpha plan");
    expect(ambiguous.text).toContain("Project Alpha review");
    expect(ambiguous.text).not.toContain("Call dentist");

    const missing = await review({
      ownerSurface: "OWNER_REMINDERS",
      target: "File taxes",
    });
    expect(missing).toMatchObject({
      success: false,
      data: {
        definitions: [],
        error: "LIFEOPS_DEFINITION_NOT_FOUND",
      },
    });
    expect(missing.text).not.toContain("Call dentist");
  });

  it("drops a list-verbiage target instead of empty-matching (live: planner stamped title 'list all')", async () => {
    const result = await review({
      ownerSurface: "OWNER_TODOS",
      target: "list all",
    });
    expect(result.success).toBe(true);
    expect(definitionTitles(result)).toEqual([
      "File taxes",
      "Project Alpha plan",
      "Project Alpha review",
    ]);
  });

  it("grounds an empty tracked-work claim only from an observed empty review", async () => {
    serviceState.definitions = [];

    const result = await review({ ownerSurface: "OWNER_TODOS" });

    expect(result).toMatchObject({
      success: true,
      data: {
        actionName: "OWNER_TODOS",
        claimGrounding: ["empty_tracked_state"],
        definitions: [],
      },
    });
  });

  it("persists the owning surface on newly created definitions", async () => {
    const result = await runLifeOperationHandler(
      makeRuntime(),
      makeMessage("yes, save it"),
      undefined,
      {
        parameters: {
          confirmed: true,
          details: {
            cadence: {
              dueAt: "2026-08-20T17:00:00.000Z",
              kind: "once",
            },
            kind: "task",
          },
          intent: "add file taxes with no due date",
          ownerSurface: "OWNER_TODOS",
          subaction: "create",
          title: "File taxes",
        },
      } as HandlerOptions,
    );

    expect(result.success).toBe(true);
    expect(serviceState.createCalls).toHaveLength(1);
    expect(serviceState.createCalls[0]).toMatchObject({
      metadata: { ownerSurface: "OWNER_TODOS" },
    });
  });
});
