import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { hasAdminAccess } from "@elizaos/agent/security/access";
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

// Validation terminates the turn cleanly: success: true at the ActionResult
// level (so the orchestrator does not retry), but values.success: false so
// downstream consumers see the logical failure. Carries descriptive text.
function validationTerminate(
  error: string,
  text: string,
  extra: Record<string, unknown> = {},
): ActionResult {
  return {
    text,
    success: true,
    values: { success: false, error, ...extra },
    data: { actionName: ACTION_NAME, error, ...extra },
  };
}

// Parse flat key=value params that arrive as a raw string instead of nested
// XML/JSON. Handles quoted and unquoted values.
function parseFlatParams(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

// Tolerate a wider shape: if `params` is a string (or carries a rawParams
// blob), attempt flat parsing and merge into a typed object.
function normalizeParams(
  raw: unknown,
): IntentSyncParameters & Record<string, unknown> {
  if (typeof raw === "string") {
    return parseFlatParams(raw);
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...obj };
    const rawParams = obj.rawParams ?? obj.raw;
    if (typeof rawParams === "string") {
      const parsed = parseFlatParams(rawParams);
      for (const [k, v] of Object.entries(parsed)) {
        if (merged[k] === undefined) merged[k] = v;
      }
    }
    return merged as IntentSyncParameters & Record<string, unknown>;
  }
  return {} as IntentSyncParameters & Record<string, unknown>;
}

function inferSubactionFromText(text: string): Subaction | undefined {
  const t = text.toLowerCase();
  if (/\b(broadcast|send|publish|push|ping)\b/.test(t)) return "broadcast";
  if (/\b(list|show|what.*pending)\b/.test(t)) return "list_pending";
  if (/\b(acknowledge|ack|mark\s+done)\b/.test(t)) return "acknowledge";
  if (/\b(prune|expire|clean)\b/.test(t)) return "prune_expired";
  return undefined;
}

function inferKindFromText(text: string): LifeOpsIntentKind | undefined {
  const t = text.toLowerCase();
  if (/\b(reminder|stretch|break|vitamin|hydrate|water|walk)\b/.test(t)) {
    if (isKind("routine_reminder")) return "routine_reminder" as LifeOpsIntentKind;
  }
  if (/\b(urgent|help|need)\b/.test(t)) {
    if (isKind("attention_request")) return "attention_request" as LifeOpsIntentKind;
  }
  if (/\b(request|ask|please)\b/.test(t)) {
    if (isKind("user_action_requested")) {
      return "user_action_requested" as LifeOpsIntentKind;
    }
  }
  return undefined;
}

export const intentSyncAction: Action = {
  name: ACTION_NAME,
  similes: [
    "BROADCAST_INTENT",
    "SYNC_INTENT",
    "CROSS_DEVICE_INTENT",
    "BROADCAST_TO_DEVICE",
    "PUSH_TO_MOBILE",
    "PUSH_TO_PHONE",
    "PUSH_TO_DESKTOP",
    "ROUTINE_REMINDER",
    "DEVICE_REMINDER",
    "SEND_TO_DEVICE",
  ],
  description:
    "Broadcast a structured device-level intent (routine_reminder, location_alert, " +
    "task_nudge, focus_prompt, calendar_event, habit_check, etc.) to one or more " +
    "of the owner's devices (mobile, desktop, watch, all, or a specific device id), " +
    "or acknowledge/list/prune pending intents. Subactions: broadcast, list_pending, " +
    "acknowledge, prune_expired. " +
    "Use this for any 'broadcast/push/send <intent> to my phone/mobile/desktop/devices' " +
    "request, or 'remind me on my phone to X' — the target is a device, not a chat " +
    "channel. Do NOT use CROSS_CHANNEL_SEND for device-targeted reminders: " +
    "CROSS_CHANNEL_SEND is for sending chat messages to another person on a " +
    "messaging platform (email/discord/telegram/signal/etc.), while INTENT_SYNC " +
    "pushes a structured intent record to the owner's own devices.",

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

    const rawParams = (options as HandlerOptions | undefined)?.parameters;
    const params = normalizeParams(rawParams);
    const messageText =
      typeof message.content?.text === "string" ? message.content.text : "";

    let subactionRaw = coerceString(params.subaction);
    if (!subactionRaw) {
      // Tolerate LLMs that emit the verb in `intent` / `mode` / plain text.
      subactionRaw =
        coerceString((params as Record<string, unknown>).mode) ??
        coerceString((params as Record<string, unknown>).action) ??
        inferSubactionFromText(messageText);
    }
    if (!subactionRaw) {
      return validationTerminate(
        "MISSING_SUBACTION",
        "I couldn't tell whether you wanted to broadcast, list, acknowledge, or prune an intent. Please say which.",
      );
    }
    if (!isSubaction(subactionRaw)) {
      return validationTerminate(
        "UNKNOWN_SUBACTION",
        `Unknown INTENT_SYNC subaction "${subactionRaw}". Expected one of: ${SUBACTIONS.join(", ")}.`,
        { subaction: subactionRaw },
      );
    }
    const subaction: Subaction = subactionRaw;

    if (subaction === "broadcast") {
      let kindRaw = coerceString(params.kind);
      if (!kindRaw || !isKind(kindRaw)) {
        // Only infer when the current value is clearly wrong/missing — not
        // when it's already a valid kind.
        const inferred = inferKindFromText(messageText);
        if (inferred) kindRaw = inferred;
      }
      const title = coerceString(params.title);
      const body = coerceString(params.body);
      if (!kindRaw) {
        return validationTerminate(
          "MISSING_KIND",
          `I need an intent kind to broadcast (one of: ${LIFE_INTENT_KINDS.join(", ")}).`,
        );
      }
      if (!isKind(kindRaw)) {
        return validationTerminate(
          "UNKNOWN_KIND",
          `Unknown intent kind "${kindRaw}". Expected one of: ${LIFE_INTENT_KINDS.join(", ")}.`,
          { kind: kindRaw },
        );
      }
      if (!title) {
        return validationTerminate(
          "MISSING_TITLE",
          "I need a short title for the intent before I can broadcast it.",
        );
      }
      if (!body) {
        return validationTerminate(
          "MISSING_BODY",
          "I need a body for the intent before I can broadcast it.",
        );
      }

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
