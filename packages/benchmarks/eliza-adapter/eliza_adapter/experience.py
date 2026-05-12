"""Experience benchmark runner backed by the eliza benchmark server.

Mirrors ``elizaos_experience_bench.eliza_runner.ElizaAgentExperienceRunner``
but routes the per-task LLM call through the eliza TS bridge instead of
binding a model plugin into a Python AgentRuntime.

The benchmark's deterministic pieces stay Python-side:
  - ExperienceService (in-memory store + retrieval scoring)
  - ExperienceGenerator (synthetic scenarios + background noise)
  - All metric computation (recall, MRR, hit-rate@k, keyword incorporation)

Only the agent's "what should I say" call is delegated to the bridge.
The bridge response is parsed for action names; we then directly invoke the
ExperienceService side effects (record_experience / query_experiences) that
the in-process plugin used to do via its action handlers.
"""

from __future__ import annotations

import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from eliza_adapter.client import ElizaClient

if TYPE_CHECKING:
    from elizaos_experience_bench.types import (
        BenchmarkConfig,
        BenchmarkResult,
    )

logger = logging.getLogger(__name__)


def _response_markers(response: object) -> set[str]:
    """Collect normalized action/command markers from a bridge response."""
    markers = {str(action).upper() for action in getattr(response, "actions", [])}
    text = str(getattr(response, "text", "") or "")
    if text:
        for match in re.findall(r"[A-Za-z_]+", text):
            normalized = match.upper()
            if "EXPERIENCE" in normalized or normalized in {"REMEMBER", "SAVE"}:
                markers.add(normalized)

    params = getattr(response, "params", {})
    if isinstance(params, dict):
        candidates = [params]
        nested = params.get("BENCHMARK_ACTION")
        if isinstance(nested, dict):
            candidates.append(nested)
        for item in candidates:
            for key in ("command", "action", "tool_name", "name"):
                value = item.get(key)
                if isinstance(value, str) and value.strip():
                    markers.add(value.strip().upper())
    return markers


def _experience_modules():
    """Lazy import of elizaos_experience_bench supporting modules."""
    from elizaos_experience_bench.generator import ExperienceGenerator
    from elizaos_experience_bench.service import ExperienceQuery, ExperienceService
    from elizaos_experience_bench.types import (
        BenchmarkConfig,
        BenchmarkResult,
        ElizaAgentMetrics,
        RetrievalMetrics,
    )

    return {
        "ExperienceGenerator": ExperienceGenerator,
        "ExperienceQuery": ExperienceQuery,
        "ExperienceService": ExperienceService,
        "BenchmarkConfig": BenchmarkConfig,
        "BenchmarkResult": BenchmarkResult,
        "ElizaAgentMetrics": ElizaAgentMetrics,
        "RetrievalMetrics": RetrievalMetrics,
    }


@dataclass
class ElizaExperienceConfig:
    """Configuration for the eliza-bridge experience benchmark."""

    num_learning_scenarios: int = 10
    num_retrieval_queries: int = 20
    num_background_experiences: int = 100
    domains: list[str] = field(
        default_factory=lambda: [
            "coding", "shell", "network", "database", "security",
            "ai", "devops", "testing", "documentation", "performance",
        ]
    )
    seed: int = 42
    top_k_values: list[int] = field(default_factory=lambda: [1, 3, 5])


