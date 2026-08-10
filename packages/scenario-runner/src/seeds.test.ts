/**
 * Tests `applyScenarioSeedStep` (seeds.ts) against a runtime stub, covering the
 * todo / contact / memory / LifeOps / MCP fixture seed types. The MCP harness
 * uses a structural Google-service seam and never opens a network listener.
 */
import type { AgentRuntime, ConnectorAccount, UUID } from "@elizaos/core";
import { getConnectorAccountManager, stringToUuid } from "@elizaos/core";
import { createRealTestRuntime } from "@elizaos/core/testing";
import type {
  McpAttachmentRef,
  McpResourceEngine,
} from "@elizaos/plugin-mcp/resource-engine";
import type {
  ScenarioContext,
  ScenarioSeedStep,
} from "@elizaos/scenario-runner/schema";
import { GOOGLE_WORKSPACE_MCP_RESOURCES } from "@elizaos/shared/contracts";
import { describe, expect, it, vi } from "vitest";
import { applyScenarioSeedStep } from "./seeds";

type LifeOpsScheduledTaskForTest = {
  taskId: string;
  kind: string;
  priority: string;
  trigger: Record<string, unknown>;
  state: { status: string; followupCount: number };
  metadata?: Record<string, unknown>;
};

type LifeOpsIntentForTest = {
  id: string;
  title: string;
  priority: string;
  target: string;
  targetDeviceId?: string;
  metadata: Record<string, unknown>;
};

type LifeOpsReminderAttemptForTest = {
  id: string;
  planId: string;
  channel: string;
  stepIndex: number;
  attemptedAt: string | null;
  outcome: string;
  connectorRef: string | null;
  deliveryMetadata: Record<string, unknown>;
  reviewAt?: string | null;
  reviewStatus?: string | null;
};

type LifeOpsBrowserSessionForTest = {
  id: string;
  title: string;
  status: string;
  result: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

async function createMcpFixtureHarness(seedAccount = true): Promise<{
  ctx: ScenarioContext;
  engine: () => McpResourceEngine;
  ref: () => McpAttachmentRef;
  runtime: AgentRuntime;
}> {
  let activeEngine: McpResourceEngine | undefined;
  let activeRef: McpAttachmentRef | undefined;
  const host = {
    options: {
      engine: {
        attach: vi.fn(),
        detach: vi.fn(),
        discover: vi.fn(),
        callTool: vi.fn(),
      } as unknown as McpResourceEngine,
    },
  };
  const service = {
    mcpHost: host,
    disconnectMcpAccount: vi.fn(async () => {
      if (activeEngine && activeRef) await activeEngine.detach(activeRef);
      activeRef = undefined;
    }),
    connectMcpAccount: vi.fn(async (account: ConnectorAccount) => {
      activeEngine = host.options.engine;
      activeRef = await activeEngine.attach({
        key: `google:scenario-agent:${account.id}:gmail`,
        endpoint: GOOGLE_WORKSPACE_MCP_RESOURCES.gmail.endpoint,
      });
      await activeEngine.discover(activeRef);
      return { products: { gmail: { status: "connected" } } };
    }),
  };
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001" as UUID,
    getService: vi.fn((name: string) => (name === "google" ? service : null)),
  } as unknown as AgentRuntime;
  const manager = getConnectorAccountManager(runtime);
  manager.registerProvider({ provider: "google", label: "Google" });
  if (seedAccount) {
    await manager.upsertAccount("google", {
      id: "google-personal",
      provider: "google",
      role: "OWNER",
      purpose: ["reading", "messaging"],
      accessGate: "open",
      status: "connected",
      capabilities: ["gmail.read", "gmail.draft", "gmail.manage"],
      scopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
        "https://www.googleapis.com/auth/gmail.modify",
      ],
      selectedProducts: ["gmail"],
      createdAt: 1,
      updatedAt: 1,
    });
  }
  return {
    ctx: { runtime, actionsCalled: [], mcpFixtures: [], mcpToolCalls: [] },
    runtime,
    engine: () => {
      if (!activeEngine) throw new Error("fixture engine was not connected");
      return activeEngine;
    },
    ref: () => {
      if (!activeRef) throw new Error("fixture attachment was not connected");
      return activeRef;
    },
  };
}

type ConnectorContributionForTest = {
  kind: string;
  capabilities: string[];
  modes: Array<"local" | "cloud">;
  describe: { label: string };
  start: () => Promise<void>;
  disconnect: () => Promise<void>;
  verify: () => Promise<boolean>;
  status: () => Promise<{
    state: "ok" | "degraded" | "disconnected";
    message?: string;
    observedAt: string;
  }>;
  send?: (payload: unknown) => Promise<unknown>;
};

type ConnectorRegistryModuleForTest = {
  createConnectorRegistry: () => {
    register: (contribution: ConnectorContributionForTest) => void;
    get: (kind: string) => ConnectorContributionForTest | null;
    list: (filter?: {
      capability?: string;
      mode?: "local" | "cloud";
    }) => ConnectorContributionForTest[];
    byCapability: (capability: string) => ConnectorContributionForTest[];
  };
  getConnectorRegistry: (
    runtime: AgentRuntime,
  ) => ReturnType<
    ConnectorRegistryModuleForTest["createConnectorRegistry"]
  > | null;
  registerConnectorRegistry: (
    runtime: AgentRuntime,
    registry: ReturnType<
      ConnectorRegistryModuleForTest["createConnectorRegistry"]
    >,
  ) => void;
};

async function loadConnectorRegistryForTest(): Promise<ConnectorRegistryModuleForTest> {
  const specifier = new URL(
    "../../../plugins/plugin-personal-assistant/src/lifeops/connectors/registry.ts",
    import.meta.url,
  ).href;
  return import(specifier) as Promise<ConnectorRegistryModuleForTest>;
}

function createSeedContext() {
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001" as UUID,
  } as unknown as AgentRuntime;
  return { runtime, ctx: { runtime } as ScenarioContext };
}

