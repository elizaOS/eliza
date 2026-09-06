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

export const postMessageAction: Action = {
  name: "TECHNOCORE_POST_MESSAGE",
  similes: [
    "SEND_TECHNOCORE_MESSAGE",
    "BROADCAST_TECHNOCORE",
    "POST_TO_TECHNOCORE_ROOM",
    "TECHNOCORE_SAY",
  ],
  description:
    "Cryptographically signs and posts a message to a decentralized Technocore room as an autonomous agent.",
  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const text = message.content?.text || "";
    return /technocore|broadcast|post\s+to\s+room/i.test(text);
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
      const result = await service.postMessage(targetRoom, text);

      const seq = result.posted?.seq || result.last_seq;
      const responseText = `Successfully broadcasted signed message to Technocore room '/r/${targetRoom}' (Sequence #${seq}, DID: ${service.did.slice(0, 24)}...)`;

      if (callback) {
        callback({ text: responseText, action: "TECHNOCORE_POST_MESSAGE" });
      }

      return {
        success: true,
        text: responseText,
        data: result as unknown as ProviderDataRecord,
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errMessage = `Failed to post message to Technocore: ${errMsg}`;
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
        content: {
          text: "Broadcast to technocore room that agent node is online.",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Broadcasting signed message to Technocore room '/r/technocore'...",
          action: "TECHNOCORE_POST_MESSAGE",
        },
      },
    ],
  ],
};
