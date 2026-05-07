/**
 * WALK_TO — moves the agent toward a world tile via
 * `ScapeGameService.executeAction("walkTo")`, which calls the xRSPS
 * bot-SDK and routes through the same `PlayerManager.moveAgent`
 * pathway human clients use.
 *
 * Expected LLM response format:
 *
 *   action: WALK_TO
 *   x: 3222
 *   z: 3218
 *   run: true
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { ScapeGameService } from "../services/game-service.js";
import { hasActionRequest, resolveActionText } from "../shared-state.js";
import { extractParamBool, extractParamInt } from "./param-parser.js";

export const walkTo: Action = {
  name: "WALK_TO",
  description:
    "Walk the agent toward a specific world tile (x, z). Use this to move to banks, NPCs, resource nodes, or just to explore.",
  descriptionCompressed: "Walk to coordinate.",
  contexts: ["game", "automation", "world", "state"],
  roleGate: { minRole: "ADMIN" },
  similes: ["MOVE_TO", "GO_TO", "TRAVEL_TO", "HEAD_TO"],
  examples: [],
  parameters: [
    {
      name: "x",
      description: "Target world X coordinate.",
      descriptionCompressed: "Target x.",
      required: true,
      schema: { type: "number" },
    },
    {
      name: "z",
      description: "Target world Z coordinate.",
      descriptionCompressed: "Target z.",
      required: true,
      schema: { type: "number" },
    },
    {
      name: "run",
      description: "Whether to run toward the target when possible.",
      descriptionCompressed: "Run toggle.",
      required: false,
      schema: { type: "boolean" },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    if (runtime.getService("scape_game") == null) return false;
    return hasActionRequest(message, "WALK_TO");
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = runtime.getService(
      "scape_game",
    ) as unknown as ScapeGameService | null;
    if (!service) {
      const errMsg = "'scape game service not available.";
      callback?.({ text: errMsg, action: "WALK_TO" });
      return { success: false, text: errMsg };
    }

    const text = resolveActionText(message);
    const x = extractParamInt(text, "x");
    const z = extractParamInt(text, "z");
    const run = extractParamBool(text, "run");

    if (x === null || z === null) {
      const errMsg =
        "WALK_TO requires x: N and z: N params. Example: x: 3222; z: 3218";
      callback?.({ text: errMsg, action: "WALK_TO" });
      return { success: false, text: errMsg };
    }

    try {
      const result = await service.executeAction({
        action: "walkTo",
        x,
        z,
        run,
      });

      const displayText =
        result.message ?? (result.success ? "walking..." : "walk failed");
      callback?.({ text: displayText, action: "WALK_TO" });
      return { success: result.success, text: displayText };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown walk failure.";
      const displayText = `walk failed: ${message}`;
      callback?.({ text: displayText, action: "WALK_TO" });
      return {
        success: false,
        text: displayText,
        error: message,
        data: { action: "walkTo", x, z, run },
      };
    }
  },
};
