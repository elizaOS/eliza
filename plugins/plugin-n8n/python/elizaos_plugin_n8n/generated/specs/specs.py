"""
Auto-generated canonical action/provider/evaluator docs for plugin-n8n.
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
      "name": "CREATE_PLUGIN",
      "description": "Create an elizaOS plugin from a structured JSON specification. Use this when the user provides a complete plugin spec as JSON. Do NOT use for n8n workflow creation.",
      "similes": [
        "create plugin",
        "build plugin",
        "generate plugin"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Create a plugin for managing user preferences"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I'll create a user preferences management plugin for you.",
              "actions": [
                "CREATE_PLUGIN"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "CHECK_PLUGIN_STATUS",
      "description": "Check the progress of an active plugin creation job. Do NOT use for n8n workflow status.",
      "similes": [
        "plugin status",
        "check plugin progress",
        "plugin creation status",
        "get plugin status"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "What's the status of my plugin creation?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Let me check the status of your plugin creation job...",
              "actions": [
                "CHECK_PLUGIN_STATUS"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "CANCEL_PLUGIN",
      "description": "Cancel an active plugin creation job. Do NOT use to cancel n8n workflow drafts.",
      "similes": [
        "stop plugin creation",
        "abort plugin creation",
        "cancel plugin"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Cancel the plugin creation"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I'll cancel the current plugin creation job.",
              "actions": [
                "CANCEL_PLUGIN"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "DESCRIBE_PLUGIN",
      "description": "Generate and create an elizaOS plugin from a natural language description. Do NOT use for n8n workflow creation.",
      "similes": [
        "describe plugin",
        "plugin from description",
        "explain plugin",
        "I need a plugin that"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "I need a plugin that helps manage todo lists with add, remove, and list functionality"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I'll create a todo list management plugin based on your description.",
              "actions": [
                "DESCRIBE_PLUGIN"
              ]
            }
          }
        ]
      ]
    }
  ]
}"""
_ALL_ACTION_DOCS_JSON = """{
  "version": "1.0.0",
  "actions": [
    {
      "name": "CREATE_PLUGIN",
      "description": "Create an elizaOS plugin from a structured JSON specification. Use this when the user provides a complete plugin spec as JSON. Do NOT use for n8n workflow creation.",
      "similes": [
        "create plugin",
        "build plugin",
        "generate plugin"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Create a plugin for managing user preferences"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I'll create a user preferences management plugin for you.",
              "actions": [
                "CREATE_PLUGIN"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "CHECK_PLUGIN_STATUS",
      "description": "Check the progress of an active plugin creation job. Do NOT use for n8n workflow status.",
      "similes": [
        "plugin status",
        "check plugin progress",
        "plugin creation status",
        "get plugin status"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "What's the status of my plugin creation?"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "Let me check the status of your plugin creation job...",
              "actions": [
                "CHECK_PLUGIN_STATUS"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "CANCEL_PLUGIN",
      "description": "Cancel an active plugin creation job. Do NOT use to cancel n8n workflow drafts.",
      "similes": [
        "stop plugin creation",
        "abort plugin creation",
        "cancel plugin"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "Cancel the plugin creation"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I'll cancel the current plugin creation job.",
              "actions": [
                "CANCEL_PLUGIN"
              ]
            }
          }
        ]
      ]
    },
    {
      "name": "DESCRIBE_PLUGIN",
      "description": "Generate and create an elizaOS plugin from a natural language description. Do NOT use for n8n workflow creation.",
      "similes": [
        "describe plugin",
        "plugin from description",
        "explain plugin",
        "I need a plugin that"
      ],
      "parameters": [],
      "examples": [
        [
          {
            "name": "{{name1}}",
            "content": {
              "text": "I need a plugin that helps manage todo lists with add, remove, and list functionality"
            }
          },
          {
            "name": "{{name2}}",
            "content": {
              "text": "I'll create a todo list management plugin based on your description.",
              "actions": [
                "DESCRIBE_PLUGIN"
              ]
            }
          }
        ]
      ]
    }
  ]
}"""
_CORE_PROVIDER_DOCS_JSON = """{
  "version": "1.0.0",
  "providers": [
    {
      "name": "n8n_plugin_status",
      "description": "Provides status of active plugin creation jobs",
      "dynamic": true
    },
    {
      "name": "n8n_plugin_registry",
      "description": "Provides information about all created plugins in the current session",
      "dynamic": true
    }
  ]
}"""
_ALL_PROVIDER_DOCS_JSON = """{
  "version": "1.0.0",
  "providers": [
    {
      "name": "n8n_plugin_status",
      "description": "Provides status of active plugin creation jobs",
      "dynamic": true
    },
    {
      "name": "n8n_plugin_registry",
      "description": "Provides information about all created plugins in the current session",
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
