/**
 * Exercises a real Eliza message loop and the production owner-reminder action
 * over a durable scheduler-backed definition, then reads it back through the
 * same production action surface. Deterministic and real-model lanes share the
 * exact world, turns, plugins, and assertions; only model selection changes.
 */

import {
  CONNECTOR_TARGET_SOURCE_REGISTRY_SERVICE,
  CORE_PLANNER_TERMINALS,
  type IAgentRuntime,
  Service,
  ServiceType,
  type UUID,
} from "@elizaos/core";
import {
  ensureLifeOpsSchedulerTask,
  LIFEOPS_TASK_NAME,
  LIFEOPS_TASK_TAGS,
  ownerRemindersAction,
  registerLifeOpsTaskWorker,
} from "@elizaos/plugin-personal-assistant";
import type { ScenarioContext } from "@elizaos/testing";
import { scenario } from "@elizaos/testing";

const request =
  "Preview a reminder for 9 AM UTC on January 2, 2099 to review the synthetic Cloud inbox. Do not save it until I confirm.";
const dueAt = "2099-01-02T09:00:00.000Z";
const tickAt = "2099-01-02T09:01:00.000Z";
const reminderArgs = {
  action: "create",
  intent: request,
  title: "Review the synthetic Cloud inbox",
  details: {
    kind: "task",
    timezone: "UTC",
    cadence: {
      kind: "once",
      dueAt,
    },
    metadata: {
      idempotencyKey: "cloud-stability-weekday-inbox",
    },
  },
};
const plannerToolNames = [
  `${ownerRemindersAction.name}_CREATE`,
  "OWNER_GOALS",
  "DISCOVER_ACTIONS",
  ...CORE_PLANNER_TERMINALS.map((tool) => tool.name),
];
const syntheticRuntimePolicy = {
  basePluginNames: [
    "@elizaos/plugin-sql",
    "scenario-agent-events",
    "assistant",
    "documents",
    "@elizaos/plugin-scheduling",
    "@elizaos/plugin-reminders",
    "@elizaos/plugin-goals",
    "@elizaos/plugin-personal-assistant/reminders-plugin",
    "core-security-hooks",
  ],
  modelPluginNames: {
    deterministic: "deterministic-model-provider",
    openai: "openai",
    anthropic: "anthropic",
  },
  allowedServiceTypes: [
    CONNECTOR_TARGET_SOURCE_REGISTRY_SERVICE,
    "CHARACTER_MANAGEMENT",
    "EXPERIENCE",
    "PERSONALITY_STORE",
    "SensitiveRequestDispatchRegistry",
    "agent_event",
    "channel_topics",
    "documents",
    "embedding-generation",
    "evaluator",
    "goals_checkin",
    "goals_migration",
    "identity_resolution",
    "lifeops_scheduled_task_runner",
    "membership",
    "memoryStorage",
    "notification",
    "optimized_prompt",
    "pii-scrub",
    "principal",
    "reminders_migration",
    "task",
    "trajectory_file_retention",
    "workflow_device_bridge",
  ],
} as const;

const cloudEffects = {
  serverId: null as number | null,
  schedulerTaskId: null as UUID | null,
  createStatus: 0,
  readStatus: 0,
  notificationPayloads: [] as Array<Record<string, unknown>>,
};
let restoreNotification: (() => void) | null = null;

const mockHeaders = {
  Authorization: "Bearer cloud-stability-mock-token",
  "Content-Type": "application/json",
};

class CloudStabilityNotificationSink extends Service {
  static override serviceType = ServiceType.NOTIFICATION;
  override capabilityDescription =
    "Scenario notification sink retaining scheduler delivery evidence.";

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<CloudStabilityNotificationSink> {
    return new CloudStabilityNotificationSink(runtime);
  }

  override async stop(): Promise<void> {}

  async notify(_input: Record<string, unknown>): Promise<{ ok: true }> {
    cloudEffects.notificationPayloads.push(structuredClone(_input));
    return { ok: true };
  }
}

interface RuntimeWithServices {
  getService?: (serviceType: string) => unknown;
  registerService?: (service: unknown) => Promise<void>;
  getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
}

