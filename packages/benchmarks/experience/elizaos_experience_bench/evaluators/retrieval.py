"""Evaluate retrieval quality: precision@k, recall@k, MRR, hit rate."""

from __future__ import annotations

import sys
import time
from collections.abc import Callable

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[4] / "plugins" / "plugin-experience" / "python"))

from elizaos_plugin_experience.service import ExperienceService
from elizaos_plugin_experience.types import ExperienceQuery

from elizaos_experience_bench.generator import GeneratedExperience, RetrievalQuery
from elizaos_experience_bench.types import RetrievalMetrics

ServiceFactory = Callable[[], ExperienceService]


class RetrievalEvaluator:
    """Evaluate how well the experience service retrieves relevant experiences."""

    def __init__(
        self,
        top_k_values: list[int] | None = None,
        service_factory: ServiceFactory | None = None,
    ) -> None:
        self.top_k_values = top_k_values or [1, 3, 5, 10]
        self._service_factory = service_factory or ExperienceService

    def evaluate(
        self,
        experiences: list[GeneratedExperience],
        queries: list[RetrievalQuery],
    ) -> RetrievalMetrics:
        """Load experiences into the service and evaluate retrieval quality."""
        svc = self._service_factory()
        now_ms = int(time.time() * 1000)

        # Load all experiences
        exp_ids: list[str] = []
        for i, exp in enumerate(experiences):
            offset_ms = int(exp.created_at_offset_days * 24 * 60 * 60 * 1000)
            recorded = svc.record_experience(
                agent_id="bench-agent",
                context=exp.context,
                action=exp.action,
                result=exp.result,
                learning=exp.learning,
                domain=exp.domain,
                tags=exp.tags,
                confidence=exp.confidence,
                importance=exp.importance,
                created_at=now_ms - offset_ms,
            )
            exp_ids.append(recorded.id)

        max_k = max(self.top_k_values)
        precision_sums: dict[int, float] = {k: 0.0 for k in self.top_k_values}
        recall_sums: dict[int, float] = {k: 0.0 for k in self.top_k_values}
        hit_sums: dict[int, int] = {k: 0 for k in self.top_k_values}
        mrr_sum = 0.0

        for query in queries:
            results = svc.query_experiences(ExperienceQuery(
                query=query.query_text,
                limit=max_k,
            ))

            result_ids = [r.id for r in results]
            relevant_ids = {exp_ids[idx] for idx in query.relevant_indices}

            # MRR: reciprocal rank of first relevant result
            for rank, rid in enumerate(result_ids, 1):
                if rid in relevant_ids:
                    mrr_sum += 1.0 / rank
                    break

            for k in self.top_k_values:
                top_k_ids = set(result_ids[:k])
                hits = top_k_ids & relevant_ids

                precision = len(hits) / k if k > 0 else 0.0
                recall = len(hits) / len(relevant_ids) if relevant_ids else 0.0

                precision_sums[k] += precision
                recall_sums[k] += recall
                if hits:
                    hit_sums[k] += 1

        n = len(queries) or 1
        return RetrievalMetrics(
            precision_at_k={k: precision_sums[k] / n for k in self.top_k_values},
            recall_at_k={k: recall_sums[k] / n for k in self.top_k_values},
            mean_reciprocal_rank=mrr_sum / n,
            hit_rate_at_k={k: hit_sums[k] / n for k in self.top_k_values},
        )
