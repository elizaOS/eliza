from __future__ import annotations

import asyncio
import contextlib
import logging
import math
import time
from typing import TYPE_CHECKING, Any, ClassVar
from uuid import uuid4

from elizaos.advanced_capabilities.experience.types import (
    Experience,
    ExperienceAnalysis,
    ExperienceQuery,
    ExperienceType,
    OutcomeType,
)
from elizaos.advanced_capabilities.experience.utils.confidence_decay import (
    ConfidenceDecayManager,
)
from elizaos.advanced_capabilities.experience.utils.experience_relationships import (
    ExperienceRelationship,
    ExperienceRelationshipManager,
)
from elizaos.types import ModelType, Service

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime

logger = logging.getLogger("elizaos.experience")

# Constant for the service type string
EXPERIENCE_SERVICE_TYPE = "experience"


class ExperienceService(Service):
    """Manages agent experiences, learning from successes and failures to improve future decisions."""

    service_type: ClassVar[str] = EXPERIENCE_SERVICE_TYPE

    @property
    def capability_description(self) -> str:
        return "Manages agent experiences, learning from successes and failures to improve future decisions"

    def __init__(self, runtime: IAgentRuntime | None = None) -> None:
        super().__init__(runtime)
        self._experiences: dict[str, Experience] = {}
        self._experiences_by_domain: dict[str, set[str]] = {}
        self._experiences_by_type: dict[ExperienceType, set[str]] = {}
        self._dirty_experiences: set[str] = set()
        self._persist_task: asyncio.Task[None] | None = None
        self._decay_manager = ConfidenceDecayManager()
        self._relationship_manager = ExperienceRelationshipManager()

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> ExperienceService:
        service = cls(runtime)
        await service._load_experiences()

        # Start periodic persistence task
        service._persist_task = asyncio.create_task(service._persist_loop())

        return service

    async def stop(self) -> None:
        logger.info("[ExperienceService] Stopping...")

        # Cancel the persistence loop
        if self._persist_task is not None:
            self._persist_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._persist_task
            self._persist_task = None

        # Final persist of all experiences
        saved_count = 0
        for experience in self._experiences.values():
            try:
                await self._save_experience_to_memory(experience)
                saved_count += 1
            except Exception as err:
                logger.warning(
                    "[ExperienceService] Failed to save experience %s: %s",
                    experience.id,
                    err,
                )

        self._dirty_experiences.clear()
        logger.info("[ExperienceService] Saved %d experiences", saved_count)

    async def _persist_loop(self) -> None:
        """Batch-persist dirty access counts every 60 seconds."""
        while True:
            await asyncio.sleep(60)
            await self._persist_dirty_experiences()

    async def _load_experiences(self) -> None:
        """Load experiences from the 'experiences' table."""
        memories = await self.runtime.get_memories(
            entity_id=str(self.runtime.agent_id),
            table_name="experiences",
        )

        for memory in memories:
            data: dict[str, Any] = {}
            if hasattr(memory, "content") and memory.content:
                content_data = getattr(memory.content, "data", None)
                if isinstance(content_data, dict):
                    data = content_data

            exp_id = data.get("id")
            if not exp_id:
                continue

            memory_created_at = (
                memory.created_at
                if isinstance(getattr(memory, "created_at", None), int)
                else _now_ms()
            )

            def _to_timestamp(value: Any, fallback: int) -> int:
                if value is None:
                    return fallback
                if isinstance(value, int):
                    return value
                if isinstance(value, float):
                    return int(value)
                return fallback

            experience = Experience(
                id=str(exp_id),
                agent_id=str(self.runtime.agent_id),
                type=ExperienceType(data.get("type", ExperienceType.LEARNING)),
                outcome=OutcomeType(data.get("outcome", OutcomeType.NEUTRAL)),
                context=str(data.get("context", "")),
                action=str(data.get("action", "")),
                result=str(data.get("result", "")),
                learning=str(data.get("learning", "")),
                domain=str(data.get("domain", "general")),
                tags=list(data.get("tags", [])),
                confidence=float(data.get("confidence", 0.5)),
                importance=float(data.get("importance", 0.5)),
                created_at=_to_timestamp(data.get("created_at"), memory_created_at),
                updated_at=_to_timestamp(data.get("updated_at"), memory_created_at),
                access_count=int(data.get("access_count", 0)),
                last_accessed_at=_to_timestamp(data.get("last_accessed_at"), memory_created_at),
                embedding=(
                    list(memory.embedding)
                    if hasattr(memory, "embedding")
                    and isinstance(getattr(memory, "embedding", None), list)
                    and len(memory.embedding) > 0
                    else data.get("embedding")
                ),
                related_experiences=data.get("related_experiences"),
                supersedes=data.get("supersedes"),
                previous_belief=data.get("previous_belief"),
                corrected_belief=data.get("corrected_belief"),
            )

            self._experiences[experience.id] = experience

            # Update indexes
            self._experiences_by_domain.setdefault(experience.domain, set()).add(experience.id)
            self._experiences_by_type.setdefault(experience.type, set()).add(experience.id)

        logger.info(
            "[ExperienceService] Loaded %d experiences from memory",
            len(self._experiences),
        )

    async def record_experience(self, experience_data: dict[str, Any]) -> Experience:
        """Record a new experience with optional embedding generation."""

        # Generate embedding for the experience (graceful fallback if unavailable)
        embedding_text = (
            f"{experience_data.get('context', '')} "
            f"{experience_data.get('action', '')} "
            f"{experience_data.get('result', '')} "
            f"{experience_data.get('learning', '')}"
        )
        embedding: list[float] | None = None
        try:
            result = await self.runtime.use_model(ModelType.TEXT_EMBEDDING, text=embedding_text)
            if isinstance(result, list) and len(result) > 0 and any(v != 0 for v in result):
                embedding = result
            else:
                logger.warning(
                    "[ExperienceService] Embedding model returned empty/zero vector, "
                    "storing without embedding"
                )
        except Exception as err:
            logger.warning(
                "[ExperienceService] Embedding generation failed, storing without embedding: %s",
                err,
            )

        now = _now_ms()

        experience = Experience(
            id=str(uuid4()),
            agent_id=str(self.runtime.agent_id),
            type=ExperienceType(experience_data.get("type", ExperienceType.LEARNING)),
            outcome=OutcomeType(experience_data.get("outcome", OutcomeType.NEUTRAL)),
            context=str(experience_data.get("context", "")),
            action=str(experience_data.get("action", "")),
            result=str(experience_data.get("result", "")),
            learning=str(experience_data.get("learning", "")),
            domain=str(experience_data.get("domain", "general")),
            tags=list(experience_data.get("tags", [])),
            confidence=float(experience_data.get("confidence", 0.5)),
            importance=float(experience_data.get("importance", 0.5)),
            created_at=now,
            updated_at=now,
            access_count=0,
            last_accessed_at=now,
            embedding=embedding,
            related_experiences=experience_data.get("related_experiences"),
            supersedes=experience_data.get("supersedes"),
            previous_belief=experience_data.get("previous_belief"),
            corrected_belief=experience_data.get("corrected_belief"),
        )

        # Store the experience
        self._experiences[experience.id] = experience

        # Update indexes
        self._experiences_by_domain.setdefault(experience.domain, set()).add(experience.id)
        self._experiences_by_type.setdefault(experience.type, set()).add(experience.id)

        # Save to memory service
        await self._save_experience_to_memory(experience)

        # Check for contradictions and add relationships
        all_experiences = list(self._experiences.values())
        contradictions = self._relationship_manager.find_contradictions(experience, all_experiences)

        for contradiction in contradictions:
            self._relationship_manager.add_relationship(
                ExperienceRelationship(
                    from_id=experience.id,
                    to_id=contradiction.id,
                    type="contradicts",
                    strength=0.8,
                )
            )

        logger.info(
            "[ExperienceService] Recorded experience: %s (%s)",
            experience.id,
            experience.type,
        )

        return experience

    async def _save_experience_to_memory(self, experience: Experience) -> None:
        """Persist an experience as a memory record."""
        data: dict[str, Any] = {
            "id": experience.id,
            "agent_id": experience.agent_id,
            "type": experience.type.value,
            "outcome": experience.outcome.value,
            "context": experience.context,
            "action": experience.action,
            "result": experience.result,
            "learning": experience.learning,
            "domain": experience.domain,
            "tags": experience.tags,
            "confidence": experience.confidence,
            "importance": experience.importance,
            "created_at": experience.created_at,
            "updated_at": experience.updated_at,
            "access_count": experience.access_count,
        }
        if experience.last_accessed_at is not None:
            data["last_accessed_at"] = experience.last_accessed_at
        if experience.related_experiences is not None:
            data["related_experiences"] = experience.related_experiences
        if experience.supersedes is not None:
            data["supersedes"] = experience.supersedes
        if experience.previous_belief is not None:
            data["previous_belief"] = experience.previous_belief
        if experience.corrected_belief is not None:
            data["corrected_belief"] = experience.corrected_belief

        memory: dict[str, Any] = {
            "id": experience.id,
            "entity_id": str(self.runtime.agent_id),
            "agent_id": str(self.runtime.agent_id),
            "room_id": str(self.runtime.agent_id),
            "content": {
                "text": f"Experience: {experience.learning}",
                "type": "experience",
                "data": data,
            },
            "created_at": experience.created_at,
        }

        await self.runtime.create_memory(memory, "experiences", True)

    async def _persist_dirty_experiences(self) -> None:
        if not self._dirty_experiences:
            return

        to_save = list(self._dirty_experiences)
        self._dirty_experiences.clear()

        saved = 0
        for exp_id in to_save:
            exp = self._experiences.get(exp_id)
            if exp:
                try:
                    await self._save_experience_to_memory(exp)
                    saved += 1
                except Exception:
                    # Re-mark as dirty so it retries next cycle
                    self._dirty_experiences.add(exp_id)

        if saved > 0:
            logger.debug("[ExperienceService] Persisted %d dirty experiences", saved)

    async def query_experiences(self, query: ExperienceQuery) -> list[Experience]:
        """Query experiences with optional semantic search and filtering."""
        limit = query.limit or 10

        if query.query:
            # Semantic search path: over-fetch when filters will reduce the set
            has_filters = bool(
                query.type
                or query.outcome
                or query.domain
                or (query.tags and len(query.tags) > 0)
                or query.min_confidence is not None
                or query.min_importance is not None
                or query.time_range_start is not None
                or query.time_range_end is not None
            )
            fetch_limit = max(limit * 5, 50) if has_filters else limit
            candidates = self._apply_filters(
                await self.find_similar_experiences(query.query, fetch_limit),
                query,
            )
            results = candidates[:limit]
        else:
            # Non-semantic path: filter then sort by quality
            candidates = self._apply_filters(list(self._experiences.values()), query)
            candidates.sort(
                key=lambda e: self._decay_manager.get_decayed_confidence(e) * e.importance,
                reverse=True,
            )
            results = candidates[:limit]

        # Include related experiences if requested
        if query.include_related:
            related_ids: set[str] = set()
            for exp in results:
                if exp.related_experiences:
                    related_ids.update(exp.related_experiences)

            result_ids = {r.id for r in results}
            for rel_id in related_ids:
                if rel_id not in result_ids:
                    rel_exp = self._experiences.get(rel_id)
                    if rel_exp:
                        results.append(rel_exp)

        # Update access counts and mark dirty for batch persistence
        now = _now_ms()
        for exp in results:
            exp.access_count += 1
            exp.last_accessed_at = now
            self._dirty_experiences.add(exp.id)

        return results

    def _apply_filters(
        self,
        candidates: list[Experience],
        query: ExperienceQuery,
    ) -> list[Experience]:
        """Apply query filters (type, outcome, domain, tags, confidence, importance, timeRange)."""
        filtered = list(candidates)

        if query.type is not None:
            types = query.type if isinstance(query.type, list) else [query.type]
            filtered = [e for e in filtered if e.type in types]

        if query.outcome is not None:
            outcomes = query.outcome if isinstance(query.outcome, list) else [query.outcome]
            filtered = [e for e in filtered if e.outcome in outcomes]

        if query.domain is not None:
            domains = query.domain if isinstance(query.domain, list) else [query.domain]
            filtered = [e for e in filtered if e.domain in domains]

        if query.tags:
            tag_set = set(query.tags)
            filtered = [e for e in filtered if tag_set & set(e.tags)]

        if query.min_confidence is not None:
            min_conf = query.min_confidence
            filtered = [
                e for e in filtered if self._decay_manager.get_decayed_confidence(e) >= min_conf
            ]

        if query.min_importance is not None:
            min_imp = query.min_importance
            filtered = [e for e in filtered if e.importance >= min_imp]

        if query.time_range_start is not None:
            start = query.time_range_start
            filtered = [e for e in filtered if e.created_at >= start]

        if query.time_range_end is not None:
            end = query.time_range_end
            filtered = [e for e in filtered if e.created_at <= end]

        return filtered

    async def find_similar_experiences(
        self,
        text: str,
        limit: int = 5,
    ) -> list[Experience]:
        """Find similar experiences using vector search + reranking.

        Reranking strategy:
          Vector similarity is the dominant signal (70%) -- an irrelevant experience
          should never outrank a relevant one just because it has high confidence.
          Quality signals (confidence, importance) act as tiebreakers among
          similarly-relevant results (30% combined).
        """
        if not text or not self._experiences:
            return []

        try:
            query_embedding: list[float] = await self.runtime.use_model(
                ModelType.TEXT_EMBEDDING, text=text
            )
            if (
                not isinstance(query_embedding, list)
                or len(query_embedding) == 0
                or all(v == 0 for v in query_embedding)
            ):
                logger.warning(
                    "[ExperienceService] Query embedding is empty/zero, falling back to recency sort"
                )
                return self._fallback_sort(limit)
        except Exception:
            logger.warning(
                "[ExperienceService] Query embedding failed, falling back to recency sort"
            )
            return self._fallback_sort(limit)

        # Minimum cosine similarity to be considered a candidate at all
        similarity_floor = 0.05

        scored: list[tuple[Experience, float]] = []
        now = _now_ms()

        for experience in self._experiences.values():
            if not experience.embedding:
                continue

            similarity = _cosine_similarity(query_embedding, experience.embedding)
            if similarity < similarity_floor:
                continue

            # --- Quality signals (all normalized 0-1) ---

            # Confidence with time-decay applied
            decayed_confidence = self._decay_manager.get_decayed_confidence(experience)

            # Smooth recency: half-life of 30 days, never goes to zero
            age_days = max(0, (now - experience.created_at) / (24 * 60 * 60 * 1000))
            recency_factor = 1 / (1 + age_days / 30)

            # Access frequency: log-scaled, capped at 1.0
            access_factor = min(1.0, math.log2(experience.access_count + 1) / math.log2(10))

            # Weighted quality score (0-1 range)
            quality_score = (
                decayed_confidence * 0.45
                + experience.importance * 0.35
                + recency_factor * 0.12
                + access_factor * 0.08
            )

            # Final reranking score: similarity dominates (70%), quality tiebreaks (30%)
            rerank_score = similarity * 0.7 + quality_score * 0.3

            scored.append((experience, rerank_score))

        # Sort by combined reranking score (highest first)
        scored.sort(key=lambda x: x[1], reverse=True)
        results = [item[0] for item in scored[:limit]]

        for exp in results:
            exp.access_count += 1
            exp.last_accessed_at = now
            self._dirty_experiences.add(exp.id)

        return results

    def _fallback_sort(self, limit: int) -> list[Experience]:
        """Fallback when embeddings are unavailable: sort by decayed confidence * importance."""
        all_exps = list(self._experiences.values())
        all_exps.sort(
            key=lambda e: self._decay_manager.get_decayed_confidence(e) * e.importance,
            reverse=True,
        )
        return all_exps[:limit]

    async def analyze_experiences(
        self,
        domain: str | None = None,
        exp_type: ExperienceType | None = None,
    ) -> ExperienceAnalysis:
        """Analyze experiences for patterns and generate recommendations."""
        experiences = await self.query_experiences(
            ExperienceQuery(
                domain=[domain] if domain else None,
                type=[exp_type] if exp_type else None,
                limit=100,
            )
        )

        if not experiences:
            return ExperienceAnalysis(
                pattern="No experiences found for analysis",
                frequency=0,
                reliability=0.0,
                alternatives=[],
                recommendations=[],
            )

        learnings = [exp.learning for exp in experiences]
        common_words = self._find_common_patterns(learnings)

        avg_confidence = sum(exp.confidence for exp in experiences) / len(experiences)
        outcome_consistency = self._calculate_outcome_consistency(experiences)
        reliability = (avg_confidence + outcome_consistency) / 2

        alternatives = self._extract_alternatives(experiences)
        recommendations = self._generate_recommendations(experiences, reliability)

        return ExperienceAnalysis(
            pattern=(
                f"Common patterns: {', '.join(common_words)}"
                if common_words
                else "No clear patterns detected"
            ),
            frequency=len(experiences),
            reliability=reliability,
            alternatives=alternatives,
            recommendations=recommendations,
        )

    @staticmethod
    def _find_common_patterns(texts: list[str]) -> list[str]:
        word_freq: dict[str, int] = {}
        for text in texts:
            words = text.lower().split()
            for word in words:
                if len(word) > 3:
                    word_freq[word] = word_freq.get(word, 0) + 1

        threshold = len(texts) * 0.3
        sorted_words = sorted(
            ((word, count) for word, count in word_freq.items() if count >= threshold),
            key=lambda x: x[1],
            reverse=True,
        )
        return [word for word, _ in sorted_words[:5]]

    @staticmethod
    def _calculate_outcome_consistency(experiences: list[Experience]) -> float:
        if not experiences:
            return 0.0
        outcome_counts: dict[OutcomeType, int] = {}
        for exp in experiences:
            outcome_counts[exp.outcome] = outcome_counts.get(exp.outcome, 0) + 1
        max_count = max(outcome_counts.values())
        return max_count / len(experiences)

    @staticmethod
    def _extract_alternatives(experiences: list[Experience]) -> list[str]:
        import re

        alternatives: set[str] = set()
        for exp in experiences:
            if exp.type == ExperienceType.CORRECTION and exp.corrected_belief:
                alternatives.add(exp.corrected_belief)
            if exp.outcome == OutcomeType.NEGATIVE and "instead" in exp.learning:
                match = re.search(r"instead\s+(.+?)(?:\.|$)", exp.learning, re.IGNORECASE)
                if match:
                    alternative = match.group(1).strip()
                    if alternative:
                        alternatives.add(alternative)
        return list(alternatives)[:5]

    @staticmethod
    def _generate_recommendations(
        experiences: list[Experience],
        reliability: float,
    ) -> list[str]:
        recommendations: list[str] = []

        if reliability > 0.8:
            recommendations.append("Continue using successful approaches")
            recommendations.append("Document and share these reliable methods")
        elif reliability > 0.6:
            recommendations.append("Continue using successful approaches with caution")
            recommendations.append("Monitor for potential issues")
            recommendations.append("Consider backup strategies")
        elif reliability > 0.4:
            recommendations.append("Review and improve current approaches")
            recommendations.append("Investigate failure patterns")
            recommendations.append("Consider alternative methods")
        else:
            recommendations.append("Significant changes needed to current approach")
            recommendations.append("Analyze failure causes thoroughly")
            recommendations.append("Seek alternative solutions")

        failure_types: dict[str, int] = {}
        for e in experiences:
            if e.outcome == OutcomeType.NEGATIVE:
                key = e.learning.lower()
                failure_types[key] = failure_types.get(key, 0) + 1

        if failure_types:
            most_common = max(failure_types.items(), key=lambda x: x[1])
            if most_common[1] > 1:
                recommendations.append(f"Address recurring issue: {most_common[0]}")

        domains = {e.domain for e in experiences}
        if "shell" in domains:
            recommendations.append("Verify command syntax and permissions")
        if "coding" in domains:
            recommendations.append("Test thoroughly before deployment")
        if "network" in domains:
            recommendations.append("Implement retry logic and error handling")

        return recommendations[:5]


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """Compute cosine similarity between two vectors."""
    if len(a) != len(b):
        return 0.0

    dot_product = 0.0
    norm_a = 0.0
    norm_b = 0.0

    for va, vb in zip(a, b, strict=False):
        dot_product += va * vb
        norm_a += va * va
        norm_b += vb * vb

    if norm_a == 0 or norm_b == 0:
        return 0.0

    return dot_product / (math.sqrt(norm_a) * math.sqrt(norm_b))


def _now_ms() -> int:
    """Current time in milliseconds."""
    return int(time.time() * 1000)
