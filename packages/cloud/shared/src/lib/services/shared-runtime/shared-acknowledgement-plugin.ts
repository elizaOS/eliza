import {
  IMESSAGE_CLASSIC_REACTIONS,
  parseImessageReaction,
} from "@elizaos/contracts/imessage-reaction";
import type { Plugin } from "@elizaos/core";

/** A turn-local selection, never a provider target or permission to send text. */
export function createSharedAcknowledgementPlugin(
  select: (reaction: string | undefined) => void,
): Plugin {
  return {
    name: "shared-imessage-acknowledgement",
    description: "Optional native acknowledgement for an otherwise silent personal iMessage turn.",
    responseHandlerFieldEvaluators: [
      {
        name: "acknowledgementReaction",
        description:
          'Choose one classic reaction (love, like, dislike, laugh, emphasize, question) or one emoji only when shouldRespond is IGNORE and it naturally acknowledges a completed conversational turn. Otherwise choose "none". Never substitute a reaction for an unanswered question, assigned work, an explicit stop request, distress, bad news, or sensitive disclosure. This targets only the current inbound message; it cannot react to another message.',
        priority: 25,
        schema: {
          type: "string",
          description: `Optional reaction: ${IMESSAGE_CLASSIC_REACTIONS.join(", ")}, one Unicode emoji, or none.`,
        },
        parse: (value) => parseImessageReaction(value) ?? "none",
        handle: ({ value, parsed, turnSignal }) => {
          select(
            !turnSignal.aborted &&
              parseImessageReaction(value) !== undefined &&
              parsed.shouldRespond === "IGNORE" &&
              !parsed.replyText.trim() &&
              parsed.intents.length === 0 &&
              parsed.candidateActionNames.length === 0
              ? parseImessageReaction(value)
              : undefined,
          );
          return undefined;
        },
      },
    ],
  };
}
