"""Local benchmark model of the built-in experience service.

The runtime implementation lives in TypeScript under advanced capabilities.
This Python model keeps the benchmark runnable without depending on the
removed external plugin package layout.
"""

from __future__ import annotations

import math
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import TypeAlias

ExperienceType: TypeAlias = str
OutcomeType: TypeAlias = str

_TOKEN_RE = re.compile(r"[a-z0-9_]+")
_STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "before",
    "by",
    "for",
    "from",
    "how",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "the",
    "to",
    "what",
    "when",
    "with",
}
_SYNONYM_GROUPS = {
    "debug": {"debugging", "troubleshooting", "diagnosing", "investigating"},
    "fix": {"fix", "resolve", "repair", "patch", "solve", "handle"},
    "install": {"install", "installed", "set", "setup", "configure", "add"},
    "optimize": {"optimize", "improve", "speed", "enhance"},
    "deploy": {"deploy", "deploying", "deployment", "release", "ship", "launch"},
    "check": {"check", "verify", "inspect", "examine", "validate"},
    "error": {"error", "bug", "issue", "problem", "fault"},
    "test": {"test", "tests", "testing", "suite", "verify", "validate", "check"},
    "reduce": {"reduce", "reduced", "minimize", "decrease", "lower"},
    "cache": {"cache", "caching", "store", "buffer", "memoize"},
    "query": {"query", "queries", "search", "lookup", "fetch"},
    "monitor": {"monitor", "monitoring", "track", "observe", "watch"},
    "failure": {"failure", "failures", "crash", "breakdown", "outage"},
    "performance": {"performance", "speed", "efficiency", "throughput"},
    "dependency": {"dependency", "dependencies", "requirement", "prerequisite", "library"},
    "connection": {"connection", "connections", "link", "session", "socket"},
    "memory": {"memory", "ram", "heap", "allocation"},
}
_CANONICAL_TOKEN = {
    token: canonical
    for canonical, tokens in _SYNONYM_GROUPS.items()
    for token in tokens | {canonical}
}


@dataclass
class Experience:
    id: str
    agent_id: str
    context: str
    action: str
    result: str
    learning: str
    domain: str = "general"
    tags: list[str] = field(default_factory=list)
    type: ExperienceType = "learning"
    outcome: OutcomeType = "neutral"
    confidence: float = 0.5
    importance: float = 0.5
    created_at: int = 0
    updated_at: int = 0
    last_accessed_at: int | None = None
    access_count: int = 0
    related_experiences: list[str] = field(default_factory=list)
    supersedes: str | None = None
    previous_belief: str | None = None
    corrected_belief: str | None = None


@dataclass
class ExperienceQuery:
    query: str | None = None
    type: ExperienceType | list[ExperienceType] | None = None
    outcome: OutcomeType | list[OutcomeType] | None = None
    domain: str | list[str] | None = None
    tags: list[str] | None = None
    min_importance: float | None = None
    min_confidence: float | None = None
    time_range: dict[str, int] | None = None
    limit: int = 10
    include_related: bool = False


