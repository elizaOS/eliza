"""Baseline service implementations for benchmark validation.

PerfectExperienceService: Cheats by using pure token overlap to always return the most
                          relevant answer first. Validates the benchmark CAN score 100%.

RandomExperienceService:  Returns random experiences regardless of query.
                          Validates the benchmark gives low scores for bad behavior.
"""

from __future__ import annotations

import os
import random
import re
import time

from elizaos_plugin_experience.service import ExperienceService
from elizaos_plugin_experience.types import Experience


class PerfectExperienceService(ExperienceService):
    """Service that cheats: returns experiences with maximum word overlap first.

    Uses pure Jaccard overlap as the score (no quality mixing), then
    confidence as tiebreaker. This gives theoretically perfect retrieval
    because the ground truth clusters are defined by template word patterns.
    """

    def find_similar_experiences(
        self,
        text: str,
        *,
        limit: int = 5,
        candidates: list[Experience] | None = None,
    ) -> list[Experience]:
        if not text:
            return []

        pool = candidates if candidates is not None else list(self._experiences.values())
        if not pool:
            return []

        query_tokens = _tokenize(text)
        if not query_tokens:
            return []

        scored: list[tuple[Experience, float, float]] = []
        for exp in pool:
            exp_tokens = _tokenize(f"{exp.context} {exp.action} {exp.result} {exp.learning}")
            union = query_tokens | exp_tokens
            overlap = len(query_tokens & exp_tokens) / len(union) if union else 0.0
            if overlap <= 0:
                continue
            scored.append((exp, overlap, exp.confidence))

        # Sort by: 1) exact overlap descending, 2) confidence descending (tiebreaker)
        scored.sort(key=lambda x: (x[1], x[2]), reverse=True)
        results = [s[0] for s in scored[:limit]]

        now_ms = int(time.time() * 1000)
        for e in results:
            e.access_count += 1
            e.last_accessed_at = now_ms

        return results


class RandomExperienceService(ExperienceService):
    """Service that returns random experiences regardless of query.

    Uses os.urandom-seeded RNG to ensure truly different shuffles across calls,
    even when the service is recreated with the same constructor.
    """

    def find_similar_experiences(
        self,
        text: str,
        *,
        limit: int = 5,
        candidates: list[Experience] | None = None,
    ) -> list[Experience]:
        if not text:
            return []

        pool = candidates if candidates is not None else list(self._experiences.values())
        if not pool:
            return []

        # Use OS entropy to ensure different shuffles each call, not a fixed seed
        rng = random.Random(int.from_bytes(os.urandom(8), "big"))
        shuffled = list(pool)
        rng.shuffle(shuffled)
        results = shuffled[:limit]

        now_ms = int(time.time() * 1000)
        for e in results:
            e.access_count += 1
            e.last_accessed_at = now_ms

        return results


def _tokenize(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9_]+", text.lower()))