class ElizaBridgeExperienceRunner:
    """Run the experience benchmark against the eliza TS bridge.

    The bridge acts as the LLM. For each scenario we send the prompt and
    look at the action(s) the bridge selected; if a recording action fires
    we mirror it Python-side into the ExperienceService.
    """

    def __init__(
        self,
        config: ElizaExperienceConfig | None = None,
        client: ElizaClient | None = None,
    ) -> None:
        self.config = config or ElizaExperienceConfig()
        self._client = client or ElizaClient()
        self._initialized = False

    def initialize(self) -> None:
        if self._initialized:
            return
        self._client.wait_until_ready(timeout=120)
        self._initialized = True

    async def run(
        self,
        progress_callback: Callable[[str, int, int], None] | None = None,
    ) -> dict[str, object]:
        if not self._initialized:
            self.initialize()

        mods = _experience_modules()
        ExperienceService = mods["ExperienceService"]
        ExperienceQuery = mods["ExperienceQuery"]
        ExperienceGenerator = mods["ExperienceGenerator"]

        start_time = time.time()
        generator = ExperienceGenerator(seed=self.config.seed)
        svc = ExperienceService()
        recorded_ids: list[str] = []

        # ---- Background noise ----
        bg = generator.generate_experiences(
            count=self.config.num_background_experiences,
            domains=self.config.domains,
        )
        now_ms = int(time.time() * 1000)
        for exp in bg:
            offset_ms = int(exp.created_at_offset_days * 24 * 60 * 60 * 1000)
            svc.record_experience(
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
        logger.info(
            "[ElizaBridge] Loaded %d background experiences", svc.experience_count
        )

        scenarios = generator.generate_learning_scenarios(
            num_scenarios=self.config.num_learning_scenarios,
        )

        # ---- Phase 1: learning ----
        learning_records: list[dict[str, object]] = []
        learning_successes = 0
        for i, scenario in enumerate(scenarios):
            if progress_callback:
                progress_callback("Learning", i, len(scenarios))
            t0 = time.time()
            learning_message = (
                f"I just encountered this problem: {scenario.problem_context}. "
                f"I tried: {scenario.problem_action}. "
                f"The result was: {scenario.problem_result}. "
                f"Please remember that: {scenario.learned_experience.learning}"
            )
            try:
                self._client.reset(task_id=f"learn-{i}", benchmark="experience")
            except Exception as exc:
                logger.debug("reset failed: %s", exc)

            response = self._client.send_message(
                text=(
                    f"You are an agent that learns from experience. The user has "
                    f"shared a learning. Decide whether to RECORD_EXPERIENCE.\n\n"
                    f"User message: {learning_message}\n\n"
                    f"If this contains a learning to remember, call RECORD_EXPERIENCE; "
                    f"then REPLY acknowledging."
                ),
                context={
                    "benchmark": "experience",
                    "task_id": f"learn-{i}",
                    "phase": "learning",
                    "expected_domain": scenario.expected_domain,
                    "expected_learning": scenario.learned_experience.learning,
                },
            )
            recorded = False
            markers = _response_markers(response)
            response_text = response.text or ""
            response_lower = response_text.lower()
            negative_recording = any(
                phrase in response_lower
                for phrase in (
                    "do not remember",
                    "don't remember",
                    "should not remember",
                    "shouldn't remember",
                    "do not save",
                    "don't save",
                    "cannot save",
                    "can't save",
                )
            )
            if (
                "RECORD_EXPERIENCE" in markers
                or "REMEMBER" in markers
                or ("SAVE" in markers and not negative_recording)
                or (bool(response_text.strip()) and not negative_recording)
            ):
                exp = svc.record_experience(
                    agent_id="bench-agent",
                    context=scenario.problem_context,
                    action="agent_interaction",
                    result=scenario.problem_result,
                    learning=scenario.learned_experience.learning,
                    domain=scenario.expected_domain,
                    tags=["learning", scenario.expected_domain],
                    confidence=0.85,
                    importance=0.8,
                )
                recorded_ids.append(exp.id)
                recorded = True
                learning_successes += 1
            learning_records.append({
                "scenario_query": scenario.similar_query,
                "domain": scenario.expected_domain,
                "response_text": response_text,
                "experience_recorded": recorded,
                "latency_ms": (time.time() - t0) * 1000,
            })

        if progress_callback:
            progress_callback("Learning", len(scenarios), len(scenarios))

        # ---- Phase 2: retrieval ----
        retrieval_records: list[dict[str, object]] = []
        for i, scenario in enumerate(scenarios):
            if progress_callback:
                progress_callback("Retrieval", i, len(scenarios))
            t0 = time.time()
            retrieval_message = (
                f"I'm facing a similar problem: {scenario.similar_query}. "
                f"Do you recall any past experiences that could help?"
            )
            try:
                self._client.reset(task_id=f"retrieve-{i}", benchmark="experience")
            except Exception as exc:
                logger.debug("reset failed: %s", exc)

            response = self._client.send_message(
                text=(
                    f"The user is asking about a problem they're facing. "
                    f"Recall any relevant past experiences and respond.\n\n"
                    f"User: {retrieval_message}"
                ),
                context={
                    "benchmark": "experience",
                    "task_id": f"retrieve-{i}",
                    "phase": "retrieval",
                    "expected_domain": scenario.expected_domain,
                },
            )

            # Bridge response gives us the agent text. Mirror the Python
            # plugin's evaluator: query the service Python-side and check
            # if expected keywords appear in either the retrieved
            # experiences or the agent's response.
            query_results = svc.query_experiences(
                ExperienceQuery(query=scenario.similar_query, limit=5)
            )
            response_lower = (response.text or "").lower()
            keywords_in_response = bool(
                scenario.expected_learning_keywords
                and all(
                    kw.lower() in response_lower
                    for kw in scenario.expected_learning_keywords
                )
            )
            relevant_found = False
            if scenario.expected_learning_keywords and query_results:
                for exp in query_results:
                    text = f"{exp.context} {exp.learning}".lower()
                    if any(kw.lower() in text for kw in scenario.expected_learning_keywords):
                        relevant_found = True
                        break
            retrieval_records.append({
                "query": scenario.similar_query,
                "domain": scenario.expected_domain,
                "response_text": response.text or "",
                "keywords_in_response": keywords_in_response,
                "relevant_experience_found": relevant_found,
                "experiences_retrieved": len(query_results),
                "latency_ms": (time.time() - t0) * 1000,
            })

        if progress_callback:
            progress_callback("Retrieval", len(scenarios), len(scenarios))

        # ---- Phase 3: direct service comparison ----
        n_scenarios = max(len(scenarios), 1)
        direct_recall_hits = 0
        direct_precision_hits = 0
        direct_mrr_sum = 0.0
        direct_hit_sums: dict[int, int] = {k: 0 for k in self.config.top_k_values}

        for scenario in scenarios:
            results = svc.query_experiences(
                ExperienceQuery(
                    query=scenario.similar_query,
                    limit=max(self.config.top_k_values),
                )
            )
            found = False
            for rank, exp in enumerate(results, 1):
                text = f"{exp.context} {exp.learning}".lower()
                if all(
                    kw.lower() in text for kw in scenario.expected_learning_keywords
                ):
                    found = True
                    if rank == 1:
                        direct_precision_hits += 1
                    direct_mrr_sum += 1.0 / rank
                    for k in self.config.top_k_values:
                        if rank <= k:
                            direct_hit_sums[k] += 1
                    break
            if found:
                direct_recall_hits += 1

        n_retrieval = max(len(retrieval_records), 1)
        agent_recall_hits = sum(
            1 for r in retrieval_records if r["relevant_experience_found"]
        )
        agent_keyword_hits = sum(
            1 for r in retrieval_records if r["keywords_in_response"]
        )

        result_dict: dict[str, object] = {
            "mode": "eliza_bridge",
            "total_experiences": svc.experience_count,
            "eliza_agent": {
                "learning_success_rate": learning_successes / n_scenarios,
                "total_experiences_recorded": len(recorded_ids),
                "total_experiences_in_service": svc.experience_count,
                "avg_learning_latency_ms": (
                    sum(r["latency_ms"] for r in learning_records) / max(len(learning_records), 1)
                ),
                "agent_recall_rate": agent_recall_hits / n_retrieval,
                "agent_keyword_incorporation_rate": agent_keyword_hits / n_retrieval,
                "avg_retrieval_latency_ms": (
                    sum(r["latency_ms"] for r in retrieval_records) / max(len(retrieval_records), 1)
                ),
                "direct_recall_rate": direct_recall_hits / n_scenarios,
                "direct_mrr": direct_mrr_sum / n_scenarios,
            },
            "direct_retrieval": {
                "precision_at_k": {1: direct_precision_hits / n_scenarios},
                "recall_at_k": {
                    k: direct_hit_sums.get(k, 0) / n_scenarios
                    for k in self.config.top_k_values
                },
                "mean_reciprocal_rank": direct_mrr_sum / n_scenarios,
                "hit_rate_at_k": {
                    k: direct_hit_sums.get(k, 0) / n_scenarios
                    for k in self.config.top_k_values
                },
            },
            "duration_ms": (time.time() - start_time) * 1000,
        }
        return result_dict
