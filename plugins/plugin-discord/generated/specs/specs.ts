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
        "ANALYZE_ATTACHMENTS",
        "SUMMARIZE_ATTACHMENTS",
        "ANSWER_WITH_ATTACHMENTS"
      ],
      "parameters": []
    },
    {
      "name": "DISCORD_MEDIA_OP",
      "description": "Run a Discord media operation: download a media attachment or URL, or transcribe an audio or video attachment.",
      "descriptionCompressed": "Discord media ops: download, transcribe.",
      "similes": [
        "DOWNLOAD_MEDIA",
        "FETCH_MEDIA",
        "SAVE_ATTACHMENT",
        "TRANSCRIBE_MEDIA",
        "TRANSCRIBE_ATTACHMENT",
        "AUDIO_TO_TEXT",
        "VIDEO_TRANSCRIPT"
      ],
      "parameters": []
    },
    {
      "name": "DISCORD_SUMMARIZE_CONVERSATION",
      "description": "Summarize a date or time range from the stored Discord conversation history. For recent channel-message requests such as 'summarize last 100 messages', use MESSAGE with operation=read and source=discord instead.",
      "descriptionCompressed": "Summarize date-range Discord conversation history.",
      "similes": [
        "SUMMARIZE_HISTORY",
        "CONVERSATION_SUMMARY",
        "RECAP_CONVERSATION"
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
      "name": "DISCORD_SETUP_CREDENTIALS",
      "description": "Start Discord credential setup or account pairing when the user requests setup.",
      "descriptionCompressed": "Set up Discord credentials.",
      "similes": [
        "SETUP_CREDENTIALS",
        "PAIR_CONNECTOR",
        "CONNECT_ACCOUNT"
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
        "ANALYZE_ATTACHMENTS",
        "SUMMARIZE_ATTACHMENTS",
        "ANSWER_WITH_ATTACHMENTS"
      ],
      "parameters": []
    },
    {
      "name": "DISCORD_MEDIA_OP",
      "description": "Run a Discord media operation: download a media attachment or URL, or transcribe an audio or video attachment.",
      "descriptionCompressed": "Discord media ops: download, transcribe.",
      "similes": [
        "DOWNLOAD_MEDIA",
        "FETCH_MEDIA",
        "SAVE_ATTACHMENT",
        "TRANSCRIBE_MEDIA",
        "TRANSCRIBE_ATTACHMENT",
        "AUDIO_TO_TEXT",
        "VIDEO_TRANSCRIPT"
      ],
      "parameters": []
    },
    {
      "name": "DISCORD_SUMMARIZE_CONVERSATION",
      "description": "Summarize a date or time range from the stored Discord conversation history. For recent channel-message requests such as 'summarize last 100 messages', use MESSAGE with operation=read and source=discord instead.",
      "descriptionCompressed": "Summarize date-range Discord conversation history.",
      "similes": [
        "SUMMARIZE_HISTORY",
        "CONVERSATION_SUMMARY",
        "RECAP_CONVERSATION"
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
      "name": "DISCORD_SETUP_CREDENTIALS",
      "description": "Start Discord credential setup or account pairing when the user requests setup.",
      "descriptionCompressed": "Set up Discord credentials.",
      "similes": [
        "SETUP_CREDENTIALS",
        "PAIR_CONNECTOR",
        "CONNECT_ACCOUNT"
      ],
      "parameters": []
    }
  ]
} as const;
export const coreProvidersSpec = {
  "version": "1.0.0",
  "providers": [
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
