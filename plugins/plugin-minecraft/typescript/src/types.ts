import { z } from "zod";
import type { JsonObject } from "./protocol.js";

export interface MinecraftSession {
  botId: string;
  createdAt: Date;
}

export interface MinecraftActionResult {
  success: boolean;
  data?: JsonObject;
  error?: string;
}

export const minecraftWorldStateSchema = z
  .object({
    connected: z.boolean(),
    username: z.string().nullable().optional(),
    version: z.string().nullable().optional(),
    health: z.number().nullable().optional(),
    food: z.number().nullable().optional(),
    experience: z.number().nullable().optional(),
    position: z
      .object({ x: z.number(), y: z.number(), z: z.number() })
      .nullable()
      .optional(),
    yaw: z.number().nullable().optional(),
    pitch: z.number().nullable().optional(),
    time: z.number().nullable().optional(),
    isRaining: z.boolean().nullable().optional(),
    inventory: z
      .array(
        z.object({
          name: z.string(),
          displayName: z.string(),
          count: z.number(),
          slot: z.number(),
        }),
      )
      .optional(),
    nearbyEntities: z
      .array(
        z.object({
          id: z.number(),
          type: z.string(),
          name: z.string().nullable(),
          username: z.string().nullable(),
          kind: z.string().nullable(),
          position: z.object({ x: z.number(), y: z.number(), z: z.number() }),
        }),
      )
      .optional(),
  })
  .passthrough();

export type MinecraftWorldState = z.infer<typeof minecraftWorldStateSchema>;
