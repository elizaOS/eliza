/**
 * Auto-generated canonical action/provider/evaluator docs for plugin-discord.
 * DO NOT EDIT - Generated from prompts/specs/**.
 */

export type ActionDoc = {
  name: string;
  description: string;
  similes?: readonly string[];
  parameters?: readonly unknown[];
  examples?: readonly (readonly unknown[])[];
};

export type ProviderDoc = {
  name: string;
  description: string;
  position?: number;
  dynamic?: boolean;
};

export type EvaluatorDoc = {
  name: string;
  description: string;
  similes?: readonly string[];
  alwaysRun?: boolean;
  examples?: readonly unknown[];
};

const pluginActionStubs: readonly ActionDoc[] = [
  { name: "SEND_DM", description: "Send a direct message to a user.", parameters: [] },
  { name: "SEARCH_MESSAGES", description: "Search messages in a channel.", parameters: [] },
  { name: "DOWNLOAD_MEDIA", description: "Download media from a message.", parameters: [] },
  { name: "SUMMARIZE_CONVERSATION", description: "Summarize a conversation.", parameters: [] },
  { name: "READ_CHANNEL", description: "Read messages from a channel.", parameters: [] },
  { name: "CREATE_POLL", description: "Create a poll in a channel.", parameters: [] },
  { name: "TRANSCRIBE_MEDIA", description: "Transcribe media.", parameters: [] },
  { name: "JOIN_CHANNEL", description: "Join a voice or text channel.", parameters: [] },
  { name: "CHAT_WITH_ATTACHMENTS", description: "Chat with attachments.", parameters: [] },
  { name: "LEAVE_CHANNEL", description: "Leave a channel.", parameters: [] },
  { name: "PIN_MESSAGE", description: "Pin a message.", parameters: [] },
  { name: "UNPIN_MESSAGE", description: "Unpin a message.", parameters: [] },
  { name: "GET_USER_INFO", description: "Get user information.", parameters: [] },
  { name: "REACT_TO_MESSAGE", description: "React to a message.", parameters: [] },
  { name: "LIST_CHANNELS", description: "List channels.", parameters: [] },
  { name: "SERVER_INFO", description: "Get server information.", parameters: [] },
];

