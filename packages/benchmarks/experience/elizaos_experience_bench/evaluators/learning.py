"""Evaluate the learning cycle: encounter problem -> record experience -> retrieve when similar."""

from __future__ import annotations

import sys
import time
from collections.abc import Callable

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[4] / "plugins" / "plugin-experience" / "python"))

from elizaos_plugin_experience.service import ExperienceService
from elizaos_plugin_experience.types import ExperienceQuery

from elizaos_experience_bench.generator import GeneratedExperience, LearningScenario
from elizaos_experience_bench.types import LearningCycleMetrics

ServiceFactory = Callable[[], ExperienceService]


class LearningCycleEvaluator:
    """Evaluate the full learn-then-apply cycle.

    For each scenario:
    1. Load background experiences (noise) — 200 experiences to dilute random chance
    2. Record the learned experience (signal)
    3. Query with a similar problem
    4. Check if the learned experience is retrieved AND is in the top 3
    """

    def __init__(self, service_factory: ServiceFactory | None = None) -> None:
        self._service_factory = service_factory or ExperienceService

    def evaluate(
        self,
        background_experiences: list[GeneratedExperience],
        scenarios: list[LearningScenario],
    ) -> LearningCycleMetrics:
        """Run learning cycle evaluation."""
        now_ms = int(time.time() * 1000)

        recall_hits = 0
        precision_hits = 0
        cycle_successes = 0
        cycle_results: list[dict[str, object]] = []

        for scenario in scenarios:
            svc = self._service_factory()

            # Phase 0: Load background noise experiences
            for bg in background_experiences:
                offset_ms = int(bg.created_at_offset_days * 24 * 60 * 60 * 1000)
                svc.record_experience(
                    agent_id="bench-agent",
                    context=bg.context,
                    action=bg.action,
                    result=bg.result,
                    learning=bg.learning,
                    domain=bg.domain,
                    tags=bg.tags,
                    confidence=bg.confidence,
                    importance=bg.importance,
                    created_at=now_ms - offset_ms,
                )

            # Phase 1+2: Agent encounters problem and records experience
            learned = scenario.learned_experience
            recorded = svc.record_experience(
                agent_id="bench-agent",
                context=learned.context,
                action=learned.action,
                result=learned.result,
                learning=learned.learning,
                domain=learned.domain,
                tags=learned.tags,
                confidence=learned.confidence,
                importance=learned.importance,
                created_at=now_ms,
            )

            # Phase 3: Agent faces similar problem — query
            results = svc.query_experiences(ExperienceQuery(
                query=scenario.similar_query,
                limit=5,
            ))

            result_ids = [r.id for r in results]

            # Evaluate: did we retrieve the learned experience in top 5?
            retrieved = recorded.id in result_ids
            if retrieved:
                recall_hits += 1

            # Evaluate: is the top result the learned experience?
            top_is_learned = result_ids[0] == recorded.id if result_ids else False
            if top_is_learned:
                precision_hits += 1

            # Evaluate: is the learned experience in the top 3?
            # This is the tighter check — being in top 5 is too loose for a meaningful signal
            top3_ids = set(result_ids[:3])
            in_top3 = recorded.id in top3_ids

            # Keyword check: verify the LEARNED EXPERIENCE ITSELF contains expected keywords
            # (not any random result — that was a bug in the original version)
            learned_text = recorded.learning.lower()
            keywords_in_learned = all(
                kw.lower() in learned_text for kw in scenario.expected_learning_keywords
            )

            # Full cycle success: in top 3 AND keywords match the learned experience
            cycle_ok = in_top3 and keywords_in_learned
            if cycle_ok:
                cycle_successes += 1

            cycle_results.append({
                "query": scenario.similar_query,
                "domain": scenario.expected_domain,
                "retrieved": retrieved,
                "top_is_learned": top_is_learned,
                "in_top3": in_top3,
                "keywords_in_learned": keywords_in_learned,
                "cycle_success": cycle_ok,
                "num_results": len(results),
                "top_result_domain": results[0].domain if results else None,
                "learned_rank": result_ids.index(recorded.id) + 1 if recorded.id in result_ids else -1,
            })

        n = len(scenarios) or 1
        return LearningCycleMetrics(
            experience_recall_rate=recall_hits / n,
            experience_precision_rate=precision_hits / n,
            cycle_success_rate=cycle_successes / n,
            cycle_results=cycle_results,
        )
