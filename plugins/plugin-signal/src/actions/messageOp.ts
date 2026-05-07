import {
  type Action,
  type ActionExample,
  type ActionResult,
  composePromptFromState,
  type HandlerCallback,
  type HandlerOptions,
	type IAgentRuntime,
	type Memory,
	ModelType,
	parseJSONObjectFromText,
	type State,
} from "@elizaos/core";
import { isValidGroupId, normalizeE164 } from "../types";
import {
  getSignalService,
  hasSignalService,
  hasStructuredSignalInvocation,
  isSignalConversation,
} from "./action-utils";

export const SIGNAL_MESSAGE_OP_ACTION = "SIGNAL_MESSAGE_OP";

type SignalOp = "send" | "react";

const VALID_OPS: ReadonlySet<SignalOp> = new Set(["send", "react"]);

interface SignalOpInfo {
  op: SignalOp;
  text?: string;
  recipient?: string;
  emoji?: string;
  targetTimestamp?: number;
  targetAuthor?: string;
  remove: boolean;
  timeoutMs?: number;
}

const MAX_SIGNAL_TEXT_CHARS = 4_000;
const SIGNAL_ACTION_TIMEOUT_MS = 30_000;

const messageOpTemplate = `# Task: Extract Signal message operation parameters.

Determine which Signal operation the user wants and extract its parameters.

Recent conversation:
{{recentMessages}}

Operations:
- send: send a text message. Provide \`text\` and \`recipient\` (E.164 phone, group id, or "current").
- react: react to a Signal message. Provide \`emoji\`, \`targetTimestamp\`, \`targetAuthor\`, and \`remove\` (true to remove).

Respond with JSON only, with no prose or fences:
{
  "op": "send",
  "text": "",
  "recipient": "current",
  "emoji": "",
  "targetTimestamp": null,
  "targetAuthor": "",
  "remove": false
}`;

function parseInfo(raw: unknown): SignalOpInfo | null {
  const parsed = parseJSONObjectFromText(
    typeof raw === "string" ? raw : String(raw)
  ) as Record<string, unknown> | null;
  if (!parsed) {
    return null;
  }
  const opRaw = typeof parsed.op === "string" ? parsed.op.toLowerCase().trim() : "";
  if (!VALID_OPS.has(opRaw as SignalOp)) {
    return null;
  }

  const text =
    typeof parsed.text === "string" && parsed.text.trim().length > 0
      ? String(parsed.text)
      : undefined;
  const recipient =
    typeof parsed.recipient === "string" && parsed.recipient.trim().length > 0
      ? String(parsed.recipient)
      : undefined;
  const emoji =
    typeof parsed.emoji === "string" && parsed.emoji.trim().length > 0
      ? String(parsed.emoji)
      : undefined;
  const targetTimestampValue = parsed.targetTimestamp;
  const targetTimestamp =
    typeof targetTimestampValue === "number" && Number.isFinite(targetTimestampValue)
      ? targetTimestampValue
      : typeof targetTimestampValue === "string" && targetTimestampValue.trim().length > 0
        ? Number(targetTimestampValue)
        : undefined;
  const targetAuthor =
    typeof parsed.targetAuthor === "string" && parsed.targetAuthor.trim().length > 0
      ? String(parsed.targetAuthor)
      : undefined;
  const remove = parsed.remove === true || String(parsed.remove ?? "").toLowerCase() === "true";

  return {
    op: opRaw as SignalOp,
    text,
    recipient,
    emoji,
    targetTimestamp:
      targetTimestamp !== undefined && Number.isFinite(targetTimestamp)
        ? targetTimestamp
        : undefined,
    targetAuthor,
    remove,
  };
}

async function handleSend(
  runtime: IAgentRuntime,
  service: NonNullable<ReturnType<typeof getSignalService>>,
  state: State | undefined,
  message: Memory,
  info: SignalOpInfo,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  if (!info.text || !info.text.trim()) {
    await callback?.({
      text: "I couldn't understand what message you want me to send. Please try again with a clearer request.",
      source: "signal",
    });
    return { success: false, error: "Could not extract message text" };
  }

  const room = state?.data?.room ?? (await runtime.getRoom(message.roomId));
  if (!room) {
    await callback?.({
      text: "I couldn't determine the current conversation.",
      source: "signal",
    });
    return { success: false, error: "Could not determine conversation" };
  }

  let targetRecipient = room.channelId || "";
  const isGroup = room.metadata?.isGroup || false;

  if (info.recipient && info.recipient !== "current") {
    const normalized = normalizeE164(info.recipient);
    if (normalized) {
      targetRecipient = normalized;
    } else if (isValidGroupId(info.recipient)) {
      targetRecipient = info.recipient;
    }
  }

  const result =
    isGroup || isValidGroupId(targetRecipient)
      ? await service.sendGroupMessage(targetRecipient, info.text)
      : await service.sendMessage(targetRecipient, info.text);

  runtime.logger.debug(
    {
      src: "plugin:signal:action:message-op",
      op: "send",
      timestamp: result.timestamp,
      recipient: targetRecipient,
    },
    "[SIGNAL_MESSAGE_OP] Message sent successfully"
  );

  return {
    success: true,
    data: {
      op: "send",
      timestamp: result.timestamp,
      recipient: targetRecipient,
      timeoutMs: info.timeoutMs,
      suppressVisibleCallback: true,
      suppressActionResultClipboard: true,
    },
  };
}

