/**
 * Auto-generated canonical action/provider/evaluator docs for plugin-discord.
 * DO NOT EDIT - Generated from prompts/specs/**.
 */

export type ActionDoc = {
  name: string;
  description: string;
  descriptionCompressed?: string;
  similes?: readonly string[];
  parameters?: readonly unknown[];
  examples?: readonly (readonly unknown[])[];
};

export type ProviderDoc = {
  name: string;
  description: string;
  descriptionCompressed?: string;
  position?: number;
  dynamic?: boolean;
};

export type EvaluatorDoc = {
  name: string;
  description: string;
  descriptionCompressed?: string;
  similes?: readonly string[];
  alwaysRun?: boolean;
  examples?: readonly unknown[];
};

export const coreActionsSpec = {
  "version": "1.0.0",
  "actions": [
    {
      "name": "DISCORD_CHAT_WITH_ATTACHMENTS",
      "description": "Legacy Discord attachment summarization for explicitly selected attachment IDs. Prefer READ_ATTACHMENT for normal current or recent files, images, media, links, and documents.",
      "descriptionCompressed": "Legacy Discord attachment-ID summarization.",
      "similes": [
        "DISCORD_ANALYZE_ATTACHMENTS",
        "DISCORD_SUMMARIZE_ATTACHMENTS",
        "DISCORD_ANSWER_WITH_ATTACHMENTS"
      ],
      "parameters": []
    },
    {
      "name": "DISCORD_MESSAGE_OP",
      "description": "Run a Discord message operation: send a channel message, reply to a message, send a direct message, edit one of the bot's messages, delete one of the bot's messages, react with an emoji, pin a message, or unpin a message. Pick the op that matches the user request.",
      "descriptionCompressed": "Discord message ops: send, reply, dm, edit, delete, react, pin, unpin.",
      "similes": [
        "DISCORD_SEND_MESSAGE",
        "DISCORD_POST_MESSAGE",
        "DISCORD_MESSAGE_CHANNEL",
        "DISCORD_REPLY",
        "DISCORD_SEND_DM",
        "DISCORD_DIRECT_MESSAGE",
        "DISCORD_DM_USER",
        "DISCORD_EDIT_MESSAGE",
        "DISCORD_UPDATE_MESSAGE",
        "DISCORD_DELETE_MESSAGE",
        "DISCORD_REMOVE_MESSAGE",
        "DISCORD_REACT_TO_MESSAGE",
        "DISCORD_ADD_REACTION",
        "DISCORD_PIN_MESSAGE",
        "DISCORD_UNPIN_MESSAGE"
      ],
      "parameters": []
    },
    {
      "name": "DISCORD_CHANNEL_OP",
      "description": "Run a Discord channel operation: join a voice or text channel, leave a voice or text channel, read or summarize recent channel messages, or search messages in a channel.",
      "descriptionCompressed": "Discord channel ops: join, leave, read, search.",
      "similes": [
        "DISCORD_JOIN_CHANNEL",
        "DISCORD_JOIN_VOICE",
        "DISCORD_LEAVE_CHANNEL",
        "DISCORD_LEAVE_VOICE",
        "DISCORD_READ_CHANNEL",
        "DISCORD_READ_MESSAGES",
        "DISCORD_SHOW_MESSAGES",
        "DISCORD_SUMMARIZE_CHANNEL",
        "DISCORD_CATCH_UP_CHANNEL",
        "DISCORD_SEARCH_MESSAGES",
        "DISCORD_FIND_MESSAGES"
      ],
      "parameters": []
    },
    {
      "name": "DISCORD_MEDIA_OP",
      "description": "Run a Discord media operation: download a media attachment or URL, or transcribe an audio or video attachment.",
      "descriptionCompressed": "Discord media ops: download, transcribe.",
      "similes": [
        "DISCORD_DOWNLOAD_MEDIA",
        "DISCORD_FETCH_MEDIA",
        "DISCORD_SAVE_ATTACHMENT",
        "DISCORD_TRANSCRIBE_MEDIA",
        "DISCORD_TRANSCRIBE_ATTACHMENT",
        "DISCORD_AUDIO_TO_TEXT",
        "DISCORD_VIDEO_TRANSCRIPT"
      ],
      "parameters": []
    },
    {
      "name": "DISCORD_SUMMARIZE_CONVERSATION",
      "description": "Summarize a date or time range from the stored Discord conversation history. For recent channel-message requests such as 'summarize last 100 messages', use DISCORD_CHANNEL_OP with op='read' instead.",
      "descriptionCompressed": "Summarize date-range Discord conversation history.",
      "similes": [
        "DISCORD_SUMMARIZE_HISTORY",
        "DISCORD_CONVERSATION_SUMMARY",
        "DISCORD_RECAP_CONVERSATION"
      ],
      "parameters": []
    },
    {
      "name": "DISCORD_CREATE_POLL",
      "description": "Create a Discord poll when the user asks for a poll or vote.",
      "descriptionCompressed": "Create Discord poll.",
      "similes": [
        "DISCORD_MAKE_POLL",
        "DISCORD_START_VOTE"
      ],
      "parameters": []
    },
    {
      "name": "DISCORD_GET_USER_INFO",
      "description": "Get Discord profile or server-member information for a user.",
      "descriptionCompressed": "Get Discord user info.",
      "similes": [
        "DISCORD_USER_INFO",
        "DISCORD_MEMBER_INFO",
        "DISCORD_PROFILE_INFO"
      ],
      "parameters": []
    },
    {
      "name": "DISCORD_SETUP_CREDENTIALS",
      "description": "Start Discord credential setup or account pairing when the user requests setup.",
      "descriptionCompressed": "Set up Discord credentials.",
      "similes": [
        "DISCORD_SETUP",
        "DISCORD_PAIR",
        "DISCORD_CONNECT"
      ],
      "parameters": []
    }
  ]
} as const;
export const allActionsSpec = {
  "version": "1.0.0",
  "actions": [
    {
      "name": "DISCORD_CHAT_WITH_ATTACHMENTS",
      "description": "Legacy Discord attachment summarization for explicitly selected attachment IDs. Prefer READ_ATTACHMENT for normal current or recent files, images, media, links, and documents.",
      "descriptionCompressed": "Legacy Discord attachment-ID summarization.",
      "similes": [
        "DISCORD_ANALYZE_ATTACHMENTS",
        "DISCORD_SUMMARIZE_ATTACHMENTS",
        "DISCORD_ANSWER_WITH_ATTACHMENTS"
      ],
      "parameters": []
    },
    {
      "name": "DISCORD_MESSAGE_OP",
      "description": "Run a Discord message operation: send a channel message, reply to a message, send a direct message, edit one of the bot's messages, delete one of the bot's messages, react with an emoji, pin a message, or unpin a message. Pick the op that matches the user request.",
      "descriptionCompressed": "Discord message ops: send, reply, dm, edit, delete, react, pin, unpin.",
      "similes": [
        "DISCORD_SEND_MESSAGE",
        "DISCORD_POST_MESSAGE",
        "DISCORD_MESSAGE_CHANNEL",
        "DISCORD_REPLY",
        "DISCORD_SEND_DM",
        "DISCORD_DIRECT_MESSAGE",
        "DISCORD_DM_USER",
        "DISCORD_EDIT_MESSAGE",
        "DISCORD_UPDATE_MESSAGE",
        "DISCORD_DELETE_MESSAGE",
        "DISCORD_REMOVE_MESSAGE",
        "DISCORD_REACT_TO_MESSAGE",
        "DISCORD_ADD_REACTION",
        "DISCORD_PIN_MESSAGE",
        "DISCORD_UNPIN_MESSAGE"
      ],
      "parameters": []
    },
    {
      "name": "DISCORD_CHANNEL_OP",
      "description": "Run a Discord channel operation: join a voice or text channel, leave a voice or text channel, read or summarize recent channel messages, or search messages in a channel.",
      "descriptionCompressed": "Discord channel ops: join, leave, read, search.",
      "similes": [
        "DISCORD_JOIN_CHANNEL",
        "DISCORD_JOIN_VOICE",
        "DISCORD_LEAVE_CHANNEL",
        "DISCORD_LEAVE_VOICE",
        "DISCORD_READ_CHANNEL",
        "DISCORD_READ_MESSAGES",
        "DISCORD_SHOW_MESSAGES",
        "DISCORD_SUMMARIZE_CHANNEL",
        "DISCORD_CATCH_UP_CHANNEL",
        "DISCORD_SEARCH_MESSAGES",
        "DISCORD_FIND_MESSAGES"
      ],
      "parameters": []
    },
    {
      "name": "DISCORD_MEDIA_OP",
      "description": "Run a Discord media operation: download a media attachment or URL, or transcribe an audio or video attachment.",
      "descriptionCompressed": "Discord media ops: download, transcribe.",
      "similes": [
        "DISCORD_DOWNLOAD_MEDIA",
        "DISCORD_FETCH_MEDIA",
        "DISCORD_SAVE_ATTACHMENT",
        "DISCORD_TRANSCRIBE_MEDIA",
        "DISCORD_TRANSCRIBE_ATTACHMENT",
        "DISCORD_AUDIO_TO_TEXT",
        "DISCORD_VIDEO_TRANSCRIPT"
      ],
      "parameters": []
    },
    {
      "name": "DISCORD_SUMMARIZE_CONVERSATION",
      "description": "Summarize a date or time range from the stored Discord conversation history. For recent channel-message requests such as 'summarize last 100 messages', use DISCORD_CHANNEL_OP with op='read' instead.",
      "descriptionCompressed": "Summarize date-range Discord conversation history.",
      "similes": [
        "DISCORD_SUMMARIZE_HISTORY",
        "DISCORD_CONVERSATION_SUMMARY",
        "DISCORD_RECAP_CONVERSATION"
      ],
      "parameters": []
    },
    {
      "name": "DISCORD_CREATE_POLL",
      "description": "Create a Discord poll when the user asks for a poll or vote.",
      "descriptionCompressed": "Create Discord poll.",
      "similes": [
        "DISCORD_MAKE_POLL",
        "DISCORD_START_VOTE"
      ],
      "parameters": []
    },
    {
      "name": "DISCORD_GET_USER_INFO",
      "description": "Get Discord profile or server-member information for a user.",
      "descriptionCompressed": "Get Discord user info.",
      "similes": [
        "DISCORD_USER_INFO",
        "DISCORD_MEMBER_INFO",
        "DISCORD_PROFILE_INFO"
      ],
      "parameters": []
    },
    {
      "name": "DISCORD_SETUP_CREDENTIALS",
      "description": "Start Discord credential setup or account pairing when the user requests setup.",
      "descriptionCompressed": "Set up Discord credentials.",
      "similes": [
        "DISCORD_SETUP",
        "DISCORD_PAIR",
        "DISCORD_CONNECT"
      ],
      "parameters": []
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
    },
    {
      "name": "discordChannels",
      "description": "Lists Discord channels the bot is currently listening to, grouped by server.",
      "descriptionCompressed": "Discord channels bot listens to (grouped by server).",
      "dynamic": true
    },
    {
      "name": "discordServerInfo",
      "description": "Discord server overview: members, channels, roles, owner, premium tier.",
      "descriptionCompressed": "Discord server overview (members, channels, roles).",
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
    },
    {
      "name": "discordChannels",
      "description": "Lists Discord channels the bot is currently listening to, grouped by server.",
      "descriptionCompressed": "Discord channels bot listens to (grouped by server).",
      "dynamic": true
    },
    {
      "name": "discordServerInfo",
      "description": "Discord server overview: members, channels, roles, owner, premium tier.",
      "descriptionCompressed": "Discord server overview (members, channels, roles).",
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
