import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  ProviderDataRecord,
  State,
} from "@elizaos/core";
import {
  cleanText,
  extractTargetRoom,
  type TechnocoreService,
} from "../services/technocore";

function getTechnocoreService(runtime: IAgentRuntime): TechnocoreService {
  const service = runtime.getService?.("technocore") as
    | TechnocoreService
    | undefined;
  if (!service) {
    throw new Error(
      "TechnocoreService is not registered or initialized in the runtime. Ensure technocorePlugin is added to plugins.",
    );
  }
  return service;
}

export const readRoomAction: Action = {
  name: "TECHNOCORE_READ_ROOM",
  similes: [
    "FETCH_TECHNOCORE_ROOM",
    "GET_TECHNOCORE_MESSAGES",
    "CHECK_TECHNOCORE_FEED",
    "LIST_TECHNOCORE_CHAT",
  ],
  description:
    "Fetches recent signed messages from a Technocore decentralized chat room.",
  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const text = message.content?.text || "";
    return /read\s+room|fetch\s+messages|technocore\s+messages|check\s+room/i.test(
      text,
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const defaultRoom =
        (runtime.getSetting?.("TECHNOCORE_DEFAULT_ROOM") as string) ||
        "technocore";

      const text = message.content?.text || "";
      const structuredRoom =
        ((message.content as Record<string, unknown>)?.room as string) ||
        (_options?.room as string);
      const targetRoom = extractTargetRoom(text, defaultRoom, structuredRoom);

      const service = getTechnocoreService(runtime);
      const result = await service.readRoom(targetRoom, 10);

      const messages = result.messages || [];
      const formatted = messages
        .slice(-5)
        .map(
          (m) =>
            `[Seq #${m.seq}] ${m.from.slice(0, 16)}...: ${cleanText(m.text)}`,
        )
        .join("\n");

      const responseText =
        messages.length > 0
          ? `Recent messages in /r/${targetRoom}:\n${formatted}`
          : `No messages found in /r/${targetRoom}.`;

      if (callback) {
        callback({ text: responseText, action: "TECHNOCORE_READ_ROOM" });
      }

      return {
        success: true,
        text: responseText,
        data: result as unknown as ProviderDataRecord,
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errMessage = `Failed to read Technocore room: ${errMsg}`;
      if (callback) {
        callback({ text: errMessage, error: true });
      }
      return {
        success: false,
        error: errMessage,
      };
    }
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "Read the latest messages from technocore room." },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Fetching latest messages from Technocore room '/r/technocore'...",
          action: "TECHNOCORE_READ_ROOM",
        },
      },
    ],
  ],
};
