"""
Auto-generated canonical action/provider docs for plugin-anthropic.
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


_CORE_ACTION_DOCS_JSON = """{
  "version": "1.0.0",
  "actions": []
}"""
_ALL_ACTION_DOCS_JSON = """{
  "version": "1.0.0",
  "actions": []
}"""
_CORE_PROVIDER_DOCS_JSON = """{
  "version": "1.0.0",
  "providers": []
}"""
_ALL_PROVIDER_DOCS_JSON = """{
  "version": "1.0.0",
  "providers": []
}"""

core_action_docs: dict[str, object] = json.loads(_CORE_ACTION_DOCS_JSON)
all_action_docs: dict[str, object] = json.loads(_ALL_ACTION_DOCS_JSON)
core_provider_docs: dict[str, object] = json.loads(_CORE_PROVIDER_DOCS_JSON)
all_provider_docs: dict[str, object] = json.loads(_ALL_PROVIDER_DOCS_JSON)

__all__ = [
    "ActionDoc",
    "ProviderDoc",
    "core_action_docs",
    "all_action_docs",
    "core_provider_docs",
    "all_provider_docs",
]
