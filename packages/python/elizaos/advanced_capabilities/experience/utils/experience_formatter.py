from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos.advanced_capabilities.experience.types import Experience

from elizaos.advanced_capabilities.experience.types import ExperienceType, OutcomeType

_TYPE_EMOJI: dict[ExperienceType, str] = {
    ExperienceType.SUCCESS: "V",
    ExperienceType.FAILURE: "X",
    ExperienceType.DISCOVERY: "*",
    ExperienceType.CORRECTION: "~",
    ExperienceType.LEARNING: "#",
    ExperienceType.HYPOTHESIS: "?",
    ExperienceType.VALIDATION: "+",
    ExperienceType.WARNING: "!",
}


def _get_type_marker(exp_type: ExperienceType) -> str:
    return _TYPE_EMOJI.get(exp_type, "-")


def format_experience_for_display(experience: Experience) -> str:
    marker = _get_type_marker(experience.type)
    timestamp = datetime.fromtimestamp(experience.created_at / 1000, tz=UTC).strftime(
        "%Y-%m-%d %H:%M:%S UTC"
    )

    return (
        f"[{marker}] {experience.type.upper()} - {timestamp}\n"
        f"Action: {experience.action}\n"
        f"Learning: {experience.learning}\n"
        f"Confidence: {round(experience.confidence * 100)}%\n"
        f"Importance: {round(experience.importance * 100)}%\n"
        f"Domain: {experience.domain}\n"
        f"Tags: {', '.join(experience.tags)}"
    )


def format_experience_summary(experience: Experience) -> str:
    marker = _get_type_marker(experience.type)
    return f"[{marker}] {experience.learning} ({round(experience.confidence * 100)}% confidence)"


def format_experience_list(experiences: list[Experience]) -> str:
    if not experiences:
        return "No experiences found."
    return "\n".join(
        f"{i + 1}. {format_experience_summary(exp)}" for i, exp in enumerate(experiences)
    )


def format_pattern_summary(pattern: dict[str, object]) -> str:
    significance = str(pattern.get("significance", ""))
    significance_marker = {"high": "[!!!]", "medium": "[!!]", "low": "[!]"}.get(significance, "[ ]")
    description = pattern.get("description", "")
    frequency = pattern.get("frequency", 0)
    return f"{significance_marker} {description} (observed {frequency} times)"


def group_experiences_by_domain(experiences: list[Experience]) -> dict[str, list[Experience]]:
    groups: dict[str, list[Experience]] = {}
    for exp in experiences:
        groups.setdefault(exp.domain, []).append(exp)
    return groups


def get_experience_stats(experiences: list[Experience]) -> dict[str, object]:
    total = len(experiences)
    by_type: dict[str, int] = {}
    by_outcome: dict[str, int] = {}
    by_domain: dict[str, int] = {}

    if total == 0:
        return {
            "total": 0,
            "by_type": by_type,
            "by_outcome": by_outcome,
            "by_domain": by_domain,
            "average_confidence": 0.0,
            "average_importance": 0.0,
            "success_rate": 0.0,
        }

    # Count by type
    for t in ExperienceType:
        count = sum(1 for e in experiences if e.type == t)
        by_type[t.value] = count

    # Count by outcome
    for o in OutcomeType:
        count = sum(1 for e in experiences if e.outcome == o)
        by_outcome[o.value] = count

    # Count by domain
    domains = {e.domain for e in experiences}
    for domain in domains:
        by_domain[domain] = sum(1 for e in experiences if e.domain == domain)

    # Calculate averages
    avg_confidence = sum(e.confidence for e in experiences) / total
    avg_importance = sum(e.importance for e in experiences) / total

    # Calculate success rate
    positive_count = by_outcome.get(OutcomeType.POSITIVE.value, 0)
    negative_count = by_outcome.get(OutcomeType.NEGATIVE.value, 0)
    total_attempts = positive_count + negative_count
    success_rate = positive_count / total_attempts if total_attempts > 0 else 0.0

    return {
        "total": total,
        "by_type": by_type,
        "by_outcome": by_outcome,
        "by_domain": by_domain,
        "average_confidence": avg_confidence,
        "average_importance": avg_importance,
        "success_rate": success_rate,
    }


def format_experience_for_rag(experience: Experience) -> str:
    """Format for knowledge storage and retrieval."""
    parts = [
        f"Experience Type: {experience.type}",
        f"Outcome: {experience.outcome}",
        f"Domain: {experience.domain}",
        f"Action: {experience.action}",
        f"Context: {experience.context}",
        f"Result: {experience.result}",
        f"Learning: {experience.learning}",
        f"Confidence: {experience.confidence}",
        f"Importance: {experience.importance}",
        f"Tags: {', '.join(experience.tags)}",
    ]

    if experience.previous_belief:
        parts.append(f"Previous Belief: {experience.previous_belief}")

    if experience.corrected_belief:
        parts.append(f"Corrected Belief: {experience.corrected_belief}")

    return "\n".join(parts)


def extract_keywords(experience: Experience) -> list[str]:
    keywords: set[str] = set()

    # Add tags
    for tag in experience.tags:
        keywords.add(tag.lower())

    # Extract words from learning
    learning_words = re.split(r"\W+", experience.learning.lower())
    for word in learning_words:
        if len(word) > 3:
            keywords.add(word)

    # Add action name parts
    action_parts = re.split(r"[_\-\s]+", experience.action)
    for part in action_parts:
        if len(part) > 2:
            keywords.add(part.lower())

    # Add type, outcome, and domain
    keywords.add(experience.type.value)
    keywords.add(experience.outcome.value)
    keywords.add(experience.domain)

    return list(keywords)
