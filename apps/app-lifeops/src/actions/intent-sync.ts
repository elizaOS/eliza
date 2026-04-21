import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { hasAdminAccess } from "@elizaos/agent";
import {
  LIFE_INTENT_KINDS,
  LIFE_INTENT_PRIORITIES,
  LIFE_INTENT_TARGETS,
  acknowledgeIntent,
  broadcastIntent,
  pruneExpiredIntents,
  receivePendingIntents,
  type LifeOpsIntentKind,
  type LifeOpsIntentPriority,
  type LifeOpsIntentTargetDevice,
} from "../lifeops/intent-sync.js";

const ACTION_NAME = "INTENT_SYNC";

const SUBACTIONS = [
  "broadcast",
  "list_pending",
  "acknowledge",
  "prune_expired",
] as const;
type Subaction = (typeof SUBACTIONS)[number];

type IntentSyncParameters = {
  subaction?: string;
  intent?: string;
  kind?: string;
  title?: string;
  body?: string;
  target?: string;
  priority?: string;
  intentId?: string;
  deviceId?: string;
  expiresInMinutes?: number;
  targetDeviceId?: string;
  actionUrl?: string;
};

function coerceString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isSubaction(value: string): value is Subaction {
  return (SUBACTIONS as readonly string[]).includes(value);
}

function isKind(value: string): value is LifeOpsIntentKind {
  return (LIFE_INTENT_KINDS as readonly string[]).includes(value);
}

function isTarget(value: string): value is LifeOpsIntentTargetDevice {
  return (LIFE_INTENT_TARGETS as readonly string[]).includes(value);
}

function isPriority(value: string): value is LifeOpsIntentPriority {
  return (LIFE_INTENT_PRIORITIES as readonly string[]).includes(value);
}

function fail(
  error: string,
  extra: Record<string, unknown> = {},
): ActionResult {
  return {
    text: "",
    success: false,
    values: { success: false, error, ...extra },
    data: { actionName: ACTION_NAME, error, ...extra },
  };
}

