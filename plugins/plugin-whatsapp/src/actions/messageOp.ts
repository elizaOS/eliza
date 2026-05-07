import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { composePromptFromState, ModelType } from "@elizaos/core";

export const WHATSAPP_MESSAGE_OP_ACTION = "WHATSAPP_MESSAGE_OP";

type WhatsAppOp = "send" | "react";

interface WhatsAppOpParams {
  op: WhatsAppOp;
  to?: string;
  text?: string;
  messageId?: string;
  emoji?: string;
}

const MESSAGE_OP_TEMPLATE = `# Task: Extract WhatsApp message op parameters.

The user wants to perform a WhatsApp message operation. Choose one of:
- send: send a text message (requires "to" and "text")
- react: react to a message with an emoji (requires "messageId" and "emoji")

Recent conversation:
{{recentMessages}}

Respond with JSON only. Return exactly one JSON object matching one of these examples:
{"op":"send","to":"+14155552671","text":"Hello from WhatsApp!"}
{"op":"react","messageId":"wamid.xxx","emoji":"👍"}`;

function isWhatsAppOp(value: unknown): value is WhatsAppOp {
  return value === "send" || value === "react";
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value.trim()) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readParams(options?: HandlerOptions | unknown): Record<string, unknown> {
  const direct = options && typeof options === "object" ? (options as Record<string, unknown>) : {};
  const parameters =
    direct.parameters && typeof direct.parameters === "object"
      ? (direct.parameters as Record<string, unknown>)
      : {};
  return { ...direct, ...parameters };
}

function normalizeParams(params: Record<string, unknown>): WhatsAppOpParams | null {
  if (!isWhatsAppOp(params.op)) {
    return null;
  }

  return {
    op: params.op,
    to: params.to ? String(params.to) : undefined,
    text: params.text ? String(params.text) : undefined,
    messageId: params.messageId ? String(params.messageId) : undefined,
    emoji: params.emoji ? String(params.emoji) : undefined,
  };
}

interface WhatsAppCredentials {
  accessToken: string;
  phoneNumberId: string;
  apiVersion: string;
}

function readCredentials(runtime: IAgentRuntime): WhatsAppCredentials | null {
  const accessToken = runtime.getSetting("WHATSAPP_ACCESS_TOKEN") as string;
  const phoneNumberId = runtime.getSetting("WHATSAPP_PHONE_NUMBER_ID") as string;
  if (!accessToken || !phoneNumberId) return null;
  const apiVersion = (runtime.getSetting("WHATSAPP_API_VERSION") as string) || "v24.0";
  return { accessToken, phoneNumberId, apiVersion };
}

async function postToWhatsApp(
  creds: WhatsAppCredentials,
  payload: Record<string, unknown>
): Promise<{ messages?: Array<{ id: string }> }> {
  const url = `https://graph.facebook.com/${creds.apiVersion}/${creds.phoneNumberId}/messages`;
  // @duplicate-component-audit-allow WhatsApp Graph messages API is not an LLM generation call.
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const errorData = (await response.json()) as { error?: { message?: string } };
    throw new Error(errorData.error?.message || `HTTP ${response.status}`);
  }
  return response.json() as Promise<{ messages?: Array<{ id: string }> }>;
}

async function handleSend(
  _runtime: IAgentRuntime,
  message: Memory,
  state: State,
  params: WhatsAppOpParams,
  creds: WhatsAppCredentials,
  callback?: HandlerCallback
): Promise<ActionResult> {
  let to = params.to;
  let text = params.text;
  if (!to) {
    to = message.content?.from as string;
  }
  if (!text?.trim()) {
    text = state.values?.response?.toString() || "";
  }
  if (!to) {
    if (callback) {
      await callback({ text: "Could not determine who to send the message to" });
    }
    return { success: false, error: "Missing recipient" };
  }
  if (!text?.trim()) {
    if (callback) {
      await callback({ text: "Cannot send an empty message. Please provide message content." });
    }
    return { success: false, error: "Empty message text" };
  }

  try {
    const data = await postToWhatsApp(creds, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: text },
    });
    const messageId = data.messages?.[0]?.id;
    return {
      success: true,
      data: {
        action: WHATSAPP_MESSAGE_OP_ACTION,
        op: "send",
        to,
        messageId,
        suppressVisibleCallback: true,
        suppressActionResultClipboard: true,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (callback) {
      await callback({ text: `Failed to send WhatsApp message: ${errorMessage}` });
    }
    return { success: false, error: errorMessage };
  }
}

