import {
  type Action,
  type ActionExample,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  type UUID,
  logger,
  composePromptFromState,
  parseKeyValueXml,
  ModelType,
} from "@elizaos/core";
import { cleanPrompt, isCreatorMode } from "../../shared/utils/helpers";
import { isOnboarded, markOnboarded } from "../utils/onboarding-state";
import type { StreamChunkCallback } from "../../shared/types";

/**
 * GUIDE_ONBOARDING Action
 *
 * One-time welcome for new users in creator mode.
 * After running once, this action is disabled for the user.
 */

const onboardingSystemPrompt = `# AI Agent Builder - Welcome

You are Eliza, an AI agent builder assistant. This is the user's first time here - give them a warm welcome and brief intro.

## What You Help Build

**Companions** - AI characters with personality, voice, and style. Great for creative projects, virtual influencers, roleplay characters, or just a fun AI friend.

**Assistants** - AI agents with capabilities. Upload documents (PDFs, transcripts, notes) to create a knowledge base. Enable plugins for tools like search, calculations, or integrations.

**Hybrids** - Both personality AND capabilities. A character that can also do useful work.

## Instructions

Give a brief, friendly welcome. Mention the three types (companion, assistant, hybrid) and ask what they'd like to build.

Keep it short and inviting - don't overwhelm with details. They can ask follow-up questions.

Never use emojis in your response.

# Output Format

<response>
  <thought>First-time user, giving welcome intro</thought>
  <text>Your welcome message</text>
</response>`;

const onboardingTemplate = `
{{receivedMessageHeader}}`;

export const guideOnboardingAction = {
  name: "GUIDE_ONBOARDING",
  description: `First-time welcome for new users. Gives a brief intro to what's possible (companions, assistants, hybrids).

This action is ONLY available for users who haven't been onboarded yet.
After running once, it's disabled - use BUILDER_CHAT for follow-up questions.`,
  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State) => {
    if (!isCreatorMode(runtime)) return false;
    const onboarded = await isOnboarded(runtime, message.entityId as string);
    return !onboarded;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: Record<string, unknown>,
    callback: HandlerCallback,
  ): Promise<void> => {
    const entityId = message.entityId as string;
    const onStreamChunk = options?.onStreamChunk as
      | StreamChunkCallback
      | undefined;

    state = await runtime.composeState(message, ["RECENT_MESSAGES"]);

    const originalSystemPrompt = runtime.character.system;

    runtime.character.system = cleanPrompt(
      composePromptFromState({ state, template: onboardingSystemPrompt }),
    );

    const prompt = cleanPrompt(
      composePromptFromState({ state, template: onboardingTemplate }),
    );

    const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
    runtime.character.system = originalSystemPrompt;

    const parsed = parseKeyValueXml(response) as {
      thought?: string;
      text?: string;
    } | null;

    if (!parsed?.text) {
      logger.error("[GUIDE_ONBOARDING] Failed to generate response");
      await callback({
        text: "Welcome! I'm Eliza, and I help you build AI agents. Would you like to create a companion (personality-focused), assistant (capability-focused), or hybrid (both)?",
      });
      await markOnboarded(runtime, entityId);
      return;
    }

    await markOnboarded(runtime, entityId);

    await callback({
      text: parsed.text,
      thought: parsed.thought,
      metadata: {
        action: "GUIDE_ONBOARDING",
      },
    });
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Hi" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Hey! Welcome to the AI agent builder. I'm Eliza, and I'll help you create your own AI.\n\nYou can build:\n- **Companions** - personality-focused characters with unique voice\n- **Assistants** - capability-focused agents with tools and knowledge\n- **Hybrids** - both personality AND capabilities\n\nWhat sounds interesting to you?",
          actions: ["GUIDE_ONBOARDING"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;
