import {
  logger,
  type Action,
  type ActionExample,
  type ActionResult,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import { hasOwnerAccess } from "@elizaos/agent/security/access";
import { broadcastIntent } from "../lifeops/intent-sync.js";

/**
 * Cross-device intent bus agent-side action.
 *
 * Publishes an intent (alarm, reminder, block, ...) to the cloud device-bus
 * service so that every paired device for this owner can realize it.
 *
 * Graceful degradation: if the cloud URL is not configured we return a
 * structured failure — this is not a stub, it is an explicit absence.
 */

const DEVICE_BUS_URL_ENV = "MILADY_DEVICE_BUS_URL";
const DEVICE_BUS_TOKEN_ENV = "MILADY_DEVICE_BUS_TOKEN";

const KNOWN_KINDS = ["alarm", "reminder", "block"] as const;
type KnownKind = (typeof KNOWN_KINDS)[number];

type PublishDeviceIntentParameters = {
  kind?: string;
  payload?: unknown;
  userId?: string;
};

type DeviceIntentPayload = Record<string, unknown>;

function readDeviceBusConfig(
  runtime: { getSetting?: (key: string) => unknown } | undefined,
): { url: string; token: string | null } | null {
  const readString = (key: string): string | null => {
    const env = process.env[key]?.trim();
    if (env) return env;
    const setting = runtime?.getSetting?.(key);
    return typeof setting === "string" && setting.trim().length > 0
      ? setting.trim()
      : null;
  };
  const url = readString(DEVICE_BUS_URL_ENV);
  if (!url) return null;
  const token = readString(DEVICE_BUS_TOKEN_ENV);
  return { url, token };
}

function normalizeKind(kind: string | undefined): KnownKind | string | null {
  if (typeof kind !== "string") return null;
  const trimmed = kind.trim();
  if (trimmed.length === 0) return null;
  const lower = trimmed.toLowerCase();
  if ((KNOWN_KINDS as readonly string[]).includes(lower)) {
    return lower as KnownKind;
  }
  return lower;
}

function coercePayload(
  payload: unknown,
): DeviceIntentPayload {
  return payload && typeof payload === "object"
    ? (payload as DeviceIntentPayload)
    : {};
}

function readPayloadString(
  payload: DeviceIntentPayload,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function readPayloadNumber(
  payload: DeviceIntentPayload,
  keys: string[],
): number | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function mapLocalIntentKind(kind: string): "routine_reminder" | "attention_request" {
  if (kind === "block") {
    return "attention_request";
  }
  return "routine_reminder";
}

async function publishLocalFallbackIntent(args: {
  runtime: IAgentRuntime;
  kind: string;
  payload: DeviceIntentPayload;
  userId?: string;
}): Promise<ActionResult> {
  const title =
    readPayloadString(args.payload, ["title", "label", "name", "subject"]) ??
    (args.kind === "alarm"
      ? "Device alarm"
      : args.kind === "block"
        ? "Device warning"
        : "Device reminder");
  const body =
    readPayloadString(args.payload, [
      "body",
      "message",
      "text",
      "description",
      "summary",
    ]) ?? title;
  const actionUrl =
    readPayloadString(args.payload, ["actionUrl", "url", "deepLink"]) ?? undefined;
  const expiresInMinutes = readPayloadNumber(args.payload, [
    "expiresInMinutes",
    "durationMinutes",
  ]);

  const intent = await broadcastIntent(args.runtime, {
    kind: mapLocalIntentKind(args.kind),
    target: "all",
    title,
    body,
    actionUrl,
    priority: "high",
    expiresInMinutes:
      expiresInMinutes !== null && expiresInMinutes > 0
        ? Math.round(expiresInMinutes)
        : undefined,
    metadata: {
      transport: "local-fallback",
      originalKind: args.kind,
      payload: args.payload,
      userId: args.userId ?? null,
    },
  });

  return {
    text: `Queued ${args.kind} intent locally.`,
    success: true,
    values: {
      success: true,
      kind: args.kind,
      intentId: intent.id,
      transport: "local-fallback",
    },
    data: {
      actionName: "PUBLISH_DEVICE_INTENT",
      kind: args.kind,
      intentId: intent.id,
      transport: "local-fallback",
      payload: args.payload,
    },
  };
}

export const publishDeviceIntentAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "PUBLISH_DEVICE_INTENT",
  similes: [
    "BROADCAST_DEVICE_INTENT",
    "FIRE_DEVICE_INTENT",
    "NOTIFY_ALL_DEVICES",
    "BROADCAST_REMINDER",
    "ROUTINE_REMINDER_TO_PHONE",
    "MOBILE_REMINDER",
    "SIGNATURE_REMINDER",
    "MEETING_REMINDER_LADDER",
    "DEVICE_WARNING",
    "UPDATED_ID_COPY",
    "UPDATED_ID_INTERVENTION",
    "CANCELLATION_FEE_WARNING",
  ],
  tags: [
    "always-include",
    "device reminder",
    "broadcast reminder",
    "mobile reminder",
    "routine reminder",
    "notify my phone",
    "meeting reminder ladder",
    "signature reminder",
    "cancellation fee warning",
    "workflow escalation",
    "updated id copy",
    "cancellation fee warning",
    "expired id reminder",
  ],
  description:
    "Publish a cross-device intent (alarm, reminder, block, or custom) to the device bus so all paired devices can realize it. Use this for desktop+phone reminder ladders, multi-device meeting nudges, document-signing reminders, updated-ID interventions, cancellation-fee warnings, and urgent device-level escalation where the owner wants the same intent realized across paired devices. Standing 'if/when this happens, warn or remind me on my devices' policies should still use this action on the first turn, even when the exact reservation, workflow, or event still needs a follow-up question. Do not use this for generic contextual bumps about unanswered events, group-chat handoff policies, or inbox coordination unless the owner explicitly asks for phone/desktop/mobile delivery; those belong to OWNER_INBOX or LIFE. Do not use this for scheduling preferences like protected sleep windows or no-call meeting hours; those belong to OWNER_CALENDAR.",
  suppressPostActionContinuation: true,

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    return hasOwnerAccess(runtime, message);
  },

  handler: async (runtime, message, _state, options): Promise<ActionResult> => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        text: "",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: {
          actionName: "PUBLISH_DEVICE_INTENT",
          error: "PERMISSION_DENIED",
        },
      };
    }

    const params =
      ((options as HandlerOptions | undefined)?.parameters as
        | PublishDeviceIntentParameters
        | undefined) ?? {};

    const kind = normalizeKind(params.kind) ?? "reminder";

    const payload = coercePayload(params.payload);

    const config = readDeviceBusConfig(runtime);
    if (!config) {
      logger.info(
        { action: "PUBLISH_DEVICE_INTENT", kind },
        "[PUBLISH_DEVICE_INTENT] device bus not configured; falling back to local intent store",
      );
      return publishLocalFallbackIntent({
        runtime,
        kind,
        payload,
        userId: typeof params.userId === "string" ? params.userId : undefined,
      });
    }

    const body = {
      kind,
      payload,
      userId: typeof params.userId === "string" ? params.userId : undefined,
    };

    const endpoint = `${config.url.replace(/\/$/, "")}/api/v1/device-bus/intents`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      logger.warn(
        {
          action: "PUBLISH_DEVICE_INTENT",
          kind,
          status: response.status,
        },
        `[PUBLISH_DEVICE_INTENT] cloud rejected intent: ${text.slice(0, 200)}`,
      );
      return {
        text: "",
        success: false,
        values: {
          success: false,
          error: "DEVICE_BUS_PUBLISH_FAILED",
          status: response.status,
        },
        data: {
          actionName: "PUBLISH_DEVICE_INTENT",
          error: "DEVICE_BUS_PUBLISH_FAILED",
          status: response.status,
          detail: text.slice(0, 500),
        },
      };
    }

    const data = (await response.json().catch(() => ({}))) as {
      intentId?: string;
      deliveredTo?: string[];
    };

    return {
      text: buildIntentResultText("Published", kind, payload),
      success: true,
      values: {
        success: true,
        kind,
        intentId: data.intentId ?? null,
      },
      data: {
        actionName: "PUBLISH_DEVICE_INTENT",
        kind,
        intentId: data.intentId ?? null,
        deliveredTo: data.deliveredTo ?? [],
        payload,
      },
    };
  },

  parameters: [
    {
      name: "kind",
      description:
        "Intent kind. Standard values: alarm, reminder, block. Custom string values accepted.",
      schema: { type: "string" as const },
    },
    {
      name: "payload",
      description:
        "Opaque JSON payload describing the intent (time, label, duration, url, etc.).",
      schema: { type: "object" as const },
    },
    {
      name: "userId",
      description:
        "Override which user's paired devices should receive the intent. Defaults to the owner.",
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "The clinic sent docs for me to sign before the appointment. Keep me on top of that.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll publish a reminder intent so your paired devices keep nudging you to sign the clinic documents before the appointment.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "For important meetings, remind me an hour before, ten minutes before, and right when they start on both my Mac and my phone.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll publish a multi-device reminder ladder for important meetings across your Mac and phone.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "If missing this could trigger a cancellation fee, warn me clearly and offer to handle it now.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll publish a device-level warning so you get a clear escalation before the cancellation-fee window closes.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "If the only ID on file is expired, ask me for an updated copy so the workflow can continue.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll publish a reminder and intervention nudge so you get asked for an updated ID copy when the workflow is blocked by an expired one.",
        },
      },
    ],
  ] as ActionExample[][],
};

// Exposed for tests.
export const __internal = {
  readDeviceBusConfig,
  normalizeKind,
};
