import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
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

export const currentCharacterProvider: Provider = {
  name: "CURRENT_CHARACTER",
  description:
    "Current character JSON for build mode (uses client-side state when available)",
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    const settings = runtime.character.settings as
      | Record<string, unknown>
      | undefined;
    const clientState = settings?.clientCharacterState as
      | ClientCharacterState
      | undefined;
    const isUnsaved = settings?.isClientStateUnsaved as boolean | undefined;

    // Check if we have client-side state from the frontend
    if (clientState) {
      const characterFields = {
        name: clientState.name || "",
        bio: clientState.bio || "",
        system: clientState.system || "",
        adjectives: clientState.adjectives || [],
        topics: clientState.topics || [],
        style: clientState.style || { all: [], chat: [], post: [] },
        messageExamples: clientState.messageExamples || [],
        avatarUrl: clientState.avatarUrl || "",
      };

      const characterJSON = JSON.stringify(characterFields, null, 2);
      const stateLabel = isUnsaved
        ? "(UNSAVED - client preview)"
        : "(from client)";

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
      const blankJSON = JSON.stringify(BLANK_CHARACTER_TEMPLATE, null, 2);

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
      adjectives: character.adjectives || [],
      topics: character.topics || [],
      style: character.style || { all: [], chat: [], post: [] },
      messageExamples: character.messageExamples || [],
    };

    const characterJSON = JSON.stringify(characterFields, null, 2);

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
        character,
        isNewCharacter: false,
        isClientState: false,
        isUnsaved: false,
      },
    };
  },
};
