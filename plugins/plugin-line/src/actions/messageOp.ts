/**
 * LINE message operation router.
 *
 * Single planner-facing router for LINE send operations across text, flex, and location.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { composePromptFromState, logger, ModelType, parseJSONObjectFromText } from "@elizaos/core";
import { isLineOutboundActionContext } from "../line-action-validate.js";
import type { LineService } from "../service.js";
import {
  isValidLineId,
  LINE_SERVICE_NAME,
  type LineFlexMessage,
  type LineLocationMessage,
  normalizeLineTarget,
} from "../types.js";

export const LINE_MESSAGE_OP_ACTION = "LINE_MESSAGE_OP";

type LineOp = "text" | "flex" | "location";

const VALID_OPS: ReadonlySet<LineOp> = new Set(["text", "flex", "location"]);

interface LineOpInfo {
  op: LineOp;
  text?: string;
  altText?: string;
  title?: string;
  body?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  to?: string;
}

const messageOpTemplate = `# Task: Extract LINE message operation parameters.

Determine which LINE operation the user wants and extract its parameters.

Recent conversation:
{{recentMessages}}

Operations:
- text: send a plain text message. Provide \`text\` and \`to\`.
- flex: send a flex/card message. Provide \`title\`, \`body\`, optional \`altText\`, and \`to\`.
- location: send a location message. Provide \`title\`, \`address\`, \`latitude\`, \`longitude\`, and \`to\`.

\`to\` is the user/group/room ID, or "current" to reply in the current chat.

Respond with JSON only, with no prose or fences:
{
  "op": "text",
  "text": "",
  "altText": "",
  "title": "",
  "body": "",
  "address": "",
  "latitude": null,
  "longitude": null,
  "to": "current"
}`;

function parseInfo(raw: unknown): LineOpInfo | null {
  const parsed = parseJSONObjectFromText(typeof raw === "string" ? raw : String(raw)) as Record<
    string,
    unknown
  > | null;
  if (!parsed) {
    return null;
  }
  const opRaw = typeof parsed.op === "string" ? parsed.op.toLowerCase().trim() : "";
  if (!VALID_OPS.has(opRaw as LineOp)) {
    return null;
  }
  const stringField = (key: string): string | undefined =>
    typeof parsed[key] === "string" && (parsed[key] as string).trim().length > 0
      ? String(parsed[key])
      : undefined;
  const numberField = (key: string): number | undefined => {
    const v = parsed[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim().length > 0) {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  };
  return {
    op: opRaw as LineOp,
    text: stringField("text"),
    altText: stringField("altText"),
    title: stringField("title"),
    body: stringField("body"),
    address: stringField("address"),
    latitude: numberField("latitude"),
    longitude: numberField("longitude"),
    to: stringField("to"),
  };
}

function resolveTarget(state: State, info: LineOpInfo): string | undefined {
  if (info.to && info.to !== "current") {
    const normalized = normalizeLineTarget(info.to);
    if (normalized && isValidLineId(normalized)) {
      return normalized;
    }
  }
  const stateData = (state.data || {}) as Record<string, unknown>;
  return (
    (stateData.groupId as string) ||
    (stateData.roomId as string) ||
    (stateData.userId as string) ||
    undefined
  );
}

function createInfoBubble(title: string, body: string): { type: string; [key: string]: unknown } {
  return {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "text",
          text: title,
          weight: "bold",
          size: "xl",
          wrap: true,
        },
        {
          type: "text",
          text: body,
          margin: "md",
          wrap: true,
        },
      ],
    },
  };
}

async function handleText(
  service: LineService,
  state: State,
  info: LineOpInfo,
  callback: HandlerCallback | undefined,
  source: string
): Promise<ActionResult> {
  if (!info.text?.trim()) {
    callback?.({
      text: "I couldn't understand what message you want me to send. Please try again.",
      source: "line",
    });
    return { success: false, error: "Could not extract message text" };
  }
  const targetId = resolveTarget(state, info);
  if (!targetId) {
    callback?.({
      text: "I couldn't determine where to send the message. Please specify a target.",
      source: "line",
    });
    return { success: false, error: "Could not determine target" };
  }
  const result = await service.sendMessage(targetId, info.text);
  if (!result.success) {
    callback?.({ text: `Failed to send message: ${result.error}`, source: "line" });
    return { success: false, error: result.error };
  }
  logger.debug(`Sent LINE message to ${targetId}`);
  callback?.({ text: "Message sent successfully.", source });
  return { success: true, text: "Message sent successfully" };
}

async function handleFlex(
  service: LineService,
  state: State,
  info: LineOpInfo,
  callback: HandlerCallback | undefined,
  source: string
): Promise<ActionResult> {
  if (!info.title || !info.body) {
    callback?.({
      text: "I couldn't understand the flex message content. Please provide a title and body.",
      source: "line",
    });
    return { success: false, error: "Missing flex title/body" };
  }
  const targetId = resolveTarget(state, info);
  if (!targetId) {
    callback?.({
      text: "I couldn't determine where to send the message. Please specify a target.",
      source: "line",
    });
    return { success: false, error: "Could not determine target" };
  }
  const altText = (info.altText ?? `${info.title}: ${info.body}`).slice(0, 400);
  const flexMessage: LineFlexMessage = {
    altText,
    contents: createInfoBubble(info.title, info.body),
  };
  const result = await service.sendFlexMessage(targetId, flexMessage);
  if (!result.success) {
    callback?.({ text: `Failed to send flex message: ${result.error}`, source: "line" });
    return { success: false, error: result.error };
  }
  logger.debug(`Sent LINE flex message to ${targetId}`);
  callback?.({ text: "Card message sent successfully.", source });
  return { success: true, text: "Card message sent successfully" };
}

async function handleLocation(
  service: LineService,
  state: State,
  info: LineOpInfo,
  callback: HandlerCallback | undefined,
  source: string
): Promise<ActionResult> {
  if (!info.title || !info.address || info.latitude === undefined || info.longitude === undefined) {
    callback?.({
      text: "I couldn't understand the location information. Please provide title, address, latitude, and longitude.",
      source: "line",
    });
    return { success: false, error: "Missing location parameters" };
  }
  const targetId = resolveTarget(state, info);
  if (!targetId) {
    callback?.({
      text: "I couldn't determine where to send the location. Please specify a target.",
      source: "line",
    });
    return { success: false, error: "Could not determine target" };
  }
  const location: LineLocationMessage = {
    type: "location",
    title: info.title,
    address: info.address,
    latitude: info.latitude,
    longitude: info.longitude,
  };
  const result = await service.sendLocationMessage(targetId, location);
  if (!result.success) {
    callback?.({ text: `Failed to send location: ${result.error}`, source: "line" });
    return { success: false, error: result.error };
  }
  logger.debug(`Sent LINE location to ${targetId}`);
  callback?.({ text: "Location sent successfully.", source });
  return { success: true, text: "Location sent successfully" };
}

export const messageOp: Action = {
  name: LINE_MESSAGE_OP_ACTION,
  similes: [
    "LINE_SEND_MESSAGE",
    "LINE_SEND_FLEX_MESSAGE",
    "LINE_SEND_LOCATION",
    "SEND_LINE_MESSAGE",
    "LINE_TEXT",
    "LINE_FLEX",
    "LINE_LOCATION",
  ],
  description: "LINE message operation router. Send text, flex/card, or location.",
  descriptionCompressed: "LINE message ops: text, flex, location.",
  suppressPostActionContinuation: true,

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> =>
    isLineOutboundActionContext(
      message,
      ["line", "send", "message", "flex", "location"],
      /\b(?:line|send|message|flex|location)\b/i
    ),

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const service = runtime.getService(LINE_SERVICE_NAME) as unknown as LineService | undefined;
    if (!service?.isConnected()) {
      callback?.({ text: "LINE service is not available.", source: "line" });
      return { success: false, error: "LINE service not available" };
    }

    const currentState = state ?? (await runtime.composeState(message));
    const prompt = composePromptFromState({
      template: messageOpTemplate,
      state: currentState,
    });

    let info: LineOpInfo | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
      info = parseInfo(response);
      if (info) {
        break;
      }
    }

    if (!info) {
      callback?.({
        text: "I couldn't determine which LINE operation to perform.",
        source: "line",
      });
      return { success: false, error: "Could not extract op parameters" };
    }

    const sourceLabel =
      typeof message.content.source === "string" ? message.content.source : "line";

    switch (info.op) {
      case "text":
        return handleText(service, currentState, info, callback, sourceLabel);
      case "flex":
        return handleFlex(service, currentState, info, callback, sourceLabel);
      case "location":
        return handleLocation(service, currentState, info, callback, sourceLabel);
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Send them a LINE message saying 'Hello!'" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll send that LINE message.",
          actions: [LINE_MESSAGE_OP_ACTION],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Send a flex card titled 'Update' with body 'New features are available'",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll send that as a LINE card.",
          actions: [LINE_MESSAGE_OP_ACTION],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Send the location of Tokyo Tower via LINE" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll send the location.",
          actions: [LINE_MESSAGE_OP_ACTION],
        },
      },
    ],
  ] as ActionExample[][],
};

export default messageOp;
