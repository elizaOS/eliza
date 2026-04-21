"""Evaluate hard hand-crafted benchmark cases.

Runs each case by loading its experiences into a fresh service, querying,
and checking whether the expected experience appears in the top results.
Reports per-category pass rates split by tier (jaccard vs semantic).
"""

from __future__ import annotations

import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, field

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[4] / "plugins" / "plugin-experience" / "python"))

from elizaos_plugin_experience.service import ExperienceService

from elizaos_experience_bench.hard_cases import (
    ALL_HARD_CASES,
    JACCARD_CATEGORIES,
    SEMANTIC_CATEGORIES,
    HardCase,
    get_all_cases,
)

ServiceFactory = Callable[[], ExperienceService]


@dataclass
class CategoryResult:
    """Results for a single category of hard cases."""

    category: str
    tier: str  # "jaccard" or "semantic"
    requires_embeddings: bool
    total: int = 0
    passed: int = 0
    failures: list[str] = field(default_factory=list)

    @property
    def rate(self) -> float:
        return self.passed / self.total if self.total > 0 else 0.0


@dataclass
class HardCaseResults:
    """Aggregated results from all hard case categories."""

    categories: list[CategoryResult] = field(default_factory=list)

    @property
    def jaccard_total(self) -> int:
        return sum(c.total for c in self.categories if c.tier == "jaccard")

    @property
    def jaccard_passed(self) -> int:
        return sum(c.passed for c in self.categories if c.tier == "jaccard")

    @property
    def jaccard_rate(self) -> float:
        t = self.jaccard_total
        return self.jaccard_passed / t if t > 0 else 0.0

    @property
    def semantic_total(self) -> int:
        return sum(c.total for c in self.categories if c.tier == "semantic")

    @property
    def semantic_passed(self) -> int:
        return sum(c.passed for c in self.categories if c.tier == "semantic")

    @property
    def semantic_rate(self) -> float:
        t = self.semantic_total
        return self.semantic_passed / t if t > 0 else 0.0

    @property
    def overall_total(self) -> int:
        return sum(c.total for c in self.categories)

    @property
    def overall_passed(self) -> int:
        return sum(c.passed for c in self.categories)

    @property
    def all_failures(self) -> list[str]:
        result: list[str] = []
        for c in self.categories:
            result.extend(c.failures)
        return result


class HardCaseEvaluator:
    """Evaluate hard hand-crafted benchmark cases."""

    def __init__(self, service_factory: ServiceFactory | None = None) -> None:
        self._service_factory = service_factory or ExperienceService

    def evaluate(self) -> HardCaseResults:
        """Run all hard cases and return per-category results."""
        results = HardCaseResults()

        for category_name, cases in ALL_HARD_CASES.items():
            if not cases:
                continue

            tier = "jaccard" if category_name in JACCARD_CATEGORIES else "semantic"
            requires_embeddings = category_name in SEMANTIC_CATEGORIES

            cat_result = CategoryResult(
                category=category_name,
                tier=tier,
                requires_embeddings=requires_embeddings,
                total=len(cases),
            )

            for case in cases:
                passed, failure_msg = self._run_case(case)
                if passed:
                    cat_result.passed += 1
                elif failure_msg:
                    cat_result.failures.append(failure_msg)

            results.categories.append(cat_result)

        return results

    def _run_case(self, case: HardCase) -> tuple[bool, str | None]:
        """Run a single hard case. Returns (passed, failure_message_or_none)."""
        svc = self._service_factory()
        now_ms = int(time.time() * 1000)

        # Load all experiences for this case
        recorded_ids: list[str] = []
        for exp_data in case.experiences:
            offset_ms = int(exp_data.created_at_offset_days * 24 * 60 * 60 * 1000)
            recorded = svc.record_experience(
                agent_id="hard-case-bench",
                context=exp_data.context,
                action=exp_data.action,
                result=exp_data.result,
                learning=exp_data.learning,
                domain=exp_data.domain,
                confidence=exp_data.confidence,
                importance=exp_data.importance,
                created_at=now_ms - offset_ms,
            )
            recorded_ids.append(recorded.id)

        expected_id = recorded_ids[case.expected_best_index]

        # Query
        results = svc.find_similar_experiences(case.query, limit=case.expected_within_top_k)
        result_ids = [r.id for r in results]

        # Check if the expected experience appears within top k
        if expected_id in result_ids:
            return True, None

        # Build detailed failure message
        top_domains = [r.domain for r in results[:3]] if results else ["<no results>"]
        expected_domain = case.experiences[case.expected_best_index].domain
        return False, (
            f"[{case.category}] {case.name}: expected '{expected_domain}' experience in top {case.expected_within_top_k}, "
            f"got domains={top_domains}. Query: '{case.query[:80]}...'"
        )
