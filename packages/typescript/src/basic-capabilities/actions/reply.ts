import { requireActionSpec } from "../../generated/spec-helpers.ts";
import { logger } from "../../logger.ts";
import { replyTemplate } from "../../prompts.ts";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "../../types/index.ts";
import { ModelType } from "../../types/index.ts";
import { composePromptFromState, parseKeyValueXml } from "../../utils.ts";

// Get text content from centralized specs
const spec = requireActionSpec("REPLY");

export const replyAction = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,
  validate: async (_runtime: IAgentRuntime) => {
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
    responses?: Memory[],
  ): Promise<ActionResult> => {
    const actionContext = _options?.actionContext;
    const previousResults = actionContext?.previousResults || [];

    if (previousResults.length > 0) {
      logger.debug(
        {
          src: "plugin:bootstrap:action:reply",
          agentId: runtime.agentId,
          count: previousResults.length,
        },
        "Found previous action results",
      );
    }

    const allProviders: string[] = [];
    if (responses) {
      for (const res of responses) {
        const providers = res.content?.providers;
        if (providers && providers.length > 0) {
          allProviders.push(...providers);
        }
      }
    }

    state = await runtime.composeState(message, [
      ...(allProviders ?? []),
      "RECENT_MESSAGES",
      "ACTION_STATE",
    ]);

    const prompt = composePromptFromState({
      state,
      template: runtime.character.templates?.replyTemplate || replyTemplate,
    });

    const response = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
    });

    const parsedXml = parseKeyValueXml(response);
    const thoughtValue = parsedXml?.thought;
    const textValue = parsedXml?.text;
    const thought: string =
      typeof thoughtValue === "string" ? thoughtValue : "";
    const text: string = typeof textValue === "string" ? textValue : "";

    const responseContent = {
      thought,
      text,
      actions: ["REPLY"] as string[],
    };

    if (callback) {
      await callback(responseContent);
    }

    const now = Date.now();
    return {
      text: `Generated reply: ${responseContent.text}`,
      values: {
        success: true,
        responded: true,
        lastReply: responseContent.text,
        lastReplyTime: now,
        thoughtProcess: thought,
      },
      data: {
        actionName: "REPLY",
        responseThought: thought,
        responseText: text,
        thought,
        messageGenerated: true,
      },
      success: true,
    };
  },
  examples: (spec.examples ?? []) as ActionExample[][],
} as Action;
