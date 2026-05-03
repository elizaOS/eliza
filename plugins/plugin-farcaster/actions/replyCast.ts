import type { Action, IAgentRuntime, Memory, State } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import type { FarcasterService } from "../services/FarcasterService";
import { FARCASTER_SERVICE_NAME, FarcasterMessageType } from "../types";

const spec = requireActionSpec("REPLY_TO_CAST");

export const replyCastAction: Action = {
  name: spec.name,
  description: spec.description,
  examples: [
    [
      {
        name: "user",
        content: {
          text: "Someone asked about ElizaOS on Farcaster, can you reply?",
        },
      },
      {
        name: "assistant",
        content: {
          text: "I'll reply to their question about ElizaOS.",
          actions: ["REPLY_TO_CAST"],
        },
      },
    ],
    [
      {
        name: "user",
        content: { text: "Reply to that cast and thank them for the feedback" },
      },
      {
        name: "assistant",
        content: {
          text: "I'll reply with a thank you message.",
          actions: ["REPLY_TO_CAST"],
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["reply", "cast"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:reply|cast)\b/i;
    const __avRegexOk = Boolean(__avText.match(__avRegex));
    const __avSource = String(message?.content?.source ?? "");
    const __avExpectedSource = "farcaster";
    const __avSourceOk = __avExpectedSource
      ? __avSource === __avExpectedSource
      : Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
    const __avInputOk =
      __avText.trim().length > 0 ||
      Boolean(message?.content && typeof message.content === "object");

    if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
      return false;
    }

    const __avLegacyValidate = async (
      runtime: IAgentRuntime,
      message: Memory
    ): Promise<boolean> => {
      const text = message.content.text?.toLowerCase() || "";
      const keywords = ["reply", "respond", "answer", "comment"];

      const hasKeyword = keywords.some((keyword) => text.includes(keyword));

      const hasParentCast = !!(
        message.content.metadata &&
        (message.content.metadata as Record<string, unknown>).parentCastHash
      );

      const service = runtime.getService(FARCASTER_SERVICE_NAME) as FarcasterService;
      const isServiceAvailable = !!service?.getMessageService(runtime.agentId);

      return hasKeyword && (hasParentCast || isServiceAvailable);
    };
    try {
      return Boolean(await __avLegacyValidate(runtime, message));
    } catch {
      return false;
    }
  },

  handler: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    try {
      const service = runtime.getService(FARCASTER_SERVICE_NAME) as FarcasterService;
      const messageService = service?.getMessageService(runtime.agentId);

      if (!messageService) {
        runtime.logger.error("[REPLY_TO_CAST] MessageService not available");
        return { success: false, error: "MessageService not available" };
      }

      const metadata = message.content.metadata as Record<string, string | undefined> | undefined;
      const stateParentCastHash =
        typeof state?.parentCastHash === "string" ? state.parentCastHash : undefined;
      const parentCastHash = metadata?.parentCastHash ?? stateParentCastHash;

      if (!parentCastHash) {
        runtime.logger.error("[REPLY_TO_CAST] No parent cast to reply to");
        return { success: false, error: "No parent cast to reply to" };
      }

      let replyContent = "";

      if (state?.replyContent) {
        replyContent = state.replyContent as string;
      } else {
        const prompt = `Based on this request: "${message.content.text}", generate a helpful and engaging reply for a Farcaster cast (max 320 characters).`;

        const response = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt,
        });
        replyContent = typeof response === "string" ? response : String(response);
      }

      if (replyContent.length > 320) {
        replyContent = `${replyContent.substring(0, 317)}...`;
      }

      const reply = await messageService.sendMessage({
        agentId: runtime.agentId,
        roomId: message.roomId,
        text: replyContent,
        type: FarcasterMessageType.REPLY,
        replyToId: parentCastHash,
        metadata: {
          parentHash: parentCastHash,
        },
      });

      runtime.logger.info(`[REPLY_TO_CAST] Successfully replied to cast: ${reply.id}`);
      return { success: true, text: `Replied to cast: ${reply.id}` };
    } catch (error) {
      runtime.logger.error(
        "[REPLY_TO_CAST] Error replying to cast:",
        typeof error === "string" ? error : (error as Error).message
      );
      throw error;
    }
  },
};
