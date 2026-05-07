import { extractActionParamsViaLlm } from "@elizaos/agent/actions/extract-params";
import { hasOwnerAccess } from "@elizaos/agent/security/access";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import {
  broadcastIntent,
  LIFE_INTENT_KINDS,
  LIFE_INTENT_PRIORITIES,
  LIFE_INTENT_TARGETS,
  type LifeOpsIntentKind,
  type LifeOpsIntentPriority,
  type LifeOpsIntentTargetDevice,
} from "../lifeops/intent-sync.js";

const ACTION_NAME = "OWNER_DEVICE_INTENT";

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

function validationTerminate(
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
): ActionResult {
  return {
    text: message,
    success: false,
    values: {
      success: false,
      error,
      requiresConfirmation: true,
      ...extra,
    },
    data: {
      actionName: ACTION_NAME,
      error,
      message,
      requiresConfirmation: true,
      ...extra,
    },
  };
}

export const ownerDeviceIntentAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    "BROADCAST_INTENT",
    "DEVICE_REMINDER",
    "MOBILE_REMINDER",
    "NOTIFY_ALL_DEVICES",
  ],
  description:
    "Broadcast a structured cross-device intent (alarm, reminder, block, or custom) to the device bus so all paired devices realize it. Owner only.",
  descriptionCompressed:
    "broadcast intent paired-devices: alarm reminder block custom owner",
  suppressPostActionContinuation: true,

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> =>
    hasOwnerAccess(runtime, message),

  parameters: [
    {
      name: "kind",
      description: `Intent kind. One of: ${LIFE_INTENT_KINDS.join(", ")}.`,
      required: true,
      schema: { type: "string" as const, enum: [...LIFE_INTENT_KINDS] },
    },
    {
      name: "title",
      description: "Short intent title (shown in notification).",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "body",
      description: "Intent body text.",
      required: true,
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
  ] as ActionExample[][],

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state,
    options,
  ): Promise<ActionResult> => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return fail("PERMISSION_DENIED");
    }

    const rawParameters =
      ((options as HandlerOptions | undefined)?.parameters as
        | Record<string, unknown>
        | undefined) ?? {};
    const params = (await extractActionParamsViaLlm<Record<string, unknown>>({
      runtime,
      message,
      state,
      actionName: ACTION_NAME,
      actionDescription: ownerDeviceIntentAction.description ?? "",
      paramSchema: ownerDeviceIntentAction.parameters ?? [],
      existingParams: rawParameters,
      requiredFields: ["kind", "title", "body"],
    })) as Record<string, unknown>;

    const kindRaw = coerceString(params.kind);
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
  },
};
