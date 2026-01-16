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

const scanSchema = z
  .object({
    blocks: z.array(z.string()).optional(),
    radius: z.number().int().positive().optional(),
    maxResults: z.number().int().positive().optional(),
  })
  .passthrough();

function parseScan(text: string): {
  blocks?: string[];
  radius?: number;
  maxResults?: number;
} {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      blocks?: unknown;
      radius?: unknown;
      maxResults?: unknown;
    };
    const validated = scanSchema.parse({
      blocks: Array.isArray(parsed.blocks)
        ? parsed.blocks.filter((b) => typeof b === "string")
        : undefined,
      radius: typeof parsed.radius === "number" ? parsed.radius : undefined,
      maxResults:
        typeof parsed.maxResults === "number" ? parsed.maxResults : undefined,
    });
    return {
      blocks: validated.blocks,
      radius: validated.radius,
      maxResults: validated.maxResults,
    };
  } catch {
    return {};
  }
}

export const minecraftScanAction: Action = {
  name: "MC_SCAN",
  similes: ["MINECRAFT_SCAN", "FIND_BLOCKS", "SCAN_BLOCKS"],
  description:
    'Scan nearby blocks. Optional JSON input: {"blocks":["oak_log"],"radius":16,"maxResults":32}. If omitted, scans for any non-air blocks.',
  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const service = runtime.getService<MinecraftService>(
      MINECRAFT_SERVICE_TYPE,
    );
    return Boolean(service);
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

    try {
      const params = parseScan(message.content.text ?? "");
      const data = await service.request("scan", {
        ...(params.blocks ? { blocks: params.blocks } : {}),
        ...(typeof params.radius === "number" ? { radius: params.radius } : {}),
        ...(typeof params.maxResults === "number"
          ? { maxResults: params.maxResults }
          : {}),
      });

      const blocks = Array.isArray(data.blocks) ? data.blocks : [];
      const content: Content = {
        text: `Scan found ${blocks.length} blocks.`,
        actions: ["MC_SCAN"],
        source: message.content.source,
      };
      await callback?.(content);

      return {
        text: content.text ?? "",
        success: true,
        data,
        values: { count: blocks.length },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const content: Content = {
        text: `Scan failed: ${msg}`,
        actions: ["MC_SCAN"],
        source: message.content.source,
      };
      await callback?.(content);
      return { text: content.text ?? "", success: false };
    }
  },
};