function createSeedHarness() {
  const relationships = {
    getContact: vi.fn(async () => null),
    addContact: vi.fn(async () => undefined),
    updateContact: vi.fn(async () => undefined),
    addHandle: vi.fn(async () => undefined),
    recordInteraction: vi.fn(async () => undefined),
    setRelationshipGoal: vi.fn(async () => undefined),
  };
  const createMemory = vi.fn(
    async (
      _memory: Record<string, unknown>,
      _tableName: string,
      _unique?: boolean,
    ) => "fact-id" as UUID,
  );
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001" as UUID,
    getService: vi.fn((serviceName: string) =>
      serviceName === "relationships" ? relationships : null,
    ),
    getEntityById: vi.fn(async () => null),
    createEntity: vi.fn(async () => undefined),
    createMemory,
  } as unknown as AgentRuntime;
  return {
    ctx: {
      runtime,
      scenarioId: "seed-test",
      primaryRoomId: "00000000-0000-0000-0000-0000000000aa",
      primaryUserId: "00000000-0000-0000-0000-0000000000bb",
    } as ScenarioContext,
    relationships,
    runtime,
    createMemory,
  };
}

function baseConnector(
  overrides: Partial<ConnectorContributionForTest> = {},
): ConnectorContributionForTest {
  return {
    kind: "telegram",
    capabilities: ["telegram.send"],
    modes: ["local"],
    describe: { label: "Telegram bridge" },
    start: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    verify: vi.fn(async () => true),
    status: vi.fn(async () => ({
      state: "ok" as const,
      observedAt: "2026-01-01T00:00:00.000Z",
    })),
    send: vi.fn(async () => ({ ok: true, messageId: "sent-1" })),
    ...overrides,
  };
}

