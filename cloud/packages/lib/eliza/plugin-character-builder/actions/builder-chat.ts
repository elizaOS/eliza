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

/**
 * BUILDER_CHAT Action
 *
 * Main conversation action for understanding user intent.
 * Knows everything about building characters/assistants.
 * Helps user clarify what they want before SUGGEST_CHANGES kicks in.
 */

const creatorModeSystemPrompt = `# Character Creation Expert

{{modeContext}}

## What You Help Build

**Companions** - AI characters with personality, voice, and style. Great for creative projects, virtual influencers, roleplay characters, or just a fun AI friend.

**Assistants** - AI agents with capabilities. Upload documents (PDFs, transcripts, notes) to create a knowledge base. Enable MCP plugins for tools like search, calculations, or integrations.

**Hybrids** - Both personality AND capabilities. A character that can also do useful work.

## Best Practices

{{characterGuide}}

{{assistantGuide}}

## Your Role

Help users figure out what they want to build through conversation:
- Ask clarifying questions to understand their vision
- Explain concepts when they're confused (use the best practices above)
- Guide them toward a clear direction
- Once intent is clear, summarize what you'll build together

Be helpful, encouraging, and knowledgeable. Don't overwhelm - answer what's asked.

Never use emojis in your response.

# Output Format

<response>
  <thought>What does the user need? Am I still learning their intent or ready to suggest building?</thought>
  <text>Your helpful response</text>
</response>`;

const buildModeSystemPrompt = `# Character Refinement Assistant

{{modeContext}}

**Your Identity:**
{{system}}

**Your Role:**
While maintaining your character's personality, help the user:
- Understand your current configuration
- Discuss potential improvements
- Answer questions about character design
- Suggest next steps for refinement

Balance staying in character with being helpful about the building process.

# Output Format

<response>
  <thought>What's the user asking about? How can I help while staying in character?</thought>
  <text>Your response</text>
</response>`;

const chatTemplate = `
## Planning Context:
{{planningThought}}

# Current Character (what user sees on the form):
{{currentCharacter}}

Note: This is the LIVE state from the user's editor. If marked "(UNSAVED)", changes haven't been saved to the database yet. Always reference this state when discussing the character.

{{conversationLog}}

{{receivedMessageHeader}}`;

