"""
Auto-generated canonical action/provider/evaluator docs for plugin-code.
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
      "name": "CHANGE_DIRECTORY",
      "description": "Change the working directory (restricted to allowed directory).",
      "similes": [
        "CD",
        "CWD"
      ],
      "parameters": []
    },
    {
      "name": "EDIT_FILE",
      "description": "Replace a substring in a file (single replacement).",
      "similes": [
        "REPLACE_IN_FILE",
        "PATCH_FILE",
        "MODIFY_FILE"
      ],
      "parameters": []
    },
    {
      "name": "EXECUTE_SHELL",
      "description": "Execute a shell command in the current working directory (restricted).",
      "similes": [
        "SHELL",
        "RUN_COMMAND",
        "EXEC",
        "TERMINAL"
      ],
      "parameters": []
    },
    {
      "name": "GIT",
      "description": "Run a git command (restricted).",
      "similes": [
        "GIT_COMMAND",
        "GIT_RUN"
      ],
      "parameters": []
    },
    {
      "name": "LIST_FILES",
      "description": "List files in a directory.",
      "similes": [
        "LS",
        "LIST_DIR",
        "LIST_DIRECTORY",
        "DIR"
      ],
      "parameters": []
    },
    {
      "name": "READ_FILE",
      "description": "Read and return a file",
      "similes": [
        "VIEW_FILE",
        "OPEN_FILE",
        "CAT_FILE",
        "SHOW_FILE",
        "GET_FILE"
      ],
      "parameters": []
    },
    {
      "name": "SEARCH_FILES",
      "description": "Search for text across files under a directory.",
      "similes": [
        "GREP",
        "RG",
        "FIND_IN_FILES",
        "SEARCH"
      ],
      "parameters": []
    },
    {
      "name": "WRITE_FILE",
      "description": "Create or overwrite a file with given content.",
      "similes": [
        "CREATE_FILE",
        "SAVE_FILE",
        "OUTPUT_FILE"
      ],
      "parameters": []
    }
  ]
}"""
_ALL_ACTION_DOCS_JSON = """{
  "version": "1.0.0",
  "actions": [
    {
      "name": "CHANGE_DIRECTORY",
      "description": "Change the working directory (restricted to allowed directory).",
      "similes": [
        "CD",
        "CWD"
      ],
      "parameters": []
    },
    {
      "name": "EDIT_FILE",
      "description": "Replace a substring in a file (single replacement).",
      "similes": [
        "REPLACE_IN_FILE",
        "PATCH_FILE",
        "MODIFY_FILE"
      ],
      "parameters": []
    },
    {
      "name": "EXECUTE_SHELL",
      "description": "Execute a shell command in the current working directory (restricted).",
      "similes": [
        "SHELL",
        "RUN_COMMAND",
        "EXEC",
        "TERMINAL"
      ],
      "parameters": []
    },
    {
      "name": "GIT",
      "description": "Run a git command (restricted).",
      "similes": [
        "GIT_COMMAND",
        "GIT_RUN"
      ],
      "parameters": []
    },
    {
      "name": "LIST_FILES",
      "description": "List files in a directory.",
      "similes": [
        "LS",
        "LIST_DIR",
        "LIST_DIRECTORY",
        "DIR"
      ],
      "parameters": []
    },
    {
      "name": "READ_FILE",
      "description": "Read and return a file",
      "similes": [
        "VIEW_FILE",
        "OPEN_FILE",
        "CAT_FILE",
        "SHOW_FILE",
        "GET_FILE"
      ],
      "parameters": []
    },
    {
      "name": "SEARCH_FILES",
      "description": "Search for text across files under a directory.",
      "similes": [
        "GREP",
        "RG",
        "FIND_IN_FILES",
        "SEARCH"
      ],
      "parameters": []
    },
    {
      "name": "WRITE_FILE",
      "description": "Create or overwrite a file with given content.",
      "similes": [
        "CREATE_FILE",
        "SAVE_FILE",
        "OUTPUT_FILE"
      ],
      "parameters": []
    }
  ]
}"""
_CORE_PROVIDER_DOCS_JSON = """{
  "version": "1.0.0",
  "providers": [
    {
      "name": "CODER_STATUS",
      "description": "Provides current working directory, allowed directory, and recent shell/file operations",
      "dynamic": true
    }
  ]
}"""
_ALL_PROVIDER_DOCS_JSON = """{
  "version": "1.0.0",
  "providers": [
    {
      "name": "CODER_STATUS",
      "description": "Provides current working directory, allowed directory, and recent shell/file operations",
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
