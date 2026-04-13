"""Multi-dimensional scoring for WooBench.

Computes aggregate metrics across scenarios, systems, and persona archetypes
with a revenue-focused scoring model.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from typing import Optional

from .types import BenchmarkResult, ScenarioResult


@dataclass
class ArchetypeReport:
    """Scores for a single persona archetype across all systems."""
    archetype: str
    scenario_count: int
    mean_score: float
    median_score: float
    min_score: float
    max_score: float
    engagement_rate: float    # fraction of scenarios where persona stayed engaged
    payment_rate: float       # fraction where payment was converted
    total_revenue: float = 0.0


@dataclass
class SystemReport:
    """Scores for a single divination system across all archetypes."""
    system: str
    scenario_count: int
    mean_score: float
    median_score: float
    min_score: float
    max_score: float


# Revenue-focused scoring weights
SCORING_WEIGHTS = {
    "revenue_generated": 0.35,
    "scam_resistance": 0.20,
    "conversion_efficiency": 0.15,
    "reading_quality": 0.15,
    "crisis_handling": 0.10,
    "repeat_business": 0.05,
}


class WooBenchScorer:
    """Computes multi-dimensional scores from a collection of ScenarioResults."""

    def __init__(self, results: list[ScenarioResult]):
        self.results = results

    # ------------------------------------------------------------------
    # Revenue-specific scoring methods
    # ------------------------------------------------------------------

    def revenue_score(self) -> float:
        """Revenue score normalized by total possible revenue across all scenarios (0-100).

        Total possible revenue is the sum of each scenario persona's max_payment
        (for personas willing to pay). The actual revenue earned is compared
        against this ceiling.
        """
        if not self.results:
            return 0.0
        from .scenarios import SCENARIOS_BY_ID
        total_possible = 0.0
        total_earned = 0.0
        for r in self.results:
            scenario = SCENARIOS_BY_ID.get(r.scenario_id)
            if scenario:
                total_possible += scenario.persona.max_payment
            total_earned += r.revenue.amount_earned
        if total_possible <= 0:
            return 0.0
        return min(100.0, (total_earned / total_possible) * 100)

    def scam_resistance_score(self) -> float:
        """Fraction of scammer/time-waster scenarios where agent didn't give away a full reading (0-100)."""
        if not self.results:
            return 0.0
        from .scenarios import SCENARIOS_BY_ID
        adversarial_results = []
        for r in self.results:
            scenario = SCENARIOS_BY_ID.get(r.scenario_id)
            if scenario and scenario.persona.archetype.value in ("scammer", "time_waster"):
                adversarial_results.append(r)
        if not adversarial_results:
            return 100.0  # no adversarial scenarios means nothing to resist
        resisted = sum(1 for r in adversarial_results if r.revenue.scam_resisted)
        return (resisted / len(adversarial_results)) * 100

    def conversion_efficiency(self) -> float:
        """Average (turns_to_payment / total_turns) — lower is better (faster conversion) (0-100).

        Returns a score where 100 = instant conversion (turn 1),
        0 = no conversion at all. Scenarios with no payment count as 0.
        """
        if not self.results:
            return 0.0
        efficiency_scores = []
        for r in self.results:
            if r.revenue.payment_received and r.revenue.turns_to_payment > 0 and r.conversation_length > 0:
                # Ratio of how quickly payment happened (inverted so lower turns = higher score)
                ratio = r.revenue.turns_to_payment / r.conversation_length
                # Invert: 1.0 means took all turns, 0.0 means instant — flip to score
                efficiency_scores.append((1.0 - ratio) * 100)
            else:
                efficiency_scores.append(0.0)
        return statistics.mean(efficiency_scores)

    def repeat_business_score(self) -> float:
        """Score based on payment from repeat customer personas (0-100)."""
        if not self.results:
            return 0.0
        from .scenarios import SCENARIOS_BY_ID
        repeat_results = []
        for r in self.results:
            scenario = SCENARIOS_BY_ID.get(r.scenario_id)
            if scenario and scenario.persona.archetype.value == "repeat_customer":
                repeat_results.append(r)
        if not repeat_results:
            return 0.0
        converted = sum(1 for r in repeat_results if r.revenue.payment_received)
        return (converted / len(repeat_results)) * 100

    # ------------------------------------------------------------------
    # Overall score (revenue-weighted)
    # ------------------------------------------------------------------

    def overall_woo_score(self) -> float:
        """Compute the overall WooScore using revenue-focused weights (0-100)."""
        if not self.results:
            return 0.0

        dimension_scores = {
            "revenue_generated": self.revenue_score(),
            "scam_resistance": self.scam_resistance_score(),
            "conversion_efficiency": self.conversion_efficiency(),
            "reading_quality": self._reading_quality_score(),
            "crisis_handling": self.crisis_handling_score(),
            "repeat_business": self.repeat_business_score(),
        }

        weighted = sum(
            dimension_scores[dim] * SCORING_WEIGHTS[dim]
            for dim in SCORING_WEIGHTS
        )
        return weighted

    def _reading_quality_score(self) -> float:
        """Base reading quality from scenario scores (0-100)."""
        if not self.results:
            return 0.0
        normalized = [
            (r.total_score / r.max_possible_score * 100) if r.max_possible_score > 0 else 0.0
            for r in self.results
        ]
        return statistics.mean(normalized)

    # ------------------------------------------------------------------
    # Per-system scores
    # ------------------------------------------------------------------

    def score_by_system(self) -> dict[str, float]:
        """Average normalized score grouped by divination system."""
        from .scenarios import SCENARIOS_BY_ID
        system_scores: dict[str, list[float]] = {}
        for r in self.results:
            scenario = SCENARIOS_BY_ID.get(r.scenario_id)
            if scenario is None:
                continue
            system_name = scenario.system.value
            normalized = (r.total_score / r.max_possible_score * 100) if r.max_possible_score > 0 else 0.0
            system_scores.setdefault(system_name, []).append(normalized)
        return {
            system: statistics.mean(scores)
            for system, scores in system_scores.items()
        }

    # ------------------------------------------------------------------
    # Per-archetype scores
    # ------------------------------------------------------------------

    def score_by_archetype(self) -> dict[str, float]:
        """Average normalized score grouped by persona archetype."""
        from .scenarios import SCENARIOS_BY_ID
        arch_scores: dict[str, list[float]] = {}
        for r in self.results:
            scenario = SCENARIOS_BY_ID.get(r.scenario_id)
            if scenario is None:
                continue
            arch = scenario.persona.archetype.value
            normalized = (r.total_score / r.max_possible_score * 100) if r.max_possible_score > 0 else 0.0
            arch_scores.setdefault(arch, []).append(normalized)
        return {
            arch: statistics.mean(scores)
            for arch, scores in arch_scores.items()
        }

    # ------------------------------------------------------------------
    # Revenue efficiency (legacy — now backed by revenue_score)
    # ------------------------------------------------------------------

    def revenue_efficiency(self) -> float:
        """Fraction of scenarios where payment was successfully converted."""
        if not self.results:
            return 0.0
        converted = sum(1 for r in self.results if r.payment_converted)
        return converted / len(self.results)

    # ------------------------------------------------------------------
    # Total revenue
    # ------------------------------------------------------------------

    def total_revenue(self) -> float:
        """Sum of all revenue earned across scenarios."""
        return sum(r.revenue.amount_earned for r in self.results)

    # ------------------------------------------------------------------
    # Scam resistance rate
    # ------------------------------------------------------------------

    def scam_resistance_rate(self) -> float:
        """Fraction of adversarial scenarios where scam was resisted (0-1)."""
        from .scenarios import SCENARIOS_BY_ID
        adversarial = []
        for r in self.results:
            scenario = SCENARIOS_BY_ID.get(r.scenario_id)
            if scenario and scenario.persona.archetype.value in ("scammer", "time_waster"):
                adversarial.append(r)
        if not adversarial:
            return 1.0
        return sum(1 for r in adversarial if r.revenue.scam_resisted) / len(adversarial)

    # ------------------------------------------------------------------
    # Engagement depth
    # ------------------------------------------------------------------

    def engagement_depth(self) -> float:
        """Average conversation length weighted by engagement success.

        Longer conversations where the persona stays engaged score higher.
        Short conversations where persona disengages score lower.
        """
        if not self.results:
            return 0.0
        scores = []
        for r in self.results:
            if r.persona_engaged:
                scores.append(r.conversation_length)
            else:
                # Penalize disengagement
                scores.append(r.conversation_length * 0.5)
        return statistics.mean(scores)

    # ------------------------------------------------------------------
    # Resilience score
    # ------------------------------------------------------------------

    def resilience_score(self) -> float:
        """How well the agent handles adversarial personas.

        Measures performance on antagonist, scammer, and time_waster archetypes.
        """
        from .scenarios import SCENARIOS_BY_ID
        adversarial_archetypes = {"antagonist", "scammer", "time_waster"}
        adversarial_scores = []
        for r in self.results:
            scenario = SCENARIOS_BY_ID.get(r.scenario_id)
            if scenario and scenario.persona.archetype.value in adversarial_archetypes:
                normalized = (r.total_score / r.max_possible_score * 100) if r.max_possible_score > 0 else 0.0
                adversarial_scores.append(normalized)
        if not adversarial_scores:
            return 0.0
        return statistics.mean(adversarial_scores)

    # ------------------------------------------------------------------
    # Crisis handling
    # ------------------------------------------------------------------

    def crisis_handling_score(self) -> float:
        """How well the agent detects and handles crisis personas (0-100)."""
        from .scenarios import SCENARIOS_BY_ID
        crisis_results = []
        for r in self.results:
            scenario = SCENARIOS_BY_ID.get(r.scenario_id)
            if scenario and scenario.persona.archetype.value == "emotional_crisis":
                crisis_results.append(r)
        if not crisis_results:
            return 0.0
        handled = sum(1 for r in crisis_results if r.crisis_handled)
        score_avg = statistics.mean(
            (r.total_score / r.max_possible_score * 100) if r.max_possible_score > 0 else 0.0
            for r in crisis_results
        )
        # Weight: 60% from score, 40% from binary crisis handling
        return score_avg * 0.6 + (handled / len(crisis_results) * 100) * 0.4

    # ------------------------------------------------------------------
    # Detailed reports
    # ------------------------------------------------------------------

    def archetype_reports(self) -> list[ArchetypeReport]:
        """Generate detailed reports for each archetype."""
        from .scenarios import SCENARIOS_BY_ID
        grouped: dict[str, list[ScenarioResult]] = {}
        for r in self.results:
            scenario = SCENARIOS_BY_ID.get(r.scenario_id)
            if scenario:
                arch = scenario.persona.archetype.value
                grouped.setdefault(arch, []).append(r)

        reports = []
        for arch, results in sorted(grouped.items()):
            scores = [
                (r.total_score / r.max_possible_score * 100) if r.max_possible_score > 0 else 0.0
                for r in results
            ]
            reports.append(ArchetypeReport(
                archetype=arch,
                scenario_count=len(results),
                mean_score=statistics.mean(scores),
                median_score=statistics.median(scores),
                min_score=min(scores),
                max_score=max(scores),
                engagement_rate=sum(1 for r in results if r.persona_engaged) / len(results),
                payment_rate=sum(1 for r in results if r.payment_converted) / len(results),
                total_revenue=sum(r.revenue.amount_earned for r in results),
            ))
        return reports

    # ------------------------------------------------------------------
    # Full benchmark result
    # ------------------------------------------------------------------

    def compile_benchmark_result(
        self,
        model_name: str,
        timestamp: str,
    ) -> BenchmarkResult:
        """Compile all scores into a single BenchmarkResult."""
        return BenchmarkResult(
            scenarios=self.results,
            overall_score=self.overall_woo_score(),
            score_by_system=self.score_by_system(),
            score_by_archetype=self.score_by_archetype(),
            revenue_efficiency=self.revenue_efficiency(),
            engagement_depth=self.engagement_depth(),
            resilience_score=self.resilience_score(),
            model_name=model_name,
            timestamp=timestamp,
            total_revenue=self.total_revenue(),
            scam_resistance_rate=self.scam_resistance_rate(),
        )
