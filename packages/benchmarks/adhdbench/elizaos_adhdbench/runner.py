"""Mock-passthrough ADHDBench runner — for harness smoke tests only.

This runner is deterministic by construction: it synthesizes responses from
each scenario's expected outcomes, so it always scores ~100%. It is NOT a
benchmark of any model and exists only to verify that the surrounding
plumbing (config, scoring, reporting) executes end-to-end.

Use ``--provider mock-passthrough`` to opt in. Production runs MUST select
a real provider (``openai``, ``cerebras``, ``groq``, ``openrouter``,
``vllm``, or ``eliza``) — the CLI fails loudly otherwise.
"""

from __future__ import annotations

import asyncio
import itertools
import logging
import time
from collections.abc import Callable

from elizaos_adhdbench.baselines import (
    BOOTSTRAP_ACTION_NAMES,
    compute_always_reply_baseline,
    compute_random_baseline,
)
from elizaos_adhdbench.config import ADHDBenchConfig
from elizaos_adhdbench.distractor_plugin import get_distractor_plugin_actions_for_scale
from elizaos_adhdbench.evaluator import compute_scenario_score, evaluate_outcome
from elizaos_adhdbench.reporting import ADHDBenchReporter
from elizaos_adhdbench.scenarios import get_scenarios
from elizaos_adhdbench.types import (
    BenchmarkResults,
    ExpectedOutcome,
    OutcomeType,
    ScalePoint,
    ScalingCurvePoint,
    Scenario,
    ScenarioResult,
    Turn,
    TurnResult,
)

ProgressCallback = Callable[[str, str, int, int], None]

logger = logging.getLogger("adhdbench.mock_passthrough")


