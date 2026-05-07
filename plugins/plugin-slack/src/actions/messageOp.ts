import {
  type Action,
  type ActionExample,
  type ActionResult,
  type Content,
  composePromptFromState,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import type { SlackService } from "../service";
import { isValidMessageTs, SLACK_SERVICE_NAME } from "../types";

const messageOpTemplate = `You are helping to extract Slack message operation parameters.

The user wants to perform a Slack message operation (send/edit/delete/react/pin/unpin).

Recent conversation:
{{recentMessages}}

Extract the operation and its parameters:
1. op: One of: send, edit, delete, react, pin, unpin
2. text: For send — the message text. For edit — the new message text.
3. messageTs: For edit/delete/react/pin/unpin — the message timestamp (format: 1234567890.123456)
4. channelRef: For send — the channel name/id, or "current".
5. channelId: For edit/delete/react/pin/unpin — the channel ID (optional, defaults to current channel)
6. threadTs: For send — optional thread timestamp to reply in a thread.
7. emoji: For react — the emoji name (without colons, e.g. "thumbsup").
8. remove: For react — true to remove the reaction, false (default) to add it.

Respond with JSON only. Return exactly one JSON object with this shape:
{"op":"send","text":"","messageTs":null,"channelRef":"current","channelId":null,"threadTs":null,"emoji":null,"remove":false}`;

interface MessageOpInfo {
  op: "send" | "edit" | "delete" | "react" | "pin" | "unpin";
  text?: string;
  messageTs?: string;
  channelRef?: string;
  channelId?: string | null;
  threadTs?: string | null;
  emoji?: string;
  remove?: boolean;
}

const MAX_SLACK_ACTION_TEXT_CHARS = 4_000;
const SLACK_ACTION_TIMEOUT_MS = 30_000;
const VALID_OPS = new Set(["send", "edit", "delete", "react", "pin", "unpin"]);

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

function readParams(
  options?: HandlerOptions | unknown,
): Record<string, unknown> {
  const direct =
    options && typeof options === "object"
      ? (options as Record<string, unknown>)
      : {};
  const parameters =
    direct.parameters && typeof direct.parameters === "object"
      ? (direct.parameters as Record<string, unknown>)
      : {};
  return { ...direct, ...parameters };
}

function normalizeMessageOpInfo(
  params: Record<string, unknown>,
): MessageOpInfo | null {
  const opRaw =
    typeof params.op === "string" ? params.op.toLowerCase().trim() : "";
  if (!VALID_OPS.has(opRaw)) {
    return null;
  }

  return {
    op: opRaw as MessageOpInfo["op"],
    text:
      typeof params.text === "string" && params.text.trim().length > 0
        ? params.text.slice(0, MAX_SLACK_ACTION_TEXT_CHARS)
        : undefined,
    messageTs:
      typeof params.messageTs === "string" && params.messageTs.trim().length > 0
        ? params.messageTs
        : undefined,
    channelRef:
      typeof params.channelRef === "string" &&
      params.channelRef.trim().length > 0
        ? params.channelRef
        : "current",
    channelId:
      typeof params.channelId === "string" && params.channelId.trim().length > 0
        ? params.channelId
        : null,
    threadTs:
      typeof params.threadTs === "string" && params.threadTs.trim().length > 0
        ? params.threadTs
        : null,
    emoji:
      typeof params.emoji === "string" && params.emoji.trim().length > 0
        ? params.emoji
        : undefined,
    remove:
      params.remove === true ||
      String(params.remove ?? "").toLowerCase() === "true",
  };
}

async function resolveChannelId(
  slackService: SlackService,
  channelRef: string | undefined,
  fallbackChannelId: string,
): Promise<string> {
  if (!channelRef || channelRef === "current") {
    return fallbackChannelId;
  }
  const channels = await slackService.listChannels();
  const targetChannel = channels.find((ch) => {
    const channelName = ch.name?.toLowerCase() || "";
    const searchTerm = channelRef.toLowerCase();
    return (
      channelName === searchTerm ||
      channelName === searchTerm.replace(/^#/, "") ||
      ch.id === channelRef
    );
  });
  return targetChannel?.id || fallbackChannelId;
}

export const messageOp: Action = {
  name: "SLACK_MESSAGE_OP",
  similes: [
    "SLACK_SEND_MESSAGE",
    "SEND_SLACK_MESSAGE",
    "POST_TO_SLACK",
    "MESSAGE_SLACK",
    "SLACK_POST",
    "SEND_TO_CHANNEL",
    "SLACK_EDIT_MESSAGE",
    "UPDATE_SLACK_MESSAGE",
    "MODIFY_MESSAGE",
    "CHANGE_MESSAGE",
    "SLACK_UPDATE",
    "SLACK_DELETE_MESSAGE",
    "REMOVE_SLACK_MESSAGE",
    "DELETE_MESSAGE",
    "SLACK_REMOVE",
    "SLACK_REACT_TO_MESSAGE",
    "ADD_SLACK_REACTION",
    "REACT_SLACK",
    "SLACK_EMOJI",
    "ADD_EMOJI",
    "REMOVE_REACTION",
    "SLACK_PIN_MESSAGE",
    "PIN_SLACK_MESSAGE",
    "PIN_MESSAGE",
    "SLACK_PIN",
    "SAVE_MESSAGE",
    "SLACK_UNPIN_MESSAGE",
    "UNPIN_SLACK_MESSAGE",
    "UNPIN_MESSAGE",
    "SLACK_UNPIN",
    "REMOVE_PIN",
  ],
  description:
    "Slack message operation router. Send, edit, delete, react, pin, or unpin Slack messages by setting op.",
  descriptionCompressed:
    "Slack message ops: send, edit, delete, react, pin, unpin.",
  contexts: ["messaging", "connectors"],
  contextGate: { anyOf: ["messaging", "connectors"] },
  roleGate: { minRole: "USER" },
  parameters: [
    {
      name: "op",
      description: "Operation: send, edit, delete, react, pin, or unpin.",
      required: false,
      schema: {
        type: "string",
        enum: ["send", "edit", "delete", "react", "pin", "unpin"],
      },
    },
    {
      name: "text",
      description: "Message text for send or edit.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "channelRef",
      description: "Slack channel name/id or current.",
      required: false,
      schema: { type: "string", default: "current" },
    },
    {
      name: "messageTs",
      description: "Slack message timestamp for edit/delete/react/pin/unpin.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "emoji",
      description: "Reaction emoji name without colons.",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: unknown,
  ): Promise<boolean> => {
    const __avTextRaw =
      typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avStructuredOp = normalizeMessageOpInfo(readParams(options));
    const __avKeywords = [
      "slack",
      "send",
      "edit",
      "delete",
      "react",
      "pin",
      "unpin",
      "message",
    ];
    const __avKeywordOk =
      Boolean(__avStructuredOp) ||
      (__avKeywords.length > 0 &&
        __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw)));
    const __avRegex = /\b(?:slack|send|edit|delete|react|pin|unpin|message)\b/i;
    const __avRegexOk = Boolean(__avStructuredOp) || __avRegex.test(__avText);
    const __avSource = String(
      message?.content?.source ?? message?.metadata?.source ?? "",
    );
    const __avExpectedSource = "slack";
    const __avSourceOk = __avExpectedSource
      ? __avSource === __avExpectedSource
      : Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
    const __avOptions = options && typeof options === "object" ? options : {};
    const __avInputOk =
      __avText.trim().length > 0 ||
      Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
      Boolean(message?.content && typeof message.content === "object");

    if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
      return false;
    }

    return message.content.source === "slack";
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const slackService = runtime.getService(SLACK_SERVICE_NAME) as SlackService;

    if (!slackService?.client) {
      await callback?.({
        text: "Slack service is not available.",
        source: "slack",
      });
      return { success: false, error: "Slack service not available" };
    }

    let info: MessageOpInfo | null = normalizeMessageOpInfo(
      readParams(_options),
    );

    if (!info) {
      const prompt = composePromptFromState({
        state,
        template: messageOpTemplate,
      });

      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt,
        });

        const parsed = parseJsonObject(response);
        if (!parsed) continue;

        info = normalizeMessageOpInfo(parsed);
        if (info) {
          break;
        }
      }
    }

    if (!info) {
      runtime.logger.debug(
        { src: "plugin:slack:action:message-op" },
        "[SLACK_MESSAGE_OP] Could not extract operation info",
      );
      await callback?.({
        text: "I couldn't determine which Slack message operation to perform.",
        source: "slack",
      });
      return { success: false, error: "Could not extract op parameters" };
    }
    info = {
      ...info,
      text: info.text?.slice(0, MAX_SLACK_ACTION_TEXT_CHARS),
    };

    const stateData = state?.data;
    const room = stateData?.room || (await runtime.getRoom(message.roomId));
    const fallbackChannelId = room?.channelId;

    if (!fallbackChannelId && !info.channelId) {
      await callback?.({
        text: "I couldn't determine the current channel.",
        source: "slack",
      });
      return { success: false, error: "Could not determine channel" };
    }

    const op = info.op;
    const logSrc = `plugin:slack:action:message-op:${op}`;
    const timeoutMs = SLACK_ACTION_TIMEOUT_MS;

    if (op === "send") {
      if (!info.text) {
        await callback?.({
          text: "I couldn't understand what message you want me to send.",
          source: "slack",
        });
        return { success: false, error: "Missing text for send" };
      }
      const targetChannelId = await resolveChannelId(
        slackService,
        info.channelRef,
        fallbackChannelId as string,
      );
      const result = await slackService.sendMessage(
        targetChannelId,
        info.text,
        {
          threadTs: info.threadTs || undefined,
          replyBroadcast: undefined,
          unfurlLinks: undefined,
          unfurlMedia: undefined,
          mrkdwn: undefined,
          attachments: undefined,
          blocks: undefined,
        },
      );
      const response: Content = {
        text: "Message sent successfully.",
        source: message.content.source,
      };
      runtime.logger.debug(
        { src: logSrc, messageTs: result.ts, channelId: targetChannelId },
        "[SLACK_MESSAGE_OP:send] Message sent",
      );
      await callback?.(response);
      return {
        success: true,
        data: { op, messageTs: result.ts, channelId: targetChannelId, timeoutMs },
      };
    }

    if (op === "edit") {
      if (!info.messageTs || !info.text) {
        await callback?.({
          text: "Edit requires both a message timestamp and new text.",
          source: "slack",
        });
        return { success: false, error: "Missing messageTs or text for edit" };
      }
      if (!isValidMessageTs(info.messageTs)) {
        await callback?.({
          text: "The message timestamp format is invalid.",
          source: "slack",
        });
        return { success: false, error: "Invalid message timestamp" };
      }
      const channelId = info.channelId || fallbackChannelId;
      if (!channelId) {
        await callback?.({
          text: "I couldn't determine the channel for the message edit.",
          source: "slack",
        });
        return { success: false, error: "Could not determine channel" };
      }
      await slackService.editMessage(channelId, info.messageTs, info.text);
      const response: Content = {
        text: "Message edited successfully.",
        source: message.content.source,
      };
      runtime.logger.debug(
        { src: logSrc, messageTs: info.messageTs, channelId },
        "[SLACK_MESSAGE_OP:edit] Message edited",
      );
      await callback?.(response);
      return {
        success: true,
        data: {
          op,
          messageTs: info.messageTs,
          channelId,
          newText: info.text,
          timeoutMs,
        },
      };
    }

    if (op === "delete") {
      if (!info.messageTs) {
        await callback?.({
          text: "Delete requires a message timestamp.",
          source: "slack",
        });
        return { success: false, error: "Missing messageTs for delete" };
      }
      if (!isValidMessageTs(info.messageTs)) {
        await callback?.({
          text: "The message timestamp format is invalid.",
          source: "slack",
        });
        return { success: false, error: "Invalid message timestamp" };
      }
      const channelId = info.channelId || fallbackChannelId;
      if (!channelId) {
        await callback?.({
          text: "I couldn't determine the channel for the deletion.",
          source: "slack",
        });
        return { success: false, error: "Could not determine channel" };
      }
      await slackService.deleteMessage(channelId, info.messageTs);
      const response: Content = {
        text: "Message deleted successfully.",
        source: message.content.source,
      };
      runtime.logger.debug(
        { src: logSrc, messageTs: info.messageTs, channelId },
        "[SLACK_MESSAGE_OP:delete] Message deleted",
      );
      await callback?.(response);
      return {
        success: true,
        data: { op, messageTs: info.messageTs, channelId, timeoutMs },
      };
    }

    if (op === "react") {
      if (!info.emoji || !info.messageTs) {
        await callback?.({
          text: "React requires an emoji name and message timestamp.",
          source: "slack",
        });
        return { success: false, error: "Missing emoji or messageTs" };
      }
      if (!isValidMessageTs(info.messageTs)) {
        await callback?.({
          text: "The message timestamp format is invalid.",
          source: "slack",
        });
        return { success: false, error: "Invalid message timestamp" };
      }
      const channelId = info.channelId || fallbackChannelId;
      if (!channelId) {
        await callback?.({
          text: "I couldn't determine the channel for the reaction.",
          source: "slack",
        });
        return { success: false, error: "Could not determine channel" };
      }
      if (info.remove) {
        await slackService.removeReaction(
          channelId,
          info.messageTs,
          info.emoji,
        );
      } else {
        await slackService.sendReaction(channelId, info.messageTs, info.emoji);
      }
      const actionWord = info.remove ? "removed" : "added";
      const response: Content = {
        text: `Reaction :${info.emoji}: ${actionWord} successfully.`,
        source: message.content.source,
      };
      runtime.logger.debug(
        {
          src: logSrc,
          emoji: info.emoji,
          messageTs: info.messageTs,
          channelId,
          remove: info.remove,
        },
        `[SLACK_MESSAGE_OP:react] Reaction ${actionWord}`,
      );
      await callback?.(response);
      return {
        success: true,
        data: {
          op,
          emoji: info.emoji,
          messageTs: info.messageTs,
          channelId,
          action: actionWord,
          timeoutMs,
        },
      };
    }

    if (op === "pin" || op === "unpin") {
      if (!info.messageTs) {
        await callback?.({
          text: `${op === "pin" ? "Pin" : "Unpin"} requires a message timestamp.`,
          source: "slack",
        });
        return { success: false, error: `Missing messageTs for ${op}` };
      }
      if (!isValidMessageTs(info.messageTs)) {
        await callback?.({
          text: "The message timestamp format is invalid.",
          source: "slack",
        });
        return { success: false, error: "Invalid message timestamp" };
      }
      const channelId = info.channelId || fallbackChannelId;
      if (!channelId) {
        await callback?.({
          text: `I couldn't determine the channel for the ${op}.`,
          source: "slack",
        });
        return { success: false, error: "Could not determine channel" };
      }
      if (op === "pin") {
        await slackService.pinMessage(channelId, info.messageTs);
      } else {
        await slackService.unpinMessage(channelId, info.messageTs);
      }
      const response: Content = {
        text: `Message ${op === "pin" ? "pinned" : "unpinned"} successfully.`,
        source: message.content.source,
      };
      runtime.logger.debug(
        { src: logSrc, messageTs: info.messageTs, channelId },
        `[SLACK_MESSAGE_OP:${op}] Message ${op === "pin" ? "pinned" : "unpinned"}`,
      );
      await callback?.(response);
      return {
        success: true,
        data: { op, messageTs: info.messageTs, channelId, timeoutMs },
      };
    }

    return { success: false, error: `Unknown op: ${op}` };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Send a message to #general saying 'Hello everyone!'",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll send that message to #general.",
          actions: ["SLACK_MESSAGE_OP"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Edit that message to say 'Meeting at 3pm' instead",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll update that message.",
          actions: ["SLACK_MESSAGE_OP"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Delete that last message I sent",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll delete that message.",
          actions: ["SLACK_MESSAGE_OP"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "React to the last message with a thumbs up",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Adding the thumbs up reaction.",
          actions: ["SLACK_MESSAGE_OP"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Pin that important announcement",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll pin that message to the channel.",
          actions: ["SLACK_MESSAGE_OP"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Unpin that old announcement",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll remove the pin.",
          actions: ["SLACK_MESSAGE_OP"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default messageOp;
