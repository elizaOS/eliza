"""
Types for ELIZA Classic Plugin.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Pattern


@dataclass
class ElizaRule:
    """A pattern rule with regex and response templates."""

    pattern: Pattern[str]
    responses: list[str]


@dataclass
class ElizaPattern:
    """A keyword pattern group with weight and rules."""

    keyword: str
    weight: int
    rules: list[ElizaRule]


@dataclass
class ElizaConfig:
    """Configuration for ELIZA response generation."""

    max_history_size: int = 10
    custom_patterns: list[ElizaPattern] = field(default_factory=list)
    custom_default_responses: list[str] = field(default_factory=list)


@dataclass
class ElizaMatchResult:
    """Result of ELIZA pattern matching."""

    pattern: ElizaPattern
    rule: ElizaRule
    captures: list[str]

