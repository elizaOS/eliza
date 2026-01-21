"""
Auto-generated canonical action/provider/evaluator docs for plugin-rss.
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
      "name": "GET_NEWSFEED",
      "description": "Download and parse an RSS/Atom feed from a URL",
      "similes": [
        "FETCH_RSS",
        "READ_FEED",
        "DOWNLOAD_FEED"
      ],
      "parameters": []
    },
    {
      "name": "LIST_RSS_FEEDS",
      "description": "List all subscribed RSS/Atom feeds",
      "similes": [
        "SHOW_RSS_FEEDS",
        "GET_RSS_FEEDS",
        "RSS_SUBSCRIPTIONS"
      ],
      "parameters": []
    },
    {
      "name": "SUBSCRIBE_RSS_FEED",
      "description": "Subscribe to an RSS/Atom feed for automatic monitoring",
      "similes": [
        "ADD_RSS_FEED",
        "FOLLOW_RSS_FEED",
        "SUBSCRIBE_TO_RSS"
      ],
      "parameters": []
    },
    {
      "name": "UNSUBSCRIBE_RSS_FEED",
      "description": "Unsubscribe from an RSS/Atom feed",
      "similes": [
        "REMOVE_RSS_FEED",
        "UNFOLLOW_RSS_FEED",
        "DELETE_RSS_FEED"
      ],
      "parameters": []
    }
  ]
}"""
_ALL_ACTION_DOCS_JSON = """{
  "version": "1.0.0",
  "actions": [
    {
      "name": "GET_NEWSFEED",
      "description": "Download and parse an RSS/Atom feed from a URL",
      "similes": [
        "FETCH_RSS",
        "READ_FEED",
        "DOWNLOAD_FEED"
      ],
      "parameters": []
    },
    {
      "name": "LIST_RSS_FEEDS",
      "description": "List all subscribed RSS/Atom feeds",
      "similes": [
        "SHOW_RSS_FEEDS",
        "GET_RSS_FEEDS",
        "RSS_SUBSCRIPTIONS"
      ],
      "parameters": []
    },
    {
      "name": "SUBSCRIBE_RSS_FEED",
      "description": "Subscribe to an RSS/Atom feed for automatic monitoring",
      "similes": [
        "ADD_RSS_FEED",
        "FOLLOW_RSS_FEED",
        "SUBSCRIBE_TO_RSS"
      ],
      "parameters": []
    },
    {
      "name": "UNSUBSCRIBE_RSS_FEED",
      "description": "Unsubscribe from an RSS/Atom feed",
      "similes": [
        "REMOVE_RSS_FEED",
        "UNFOLLOW_RSS_FEED",
        "DELETE_RSS_FEED"
      ],
      "parameters": []
    }
  ]
}"""
_CORE_PROVIDER_DOCS_JSON = """{
  "version": "1.0.0",
  "providers": [
    {
      "name": "FEEDITEMS",
      "description": "Provides recent news and articles from subscribed RSS feeds",
      "dynamic": true
    }
  ]
}"""
_ALL_PROVIDER_DOCS_JSON = """{
  "version": "1.0.0",
  "providers": [
    {
      "name": "FEEDITEMS",
      "description": "Provides recent news and articles from subscribed RSS feeds",
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
