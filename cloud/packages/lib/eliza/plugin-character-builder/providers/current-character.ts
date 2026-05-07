import {
  logger,
  type IAgentRuntime,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";
import { isCreatorMode } from "../../shared/utils/helpers";

/**
 * Current Character Provider
 *
 * Returns clean JSON of current character fields for build mode.
 * Priority:
 * 1. Client-side state (from frontend form) - what user currently sees
 * 2. Runtime character (from database) - saved state
 * 3. Blank template (for creator mode)
 */

const BLANK_CHARACTER_TEMPLATE = {
  name: "",
  bio: "",
  system: "",
  adjectives: [],
  topics: [],
  style: { all: [], chat: [], post: [] },
  messageExamples: [],
};

const CHARACTER_TEXT_LIMIT = 8000;
const CHARACTER_ARRAY_LIMIT = 30;
const MESSAGE_EXAMPLE_LIMIT = 12;

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...`;
}

function limitArray<T>(value: T[] | undefined, limit: number): T[] {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

interface ClientCharacterState {
  name?: string;
  bio?: string | string[];
  system?: string;
  adjectives?: string[];
  topics?: string[];
  style?: { all?: string[]; chat?: string[]; post?: string[] };
  messageExamples?: unknown[];
  avatarUrl?: string;
}

function limitStyle(
  style: ClientCharacterState["style"] | undefined,
): ClientCharacterState["style"] {
  return {
    all: limitArray(style?.all, CHARACTER_ARRAY_LIMIT),
    chat: limitArray(style?.chat, CHARACTER_ARRAY_LIMIT),
    post: limitArray(style?.post, CHARACTER_ARRAY_LIMIT),
  };
}

export const currentCharacterProvider: Provider = {
  name: "CURRENT_CHARACTER",
  description: "Current character JSON for build mode (uses client-side state when available)",
  contexts: ["general", "agent_internal"],
  contextGate: { anyOf: ["general", "agent_internal"] },
  cacheStable: false,
  cacheScope: "turn",
  roleGate: { minRole: "USER" },

  get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
    try {
      const settings = runtime.character.settings as Record<string, unknown> | undefined;
      const clientState = settings?.clientCharacterState as ClientCharacterState | undefined;
      const isUnsaved = settings?.isClientStateUnsaved as boolean | undefined;

      // Check if we have client-side state from the frontend
      if (clientState) {
        const characterFields = {
          name: clientState.name || "",
          bio: clientState.bio || "",
          system: clientState.system || "",
          adjectives: limitArray(clientState.adjectives, CHARACTER_ARRAY_LIMIT),
          topics: limitArray(clientState.topics, CHARACTER_ARRAY_LIMIT),
          style: limitStyle(clientState.style),
          messageExamples: limitArray(clientState.messageExamples, MESSAGE_EXAMPLE_LIMIT),
          avatarUrl: clientState.avatarUrl || "",
        };

        const stateLabel = isUnsaved ? "(UNSAVED - client preview)" : "(from client)";
        const characterJSON = truncateText(
          JSON.stringify(characterFields, null, 2),
          CHARACTER_TEXT_LIMIT,
        );

        return {
          text: `# Current Character State ${stateLabel}\n${characterJSON}`,
          values: {
            currentCharacter: characterJSON,
            isNewCharacter: isCreatorMode(runtime),
            isClientState: true,
            isUnsaved: isUnsaved ?? false,
          },
          data: {
            characterFields,
            isNewCharacter: isCreatorMode(runtime),
            isClientState: true,
            isUnsaved: isUnsaved ?? false,
          },
        };
      }

      // In creator mode without client state, show blank template
      if (isCreatorMode(runtime)) {
        const blankJSON = truncateText(
          JSON.stringify(BLANK_CHARACTER_TEMPLATE, null, 2),
          CHARACTER_TEXT_LIMIT,
        );

        return {
          text: `# New Character Template (blank)\n${blankJSON}`,
          values: {
            currentCharacter: blankJSON,
            isNewCharacter: true,
            isClientState: false,
            isUnsaved: true,
          },
          data: {
            characterFields: BLANK_CHARACTER_TEMPLATE,
            isNewCharacter: true,
            isClientState: false,
            isUnsaved: true,
          },
        };
      }

      // Fallback: use runtime character (from database)
      const character = runtime.character;

      const characterFields = {
        name: character.name || "",
        bio: character.bio || "",
        system: character.system || "",
        adjectives: limitArray(character.adjectives, CHARACTER_ARRAY_LIMIT),
        topics: limitArray(character.topics, CHARACTER_ARRAY_LIMIT),
        style: limitStyle(character.style),
        messageExamples: limitArray(character.messageExamples, MESSAGE_EXAMPLE_LIMIT),
      };
      const characterJSON = truncateText(
        JSON.stringify(characterFields, null, 2),
        CHARACTER_TEXT_LIMIT,
      );

      return {
        text: `# Current Character State (from database)\n${characterJSON}`,
        values: {
          currentCharacter: characterJSON,
          isNewCharacter: false,
          isClientState: false,
          isUnsaved: false,
        },
        data: {
          characterFields,
          character: {
            id: (character as { id?: unknown }).id,
            name: character.name,
          },
          isNewCharacter: false,
          isClientState: false,
          isUnsaved: false,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.error({ src: "provider:currentCharacter", err }, "Error in currentCharacterProvider");
      return {
        text: "",
        values: {
          currentCharacter: "",
          isNewCharacter: false,
          isClientState: false,
          isUnsaved: false,
        },
        data: {
          characterFields: {},
          isNewCharacter: false,
          isClientState: false,
          isUnsaved: false,
        },
      };
    }
  },
};
