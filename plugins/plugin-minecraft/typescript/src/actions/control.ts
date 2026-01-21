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

const controlSchema = z.object({
  control: z.string(),
  state: z.boolean(),
  durationMs: z.number().int().positive().optional(),
});

function parseControl(
  text: string,
): { control: string; state: boolean; durationMs?: number } | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as {
        control?: string;
        state?: boolean;
        durationMs?: number;
      };
      return controlSchema.parse(parsed);
    } catch {
      return null;
    }
  }
  const m = trimmed.match(/^(\S+)\s+(true|false)(?:\s+(\d+))?$/i);
  if (!m) return null;
  const control = m[1];
  const state = m[2].toLowerCase() === "true";
  const durationMs = m[3] ? Number(m[3]) : undefined;
  if (durationMs !== undefined && !Number.isFinite(durationMs)) return null;
  return durationMs ? { control, state, durationMs } : { control, state };
}

export const minecraftControlAction: Action = {
  name: "MC_CONTROL",
  similes: ["MINECRAFT_CONTROL", "SET_CONTROL_STATE"],
  description:
    "Set a control state (e.g. forward/back/left/right/jump/sprint/sneak). Provide JSON {control,state,durationMs?} or 'forward true 1000'.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const service = runtime.getService<MinecraftService>(
      MINECRAFT_SERVICE_TYPE,
    );
    return (
      Boolean(service) && Boolean(parseControl(message.content.text ?? ""))
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

    const req = parseControl(message.content.text ?? "");
    if (!req) return { text: "Missing control command", success: false };

    try {
      await service.request("control", {
        control: req.control,
        state: req.state,
        ...(typeof req.durationMs === "number"
          ? { durationMs: req.durationMs }
          : {}),
      });
      const content: Content = {
        text: `Set control ${req.control}=${String(req.state)}${req.durationMs ? ` for ${req.durationMs}ms` : ""}.`,
        actions: ["MC_CONTROL"],
        source: message.content.source,
      };
      await callback?.(content);
      return { text: content.text ?? "", success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const content: Content = {
        text: `Failed to set control: ${msg}`,
        actions: ["MC_CONTROL"],
        source: message.content.source,
      };
      await callback?.(content);
      return { text: content.text ?? "", success: false };
    }
  },
};
