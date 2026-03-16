from __future__ import annotations

from dataclasses import dataclass, field
from typing import Pattern


@dataclass
class ElizaRule:
    pattern: Pattern[str]
    responses: list[str]


@dataclass
class ElizaPattern:
    keyword: str
    weight: int
    rules: list[ElizaRule]


@dataclass
class ElizaConfig:
    max_history_size: int = 10
    custom_patterns: list[ElizaPattern] = field(default_factory=list)
    custom_default_responses: list[str] = field(default_factory=list)


@dataclass
class ElizaMatchResult:
    pattern: ElizaPattern
    rule: ElizaRule
    captures: list[str]
