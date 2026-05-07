/**
 * Helper functions to lookup action/provider/evaluator specs by name.
 * These allow language-specific implementations to import their text content
 * (description, similes, examples) from the centralized specs.
 *
 * DO NOT EDIT the spec data - update prompts/actions.json, prompts/providers.json, prompts/evaluators.json and regenerate.
 */

import {
  coreActionDocs,
  coreProviderDocs,
  coreEvaluatorDocs,
  allActionDocs,
  allProviderDocs,
  allEvaluatorDocs,
  type ActionDoc,
  type ProviderDoc,
  type EvaluatorDoc,
} from "./specs";

// Build lookup maps for O(1) access
const coreActionMap = new Map<string, ActionDoc>(
  coreActionDocs.map((doc) => [doc.name, doc])
);
const allActionMap = new Map<string, ActionDoc>(
  allActionDocs.map((doc) => [doc.name, doc])
);
const legacyActionSpecAliases: Readonly<
  Record<
    string,
    {
      target: string;
      description?: string;
      descriptionCompressed?: string;
      similes?: readonly string[];
    }
  >
> = {
  CHAT_WITH_ATTACHMENTS: {
    target: "DISCORD_CHAT_WITH_ATTACHMENTS",
  },
  DOWNLOAD_MEDIA: {
    target: "DISCORD_MEDIA_OP",
    description: "Download a media attachment or URL from Discord.",
    descriptionCompressed: "Download Discord media attachment or URL.",
    similes: ["DISCORD_DOWNLOAD_MEDIA", "DISCORD_FETCH_MEDIA", "DISCORD_SAVE_ATTACHMENT"],
  },
  TRANSCRIBE_MEDIA: {
    target: "DISCORD_MEDIA_OP",
    description: "Transcribe an audio or video attachment from Discord.",
    descriptionCompressed: "Transcribe Discord audio or video attachment.",
    similes: ["DISCORD_TRANSCRIBE_MEDIA", "DISCORD_AUDIO_TO_TEXT", "DISCORD_VIDEO_TRANSCRIPT"],
  },
  JOIN_CHANNEL: {
    target: "DISCORD_CHANNEL_OP",
    description: "Join a Discord voice or text channel.",
    descriptionCompressed: "Join Discord channel.",
    similes: ["DISCORD_JOIN_CHANNEL", "DISCORD_JOIN_VOICE"],
  },
  LEAVE_CHANNEL: {
    target: "DISCORD_CHANNEL_OP",
    description: "Leave a Discord voice or text channel.",
    descriptionCompressed: "Leave Discord channel.",
    similes: ["DISCORD_LEAVE_CHANNEL", "DISCORD_LEAVE_VOICE"],
  },
  LIST_CHANNELS: {
    target: "DISCORD_CHANNEL_OP",
    description: "List available Discord channels.",
    descriptionCompressed: "List Discord channels.",
    similes: ["DISCORD_LIST_CHANNELS", "DISCORD_SHOW_CHANNELS"],
  },
  READ_CHANNEL: {
    target: "DISCORD_CHANNEL_OP",
    description: "Read or summarize recent Discord channel messages.",
    descriptionCompressed: "Read recent Discord channel messages.",
    similes: ["DISCORD_READ_CHANNEL", "DISCORD_READ_MESSAGES", "DISCORD_SHOW_MESSAGES"],
  },
  SEARCH_MESSAGES: {
    target: "DISCORD_CHANNEL_OP",
    description: "Search Discord messages in a channel.",
    descriptionCompressed: "Search Discord channel messages.",
    similes: ["DISCORD_SEARCH_MESSAGES", "DISCORD_FIND_MESSAGES"],
  },
  SEND_MESSAGE: {
    target: "DISCORD_MESSAGE_OP",
    description: "Send a message to a Discord channel.",
    descriptionCompressed: "Send Discord channel message.",
    similes: ["DISCORD_SEND_MESSAGE", "DISCORD_POST_MESSAGE", "DISCORD_MESSAGE_CHANNEL"],
  },
  SEND_DM: {
    target: "DISCORD_MESSAGE_OP",
    description: "Send a direct message to a Discord user.",
    descriptionCompressed: "Send Discord DM.",
    similes: ["DISCORD_SEND_DM", "DISCORD_DIRECT_MESSAGE", "DISCORD_DM_USER"],
  },
  PIN_MESSAGE: {
    target: "DISCORD_MESSAGE_OP",
    description: "Pin a Discord message.",
    descriptionCompressed: "Pin Discord message.",
    similes: ["DISCORD_PIN_MESSAGE"],
  },
  UNPIN_MESSAGE: {
    target: "DISCORD_MESSAGE_OP",
    description: "Unpin a Discord message.",
    descriptionCompressed: "Unpin Discord message.",
    similes: ["DISCORD_UNPIN_MESSAGE"],
  },
  REACT_TO_MESSAGE: {
    target: "DISCORD_MESSAGE_OP",
    description: "React to a Discord message with an emoji.",
    descriptionCompressed: "React to Discord message.",
    similes: ["DISCORD_REACT_TO_MESSAGE", "DISCORD_ADD_REACTION"],
  },
  SUMMARIZE_CONVERSATION: {
    target: "DISCORD_SUMMARIZE_CONVERSATION",
  },
  CREATE_POLL: {
    target: "DISCORD_CREATE_POLL",
  },
  GET_USER_INFO: {
    target: "DISCORD_GET_USER_INFO",
  },
  SERVER_INFO: {
    target: "DISCORD_GET_USER_INFO",
    description: "Get Discord server or guild information.",
    descriptionCompressed: "Get Discord server info.",
    similes: ["DISCORD_SERVER_INFO", "DISCORD_GUILD_INFO"],
  },
};
const coreProviderMap = new Map<string, ProviderDoc>(
  coreProviderDocs.map((doc) => [doc.name, doc])
);
const allProviderMap = new Map<string, ProviderDoc>(
  allProviderDocs.map((doc) => [doc.name, doc])
);
const coreEvaluatorMap = new Map<string, EvaluatorDoc>(
  coreEvaluatorDocs.map((doc) => [doc.name, doc])
);
const allEvaluatorMap = new Map<string, EvaluatorDoc>(
  allEvaluatorDocs.map((doc) => [doc.name, doc])
);

