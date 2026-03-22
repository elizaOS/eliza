"""
Auto-generated canonical action/provider/evaluator docs for plugin-evm.
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
      "name": "assistant",
      "description": "",
      "parameters": []
    },
    {
      "name": "TRANSFER",
      "description": "Transfer tokens or native asset to an address",
      "parameters": [],
      "similes": []
    },
    {
      "name": "SWAP_TOKENS",
      "description": "Swap tokens via DEX or aggregator",
      "parameters": [],
      "similes": []
    },
    {
      "name": "BRIDGE",
      "description": "Bridge assets across chains",
      "parameters": [],
      "similes": []
    },
    {
      "name": "VOTE_PROPOSAL",
      "description": "Vote on a governance proposal",
      "parameters": [],
      "similes": []
    },
    {
      "name": "QUEUE_PROPOSAL",
      "description": "Queue a governance proposal",
      "parameters": [],
      "similes": []
    },
    {
      "name": "GOV_PROPOSE",
      "description": "Create a governance proposal",
      "parameters": [],
      "similes": []
    },
    {
      "name": "GOV_EXECUTE",
      "description": "Execute a passed governance proposal",
      "parameters": [],
      "similes": []
    }
  ]
}"""
_ALL_ACTION_DOCS_JSON = """{
  "version": "1.0.0",
  "actions": [
    {
      "name": "assistant",
      "description": "",
      "parameters": []
    },
    {
      "name": "TRANSFER",
      "description": "Transfer tokens or native asset to an address",
      "parameters": [],
      "similes": []
    },
    {
      "name": "SWAP_TOKENS",
      "description": "Swap tokens via DEX or aggregator",
      "parameters": [],
      "similes": []
    },
    {
      "name": "BRIDGE",
      "description": "Bridge assets across chains",
      "parameters": [],
      "similes": []
    },
    {
      "name": "VOTE_PROPOSAL",
      "description": "Vote on a governance proposal",
      "parameters": [],
      "similes": []
    },
    {
      "name": "QUEUE_PROPOSAL",
      "description": "Queue a governance proposal",
      "parameters": [],
      "similes": []
    },
    {
      "name": "GOV_PROPOSE",
      "description": "Create a governance proposal",
      "parameters": [],
      "similes": []
    },
    {
      "name": "GOV_EXECUTE",
      "description": "Execute a passed governance proposal",
      "parameters": [],
      "similes": []
    }
  ]
}"""
_CORE_PROVIDER_DOCS_JSON = """{
  "version": "1.0.0",
  "providers": [
    {
      "name": "EVMWalletProvider",
      "description": "",
      "dynamic": true
    },
    {
      "name": "TOKEN_BALANCE",
      "description": "Token balance for ERC20 tokens when onchain actions are requested",
      "dynamic": true
    }
  ]
}"""
_ALL_PROVIDER_DOCS_JSON = """{
  "version": "1.0.0",
  "providers": [
    {
      "name": "EVMWalletProvider",
      "description": "",
      "dynamic": true
    },
    {
      "name": "TOKEN_BALANCE",
      "description": "Token balance for ERC20 tokens when onchain actions are requested",
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
