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

async function generateCastText(
  runtime: IAgentRuntime,
  message: Memory,
  isReply: boolean
): Promise<string> {
  const prompt = isReply
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
  description:
    "Post a public Farcaster cast, or reply to an existing cast when replyToHash is provided.",
  descriptionCompressed: "Farcaster cast: post or reply (with replyToHash).",
  contexts: ["social_posting", "connectors"],
  contextGate: { anyOf: ["social_posting", "connectors"] },
  roleGate: { minRole: "USER" },
  parameters: [
    {
      name: "text",
      description: "Cast text.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "replyToHash",
      description:
        "Hash of the parent cast. When set, posts as a reply; otherwise posts a new cast.",
      required: false,
      schema: { type: "string" },
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
    const optionText = readStringOption(options, "text");
    const replyToHash =
      readStringOption(options, "replyToHash") ??
      readStringOption(options, "parentCastHash") ??
      (typeof metadata?.parentCastHash === "string" ? metadata.parentCastHash : null);
    const parentFid =
      readNumberOption(options, "parentFid") ??
      (typeof metadata?.parentFid === "number" ? metadata.parentFid : null) ??
      getFarcasterFid(runtime);

    const isReply = Boolean(replyToHash);
    const generatedText = optionText ?? (await generateCastText(runtime, message, isReply));
    const castText = truncateCast(generatedText.trim());
    if (!castText) {
      return { success: false, error: "FARCASTER_CAST requires text" };
    }

    const cast = await castService.createCast({
      agentId: runtime.agentId,
      roomId: message.roomId ?? createUniqueUuid(runtime, "farcaster-timeline"),
      text: castText,
      replyTo:
        isReply && replyToHash && parentFid ? { hash: replyToHash, fid: parentFid } : undefined,
    });

    runtime.logger.info(
      { castId: cast.id, isReply, replyToHash },
      "[FARCASTER_CAST] Successfully published cast"
    );

    return {
      success: true,
      text: isReply ? `Replied with cast: ${cast.id}` : `Posted cast: ${cast.id}`,
      data: {
        isReply,
        castId: cast.id,
        castHash: cast.metadata?.castHash,
        text: castText,
        ...(replyToHash ? { replyToHash } : {}),
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