function getLegacyActionSpec(name: string): ActionDoc | undefined {
  const alias = legacyActionSpecAliases[name];
  if (!alias) {
    return undefined;
  }
  const target = coreActionMap.get(alias.target) ?? allActionMap.get(alias.target);
  if (!target) {
    return undefined;
  }
  return {
    ...target,
    name,
    description: alias.description ?? target.description,
    descriptionCompressed:
      alias.descriptionCompressed ?? target.descriptionCompressed,
    similes: alias.similes ?? target.similes,
  };
}

/**
 * Get an action spec by name from the core specs.
 * @param name - The action name
 * @returns The action spec or undefined if not found
 */
export function getActionSpec(name: string): ActionDoc | undefined {
  return coreActionMap.get(name) ?? allActionMap.get(name) ?? getLegacyActionSpec(name);
}

/**
 * Get an action spec by name, throwing if not found.
 * @param name - The action name
 * @returns The action spec
 * @throws Error if the action is not found
 */
export function requireActionSpec(name: string): ActionDoc {
  const spec = getActionSpec(name);
  if (!spec) {
    throw new Error(`Action spec not found: ${name}`);
  }
  return spec;
}

/**
 * Get a provider spec by name from the core specs.
 * @param name - The provider name
 * @returns The provider spec or undefined if not found
 */
export function getProviderSpec(name: string): ProviderDoc | undefined {
  return coreProviderMap.get(name) ?? allProviderMap.get(name);
}

/**
 * Get a provider spec by name, throwing if not found.
 * @param name - The provider name
 * @returns The provider spec
 * @throws Error if the provider is not found
 */
export function requireProviderSpec(name: string): ProviderDoc {
  const spec = getProviderSpec(name);
  if (!spec) {
    throw new Error(`Provider spec not found: ${name}`);
  }
  return spec;
}

/**
 * Get an evaluator spec by name from the core specs.
 * @param name - The evaluator name
 * @returns The evaluator spec or undefined if not found
 */
export function getEvaluatorSpec(name: string): EvaluatorDoc | undefined {
  return coreEvaluatorMap.get(name) ?? allEvaluatorMap.get(name);
}

/**
 * Get an evaluator spec by name, throwing if not found.
 * @param name - The evaluator name
 * @returns The evaluator spec
 * @throws Error if the evaluator is not found
 */
export function requireEvaluatorSpec(name: string): EvaluatorDoc {
  const spec = getEvaluatorSpec(name);
  if (!spec) {
    throw new Error(`Evaluator spec not found: ${name}`);
  }
  return spec;
}

// Re-export types for convenience
export type { ActionDoc, ProviderDoc, EvaluatorDoc };
