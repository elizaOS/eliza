import {
  type Action,
  type ActionExample,
  type ActionResult,
  createUniqueUuid,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import type { FarcasterService } from "../services/FarcasterService";
import { DEFAULT_MAX_CAST_LENGTH, FARCASTER_SERVICE_NAME } from "../types";
import { getFarcasterFid } from "../utils/config";

type FarcasterCastSubaction = "post" | "reply";

function readStringOption(
  options: Record<string, unknown> | undefined,
  key: string
): string | null {
  const value = options?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumberOption(
  options: Record<string, unknown> | undefined,
  key: string
): number | null {
  const value = options?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeSubaction(value: string | null): FarcasterCastSubaction | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "post" || normalized === "create" || normalized === "cast") {
    return "post";
  }
  if (normalized === "reply" || normalized === "respond") {
    return "reply";
  }
  return null;
}

function inferSubaction(message: Memory): FarcasterCastSubaction {
  const text = message.content.text?.toLowerCase() ?? "";
  if (/\b(reply|respond|answer|comment)\b/.test(text)) {
    return "reply";
  }
  return "post";
}

async function generateCastText(
  runtime: IAgentRuntime,
  message: Memory,
  subaction: FarcasterCastSubaction
): Promise<string> {
  const prompt =
    subaction === "reply"
      ? `Based on this request: "${message.content.text}", generate a helpful Farcaster cast reply under ${DEFAULT_MAX_CAST_LENGTH} characters.`
      : `Based on this request: "${message.content.text}", generate a concise Farcaster cast under ${DEFAULT_MAX_CAST_LENGTH} characters.`;

  const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
  return typeof response === "string" ? response : String(response);
}

function truncateCast(text: string): string {
  return text.length > DEFAULT_MAX_CAST_LENGTH
    ? `${text.substring(0, DEFAULT_MAX_CAST_LENGTH - 3)}...`
    : text;
}

export const farcasterCastAction: Action = {
  name: "FARCASTER_CAST",
  similes: ["SEND_CAST", "REPLY_TO_CAST", "POST_CAST", "FARCASTER_POST", "SHARE_ON_FARCASTER"],
  description: "Create or reply to a public Farcaster cast with subaction post or reply.",
  descriptionCompressed: "public Farcaster cast router; subaction post reply",
  parameters: [
    {
      name: "subaction",
      description: "post or reply.",
      required: true,
      schema: { type: "string", enum: ["post", "reply"] },
    },
    {
      name: "text",
      description: "Cast text.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "parentCastHash",
      description: "Parent cast hash for replies.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "parentFid",
      description: "Parent cast author FID for replies.",
      required: false,
      schema: { type: "number" },
    },
  ],
  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() || "";
    const hasKeyword = /\b(post|cast|share|announce|reply|respond|farcaster)\b/.test(text);
    const service = runtime.getService(FARCASTER_SERVICE_NAME) as FarcasterService;
    return hasKeyword && !!service?.getCastService(runtime.agentId);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: Record<string, unknown>
  ): Promise<ActionResult> => {
    const service = runtime.getService(FARCASTER_SERVICE_NAME) as FarcasterService;
    const castService = service?.getCastService(runtime.agentId);

    if (!castService) {
      runtime.logger.error("[FARCASTER_CAST] CastService not available");
      return { success: false, error: "CastService not available" };
    }

    const metadata = message.content.metadata as Record<string, unknown> | undefined;
    const subaction =
      normalizeSubaction(readStringOption(options, "subaction")) ?? inferSubaction(message);
    const optionText = readStringOption(options, "text");
    const parentCastHash =
      readStringOption(options, "parentCastHash") ??
      (typeof metadata?.parentCastHash === "string" ? metadata.parentCastHash : null);
    const parentFid =
      readNumberOption(options, "parentFid") ??
      (typeof metadata?.parentFid === "number" ? metadata.parentFid : null) ??
      getFarcasterFid(runtime);

    if (subaction === "reply" && !parentCastHash) {
      return { success: false, error: "FARCASTER_CAST reply requires parentCastHash" };
    }

    const generatedText = optionText ?? (await generateCastText(runtime, message, subaction));
    const castText = truncateCast(generatedText.trim());
    if (!castText) {
      return { success: false, error: "FARCASTER_CAST requires text" };
    }

    const cast = await castService.createCast({
      agentId: runtime.agentId,
      roomId: message.roomId ?? createUniqueUuid(runtime, "farcaster-timeline"),
      text: castText,
      replyTo:
        subaction === "reply" && parentCastHash && parentFid
          ? { hash: parentCastHash, fid: parentFid }
          : undefined,
    });

    runtime.logger.info(
      { castId: cast.id, subaction },
      "[FARCASTER_CAST] Successfully published cast"
    );

    return {
      success: true,
      text: subaction === "reply" ? `Replied with cast: ${cast.id}` : `Posted cast: ${cast.id}`,
      data: {
        subaction,
        castId: cast.id,
        castHash: cast.metadata?.castHash,
        text: castText,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Post a Farcaster cast about today's release." },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll draft and publish a cast.",
          actions: ["FARCASTER_CAST"],
        },
      },
    ],
  ] as ActionExample[][],
};
