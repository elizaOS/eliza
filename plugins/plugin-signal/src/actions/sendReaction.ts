import {
  type Action,
  type ActionExample,
  type ActionResult,
  composePromptFromState,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import {
  getMessageText,
  getSignalService,
  hasSignalService,
  hasStructuredSignalInvocation,
  isSignalConversation,
} from "./action-utils";

const sendReactionTemplate = `You are helping to extract reaction parameters for Signal.

The user wants to react to a Signal message with an emoji.

Recent conversation:
{{recentMessages}}

Extract the following:
1. emoji: The emoji to react with (single emoji character)
2. targetTimestamp: The timestamp of the message to react to (number)
3. targetAuthor: The phone number of the message author
4. remove: Whether to remove the reaction instead of adding it (default: false)

Respond with a JSON object like:
{
  "emoji": "👍",
  "targetTimestamp": 1234567890000,
  "targetAuthor": "+1234567890",
  "remove": false
}

Only respond with the JSON object, no other text.`;

export const sendReaction: Action = {
  name: "SIGNAL_SEND_REACTION",
  similes: ["REACT_SIGNAL", "SIGNAL_REACT", "ADD_SIGNAL_REACTION", "SIGNAL_EMOJI"],
  description: "React to a Signal message with an emoji",
  descriptionCompressed: "React to Signal message.",
  suppressPostActionContinuation: true,
  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    if (!hasSignalService(runtime)) {
      return false;
    }

    if (isSignalConversation(message)) {
      return true;
    }

    if (hasStructuredSignalInvocation(message, "SIGNAL_SEND_REACTION", ["emoji", "targetAuthor"])) {
      return true;
    }

    const text = getMessageText(message);
    return /\bsignal\b/i.test(text) && /\b(react|reaction|emoji)\b/i.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    const signalService = getSignalService(runtime);

    if (!signalService || !signalService.isServiceConnected()) {
      await callback?.({
        text: "Signal service is not available.",
        source: "signal",
      });
      return { success: false, error: "Signal service not available" };
    }

    const composedState: State = state ?? {
      values: {},
      data: {},
      text: "",
    };
    const prompt = composePromptFromState({
      state: composedState,
      template: sendReactionTemplate,
    });

    let reactionInfo: {
      emoji: string;
      targetTimestamp: number;
      targetAuthor: string;
      remove?: boolean;
    } | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsedResponse = parseJSONObjectFromText(response);
      if (
        parsedResponse?.emoji &&
        parsedResponse?.targetTimestamp &&
        parsedResponse?.targetAuthor
      ) {
        reactionInfo = {
          emoji: String(parsedResponse.emoji),
          targetTimestamp: Number(parsedResponse.targetTimestamp),
          targetAuthor: String(parsedResponse.targetAuthor),
          remove: Boolean(parsedResponse.remove),
        };
        break;
      }
    }

    if (!reactionInfo) {
      await callback?.({
        text: "I couldn't understand the reaction request. Please specify the emoji and message to react to.",
        source: "signal",
      });
      return { success: false, error: "Could not extract reaction parameters" };
    }

    const stateData = state?.data;
    const room = stateData?.room || (await runtime.getRoom(message.roomId));
    const recipient = room?.channelId || reactionInfo.targetAuthor;

    if (reactionInfo.remove) {
      await signalService.removeReaction(
        recipient,
        reactionInfo.emoji,
        reactionInfo.targetTimestamp,
        reactionInfo.targetAuthor
      );
    } else {
      await signalService.sendReaction(
        recipient,
        reactionInfo.emoji,
        reactionInfo.targetTimestamp,
        reactionInfo.targetAuthor
      );
    }

    const actionWord = reactionInfo.remove ? "removed" : "added";

    return {
      success: true,
      data: {
        emoji: reactionInfo.emoji,
        targetTimestamp: reactionInfo.targetTimestamp,
        targetAuthor: reactionInfo.targetAuthor,
        action: actionWord,
        suppressVisibleCallback: true,
        suppressActionResultClipboard: true,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "React to the last message with a thumbs up",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll add a thumbs up reaction.",
          actions: ["SIGNAL_SEND_REACTION"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default sendReaction;
