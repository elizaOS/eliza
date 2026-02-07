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
import type { StreamChunkCallback } from "../../shared/types";

/**
 * TEST_RESPONSE Action
 *
 * Simulates how the character would respond to a test prompt.
 * ONLY available in build mode (when editing an existing character).
 *
 * Purpose:
 * - Test the character's voice and personality
 * - See how changes affect responses
 * - Iterate on style before saving
 */

const testResponseSystemPrompt = `# Character Response Simulation (TEST MODE)
{{bio}}
{{system}}
{{messageDirections}}
{{adjectiveSentence}}
{{topicSentence}}

# Instructions
<instructions>
Respond EXACTLY as this character would respond to the user's message.
This is a TEST to help the user evaluate their character's voice and personality.

- Stay fully in character
- Use the character's voice, mannerisms, and style
- Don't break character or mention you're a simulation
- The response should feel authentic to the character
</instructions>

# Output Format:

<response>
  <thought>How would this character approach this message? What's their authentic reaction?</thought>
  <text>The character's natural response, fully in their voice and style</text>
</response>`;

const testResponseTemplate = `
## Character Name:
{{agentName}}

## Test Context:
This is a test to see how the character responds. Respond naturally as the character.

{{messageExamples}}

{{conversationLog}}

{{receivedMessageHeader}}`;

export const testResponseAction = {
  name: "TEST_RESPONSE",
  description:
    "User wants to test how the character would respond. Use when: 'how would you respond to...', 'test the character', 'let me see how they talk', 'show me how you'd answer', 'roleplay as the character'. Only available in build mode for existing characters. Simulates authentic character response.",
  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ) => {
    return !isCreatorMode(runtime);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: Record<string, unknown>,
    callback: HandlerCallback,
  ): Promise<void> => {
    const onStreamChunk = options?.onStreamChunk as
      | StreamChunkCallback
      | undefined;
    logger.info(
      `[TEST_RESPONSE] Generating character test response, streaming=${!!onStreamChunk}`,
    );

    // Verify we're in build mode
    if (isCreatorMode(runtime)) {
      logger.error("[TEST_RESPONSE] Called in creator mode");
      await callback({
        text: "Test Response is only available in **Edit Mode** after you've saved a character. Right now we're in Creator Mode - I'm Eliza, helping you design the character. Once you save it, you can test how they'd respond to specific prompts, or go to **Chat** to talk with them directly.",
        error: true,
      });
      return;
    }

    // Compose state with character identity
    state = await runtime.composeState(message, [
      "SUMMARIZED_CONTEXT",
      "RECENT_MESSAGES",
      "CURRENT_CHARACTER",
    ]);

    const originalSystemPrompt = runtime.character.system;

    // Compose system prompt with character identity
    const systemPrompt = cleanPrompt(
      composePromptFromState({
        state,
        template: testResponseSystemPrompt,
      }),
    );

    runtime.character.system = systemPrompt;

    // Compose prompt for test response
    const prompt = cleanPrompt(
      composePromptFromState({
        state,
        template: testResponseTemplate,
      }),
    );

    const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });

    // Restore original system prompt
    runtime.character.system = originalSystemPrompt;

    const parsed = parseKeyValueXml(response) as {
      thought?: string;
      text?: string;
    } | null;

    if (!parsed?.text) {
      logger.warn("[TEST_RESPONSE] Failed to parse response");
      await callback({
        text: "I had trouble generating a test response. Could you try a different prompt?",
        error: true,
      });
      return;
    }

    logger.debug("[TEST_RESPONSE] Test response generated successfully");

    await callback({
      text: `*[Testing ${runtime.character.name}]*\n\n${parsed.text}`,
      thought: parsed.thought,
      metadata: {
        action: "TEST_RESPONSE",
        isTest: true,
      },
    });
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "How would you respond to 'Hello, nice to meet you'?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "*[Testing current character]*\n\nHey there! Always great to meet someone new. What's on your mind?",
          actions: ["TEST_RESPONSE"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Test the character: What's your favorite thing to do?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "*[Testing current character]*\n\nOh, that's easy - I love diving into deep conversations about ideas that matter...",
          actions: ["TEST_RESPONSE"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Show me how you'd answer if someone asked for advice",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "*[Testing current character]*\n\nI'd start by understanding what you're actually dealing with...",
          actions: ["TEST_RESPONSE"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;
