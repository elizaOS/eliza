"""
Auto-generated canonical action/provider/evaluator docs for plugin-todo.
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
      "name": "CANCEL_TODO",
      "description": "Cancels and deletes a todo item from the user",
      "similes": [
        "DELETE_TODO",
        "REMOVE_TASK",
        "DELETE_TASK",
        "REMOVE_TODO"
      ],
      "parameters": []
    },
    {
      "name": "COMPLETE_TODO",
      "description": "Marks a todo item as completed.",
      "similes": [
        "MARK_COMPLETE",
        "FINISH_TASK",
        "DONE",
        "TASK_DONE",
        "TASK_COMPLETED"
      ],
      "parameters": []
    },
    {
      "name": "CONFIRM_TODO",
      "description": "Confirms or cancels a pending todo creation after user review.",
      "similes": [
        "CONFIRM_TASK",
        "APPROVE_TODO",
        "APPROVE_TASK",
        "TODO_CONFIRM"
      ],
      "parameters": []
    },
    {
      "name": "CREATE_TODO",
      "description": "Creates a new todo item from a user description (daily, one-off, or aspirational) immediately.",
      "similes": [
        "ADD_TODO",
        "NEW_TASK",
        "ADD_TASK",
        "CREATE_TASK"
      ],
      "parameters": []
    },
    {
      "name": "UPDATE_TODO",
      "description": "Updates an existing todo item immediately based on user description.",
      "similes": [
        "EDIT_TODO",
        "MODIFY_TASK",
        "CHANGE_TASK",
        "MODIFY_TODO",
        "EDIT_TASK"
      ],
      "parameters": []
    }
  ]
}"""
_ALL_ACTION_DOCS_JSON = """{
  "version": "1.0.0",
  "actions": [
    {
      "name": "CANCEL_TODO",
      "description": "Cancels and deletes a todo item from the user",
      "similes": [
        "DELETE_TODO",
        "REMOVE_TASK",
        "DELETE_TASK",
        "REMOVE_TODO"
      ],
      "parameters": []
    },
    {
      "name": "COMPLETE_TODO",
      "description": "Marks a todo item as completed.",
      "similes": [
        "MARK_COMPLETE",
        "FINISH_TASK",
        "DONE",
        "TASK_DONE",
        "TASK_COMPLETED"
      ],
      "parameters": []
    },
    {
      "name": "CONFIRM_TODO",
      "description": "Confirms or cancels a pending todo creation after user review.",
      "similes": [
        "CONFIRM_TASK",
        "APPROVE_TODO",
        "APPROVE_TASK",
        "TODO_CONFIRM"
      ],
      "parameters": []
    },
    {
      "name": "CREATE_TODO",
      "description": "Creates a new todo item from a user description (daily, one-off, or aspirational) immediately.",
      "similes": [
        "ADD_TODO",
        "NEW_TASK",
        "ADD_TASK",
        "CREATE_TASK"
      ],
      "parameters": []
    },
    {
      "name": "UPDATE_TODO",
      "description": "Updates an existing todo item immediately based on user description.",
      "similes": [
        "EDIT_TODO",
        "MODIFY_TASK",
        "CHANGE_TASK",
        "MODIFY_TODO",
        "EDIT_TASK"
      ],
      "parameters": []
    }
  ]
}"""
_CORE_PROVIDER_DOCS_JSON = """{
  "version": "1.0.0",
  "providers": [
    {
      "name": "TODOS",
      "description": "Information about the user",
      "dynamic": true
    }
  ]
}"""
_ALL_PROVIDER_DOCS_JSON = """{
  "version": "1.0.0",
  "providers": [
    {
      "name": "TODOS",
      "description": "Information about the user",
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
