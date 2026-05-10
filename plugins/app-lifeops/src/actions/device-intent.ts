import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import {
  broadcastIntent,
  type LifeOpsIntentKind,
  type LifeOpsIntentPriority,
  type LifeOpsIntentTargetDevice,
} from "../lifeops/intent-sync.js";

const ACTION_NAME = "DEVICE_INTENT";

type DeviceIntentSubaction = "broadcast";

interface DeviceIntentParams {
  subaction?: DeviceIntentSubaction | string;
  kind?: LifeOpsIntentKind | string;
  target?: LifeOpsIntentTargetDevice | string;
  targetDeviceId?: string;
  title?: string;
  body?: string;
  actionUrl?: string;
  priority?: LifeOpsIntentPriority | string;
  expiresInMinutes?: number;
}

function messageText(message: Memory): string {
  return typeof message.content?.text === "string" ? message.content.text : "";
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeTarget(
  value: unknown,
  text: string,
): LifeOpsIntentTargetDevice {
  const explicit = stringParam(value)?.toLowerCase();
  if (explicit === "mobile" || explicit === "phone") return "mobile";
  if (explicit === "desktop" || explicit === "computer") return "desktop";
  if (explicit === "specific") return "specific";
  if (explicit === "all") return "all";
  if (/\b(?:mobile|phone)\b/iu.test(text)) return "mobile";
  if (/\b(?:desktop|computer|mac)\b/iu.test(text)) return "desktop";
  return "all";
}

function normalizeKind(value: unknown, text: string): LifeOpsIntentKind {
  const explicit = stringParam(value)?.toLowerCase();
  if (explicit === "routine_reminder") return "routine_reminder";
  if (explicit === "attention_request") return "attention_request";
  if (explicit === "state_sync") return "state_sync";
  if (/\broutine\b/iu.test(text)) return "routine_reminder";
  return "user_action_requested";
}

function normalizePriority(value: unknown): LifeOpsIntentPriority {
  const explicit = stringParam(value)?.toLowerCase();
  if (
    explicit === "low" ||
    explicit === "medium" ||
    explicit === "high" ||
    explicit === "urgent"
  ) {
    return explicit;
  }
  return "medium";
}

function inferQuoted(text: string, label: string): string | undefined {
  const pattern = new RegExp(`${label}\\s+['"]([^'"]+)['"]`, "iu");
  return pattern.exec(text)?.[1]?.trim();
}

function inferTitle(params: DeviceIntentParams, text: string): string {
  return (
    stringParam(params.title) ??
    inferQuoted(text, "titled") ??
    "Device reminder"
  );
}

function inferBody(params: DeviceIntentParams, text: string): string {
  return (
    stringParam(params.body) ??
    inferQuoted(text, "saying") ??
    stringParam(text.replace(/^broadcast\s+/iu, "")) ??
    "Reminder"
  );
}

export const deviceIntentAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    "BROADCAST_INTENT",
    "BROADCAST_REMINDER",
    "DEVICE_BROADCAST",
    "MOBILE_REMINDER",
    "INTENT_SYNC",
  ],
  description:
    "Owner-only cross-device intent broadcast. Use for requests to broadcast a reminder or routine reminder to all devices, mobile, desktop, or a specific device.",
  descriptionCompressed:
    "broadcast device intent/reminder: target all|mobile|desktop|specific title body kind routine_reminder|user_action_requested",
  contexts: ["automation", "connectors", "tasks", "settings"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: async () => true,
  parameters: [
    {
      name: "subaction",
      description: "Only supported subaction: broadcast.",
      descriptionCompressed: "op: broadcast",
      required: false,
      schema: { type: "string" as const, enum: ["broadcast"] },
    },
    {
      name: "kind",
      description:
        "Intent kind: user_action_requested, routine_reminder, attention_request, or state_sync.",
      descriptionCompressed:
        "kind: user_action_requested|routine_reminder|attention_request|state_sync",
      required: false,
      schema: {
        type: "string" as const,
        enum: [
          "user_action_requested",
          "routine_reminder",
          "attention_request",
          "state_sync",
        ],
      },
    },
    {
      name: "target",
      description: "Target device group: all, mobile, desktop, or specific.",
      descriptionCompressed: "target: all|mobile|desktop|specific",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["all", "mobile", "desktop", "specific"],
      },
      examples: ["mobile", "all"],
    },
    {
      name: "targetDeviceId",
      description: "Specific device id when target=specific.",
      descriptionCompressed: "device id when target=specific",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "title",
      description: "Short notification title.",
      descriptionCompressed: "notification title",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "body",
      description: "Notification body.",
      descriptionCompressed: "notification body",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "priority",
      description: "Notification priority: low, medium, high, urgent.",
      descriptionCompressed: "priority: low|medium|high|urgent (default medium)",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["low", "medium", "high", "urgent"],
      },
    },
    {
      name: "expiresInMinutes",
      description:
        "Optional auto-expire window in minutes (intent stops broadcasting after this).",
      descriptionCompressed: "expires-in mins optional",
      required: false,
      schema: { type: "number" as const, minimum: 1 },
    },
    {
      name: "actionUrl",
      description:
        "Optional deep link / URL the notification should open when tapped.",
      descriptionCompressed: "deep-link URL on tap",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options: HandlerOptions | undefined,
    callback: HandlerCallback | undefined,
  ): Promise<ActionResult> => {
    const params = (options?.parameters ?? {}) as DeviceIntentParams;
    const text = messageText(message);
    const target = normalizeTarget(params.target, text);
    const intent = await broadcastIntent(runtime, {
      kind: normalizeKind(params.kind, text),
      target,
      ...(target === "specific" && params.targetDeviceId
        ? { targetDeviceId: params.targetDeviceId }
        : {}),
      title: inferTitle(params, text),
      body: inferBody(params, text),
      ...(stringParam(params.actionUrl) ? { actionUrl: params.actionUrl } : {}),
      priority: normalizePriority(params.priority),
      ...(typeof params.expiresInMinutes === "number"
        ? { expiresInMinutes: params.expiresInMinutes }
        : {}),
      metadata: {
        source: ACTION_NAME,
        originalText: text,
      },
    });

    const response = `Broadcast "${intent.title}" to ${intent.target}.`;
    await callback?.({ text: response, source: "action", action: ACTION_NAME });
    return {
      success: true,
      text: response,
      data: {
        actionName: ACTION_NAME,
        subaction: "broadcast",
        intent,
      },
    };
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Send a reminder to my phone titled 'Take meds' saying 'Time for evening meds'.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Broadcast "Take meds" to mobile.',
          actions: ["DEVICE_INTENT"],
          thought:
            "Owner asked for a phone-targeted notification; DEVICE_INTENT subaction=broadcast with target=mobile, title and body extracted from quotes.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Broadcast a routine reminder to all my devices: stretch break.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Broadcast "Device reminder" to all.',
          actions: ["DEVICE_INTENT"],
          thought:
            "Cross-device routine maps to DEVICE_INTENT subaction=broadcast with target=all and kind=routine_reminder.",
        },
      },
    ],
  ],
};