async function seedCloudWorld(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  cloudEffects.serverId = null;
  cloudEffects.schedulerTaskId = null;
  cloudEffects.createStatus = 0;
  cloudEffects.readStatus = 0;
  cloudEffects.notificationPayloads = [];
  restoreNotification?.();
  restoreNotification = null;
  const hetznerUrl = process.env.CLOUD_E2E_HETZNER_URL;
  const apiUrl = process.env.CLOUD_E2E_API_URL;
  if (!hetznerUrl || !apiUrl)
    return "canonical Cloud mock URLs are unavailable";

  const health = await fetch(`${apiUrl}/api/health`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!health.ok) return `Cloud API health returned ${health.status}`;

  const create = await fetch(`${hetznerUrl}/servers`, {
    method: "POST",
    headers: mockHeaders,
    body: JSON.stringify({
      name: `stability-${ctx.runId ?? "run"}`.slice(0, 63),
      server_type: "cx22",
      location: "fsn1",
      image: "ubuntu-24.04",
    }),
    signal: AbortSignal.timeout(5_000),
  });
  cloudEffects.createStatus = create.status;
  if (create.status !== 201)
    return `Hetzner mock create returned ${create.status}`;
  const created = (await create.json()) as { server?: { id?: unknown } };
  if (!Number.isSafeInteger(created.server?.id)) {
    return "Hetzner mock create omitted its server id";
  }
  cloudEffects.serverId = created.server?.id as number;

  const runtime = ctx.runtime as RuntimeWithServices | undefined;
  const existing = runtime?.getService?.(ServiceType.NOTIFICATION) as
    | { notify?: (input: Record<string, unknown>) => Promise<unknown> }
    | null
    | undefined;
  if (!existing) {
    if (!runtime?.registerService)
      return "runtime cannot register notification sink";
    await runtime.registerService(CloudStabilityNotificationSink);
    await runtime.getServiceLoadPromise?.(ServiceType.NOTIFICATION);
  } else if (typeof existing.notify === "function") {
    const original = existing.notify.bind(existing);
    existing.notify = async (
      input: Record<string, unknown>,
    ): Promise<unknown> => {
      cloudEffects.notificationPayloads.push(structuredClone(input));
      return original(input);
    };
    restoreNotification = () => {
      existing.notify = original;
    };
  }
  if (!runtime?.getService?.(ServiceType.NOTIFICATION)) {
    return "notification sink did not start";
  }
  return undefined;
}

async function seedReminderScheduler(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as IAgentRuntime | undefined;
  if (!runtime) return "reminder scheduler runtime is unavailable";
  // Tick turns own the scenario clock. Register the production worker identity
  // without allowing wall-clock polling to race those explicit scheduler ticks.
  registerLifeOpsTaskWorker(runtime, { disabled: true });
  cloudEffects.schedulerTaskId = await ensureLifeOpsSchedulerTask(runtime);
  const tasks = await runtime.getTasks({
    agentIds: [runtime.agentId],
    tags: [...LIFEOPS_TASK_TAGS],
  });
  const schedulers = tasks.filter((task) => task.name === LIFEOPS_TASK_NAME);
  return schedulers.length === 1 &&
    schedulers[0]?.id === cloudEffects.schedulerTaskId
    ? undefined
    : "the reminder world did not seed exactly one production scheduler row";
}

async function assertReminderWake(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as IAgentRuntime | undefined;
  if (!runtime || !cloudEffects.schedulerTaskId)
    return "reminder scheduler identity was not retained";
  const task = await runtime.getTask(cloudEffects.schedulerTaskId);
  const metadata = task?.metadata;
  return task?.name === LIFEOPS_TASK_NAME &&
    Number.isSafeInteger(metadata?.wakeAt) &&
    Number.isSafeInteger(metadata?.wakeRevision) &&
    (metadata?.wakeRevision ?? 0) > 0
    ? undefined
    : "saving the reminder did not persist an atomic scheduler wake";
}

async function assertCloudReadback(): Promise<string | undefined> {
  const hetznerUrl = process.env.CLOUD_E2E_HETZNER_URL;
  if (!hetznerUrl || cloudEffects.serverId === null) {
    return "mock Cloud seed did not retain a server id";
  }
  const read = await fetch(`${hetznerUrl}/servers/${cloudEffects.serverId}`, {
    headers: mockHeaders,
    signal: AbortSignal.timeout(5_000),
  });
  cloudEffects.readStatus = read.status;
  if (read.status !== 200)
    return `Hetzner mock readback returned ${read.status}`;
  const body = (await read.json()) as {
    server?: { id?: unknown; name?: unknown };
  };
  if (body.server?.id !== cloudEffects.serverId) {
    return "Hetzner mock readback returned a different server";
  }
  if (cloudEffects.createStatus !== 201)
    return "mock Cloud create was not durable";
  if (cloudEffects.notificationPayloads.length !== 1) {
    return `expected one durable notification dispatch, saw ${cloudEffects.notificationPayloads.length}`;
  }
  const notification = cloudEffects.notificationPayloads[0];
  const timing = notification?.data as
    | { scheduledFor?: unknown; dueAt?: unknown }
    | undefined;
  if (
    notification?.category !== "reminder" ||
    notification?.source !== "lifeops" ||
    notification?.title !== "Reminder" ||
    notification?.body !== reminderArgs.title ||
    timing?.scheduledFor !== dueAt ||
    timing?.dueAt !== dueAt ||
    typeof notification?.groupKey !== "string" ||
    !notification.groupKey.startsWith("reminder:")
  ) {
    return `notification payload did not bind the scheduled reminder: ${JSON.stringify(notification)}`;
  }
  return undefined;
}

