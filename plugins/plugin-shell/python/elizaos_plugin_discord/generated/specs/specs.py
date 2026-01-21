"""
Auto-generated canonical action/provider/evaluator docs for plugin-shell.
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
      "name": "CLEAR_SHELL_HISTORY",
      "description": "Clears the recorded history of shell commands for the current conversation",
      "similes": [
        "RESET_SHELL",
        "CLEAR_TERMINAL",
        "CLEAR_HISTORY",
        "RESET_HISTORY"
      ],
      "parameters": []
    },
    {
      "name": "EXECUTE_COMMAND",
      "description": "Execute shell commands including brew install, npm install, apt-get, system commands, file operations, directory navigation, and scripts.",
      "similes": [
        "RUN_COMMAND",
        "SHELL_COMMAND",
        "TERMINAL_COMMAND",
        "EXEC",
        "RUN",
        "EXECUTE",
        "CREATE_FILE",
        "WRITE_FILE",
        "MAKE_FILE",
        "INSTALL",
        "BREW_INSTALL",
        "NPM_INSTALL",
        "APT_INSTALL"
      ],
      "parameters": []
    }
  ]
}"""
_ALL_ACTION_DOCS_JSON = """{
  "version": "1.0.0",
  "actions": [
    {
      "name": "CLEAR_SHELL_HISTORY",
      "description": "Clears the recorded history of shell commands for the current conversation",
      "similes": [
        "RESET_SHELL",
        "CLEAR_TERMINAL",
        "CLEAR_HISTORY",
        "RESET_HISTORY"
      ],
      "parameters": []
    },
    {
      "name": "EXECUTE_COMMAND",
      "description": "Execute shell commands including brew install, npm install, apt-get, system commands, file operations, directory navigation, and scripts.",
      "similes": [
        "RUN_COMMAND",
        "SHELL_COMMAND",
        "TERMINAL_COMMAND",
        "EXEC",
        "RUN",
        "EXECUTE",
        "CREATE_FILE",
        "WRITE_FILE",
        "MAKE_FILE",
        "INSTALL",
        "BREW_INSTALL",
        "NPM_INSTALL",
        "APT_INSTALL"
      ],
      "parameters": []
    }
  ]
}"""
_CORE_PROVIDER_DOCS_JSON = """{
  "version": "1.0.0",
  "providers": [
    {
      "name": "SHELL_HISTORY",
      "description": "Provides recent shell command history, current working directory, and file operations within the restricted environment",
      "dynamic": true
    }
  ]
}"""
_ALL_PROVIDER_DOCS_JSON = """{
  "version": "1.0.0",
  "providers": [
    {
      "name": "SHELL_HISTORY",
      "description": "Provides recent shell command history, current working directory, and file operations within the restricted environment",
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
