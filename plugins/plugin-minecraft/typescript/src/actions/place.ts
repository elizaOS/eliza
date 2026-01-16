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
import { z } from "zod";
import {
  MINECRAFT_SERVICE_TYPE,
  type MinecraftService,
} from "../services/minecraft-service.js";

const placeSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  face: z.enum(["up", "down", "north", "south", "east", "west"]),
});

function parsePlace(
  text: string,
): { x: number; y: number; z: number; face: string } | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as {
        x?: number;
        y?: number;
        z?: number;
        face?: string;
      };
      const v = placeSchema.parse(parsed);
      return v;
    } catch {
      return null;
    }
  }

  const m = trimmed.match(
    /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(up|down|north|south|east|west)\b/i,
  );
  if (!m) return null;
  const x = Number(m[1]);
  const y = Number(m[2]);
  const zVal = Number(m[3]);
  const face = m[4].toLowerCase();
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zVal))
    return null;
  return { x, y, z: zVal, face };
}

export const minecraftPlaceAction: Action = {
  name: "MC_PLACE",
  similes: ["MINECRAFT_PLACE", "PLACE_BLOCK"],
  description:
    "Place the currently-held block onto a reference block face. Provide 'x y z face' (face=up/down/north/south/east/west) or JSON {x,y,z,face}.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService<MinecraftService>(
      MINECRAFT_SERVICE_TYPE,
    );
    return Boolean(service) && Boolean(parsePlace(message.content.text ?? ""));
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

    const req = parsePlace(message.content.text ?? "");
    if (!req)
      return { text: "Missing placement target (x y z face)", success: false };

    try {
      await service.request("place", {
        x: req.x,
        y: req.y,
        z: req.z,
        face: req.face,
      });
      const content: Content = {
        text: `Placed block at (${req.x}, ${req.y}, ${req.z}) face=${req.face}.`,
        actions: ["MC_PLACE"],
        source: message.content.source,
      };
      await callback?.(content);
      return { text: content.text ?? "", success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const content: Content = {
        text: `Failed to place: ${msg}`,
        actions: ["MC_PLACE"],
        source: message.content.source,
      };
      await callback?.(content);
      return { text: content.text ?? "", success: false };
    }
  },
};
