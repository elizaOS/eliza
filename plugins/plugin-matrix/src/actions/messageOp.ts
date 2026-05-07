/**
 * Matrix message operation router.
 *
 * Single planner-facing router for Matrix send and react operations.
 */

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
import { composePromptFromState, ModelType, parseJSONObjectFromText } from "@elizaos/core";
import type { MatrixService } from "../service.js";
import { isValidMatrixRoomAlias, isValidMatrixRoomId, MATRIX_SERVICE_NAME } from "../types.js";

export const MATRIX_MESSAGE_OP_ACTION = "MATRIX_MESSAGE_OP";

type MatrixOp = "send" | "react";

const VALID_OPS: ReadonlySet<MatrixOp> = new Set(["send", "react"]);

interface MatrixOpInfo {
  op: MatrixOp;
  text?: string;
  roomId?: string;
  emoji?: string;
  eventId?: string;
  timeoutMs?: number;
}

const MAX_MATRIX_TEXT_CHARS = 4_000;
const MATRIX_ACTION_TIMEOUT_MS = 30_000;

const messageOpTemplate = `# Task: Extract Matrix message operation parameters.

Determine which Matrix operation the user wants and extract its parameters.

Recent conversation:
{{recentMessages}}

Operations:
- send: send a message to a Matrix room. Provide \`text\` and \`roomId\` (!room:server, #alias:server, or "current").
- react: react to a Matrix event with an emoji. Provide \`emoji\` and \`eventId\` (starts with $).

Respond with JSON only, with no prose or fences:
{
  "op": "send",
  "text": "",
  "roomId": "current",
  "emoji": "",
  "eventId": ""
}`;

function parseInfo(raw: unknown): MatrixOpInfo | null {
  const parsed = parseJSONObjectFromText(typeof raw === "string" ? raw : String(raw)) as Record<
    string,
    unknown
  > | null;
  if (!parsed) {
    return null;
  }
  const opRaw = typeof parsed.op === "string" ? parsed.op.toLowerCase().trim() : "";
  if (!VALID_OPS.has(opRaw as MatrixOp)) {
    return null;
  }
  const stringField = (key: string): string | undefined =>
    typeof parsed[key] === "string" && (parsed[key] as string).trim().length > 0
      ? String(parsed[key])
      : undefined;
  return {
    op: opRaw as MatrixOp,
    text: stringField("text"),
    roomId: stringField("roomId"),
    emoji: stringField("emoji"),
    eventId: stringField("eventId"),
  };
}

function resolveRoomId(state: State | undefined, info: MatrixOpInfo): string | undefined {
  if (info.roomId && info.roomId !== "current") {
    if (isValidMatrixRoomId(info.roomId) || isValidMatrixRoomAlias(info.roomId)) {
      return info.roomId;
    }
  }
  const roomData = state?.data?.room as Record<string, string> | undefined;
  return roomData?.roomId;
}

async function handleSend(
  service: MatrixService,
  state: State,
  message: Memory,
  info: MatrixOpInfo,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  if (!info.text?.trim()) {
    await callback?.({
      text: "I couldn't understand what message you want me to send. Please try again.",
      source: "matrix",
    });
    return { success: false, error: "Could not extract message text" };
  }
  const targetRoomId = resolveRoomId(state, info);
  if (!targetRoomId) {
    await callback?.({
      text: "I couldn't determine which room to send to. Please specify a room.",
      source: "matrix",
    });
    return { success: false, error: "Could not determine target room" };
  }
  const result = await service.sendMessage(info.text, { roomId: targetRoomId });
  if (!result.success) {
    await callback?.({
      text: `Failed to send message: ${result.error}`,
      source: "matrix",
    });
    return { success: false, error: result.error };
  }
  await callback?.({
    text: "Message sent successfully.",
    source: typeof message.content.source === "string" ? message.content.source : "matrix",
  });
  return {
    success: true,
    data: {
      op: "send",
      roomId: result.roomId,
      eventId: result.eventId,
      timeoutMs: info.timeoutMs,
    },
  };
}

async function handleReact(
  service: MatrixService,
  state: State,
  message: Memory,
  info: MatrixOpInfo,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  if (!info.emoji || !info.eventId) {
    await callback?.({
      text: "I couldn't understand the reaction request. Please specify an emoji and event id.",
      source: "matrix",
    });
    return { success: false, error: "Missing reaction parameters" };
  }
  const roomData = state?.data?.room as Record<string, string> | undefined;
  const roomId = roomData?.roomId;
  if (!roomId) {
    await callback?.({
      text: "I couldn't determine which room this is in.",
      source: "matrix",
    });
    return { success: false, error: "Could not determine room" };
  }
  const result = await service.sendReaction(roomId, info.eventId, info.emoji);
  if (!result.success) {
    await callback?.({
      text: `Failed to add reaction: ${result.error}`,
      source: "matrix",
    });
    return { success: false, error: result.error };
  }
  await callback?.({
    text: `Added ${info.emoji} reaction.`,
    source: typeof message.content.source === "string" ? message.content.source : "matrix",
  });
  return {
    success: true,
    data: {
      op: "react",
      emoji: info.emoji,
      eventId: info.eventId,
      roomId,
      timeoutMs: info.timeoutMs,
    },
  };
}

export const messageOp: Action = {
  name: MATRIX_MESSAGE_OP_ACTION,
  similes: [
    "MATRIX_SEND_MESSAGE",
    "MATRIX_SEND_REACTION",
    "SEND_MATRIX_MESSAGE",
    "MESSAGE_MATRIX",
    "MATRIX_TEXT",
    "MATRIX_REACT",
    "REACT_MATRIX",
  ],
  description: "Matrix message operation router (send, react).",
  descriptionCompressed: "Matrix message ops: send, react.",
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
      name: "roomId",
      description: "Matrix room id or current room.",
      required: false,
      schema: { type: "string", default: "current" },
    },
    {
      name: "eventId",
      description: "Target event id for reactions.",
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
    return message.content.source === "matrix";
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    const matrixService = runtime.getService(MATRIX_SERVICE_NAME) as MatrixService | undefined;
    if (!matrixService?.isConnected()) {
      await callback?.({
        text: "Matrix service is not available.",
        source: "matrix",
      });
      return { success: false, error: "Matrix service not available" };
    }

    const composedState: State =
      state ??
      ({
        values: {},
        data: {},
        text: "",
      } as State);
    const prompt = await composePromptFromState({
      template: messageOpTemplate,
      state: composedState,
    });

    let info: MatrixOpInfo | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
      info = parseInfo(response);
      if (info) {
        break;
      }
    }

    if (!info) {
      await callback?.({
        text: "I couldn't determine which Matrix operation to perform.",
        source: "matrix",
      });
      return { success: false, error: "Could not extract op parameters" };
    }
    info = {
      ...info,
      text: info.text?.slice(0, MAX_MATRIX_TEXT_CHARS),
      timeoutMs: MATRIX_ACTION_TIMEOUT_MS,
    };

    if (info.op === "react") {
      return handleReact(matrixService, composedState, message, info, callback);
    }
    return handleSend(matrixService, composedState, message, info, callback);
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Send a Matrix message saying 'Hello everyone!'" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll send that message to the room.",
          actions: [MATRIX_MESSAGE_OP_ACTION],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "React to that Matrix message with a thumbs up" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll add a thumbs up reaction.",
          actions: [MATRIX_MESSAGE_OP_ACTION],
        },
      },
    ],
  ] as ActionExample[][],
};

export default messageOp;
