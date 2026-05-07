/**
 * Google Chat message operation router.
 *
 * Single planner-facing router for Google Chat send and react operations.
 */

import {
  type Action,
  type ActionExample,
  type ActionResult,
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import type { GoogleChatService } from "../service.js";
import {
  GOOGLE_CHAT_SERVICE_NAME,
  normalizeSpaceTarget,
  splitMessageForGoogleChat,
} from "../types.js";

export const GOOGLE_CHAT_MESSAGE_OP_ACTION = "GOOGLE_CHAT_MESSAGE_OP";

type GoogleChatOp = "send" | "react";

const VALID_OPS: ReadonlySet<GoogleChatOp> = new Set(["send", "react"]);

interface GoogleChatOpInfo {
  op: GoogleChatOp;
  text?: string;
  space?: string;
  thread?: string;
  emoji?: string;
  messageName?: string;
  remove: boolean;
}

const messageOpTemplate = `# Task: Extract Google Chat message operation parameters.

Determine which Google Chat operation the user wants and extract its parameters.

Recent conversation:
{{recentMessages}}

Operations:
- send: send a message to a space. Provide \`text\`, \`space\` (spaces/xxx or "current"), and optional \`thread\`.
- react: add or remove an emoji reaction. Provide \`emoji\`, \`messageName\` (spaces/xxx/messages/yyy), and \`remove\` (true to remove).

Respond with JSON only, with no prose or fences:
{
  "op": "send",
  "text": "",
  "space": "current",
  "thread": "",
  "emoji": "",
  "messageName": "",
  "remove": false
}`;

function parseInfo(raw: unknown): GoogleChatOpInfo | null {
  const parsed = parseJSONObjectFromText(typeof raw === "string" ? raw : String(raw)) as Record<
    string,
    unknown
  > | null;
  if (!parsed) {
    return null;
  }
  const opRaw = typeof parsed.op === "string" ? parsed.op.toLowerCase().trim() : "";
  if (!VALID_OPS.has(opRaw as GoogleChatOp)) {
    return null;
  }
  const stringField = (key: string): string | undefined =>
    typeof parsed[key] === "string" && (parsed[key] as string).trim().length > 0
      ? String(parsed[key])
      : undefined;
  return {
    op: opRaw as GoogleChatOp,
    text: stringField("text"),
    space: stringField("space"),
    thread: stringField("thread"),
    emoji: stringField("emoji"),
    messageName: stringField("messageName"),
    remove: parsed.remove === true || String(parsed.remove ?? "").toLowerCase() === "true",
  };
}

async function handleSend(
  service: GoogleChatService,
  state: State,
  message: Memory,
  info: GoogleChatOpInfo,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  if (!info.text?.trim()) {
    callback?.({
      text: "I couldn't understand what message you want me to send. Please try again.",
      source: "google-chat",
    });
    return { success: false, error: "Could not extract message text" };
  }

  let targetSpace: string | undefined;
  if (info.space && info.space !== "current") {
    const normalized = normalizeSpaceTarget(info.space);
    if (normalized) {
      targetSpace = normalized;
    }
  }
  const spaceData = state.data?.space as Record<string, unknown> | undefined;
  if (!targetSpace && spaceData?.name) {
    targetSpace = String(spaceData.name);
  }

  if (!targetSpace) {
    callback?.({
      text: "I couldn't determine which space to send to. Please specify a space.",
      source: "google-chat",
    });
    return { success: false, error: "Could not determine target space" };
  }

  const chunks = splitMessageForGoogleChat(info.text);

  let lastResult: { messageName?: string } | undefined;
  for (const chunk of chunks) {
    const result = await service.sendMessage({
      space: targetSpace,
      text: chunk,
      thread: info.thread,
    });
    if (!result.success) {
      callback?.({
        text: `Failed to send message: ${result.error}`,
        source: "google-chat",
      });
      return { success: false, error: result.error };
    }
    lastResult = { messageName: result.messageName };
    logger.debug(`Sent Google Chat message: ${result.messageName}`);
  }

  callback?.({
    text: "Message sent successfully.",
    source: typeof message.content.source === "string" ? message.content.source : "google-chat",
  });

  return {
    success: true,
    data: {
      op: "send",
      space: targetSpace,
      messageName: lastResult?.messageName,
      chunksCount: chunks.length,
    },
  };
}

async function handleReact(
  service: GoogleChatService,
  state: State,
  message: Memory,
  info: GoogleChatOpInfo,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  if (!info.emoji) {
    callback?.({
      text: "I couldn't understand the reaction details. Please specify an emoji.",
      source: "google-chat",
    });
    return { success: false, error: "Missing reaction emoji" };
  }

  let targetMessage = info.messageName;
  const messageData = state.data?.message as Record<string, unknown> | undefined;
  if (!targetMessage && messageData?.name) {
    targetMessage = String(messageData.name);
  }
  if (!targetMessage) {
    callback?.({
      text: "I couldn't determine which message to react to. Please specify the message.",
      source: "google-chat",
    });
    return { success: false, error: "Could not determine target message" };
  }

  if (info.remove) {
    const reactions = await service.listReactions(targetMessage);
    const botUser = service.getBotUser();
    const toRemove = reactions.filter((r) => {
      const userName = r.user?.name;
      if (botUser && userName !== botUser && userName !== "users/app") {
        return false;
      }
      if (info.emoji && r.emoji?.unicode !== info.emoji) {
        return false;
      }
      return true;
    });
    for (const reaction of toRemove) {
      if (reaction.name) {
        await service.deleteReaction(reaction.name);
      }
    }
    callback?.({
      text: `Removed ${toRemove.length} reaction(s).`,
      source: typeof message.content.source === "string" ? message.content.source : "google-chat",
    });
    return {
      success: true,
      data: {
        op: "react",
        removed: toRemove.length,
      },
    };
  }

  const result = await service.sendReaction(targetMessage, info.emoji);
  if (!result.success) {
    callback?.({
      text: `Failed to add reaction: ${result.error}`,
      source: "google-chat",
    });
    return { success: false, error: result.error };
  }
  callback?.({
    text: `Added ${info.emoji} reaction.`,
    source: typeof message.content.source === "string" ? message.content.source : "google-chat",
  });
  return {
    success: true,
    data: {
      op: "react",
      reactionName: result.name,
      emoji: info.emoji,
    },
  };
}

export const messageOp: Action = {
  name: GOOGLE_CHAT_MESSAGE_OP_ACTION,
  similes: [
    "GOOGLE_CHAT_SEND_MESSAGE",
    "GOOGLE_CHAT_SEND_REACTION",
    "SEND_GOOGLE_CHAT_MESSAGE",
    "MESSAGE_GOOGLE_CHAT",
    "GCHAT_SEND",
    "GCHAT_REACT",
    "REACT_GOOGLE_CHAT",
  ],
  description: "Google Chat message operation router (send, react).",
  descriptionCompressed: "Google Chat message ops: send, react.",
  contexts: ["messaging", "connectors"],
  contextGate: { anyOf: ["messaging", "connectors"] },
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
      name: "space",
      description: "Google Chat space id/name or current space.",
      required: false,
      schema: { type: "string", default: "current" },
    },
    {
      name: "messageName",
      description: "Target Google Chat message resource name for reaction.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "emoji",
      description: "Reaction emoji.",
      required: false,
      schema: { type: "string" },
    },
  ],
  suppressPostActionContinuation: true,

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    return message.content.source === "google-chat";
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const service = runtime.getService<GoogleChatService>(GOOGLE_CHAT_SERVICE_NAME);
    if (!service?.isConnected()) {
      callback?.({
        text: "Google Chat service is not available.",
        source: "google-chat",
      });
      return { success: false, error: "Google Chat service not available" };
    }

    const currentState = state ?? (await runtime.composeState(message));
    const prompt = await composePromptFromState({
      template: messageOpTemplate,
      state: currentState,
    });

    let info: GoogleChatOpInfo | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
      info = parseInfo(response);
      if (info) {
        break;
      }
    }

    if (!info) {
      callback?.({
        text: "I couldn't determine which Google Chat operation to perform.",
        source: "google-chat",
      });
      return { success: false, error: "Could not extract op parameters" };
    }

    if (info.op === "react") {
      return handleReact(service, currentState, message, info, callback);
    }
    return handleSend(service, currentState, message, info, callback);
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Send a Google Chat message saying 'Hello everyone!'" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll send that message to the space.",
          actions: [GOOGLE_CHAT_MESSAGE_OP_ACTION],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "React to that Google Chat message with a thumbs up" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll add a thumbs up reaction.",
          actions: [GOOGLE_CHAT_MESSAGE_OP_ACTION],
        },
      },
    ],
  ] as ActionExample[][],
};

export default messageOp;
