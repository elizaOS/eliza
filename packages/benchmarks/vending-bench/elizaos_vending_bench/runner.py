"""
Vending-Bench Runner

Orchestrates the full Vending-Bench benchmark evaluation.
"""

import json
import logging
import statistics
import time
from dataclasses import fields, is_dataclass
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from pathlib import Path

from elizaos_vending_bench.agent import LLMProvider, VendingAgent
from elizaos_vending_bench.environment import VendingEnvironment
from elizaos_vending_bench.evaluator import CoherenceEvaluator
from elizaos_vending_bench.reporting import VendingBenchReporter
from elizaos_vending_bench.types import (
    LEADERBOARD_SCORES,
    LeaderboardComparison,
    VendingBenchConfig,
    VendingBenchMetrics,
    VendingBenchReport,
    VendingBenchResult,
)

logger = logging.getLogger(__name__)


class VendingBenchRunner:
    """Orchestrates Vending-Bench evaluation."""

    def __init__(
        self,
        config: VendingBenchConfig,
        llm_provider: LLMProvider | None = None,
    ) -> None:
        """
        Initialize the benchmark runner.

        Args:
            config: Benchmark configuration
            llm_provider: LLM provider for agent decisions
        """
        self.config = config
        self.llm_provider = llm_provider
        self.evaluator = CoherenceEvaluator()
        self.reporter = VendingBenchReporter()
        self._start_time = 0.0

    def _to_jsonable(self, obj: object) -> object:
        """Convert common Python/benchmark types into JSON-serializable values."""
        if isinstance(obj, Decimal):
            return str(obj)
        if isinstance(obj, Enum):
            return obj.value
        if isinstance(obj, (datetime, date)):
            return obj.isoformat()
        if isinstance(obj, dict):
            return {str(k): self._to_jsonable(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [self._to_jsonable(v) for v in obj]
        if isinstance(obj, tuple):
            return [self._to_jsonable(v) for v in obj]
        if is_dataclass(obj) and not isinstance(obj, type):
            return {f.name: self._to_jsonable(getattr(obj, f.name)) for f in fields(obj)}
        return obj

    def _report_to_detailed_dict(self, report: VendingBenchReport) -> dict[str, object]:
        """Convert a full report (including actions/summaries) to a JSON-serializable dict."""
        return {
            "metadata": self._to_jsonable(report.metadata),
            "config": self._to_jsonable(report.config),
            "metrics": self._to_jsonable(report.metrics),
            "leaderboard_comparison": self._to_jsonable(report.leaderboard_comparison)
            if report.leaderboard_comparison
            else None,
            "summary": self._to_jsonable(report.summary),
            "results": [self._to_jsonable(r) for r in report.results],
        }

    async def run_benchmark(self) -> VendingBenchReport:
        """
        Run the complete Vending-Bench evaluation.

        Returns:
            Complete benchmark report with analysis
        """
        self._start_time = time.time()

        logger.info("[VendingBenchRunner] Starting Vending-Bench evaluation")
        logger.info(
            f"[VendingBenchRunner] Config: {self.config.num_runs} runs, {self.config.max_days_per_run} days each"
        )

        results: list[VendingBenchResult] = []

        for run_idx in range(self.config.num_runs):
            run_id = f"run_{run_idx + 1:03d}"
            logger.info(f"[VendingBenchRunner] Starting {run_id}")

            try:
                result = await self._run_single(run_idx, run_id)
                results.append(result)

                logger.info(
                    f"[VendingBenchRunner] {run_id} completed: "
                    f"net_worth=${result.final_net_worth:.2f}, "
                    f"days={result.simulation_days}, "
                    f"errors={len(result.coherence_errors)}"
                )

            except TimeoutError:
                logger.error(f"[VendingBenchRunner] {run_id} timed out")
                results.append(
                    VendingBenchResult(
                        run_id=run_id,
                        simulation_days=0,
                        final_net_worth=Decimal("0"),
                        initial_cash=self.config.initial_cash,
                        profit=Decimal("0") - self.config.initial_cash,
                        total_revenue=Decimal("0"),
                        total_costs=Decimal("0"),
                        total_operational_fees=Decimal("0"),
                        items_sold=0,
                        orders_placed=0,
                        successful_deliveries=0,
                        stockout_days=0,
                        error="Timeout",
                    )
                )

            except Exception as e:
                logger.error(f"[VendingBenchRunner] {run_id} failed: {e}")
                results.append(
                    VendingBenchResult(
                        run_id=run_id,
                        simulation_days=0,
                        final_net_worth=Decimal("0"),
                        initial_cash=self.config.initial_cash,
                        profit=Decimal("0") - self.config.initial_cash,
                        total_revenue=Decimal("0"),
                        total_costs=Decimal("0"),
                        total_operational_fees=Decimal("0"),
                        items_sold=0,
                        orders_placed=0,
                        successful_deliveries=0,
                        stockout_days=0,
                        error=str(e),
                    )
                )

        # Calculate metrics
        metrics = self._calculate_metrics(results)

        # Compare with leaderboard
        leaderboard_comparison: LeaderboardComparison | None = None
        if self.config.compare_leaderboard:
            leaderboard_comparison = self._compare_leaderboard(metrics)

        # Generate summary
        summary = self._generate_summary(results, metrics, leaderboard_comparison)

        # Build report
        duration = time.time() - self._start_time
        report = VendingBenchReport(
            metadata={
                "timestamp": datetime.now().isoformat(),
                "duration_seconds": duration,
                "total_runs": len(results),
                "successful_runs": sum(1 for r in results if r.error is None),
                "model_name": self.config.model_name,
                "version": "1.0.0",
            },
            config=self.config,
            results=results,
            metrics=metrics,
            leaderboard_comparison=leaderboard_comparison,
            summary=summary,
        )

        # Save results
        if self.config.generate_report:
            await self._save_report(report)

        logger.info(
            f"[VendingBenchRunner] Benchmark completed in {duration:.1f}s. "
            f"Best net worth: ${metrics.max_net_worth:.2f}"
        )

        return report

    async def _run_single(self, run_idx: int, run_id: str) -> VendingBenchResult:
        """Run a single benchmark trial."""
        # Create environment with seed
        seed = None
        if self.config.random_seed is not None:
            seed = self.config.random_seed + run_idx

        environment = VendingEnvironment(
            initial_cash=self.config.initial_cash,
            seed=seed,
            rows=self.config.machine_rows,
            columns=self.config.machine_columns,
            location=self.config.location,
            daily_base_fee=self.config.daily_base_fee,
            slot_fee=self.config.slot_fee,
        )

        # Create agent
        agent = VendingAgent(
            environment=environment,
            llm_provider=self.llm_provider,
            temperature=self.config.temperature,
        )

        # Run simulation
        result = await agent.run_simulation(
            max_days=self.config.max_days_per_run,
            max_actions_per_day=self.config.max_actions_per_day,
            run_id=run_id,
        )

        # Evaluate coherence
        self.evaluator._reset_tracking()
        coherence_errors = self.evaluator.evaluate_run(result)
        result.coherence_errors = coherence_errors

        return result

    def _calculate_metrics(self, results: list[VendingBenchResult]) -> VendingBenchMetrics:
        """Calculate aggregate metrics from results."""
        # Filter successful runs
        valid_results = [r for r in results if r.error is None]

        if not valid_results:
            # Return zero metrics if all runs failed
            return VendingBenchMetrics(
                avg_net_worth=Decimal("0"),
                max_net_worth=Decimal("0"),
                min_net_worth=Decimal("0"),
                std_net_worth=Decimal("0"),
                median_net_worth=Decimal("0"),
                success_rate=0.0,
                avg_profit=Decimal("0"),
                profitability_rate=0.0,
                avg_items_sold=0.0,
                avg_orders_placed=0.0,
                avg_stockout_days=0.0,
                avg_simulation_days=0.0,
                coherence_score=0.0,
                avg_coherence_errors=0.0,
                avg_tokens_per_run=0.0,
                avg_tokens_per_day=0.0,
                avg_latency_per_action_ms=0.0,
            )

        net_worths = [float(r.final_net_worth) for r in valid_results]
        profits = [float(r.profit) for r in valid_results]

        # Calculate standard deviation safely
        std_net_worth = Decimal("0")
        if len(net_worths) > 1:
            std_net_worth = Decimal(str(statistics.stdev(net_worths)))

        # Coherence analysis
        all_errors = []
        for r in valid_results:
            all_errors.extend(r.coherence_errors)

        total_days = sum(r.simulation_days for r in valid_results)
        coherence_score = self.evaluator.calculate_coherence_score(all_errors, total_days)

        error_breakdown = self.evaluator.get_error_breakdown(all_errors)

        # Calculate action metrics
        total_actions = sum(len(r.actions) for r in valid_results)
        total_latency = sum(r.total_latency_ms for r in valid_results)
        avg_latency = total_latency / total_actions if total_actions > 0 else 0.0

        total_tokens = sum(r.total_tokens for r in valid_results)

        return VendingBenchMetrics(
            avg_net_worth=Decimal(str(statistics.mean(net_worths))),
            max_net_worth=Decimal(str(max(net_worths))),
            min_net_worth=Decimal(str(min(net_worths))),
            std_net_worth=std_net_worth,
            median_net_worth=Decimal(str(statistics.median(net_worths))),
            success_rate=sum(1 for r in valid_results if r.profit > 0) / len(valid_results),
            avg_profit=Decimal(str(statistics.mean(profits))),
            profitability_rate=sum(1 for p in profits if p > 0) / len(profits),
            avg_items_sold=statistics.mean([r.items_sold for r in valid_results]),
            avg_orders_placed=statistics.mean([r.orders_placed for r in valid_results]),
            avg_stockout_days=statistics.mean([r.stockout_days for r in valid_results]),
            avg_simulation_days=statistics.mean([r.simulation_days for r in valid_results]),
            coherence_score=coherence_score,
            avg_coherence_errors=len(all_errors) / len(valid_results) if valid_results else 0,
            error_breakdown=error_breakdown,
            avg_tokens_per_run=total_tokens / len(valid_results) if valid_results else 0,
            avg_tokens_per_day=total_tokens / total_days if total_days > 0 else 0,
            avg_latency_per_action_ms=avg_latency,
        )

    def _compare_leaderboard(
        self,
        metrics: VendingBenchMetrics,
    ) -> LeaderboardComparison:
        """Compare results with published leaderboard scores."""
        our_score = metrics.max_net_worth

        # Sort leaderboard by score
        sorted_entries = sorted(
            LEADERBOARD_SCORES.items(),
            key=lambda x: x[1].top_score,
            reverse=True,
        )

        # Find our rank
        rank = 1
        for _name, entry in sorted_entries:
            if our_score >= entry.top_score:
                break
            rank += 1

        total_entries = len(LEADERBOARD_SCORES) + 1  # +1 for us
        percentile = (total_entries - rank) / total_entries * 100

        # Build comparisons
        comparisons: list[tuple[str, Decimal, str]] = []
        for _name, entry in sorted_entries[:5]:  # Top 5
            diff = our_score - entry.top_score
            if diff > 0:
                comparison = f"+${diff:.2f} (better)"
            elif diff < 0:
                comparison = f"-${abs(diff):.2f} (worse)"
            else:
                comparison = "equal"
            comparisons.append((entry.model_name, entry.top_score, comparison))

        return LeaderboardComparison(
            our_score=our_score,
            our_rank=rank,
            total_entries=total_entries,
            percentile=percentile,
            comparisons=comparisons,
        )

    def _generate_summary(
        self,
        results: list[VendingBenchResult],
        metrics: VendingBenchMetrics,
        leaderboard: LeaderboardComparison | None,
    ) -> dict[str, str | list[str]]:
        """Generate a summary of the benchmark results."""
        key_findings: list[str] = []
        recommendations: list[str] = []

        # Determine status based on performance
        if metrics.profitability_rate >= 0.8:
            status = "excellent"
            key_findings.append(
                f"Excellent performance: {metrics.profitability_rate:.0%} of runs profitable"
            )
        elif metrics.profitability_rate >= 0.5:
            status = "good"
            key_findings.append(
                f"Good performance: {metrics.profitability_rate:.0%} of runs profitable"
            )
        elif metrics.profitability_rate >= 0.2:
            status = "moderate"
            key_findings.append(
                f"Moderate performance: {metrics.profitability_rate:.0%} of runs profitable"
            )
        else:
            status = "needs_improvement"
            key_findings.append(
                f"Performance needs improvement: only {metrics.profitability_rate:.0%} profitable"
            )

        # Net worth analysis
        key_findings.append(
            f"Average net worth: ${metrics.avg_net_worth:.2f} "
            f"(range: ${metrics.min_net_worth:.2f} - ${metrics.max_net_worth:.2f})"
        )

        # Coherence analysis
        if metrics.coherence_score >= 0.9:
            key_findings.append(f"Excellent coherence: {metrics.coherence_score:.1%} score")
        elif metrics.coherence_score >= 0.7:
            key_findings.append(f"Good coherence: {metrics.coherence_score:.1%} score")
        else:
            key_findings.append(f"Coherence issues detected: {metrics.coherence_score:.1%} score")
            recommendations.append("Review and improve long-term decision consistency")

        # Error breakdown
        if metrics.error_breakdown:
            top_errors = sorted(
                metrics.error_breakdown.items(),
                key=lambda x: x[1],
                reverse=True,
            )[:3]
            for error_type, count in top_errors:
                if count > 0:
                    key_findings.append(f"Common error: {error_type.value} ({count} occurrences)")

        # Leaderboard comparison
        if leaderboard:
            key_findings.append(
                f"Leaderboard rank: #{leaderboard.our_rank} of {leaderboard.total_entries} "
                f"(top {100 - leaderboard.percentile:.0f}%)"
            )
            if leaderboard.our_rank == 1:
                key_findings.append("🏆 New #1 on the leaderboard!")

        # Operational analysis
        if metrics.avg_stockout_days > metrics.avg_simulation_days * 0.3:
            recommendations.append("Reduce stockouts - consider more frequent/larger orders")

        if metrics.avg_items_sold < metrics.avg_simulation_days * 5:
            recommendations.append("Improve sales - review pricing and product selection")

        # Default recommendations
        if not recommendations:
            recommendations.append("Continue testing with more runs for statistical significance")
            recommendations.append("Try different model configurations to optimize performance")

        return {
            "status": status,
            "best_net_worth": f"${metrics.max_net_worth:.2f}",
            "avg_net_worth": f"${metrics.avg_net_worth:.2f}",
            "profitability_rate": f"{metrics.profitability_rate:.0%}",
            "coherence_score": f"{metrics.coherence_score:.1%}",
            "key_findings": key_findings,
            "recommendations": recommendations,
        }

    async def _save_report(self, report: VendingBenchReport) -> None:
        """Save benchmark report to files."""
        output_dir = Path(self.config.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        # Save JSON results
        json_path = output_dir / f"vending-bench-results-{timestamp}.json"
        results_dict = self._report_to_dict(report)
        with open(json_path, "w") as f:
            json.dump(results_dict, f, indent=2, default=str)
        logger.info(f"[VendingBenchRunner] Saved JSON results to {json_path}")

        # Generate and save markdown report
        report_path = output_dir / f"VENDING-BENCH-REPORT-{timestamp}.md"
        markdown_report = self.reporter.generate_report(report)
        with open(report_path, "w") as f:
            f.write(markdown_report)
        logger.info(f"[VendingBenchRunner] Saved markdown report to {report_path}")

        # Save detailed logs (full actions + daily summaries) if configured
        if self.config.save_detailed_logs:
            detailed_path = output_dir / f"vending-bench-detailed-{timestamp}.json"
            detailed_dict = self._report_to_detailed_dict(report)
            with open(detailed_path, "w") as f:
                json.dump(detailed_dict, f, indent=2)
            logger.info(f"[VendingBenchRunner] Saved detailed logs to {detailed_path}")

        # Save trajectories if configured
        if self.config.save_trajectories:
            trajectories_path = output_dir / f"trajectories-{timestamp}.json"
            trajectories = []
            for result in report.results:
                trajectories.append(
                    {
                        "run_id": result.run_id,
                        "final_net_worth": str(result.final_net_worth),
                        "profit": str(result.profit),
                        "simulation_days": result.simulation_days,
                        "actions_count": len(result.actions),
                        "coherence_errors": len(result.coherence_errors),
                        "error": result.error,
                    }
                )
            with open(trajectories_path, "w") as f:
                json.dump(trajectories, f, indent=2)
            logger.info(f"[VendingBenchRunner] Saved trajectories to {trajectories_path}")

    def _report_to_dict(self, report: VendingBenchReport) -> dict:
        """Convert report to a serializable dictionary."""

        def decimal_to_str(obj: object) -> object:
            if isinstance(obj, Decimal):
                return str(obj)
            return obj

        return {
            "metadata": report.metadata,
            "config": {
                "num_runs": report.config.num_runs,
                "max_days_per_run": report.config.max_days_per_run,
                "initial_cash": str(report.config.initial_cash),
                "model_name": report.config.model_name,
            },
            "metrics": {
                "avg_net_worth": str(report.metrics.avg_net_worth),
                "max_net_worth": str(report.metrics.max_net_worth),
                "min_net_worth": str(report.metrics.min_net_worth),
                "std_net_worth": str(report.metrics.std_net_worth),
                "success_rate": report.metrics.success_rate,
                "profitability_rate": report.metrics.profitability_rate,
                "coherence_score": report.metrics.coherence_score,
                "avg_coherence_errors": report.metrics.avg_coherence_errors,
                "error_breakdown": {k.value: v for k, v in report.metrics.error_breakdown.items()},
                "avg_items_sold": report.metrics.avg_items_sold,
                "avg_orders_placed": report.metrics.avg_orders_placed,
                "avg_stockout_days": report.metrics.avg_stockout_days,
                "avg_simulation_days": report.metrics.avg_simulation_days,
                "avg_tokens_per_run": report.metrics.avg_tokens_per_run,
                "avg_latency_per_action_ms": report.metrics.avg_latency_per_action_ms,
            },
            "leaderboard_comparison": (
                {
                    "our_score": str(report.leaderboard_comparison.our_score),
                    "our_rank": report.leaderboard_comparison.our_rank,
                    "total_entries": report.leaderboard_comparison.total_entries,
                    "percentile": report.leaderboard_comparison.percentile,
                    "comparisons": [
                        {
                            "model": name,
                            "score": str(score),
                            "comparison": comp,
                        }
                        for name, score, comp in report.leaderboard_comparison.comparisons
                    ],
                }
                if report.leaderboard_comparison
                else None
            ),
            "summary": report.summary,
            "results": [
                {
                    "run_id": r.run_id,
                    "simulation_days": r.simulation_days,
                    "final_net_worth": str(r.final_net_worth),
                    "profit": str(r.profit),
                    "total_revenue": str(r.total_revenue),
                    "total_costs": str(r.total_costs),
                    "items_sold": r.items_sold,
                    "orders_placed": r.orders_placed,
                    "stockout_days": r.stockout_days,
                    "coherence_errors": len(r.coherence_errors),
                    "total_tokens": r.total_tokens,
                    "error": r.error,
                }
                for r in report.results
            ],
        }
