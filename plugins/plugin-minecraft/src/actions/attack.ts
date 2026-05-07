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
import type { JsonValue } from "../protocol.js";
import { MINECRAFT_SERVICE_TYPE, type MinecraftService } from "../services/minecraft-service.js";
import { emit, mergedInput, readNumber } from "./helpers.js";

const ACTION_NAME = "MC_ATTACK";

function parseEntityId(params: Record<string, unknown>, text: string): number | null {
  const fromParams = readNumber(params, "entityId", "entity");
  if (fromParams !== null) return fromParams;
  const match = text.trim().match(/\b(?:entity\s*)?(\d+)\b/i);
  if (!match) return null;
  const entityId = Number(match[1]);
  return Number.isFinite(entityId) ? entityId : null;
}

export const minecraftAttackAction: Action = {
  name: ACTION_NAME,
  contexts: ["automation", "media"],
  contextGate: { anyOf: ["automation", "media"] },
  roleGate: { minRole: "USER" },
  similes: ["MC_HIT"],
  description: "Attack a Minecraft entity by id.",
  descriptionCompressed: "Attack entity by id.",
  parameters: [
    {
      name: "entityId",
      description: "Entity id to attack.",
      descriptionCompressed: "entity id",
      required: true,
      schema: { type: "number" },
    },
  ],
  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    if (!runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE)) return false;
    return /\b(attack|hit)\b/i.test(message.content.text ?? "");
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions | Record<string, JsonValue | undefined>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const service = runtime.getService<MinecraftService>(MINECRAFT_SERVICE_TYPE);
    if (!service) return { text: "Minecraft service is not available", success: false };

    const params = mergedInput(message, options);
    const entityId = parseEntityId(params, message.content.text ?? "");
    if (entityId === null) {
      return emit(ACTION_NAME, callback, "Missing entityId.", message.content.source, {
        success: false,
      });
    }

    try {
      await service.request("attack", { entityId });
      return await emit(
        ACTION_NAME,
        callback,
        `Attacked entity ${entityId}.`,
        message.content.source,
        { success: true }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return emit(ACTION_NAME, callback, `Attack failed: ${msg}`, message.content.source, {
        success: false,
        data: { error: msg },
      });
    }
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "Attack entity 42." } },
      {
        name: "{{agent}}",
        content: { text: "Attacking entity 42.", actions: [ACTION_NAME] },
      },
    ],
  ] as ActionExample[][],
};