export const coreActionsSpec = {
  "version": "1.0.0",
  "actions": [
    {
      "name": "name",
      "description": "",
      "parameters": []
    },
    {
      "name": "SEND_MESSAGE",
      "description": "Send a message to a channel",
      "parameters": [],
      "similes": []
    },
    {
      "name": "SEARCH_MESSAGES",
      "description": "Search messages in a channel",
      "parameters": [],
      "similes": []
    },
    {
      "name": "SUMMARIZE_CONVERSATION",
      "description": "Summarize a conversation",
      "parameters": [],
      "similes": []
    },
    {
      "name": "READ_CHANNEL",
      "description": "Read messages from a channel",
      "parameters": [],
      "similes": []
    },
    {
      "name": "SEND_DM",
      "description": "Send a direct message",
      "parameters": [],
      "similes": []
    },
    {
      "name": "TRANSCRIBE_MEDIA",
      "description": "Transcribe media content",
      "parameters": [],
      "similes": []
    },
    {
      "name": "LEAVE_CHANNEL",
      "description": "Leave a channel",
      "parameters": [],
      "similes": []
    },
    {
      "name": "PIN_MESSAGE",
      "description": "Pin a message",
      "parameters": [],
      "similes": []
    },
    {
      "name": "UNPIN_MESSAGE",
      "description": "Unpin a message",
      "parameters": [],
      "similes": []
    },
    {
      "name": "SERVER_INFO",
      "description": "Get server information",
      "parameters": [],
      "similes": []
    },
    {
      "name": "REACT_TO_MESSAGE",
      "description": "React to a message",
      "parameters": [],
      "similes": []
    },
    {
      "name": "LIST_CHANNELS",
      "description": "List channels",
      "parameters": [],
      "similes": []
    },
    {
      "name": "DOWNLOAD_MEDIA",
      "description": "Download media from a message",
      "parameters": [],
      "similes": []
    },
    {
      "name": "CREATE_POLL",
      "description": "Create a poll",
      "parameters": [],
      "similes": []
    },
    {
      "name": "JOIN_CHANNEL",
      "description": "Join a channel",
      "parameters": [],
      "similes": []
    },
    {
      "name": "CHAT_WITH_ATTACHMENTS",
      "description": "Send a message with attachments",
      "parameters": [],
      "similes": []
    },
    {
      "name": "GET_USER_INFO",
      "description": "Get user information",
      "parameters": [],
      "similes": []
    }
  ]
} as const;
export const allActionsSpec = {
  "version": "1.0.0",
  "actions": [
    {
      "name": "name",
      "description": "",
      "parameters": []
    },
    {
      "name": "SEND_MESSAGE",
      "description": "Send a message to a channel",
      "parameters": [],
      "similes": []
    },
    {
      "name": "SEARCH_MESSAGES",
      "description": "Search messages in a channel",
      "parameters": [],
      "similes": []
    },
    {
      "name": "SUMMARIZE_CONVERSATION",
      "description": "Summarize a conversation",
      "parameters": [],
      "similes": []
    },
    {
      "name": "READ_CHANNEL",
      "description": "Read messages from a channel",
      "parameters": [],
      "similes": []
    },
    {
      "name": "SEND_DM",
      "description": "Send a direct message",
      "parameters": [],
      "similes": []
    },
    {
      "name": "TRANSCRIBE_MEDIA",
      "description": "Transcribe media content",
      "parameters": [],
      "similes": []
    },
    {
      "name": "LEAVE_CHANNEL",
      "description": "Leave a channel",
      "parameters": [],
      "similes": []
    },
    {
      "name": "PIN_MESSAGE",
      "description": "Pin a message",
      "parameters": [],
      "similes": []
    },
    {
      "name": "UNPIN_MESSAGE",
      "description": "Unpin a message",
      "parameters": [],
      "similes": []
    },
    {
      "name": "SERVER_INFO",
      "description": "Get server information",
      "parameters": [],
      "similes": []
    },
    {
      "name": "REACT_TO_MESSAGE",
      "description": "React to a message",
      "parameters": [],
      "similes": []
    },
    {
      "name": "LIST_CHANNELS",
      "description": "List channels",
      "parameters": [],
      "similes": []
    },
    {
      "name": "DOWNLOAD_MEDIA",
      "description": "Download media from a message",
      "parameters": [],
      "similes": []
    },
    {
      "name": "CREATE_POLL",
      "description": "Create a poll",
      "parameters": [],
      "similes": []
    },
    {
      "name": "JOIN_CHANNEL",
      "description": "Join a channel",
      "parameters": [],
      "similes": []
    },
    {
      "name": "CHAT_WITH_ATTACHMENTS",
      "description": "Send a message with attachments",
      "parameters": [],
      "similes": []
    },
    {
      "name": "GET_USER_INFO",
      "description": "Get user information",
      "parameters": [],
      "similes": []
    }
  ]
} as const;
export const coreProvidersSpec = {
  "version": "1.0.0",
  "providers": [
    {
      "name": "channelState",
      "description": "Provides information about the current Discord channel state, including whether it's a DM or group channel, channel name, and server name.",
      "dynamic": true
    },
    {
      "name": "guildInfo",
      "description": "Provides information about the current Discord server/guild including member count, creation date, channels, roles, and bot permissions.",
      "dynamic": true
    },
    {
      "name": "voiceState",
      "description": "Provides information about the voice state of the agent, including whether it is currently in a voice channel.",
      "dynamic": true
    }
  ]
} as const;
export const allProvidersSpec = {
  "version": "1.0.0",
  "providers": [
    {
      "name": "channelState",
      "description": "Provides information about the current Discord channel state, including whether it's a DM or group channel, channel name, and server name.",
      "dynamic": true
    },
    {
      "name": "guildInfo",
      "description": "Provides information about the current Discord server/guild including member count, creation date, channels, roles, and bot permissions.",
      "dynamic": true
    },
    {
      "name": "voiceState",
      "description": "Provides information about the voice state of the agent, including whether it is currently in a voice channel.",
      "dynamic": true
    }
  ]
} as const;
export const coreEvaluatorsSpec = {
  "version": "1.0.0",
  "evaluators": []
} as const;
export const allEvaluatorsSpec = {
  "version": "1.0.0",
  "evaluators": []
} as const;

export const coreActionDocs: readonly ActionDoc[] = coreActionsSpec.actions;
export const allActionDocs: readonly ActionDoc[] = allActionsSpec.actions;
export const coreProviderDocs: readonly ProviderDoc[] = coreProvidersSpec.providers;
export const allProviderDocs: readonly ProviderDoc[] = allProvidersSpec.providers;
export const coreEvaluatorDocs: readonly EvaluatorDoc[] = coreEvaluatorsSpec.evaluators;
export const allEvaluatorDocs: readonly EvaluatorDoc[] = allEvaluatorsSpec.evaluators;
