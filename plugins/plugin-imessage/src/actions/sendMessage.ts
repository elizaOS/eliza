/**
 * Send message action for the iMessage plugin.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { composePromptFromState, logger, ModelType, parseJSONObjectFromText } from "@elizaos/core";
import type { IMessageService } from "../service.js";
import { IMESSAGE_SERVICE_NAME, isValidIMessageTarget, normalizeIMessageTarget } from "../types.js";

const SEND_MESSAGE_TEMPLATE = `# Task: Extract iMessage parameters

Based on the conversation, determine what message to send and to whom.

Recent conversation:
{{recentMessages}}

Extract the following:
1. text: The message content to send
2. to: The recipient (phone number, email, or "current" to reply)

Respond with JSON only, with no prose or fences:
{
  "text": "message to send",
  "to": "phone/email or current"
}
`;

interface SendMessageParams {
  text: string;
  to: string;
}

const MAX_IMESSAGE_TEXT_CHARS = 4_000;
const IMESSAGE_ACTION_TIMEOUT_MS = 30_000;

function truncateActionText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

function parseSendMessageParams(response: string): SendMessageParams | null {
  const parsed = parseJSONObjectFromText(response) as Record<string, unknown> | null;
  if (parsed?.text) {
    return {
      text: truncateActionText(String(parsed.text), MAX_IMESSAGE_TEXT_CHARS),
      to: String(parsed.to || "current"),
    };
  }

  return null;
}

export const sendMessage: Action = {
  name: "IMESSAGE_SEND_MESSAGE",
  similes: ["SEND_IMESSAGE", "IMESSAGE_TEXT", "TEXT_IMESSAGE", "SEND_IMSG"],
  description: "Send a text message via iMessage (macOS only)",
  descriptionCompressed: "Send iMessage (macOS).",
  contexts: ["phone", "messaging", "connectors"],
  contextGate: { anyOf: ["phone", "messaging", "connectors"] },
  roleGate: { minRole: "USER" },
  parameters: [
    {
      name: "text",
      description: "Message text to send.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "to",
      description: "Phone number, email address, or current conversation.",
      required: false,
      schema: { type: "string", default: "current" },
    },
  ],
  suppressPostActionContinuation: true,

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    // The action is available whenever the iMessage service is registered,
    // regardless of where the inbound message came from. Previously this
    // validate() required `message.content.source === "imessage"`, which
    // meant the agent could only send iMessages if the *user's* incoming
    // message had also come in over iMessage. That broke the common cases:
    // commanding the agent from the dashboard, from /api/chat, from a
    // cron task, or from any other connector. Opening the gate to any
    // source is the only way "tell my agent to text Shaw" works from
    // outside an iMessage conversation.
    //
    // We still require (a) the service to be registered, so we don't
    // pretend to expose a send path the runtime can't fulfil, and (b)
    // some intent signal in the text — a bare "hi" on the wire from a
    // non-imessage source shouldn't flag this action as relevant.
    const imessageService =
      typeof runtime?.getService === "function"
        ? runtime.getService<IMessageService>(IMESSAGE_SERVICE_NAME)
        : null;
    if (!imessageService) return false;

    const source = String(message.content.source ?? "");

    // Messages that arrive over iMessage itself are always eligible —
    // the agent is mid-conversation and every reply is a candidate send.
    if (source === "imessage") return true;

    // For every other source (client_chat, dashboard, api, cron, …) we
    // look for explicit intent: a structured invocation in the content,
    // or keywords that match the Action's purpose.
    const hasStructuredInvocation =
      Boolean(message.content.actions?.includes("IMESSAGE_SEND_MESSAGE")) ||
      (typeof message.content === "object" &&
        typeof (message.content as Record<string, unknown>).to === "string");
    if (hasStructuredInvocation) return true;

    const text = typeof message.content.text === "string" ? message.content.text.trim() : "";
    if (!text) return false;

    // Keyword intent: "text", "send", "message", "imessage", "sms".
    // Any of these in the user's prompt marks the action as candidate;
    // the LLM still decides whether to actually invoke it.
    return /\b(imessage|text|send|message|sms)\b/i.test(text);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const imessageService = runtime.getService<IMessageService>(IMESSAGE_SERVICE_NAME);

    if (!imessageService?.isConnected()) {
      if (callback) {
        callback({
          text: "iMessage service is not available.",
          source: "imessage",
        });
      }
      return { success: false, error: "iMessage service not available" };
    }

    if (!imessageService.isMacOS()) {
      if (callback) {
        callback({
          text: "iMessage is only available on macOS.",
          source: "imessage",
        });
      }
      return { success: false, error: "iMessage requires macOS" };
    }

    // Compose state if not provided
    const currentState = state ?? (await runtime.composeState(message));

    // Extract parameters using LLM
    const prompt = await composePromptFromState({
      template: SEND_MESSAGE_TEMPLATE,
      state: currentState,
    });

    let msgInfo: SendMessageParams | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsed = parseSendMessageParams(response);
      if (parsed?.text) {
        msgInfo = parsed;
        break;
      }
    }

    if (!msgInfo?.text) {
      if (callback) {
        callback({
          text: "I couldn't understand what message you want me to send. Please try again.",
          source: "imessage",
        });
      }
      return { success: false, error: "Could not extract message parameters" };
    }
    msgInfo = {
      ...msgInfo,
      text: msgInfo.text.slice(0, MAX_IMESSAGE_TEXT_CHARS),
    };

    // Determine target
    let targetId: string | undefined;

    if (msgInfo.to && msgInfo.to !== "current") {
      const normalized = normalizeIMessageTarget(msgInfo.to);
      if (normalized && isValidIMessageTarget(normalized)) {
        targetId = normalized;
      }
    }

    // Fall back to current chat
    if (!targetId) {
      const stateData = (currentState.data || {}) as Record<string, unknown>;
      targetId = (stateData.chatId as string) || (stateData.handle as string);
    }

    if (!targetId) {
      if (callback) {
        callback({
          text: "I couldn't determine who to send the message to. Please specify a phone number or email.",
          source: "imessage",
        });
      }
      return { success: false, error: "Could not determine recipient" };
    }

    // Send message
    const timeoutMs = IMESSAGE_ACTION_TIMEOUT_MS;
    const result = await imessageService.sendMessage(targetId, msgInfo.text);

    if (!result.success) {
      if (callback) {
        callback({
          text: `Failed to send message: ${result.error}`,
          source: "imessage",
        });
      }
      return { success: false, error: result.error };
    }

    logger.debug(`Sent iMessage to ${targetId}`);

    return {
      success: true,
      data: {
        to: targetId,
        messageId: result.messageId,
        timeoutMs,
        suppressVisibleCallback: true,
        suppressActionResultClipboard: true,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Send them a message saying 'Hello!'" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll send that message via iMessage.",
          actions: ["IMESSAGE_SEND_MESSAGE"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Text +1234567890 saying 'I'll be there in 10 minutes'",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll send that text.",
          actions: ["IMESSAGE_SEND_MESSAGE"],
        },
      },
    ],
  ],
};
