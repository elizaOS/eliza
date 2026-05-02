from __future__ import annotations

import random
from dataclasses import dataclass
from datetime import UTC, datetime

from elizaos.advanced_capabilities.experience.types import (
    Experience,
    ExperienceType,
    OutcomeType,
)


@dataclass
class ExperienceAnalysisResult:
    is_significant: bool
    learning: str | None = None
    confidence: float = 0.5
    related_experiences: list[str] | None = None
    actionable_insights: list[str] | None = None


@dataclass
class FailurePattern:
    learning: str
    related_ids: list[str]
    insights: list[str]


@dataclass
class DetectedPattern:
    description: str
    frequency: int
    experiences: list[str]
    significance: str  # "low" | "medium" | "high"


async def analyze_experience(
    partial_experience: dict[str, object],
    recent_experiences: list[Experience],
) -> ExperienceAnalysisResult:
    """Check if this experience represents something new or significant."""

    similar = _find_similar_experiences(partial_experience, recent_experiences)

    # If we've seen this exact pattern many times, it's less significant
    if len(similar) > 5:
        return ExperienceAnalysisResult(is_significant=False, confidence=0.3)

    # Check for contradictions with previous experiences
    contradictions = _find_contradictions(partial_experience, recent_experiences)
    if contradictions:
        first = contradictions[0]
        current_result = partial_experience.get("result", "unknown result")
        previous_result = first.result or "unknown result"

        return ExperienceAnalysisResult(
            is_significant=True,
            learning=f"New outcome contradicts previous experience: {current_result} vs {previous_result}",
            confidence=0.8,
            related_experiences=[e.id for e in contradictions],
            actionable_insights=["Update strategy based on new information"],
        )

    # Check if this is a first-time action
    action = partial_experience.get("action")
    exp_type = partial_experience.get("type")
    is_first_time = not any(e.action == action for e in recent_experiences)
    if is_first_time and exp_type == ExperienceType.SUCCESS:
        return ExperienceAnalysisResult(
            is_significant=True,
            learning=f"Successfully completed new action: {action}",
            confidence=0.7,
            actionable_insights=[f"{action} is now a known capability"],
        )

    # Check for failure patterns
    if exp_type == ExperienceType.FAILURE:
        failure_pattern = _detect_failure_pattern(partial_experience, recent_experiences)
        if failure_pattern:
            return ExperienceAnalysisResult(
                is_significant=True,
                learning=failure_pattern.learning,
                confidence=0.9,
                related_experiences=failure_pattern.related_ids,
                actionable_insights=failure_pattern.insights,
            )

    # Default: Record if confidence is high enough
    return ExperienceAnalysisResult(
        is_significant=(exp_type != ExperienceType.SUCCESS or random.random() > 0.7),
        confidence=0.5,
    )


def _find_similar_experiences(
    partial: dict[str, object],
    experiences: list[Experience],
) -> list[Experience]:
    return [
        e
        for e in experiences
        if (
            e.action == partial.get("action")
            and e.type == partial.get("type")
            and _similar_context(e.context, str(partial.get("context", "")))
        )
    ]


def _find_contradictions(
    partial: dict[str, object],
    experiences: list[Experience],
) -> list[Experience]:
    return [
        e
        for e in experiences
        if (
            e.action == partial.get("action")
            and e.context == partial.get("context")
            and e.type != partial.get("type")
        )
    ]


def _similar_context(context1: str, context2: str) -> bool:
    """Simple similarity check based on word overlap."""
    words1 = context1.lower().split()
    words2 = context2.lower().split()
    if not words1 or not words2:
        return False
    common_words = [w for w in words1 if w in words2]
    return len(common_words) / max(len(words1), len(words2)) > 0.5


def _detect_failure_pattern(
    partial: dict[str, object],
    experiences: list[Experience],
) -> FailurePattern | None:
    recent_failures = [e for e in experiences if e.type == ExperienceType.FAILURE][:10]
    action = partial.get("action")

    # Check for repeated failures
    same_action_failures = [e for e in recent_failures if e.action == action]
    if len(same_action_failures) >= 3:
        return FailurePattern(
            learning=(
                f"Action {action} has failed {len(same_action_failures)} times recently. "
                "Need alternative approach."
            ),
            related_ids=[e.id for e in same_action_failures],
            insights=[
                f"Avoid {action} until root cause is addressed",
                "Consider alternative actions to achieve the same goal",
            ],
        )

    # Check for cascading failures
    if len(recent_failures) >= 5:
        return FailurePattern(
            learning="Multiple consecutive failures detected. System may be in unstable state.",
            related_ids=[e.id for e in recent_failures[:5]],
            insights=[
                "Pause and reassess current approach",
                "Check system health and dependencies",
            ],
        )

    return None


async def detect_patterns(experiences: list[Experience]) -> list[DetectedPattern]:
    patterns: list[DetectedPattern] = []

    # Group experiences by action
    action_groups: dict[str, list[Experience]] = {}
    for exp in experiences:
        action_groups.setdefault(exp.action, []).append(exp)

    # Detect success/failure patterns
    for action, group in action_groups.items():
        positive_count = sum(1 for e in group if e.outcome == OutcomeType.POSITIVE)
        success_rate = positive_count / len(group) if group else 0

        if len(group) >= 5:
            if success_rate < 0.3:
                patterns.append(
                    DetectedPattern(
                        description=f"Action {action} has low success rate ({round(success_rate * 100)}%)",
                        frequency=len(group),
                        experiences=[e.id for e in group],
                        significance="high",
                    )
                )
            elif success_rate > 0.9:
                patterns.append(
                    DetectedPattern(
                        description=f"Action {action} is highly reliable ({round(success_rate * 100)}% success)",
                        frequency=len(group),
                        experiences=[e.id for e in group],
                        significance="medium",
                    )
                )

    # Detect time-based patterns
    hourly_groups = _group_by_hour(experiences)
    for hour, group in hourly_groups.items():
        if len(group) >= 10:
            negative_count = sum(1 for e in group if e.outcome == OutcomeType.NEGATIVE)
            failure_rate = negative_count / len(group)
            if failure_rate > 0.5:
                patterns.append(
                    DetectedPattern(
                        description=f"Higher failure rate during hour {hour} ({round(failure_rate * 100)}%)",
                        frequency=len(group),
                        experiences=[e.id for e in group[:5]],
                        significance="medium",
                    )
                )

    # Detect learning velocity
    learning_experiences = [
        e for e in experiences if e.type in (ExperienceType.DISCOVERY, ExperienceType.LEARNING)
    ]

    if len(learning_experiences) >= 3:
        recent_learning = learning_experiences[:10]
        time_diffs: list[int] = []
        for i in range(1, len(recent_learning)):
            prev = recent_learning[i - 1]
            curr = recent_learning[i]
            time_diffs.append(abs(prev.created_at - curr.created_at))

        if time_diffs:
            avg_time_between = sum(time_diffs) / len(time_diffs)
            patterns.append(
                DetectedPattern(
                    description=(
                        f"Learning new things every {round(avg_time_between / 60000)} "
                        "minutes on average"
                    ),
                    frequency=len(learning_experiences),
                    experiences=[e.id for e in recent_learning],
                    significance="medium",
                )
            )

    return patterns


def _group_by_hour(experiences: list[Experience]) -> dict[int, list[Experience]]:
    groups: dict[int, list[Experience]] = {}
    for exp in experiences:
        hour = datetime.fromtimestamp(exp.created_at / 1000, tz=UTC).hour
        groups.setdefault(hour, []).append(exp)
    return groups
