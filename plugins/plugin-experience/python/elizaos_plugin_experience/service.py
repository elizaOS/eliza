from __future__ import annotations

import re
import time
import uuid
from dataclasses import dataclass

from elizaos_plugin_experience.types import Experience, ExperienceQuery, ExperienceType, OutcomeType


@dataclass(frozen=True)
class SimilarityResult:
    experience: Experience
    similarity: float


class ExperienceService:
    """
    In-memory experience store with simple semantic-like querying.

    This Python implementation does not rely on runtime embeddings; it uses a token overlap
    heuristic so it can run standalone.
    """

    def __init__(self, max_experiences: int = 10_000) -> None:
        self._max_experiences = max_experiences
        self._experiences: dict[str, Experience] = {}

    def set_max_experiences(self, max_experiences: int) -> None:
        if max_experiences <= 0:
            return
        self._max_experiences = max_experiences
        self._prune_if_needed()

    def record_experience(
        self,
        *,
        agent_id: str,
        context: str,
        action: str,
        result: str,
        learning: str,
        experience_type: ExperienceType = ExperienceType.LEARNING,
        outcome: OutcomeType = OutcomeType.NEUTRAL,
        domain: str = "general",
        tags: list[str] | None = None,
        confidence: float = 0.5,
        importance: float = 0.5,
        related_experiences: list[str] | None = None,
        supersedes: str | None = None,
        previous_belief: str | None = None,
        corrected_belief: str | None = None,
    ) -> Experience:
        now_ms = int(time.time() * 1000)
        exp_id = str(uuid.uuid4())

        exp = Experience(
            id=exp_id,
            agent_id=agent_id,
            type=experience_type,
            outcome=outcome,
            context=context,
            action=action,
            result=result,
            learning=learning,
            tags=tags or [],
            domain=domain,
            related_experiences=related_experiences,
            supersedes=supersedes,
            confidence=confidence,
            importance=importance,
            created_at=now_ms,
            updated_at=now_ms,
            last_accessed_at=now_ms,
            access_count=0,
            previous_belief=previous_belief,
            corrected_belief=corrected_belief,
        )

        self._experiences[exp.id] = exp
        self._prune_if_needed()
        return exp

    def query_experiences(self, query: ExperienceQuery) -> list[Experience]:
        candidates = list(self._experiences.values())

        # Apply filters
        if query.type is not None:
            allowed_types = list(query.type) if isinstance(query.type, list) else [query.type]
            candidates = [e for e in candidates if e.type in allowed_types]

        if query.outcome is not None:
            allowed_outcomes = (
                list(query.outcome) if isinstance(query.outcome, list) else [query.outcome]
            )
            candidates = [e for e in candidates if e.outcome in allowed_outcomes]

        if query.domain is not None:
            allowed_domains = (
                list(query.domain) if isinstance(query.domain, list) else [query.domain]
            )
            candidates = [e for e in candidates if e.domain in allowed_domains]

        if query.tags:
            candidates = [e for e in candidates if any(tag in e.tags for tag in query.tags or [])]

        if query.min_confidence is not None:
            candidates = [e for e in candidates if e.confidence >= query.min_confidence]

        if query.min_importance is not None:
            candidates = [e for e in candidates if e.importance >= query.min_importance]

        if query.time_range is not None:
            start = query.time_range.start
            end = query.time_range.end
            candidates = [
                e
                for e in candidates
                if (start is None or e.created_at >= start) and (end is None or e.created_at <= end)
            ]

        limit = query.limit or 10

        # Semantic-ish query via token overlap
        if query.query:
            ranked = self.find_similar_experiences(query.query, limit=limit, candidates=candidates)
            results = ranked
        else:
            # Sort by confidence*importance then recency
            candidates.sort(
                key=lambda e: (e.confidence * e.importance, e.updated_at),
                reverse=True,
            )
            results = candidates[:limit]

        now_ms = int(time.time() * 1000)
        for e in results:
            e.access_count += 1
            e.last_accessed_at = now_ms

        # Include related (best-effort)
        if query.include_related:
            related: list[Experience] = []
            seen = {e.id for e in results}
            for e in results:
                for rel_id in e.related_experiences or []:
                    rel = self._experiences.get(rel_id)
                    if rel and rel.id not in seen:
                        related.append(rel)
                        seen.add(rel.id)
            results = results + related

        return results

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

        scored: list[SimilarityResult] = []
        for exp in pool:
            exp_tokens = _tokenize(f"{exp.context} {exp.action} {exp.result} {exp.learning}")
            sim = _jaccard(query_tokens, exp_tokens)
            if sim <= 0:
                continue
            scored.append(SimilarityResult(experience=exp, similarity=sim))

        scored.sort(key=lambda r: r.similarity, reverse=True)
        return [r.experience for r in scored[:limit]]

    def _prune_if_needed(self) -> None:
        if len(self._experiences) <= self._max_experiences:
            return

        # Remove least important, least accessed, oldest
        items = list(self._experiences.values())
        items.sort(
            key=lambda e: (e.importance, e.access_count, e.created_at),
        )
        to_remove = items[: max(0, len(items) - self._max_experiences)]
        for exp in to_remove:
            self._experiences.pop(exp.id, None)


def _tokenize(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9_]+", text.lower()))


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = a.intersection(b)
    union = a.union(b)
    return len(inter) / len(union) if union else 0.0
