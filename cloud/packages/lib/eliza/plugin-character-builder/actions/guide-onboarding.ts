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
import { isOnboarded, markOnboarded } from "../utils/onboarding-state";

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

const CHARACTER_BUILDER_CONTEXTS = ["general", "agent_internal"];
const ONBOARDING_KEYWORDS = [
  "hi",
  "hello",
  "hey",
  "start",
  "begin",
  "new",
  "first",
  "onboarding",
  "help",
  "build",
  "create",
  "hola",
  "buenas",
  "empezar",
  "nuevo",
  "ayuda",
  "crear",
  "bonjour",
  "salut",
  "commencer",
  "nouveau",
  "aide",
  "creer",
  "hallo",
  "starten",
  "neu",
  "hilfe",
  "erstellen",
  "ciao",
  "iniziare",
  "nuovo",
  "aiuto",
  "creare",
  "ola",
  "comecar",
  "novo",
  "ajuda",
  "criar",
  "你好",
  "开始",
  "新",
  "帮助",
  "こんにちは",
  "開始",
  "新規",
  "ヘルプ",
];

function collectConversationText(message: Memory, state?: State): string {
  const parts: string[] = [];
  const text = message.content?.text;
  if (typeof text === "string") parts.push(text);
  for (const key of ["conversationLog", "recentMessages", "receivedMessageHeader"]) {
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

export const guideOnboardingAction = {
  name: "GUIDE_ONBOARDING",
  contexts: CHARACTER_BUILDER_CONTEXTS,
  contextGate: { anyOf: CHARACTER_BUILDER_CONTEXTS },
  parameters: [
    {
      name: "request",
      description: "Optional first user message that triggered onboarding.",
      required: false,
      schema: { type: "string" },
    },
  ],
  description: `First-time welcome for new users. Gives a brief intro to what's possible (companions, assistants, hybrids).

This action is ONLY available for users who haven't been onboarded yet.
After running once, it's disabled - use BUILDER_CHAT for follow-up questions.`,
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    if (!isCreatorMode(runtime)) return false;
    const onboarded = await isOnboarded(runtime, message.entityId as string);
    return (
      !onboarded &&
      (hasSelectedContext(state, CHARACTER_BUILDER_CONTEXTS) ||
        hasKeyword(collectConversationText(message, state), ONBOARDING_KEYWORDS))
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: Record<string, unknown>,
    callback: HandlerCallback,
  ): Promise<ActionResult> => {
    const entityId = message.entityId as string;
    const _onStreamChunk = options?.onStreamChunk as StreamChunkCallback | undefined;

    state = await runtime.composeState(message, ["RECENT_MESSAGES"]);

    const originalSystemPrompt = runtime.character.system;

    runtime.character.system = cleanPrompt(
      composePromptFromState({ state, template: onboardingSystemPrompt }),
    );

    const prompt = cleanPrompt(composePromptFromState({ state, template: onboardingTemplate }));

    let response: string;
    try {
      response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
    } catch (error) {
      runtime.character.system = originalSystemPrompt;
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, "[GUIDE_ONBOARDING] Model call failed");
      const text =
        "Welcome! I'm Eliza, and I help you build AI agents. Would you like to create a companion, assistant, or hybrid?";
      await callback({ text, error: true });
      return {
        success: false,
        text,
        error: errorMessage,
        data: { actionName: "GUIDE_ONBOARDING" },
      };
    } finally {
      runtime.character.system = originalSystemPrompt;
    }

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
      return {
        success: false,
        text: "Welcome! I'm Eliza, and I help you build AI agents. Would you like to create a companion, assistant, or hybrid?",
        error: "PARSE_FAILED",
        data: { actionName: "GUIDE_ONBOARDING" },
      };
    }

    await markOnboarded(runtime, entityId);

    await callback({
      text: parsed.text,
      thought: parsed.thought,
      metadata: {
        action: "GUIDE_ONBOARDING",
      },
    });
    return {
      success: true,
      text: parsed.text,
      values: { success: true, onboarded: true },
      data: { actionName: "GUIDE_ONBOARDING", thought: parsed.thought },
    };
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
