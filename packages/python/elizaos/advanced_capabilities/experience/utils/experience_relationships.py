from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    pass

from elizaos.advanced_capabilities.experience.types import (
    Experience,
    ExperienceType,
    JsonObject,
    OutcomeType,
)

RelationshipType = Literal["causes", "contradicts", "supports", "supersedes", "related"]


@dataclass
class ExperienceChain:
    root_experience: str  # UUID of the root experience
    chain: list[str] = field(default_factory=list)  # Ordered list of experience IDs
    strength: float = 0.0  # How strong the causal relationship is
    validated: bool = False  # Whether the chain has been validated


@dataclass
class ExperienceRelationship:
    from_id: str
    to_id: str
    type: RelationshipType
    strength: float  # 0-1
    metadata: JsonObject | None = None


class ExperienceRelationshipManager:
    """Manages relationships between experiences (causal chains, contradictions, etc.)."""

    def __init__(self) -> None:
        self._relationships: dict[str, list[ExperienceRelationship]] = {}

    def add_relationship(self, relationship: ExperienceRelationship) -> None:
        from_id = relationship.from_id
        self._relationships.setdefault(from_id, []).append(relationship)

    def find_relationships(
        self,
        experience_id: str,
        rel_type: RelationshipType | None = None,
    ) -> list[ExperienceRelationship]:
        rels = self._relationships.get(experience_id, [])
        if rel_type is not None:
            return [r for r in rels if r.type == rel_type]
        return list(rels)

    def detect_causal_chain(self, experiences: list[Experience]) -> list[ExperienceChain]:
        chains: list[ExperienceChain] = []

        # Sort experiences by timestamp
        sorted_exps = sorted(experiences, key=lambda e: e.created_at)

        # Look for sequences where validation follows hypothesis
        for i, current in enumerate(sorted_exps[:-1]):
            if current.type != ExperienceType.HYPOTHESIS:
                continue

            chain_ids: list[str] = [current.id]
            j = i + 1

            while j < len(sorted_exps):
                next_exp = sorted_exps[j]

                # Check if next experience validates or contradicts the hypothesis
                is_explicitly_related = (
                    next_exp.related_experiences is not None
                    and current.id in next_exp.related_experiences
                )
                if is_explicitly_related or self._is_related(current, next_exp):
                    chain_ids.append(next_exp.id)

                    # If we found a validation, create a chain
                    if next_exp.type == ExperienceType.VALIDATION:
                        chains.append(
                            ExperienceChain(
                                root_experience=current.id,
                                chain=chain_ids,
                                strength=next_exp.confidence,
                                validated=next_exp.outcome == OutcomeType.POSITIVE,
                            )
                        )
                        break
                j += 1

        return chains

    def _is_related(self, exp1: Experience, exp2: Experience) -> bool:
        """Check if two experiences are related by domain, temporal proximity, and content."""
        if exp1.domain != exp2.domain:
            return False

        # Check temporal proximity (within 5 minutes)
        time_diff = abs(exp2.created_at - exp1.created_at)
        if time_diff >= 5 * 60 * 1000:
            return False

        # Check content similarity
        return self._content_similarity(exp1, exp2) > 0.7

    @staticmethod
    def _content_similarity(exp1: Experience, exp2: Experience) -> float:
        """Simple keyword overlap (Jaccard similarity)."""
        words1 = set(exp1.learning.lower().split())
        words2 = set(exp2.learning.lower().split())

        union = words1 | words2
        if not union:
            return 0.0

        intersection = words1 & words2
        return len(intersection) / len(union)

    def find_contradictions(
        self,
        experience: Experience,
        all_experiences: list[Experience],
    ) -> list[Experience]:
        contradictions: list[Experience] = []

        for other in all_experiences:
            if other.id == experience.id:
                continue

            # Same action, different outcome, same domain
            if (
                other.action == experience.action
                and other.outcome != experience.outcome
                and other.domain == experience.domain
            ):
                contradictions.append(other)

            # Explicit contradiction relationship
            rels = self.find_relationships(experience.id, "contradicts")
            if any(r.to_id == other.id for r in rels):
                if other not in contradictions:
                    contradictions.append(other)

        return contradictions

    def get_experience_impact(
        self,
        experience_id: str,
        all_experiences: list[Experience],
    ) -> float:
        impact = 0.0

        for exp in all_experiences:
            if exp.related_experiences and experience_id in exp.related_experiences:
                impact += exp.importance

        # Add impact from relationships
        relationships = self.find_relationships(experience_id)
        for rel in relationships:
            if rel.type == "causes":
                impact += rel.strength

        return impact