async function handleReact(
  message: Memory,
  params: WhatsAppOpParams,
  creds: WhatsAppCredentials,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const messageId = params.messageId ?? (message.content?.messageId as string | undefined);
  const emoji = params.emoji?.trim() ? params.emoji : "👍";
  if (!messageId) {
    if (callback) {
      await callback({ text: "Could not determine which message to react to" });
    }
    return { success: false, error: "Missing message ID" };
  }
  const to = message.content?.from as string;
  if (!to) {
    if (callback) {
      await callback({ text: "Could not determine the recipient for the reaction" });
    }
    return { success: false, error: "Missing recipient" };
  }

  try {
    await postToWhatsApp(creds, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "reaction",
      reaction: { message_id: messageId, emoji },
    });
    return {
      success: true,
      data: {
        action: WHATSAPP_MESSAGE_OP_ACTION,
        op: "react",
        messageId,
        emoji,
        suppressVisibleCallback: true,
        suppressActionResultClipboard: true,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (callback) {
      await callback({ text: `Failed to send reaction: ${errorMessage}` });
    }
    return { success: false, error: errorMessage };
  }
}

export const messageOpAction: Action = {
  name: WHATSAPP_MESSAGE_OP_ACTION,
  similes: [
    "WHATSAPP_SEND_MESSAGE",
    "WHATSAPP_SEND_REACTION",
    "SEND_WHATSAPP",
    "WHATSAPP_MESSAGE",
    "WHATSAPP_REACT",
    "REACT_WHATSAPP",
  ],
  description: "WhatsApp message operations (send, react).",
  descriptionCompressed: "WhatsApp message ops: send, react.",
  suppressPostActionContinuation: true,

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions
  ): Promise<boolean> => {
    const text = message.content?.text?.toLowerCase() ?? "";
    const structuredParams = normalizeParams(readParams(options));
    const hasIntent =
      Boolean(structuredParams) ||
      (["whatsapp", "send", "message", "react", "reaction"].some((keyword) =>
        text.includes(keyword)
      ) &&
        /\b(?:whatsapp|send|message|react|reaction)\b/i.test(text));
    return hasIntent && message.content?.source === "whatsapp";
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const creds = readCredentials(runtime);
    if (!creds) {
      if (callback) {
        await callback({
          text: "WhatsApp is not configured. Missing access token or phone number ID.",
        });
      }
      return { success: false, error: "WhatsApp not configured" };
    }

    const currentState = state ?? (await runtime.composeState(message));

    let params: WhatsAppOpParams | null = normalizeParams(readParams(_options));
    try {
      if (!params) {
        const prompt = composePromptFromState({
          state: currentState,
          template: MESSAGE_OP_TEMPLATE,
        });
        const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
        const parsed = parseJsonObject(response);
        if (parsed) {
          params = normalizeParams(parsed);
        }
      }
    } catch {
      // fall through; we'll attempt to infer below
    }

    if (!params) {
      const text = message.content?.text?.toLowerCase() ?? "";
      const inferred: WhatsAppOp =
        /\b(react|reaction|emoji)\b/.test(text) && !/\bsend\b/.test(text) ? "react" : "send";
      params = { op: inferred };
    }

    if (params.op === "react") {
      return handleReact(message, params, creds, callback);
    }
    return handleSend(runtime, message, currentState, params, creds, callback);
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Send a WhatsApp message to +14155552671 saying hello" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll send that WhatsApp message now.",
          actions: [WHATSAPP_MESSAGE_OP_ACTION],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "React to that with a thumbs up" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll add that reaction.",
          actions: [WHATSAPP_MESSAGE_OP_ACTION],
        },
      },
    ],
  ] as ActionExample[][],
};