async function cleanupCloudWorld(): Promise<string | undefined> {
  const hetznerUrl = process.env.CLOUD_E2E_HETZNER_URL;
  if (!hetznerUrl || cloudEffects.serverId === null) return undefined;
  const response = await fetch(
    `${hetznerUrl}/servers/${cloudEffects.serverId}`,
    {
      method: "DELETE",
      headers: mockHeaders,
      signal: AbortSignal.timeout(5_000),
    },
  );
  restoreNotification?.();
  restoreNotification = null;
  return response.status === 200
    ? undefined
    : `Hetzner mock cleanup returned ${response.status}`;
}

const definition = scenario({
  id: "cloud-stability-agent",
  title: "Cloud synthetic agent schedules and reads back an owner reminder",
  domain: "cloud",
  lane: "pr-deterministic",
  isolation: "per-scenario",
  requires: {
    plugins: [
      "@elizaos/plugin-scheduling",
      "@elizaos/plugin-reminders",
      "@elizaos/plugin-goals",
      "@elizaos/plugin-personal-assistant/reminders-plugin",
    ],
  },
  seed: [
    {
      type: "custom",
      name: "seed Cloud API and Hetzner mock world",
      apply: seedCloudWorld,
    },
    {
      type: "custom",
      name: "seed the production reminder scheduler for the controlled clock",
      apply: seedReminderScheduler,
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "remove the synthetic Cloud server",
      apply: cleanupCloudWorld,
    },
  ],
  modelFixtures: {
    mode: "fixtures",
    fixtures: [
      {
        name: "cloud-reminder-post-turn-memory",
        match: {
          modelType: "TEXT_SMALL",
          input: {
            pattern:
              "^# Task: Post-turn evaluation[\\s\\S]*\\n## Active Evaluator(?:s| Instructions)\\n",
          },
          toolNames: [],
        },
        response: {
          json: {
            factMemory: { ops: [] },
            relationships: { relationships: [] },
            identities: { identities: [] },
            preferences: { ops: [] },
            success: {
              completed: false,
              reason: "The reminder is an unsaved draft awaiting confirmation.",
            },
            skillProposal: {
              extract: false,
              reason: "No reusable skill was demonstrated.",
            },
            skillRefinement: { refinements: [] },
            experiencePatterns: { experiences: [] },
          },
        },
        cardinality: 1,
      },
      {
        name: "cloud-reminder-stage1",
        match: {
          modelType: "RESPONSE_HANDLER",
          input: { includes: request },
          toolNames: ["HANDLE_RESPONSE"],
        },
        response: {
          json: {
            shouldRespond: "RESPOND",
            contexts: ["tasks"],
            intents: ["create reminder"],
            replyText: "I’ll preview that reminder for you to confirm.",
            replyEffectStatus: "pending",
            candidateActionNames: ["OWNER_REMINDERS"],
            facts: [],
            relationships: [],
            topics: ["reminders"],
            addressedTo: [],
            emotion: "none",
          },
        },
        cardinality: 1,
      },
      {
        name: "cloud-reminder-planner",
        match: {
          modelType: "ACTION_PLANNER",
          input: { includes: request },
          toolNames: plannerToolNames,
        },
        response: {
          text: "",
          toolCalls: [
            {
              id: "call-cloud-owner-reminder",
              name: "OWNER_REMINDERS_CREATE",
              arguments: {
                ...reminderArgs,
                createPlan: {
                  mode: "create",
                  multiStep: false,
                  requestKind: "reminder",
                  nativeProjection: "in_app_only",
                  title: reminderArgs.title,
                  description: null,
                  cadenceKind: "once",
                  dueDate: "2099-01-02",
                  dueInDays: null,
                  dueWeekday: null,
                  dueInMinutes: null,
                  timeOfDay: "09:00",
                  timeZone: "UTC",
                },
              },
            },
          ],
          finishReason: "tool-calls",
          thought: "Preview the requested owner reminder without saving it.",
          messageToUser: "I prepared the reminder preview.",
          completed: true,
        },
        cardinality: 1,
      },
      {
        name: "cloud-reminder-saved-reply",
        match: {
          modelType: "TEXT_SMALL",
          input: { includes: "Scenario: saved_definition" },
          toolNames: [],
        },
        response: {
          text: "Saved the synthetic Cloud inbox reminder for January 2, 2099 at 9 AM UTC.",
        },
        cardinality: 1,
      },
      {
        name: "cloud-reminder-review-reply",
        match: {
          modelType: "TEXT_SMALL",
          input: { includes: "Scenario: definitions_review" },
          toolNames: [],
        },
        response: {
          text: "You’re tracking the synthetic Cloud inbox reminder for January 2, 2099 at 9 AM UTC.",
        },
        cardinality: 1,
      },
      {
        name: "cloud-reminder-confirm-draft",
        match: {
          modelType: "TEXT_LARGE",
          input: {
            includes:
              "Decide how the assistant should interpret the user's follow-up to a previewed LifeOps draft",
          },
          toolNames: [],
        },
        response: { json: { mode: "confirm" } },
        cardinality: 1,
      },
      {
        name: "cloud-reminder-post-action-evaluator",
        match: {
          modelType: "RESPONSE_HANDLER",
          // The evaluator's latest user message is its current decision state;
          // the original request stays in the earlier context message.
          input: {
            pattern:
              "^# Current decision state\\n[\\s\\S]*\\nQueued call IDs: \\[\\]\\nCommitted effect receipt IDs: \\[\\]\\n[\\s\\S]*\\nrequiresReplyField: true\\nhasUnresolvedToolFailure: false\\n[\\s\\S]*\\nintent:1: create reminder\\nEvidence step sources[^\\n]*\\nstep:1: OWNER_REMINDERS_CREATE; success=false$",
          },
          toolNames: [],
        },
        response: {
          json: {
            success: false,
            decision: "FINISH",
            thought: "The reminder draft is waiting for owner confirmation.",
            messageToUser:
              "I can save this reminder for January 2, 2099 at 9 AM UTC. Confirm and I’ll save it.",
          },
        },
        cardinality: 1,
      },
    ],
  },
  rooms: [
    {
      id: "owner",
      source: "cloud-app",
      channelType: "DM",
      title: "Synthetic Cloud owner chat",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "plan and preview the one-time reminder",
      room: "owner",
      text: request,
      responseIncludesAll: ["reminder", /confirm/i],
    },
    {
      kind: "action",
      name: "confirm and persist the reminder draft",
      room: "owner",
      text: "Yes, save that reminder exactly as previewed.",
      actionName: "OWNER_REMINDERS",
      options: {
        parameters: {
          ...reminderArgs,
          confirmed: true,
        },
      },
      responseIncludesAny: ["saved", "reminder"],
    },
    {
      kind: "tick",
      name: "scheduler fires the reminder through notification delivery",
      worker: "lifeops_reminders",
      now: tickAt,
      expectedStatus: 200,
      assertResponse: (status: number, body: unknown) => {
        if (status !== 200) return `scheduler tick returned ${status}`;
        const value = body as { success?: unknown };
        return value?.success === true
          ? undefined
          : `scheduler tick did not succeed: ${JSON.stringify(body)}`;
      },
    },
    {
      kind: "action",
      name: "read the durable reminder back",
      room: "owner",
      text: "Review my reminders",
      actionName: "OWNER_REMINDERS",
      options: { parameters: { action: "review" } },
      responseIncludesAny: ["synthetic Cloud inbox", "reminder"],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "message planning previews the reminder before owner confirmation",
      predicate: (ctx: ScenarioContext) => {
        const preview = ctx.turns?.[0]?.actionsCalled.find(
          (action) => action.actionName === "OWNER_REMINDERS_CREATE",
        );
        const data = preview?.result?.data;
        return data &&
          typeof data === "object" &&
          "requiresConfirmation" in data &&
          data.requiresConfirmation === true &&
          "saved" in data &&
          data.saved === false
          ? undefined
          : "The owner message did not produce an unsaved reminder preview.";
      },
    },
    {
      type: "custom",
      name: "mock Cloud write, readback, and notification are durable",
      predicate: assertCloudReadback,
    },
    {
      type: "custom",
      name: "the reminder save persists a wake on its production scheduler",
      predicate: assertReminderWake,
    },
    {
      type: "actionCalled",
      actionName: "OWNER_REMINDERS",
      status: "success",
      minCount: 2,
    },
    {
      type: "selectedActionArguments",
      actionName: "OWNER_REMINDERS",
      includesAll: [
        /cloud-stability-weekday-inbox/,
        /review the synthetic Cloud inbox/,
      ],
    },
  ],
});

export default Object.assign(definition, {
  contract: {
    version: 1,
    id: definition.id,
    request,
    reminderArgs,
    tickAt,
    requiredPlugins: definition.requires?.plugins ?? [],
    mockCloudOperations: [
      "GET cloud-api /api/health",
      "POST hetzner /servers",
      "GET hetzner /servers/:id",
      "DELETE hetzner /servers/:id",
    ],
    durableEffects: [
      "LifeOps scheduler bootstrap",
      "OWNER_REMINDERS create",
      "atomic reminder wake",
      "scheduler notification",
      "OWNER_REMINDERS review",
    ],
    syntheticRuntimePolicy,
  },
});
