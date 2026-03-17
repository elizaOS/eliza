"""
Auto-generated canonical action/provider/evaluator docs for plugin-discord.
DO NOT EDIT - Generated from prompts/specs/**.
"""

from __future__ import annotations

import json
from typing import TypedDict

class ActionDoc(TypedDict, total=False):
    name: str
    description: str
    similes: list[str]
    parameters: list[object]
    examples: list[list[object]]

class ProviderDoc(TypedDict, total=False):
    name: str
    description: str
    position: int
    dynamic: bool

class EvaluatorDoc(TypedDict, total=False):
    name: str
    description: str
    similes: list[str]
    alwaysRun: bool
    examples: list[object]

_CORE_ACTION_DOCS_JSON = """{
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
}"""
_ALL_ACTION_DOCS_JSON = """{
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
}"""
_CORE_PROVIDER_DOCS_JSON = """{
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
}"""
_ALL_PROVIDER_DOCS_JSON = """{
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
}"""
_CORE_EVALUATOR_DOCS_JSON = """{
  "version": "1.0.0",
  "evaluators": []
}"""
_ALL_EVALUATOR_DOCS_JSON = """{
  "version": "1.0.0",
  "evaluators": []
}"""

core_action_docs: dict[str, object] = json.loads(_CORE_ACTION_DOCS_JSON)
all_action_docs: dict[str, object] = json.loads(_ALL_ACTION_DOCS_JSON)
core_provider_docs: dict[str, object] = json.loads(_CORE_PROVIDER_DOCS_JSON)
all_provider_docs: dict[str, object] = json.loads(_ALL_PROVIDER_DOCS_JSON)
core_evaluator_docs: dict[str, object] = json.loads(_CORE_EVALUATOR_DOCS_JSON)
all_evaluator_docs: dict[str, object] = json.loads(_ALL_EVALUATOR_DOCS_JSON)

__all__ = [
    "ActionDoc",
    "ProviderDoc",
    "EvaluatorDoc",
    "core_action_docs",
    "all_action_docs",
    "core_provider_docs",
    "all_provider_docs",
    "core_evaluator_docs",
    "all_evaluator_docs",
]