describe("scenario memory seeds", () => {
  it("writes user-state memory seeds into proactive activity profile metadata", async () => {
    const harness = await createRealTestRuntime({
      withLLM: false,
      characterName: "scenario-user-state-seed-test",
    });
    try {
      const ctx = {
        runtime: harness.runtime,
        scenarioId: "push.urgent-bypasses-do-not-disturb",
        now: "2026-07-06T14:00:00.000Z",
        primaryUserId: "00000000-0000-0000-0000-0000000000bb",
      } as ScenarioContext;

      const result = await applyScenarioSeedStep(ctx, {
        type: "memory",
        content: {
          kind: "user-state",
          doNotDisturb: true,
          lastSeenPlatform: "mobile",
          isCurrentlyActive: true,
        },
      } satisfies ScenarioSeedStep);

      expect(result).toBeUndefined();
      const tasks = await harness.runtime.getTasks({
        tags: ["queue", "repeat", "proactive"],
      });
      const proactiveTask = tasks.find(
        (task) => task.name === "PROACTIVE_AGENT",
      );
      expect(proactiveTask?.metadata).toMatchObject({
        proactiveAgent: { kind: "runtime_runner" },
        activityProfile: {
          ownerEntityId: "00000000-0000-0000-0000-0000000000bb",
          analyzedAt: Date.parse("2026-07-06T14:00:00.000Z"),
          totalMessages: 0,
          primaryPlatform: "mobile",
          lastSeenPlatform: "mobile",
          isCurrentlyActive: true,
          dndActive: true,
          metadata: {
            source: "scenario-seed",
            scenarioId: "push.urgent-bypasses-do-not-disturb",
          },
        },
      });
    } finally {
      await harness.cleanup();
    }
  }, 120_000);

  it("maps active focus-window and queued-push memory seeds into LifeOps attention state", async () => {
    const harness = await createRealTestRuntime({
      withLLM: false,
      characterName: "scenario-focus-window-seed-test",
    });
    try {
      const ctx = {
        runtime: harness.runtime,
        scenarioId: "push.silent-during-deep-work",
        now: "2026-07-06T14:00:00.000Z",
        primaryUserId: "00000000-0000-0000-0000-0000000000cc",
      } as ScenarioContext;

      const result = await applyScenarioSeedStep(ctx, {
        type: "memory",
        content: {
          kind: "focus-window-active",
          title: "Deep work block",
          startAt: "2026-07-06T13:30:00.000Z",
          endAt: "2026-07-06T15:30:00.000Z",
        },
      } satisfies ScenarioSeedStep);
      const queuedResult = await applyScenarioSeedStep(ctx, {
        type: "memory",
        content: {
          kind: "queued-push",
          title: "Send newsletter draft",
          urgency: "low",
        },
      } satisfies ScenarioSeedStep);

      expect(result).toBeUndefined();
      expect(queuedResult).toBeUndefined();
      const tasks = await harness.runtime.getTasks({
        tags: ["queue", "repeat", "proactive"],
      });
      const proactiveTask = tasks.find(
        (task) => task.name === "PROACTIVE_AGENT",
      );
      expect(proactiveTask?.metadata).toMatchObject({
        proactiveAgent: { kind: "runtime_runner" },
        activityProfile: {
          ownerEntityId: "00000000-0000-0000-0000-0000000000cc",
          primaryPlatform: "desktop",
          lastSeenPlatform: "desktop",
          isCurrentlyActive: true,
          screenContextBusy: true,
          screenContextAvailable: true,
          screenContextFocus: "work",
          dndActive: false,
          metadata: {
            source: "scenario-seed",
            scenarioId: "push.silent-during-deep-work",
            focusWindow: {
              title: "Deep work block",
              startAt: "2026-07-06T13:30:00.000Z",
              endAt: "2026-07-06T15:30:00.000Z",
            },
          },
        },
      });

      const { LifeOpsRepository } = (await import(
        "../../../plugins/plugin-personal-assistant/src/lifeops/repository.ts"
      )) as {
        LifeOpsRepository: new (
          runtime: AgentRuntime,
        ) => {
          listScheduledTasks: (
            agentId: string,
            filter?: Record<string, unknown>,
          ) => Promise<LifeOpsScheduledTaskForTest[]>;
        };
      };
      const repository = new LifeOpsRepository(harness.runtime);
      const scheduledTasks = await repository.listScheduledTasks(
        String(harness.runtime.agentId),
        { kind: "reminder", status: "scheduled" },
      );
      expect(scheduledTasks).toContainEqual(
        expect.objectContaining({
          taskId:
            "scenario-queued-push:push.silent-during-deep-work:Send newsletter draft",
          kind: "reminder",
          priority: "low",
          trigger: { kind: "once", atIso: "2026-07-06T14:00:00.000Z" },
          state: { status: "scheduled", followupCount: 0 },
          metadata: expect.objectContaining({
            source: "scenario-seed",
            scenarioId: "push.silent-during-deep-work",
            push: {
              title: "Send newsletter draft",
              urgency: "low",
              channel: "push",
            },
          }),
        }),
      );
    } finally {
      await harness.cleanup();
    }
  }, 120_000);

  it("maps device-intent memory seeds into pending LifeOps device intents", async () => {
    const harness = await createRealTestRuntime({
      withLLM: false,
      characterName: "scenario-device-intent-seed-test",
    });
    try {
      const ctx = {
        runtime: harness.runtime,
        scenarioId: "push.ack-from-one-device-clears-others",
        now: "2026-07-06T14:00:00.000Z",
      } as ScenarioContext;

      const result = await applyScenarioSeedStep(ctx, {
        type: "memory",
        content: {
          kind: "device-intent",
          id: "di-board-call-meeting",
          title: "Board call at 3pm",
          priority: "high",
          dispatchedTo: ["desktop", "mobile", "watch"],
        },
      } satisfies ScenarioSeedStep);

      expect(result).toBeUndefined();
      const { receivePendingIntents } = (await import(
        "../../../plugins/plugin-personal-assistant/src/lifeops/intent-sync.ts"
      )) as {
        receivePendingIntents: (
          runtime: AgentRuntime,
          opts?: {
            device?: "all" | "desktop" | "mobile" | "specific";
            deviceId?: string;
            limit?: number;
          },
        ) => Promise<LifeOpsIntentForTest[]>;
      };
      const desktop = await receivePendingIntents(harness.runtime, {
        device: "desktop",
      });
      const mobile = await receivePendingIntents(harness.runtime, {
        device: "mobile",
      });
      const watch = await receivePendingIntents(harness.runtime, {
        device: "specific",
        deviceId: "watch",
      });

      expect(desktop).toContainEqual(
        expect.objectContaining({
          id: "di-board-call-meeting:desktop",
          title: "Board call at 3pm",
          priority: "high",
          target: "desktop",
          metadata: expect.objectContaining({
            source: "scenario-seed",
            scenarioId: "push.ack-from-one-device-clears-others",
            deviceIntentId: "di-board-call-meeting",
            syncGroupId: "di-board-call-meeting",
            dispatchedTo: ["desktop", "mobile", "watch"],
            device: "desktop",
          }),
        }),
      );
      expect(mobile).toContainEqual(
        expect.objectContaining({
          id: "di-board-call-meeting:mobile",
          target: "mobile",
        }),
      );
      expect(watch).toContainEqual(
        expect.objectContaining({
          id: "di-board-call-meeting:watch",
          target: "specific",
          targetDeviceId: "watch",
        }),
      );
    } finally {
      await harness.cleanup();
    }
  }, 120_000);

  it("maps push delivery and ladder state seeds into reminder attempts", async () => {
    const harness = await createRealTestRuntime({
      withLLM: false,
      characterName: "scenario-reminder-attempt-seed-test",
    });
    try {
      const ctx = {
        runtime: harness.runtime,
        scenarioId: "push.failed-delivery-retry-on-secondary-channel",
        now: "2026-07-06T14:00:00.000Z",
      } as ScenarioContext;

      const failedResult = await applyScenarioSeedStep(ctx, {
        type: "memory",
        content: {
          kind: "push-delivery-attempt",
          channel: "ntfy",
          topic: "eliza-shaw-mobile",
          result: "failed",
          statusCode: 503,
          attemptedAt: "2026-07-06T13:58:00.000Z",
        },
      } satisfies ScenarioSeedStep);
      const ladderResult = await applyScenarioSeedStep(
        {
          ...ctx,
          scenarioId: "push.voice-call-as-last-resort",
        } as ScenarioContext,
        {
          type: "memory",
          content: {
            kind: "ladder-state",
            history: [
              {
                channel: "desktop",
                at: "2026-07-06T13:30:00.000Z",
                ackedAt: null,
              },
              {
                channel: "mobile",
                at: "2026-07-06T13:38:00.000Z",
                ackedAt: null,
              },
              {
                channel: "sms",
                at: "2026-07-06T13:48:00.000Z",
                ackedAt: null,
              },
            ],
            urgency: "critical",
          },
        } satisfies ScenarioSeedStep,
      );

      expect(failedResult).toBeUndefined();
      expect(ladderResult).toBeUndefined();
      const { LifeOpsRepository } = (await import(
        "../../../plugins/plugin-personal-assistant/src/lifeops/repository.ts"
      )) as {
        LifeOpsRepository: new (
          runtime: AgentRuntime,
        ) => {
          listReminderAttempts: (
            agentId: string,
            filter?: Record<string, unknown>,
          ) => Promise<LifeOpsReminderAttemptForTest[]>;
        };
      };
      const repository = new LifeOpsRepository(harness.runtime);
      const failedAttempts = await repository.listReminderAttempts(
        String(harness.runtime.agentId),
        {
          planId:
            "scenario-reminder-plan:push.failed-delivery-retry-on-secondary-channel:ntfy push",
        },
      );
      expect(failedAttempts).toContainEqual(
        expect.objectContaining({
          channel: "ntfy",
          outcome: "blocked_connector",
          connectorRef: "ntfy:eliza-shaw-mobile",
          deliveryMetadata: expect.objectContaining({
            source: "scenario-seed",
            scenarioId: "push.failed-delivery-retry-on-secondary-channel",
            statusCode: 503,
            result: "failed",
            topic: "eliza-shaw-mobile",
          }),
        }),
      );

      const ladderAttempts = await repository.listReminderAttempts(
        String(harness.runtime.agentId),
        { planId: "scenario-ladder:push.voice-call-as-last-resort" },
      );
      expect(ladderAttempts.map((attempt) => attempt.channel)).toEqual([
        "desktop",
        "mobile",
        "sms",
      ]);
      expect(ladderAttempts).toContainEqual(
        expect.objectContaining({
          channel: "sms",
          stepIndex: 2,
          outcome: "delivered_unread",
          reviewAt: "2026-07-06T14:00:00.000Z",
          reviewStatus: "no_response",
          deliveryMetadata: expect.objectContaining({
            scenarioId: "push.voice-call-as-last-resort",
            urgency: "critical",
          }),
        }),
      );
    } finally {
      await harness.cleanup();
    }
  }, 120_000);

  it("writes calendar-event memory seeds into the LifeOps calendar event store", async () => {
    const harness = await createRealTestRuntime({
      withLLM: false,
      characterName: "scenario-calendar-seed-test",
    });
    try {
      const ctx = {
        runtime: harness.runtime,
        scenarioId: "push.meeting-reminder-T-0",
        now: "2026-07-06T14:00:00.000Z",
      } as ScenarioContext;

      const result = await applyScenarioSeedStep(ctx, {
        type: "memory",
        content: {
          kind: "calendar-event",
          id: "evt-eng-standup",
          title: "Eng standup",
          startAt: "2026-07-06T15:00:00.000Z",
          joinLink: "https://meet.example.com/eng-standup",
          attendees: [
            { email: "owner@example.com", responseStatus: "accepted" },
          ],
        },
      } satisfies ScenarioSeedStep);

      expect(result).toBeUndefined();
      const { LifeOpsRepository } = await import(
        "../../../plugins/plugin-personal-assistant/src/lifeops/repository.ts"
      );
      const repository = new LifeOpsRepository(harness.runtime);
      const events = await repository.listCalendarEvents(
        String(harness.runtime.agentId),
        "google",
        "2026-07-06T14:30:00.000Z",
        "2026-07-06T16:00:00.000Z",
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        id: "evt-eng-standup",
        externalId: "evt-eng-standup",
        calendarId: "primary",
        title: "Eng standup",
        status: "confirmed",
        startAt: "2026-07-06T15:00:00.000Z",
        endAt: "2026-07-06T15:30:00.000Z",
        conferenceLink: "https://meet.example.com/eng-standup",
        metadata: expect.objectContaining({
          source: "scenario-seed",
          kind: "calendar-event",
          scenarioId: "push.meeting-reminder-T-0",
          joinLink: "https://meet.example.com/eng-standup",
        }),
      });
      expect(events[0]?.attendees).toEqual([
        { email: "owner@example.com", responseStatus: "accepted" },
      ]);
    } finally {
      await harness.cleanup();
    }
  }, 120_000);

  it("maps cancelled calendar-event shorthand into cancelled calendar rows", async () => {
    const harness = await createRealTestRuntime({
      withLLM: false,
      characterName: "scenario-cancelled-calendar-seed-test",
    });
    try {
      const ctx = {
        runtime: harness.runtime,
        scenarioId: "push.scheduled-notification-cancel-when-event-cancelled",
        now: "2026-07-06T14:00:00.000Z",
      } as ScenarioContext;

      const result = await applyScenarioSeedStep(ctx, {
        type: "memory",
        content: {
          kind: "calendar-event",
          id: "evt-investor-sync",
          title: "Investor sync",
          startAt: "2026-07-06T16:00:00.000Z",
          cancelled: true,
          cancelledAt: "2026-07-06T13:50:00.000Z",
        },
      } satisfies ScenarioSeedStep);

      expect(result).toBeUndefined();
      const { LifeOpsRepository } = await import(
        "../../../plugins/plugin-personal-assistant/src/lifeops/repository.ts"
      );
      const repository = new LifeOpsRepository(harness.runtime);
      const events = await repository.listCalendarEvents(
        String(harness.runtime.agentId),
        "google",
        "2026-07-06T15:30:00.000Z",
        "2026-07-06T17:00:00.000Z",
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        id: "evt-investor-sync",
        title: "Investor sync",
        status: "cancelled",
        metadata: expect.objectContaining({
          cancelledAt: "2026-07-06T13:50:00.000Z",
        }),
      });
    } finally {
      await harness.cleanup();
    }
  }, 120_000);

  it("writes inbound-message memory seeds into the messages table", async () => {
    const harness = await createRealTestRuntime({
      withLLM: false,
      characterName: "scenario-inbound-seed-test",
    });
    try {
      const roomId = stringToUuid("scenario-inbound-seed-room");
      const ownerId = stringToUuid("scenario-inbound-seed-owner");
      await harness.runtime.ensureConnection({
        entityId: ownerId,
        roomId,
        worldId: stringToUuid("scenario-inbound-seed-world"),
        userName: "Scenario owner",
        source: "scenario-runner",
        channelId: roomId,
        type: "DM",
      });
      const ctx = {
        runtime: harness.runtime,
        scenarioId: "identity.detect-impersonation-attempt",
        now: "2026-07-06T14:00:00.000Z",
        primaryRoomId: roomId,
        primaryUserId: ownerId,
      } as ScenarioContext;

      const result = await applyScenarioSeedStep(ctx, {
        type: "memory",
        content: {
          kind: "inbound-message",
          platform: "telegram",
          handle: "@jordan_kim_real",
          platformUserId: "tg-99887",
          displayName: "Jordan Kim",
          text: "hey can you send me the deck and wallet seed quickly",
          priority: "interrupt",
        },
      } satisfies ScenarioSeedStep);

      expect(result).toBeUndefined();
      const memories = await harness.runtime.getMemories({
        roomId,
        tableName: "messages",
        count: 5,
      });
      expect(memories).toHaveLength(1);
      expect(memories[0]?.content).toMatchObject({
        text: "hey can you send me the deck and wallet seed quickly",
        source: "telegram",
        displayName: "Jordan Kim",
        senderName: "Jordan Kim",
        username: "@jordan_kim_real",
        platformUserId: "tg-99887",
        priority: "interrupt",
      });
      expect(memories[0]?.metadata).toMatchObject({
        type: "message",
        source: "scenario-seed",
        kind: "inbound-message",
        scenarioId: "identity.detect-impersonation-attempt",
        entityName: "Jordan Kim",
        sender: {
          name: "Jordan Kim",
          username: "@jordan_kim_real",
          id: "tg-99887",
        },
        provider: "telegram",
        telegram: {
          userId: "tg-99887",
          id: "tg-99887",
        },
      });
    } finally {
      await harness.cleanup();
    }
  }, 120_000);

  it("maps appointment and scheduled-push-ladder seeds into calendar and scheduled-task state", async () => {
    const harness = await createRealTestRuntime({
      withLLM: false,
      characterName: "scenario-appointment-ladder-seed-test",
    });
    try {
      const roomId = stringToUuid("scenario-appointment-ladder-room");
      const ownerId = stringToUuid("scenario-appointment-ladder-owner");
      await harness.runtime.ensureConnection({
        entityId: ownerId,
        roomId,
        worldId: stringToUuid("scenario-appointment-ladder-world"),
        userName: "Scenario owner",
        source: "scenario-runner",
        channelId: roomId,
        type: "DM",
      });
      const ctx = {
        runtime: harness.runtime,
        scenarioId: "push.scheduled-notification-cancel-when-event-cancelled",
        now: "2026-07-06T14:00:00.000Z",
        primaryRoomId: roomId,
        primaryUserId: ownerId,
      } as ScenarioContext;

      const missingEventResult = await applyScenarioSeedStep(ctx, {
        type: "memory",
        content: {
          kind: "scheduled-push-ladder",
          eventId: "missing-event",
          rungs: [{ offsetMin: -10, channel: "mobile", status: "pending" }],
        },
      } satisfies ScenarioSeedStep);
      const appointmentResult = await applyScenarioSeedStep(ctx, {
        type: "memory",
        content: {
          kind: "appointment",
          id: "evt-investor-sync",
          provider: "Westside Imaging",
          startAt: "2026-07-06T20:00:00.000Z",
          requiresSignature: true,
          signatureCompleted: false,
        },
      } satisfies ScenarioSeedStep);
      const ladderResult = await applyScenarioSeedStep(ctx, {
        type: "memory",
        content: {
          kind: "scheduled-push-ladder",
          eventId: "evt-investor-sync",
          rungs: [
            { offsetMin: -60, channel: "desktop", status: "pending" },
            { offsetMin: -10, channel: "mobile", status: "pending" },
          ],
        },
      } satisfies ScenarioSeedStep);

      expect(missingEventResult).toMatch(
        /requires a previously seeded calendar event/,
      );
      expect(appointmentResult).toBeUndefined();
      expect(ladderResult).toBeUndefined();
      const { LifeOpsRepository } = await import(
        "../../../plugins/plugin-personal-assistant/src/lifeops/repository.ts"
      );
      const repository = new LifeOpsRepository(harness.runtime);
      const events = await repository.listCalendarEvents(
        String(harness.runtime.agentId),
        "google",
        "2026-07-06T19:30:00.000Z",
        "2026-07-06T21:00:00.000Z",
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          title: "Westside Imaging appointment",
          startAt: "2026-07-06T20:00:00.000Z",
          metadata: expect.objectContaining({
            source: "scenario-seed",
            appointment: expect.objectContaining({
              provider: "Westside Imaging",
              requiresSignature: true,
              signatureCompleted: false,
            }),
          }),
        }),
      );

      const scheduledTasks = await repository.listScheduledTasks(
        String(harness.runtime.agentId),
        { kind: "reminder", status: "scheduled" },
      );
      expect(
        scheduledTasks.filter(
          (task: LifeOpsScheduledTaskForTest) =>
            task.metadata?.seedKind === "scheduled-push-ladder",
        ),
      ).toHaveLength(2);
      expect(scheduledTasks).toContainEqual(
        expect.objectContaining({
          taskId:
            "scenario-scheduled-push-ladder:push.scheduled-notification-cancel-when-event-cancelled:evt-investor-sync:0:desktop",
          metadata: expect.objectContaining({
            eventId: "evt-investor-sync",
            rung: {
              offsetMin: -60,
              channel: "desktop",
              status: "pending",
              index: 0,
            },
          }),
          trigger: {
            kind: "once",
            atIso: "2026-07-06T19:00:00.000Z",
          },
        }),
      );
      expect(scheduledTasks).toContainEqual(
        expect.objectContaining({
          taskId:
            "scenario-scheduled-push-ladder:push.scheduled-notification-cancel-when-event-cancelled:evt-investor-sync:1:mobile",
          trigger: {
            kind: "once",
            atIso: "2026-07-06T19:50:00.000Z",
          },
        }),
      );
    } finally {
      await harness.cleanup();
    }
  }, 120_000);

  it("maps browser-task-state seeds into browser workflow sessions", async () => {
    const harness = await createRealTestRuntime({
      withLLM: false,
      characterName: "scenario-browser-task-seed-test",
    });
    try {
      const roomId = stringToUuid("scenario-browser-task-room");
      const ownerId = stringToUuid("scenario-browser-task-owner");
      await harness.runtime.ensureConnection({
        entityId: ownerId,
        roomId,
        worldId: stringToUuid("scenario-browser-task-world"),
        userName: "Scenario owner",
        source: "scenario-runner",
        channelId: roomId,
        type: "DM",
      });
      const ctx = {
        runtime: harness.runtime,
        scenarioId: "push.stuck-agent-calls-user-CAPTCHA",
        now: "2026-07-06T14:00:00.000Z",
        primaryRoomId: roomId,
        primaryUserId: ownerId,
      } as ScenarioContext;

      const result = await applyScenarioSeedStep(ctx, {
        type: "memory",
        content: {
          kind: "browser-task-state",
          task: "United online check-in",
          blockedBy: "CAPTCHA",
          attempts: 2,
        },
      } satisfies ScenarioSeedStep);

      expect(result).toBeUndefined();
      const { LifeOpsRepository } = await import(
        "../../../plugins/plugin-personal-assistant/src/lifeops/repository.ts"
      );
      const repository = new LifeOpsRepository(harness.runtime);
      const sessions = (await repository.listBrowserSessions(
        String(harness.runtime.agentId),
      )) as LifeOpsBrowserSessionForTest[];
      expect(sessions).toContainEqual(
        expect.objectContaining({
          title: "United online check-in",
          status: "failed",
          result: {
            browserTask: {
              task: "United online check-in",
              blockedBy: "CAPTCHA",
              attempts: 2,
              state: "blocked",
            },
          },
          metadata: expect.objectContaining({
            source: "scenario-seed",
            seedKind: "browser-task-state",
          }),
        }),
      );
    } finally {
      await harness.cleanup();
    }
  }, 120_000);

  it("maps follow-up, digest, and voice-attempt seeds into LifeOps scheduled state", async () => {
    const harness = await createRealTestRuntime({
      withLLM: false,
      characterName: "scenario-followup-state-seed-test",
    });
    try {
      const roomId = stringToUuid("scenario-followup-state-room");
      const ownerId = stringToUuid("scenario-followup-state-owner");
      await harness.runtime.ensureConnection({
        entityId: ownerId,
        roomId,
        worldId: stringToUuid("scenario-followup-state-world"),
        userName: "Scenario owner",
        source: "scenario-runner",
        channelId: roomId,
        type: "DM",
      });
      const ctx = {
        runtime: harness.runtime,
        scenarioId: "followup.list-overdue-by-priority",
        now: "2026-07-06T14:00:00.000Z",
        primaryRoomId: roomId,
        primaryUserId: ownerId,
      } as ScenarioContext;

      await applyScenarioSeedStep(ctx, {
        type: "memory",
        content: {
          kind: "overdue-followup",
          name: "Reply to Acme VIP customer",
          priority: "vip",
          overdueAt: "2026-07-01T14:00:00.000Z",
        },
      } satisfies ScenarioSeedStep);
      await applyScenarioSeedStep(ctx, {
        type: "memory",
        content: {
          kind: "pending-low-urgency-pushes",
          items: [
            { title: "Send newsletter draft", category: "writing" },
            { title: "Archive old email labels", category: "inbox" },
          ],
        },
      } satisfies ScenarioSeedStep);
      await applyScenarioSeedStep(ctx, {
        type: "memory",
        content: {
          kind: "voice-call-attempt",
          outcome: "voicemail",
          attemptedAt: "2026-07-06T13:55:00.000Z",
          reason: "CAPTCHA on United check-in",
        },
      } satisfies ScenarioSeedStep);

      const { LifeOpsRepository } = (await import(
        "../../../plugins/plugin-personal-assistant/src/lifeops/repository.ts"
      )) as {
        LifeOpsRepository: new (
          runtime: AgentRuntime,
        ) => {
          listScheduledTasks: (
            agentId: string,
            filter?: Record<string, unknown>,
          ) => Promise<LifeOpsScheduledTaskForTest[]>;
          listReminderAttempts: (
            agentId: string,
            filter?: Record<string, unknown>,
          ) => Promise<LifeOpsReminderAttemptForTest[]>;
        };
      };
      const repository = new LifeOpsRepository(harness.runtime);
      const scheduledTasks = await repository.listScheduledTasks(
        String(harness.runtime.agentId),
        { status: "scheduled" },
      );
      expect(scheduledTasks).toContainEqual(
        expect.objectContaining({
          taskId:
            "scenario-overdue-followup:followup.list-overdue-by-priority:Reply to Acme VIP customer",
          priority: "high",
          metadata: expect.objectContaining({
            seedKind: "overdue-followup",
            followup: expect.objectContaining({
              topic: null,
              overdueAt: "2026-07-01T14:00:00.000Z",
            }),
          }),
        }),
      );
      expect(scheduledTasks).toContainEqual(
        expect.objectContaining({
          taskId:
            "scenario-pending-low-urgency-pushes:followup.list-overdue-by-priority:Low-urgency digest",
          priority: "low",
          metadata: expect.objectContaining({
            seedKind: "pending-low-urgency-pushes",
            digest: expect.objectContaining({
              titles: ["Send newsletter draft", "Archive old email labels"],
            }),
          }),
        }),
      );

      const attempts = await repository.listReminderAttempts(
        String(harness.runtime.agentId),
        {
          planId:
            "scenario-reminder-plan:followup.list-overdue-by-priority:CAPTCHA on United check-in",
        },
      );
      expect(attempts).toContainEqual(
        expect.objectContaining({
          channel: "voice",
          outcome: "blocked_connector",
          deliveryMetadata: expect.objectContaining({
            result: "failed",
            title: "CAPTCHA on United check-in",
          }),
        }),
      );
    } finally {
      await harness.cleanup();
    }
  }, 120_000);

  it("maps rolodex-entity memory seeds into relationship contacts", async () => {
    const { ctx, relationships, runtime } = createSeedHarness();

    const result = await applyScenarioSeedStep(ctx, {
      type: "memory",
      content: {
        kind: "rolodex-entity",
        id: "ent-acme-buyer",
        displayName: "Tomas Reyes",
        company: "Acme Inc.",
        tags: ["vip"],
        handles: [{ platform: "gmail", handle: "tomas.reyes@acme.com" }],
      },
    } satisfies ScenarioSeedStep);

    expect(result).toBeUndefined();
    expect(runtime.createEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        names: ["Tomas Reyes"],
      }),
    );
    expect(relationships.addContact).toHaveBeenCalledWith(
      expect.any(String),
      ["acquaintance"],
      expect.objectContaining({
        notes: expect.stringContaining("Company: Acme Inc."),
      }),
      { displayName: "Tomas Reyes" },
    );
    expect(relationships.addHandle).toHaveBeenCalledWith(expect.any(String), {
      platform: "gmail",
      identifier: "tomas.reyes@acme.com",
      displayLabel: undefined,
      isPrimary: undefined,
    });
    expect(relationships.updateContact).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        tags: ["vip"],
        relationshipStatus: "active",
      }),
    );
  });

  it("maps direct rolodex platform handles and recent news", async () => {
    const { ctx, relationships } = createSeedHarness();

    const result = await applyScenarioSeedStep(ctx, {
      type: "memory",
      content: {
        kind: "rolodex-entity",
        name: "Alex Rivera",
        primaryChannel: "telegram",
        telegramHandle: "@arivera",
        recentNews: "promoted to VP Engineering at Acme",
      },
    } satisfies ScenarioSeedStep);

    expect(result).toBeUndefined();
    expect(relationships.addHandle).toHaveBeenCalledWith(expect.any(String), {
      platform: "telegram",
      identifier: "@arivera",
      displayLabel: "Alex Rivera",
      isPrimary: true,
    });
    expect(relationships.addContact).toHaveBeenCalledWith(
      expect.any(String),
      ["acquaintance"],
      expect.objectContaining({
        notes: expect.stringContaining(
          "Recent news: promoted to VP Engineering at Acme",
        ),
      }),
      { displayName: "Alex Rivera" },
    );
  });

  it("maps merged-entity memory seeds into relationship contacts with all handles", async () => {
    const { ctx, relationships, runtime } = createSeedHarness();

    const result = await applyScenarioSeedStep(ctx, {
      type: "memory",
      content: {
        kind: "merged-entity",
        id: "ent-alex-lee-merged",
        displayName: "Alex Lee",
        handles: [
          {
            platform: "gmail",
            handle: "alex.lee@quanta.com",
            realPerson: "alex-1",
          },
          {
            platform: "telegram",
            handle: "@alexlee",
            realPerson: "alex-2",
          },
        ],
        mergedAccidentally: true,
      },
    } satisfies ScenarioSeedStep);

    expect(result).toBeUndefined();
    expect(runtime.createEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        names: ["Alex Lee"],
      }),
    );
    expect(relationships.addContact).toHaveBeenCalledWith(
      expect.any(String),
      ["merged-entity"],
      {
        notes:
          "Scenario entity id: ent-alex-lee-merged\n" +
          "Merged accidentally: true\n" +
          "gmail alex.lee@quanta.com real person: alex-1\n" +
          "telegram @alexlee real person: alex-2",
      },
      { displayName: "Alex Lee" },
    );
    const addedHandles = relationships.addHandle.mock.calls.map(
      (call) =>
        (
          call as unknown as [
            unknown,
            {
              platform: string;
              identifier: string;
            },
          ]
        )[1],
    );
    expect(addedHandles).toEqual([
      expect.objectContaining({
        platform: "gmail",
        identifier: "alex.lee@quanta.com",
      }),
      expect.objectContaining({
        platform: "telegram",
        identifier: "@alexlee",
      }),
    ]);
    expect(relationships.updateContact).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        relationshipStatus: "active",
        tags: ["merged-entity"],
      }),
    );
  });

  it("keeps direct platform handles and authored tags on merged-entity seeds", async () => {
    const { ctx, relationships } = createSeedHarness();

    await applyScenarioSeedStep(ctx, {
      type: "memory",
      content: {
        kind: "merged-entity",
        platform: "discord",
        handle: "priyam#0042",
        tags: ["vip", "studio"],
      },
    } satisfies ScenarioSeedStep);

    expect(relationships.addHandle).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        platform: "discord",
        identifier: "priyam#0042",
      }),
    );
    expect(relationships.updateContact).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        tags: ["vip", "studio"],
      }),
    );
  });

  it("writes plain-text memory seeds as durable owner facts in the facts table", async () => {
    const { ctx, createMemory } = createSeedHarness();

    const result = await applyScenarioSeedStep(ctx, {
      type: "memory",
      content: {
        text: "Owner fact: largest account is Halcyon Freight; their contact sometimes messages from a plain personal address with no signature.",
      },
    } satisfies ScenarioSeedStep);

    expect(result).toBeUndefined();
    expect(createMemory).toHaveBeenCalledTimes(1);
    const [memory, tableName, unique] = createMemory.mock.calls[0];
    expect(tableName).toBe("facts");
    expect(unique).toBe(true);
    expect(memory.roomId).toBe(ctx.primaryRoomId);
    expect(memory.entityId).toBe(ctx.primaryUserId);
    expect(memory.content).toEqual({
      text: "Owner fact: largest account is Halcyon Freight; their contact sometimes messages from a plain personal address with no signature.",
    });
    // Durable kind is load-bearing: the FACTS provider's keyword-miss
    // fallback only applies to durable facts, which is what guarantees a
    // seeded fact surfaces even without lexical overlap with the turn text.
    expect(memory.metadata).toMatchObject({
      kind: "durable",
      source: "scenario-seed",
    });
  });

  it("fails the seed (never silently no-ops) on unsupported memory kinds", async () => {
    const { ctx, relationships, createMemory } = createSeedHarness();

    const result = await applyScenarioSeedStep(ctx, {
      type: "memory",
      content: {
        kind: "future-unsupported-kind",
        text: "hello",
      },
    } satisfies ScenarioSeedStep);

    expect(result).toMatch(
      /unsupported memory seed kind "future-unsupported-kind"/,
    );
    expect(result).toContain("user-state");
    expect(createMemory).not.toHaveBeenCalled();
    expect(relationships.addContact).not.toHaveBeenCalled();
  });

  it("fails the seed when memory content has neither text nor a contact kind", async () => {
    const { ctx, createMemory } = createSeedHarness();

    const result = await applyScenarioSeedStep(ctx, {
      type: "memory",
      content: {},
    } satisfies ScenarioSeedStep);

    expect(result).toMatch(/non-empty text or a contact-like kind/);
    expect(createMemory).not.toHaveBeenCalled();
  });

  it("fails the seed when the executor did not provide the primary room identity", async () => {
    const { ctx, createMemory } = createSeedHarness();
    delete (ctx as { primaryRoomId?: string }).primaryRoomId;

    const result = await applyScenarioSeedStep(ctx, {
      type: "memory",
      content: { text: "Owner fact: something important." },
    } satisfies ScenarioSeedStep);

    expect(result).toMatch(/primaryRoomId/);
    expect(createMemory).not.toHaveBeenCalled();
  });
});

