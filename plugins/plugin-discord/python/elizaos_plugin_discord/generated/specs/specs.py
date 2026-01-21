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
