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
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "kind",
      description:
        "Intent kind: user_action_requested, routine_reminder, attention_request, or state_sync.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "target",
      description: "Target device group: all, mobile, desktop, or specific.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "targetDeviceId",
      description: "Specific device id when target=specific.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "title",
      description: "Short notification title.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "body",
      description: "Notification body.",
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
};
