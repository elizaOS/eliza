import {
  type Action,
  type ActionExample,
  type ActionResult,
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseKeyValueXml,
  type State,
} from "@elizaos/core";
import type { StreamChunkCallback } from "../../shared/types";
import { cleanPrompt, isCreatorMode } from "../../shared/utils/helpers";

const CHARACTER_BUILDER_CONTEXTS = ["general", "agent_internal"];
const TEST_RESPONSE_OUTPUT_MAX_CHARS = 4_000;
const TEST_RESPONSE_KEYWORDS = [
  "test",
  "respond",
  "response",
  "reply",
  "answer",
  "say",
  "roleplay",
  "simulate",
  "preview",
  "how would",
  "character",
  "probar",
  "responder",
  "respuesta",
  "contestar",
  "decir",
  "simular",
  "vista previa",
  "tester",
  "repondre",
  "reponse",
  "dire",
  "simuler",
  "apercu",
  "testen",
  "antworten",
  "antwort",
  "sagen",
  "simulieren",
  "vorschau",
  "testare",
  "rispondere",
  "risposta",
  "dire",
  "simulare",
  "anteprima",
  "testar",
  "responder",
  "resposta",
  "dizer",
  "simular",
  "预览",
  "测试",
  "回复",
  "回答",
  "模拟",
  "プレビュー",
  "テスト",
  "返答",
  "回答",
  "シミュレート",
];

function collectConversationText(message: Memory, state?: State): string {
  const parts: string[] = [];
  const text = message.content?.text;
  if (typeof text === "string") parts.push(text);
  for (const key of ["conversationLog", "recentMessages", "currentCharacter"]) {
    const value = state?.values?.[key];
    if (typeof value === "string") parts.push(value);
  }
  return parts.join("\n").toLowerCase();
}

function hasSelectedContext(state: State | undefined, contexts: string[]): boolean {
  const selected = [
    state?.data?.selectedContexts,
    state?.data?.activeContexts,
    state?.data?.contexts,
    state?.values?.selectedContexts,
    state?.values?.activeContexts,
    state?.values?.contexts,
  ].flatMap((value) => (Array.isArray(value) ? value : typeof value === "string" ? [value] : []));
  return selected.some((context) => contexts.includes(String(context).toLowerCase()));
}

function hasKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

function truncateTestResponseText(text: string): string {
  if (text.length <= TEST_RESPONSE_OUTPUT_MAX_CHARS) return text;
  return `${text.slice(0, TEST_RESPONSE_OUTPUT_MAX_CHARS)}\n\n[truncated test response]`;
}

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
  contexts: CHARACTER_BUILDER_CONTEXTS,
  contextGate: { anyOf: CHARACTER_BUILDER_CONTEXTS },
  parameters: [
    {
      name: "testPrompt",
      description: "The prompt to test against the current character voice.",
      required: false,
      schema: { type: "string" },
    },
  ],
  description:
    "User wants to test how the character would respond. Use when: 'how would you respond to...', 'test the character', 'let me see how they talk', 'show me how you'd answer', 'roleplay as the character'. Only available in build mode for existing characters. Simulates authentic character response.",
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    return (
      !isCreatorMode(runtime) &&
      (hasSelectedContext(state, CHARACTER_BUILDER_CONTEXTS) ||
        hasKeyword(collectConversationText(message, state), TEST_RESPONSE_KEYWORDS))
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: Record<string, unknown>,
    callback: HandlerCallback,
  ): Promise<ActionResult> => {
    const onStreamChunk = options?.onStreamChunk as StreamChunkCallback | undefined;
    logger.info(`[TEST_RESPONSE] Generating character test response, streaming=${!!onStreamChunk}`);

    // Verify we're in build mode
    if (isCreatorMode(runtime)) {
      logger.error("[TEST_RESPONSE] Called in creator mode");
      await callback({
        text: "Test Response is only available in **Edit Mode** after you've saved a character. Right now we're in Creator Mode - I'm Eliza, helping you design the character. Once you save it, you can test how they'd respond to specific prompts, or go to **Chat** to talk with them directly.",
        error: true,
      });
      return {
        success: false,
        text: "Test Response is only available in Edit Mode after you've saved a character.",
        error: "CREATOR_MODE",
        data: { actionName: "TEST_RESPONSE" },
      };
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

    let response: string;
    try {
      response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
    } catch (error) {
      runtime.character.system = originalSystemPrompt;
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, "[TEST_RESPONSE] Model call failed");
      const text = "I had trouble generating a test response. Could you try a different prompt?";
      await callback({ text, error: true });
      return {
        success: false,
        text,
        error: errorMessage,
        data: { actionName: "TEST_RESPONSE" },
      };
    } finally {
      runtime.character.system = originalSystemPrompt;
    }

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
      return {
        success: false,
        text: "I had trouble generating a test response. Could you try a different prompt?",
        error: "PARSE_FAILED",
        data: { actionName: "TEST_RESPONSE" },
      };
    }

    logger.debug("[TEST_RESPONSE] Test response generated successfully");
    const responseText = truncateTestResponseText(parsed.text);

    await callback({
      text: `*[Testing ${runtime.character.name}]*\n\n${responseText}`,
      thought: parsed.thought,
      metadata: {
        action: "TEST_RESPONSE",
        isTest: true,
        outputTruncated: responseText !== parsed.text,
      },
    });
    return {
      success: true,
      text: responseText,
      values: {
        success: true,
        isTest: true,
        characterName: runtime.character.name,
        outputTruncated: responseText !== parsed.text,
      },
      data: {
        actionName: "TEST_RESPONSE",
        characterName: runtime.character.name,
        thought: parsed.thought,
        outputTruncated: responseText !== parsed.text,
      },
    };
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
