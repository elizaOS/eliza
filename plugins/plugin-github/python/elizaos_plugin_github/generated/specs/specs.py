"""
Auto-generated canonical action/provider/evaluator docs for plugin-github.
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
      "name": "CREATE_GITHUB_BRANCH",
      "description": "",
      "parameters": []
    },
    {
      "name": "CREATE_GITHUB_COMMENT",
      "description": "",
      "parameters": []
    },
    {
      "name": "CREATE_GITHUB_ISSUE",
      "description": "",
      "parameters": []
    },
    {
      "name": "CREATE_GITHUB_PULL_REQUEST",
      "description": "",
      "parameters": []
    },
    {
      "name": "MERGE_GITHUB_PULL_REQUEST",
      "description": "",
      "parameters": []
    },
    {
      "name": "PUSH_GITHUB_CODE",
      "description": "",
      "parameters": []
    },
    {
      "name": "REVIEW_GITHUB_PULL_REQUEST",
      "description": "",
      "parameters": []
    }
  ]
}"""
_ALL_ACTION_DOCS_JSON = """{
  "version": "1.0.0",
  "actions": [
    {
      "name": "CREATE_GITHUB_BRANCH",
      "description": "",
      "parameters": []
    },
    {
      "name": "CREATE_GITHUB_COMMENT",
      "description": "",
      "parameters": []
    },
    {
      "name": "CREATE_GITHUB_ISSUE",
      "description": "",
      "parameters": []
    },
    {
      "name": "CREATE_GITHUB_PULL_REQUEST",
      "description": "",
      "parameters": []
    },
    {
      "name": "MERGE_GITHUB_PULL_REQUEST",
      "description": "",
      "parameters": []
    },
    {
      "name": "PUSH_GITHUB_CODE",
      "description": "",
      "parameters": []
    },
    {
      "name": "REVIEW_GITHUB_PULL_REQUEST",
      "description": "",
      "parameters": []
    }
  ]
}"""
_CORE_PROVIDER_DOCS_JSON = """{
  "version": "1.0.0",
  "providers": [
    {
      "name": "GITHUB_ISSUE_CONTEXT",
      "description": "Provides detailed context about a specific GitHub issue or pull request when referenced",
      "dynamic": true
    },
    {
      "name": "GITHUB_REPOSITORY_STATE",
      "description": "Provides context about the current GitHub repository including recent activity",
      "dynamic": true
    }
  ]
}"""
_ALL_PROVIDER_DOCS_JSON = """{
  "version": "1.0.0",
  "providers": [
    {
      "name": "GITHUB_ISSUE_CONTEXT",
      "description": "Provides detailed context about a specific GitHub issue or pull request when referenced",
      "dynamic": true
    },
    {
      "name": "GITHUB_REPOSITORY_STATE",
      "description": "Provides context about the current GitHub repository including recent activity",
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