class ExperienceService:
    """In-memory benchmark service matching the public experience operations."""

    def __init__(self) -> None:
        self._experiences: dict[str, Experience] = {}

    @property
    def experience_count(self) -> int:
        return len(self._experiences)

    def record_experience(
        self,
        *,
        agent_id: str,
        context: str = "",
        action: str = "",
        result: str = "",
        learning: str = "",
        domain: str = "general",
        tags: list[str] | None = None,
        confidence: float = 0.5,
        importance: float = 0.5,
        created_at: int | None = None,
        type: ExperienceType = "learning",
        outcome: OutcomeType = "neutral",
        related_experiences: list[str] | None = None,
        supersedes: str | None = None,
        previous_belief: str | None = None,
        corrected_belief: str | None = None,
    ) -> Experience:
        now_ms = int(time.time() * 1000)
        created = created_at if created_at is not None else now_ms
        experience = Experience(
            id=str(uuid.uuid4()),
            agent_id=agent_id,
            type=type,
            outcome=outcome,
            context=context,
            action=action,
            result=result,
            learning=learning,
            domain=domain,
            tags=list(tags or []),
            confidence=_clamp(confidence),
            importance=_clamp(importance),
            created_at=created,
            updated_at=now_ms,
            last_accessed_at=now_ms,
            related_experiences=list(related_experiences or []),
            supersedes=supersedes,
            previous_belief=previous_belief,
            corrected_belief=corrected_belief,
        )
        self._experiences[experience.id] = experience
        return experience

    def query_experiences(self, query: ExperienceQuery) -> list[Experience]:
        limit = max(1, query.limit)
        if query.query:
            candidates = self._apply_filters(list(self._experiences.values()), query)
            results = self.find_similar_experiences(query.query, limit=limit, candidates=candidates)
        else:
            results = self._apply_filters(list(self._experiences.values()), query)
            results.sort(
                key=lambda exp: (_decayed_confidence(exp) * exp.importance, exp.created_at),
                reverse=True,
            )
            results = results[:limit]

        if query.include_related:
            seen = {exp.id for exp in results}
            for exp in list(results):
                for related_id in exp.related_experiences:
                    related = self._experiences.get(related_id)
                    if related and related.id not in seen:
                        results.append(related)
                        seen.add(related.id)

        _touch(results)
        return results

    def find_similar_experiences(
        self,
        text: str,
        *,
        limit: int = 5,
        candidates: list[Experience] | None = None,
    ) -> list[Experience]:
        query_tokens = _tokenize(text)
        if not query_tokens:
            return []

        pool = candidates if candidates is not None else list(self._experiences.values())
        scored: list[tuple[Experience, float]] = []
        now_ms = int(time.time() * 1000)

        for exp in pool:
            exp_tokens = _tokenize(
                " ".join([exp.context, exp.action, exp.result, exp.learning, exp.domain, *exp.tags])
            )
            if not exp_tokens:
                continue

            intersection = query_tokens & exp_tokens
            if not intersection:
                continue

            coverage = len(intersection) / len(query_tokens)
            jaccard = len(intersection) / len(query_tokens | exp_tokens)
            recency = 1 / (1 + max(0, (now_ms - exp.created_at) / 86_400_000) / 30)
            access = min(1.0, math.log2(exp.access_count + 1) / math.log2(10))
            quality = (
                _decayed_confidence(exp) * 0.45
                + exp.importance * 0.35
                + recency * 0.12
                + access * 0.08
            )
            score = coverage * 0.62 + jaccard * 0.14 + quality * 0.24
            scored.append((exp, score))

        scored.sort(key=lambda item: item[1], reverse=True)
        results = [exp for exp, _score in scored[: max(1, limit)]]
        _touch(results)
        return results

    def _apply_filters(
        self,
        candidates: list[Experience],
        query: ExperienceQuery,
    ) -> list[Experience]:
        results = candidates

        if query.type:
            values = set(query.type if isinstance(query.type, list) else [query.type])
            results = [exp for exp in results if exp.type in values]
        if query.outcome:
            values = set(query.outcome if isinstance(query.outcome, list) else [query.outcome])
            results = [exp for exp in results if exp.outcome in values]
        if query.domain:
            values = set(query.domain if isinstance(query.domain, list) else [query.domain])
            results = [exp for exp in results if exp.domain in values]
        if query.tags:
            tags = set(query.tags)
            results = [exp for exp in results if tags & set(exp.tags)]
        if query.min_importance is not None:
            results = [exp for exp in results if exp.importance >= query.min_importance]
        if query.min_confidence is not None:
            results = [exp for exp in results if _decayed_confidence(exp) >= query.min_confidence]
        if query.time_range:
            start = query.time_range.get("start")
            end = query.time_range.get("end")
            if start is not None:
                results = [exp for exp in results if exp.created_at >= start]
            if end is not None:
                results = [exp for exp in results if exp.created_at <= end]

        return results


def _tokenize(text: str) -> set[str]:
    tokens: set[str] = set()
    for raw in _TOKEN_RE.findall(text.lower()):
        if raw in _STOPWORDS:
            continue
        token = raw[:-1] if len(raw) > 4 and raw.endswith("s") else raw
        tokens.add(_CANONICAL_TOKEN.get(token, token))
    return tokens


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _decayed_confidence(exp: Experience) -> float:
    age_ms = max(0, int(time.time() * 1000) - exp.created_at)
    grace_ms = 7 * 24 * 60 * 60 * 1000
    if age_ms < grace_ms:
        return exp.confidence
    half_life_ms = 30 * 24 * 60 * 60 * 1000
    decayed = exp.confidence * (0.5 ** ((age_ms - grace_ms) / half_life_ms))
    return max(0.1, decayed)


def _touch(experiences: list[Experience]) -> None:
    now_ms = int(time.time() * 1000)
    for exp in experiences:
        exp.access_count += 1
        exp.last_accessed_at = now_ms
