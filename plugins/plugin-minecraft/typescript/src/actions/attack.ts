import type {
  Action,
  ActionResult,
  Content,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  MINECRAFT_SERVICE_TYPE,
  type MinecraftService,
} from "../services/minecraft-service.js";

function parseEntityId(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const id = Number(trimmed);
  return Number.isFinite(id) ? id : null;
}

export const minecraftAttackAction: Action = {
  name: "MC_ATTACK",
  similes: ["MINECRAFT_ATTACK", "HIT_ENTITY"],
  description:
    "Attack an entity by numeric entityId (from MC_WORLD_STATE.nearbyEntities).",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService<MinecraftService>(
      MINECRAFT_SERVICE_TYPE,
    );
    return (
      Boolean(service) && parseEntityId(message.content.text ?? "") !== null
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const service = runtime.getService<MinecraftService>(
      MINECRAFT_SERVICE_TYPE,
    );
    if (!service)
      return { text: "Minecraft service is not available", success: false };
    const entityId = parseEntityId(message.content.text ?? "");
    if (entityId === null) return { text: "Missing entityId", success: false };

    try {
      await service.request("attack", { entityId });
      const content: Content = {
        text: `Attacked entity ${entityId}.`,
        actions: ["MC_ATTACK"],
        source: message.content.source,
      };
      await callback?.(content);
      return { text: content.text ?? "", success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const content: Content = {
        text: `Failed to attack: ${msg}`,
        actions: ["MC_ATTACK"],
        source: message.content.source,
      };
      await callback?.(content);
      return { text: content.text ?? "", success: false };
    }
  },
};