async function handleReact(
  service: NonNullable<ReturnType<typeof getSignalService>>,
  runtime: IAgentRuntime,
  state: State | undefined,
  message: Memory,
  info: SignalOpInfo,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  if (!info.emoji || info.targetTimestamp === undefined || !info.targetAuthor) {
    await callback?.({
      text: "I couldn't understand the reaction request. Please specify the emoji and message to react to.",
      source: "signal",
    });
    return { success: false, error: "Missing reaction parameters" };
  }

  const room = state?.data?.room ?? (await runtime.getRoom(message.roomId));
  const recipient = room?.channelId || info.targetAuthor;

  if (info.remove) {
    await service.removeReaction(recipient, info.emoji, info.targetTimestamp, info.targetAuthor);
  } else {
    await service.sendReaction(recipient, info.emoji, info.targetTimestamp, info.targetAuthor);
  }

  return {
    success: true,
    data: {
      op: "react",
      emoji: info.emoji,
      targetTimestamp: info.targetTimestamp,
      targetAuthor: info.targetAuthor,
      action: info.remove ? "removed" : "added",
      timeoutMs: info.timeoutMs,
      suppressVisibleCallback: true,
      suppressActionResultClipboard: true,
    },
  };
}

export const messageOp: Action = {
  name: SIGNAL_MESSAGE_OP_ACTION,
  similes: [
    "SIGNAL_SEND_MESSAGE",
    "SIGNAL_SEND_REACTION",
    "SEND_SIGNAL_MESSAGE",
    "REACT_SIGNAL",
    "SIGNAL_REACT",
    "SIGNAL_TEXT",
    "MESSAGE_SIGNAL",
  ],
  description: "Signal message operation router (send, react).",
  descriptionCompressed: "Signal message ops: send, react.",
  contexts: ["phone", "messaging", "connectors"],
  contextGate: { anyOf: ["phone", "messaging", "connectors"] },
  roleGate: { minRole: "USER" },
  parameters: [
    {
      name: "op",
      description: "Operation to run: send or react.",
      required: false,
      schema: { type: "string", enum: ["send", "react"] },
    },
    {
      name: "text",
      description: "Message text for send.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "recipient",
      description: "E.164 phone number, Signal group id, or current.",
      required: false,
      schema: { type: "string", default: "current" },
    },
    {
      name: "emoji",
      description: "Reaction emoji.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "targetAuthor",
      description: "Signal author id for the message being reacted to.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "targetTimestamp",
      description: "Signal timestamp for the message being reacted to.",
      required: false,
      schema: { type: "number" },
    },
  ],
  suppressPostActionContinuation: true,

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    if (!hasSignalService(runtime)) {
      return false;
    }
    if (isSignalConversation(message)) {
      return true;
    }
    if (
      hasStructuredSignalInvocation(message, SIGNAL_MESSAGE_OP_ACTION, [
        "recipient",
        "text",
        "emoji",
        "targetAuthor",
      ])
    ) {
      return true;
    }
    const text = typeof message.content?.text === "string" ? message.content.text : "";
    return (
      /\bsignal\b/i.test(text) && /\b(reply|send|message|text|react|reaction|emoji)\b/i.test(text)
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    const service = getSignalService(runtime);
    if (!service || !service.isServiceConnected()) {
      await callback?.({
        text: "Signal service is not available.",
        source: "signal",
      });
      return { success: false, error: "Signal service not available" };
    }

    const composedState: State =
      state ??
      ({
        values: {},
        data: {},
        text: "",
      } as State);
    const prompt = composePromptFromState({
      state: composedState,
      template: messageOpTemplate,
    });

    let info: SignalOpInfo | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
      info = parseInfo(response);
      if (info) {
        break;
      }
    }

    if (!info) {
      await callback?.({
        text: "I couldn't determine which Signal operation to perform.",
        source: "signal",
      });
      return { success: false, error: "Could not extract op parameters" };
    }
    info = {
      ...info,
      text: info.text?.slice(0, MAX_SIGNAL_TEXT_CHARS),
      timeoutMs: SIGNAL_ACTION_TIMEOUT_MS,
    };

    if (info.op === "react") {
      return handleReact(service, runtime, composedState, message, info, callback);
    }
    return handleSend(runtime, service, composedState, message, info, callback);
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Send a Signal message to +1234567890 saying 'Hello!'",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll send that Signal message.",
          actions: [SIGNAL_MESSAGE_OP_ACTION],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "React to that Signal message with a thumbs up",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll add that reaction.",
          actions: [SIGNAL_MESSAGE_OP_ACTION],
        },
      },
    ],
  ] as ActionExample[][],
};

export default messageOp;