describe("scenario MCP fixtures", () => {
  it("creates a credentialless synthetic owner binding when none exists", async () => {
    const harness = await createMcpFixtureHarness(false);
    const result = await applyScenarioSeedStep(harness.ctx, {
      type: "mcpFixture",
      provider: "google",
      resource: "gmail",
      tool: "search_threads",
      arguments: { query: "is:unread" },
      result: { structuredContent: { threads: [] } },
    } satisfies ScenarioSeedStep);

    expect(result).toBeUndefined();
    const accounts = await getConnectorAccountManager(
      harness.runtime,
    ).listAccounts("google");
    expect(accounts).toEqual([
      expect.objectContaining({
        id: "scenario-google-owner",
        role: "OWNER",
        status: "connected",
        capabilities: ["gmail.read"],
        selectedProducts: ["gmail"],
        metadata: { synthetic: true, fixtureOnly: true },
      }),
    ]);
    expect(JSON.stringify(accounts)).not.toMatch(/token|credentialRefs/);
  });

  it("serves sequential canonical Gmail responses and records bound authorization context", async () => {
    const harness = await createMcpFixtureHarness();
    const query = "is:unread";
    for (const threadId of ["thread-page-1", "thread-page-2"]) {
      const result = await applyScenarioSeedStep(harness.ctx, {
        type: "mcpFixture",
        provider: "google",
        resource: "gmail",
        tool: "search_threads",
        arguments: { query, pageSize: 20, view: "THREAD_VIEW_MINIMAL" },
        result: { structuredContent: { threads: [{ id: threadId }] } },
      } satisfies ScenarioSeedStep);
      expect(result).toBeUndefined();
    }

    const call = {
      name: "search_threads",
      arguments: { query, pageSize: 20, view: "THREAD_VIEW_MINIMAL" },
    };
    await expect(
      harness.engine().callTool(harness.ref(), call),
    ).resolves.toMatchObject({
      structuredContent: { threads: [{ id: "thread-page-1" }] },
    });
    await expect(
      harness.engine().callTool(harness.ref(), call),
    ).resolves.toMatchObject({
      structuredContent: { threads: [{ id: "thread-page-2" }] },
    });
    expect(harness.ctx.mcpToolCalls).toEqual([
      expect.objectContaining({
        provider: "google",
        resource: "gmail",
        tool: "search_threads",
        accountId: "google-personal",
        requiredCapability: "gmail.read",
        authorization: "authorized",
        arguments: call.arguments,
      }),
      expect.objectContaining({
        provider: "google",
        resource: "gmail",
        tool: "search_threads",
        accountId: "google-personal",
        requiredCapability: "gmail.read",
        authorization: "authorized",
        arguments: call.arguments,
      }),
    ]);
    expect(JSON.stringify(harness.ctx.mcpToolCalls)).not.toContain("token");
  });

  it("uses exactly the curated Gmail names and rejects unsupported send", async () => {
    expect(Object.keys(GOOGLE_WORKSPACE_MCP_RESOURCES.gmail.tools)).toEqual([
      "create_draft",
      "list_drafts",
      "get_thread",
      "get_message",
      "search_threads",
      "label_thread",
      "unlabel_thread",
      "list_labels",
      "label_message",
      "unlabel_message",
    ]);
    expect(GOOGLE_WORKSPACE_MCP_RESOURCES.gmail.tools).not.toHaveProperty(
      "send_email",
    );

    const harness = await createMcpFixtureHarness();
    const rejected = await applyScenarioSeedStep(harness.ctx, {
      type: "mcpFixture",
      provider: "google",
      resource: "gmail",
      tool: "send_email",
      arguments: { to: ["person@example.com"] },
      result: { structuredContent: { id: "fabricated-send" } },
    } as unknown as ScenarioSeedStep);
    expect(rejected).toMatch(/not in the curated MCP catalog/);

    await applyScenarioSeedStep(harness.ctx, {
      type: "mcpFixture",
      provider: "google",
      resource: "gmail",
      tool: "list_labels",
      result: { structuredContent: { labels: [] } },
    } satisfies ScenarioSeedStep);
    await expect(
      harness.engine().callTool(harness.ref(), {
        name: "send_email",
        arguments: {},
      }),
    ).rejects.toThrow(/rejected unsupported google\/gmail tool send_email/);
  });

  it("rejects REST-shaped arguments at the reviewed MCP fixture boundary", async () => {
    const harness = await createMcpFixtureHarness();
    const result = await applyScenarioSeedStep(harness.ctx, {
      type: "mcpFixture",
      provider: "google",
      resource: "gmail",
      tool: "get_message",
      arguments: { path: "/gmail/v1/users/me/messages/msg-1" },
      result: { structuredContent: { message: { id: "msg-1" } } },
    } as unknown as ScenarioSeedStep);
    expect(result).toMatch(/unsupported field\(s\): path/);
  });
});