export const intentSyncAction: Action = {
  name: ACTION_NAME,
  similes: ["BROADCAST_INTENT", "SYNC_INTENT", "CROSS_DEVICE_INTENT"],
  description:
    "Broadcast intents across devices or acknowledge pending intents. " +
    "Subactions: broadcast, list_pending, acknowledge, prune_expired.",

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> =>
    hasAdminAccess(runtime, message),

  parameters: [
    {
      name: "subaction",
      description: `Which operation to perform. One of: ${SUBACTIONS.join(", ")}.`,
      required: true,
      schema: { type: "string" as const, enum: [...SUBACTIONS] },
    },
    {
      name: "intent",
      description: "User-phrased intent summary (optional, for logging).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "kind",
      description: `Intent kind. One of: ${LIFE_INTENT_KINDS.join(", ")}.`,
      required: false,
      schema: { type: "string" as const, enum: [...LIFE_INTENT_KINDS] },
    },
    {
      name: "title",
      description: "Short intent title (shown in notification).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "body",
      description: "Intent body text.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "target",
      description: `Target device class. One of: ${LIFE_INTENT_TARGETS.join(", ")}. Defaults to "all".`,
      required: false,
      schema: { type: "string" as const, enum: [...LIFE_INTENT_TARGETS] },
    },
    {
      name: "targetDeviceId",
      description: "Specific device id when target = 'specific'.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "actionUrl",
      description: "Deep link URL for mobile follow-up.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "priority",
      description: `Priority. One of: ${LIFE_INTENT_PRIORITIES.join(", ")}. Defaults to "medium".`,
      required: false,
      schema: { type: "string" as const, enum: [...LIFE_INTENT_PRIORITIES] },
    },
    {
      name: "intentId",
      description: "Intent id to acknowledge.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "deviceId",
      description:
        "Device id performing the acknowledgement, or requesting pending intents.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "expiresInMinutes",
      description: "Expire the intent after this many minutes.",
      required: false,
      schema: { type: "number" as const },
    },
  ],

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Ping my phone to take out the trash" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Broadcasting routine_reminder intent to mobile.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "What intents are pending on this desktop?" },
      },
      {
        name: "{{agentName}}",
        content: { text: "Listing pending intents for desktop..." },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Acknowledge intent abc-123 from this device" },
      },
      {
        name: "{{agentName}}",
        content: { text: "Marked intent abc-123 acknowledged." },
      },
    ],
  ] as ActionExample[][],

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
  ): Promise<ActionResult> => {
    if (!(await hasAdminAccess(runtime, message))) {
      return fail("PERMISSION_DENIED");
    }

    const params =
      ((options as HandlerOptions | undefined)?.parameters as
        | IntentSyncParameters
        | undefined) ?? {};

    const subactionRaw = coerceString(params.subaction);
    if (!subactionRaw) return fail("MISSING_SUBACTION");
    if (!isSubaction(subactionRaw)) {
      return fail("UNKNOWN_SUBACTION", { subaction: subactionRaw });
    }
    const subaction: Subaction = subactionRaw;

    if (subaction === "broadcast") {
      const kindRaw = coerceString(params.kind);
      const title = coerceString(params.title);
      const body = coerceString(params.body);
      if (!kindRaw) return fail("MISSING_KIND");
      if (!isKind(kindRaw)) return fail("UNKNOWN_KIND", { kind: kindRaw });
      if (!title) return fail("MISSING_TITLE");
      if (!body) return fail("MISSING_BODY");

      const targetRaw = coerceString(params.target) ?? "all";
      if (!isTarget(targetRaw)) {
        return fail("UNKNOWN_TARGET", { target: targetRaw });
      }
      const priorityRaw = coerceString(params.priority) ?? "medium";
      if (!isPriority(priorityRaw)) {
        return fail("UNKNOWN_PRIORITY", { priority: priorityRaw });
      }

      const targetDeviceId = coerceString(params.targetDeviceId);
      if (targetRaw === "specific" && !targetDeviceId) {
        return fail("MISSING_TARGET_DEVICE_ID");
      }

      const intent = await broadcastIntent(runtime, {
        kind: kindRaw,
        target: targetRaw,
        targetDeviceId,
        title,
        body,
        actionUrl: coerceString(params.actionUrl),
        priority: priorityRaw,
        expiresInMinutes: coerceNumber(params.expiresInMinutes),
      });

      return {
        text: `Broadcast ${intent.kind} intent "${intent.title}" to ${intent.target}.`,
        success: true,
        values: { success: true, intentId: intent.id, kind: intent.kind },
        data: { actionName: ACTION_NAME, intent },
      };
    }

    if (subaction === "list_pending") {
      const deviceRaw = coerceString(params.target);
      let device: LifeOpsIntentTargetDevice | undefined;
      if (deviceRaw !== undefined) {
        if (!isTarget(deviceRaw)) {
          return fail("UNKNOWN_TARGET", { target: deviceRaw });
        }
        device = deviceRaw;
      }
      const deviceId = coerceString(params.deviceId);
      const intents = await receivePendingIntents(runtime, {
        device,
        deviceId,
      });
      return {
        text: `Found ${intents.length} pending intent(s).`,
        success: true,
        values: { success: true, count: intents.length },
        data: { actionName: ACTION_NAME, intents },
      };
    }

    if (subaction === "acknowledge") {
      const intentId = coerceString(params.intentId);
      const deviceId = coerceString(params.deviceId);
      if (!intentId) return fail("MISSING_INTENT_ID");
      if (!deviceId) return fail("MISSING_DEVICE_ID");
      await acknowledgeIntent(runtime, intentId, deviceId);
      return {
        text: `Acknowledged intent ${intentId}.`,
        success: true,
        values: { success: true, intentId, deviceId },
        data: { actionName: ACTION_NAME, intentId, deviceId },
      };
    }

    // prune_expired
    const { pruned } = await pruneExpiredIntents(runtime);
    return {
      text: `Pruned ${pruned} expired intent(s).`,
      success: true,
      values: { success: true, pruned },
      data: { actionName: ACTION_NAME, pruned },
    };
  },
};
