"""Benchmark orchestration for WooBench.

Runs scenarios against a reading agent and collects results.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import statistics
from datetime import datetime, timezone
from typing import Callable, Any, Optional

from .evaluator import WooBenchEvaluator
from .scorer import WooBenchScorer
from .types import BenchmarkResult, RevenueResult, ScenarioResult, Scenario

logger = logging.getLogger(__name__)


class WooBenchRunner:
    """Orchestrates WooBench benchmark runs.

    Parameters
    ----------
    agent_fn : Callable
        An async function that takes conversation history
        (``list[dict[str, str]]``) and returns the agent's next message
        as a string.
    evaluator_model : str
        Model name for the LLM evaluator (e.g. ``"gpt-5"``).
    scenarios : list[Scenario] | None
        Specific scenarios to run. If ``None``, all scenarios are loaded.
    concurrency : int
        Maximum number of scenarios to run concurrently.
    """

    def __init__(
        self,
        agent_fn: Callable[[list[dict[str, str]]], Any],
        evaluator_model: str = "gpt-5",
        scenarios: Optional[list[Scenario]] = None,
        concurrency: int = 4,
    ):
        self.agent_fn = agent_fn
        self.evaluator_model = evaluator_model
        self.concurrency = concurrency

        if scenarios is not None:
            self.scenarios = scenarios
        else:
            from .scenarios import ALL_SCENARIOS
            self.scenarios = ALL_SCENARIOS

        self.evaluator = WooBenchEvaluator(evaluator_model=evaluator_model)

    # ------------------------------------------------------------------
    # Run methods
    # ------------------------------------------------------------------

    async def run_all(self) -> BenchmarkResult:
        """Run all configured scenarios and return aggregated results."""
        results = await self._run_scenarios(self.scenarios)
        scorer = WooBenchScorer(results)
        return scorer.compile_benchmark_result(
            model_name=self.evaluator_model,
            timestamp=datetime.now(timezone.utc).isoformat(),
        )

    async def run_system(self, system: str) -> list[ScenarioResult]:
        """Run all scenarios for a specific divination system."""
        filtered = [
            s for s in self.scenarios
            if s.system.value == system
        ]
        if not filtered:
            logger.warning("No scenarios found for system %r", system)
            return []
        return await self._run_scenarios(filtered)

    async def run_archetype(self, archetype: str) -> list[ScenarioResult]:
        """Run all scenarios for a specific persona archetype."""
        filtered = [
            s for s in self.scenarios
            if s.persona.archetype.value == archetype
        ]
        if not filtered:
            logger.warning("No scenarios found for archetype %r", archetype)
            return []
        return await self._run_scenarios(filtered)

    async def run_scenario_by_id(self, scenario_id: str) -> Optional[ScenarioResult]:
        """Run a single scenario by ID."""
        scenario = next(
            (s for s in self.scenarios if s.id == scenario_id),
            None,
        )
        if scenario is None:
            logger.error("Scenario %r not found", scenario_id)
            return None
        results = await self._run_scenarios([scenario])
        return results[0] if results else None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _run_scenarios(
        self,
        scenarios: list[Scenario],
    ) -> list[ScenarioResult]:
        """Run a list of scenarios with concurrency control."""
        semaphore = asyncio.Semaphore(self.concurrency)
        results: list[ScenarioResult] = []

        async def _run_one(scenario: Scenario) -> ScenarioResult:
            async with semaphore:
                logger.info(
                    "Running scenario: %s (%s)",
                    scenario.name,
                    scenario.id,
                )
                try:
                    result = await self.evaluator.run_scenario(
                        scenario=scenario,
                        agent_fn=self.agent_fn,
                    )
                    logger.info(
                        "Scenario %s complete: score=%.1f/%d, turns=%d",
                        scenario.id,
                        result.total_score,
                        result.max_possible_score,
                        result.conversation_length,
                    )
                    return result
                except Exception as e:
                    logger.error(
                        "Scenario %s failed: %s", scenario.id, e,
                        exc_info=True,
                    )
                    # Return a zero-score result on failure
                    return ScenarioResult(
                        scenario_id=scenario.id,
                        turns=[],
                        total_score=0.0,
                        max_possible_score=scenario.scoring.max_score,
                        score_by_category={},
                        conversation_length=0,
                        persona_engaged=False,
                        payment_converted=False,
                        crisis_handled=False,
                        notes=f"ERROR: {e}",
                        revenue=RevenueResult(0, False, False, -1, 0, True),
                    )

        tasks = [_run_one(s) for s in scenarios]
        results = await asyncio.gather(*tasks)
        return list(results)

    # ------------------------------------------------------------------
    # Results persistence
    # ------------------------------------------------------------------

    @staticmethod
    def save_results(
        result: BenchmarkResult,
        output_dir: str = "benchmark_results",
    ) -> str:
        """Save benchmark results to a JSON file.

        Returns the path to the saved file.
        """
        os.makedirs(output_dir, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe_model_name = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(result.model_name)).strip("-") or "model"
        filename = f"woobench_{safe_model_name}_{timestamp}.json"
        filepath = os.path.join(output_dir, filename)

        # Serialize — convert dataclasses to dicts
        def _serialize(obj: Any) -> Any:
            if hasattr(obj, "__dataclass_fields__"):
                return {k: _serialize(v) for k, v in obj.__dict__.items()}
            if isinstance(obj, list):
                return [_serialize(item) for item in obj]
            if isinstance(obj, dict):
                return {k: _serialize(v) for k, v in obj.items()}
            if hasattr(obj, "value"):  # Enum
                return obj.value
            return obj

        data = _serialize(result)
        with open(filepath, "w") as f:
            json.dump(data, f, indent=2, default=str)

        logger.info("Results saved to %s", filepath)
        return filepath

    @staticmethod
    def print_revenue_report(result: BenchmarkResult) -> None:
        """Print a revenue-focused summary of the benchmark results."""
        print(f"\n{'=' * 60}")
        print("  REVENUE REPORT")
        print(f"{'=' * 60}")
        print(f"  Total revenue:        ${result.total_revenue:.2f}")
        print(f"  Scam resistance:      {result.scam_resistance_rate:.0%}")
        scenarios_with_payment = sum(
            1 for s in result.scenarios if s.revenue.payment_received
        )
        print(
            f"  Scenarios w/ payment: "
            f"{scenarios_with_payment}/{len(result.scenarios)}"
        )
        total_free = sum(s.revenue.free_reveals_given for s in result.scenarios)
        print(f"  Free reveals given:   {total_free}")
        paid_scenarios = [
            s for s in result.scenarios if s.revenue.payment_received
        ]
        if paid_scenarios:
            avg_turns = statistics.mean(
                s.revenue.turns_to_payment for s in paid_scenarios
            )
            avg_amount = statistics.mean(
                s.revenue.amount_earned for s in paid_scenarios
            )
            print(f"  Avg turns to payment: {avg_turns:.1f}")
            print(f"  Avg payment amount:   ${avg_amount:.2f}")
        print(f"{'=' * 60}\n")

    @staticmethod
    def print_summary(result: BenchmarkResult) -> None:
        """Print a human-readable summary of the benchmark results."""
        print("\n" + "=" * 60)
        print("  WooBench Results Summary")
        print("=" * 60)
        print(f"  Model:              {result.model_name}")
        print(f"  Timestamp:          {result.timestamp}")
        print(f"  Scenarios run:      {len(result.scenarios)}")
        print(f"  Overall WooScore:   {result.overall_score:.1f}/100")
        print()

        print("  Scores by System:")
        for system, score in sorted(result.score_by_system.items()):
            print(f"    {system:<15} {score:.1f}/100")
        print()

        print("  Scores by Archetype:")
        for arch, score in sorted(result.score_by_archetype.items()):
            print(f"    {arch:<20} {score:.1f}/100")
        print()

        print(f"  Revenue Efficiency: {result.revenue_efficiency:.1%}")
        print(f"  Engagement Depth:   {result.engagement_depth:.1f} turns avg")
        print(f"  Resilience Score:   {result.resilience_score:.1f}/100")
        print("=" * 60)

        # Append revenue report
        WooBenchRunner.print_revenue_report(result)