class ADHDBenchRunner:
    """Mock-passthrough runner — deterministic, always ~100%, for plumbing tests.

    The class name is preserved for back-compat with external imports. Treat
    every score this produces as meaningless: it concatenates expected-outcome
    values into the response, so all evaluators trivially pass.
    """

    def __init__(self, config: ADHDBenchConfig) -> None:
        self.config = config
        logger.warning(
            "[WARNING] ADHDBenchRunner (mock-passthrough) selected. Scores from "
            "this runner are NOT a measurement of any model — it synthesizes "
            "responses from expected outcomes and will always score ~100%%. "
            "Use --provider {openai|cerebras|groq|openrouter|vllm|eliza} for "
            "real benchmarks."
        )

    async def run(self, progress_callback: ProgressCallback | None = None) -> BenchmarkResults:
        start = time.perf_counter()
        scenarios = get_scenarios(
            levels=self.config.levels,
            tags=self.config.tags,
            scenario_ids=self.config.scenario_ids,
        )
        results: list[ScenarioResult] = []

        total = len(self.config.config_names) * len(self.config.scale_points) * len(scenarios)
        current = 0
        for config_name in self.config.config_names:
            for scale in self.config.scale_points:
                for scenario in scenarios:
                    current += 1
                    if progress_callback is not None:
                        progress_callback(config_name, scale.label, current, total)
                    results.append(await self._run_scenario(scenario, scale, config_name))

        scaling_curves = self._build_scaling_curves(results)
        action_pool = BOOTSTRAP_ACTION_NAMES + [
            action.name
            for action in get_distractor_plugin_actions_for_scale(
                max((sp.action_count for sp in self.config.scale_points), default=len(BOOTSTRAP_ACTION_NAMES)),
                len(BOOTSTRAP_ACTION_NAMES),
            )
        ]
        benchmark_results = BenchmarkResults(
            metadata={
                "benchmark": "ADHDBench",
                "model": self.config.model_name,
                "provider": self.config.model_provider,
                "duration_ms": round((time.perf_counter() - start) * 1000, 1),
                "total_scenarios": len(results),
            },
            results=results,
            scaling_curves=scaling_curves,
            baselines={
                "random": compute_random_baseline(scenarios, action_pool),
                "always_reply": compute_always_reply_baseline(scenarios),
            },
        )

        if self.config.generate_report:
            ADHDBenchReporter(self.config).generate_report(benchmark_results)
        return benchmark_results

    async def _run_scenario(self, scenario: Scenario, scale: ScalePoint, config_name: str) -> ScenarioResult:
        turn_results: list[TurnResult] = []
        prefill = list(itertools.islice(itertools.cycle(self.config.prefill_topic_pool), scale.conversation_prefill))
        memory_text = " ".join(prefill)
        total_latency = 0.0

        for idx, turn in enumerate(scenario.turns):
            started = time.perf_counter()
            if turn.role == "system":
                memory_text = f"{memory_text} {turn.text}".strip()
                continue
            response = self._response_for_turn(turn, memory_text)
            actions = self._actions_for_turn(turn)
            providers = self._providers_for_turn(turn, scale)
            latency_ms = round((time.perf_counter() - started) * 1000, 3)
            total_latency += latency_ms
            result = TurnResult(
                turn_index=idx,
                actions_selected=actions,
                providers_requested=providers,
                response_text=response,
                providers_actually_run=providers,
                outcome_results=[],
                latency_ms=latency_ms,
                raw_llm_response=response,
                thought=response,
            )
            result.outcome_results = [evaluate_outcome(outcome, result) for outcome in turn.expected_outcomes]
            turn_results.append(result)
            memory_text = f"{memory_text} {turn.text} {response}".strip()
            if turn.delay_seconds > 0:
                await asyncio.sleep(min(turn.delay_seconds, 0.01))

        score = compute_scenario_score(turn_results, has_runtime_signal=False)
        return ScenarioResult(
            scenario_id=scenario.id,
            scenario_name=scenario.name,
            level=scenario.level,
            scale_point=scale,
            config_name=config_name,
            turn_results=turn_results,
            score=score,
            total_latency_ms=total_latency,
            model_name=self.config.model_name,
        )

    def _response_for_turn(self, turn: Turn, memory_text: str) -> str:
        parts = [turn.text, memory_text]
        for outcome in turn.expected_outcomes:
            if outcome.outcome_type in {
                OutcomeType.TEXT_CONTAINS,
                OutcomeType.MEMORY_RECALLED,
            } and isinstance(outcome.value, str):
                parts.append(outcome.value)
            elif outcome.outcome_type == OutcomeType.PARAM_MATCH and isinstance(outcome.value, dict):
                parts.extend(outcome.value.values())
        return " ".join(part for part in parts if part).strip() or "OK"

    def _actions_for_turn(self, turn: Turn) -> list[str]:
        actions: list[str] = []
        forbidden: set[str] = set()
        for outcome in turn.expected_outcomes:
            values = self._outcome_values(outcome)
            if outcome.outcome_type == OutcomeType.ACTION_MATCH:
                actions.extend(values[:1])
            elif outcome.outcome_type == OutcomeType.ACTION_NOT_MATCH:
                forbidden.update(values)
        if not actions and turn.expected_outcomes:
            actions.append("REPLY")
        return [action for action in actions if action not in forbidden]

    def _providers_for_turn(self, turn: Turn, scale: ScalePoint) -> list[str]:
        providers = ["CHARACTER", "RECENT_MESSAGES", "ENTITIES"]
        for outcome in turn.expected_outcomes:
            if outcome.outcome_type == OutcomeType.PROVIDERS_REQUESTED:
                providers.extend(self._outcome_values(outcome))
        return list(dict.fromkeys(providers[: max(0, scale.provider_count)]))

    def _outcome_values(self, outcome: ExpectedOutcome) -> list[str]:
        if isinstance(outcome.value, str):
            return [outcome.value]
        if isinstance(outcome.value, list):
            return [str(value) for value in outcome.value]
        return []

    def _build_scaling_curves(self, results: list[ScenarioResult]) -> dict[str, list[ScalingCurvePoint]]:
        curves: dict[str, list[ScalingCurvePoint]] = {}
        for config_name in self.config.config_names:
            points: list[ScalingCurvePoint] = []
            for scale in self.config.scale_points:
                matching = [
                    result for result in results
                    if result.config_name == config_name and result.scale_point.label == scale.label
                ]
                if not matching:
                    continue
                points.append(
                    ScalingCurvePoint(
                        scale_label=scale.label,
                        action_count=scale.action_count,
                        provider_count=scale.provider_count,
                        conversation_prefill=scale.conversation_prefill,
                        score=sum(result.score for result in matching) / len(matching),
                        latency_ms=sum(result.total_latency_ms for result in matching) / len(matching),
                        scenario_count=len(matching),
                    )
                )
            curves[config_name] = points
        return curves
