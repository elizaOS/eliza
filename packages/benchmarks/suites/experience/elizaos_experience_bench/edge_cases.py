"""Edge-case expansion helpers for ExperienceBench scenarios."""

from __future__ import annotations

from dataclasses import replace
from typing import TypeVar

from elizaos_experience_bench.generator import LearningScenario, RetrievalQuery
from elizaos_experience_bench.hard_cases import HardCase

EDGE_VARIANTS: tuple[tuple[str, str], ...] = (
    (
        "incident-handoff",
        " Context: this came from an incident handoff; stale notes should not override the query.",
    ),
    (
        "mobile-typos",
        " Sent from mobile with terse wording and possible typos.",
    ),
    (
        "duplicate-report",
        " The same problem was reported twice; retrieve or apply the matching experience once.",
    ),
    (
        "noisy-ticket",
        " Ticket noise: priority labels and customer names may be unrelated.",
    ),
    (
        "recent-regression",
        " Treat this as a recent regression and prefer specific operational learnings.",
    ),
    (
        "cross-domain-distractor",
        " Ignore unrelated examples from other domains unless they solve this exact issue.",
    ),
    (
        "security-review",
        " Security review context: do not expose secrets; use the relevant prior fix or learning.",
    ),
    (
        "ambiguous-symptom",
        " The symptom is ambiguous, so prefer the experience that matches the root cause.",
    ),
    (
        "time-pressure",
        " The operator needs a fast but accurate answer for production triage.",
    ),
    (
        "audit-trail",
        " Keep the retrieved rationale auditable and tied to concrete prior evidence.",
    ),
)

T = TypeVar("T")


def expand_retrieval_queries(queries: list[RetrievalQuery]) -> list[RetrievalQuery]:
    expanded = list(queries)
    for query in queries:
        for variant_id, suffix in EDGE_VARIANTS:
            expanded.append(
                replace(
                    query,
                    query_text=f"{query.query_text}{suffix}",
                    cluster=f"{query.cluster}--edge-{variant_id}",
                )
            )
    return expanded


def expand_learning_scenarios(scenarios: list[LearningScenario]) -> list[LearningScenario]:
    expanded = list(scenarios)
    for index, scenario in enumerate(scenarios):
        for variant_id, suffix in EDGE_VARIANTS:
            expanded.append(
                replace(
                    scenario,
                    problem_context=f"{scenario.problem_context}{suffix}",
                    similar_query=f"{scenario.similar_query}{suffix}",
                )
            )
    return expanded


def expand_hard_cases(cases: list[HardCase]) -> list[HardCase]:
    expanded = list(cases)
    for case in cases:
        for variant_id, suffix in EDGE_VARIANTS:
            expanded.append(
                replace(
                    case,
                    name=f"{case.name}--edge-{variant_id}",
                    why_hard=f"{case.why_hard} Edge variant: {variant_id}.",
                    query=f"{case.query}{suffix}",
                )
            )
    return expanded


def expand_dict_cases(cases: list[dict[str, T]]) -> list[dict[str, T | str]]:
    expanded: list[dict[str, T | str]] = [dict(case) for case in cases]
    for index, case in enumerate(cases):
        for variant_id, suffix in EDGE_VARIANTS:
            edge_case: dict[str, T | str] = dict(case)
            edge_case["query"] = f"{case['query']}{suffix}"  # type: ignore[index]
            edge_case["edge_variant"] = variant_id
            edge_case["base_index"] = str(index)
            expanded.append(edge_case)
    return expanded


def count_expanded(base_count: int, *, include_edge_scenarios: bool) -> dict[str, int]:
    edge = base_count * len(EDGE_VARIANTS) if include_edge_scenarios else 0
    return {
        "base": base_count,
        "edge": edge,
        "total": base_count + edge,
        "edge_multiplier": len(EDGE_VARIANTS),
    }


def validate_unique_texts(items: list[str], label: str) -> list[str]:
    if len(items) == len(set(items)):
        return []
    return [f"{label}: duplicate scenario text found"]
