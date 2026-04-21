"""
REALM-Bench Runner

Orchestrates the full REALM benchmark evaluation.
"""

import asyncio
import json
import logging
import time
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from benchmarks.realm.types import (
    LEADERBOARD_SCORES,
    PlanningTrajectory,
    REALMCategory,
    REALMConfig,
    REALMMetrics,
    REALMReport,
    REALMResult,
    REALMResultMetrics,
    REALMResultDetails,
)
from benchmarks.realm.dataset import REALMDataset
from benchmarks.realm.agent import REALMAgent, MockREALMAgent
from benchmarks.realm.evaluator import REALMEvaluator, MetricsCalculator

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime

logger = logging.getLogger(__name__)


class REALMRunner:
    """Run the complete REALM benchmark evaluation."""

    def __init__(
        self,
        config: REALMConfig,
        runtime: Optional["AgentRuntime"] = None,
        use_mock: bool = False,
        enable_trajectory_logging: bool = True,
    ):
        """
        Initialize the REALM benchmark runner.

        Args:
            config: Benchmark configuration
            runtime: Optional ElizaOS runtime for model interactions
            use_mock: If True, use mock agent for testing
            enable_trajectory_logging: Enable trajectory logging for training export
        """
        self.config = config
        self.runtime = runtime
        self.use_mock = use_mock
        self.enable_trajectory_logging = enable_trajectory_logging

        # Initialize components
        self.dataset = REALMDataset(config.data_path)
        
        if use_mock:
            self.agent: REALMAgent | MockREALMAgent = MockREALMAgent(
                return_expected=True,
                success_rate=0.8,
            )
        else:
            self.agent = REALMAgent(
                runtime=runtime,
                max_steps=config.max_steps,
                execution_model=config.execution_model,
                enable_adaptation=config.enable_adaptation,
                temperature=config.temperature,
                use_llm=True,
                enable_trajectory_logging=enable_trajectory_logging,
            )
        
        self.evaluator = REALMEvaluator()
        self.metrics_calculator = MetricsCalculator()

        self._start_time = 0.0
        self._agent_initialized = False

    async def run_benchmark(self) -> REALMReport:
        """
        Run the complete REALM benchmark.

        Returns:
            REALMReport with all results and metrics
        """
        self._start_time = time.time()

        logger.info("[REALMRunner] Starting REALM benchmark")
        logger.info(f"[REALMRunner] Config: {self.config}")

        # Initialize the agent
        if not self._agent_initialized:
            await self.agent.initialize()
            self._agent_initialized = True

        # Load dataset
        await self.dataset.load()
        test_cases = self.dataset.get_test_cases(
            categories=self.config.categories,
            limit=self.config.max_tasks_per_category,
        )

        if not test_cases:
            raise ValueError("No test cases loaded from dataset")

        logger.info(f"[REALMRunner] Loaded {len(test_cases)} test cases")

        # Run all test cases
        results: list[REALMResult] = []

        for idx, test_case in enumerate(test_cases):
            try:
                logger.info(
                    f"[REALMRunner] [{idx + 1}/{len(test_cases)}] "
                    f"Running {test_case.task.id}: {test_case.task.name}"
                )

                # Run with timeout
                trajectory = await asyncio.wait_for(
                    self.agent.solve_task(test_case.task, test_case),
                    timeout=self.config.timeout_per_task_ms / 1000,
                )

                # Evaluate result
                result = self.evaluator.evaluate_trajectory(
                    test_case.task,
                    test_case,
                    trajectory,
                )
                results.append(result)

                status = "✓" if result.success else "✗"
                logger.info(
                    f"[REALMRunner] {status} {test_case.task.id}: "
                    f"{result.steps_executed} steps, {result.duration_ms:.0f}ms"
                )

            except asyncio.TimeoutError:
                logger.warning(f"[REALMRunner] Task {test_case.task.id} timed out")
                results.append(REALMResult(
                    task_id=test_case.task.id,
                    category=test_case.task.category,
                    trajectory=PlanningTrajectory(task_id=test_case.task.id),
                    success=False,
                    steps_executed=0,
                    actions_performed=[],
                    duration_ms=float(self.config.timeout_per_task_ms),
                    error="Timeout",
                    metrics=REALMResultMetrics(),
                    details=REALMResultDetails(),
                ))

            except Exception as e:
                logger.error(f"[REALMRunner] Task {test_case.task.id} failed: {e}")
                results.append(REALMResult(
                    task_id=test_case.task.id,
                    category=test_case.task.category,
                    trajectory=PlanningTrajectory(task_id=test_case.task.id),
                    success=False,
                    steps_executed=0,
                    actions_performed=[],
                    error=str(e),
                    metrics=REALMResultMetrics(),
                    details=REALMResultDetails(),
                ))

        # Calculate metrics
        metrics = self.metrics_calculator.calculate(results)

        # Compare to leaderboard
        comparison = self.metrics_calculator.compare_to_leaderboard(
            metrics, LEADERBOARD_SCORES
        )

        # Generate category breakdown
        category_breakdown = self._generate_category_breakdown(results)

        # Generate summary
        summary = self._generate_summary(metrics, comparison)

        # Build report
        duration = time.time() - self._start_time
        report = REALMReport(
            metadata={
                "timestamp": datetime.now().isoformat(),
                "duration_seconds": duration,
                "total_tasks": len(test_cases),
                "categories": [c.value for c in (self.config.categories or list(REALMCategory))],
                "config": {
                    "execution_model": self.config.execution_model.value,
                    "max_steps": self.config.max_steps,
                    "enable_adaptation": self.config.enable_adaptation,
                    "model": self.config.model_name,
                },
            },
            metrics=metrics,
            results=results,
            category_breakdown=category_breakdown,
            comparison_to_leaderboard=comparison,
            summary=summary,
        )

        # Save results
        if self.config.generate_report:
            await self._save_results(report)

        # Export trajectories for training if configured
        if self.config.save_trajectories and isinstance(self.agent, REALMAgent):
            await self._export_training_trajectories(report)

        logger.info(
            f"[REALMRunner] Benchmark completed in {duration:.1f}s. "
            f"Success rate: {metrics.overall_success_rate:.1%}"
        )

        return report

    def _generate_category_breakdown(
        self, results: list[REALMResult]
    ) -> dict[str, dict[str, float]]:
        """Generate per-category breakdown."""
        breakdown: dict[str, dict[str, float]] = {}

        for category in REALMCategory:
            cat_results = [r for r in results if r.category == category]
            if cat_results:
                passed = sum(1 for r in cat_results if r.success)
                breakdown[category.value] = {
                    "total": float(len(cat_results)),
                    "passed": float(passed),
                    "failed": float(len(cat_results) - passed),
                    "success_rate": passed / len(cat_results),
                    "avg_plan_quality": sum(r.metrics.plan_quality for r in cat_results) / len(cat_results),
                    "avg_efficiency": sum(r.metrics.efficiency for r in cat_results) / len(cat_results),
                }

        return breakdown

    def _generate_summary(
        self,
        metrics: REALMMetrics,
        comparison: dict[str, dict[str, float]],
    ) -> dict[str, str | int | list[str]]:
        """Generate summary of benchmark results."""
        key_findings: list[str] = []
        recommendations: list[str] = []

        # Overall status
        success_rate = metrics.overall_success_rate
        if success_rate >= 0.7:
            status = "excellent"
            key_findings.append(f"Excellent planning performance: {success_rate:.1%} success rate")
        elif success_rate >= 0.5:
            status = "good"
            key_findings.append(f"Good planning performance: {success_rate:.1%} success rate")
        elif success_rate >= 0.3:
            status = "moderate"
            key_findings.append(f"Moderate planning performance: {success_rate:.1%} success rate")
        else:
            status = "needs_improvement"
            key_findings.append(f"Planning performance needs improvement: {success_rate:.1%} success rate")

        # Category analysis
        best_category = None
        worst_category = None
        best_rate = 0.0
        worst_rate = 1.0

        for category, rate in metrics.category_success_rates.items():
            if rate > best_rate:
                best_rate = rate
                best_category = category
            if rate < worst_rate:
                worst_rate = rate
                worst_category = category

        if best_category:
            key_findings.append(f"Strongest category: {best_category.value} ({best_rate:.1%})")
        if worst_category and worst_rate < 0.5:
            key_findings.append(f"Needs improvement: {worst_category.value} ({worst_rate:.1%})")
            recommendations.append(f"Focus on improving {worst_category.value} task handling")

        # Plan quality analysis
        if metrics.avg_plan_quality >= 0.7:
            key_findings.append("High plan quality scores achieved")
        elif metrics.avg_plan_quality < 0.5:
            recommendations.append("Improve plan generation quality")

        # Efficiency analysis
        if metrics.avg_efficiency >= 0.7:
            key_findings.append("Excellent execution efficiency")
        elif metrics.avg_efficiency < 0.5:
            recommendations.append("Optimize execution efficiency")

        # Adaptation analysis
        if metrics.adaptation_rate > 0.3:
            if metrics.adaptation_success_rate >= 0.6:
                key_findings.append(f"Effective plan adaptation ({metrics.adaptation_success_rate:.1%} success)")
            else:
                recommendations.append("Improve plan adaptation strategies")

        # Leaderboard comparison
        better_than_count = sum(
            1 for model_data in comparison.values()
            if model_data.get("better", 0) > 0
        )
        total_models = len(comparison)

        if better_than_count > 0:
            key_findings.append(f"Outperforms {better_than_count}/{total_models} baseline models")

        # Calculate estimated rank
        our_score = metrics.overall_success_rate * 100
        rank = 1
        for model_data in comparison.values():
            if model_data.get("their_score", 0) > our_score:
                rank += 1
        key_findings.append(f"Estimated leaderboard rank: #{rank}")

        if not recommendations:
            recommendations.append("Continue testing with larger datasets")
            recommendations.append("Compare with additional model configurations")

        return {
            "status": status,
            "success_rate": f"{success_rate:.1%}",
            "estimated_rank": rank,
            "key_findings": key_findings,
            "recommendations": recommendations,
        }

    async def _export_training_trajectories(self, report: REALMReport) -> None:
        """Export trajectories in training-ready formats (ART/GRPO)."""
        if not isinstance(self.agent, REALMAgent):
            return

        output_dir = Path(self.config.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        completed = self.agent.get_completed_trajectories()
        if not completed:
            logger.info("[REALMRunner] No completed trajectories to export")
            return

        logger.info(f"[REALMRunner] Exporting {len(completed)} trajectories for training")

        # Export ART format (for OpenPipe)
        art_path = self.agent.export_trajectories_art(
            dataset_name=f"realm-{self.config.model_name}",
            output_dir=str(output_dir),
        )
        if art_path:
            logger.info(f"[REALMRunner] Saved ART trajectories to {art_path}")

        # Export GRPO format (for group-relative training)
        grpo_path = self.agent.export_trajectories_grpo(
            dataset_name=f"realm-{self.config.model_name}",
            output_dir=str(output_dir),
        )
        if grpo_path:
            logger.info(f"[REALMRunner] Saved GRPO trajectories to {grpo_path}")

    async def _save_results(self, report: REALMReport) -> None:
        """Save benchmark results to files."""
        output_dir = Path(self.config.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        # Save JSON results
        json_path = output_dir / f"realm-benchmark-{timestamp}.json"
        results_dict = self._report_to_dict(report)
        with open(json_path, "w") as f:
            json.dump(results_dict, f, indent=2, default=str)
        logger.info(f"[REALMRunner] Saved JSON results to {json_path}")

        # Save markdown report
        md_path = output_dir / f"REALM-BENCHMARK-REPORT-{timestamp}.md"
        markdown = self._generate_markdown_report(report)
        with open(md_path, "w") as f:
            f.write(markdown)
        logger.info(f"[REALMRunner] Saved markdown report to {md_path}")

        # Save trajectories if configured
        if self.config.save_trajectories:
            traj_path = output_dir / f"trajectories-{timestamp}.json"
            trajectories = [
                {
                    "task_id": r.task_id,
                    "success": r.success,
                    "steps": r.steps_executed,
                    "actions": r.actions_performed,
                    "duration_ms": r.duration_ms,
                    "metrics": {
                        "planning_time": r.metrics.planning_time,
                        "execution_time": r.metrics.execution_time,
                        "plan_quality": r.metrics.plan_quality,
                        "goal_achievement": r.metrics.goal_achievement,
                        "efficiency": r.metrics.efficiency,
                    },
                }
                for r in report.results
            ]
            with open(traj_path, "w") as f:
                json.dump(trajectories, f, indent=2)

    def _metrics_to_dict(self, metrics: REALMMetrics) -> dict[str, float | int | dict[str, float]]:
        """Convert metrics to serializable dictionary."""
        return {
            "overall_success_rate": metrics.overall_success_rate,
            "total_tasks": metrics.total_tasks,
            "passed_tasks": metrics.passed_tasks,
            "failed_tasks": metrics.failed_tasks,
            "avg_plan_quality": metrics.avg_plan_quality,
            "avg_goal_achievement": metrics.avg_goal_achievement,
            "avg_efficiency": metrics.avg_efficiency,
            "avg_planning_time_ms": metrics.avg_planning_time_ms,
            "avg_execution_time_ms": metrics.avg_execution_time_ms,
            "avg_latency_ms": metrics.avg_latency_ms,
            "total_tokens": metrics.total_tokens,
            "category_success_rates": {
                k.value: v for k, v in metrics.category_success_rates.items()
            },
        }

    def _result_to_dict(self, r: REALMResult) -> dict[str, str | int | float | bool | list[str] | dict[str, float] | None]:
        """Convert a single result to serializable dictionary."""
        return {
            "task_id": r.task_id,
            "category": r.category.value,
            "success": r.success,
            "steps_executed": r.steps_executed,
            "actions_performed": r.actions_performed,
            "duration_ms": r.duration_ms,
            "metrics": {
                "planning_time": r.metrics.planning_time,
                "execution_time": r.metrics.execution_time,
                "plan_quality": r.metrics.plan_quality,
                "goal_achievement": r.metrics.goal_achievement,
                "efficiency": r.metrics.efficiency,
            },
            "error": r.error,
        }

    def _report_to_dict(self, report: REALMReport) -> dict[str, object]:
        """Convert report to serializable dictionary."""
        return {
            "metadata": report.metadata,
            "summary": report.summary,
            "metrics": self._metrics_to_dict(report.metrics),
            "category_breakdown": report.category_breakdown,
            "leaderboard_comparison": report.comparison_to_leaderboard,
            "results": [self._result_to_dict(r) for r in report.results],
        }

    def _generate_markdown_report(self, report: REALMReport) -> str:
        """Generate markdown report."""
        metrics = report.metrics
        summary = report.summary

        status_val = summary.get("status", "unknown")
        status_str = status_val.upper() if isinstance(status_val, str) else "UNKNOWN"

        estimated_rank_val = summary.get("estimated_rank", "N/A")
        estimated_rank_str = str(estimated_rank_val)

        duration_val = report.metadata.get("duration_seconds", 0.0)
        duration_seconds = float(duration_val) if isinstance(duration_val, (int, float)) else 0.0

        key_findings_val = summary.get("key_findings", [])
        key_findings: list[str] = (
            [str(x) for x in key_findings_val] if isinstance(key_findings_val, list) else []
        )

        recommendations_val = summary.get("recommendations", [])
        recommendations: list[str] = (
            [str(x) for x in recommendations_val] if isinstance(recommendations_val, list) else []
        )

        config_val = report.metadata.get("config")
        if isinstance(config_val, dict):
            model_name = str(config_val.get("model", "Unknown"))
            execution_model = str(config_val.get("execution_model", "Unknown"))
            max_steps = str(config_val.get("max_steps", "Unknown"))
            adaptation_enabled = bool(config_val.get("enable_adaptation", False))
        else:
            model_name = "Unknown"
            execution_model = "Unknown"
            max_steps = "Unknown"
            adaptation_enabled = False

        timestamp_val = report.metadata.get("timestamp")
        timestamp_str = timestamp_val if isinstance(timestamp_val, str) else datetime.now().isoformat()

        md = f"""# REALM-Bench Benchmark Results

## Summary

| Metric | Value |
|--------|-------|
| **Status** | {status_str} |
| **Success Rate** | {metrics.overall_success_rate:.1%} |
| **Total Tasks** | {metrics.total_tasks} |
| **Passed** | {metrics.passed_tasks} |
| **Failed** | {metrics.failed_tasks} |
| **Estimated Rank** | #{estimated_rank_str} |
| **Duration** | {duration_seconds:.1f}s |

## Planning Metrics

| Metric | Value |
|--------|-------|
| Plan Quality | {metrics.avg_plan_quality:.1%} |
| Goal Achievement | {metrics.avg_goal_achievement:.1%} |
| Efficiency | {metrics.avg_efficiency:.1%} |
| Avg Planning Time | {metrics.avg_planning_time_ms:.0f}ms |
| Avg Execution Time | {metrics.avg_execution_time_ms:.0f}ms |
| Total Tokens | {metrics.total_tokens:,} |

## Key Findings

"""
        for finding in key_findings:
            md += f"- {finding}\n"

        md += """
## Recommendations

"""
        for rec in recommendations:
            md += f"- {rec}\n"

        md += """
## Category Breakdown

| Category | Total | Passed | Success Rate | Plan Quality |
|----------|-------|--------|--------------|--------------|
"""
        for category, data in report.category_breakdown.items():
            md += f"| {category} | {data['total']:.0f} | {data['passed']:.0f} | {data['success_rate']:.1%} | {data['avg_plan_quality']:.1%} |\n"

        md += """
## Leaderboard Comparison

| Model | Their Score | Our Score | Difference |
|-------|-------------|-----------|------------|
"""
        our_score = metrics.overall_success_rate * 100
        for model, data in sorted(
            report.comparison_to_leaderboard.items(),
            key=lambda x: x[1].get("their_score", 0),
            reverse=True,
        ):
            their = data.get("their_score", 0)
            diff = our_score - their
            diff_str = f"+{diff:.1f}%" if diff > 0 else f"{diff:.1f}%"
            md += f"| {model} | {their:.1f}% | {our_score:.1f}% | {diff_str} |\n"

        md += f"""
## Configuration

- Model: {model_name}
- Execution Model: {execution_model}
- Max Steps: {max_steps}
- Adaptation Enabled: {adaptation_enabled}

---
*Generated by ElizaOS REALM-Bench*
*Timestamp: {timestamp_str}*

## Reference

- Paper: https://arxiv.org/abs/2412.13102
- GitHub: https://github.com/genglongling/REALM-Bench
"""
        return md
