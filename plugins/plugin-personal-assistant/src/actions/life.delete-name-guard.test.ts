/**
 * Wrong-item fuzzy-deletion guard (watchtower's post-resurrection audit,
 * HQ #18309): "delete the reminder named check the oven" deleted
 * "check the kettle" — a token-overlap guess — and reported success. The
 * destructive resolver mode now degrades scorer-only matches into
 * clarification candidates (ask, never delete a guess), while containment
 * matches (exact/substring — "one name contains the other") still delete.
 * Sibling of the trigger path's TRIGGER_REF_MISMATCH guard; update stays
 * exempt per that precedent.
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
  },
};

function reminderRecord(id: string, title: string): LifeOpsDefinitionRecord {
  const now = "2026-08-15T00:00:00.000Z";
  const definition = {
    id,
    agentId: "00000000-0000-0000-0000-000000000003",
    domain: "user_lifeops",
    subjectType: "owner",
    subjectId: "00000000-0000-0000-0000-000000000002",
    visibilityScope: "owner_only",
    contextPolicy: "allowed_in_private_chat",
    kind: "task",
    title,
    description: "",
    originalIntent: title,
    timezone: "UTC",
    status: "active",
    priority: 5,
    cadence: { kind: "unscheduled" },
    windowPolicy: { timezone: "UTC", windows: [] },
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

async function requestDelete(targetPhrase: string, messageTextValue: string) {
  return runLifeOperationHandler(
    makeRuntime(),
    makeMessage(messageTextValue),
    undefined,
    {
      parameters: {
        subaction: "delete",
        intent: messageTextValue,
        ownerSurface: "OWNER_REMINDERS",
        target: targetPhrase,
      },
    } as HandlerOptions,
  );
}

describe("destructive definition resolution — wrong-item guard", () => {
  beforeEach(() => {
    serviceState.definitions = [reminderRecord("r-kettle", "check the kettle")];
    serviceState.deletedIds.length = 0;
  });

  it("a token-overlap near-miss asks instead of deleting the wrong record", async () => {
    const result = await requestDelete(
      "check the oven",
      "delete the reminder named check the oven",
    );
    expect(result.success).toBe(false);
    expect(serviceState.deletedIds).toHaveLength(0);
    expect(String(result.text)).toContain("check the kettle");
    expect(String(result.text)).not.toMatch(/^Deleted/);
  });

  it("a containment match still deletes (exact/substring names keep working)", async () => {
    const result = await requestDelete(
      "check the kettle",
      "delete the reminder check the kettle",
    );
    expect(result.success).toBe(true);
    expect(serviceState.deletedIds).toEqual(["r-kettle"]);
  });
});
