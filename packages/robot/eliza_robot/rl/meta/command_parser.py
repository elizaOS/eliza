"""Command parser — text → ``(skill_name, SkillParams)``.

Fast path: regex patterns for common commands.
Fallback: cosine similarity of text embedding vs skill description embeddings.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np

from eliza_robot.rl.meta.text_encoder import TextEncoder
from eliza_robot.rl.skills.base import SkillParams


# Regex pattern entries: ``(pattern, skill_name, default_params_factory)``.
_REGEX_PATTERNS: list[tuple[str, str, dict]] = [
    # Walk commands.
    (r"walk\s+forward\s+fast", "walk", {"speed": 0.8, "direction": 0.0}),
    (r"walk\s+forward\s+slow(ly)?", "walk", {"speed": 0.25, "direction": 0.0}),
    (r"walk\s+forward", "walk", {"speed": 0.5, "direction": 0.0}),
    (r"walk\s+backward", "walk", {"speed": 0.3, "direction": 3.14}),
    (r"walk\s+slow(ly)?", "walk", {"speed": 0.25}),
    (r"walk\s+fast", "walk", {"speed": 0.8}),
    (r"walk", "walk", {"speed": 0.5}),
    (r"go\s+forward", "walk", {"speed": 0.5, "direction": 0.0}),
    (r"move\s+forward", "walk", {"speed": 0.5, "direction": 0.0}),
    # Turn commands.
    (r"turn\s+left", "turn", {"direction": -1.0}),
    (r"turn\s+right", "turn", {"direction": 1.0}),
    (r"turn\s+around", "turn", {"direction": 1.0, "magnitude": 3.14}),
    (r"turn", "turn", {"direction": 1.0}),
    (r"rotate\s+left", "turn", {"direction": -1.0}),
    (r"rotate\s+right", "turn", {"direction": 1.0}),
    # Stop.
    (r"stop", "stand", {}),
    (r"halt", "stand", {}),
    (r"stand\s*(still)?", "stand", {}),
    (r"freeze", "stand", {}),
    # Wave.
    (r"wave(\s+hand)?", "wave", {}),
    (r"say\s+hello", "wave", {}),
    (r"greet", "wave", {}),
    (r"hello", "wave", {}),
    # Bow.
    (r"bow(\s+down)?", "bow", {}),
    (r"take\s+a\s+bow", "bow", {}),
]

_COMPILED_PATTERNS = [
    (re.compile(p, re.IGNORECASE), skill, params)
    for p, skill, params in _REGEX_PATTERNS
]

SKILL_DESCRIPTIONS: dict[str, str] = {
    "walk": "walk forward, move, go, locomotion",
    "turn": "turn, rotate, spin, change direction",
    "stand": "stop, stand still, halt, freeze",
    "wave": "wave hand, greet, say hello",
    "bow": "bow, bend forward",
}


@dataclass
class ParseResult:
    """Result of parsing a text command."""
    skill_name: str
    params: SkillParams
    confidence: float  # 1.0 for regex, similarity score for embedding


def parse_command_regex(text: str) -> ParseResult | None:
    """Try to parse command using regex patterns (fast path).

    Returns ``None`` if no pattern matches.
    """
    text = text.strip()
    for pattern, skill_name, param_overrides in _COMPILED_PATTERNS:
        if pattern.search(text):
            params = SkillParams(**param_overrides)
            return ParseResult(skill_name=skill_name, params=params, confidence=1.0)
    return None


class CommandParser:
    """Parse text commands to skill activations.

    Uses regex for common commands, falls back to embedding similarity.
    """

    def __init__(self, encoder: TextEncoder | None = None) -> None:
        self._encoder = encoder or TextEncoder(prefer_transformer=False)
        self._skill_embeddings: dict[str, np.ndarray] = {}
        self._build_skill_embeddings()

    def _build_skill_embeddings(self) -> None:
        """Pre-compute embeddings for all skill descriptions."""
        names = list(SKILL_DESCRIPTIONS.keys())
        descriptions = [SKILL_DESCRIPTIONS[n] for n in names]
        embeddings = self._encoder.encode(descriptions)
        for name, emb in zip(names, embeddings, strict=True):
            self._skill_embeddings[name] = emb

    def parse(self, text: str) -> ParseResult:
        """Parse a text command into a skill activation."""
        result = parse_command_regex(text)
        if result is not None:
            return result

        text_emb = self._encoder.encode_single(text)

        best_skill = "stand"
        best_score = -1.0

        for name, skill_emb in self._skill_embeddings.items():
            score = float(np.dot(text_emb, skill_emb) / (
                np.linalg.norm(text_emb) * np.linalg.norm(skill_emb) + 1e-8
            ))
            if score > best_score:
                best_score = score
                best_skill = name

        return ParseResult(
            skill_name=best_skill,
            params=SkillParams(),
            confidence=max(0.0, best_score),
        )
