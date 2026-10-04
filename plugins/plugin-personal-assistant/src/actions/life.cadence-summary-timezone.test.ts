/**
 * Cadence summaries render in the definition's explicit timezone, not the
 * host clock (issue #33155): the duplicate-title time-hint resolver extracts
 * clock tokens from that summary, so a host-local rendering selected and
 * deleted the wrong same-title reminder. Harness: real LIFE handler and
 * formatter; only the LifeOps storage collaborator is in-memory.
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
  LifeOpsTaskDefinition,
} from "../contracts/index.js";
import { runLifeOperationHandler } from "./life.js";

const serviceState = vi.hoisted(() => ({
  definitions: [] as LifeOpsDefinitionRecord[],
  deletedIds: [] as string[],
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

    repository = {
      listAuditEvents: async (
        _agentId: string,
        _ownerType: string,
        ownerId: string,
      ) =>
        serviceState.deletedIds.includes(ownerId)
          ? [
              {
                id: "audit-1",
                eventType: "definition_deleted",
                ownerId,
                createdAt: "2026-08-15T00:00:01.000Z",
              },
            ]
          : [],
    };
    async listDefinitions() {
      return serviceState.definitions;
    }
    async deleteDefinition(id: string) {
      serviceState.deletedIds.push(id);
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
  },
};

/** A one-time reminder whose stored `timezone` is the definition owner's
 * zone: 16:00Z is 9:00 AM and 23:00Z is 4:00 PM in America/Los_Angeles. */
function onceReminderRecord(args: {
  id: string;
  dueAt: string;
  title?: string;
}): LifeOpsDefinitionRecord {
  const now = "2026-08-15T00:00:00.000Z";
  const definition = {
    id: args.id,
    agentId: "00000000-0000-0000-0000-000000000003",
    domain: "user_lifeops",
    subjectType: "owner",
    subjectId: "00000000-0000-0000-0000-000000000002",
    visibilityScope: "owner_only",
    contextPolicy: "allowed_in_private_chat",
    kind: "task",
    title: args.title ?? "Call dentist",
    description: "",
    originalIntent: args.title ?? "Call dentist",
    timezone: "America/Los_Angeles",
    status: "active",
    priority: 5,
    cadence: { kind: "once", dueAt: args.dueAt },
    windowPolicy: { timezone: "America/Los_Angeles", windows: [] },
    progressionRule: { kind: "manual" },
    checkInPolicy: null,
    websiteAccess: null,
    reminderPlanId: null,
    goalId: null,
    source: "chat",
    metadata: { ownerSurface: "OWNER_REMINDERS" },
    createdAt: now,
    updatedAt: now,
  } satisfies LifeOpsTaskDefinition;
  return { definition, reminderPlan: null, performance: PERFORMANCE };
}

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000003" as UUID,
    getRoom: vi.fn(async () => null),
    getTasks: vi.fn(async () => []),
    useModel: vi.fn(async () => ""),
    getCache: vi.fn(async () => null),
    setCache: vi.fn(async () => true),
    deleteCache: vi.fn(async () => true),
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
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

async function requestLife(args: {
  messageText: string;
  parameters: Record<string, unknown>;
}) {
  return runLifeOperationHandler(
    makeRuntime(),
    makeMessage(args.messageText),
    undefined,
    { parameters: args.parameters } as HandlerOptions,
  );
}

describe("cadence summaries use the definition timezone (#33155)", () => {
  beforeEach(() => {
    serviceState.definitions = [
      onceReminderRecord({
        id: "owner-9am",
        dueAt: "2026-08-20T16:00:00.000Z",
      }),
      onceReminderRecord({
        id: "owner-4pm",
        dueAt: "2026-08-20T23:00:00.000Z",
      }),
    ];
    serviceState.deletedIds.length = 0;
  });

  it("a clock-hint duplicate delete selects the owner-local time, never the host-local match", async () => {
    const result = await requestLife({
      messageText: "delete the Call dentist reminder at 4pm",
      parameters: {
        subaction: "delete",
        intent: "delete the Call dentist reminder at 4pm",
        ownerSurface: "OWNER_REMINDERS",
        target: "Call dentist",
      },
    });
    expect(result.success).toBe(true);
    expect(serviceState.deletedIds).toEqual(["owner-4pm"]);
    expect(String(result.text)).toContain('Deleted "Call dentist"');
  });

  it("a duplicate delete without a clock hint asks with owner-local labels", async () => {
    const result = await requestLife({
      messageText: "delete the Call dentist reminder",
      parameters: {
        subaction: "delete",
        intent: "delete the Call dentist reminder",
        ownerSurface: "OWNER_REMINDERS",
        target: "Call dentist",
      },
    });
    expect(result.success).toBe(false);
    expect(serviceState.deletedIds).toHaveLength(0);
    const text = String(result.text);
    expect(text).toContain("9:00 AM");
    expect(text).toContain("4:00 PM");
    expect(text).not.toContain("11:00");
    expect(text).not.toContain("6:00");
  });

  it("reminder review renders the owner-local time regardless of host zone", async () => {
    const result = await requestLife({
      messageText: "review my reminders",
      parameters: {
        subaction: "review",
        intent: "review my reminders",
        ownerSurface: "OWNER_REMINDERS",
      },
    });
    expect(result.success).toBe(true);
    const text = String(result.text);
    expect(text).toContain("once on Aug 20 at 9:00 AM");
    expect(text).toContain("once on Aug 20 at 4:00 PM");
    expect(text).not.toContain("11:00");
    expect(text).not.toContain("6:00");
  });
});
