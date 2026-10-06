/**
 * One-time cadence text must use the definition timezone. Duplicate-title
 * deletion reads clock tokens from that summary, so a host-local clock can
 * delete the other reminder.
 */

import type {
  LifeOpsCadence,
  LifeOpsDefinitionRecord,
  LifeOpsTaskDefinition,
} from "@elizaos/contracts";
import type {
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import * as assistant from "@elizaos/plugin-assistant";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLifeOperationHandler } from "./life.js";

const OWNER_ZONE = "America/Los_Angeles";

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
                createdAt: "2026-08-20T00:00:01.000Z",
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

function onceReminder(id: string, dueAt: string): LifeOpsDefinitionRecord {
  const now = "2026-08-15T00:00:00.000Z";
  const cadence = { kind: "once", dueAt } satisfies LifeOpsCadence;
  const definition = {
    id,
    agentId: "00000000-0000-0000-0000-000000000003",
    domain: "user_lifeops",
    subjectType: "owner",
    subjectId: "00000000-0000-0000-0000-000000000002",
    visibilityScope: "owner_only",
    contextPolicy: "allowed_in_private_chat",
    kind: "task",
    title: "Call dentist",
    description: "",
    originalIntent: "Call dentist",
    timezone: OWNER_ZONE,
    status: "active",
    priority: 5,
    cadence,
    windowPolicy: { timezone: OWNER_ZONE, windows: [] },
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

describe("one-time cadence summaries use the definition timezone", () => {
  beforeEach(() => {
    serviceState.definitions = [
      onceReminder("owner-9am", "2026-08-20T16:00:00.000Z"),
      onceReminder("owner-4pm", "2026-08-20T23:00:00.000Z"),
    ];
    serviceState.deletedIds.length = 0;
    vi.spyOn(assistant, "renderGroundedActionReply").mockImplementation(
      async (args) => ({ kind: "model", text: args.fallback }),
    );
  });

  it("reviews both reminders on the owner's clock", async () => {
    const result = await runLifeOperationHandler(
      makeRuntime(),
      makeMessage("what reminders do I have"),
      undefined,
      {
        parameters: {
          subaction: "review",
          intent: "what reminders do I have",
          ownerSurface: "OWNER_REMINDERS",
        },
      } as HandlerOptions,
    );
    const text = String(result.text);
    expect(text).toContain("9:00 AM");
    expect(text).toContain("4:00 PM");
    expect(text).not.toContain("12:00 AM");
  });

  it("deletes the 4pm duplicate instead of the 9am one", async () => {
    const text = "delete the Call dentist reminder at 4pm";
    const result = await runLifeOperationHandler(
      makeRuntime(),
      makeMessage(text),
      undefined,
      {
        parameters: {
          subaction: "delete",
          intent: text,
          ownerSurface: "OWNER_REMINDERS",
          target: "Call dentist",
        },
      } as HandlerOptions,
    );
    expect(result.success).toBe(true);
    expect(serviceState.deletedIds).toEqual(["owner-4pm"]);
  });

  describe("on a 24-hour host locale", () => {
    let hostLocale: { mockRestore(): void } | undefined;
    beforeEach(() => {
      // Simulate a de-DE host: an unspecified locale formats `9:00` with no
      // am/pm (and German month names), as on en-GB or de-DE servers.
      const hostFormat = Date.prototype.toLocaleString;
      hostLocale = vi
        .spyOn(Date.prototype, "toLocaleString")
        .mockImplementation(function (
          this: Date,
          locales?: Intl.LocalesArgument,
          options?: Intl.DateTimeFormatOptions,
        ) {
          return hostFormat.call(this, locales ?? "de-DE", options);
        });
    });
    afterEach(() => hostLocale?.mockRestore());

    it("still summarizes reminders with am/pm clock times", async () => {
      const result = await runLifeOperationHandler(
        makeRuntime(),
        makeMessage("what reminders do I have"),
        undefined,
        {
          parameters: {
            subaction: "review",
            intent: "what reminders do I have",
            ownerSurface: "OWNER_REMINDERS",
          },
        } as HandlerOptions,
      );
      const text = String(result.text);
      expect(text).toContain("9:00 AM");
      expect(text).toContain("4:00 PM");
    });

    it("still deletes the 4pm duplicate the owner named", async () => {
      const text = "delete the Call dentist reminder at 4pm";
      const result = await runLifeOperationHandler(
        makeRuntime(),
        makeMessage(text),
        undefined,
        {
          parameters: {
            subaction: "delete",
            intent: text,
            ownerSurface: "OWNER_REMINDERS",
            target: "Call dentist",
          },
        } as HandlerOptions,
      );
      expect(result.success).toBe(true);
      expect(serviceState.deletedIds).toEqual(["owner-4pm"]);
    });
  });
});
