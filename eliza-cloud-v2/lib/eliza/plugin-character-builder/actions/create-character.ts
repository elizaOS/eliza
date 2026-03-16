import {
  type Action,
  type ActionExample,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from "@elizaos/core";
import { charactersService } from "@/lib/services/characters/characters";
import { roomsService } from "@/lib/services/agents/rooms";
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

export const createCharacterAction = {
  name: "CREATE_CHARACTER",
  description:
    "User has confirmed they want to save the character. ONLY use when: (1) a character definition exists in the UI with at least a name populated from previous SUGGEST_CHANGES, AND (2) user explicitly confirms with phrases like 'create it', 'save this', 'looks good', 'let's go'. Do NOT use if character JSON is empty or user is still exploring ideas.",
  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ) => {
    if (!isCreatorMode(runtime)) return false;

    // Check if we have client character state with at least a name
    const settings = runtime.character.settings as
      | Record<string, unknown>
      | undefined;
    const clientState = settings?.clientCharacterState as
      | ClientCharacterState
      | undefined;

    return Boolean(clientState?.name);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: Record<string, unknown>,
    callback: HandlerCallback,
  ): Promise<void> => {
    logger.info("[CREATE_CHARACTER] Storing character from UI state");

    // Verify we're in creator mode
    if (!isCreatorMode(runtime)) {
      logger.error("[CREATE_CHARACTER] Called outside creator mode");
      await callback({
        text: "I can only create new characters when you're in creator mode. To update an existing character, use the save action.",
        error: true,
      });
      return;
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
      return;
    }

    // Get the client character state - this is what the UI currently shows
    const clientState = settings.clientCharacterState as
      | ClientCharacterState
      | undefined;

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
      return;
    }

    logger.info(`[CREATE_CHARACTER] Creating character: ${clientState.name}`);

    // Create the character in the database using the UI state
    const savedCharacter = await charactersService.create({
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

    if (!savedCharacter?.id) {
      logger.error("[CREATE_CHARACTER] Failed to save character to database");
      await callback({
        text: "There was an error saving your character. Please try again.",
        error: true,
      });
      return;
    }

    logger.info(
      `[CREATE_CHARACTER] Character created with ID: ${savedCharacter.id}`,
    );

    // Lock the room - this creator session is complete
    const roomId = message.roomId;
    if (roomId) {
      await roomsService.updateMetadata(roomId, {
        locked: true,
        createdCharacterId: savedCharacter.id,
        createdCharacterName: savedCharacter.name,
        lockedAt: Date.now(),
      });
    }

    // Callback with success and character ID for frontend redirect
    await callback({
      text: `Done! I've saved ${savedCharacter.name}. You can now enter **Edit Mode** to chat with your character while refining them, or go to **Chat** for a full conversation. In Edit Mode, you can also use **Test Response** to preview how they'd answer specific prompts.`,
      metadata: {
        action: "CREATE_CHARACTER",
        characterCreated: true,
        characterId: savedCharacter.id,
        characterName: savedCharacter.name,
        roomLocked: true,
      },
    });
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