describe("scenario connector seeds", () => {
  it("registers connectorStatus seeds as degraded connector contributions", async () => {
    const { ctx, runtime } = createSeedContext();
    const { getConnectorRegistry } = await loadConnectorRegistryForTest();

    const result = await applyScenarioSeedStep(ctx, {
      type: "connectorStatus",
      connector: "gmail",
      provider: "Gmail API",
      state: "missing-scope",
      capabilities: ["google.gmail.triage"],
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    } as ScenarioSeedStep);

    expect(result).toBeUndefined();
    const registry = getConnectorRegistry(runtime);
    const connector = registry?.get("gmail");
    expect(connector?.describe.label).toBe("Gmail API");
    expect(connector?.capabilities).toEqual([
      "google.gmail.triage",
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
    await expect(connector?.status()).resolves.toMatchObject({
      state: "degraded",
      message: "Gmail API seeded missing scope",
    });
  });

  it("overrides existing connector auth status and send failures", async () => {
    const { ctx, runtime } = createSeedContext();
    const {
      createConnectorRegistry,
      getConnectorRegistry,
      registerConnectorRegistry,
    } = await loadConnectorRegistryForTest();
    const base = createConnectorRegistry();
    base.register(baseConnector());
    registerConnectorRegistry(runtime, base);

    await applyScenarioSeedStep(ctx, {
      type: "connectorAuthSession",
      connector: "telegram",
      provider: "Telegram bridge",
      state: "auth-expired",
    } as ScenarioSeedStep);

    const connector = getConnectorRegistry(runtime)?.get("telegram");
    await expect(connector?.status()).resolves.toMatchObject({
      state: "disconnected",
      message: "Telegram bridge seeded auth expired",
    });
    await expect(connector?.send?.({ text: "hello" })).resolves.toMatchObject({
      ok: false,
      reason: "auth_expired",
      userActionable: true,
    });
  });

  it("limits transportFault failures before delegating to the base sender", async () => {
    const { ctx, runtime } = createSeedContext();
    const {
      createConnectorRegistry,
      getConnectorRegistry,
      registerConnectorRegistry,
    } = await loadConnectorRegistryForTest();
    const base = createConnectorRegistry();
    base.register(
      baseConnector({
        kind: "whatsapp",
        capabilities: ["whatsapp.send"],
        describe: { label: "WhatsApp bridge" },
      }),
    );
    registerConnectorRegistry(runtime, base);

    await applyScenarioSeedStep(ctx, {
      type: "transportFault",
      connector: "whatsapp",
      provider: "WhatsApp bridge",
      state: "rate-limited",
      limit: 1,
    } as ScenarioSeedStep);

    const connector = getConnectorRegistry(runtime)?.get("whatsapp");
    await expect(connector?.status()).resolves.toMatchObject({
      state: "degraded",
      message: "WhatsApp bridge seeded rate limited",
    });
    await expect(connector?.send?.({ text: "first" })).resolves.toMatchObject({
      ok: false,
      reason: "rate_limited",
      retryAfterMinutes: 5,
      userActionable: false,
    });
    await expect(connector?.send?.({ text: "second" })).resolves.toMatchObject({
      ok: true,
      messageId: "sent-1",
    });
  });
});
