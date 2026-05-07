import {
  type Action,
  type ActionExample,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import { roomsService } from "@/lib/services/agents/rooms";
import { charactersService } from "@/lib/services/characters/characters";
import { isCreatorMode } from "../../shared/utils/helpers";

/**
 * CREATE_CHARACTER Action
 *
 * Stores the current character JSON from the UI to the database.
 * ONLY available in creator mode (when chatting with Eliza).
 *
 * Prerequisites:
 * - clientCharacterState must be populated (via SUGGEST_CHANGES action)
 * - Character must have at least a name
 *
 * This action:
 * 1. Reads the current character state from clientCharacterState
 * 2. Creates the character in the database
 * 3. Signals to frontend to redirect to build mode
 */

interface ClientCharacterState {
  name?: string;
  username?: string;
  bio?: string | string[];
  system?: string;
  adjectives?: string[];
  topics?: string[];
  style?: { all?: string[]; chat?: string[]; post?: string[] };
  messageExamples?: Record<string, unknown>[][];
  postExamples?: string[];
  knowledge?: string[];
  plugins?: string[];
  settings?: Record<string, unknown>;
  secrets?: Record<string, string | boolean | number>;
  avatarUrl?: string;
}

const CHARACTER_BUILDER_CONTEXTS = ["general", "agent_internal"];
const CREATE_CHARACTER_TEXT_MAX_CHARS = 2_000;
const CREATE_CHARACTER_KEYWORDS = [
  "create",
  "save",
  "publish",
  "done",
  "confirm",
  "looks good",
  "let's go",
  "go ahead",
  "finish",
  "character",
  "agent",
  "crear",
  "guardar",
  "publicar",
  "listo",
  "confirmar",
  "personaje",
  "agente",
  "creer",
  "enregistrer",
  "publier",
  "terminer",
  "confirmer",
  "personnage",
  "agent",
  "erstellen",
  "speichern",
  "fertig",
  "bestatigen",
  "charakter",
  "agent",
  "creare",
  "salvare",
  "finito",
  "conferma",
  "personaggio",
  "agente",
  "criar",
  "salvar",
  "pronto",
  "confirmar",
  "personagem",
  "agente",
  "创建",
  "保存",
  "确认",
  "完成",
  "角色",
  "作成",
  "保存",
  "確認",
  "完了",
  "キャラクター",
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

function truncateCreateCharacterText(text: string): string {
  if (text.length <= CREATE_CHARACTER_TEXT_MAX_CHARS) return text;
  return `${text.slice(0, CREATE_CHARACTER_TEXT_MAX_CHARS)}\n\n[truncated create-character response]`;
}

export const createCharacterAction = {
  name: "CREATE_CHARACTER",
  contexts: CHARACTER_BUILDER_CONTEXTS,
  contextGate: { anyOf: CHARACTER_BUILDER_CONTEXTS },
  parameters: [
    {
      name: "confirmation",
      description: "The user's confirmation that the current character should be created.",
      required: false,
      schema: { type: "string" },
    },
  ],
  description:
    "User has confirmed they want to save the character. ONLY use when: (1) a character definition exists in the UI with at least a name populated from previous SUGGEST_CHANGES, AND (2) user explicitly confirms with phrases like 'create it', 'save this', 'looks good', 'let's go'. Do NOT use if character JSON is empty or user is still exploring ideas.",
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    if (!isCreatorMode(runtime)) return false;

    // Check if we have client character state with at least a name
    const settings = runtime.character.settings as Record<string, unknown> | undefined;
    const clientState = settings?.clientCharacterState as ClientCharacterState | undefined;

    return (
      Boolean(clientState?.name) &&
      (hasSelectedContext(state, CHARACTER_BUILDER_CONTEXTS) ||
        hasKeyword(collectConversationText(message, state), CREATE_CHARACTER_KEYWORDS))
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: Record<string, unknown>,
    callback: HandlerCallback,
  ): Promise<ActionResult> => {
    logger.info("[CREATE_CHARACTER] Storing character from UI state");

    // Verify we're in creator mode
    if (!isCreatorMode(runtime)) {
      logger.error("[CREATE_CHARACTER] Called outside creator mode");
      await callback({
        text: "I can only create new characters when you're in creator mode. To update an existing character, use the save action.",
        error: true,
      });
      return {
        success: false,
        text: "I can only create new characters when you're in creator mode. To update an existing character, use the save action.",
        error: "NOT_CREATOR_MODE",
        data: { actionName: "CREATE_CHARACTER" },
      };
    }

    // Get user context from runtime settings
    const settings = runtime.character.settings as Record<string, unknown>;
    const userId = settings.USER_ID as string;
    const organizationId = settings.ORGANIZATION_ID as string;

    if (!userId) {
      logger.error("[CREATE_CHARACTER] No USER_ID in runtime settings");
      await callback({
        text: "Unable to create character: User context is missing.",
        error: true,
      });
      return {
        success: false,
        text: "Unable to create character: User context is missing.",
        error: "MISSING_USER_CONTEXT",
        data: { actionName: "CREATE_CHARACTER" },
      };
    }

    // Get the client character state - this is what the UI currently shows
    const clientState = settings.clientCharacterState as ClientCharacterState | undefined;

    if (!clientState?.name) {
      logger.error("[CREATE_CHARACTER] No character state or name in UI");
      await callback({
        text: "I don't have a character to save yet. Let me help you design one first - what kind of character would you like to create?",
        error: true,
        metadata: {
          action: "CREATE_CHARACTER",
          shouldSuggest: true,
        },
      });
      return {
        success: false,
        text: "I don't have a character to save yet.",
        error: "MISSING_CHARACTER_STATE",
        data: { actionName: "CREATE_CHARACTER", shouldSuggest: true },
      };
    }

    logger.info(`[CREATE_CHARACTER] Creating character: ${clientState.name}`);

    let savedCharacter;
    try {
      // Create the character in the database using the UI state
      savedCharacter = await charactersService.create({
        name: clientState.name,
        username: clientState.username || undefined,
        user_id: userId,
        organization_id: organizationId,
        system: clientState.system || undefined,
        bio: clientState.bio || [],
        adjectives: clientState.adjectives || undefined,
        topics: clientState.topics || undefined,
        style: clientState.style || undefined,
        message_examples: clientState.messageExamples || undefined,
        post_examples: clientState.postExamples || undefined,
        knowledge: clientState.knowledge || undefined,
        plugins: clientState.plugins || undefined,
        settings: clientState.settings || undefined,
        secrets: clientState.secrets || undefined,
        character_data: {},
        is_public: false,
        is_template: false,
        featured: false,
        source: "cloud",
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, "[CREATE_CHARACTER] Database create failed");
      await callback({
        text: "There was an error saving your character. Please try again.",
        error: true,
      });
      return {
        success: false,
        text: "There was an error saving your character. Please try again.",
        error: errorMessage,
        data: { actionName: "CREATE_CHARACTER", characterName: clientState.name },
      };
    }

    if (!savedCharacter?.id) {
      logger.error("[CREATE_CHARACTER] Failed to save character to database");
      await callback({
        text: "There was an error saving your character. Please try again.",
        error: true,
      });
      return {
        success: false,
        text: "There was an error saving your character. Please try again.",
        error: "SAVE_FAILED",
        data: { actionName: "CREATE_CHARACTER", characterName: clientState.name },
      };
    }

    logger.info(`[CREATE_CHARACTER] Character created with ID: ${savedCharacter.id}`);

    // Lock the room - this creator session is complete
    const roomId = message.roomId;
    if (roomId) {
      try {
        await roomsService.updateMetadata(roomId, {
          locked: true,
          createdCharacterId: savedCharacter.id,
          createdCharacterName: savedCharacter.name,
          lockedAt: Date.now(),
        });
      } catch (error) {
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "[CREATE_CHARACTER] Failed to lock room after character create",
        );
      }
    }

    // Callback with success and character ID for frontend redirect
    const callbackText = truncateCreateCharacterText(
      `Done! I've saved ${savedCharacter.name}. You can now enter **Edit Mode** to chat with your character while refining them, or go to **Chat** for a full conversation. In Edit Mode, you can also use **Test Response** to preview how they'd answer specific prompts.`,
    );
    await callback({
      text: callbackText,
      metadata: {
        action: "CREATE_CHARACTER",
        characterCreated: true,
        characterId: savedCharacter.id,
        characterName: savedCharacter.name,
        roomLocked: true,
        outputTruncated: false,
      },
    });
    return {
      success: true,
      text: `Created character ${savedCharacter.name}.`,
      values: {
        success: true,
        characterCreated: true,
        characterId: savedCharacter.id,
        characterName: savedCharacter.name,
      },
      data: {
        actionName: "CREATE_CHARACTER",
        characterId: savedCharacter.id,
        characterName: savedCharacter.name,
        roomLocked: true,
        outputTruncated: false,
      },
    };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Create it! I'm happy with the character",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Done! I've saved your character. You'll now be redirected to continue building and refining them.",
          actions: ["CREATE_CHARACTER"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Save this character",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Done! Your character has been saved. Let's continue refining their personality.",
          actions: ["CREATE_CHARACTER"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Let's go, this looks good",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Your character is now created! You'll be redirected to the build mode to continue.",
          actions: ["CREATE_CHARACTER"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;