const CHARACTER_BUILDER_CONTEXTS = ["general", "agent_internal"];
const BUILDER_CHAT_OUTPUT_MAX_CHARS = 4_000;
const BUILDER_CHAT_KEYWORDS = [
  "help",
  "question",
  "explain",
  "companion",
  "assistant",
  "hybrid",
  "character",
  "agent",
  "build",
  "create",
  "design",
  "how",
  "what",
  "why",
  "hola",
  "ayuda",
  "pregunta",
  "explica",
  "personaje",
  "asistente",
  "crear",
  "construir",
  "aide",
  "question",
  "expliquer",
  "personnage",
  "assistant",
  "creer",
  "hilfe",
  "frage",
  "erklaren",
  "charakter",
  "assistent",
  "erstellen",
  "aiuto",
  "domanda",
  "spiega",
  "personaggio",
  "assistente",
  "creare",
  "ajuda",
  "pergunta",
  "explicar",
  "personagem",
  "assistente",
  "criar",
  "帮助",
  "问题",
  "解释",
  "角色",
  "助手",
  "创建",
  "質問",
  "説明",
  "キャラクター",
  "アシスタント",
  "作成",
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

function truncateBuilderChatText(text: string): string {
  if (text.length <= BUILDER_CHAT_OUTPUT_MAX_CHARS) return text;
  return `${text.slice(0, BUILDER_CHAT_OUTPUT_MAX_CHARS)}\n\n[truncated builder chat response]`;
}

export const builderChatAction = {
  name: "BUILDER_CHAT",
  contexts: CHARACTER_BUILDER_CONTEXTS,
  contextGate: { anyOf: CHARACTER_BUILDER_CONTEXTS },
  roleGate: { minRole: "USER" },
  parameters: [
    {
      name: "request",
      description: "The user's character-builder question or general builder chat request.",
      required: false,
      schema: { type: "string" },
    },
  ],
  description: `Conversation to understand user intent and explain building concepts.

USE when:
- User asks questions: "what's a companion?", "how do style directives work?"
- User needs clarification before you can build
- Early in conversation when intent isn't clear yet
- General chat and greetings

DO NOT USE when:
- User has clear intent and you should start building → use SUGGEST_CHANGES
- User confirms they want to save → use CREATE_CHARACTER or SAVE_CHANGES

This is your main tool for understanding what the user wants before taking action.`,
  validate: async (_runtime: IAgentRuntime, message: Memory, state?: State) => {
    return (
      hasSelectedContext(state, CHARACTER_BUILDER_CONTEXTS) ||
      hasKeyword(collectConversationText(message, state), BUILDER_CHAT_KEYWORDS)
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: Record<string, unknown>,
    callback: HandlerCallback,
  ): Promise<ActionResult> => {
    const creatorMode = isCreatorMode(runtime);
    const modeLabel = creatorMode ? "Creator" : "Build";
    const onStreamChunk = options?.onStreamChunk as StreamChunkCallback | undefined;

    logger.info(`[BUILDER_CHAT] ${modeLabel} mode conversation, streaming=${!!onStreamChunk}`);

    state = await runtime.composeState(message, [
      "SUMMARIZED_CONTEXT",
      "RECENT_MESSAGES",
      "CURRENT_CHARACTER",
      "CHARACTER_GUIDE",
      "ASSISTANT_GUIDE",
      "MODE_CONTEXT",
    ]);

    state.values = {
      ...state.values,
      modeLabel,
    };

    const originalSystemPrompt = runtime.character.system;

    const systemTemplate = creatorMode ? creatorModeSystemPrompt : buildModeSystemPrompt;
    runtime.character.system = cleanPrompt(
      composePromptFromState({ state, template: systemTemplate }),
    );

    const prompt = cleanPrompt(composePromptFromState({ state, template: chatTemplate }));

    let response: string;
    try {
      response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
    } catch (error) {
      runtime.character.system = originalSystemPrompt;
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, "[BUILDER_CHAT] Model call failed");
      const text = "I'm having trouble responding right now. What would you like to build?";
      await callback({ text, error: true });
      return {
        success: false,
        text,
        error: errorMessage,
        data: { actionName: "BUILDER_CHAT", mode: modeLabel },
      };
    } finally {
      runtime.character.system = originalSystemPrompt;
    }

    const parsed = parseKeyValueXml(response) as {
      thought?: string;
      text?: string;
    } | null;

    if (!parsed?.text) {
      logger.warn("[BUILDER_CHAT] Failed to parse response");
      await callback({
        text: "I'm here to help you build! What would you like to create?",
      });
      return {
        success: false,
        text: "I'm here to help you build! What would you like to create?",
        error: "PARSE_FAILED",
        data: { actionName: "BUILDER_CHAT", mode: modeLabel },
      };
    }

    const responseText = truncateBuilderChatText(parsed.text);

    await callback({
      text: responseText,
      thought: parsed.thought,
      metadata: {
        action: "BUILDER_CHAT",
        mode: modeLabel,
        outputTruncated: responseText !== parsed.text,
      },
    });
    return {
      success: true,
      text: responseText,
      values: {
        success: true,
        mode: modeLabel,
        outputTruncated: responseText !== parsed.text,
      },
      data: {
        actionName: "BUILDER_CHAT",
        mode: modeLabel,
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
          text: "What's the difference between a companion and assistant?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "A **companion** is personality-focused - think of it as creating a character with a unique voice, style, and backstory. Great for creative projects or just a fun AI to chat with.\n\nAn **assistant** is capability-focused - it uses knowledge bases and tools to actually do things. Upload your docs, connect APIs, enable search.\n\nYou can also build a **hybrid** that has both personality AND capabilities. What sounds right for what you have in mind?",
          actions: ["BUILDER_CHAT"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "I want to build something for my Discord server" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Nice! What kind of vibe are you going for? A few directions:\n\n- **Community manager** - helps moderate, answers FAQs, welcomes new members\n- **Fun character** - has personality, banters with members, adds entertainment\n- **Utility bot** - focused on tools and integrations\n\nWhat would be most useful for your server?",
          actions: ["BUILDER_CHAT"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "How do message examples work?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Message examples are how you teach your character's exact voice. They work through few-shot learning - the AI sees how your character responds and mimics that style.\n\nInclude 3-7 quality examples covering different scenarios: greetings, giving advice, handling questions. Quality matters more than quantity.\n\nWant me to help craft some examples for a character you have in mind?",
          actions: ["BUILDER_CHAT"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Why aren't you responding like the character I'm building?",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Right now you're in Creator Mode - I'm Eliza, helping you design your character. Think of me as the architect, and the character preview on the right is the blueprint we're building together.\n\nOnce you save the character, you can:\n- Enter **Edit Mode** to chat with the character while refining it\n- Go to **Chat** for full conversations with your agent\n- Use **Test Response** in Edit Mode to preview how they'd respond\n\nWant me to keep building, or are you ready to create and test it out?",
          actions: ["BUILDER_CHAT"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;
