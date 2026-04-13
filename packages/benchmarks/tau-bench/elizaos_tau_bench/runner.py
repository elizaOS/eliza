"""
Benchmark runner for Tau-bench.
"""

import asyncio
import json
import logging
import time
import tracemalloc
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Any, Optional, Union

from elizaos_tau_bench.types import (
    TauBenchConfig,
    TauBenchTask,
    TauBenchResult,
    TauBenchReport,
    TauDomain,
    DomainReport,
)
from elizaos_tau_bench.dataset import TauBenchDataset
from elizaos_tau_bench.evaluator import TauBenchEvaluator
from elizaos_tau_bench.eliza_agent import (
    ElizaOSTauAgent,
    MockTauAgent,
    create_tau_agent,
    ELIZAOS_AVAILABLE,
)
from elizaos_tau_bench.trajectory_integration import (
    TauBenchTrajectoryConfig,
    TauBenchTrajectoryIntegration,
)
from elizaos_tau_bench.executor import ToolExecutor
from elizaos_tau_bench.environments.retail import RetailEnvironment
from elizaos_tau_bench.environments.airline import AirlineEnvironment
from elizaos_tau_bench.environments.base import DomainEnvironment
from elizaos_tau_bench.constants import LEADERBOARD_SCORES

logger = logging.getLogger(__name__)

# Type alias for agent
TauAgentType = Union[ElizaOSTauAgent, MockTauAgent]


class MemoryTracker:
    """Tracks memory usage during benchmark execution."""

    def __init__(self, enabled: bool = True) -> None:
        self.enabled = enabled
        self.measurements: list[int] = []
        self._running = False
        self._task: Optional[asyncio.Task[None]] = None

    async def start(self) -> None:
        if not self.enabled:
            return

        self.measurements = []
        self._running = True
        tracemalloc.start()
        self._task = asyncio.create_task(self._track())

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self.enabled:
            tracemalloc.stop()

    async def _track(self) -> None:
        while self._running:
            current, _ = tracemalloc.get_traced_memory()
            self.measurements.append(current)
            await asyncio.sleep(1.0)

    def get_stats(self) -> dict[str, int]:
        if not self.enabled or not self.measurements:
            return {"peak": 0, "average": 0}

        return {
            "peak": max(self.measurements),
            "average": sum(self.measurements) // len(self.measurements),
        }


class TauBenchRunner:
    """Runs Tau-bench evaluation."""

    def __init__(self, config: TauBenchConfig) -> None:
        self.config = config
        self.dataset = TauBenchDataset(config.data_path)
        self.evaluator = TauBenchEvaluator(use_llm_judge=config.use_llm_judge)
        self.memory_tracker = MemoryTracker(config.enable_memory_tracking)
        self._start_time = 0.0
        self._elizaos_mode = not config.use_mock and ELIZAOS_AVAILABLE
        self._trajectory: TauBenchTrajectoryIntegration | None = None

        if self._elizaos_mode and config.enable_trajectory_logging:
            self._trajectory = TauBenchTrajectoryIntegration(
                TauBenchTrajectoryConfig(
                    enabled=True,
                    export_format="grpo"
                    if config.trajectory_export_format == "grpo"
                    else "art",
                    scenario_prefix="tau-bench",
                )
            )

        if self._elizaos_mode:
            logger.info("[TauBenchRunner] Running with ElizaOS integration (real LLM)")
        else:
            logger.info("[TauBenchRunner] Running in mock mode (no LLM calls)")

    async def run_benchmark(self) -> TauBenchReport:
        """Run the complete Tau-bench evaluation."""
        self._start_time = time.time()
        await self.memory_tracker.start()

        logger.info("[TauBenchRunner] Starting Tau-bench evaluation")
        logger.info(f"[TauBenchRunner] Domains: {[d.value for d in self.config.domains]}")
        logger.info(f"[TauBenchRunner] Trials per task: {self.config.num_trials}")

        try:
            # Load dataset
            await self.dataset.load()

            # If no tasks loaded, create sample tasks
            if not self.dataset.tasks:
                logger.warning("[TauBenchRunner] No tasks found, using sample tasks")
                self.dataset.tasks = self.dataset.create_sample_tasks()

            all_results: list[TauBenchResult] = []

            # Run tasks for each domain
            for domain in self.config.domains:
                tasks = self.dataset.get_tasks(
                    domain=domain,
                    difficulty=self.config.difficulty,
                    limit=self.config.max_tasks,
                )

                logger.info(f"[TauBenchRunner] Running {len(tasks)} tasks for {domain.value}")

                for task in tasks:
                    # Run multiple trials for Pass^k evaluation
                    for trial in range(1, self.config.num_trials + 1):
                        logger.debug(
                            f"[TauBenchRunner] Task {task.task_id} trial {trial}/{self.config.num_trials}"
                        )
                        result = await self._run_task(task, trial)
                        all_results.append(result)

            # Generate report
            report = self._generate_report(all_results)

            # Save results
            await self._save_results(report)

            # Export trajectories (ART/GRPO) alongside benchmark outputs
            if self._trajectory and self._trajectory.enabled:
                traj_dir = str(Path(self.config.output_dir) / "trajectories")
                exported = self._trajectory.export_trajectories(
                    output_dir=traj_dir,
                    dataset_name="tau_bench_trajectories",
                )
                if exported and exported.success:
                    logger.info(
                        f"[TauBenchRunner] Exported {exported.trajectories_exported} trajectories to {exported.dataset_url}"
                    )

            logger.info(
                f"[TauBenchRunner] Benchmark completed: "
                f"{report.passed_tasks}/{report.total_tasks} passed "
                f"({report.overall_success_rate * 100:.1f}%)"
            )

            return report

        except Exception as e:
            logger.error(f"[TauBenchRunner] Benchmark failed: {e}")
            raise
        finally:
            await self.memory_tracker.stop()

    async def _run_task(self, task: TauBenchTask, trial_number: int = 1) -> TauBenchResult:
        """Run a single task."""
        start_time = time.time()

        try:
            # Store trial_number for downstream telemetry (agent-side trajectory metadata)
            task.metadata["trial_number"] = trial_number

            # Create environment
            environment = self._create_environment(task)
            await environment.initialize()

            # Create executor and register tools
            executor = ToolExecutor(environment)
            tools = environment.get_available_tools()
            executor.register_tools(tools)

            # Update task with environment tools if not already set
            if not task.available_tools:
                task.available_tools = tools

            if not task.policy_constraints:
                task.policy_constraints = environment.get_policy_constraints()

            # Create agent (mock, real ElizaOS, or milady TS agent)
            if self.config.model_provider == "milady":
                from milady_adapter.tau_bench import MiladyTauAgent

                agent = MiladyTauAgent(
                    executor=executor,
                    max_turns=self.config.max_turns_per_task,
                )
            else:
                agent = create_tau_agent(
                    executor=executor,
                    max_turns=self.config.max_turns_per_task,
                    use_mock=self.config.use_mock,
                    model_provider=self.config.model_provider,
                    temperature=self.config.temperature,
                    trajectory=self._trajectory,
                )
            
            # Initialize agent (connects to LLM if not mock)
            await agent.initialize()

            # Process task with timeout
            try:
                tool_calls, response, conversation = await asyncio.wait_for(
                    agent.process_task(task),
                    timeout=self.config.timeout_ms / 1000,
                )
            except asyncio.TimeoutError:
                return TauBenchResult(
                    task_id=task.task_id,
                    domain=task.domain,
                    trial_number=trial_number,
                    success=False,
                    error="Task timed out",
                    duration_ms=(time.time() - start_time) * 1000,
                )

            # Check policy compliance
            policy_violations = await environment.check_policy_compliance()

            # Check if goal achieved
            goal_achieved = await environment.check_goal_achieved()

            # Get final state
            final_state = environment.get_state_snapshot()

            # Evaluate
            duration_ms = (time.time() - start_time) * 1000
            result = self.evaluator.evaluate_task(
                task=task,
                tool_calls_made=tool_calls,
                response=response,
                policy_violations=policy_violations,
                goal_achieved=goal_achieved,
                final_state=final_state,
                duration_ms=duration_ms,
                trial_number=trial_number,
            )

            # Trajectory finalize (after evaluation so we have success signal)
            if self._trajectory and self._trajectory.enabled:
                await self._trajectory.end_task(result=result)

            return result

        except Exception as e:
            logger.error(f"[TauBenchRunner] Task {task.task_id} failed: {e}")
            return TauBenchResult(
                task_id=task.task_id,
                domain=task.domain,
                trial_number=trial_number,
                success=False,
                error=str(e),
                duration_ms=(time.time() - start_time) * 1000,
            )

    def _create_environment(self, task: TauBenchTask) -> DomainEnvironment:
        """Create the appropriate environment for the task domain."""
        if task.domain == TauDomain.RETAIL:
            return RetailEnvironment(task)
        elif task.domain == TauDomain.AIRLINE:
            return AirlineEnvironment(task)
        else:
            raise ValueError(f"Unknown domain: {task.domain}")

    def _generate_report(self, results: list[TauBenchResult]) -> TauBenchReport:
        """Generate comprehensive benchmark report."""
        total_duration = time.time() - self._start_time
        memory_stats = self.memory_tracker.get_stats()

        # Calculate overall metrics
        total_tasks = len(set(r.task_id for r in results))
        total_trials = len(results)
        passed_tasks = sum(1 for r in results if r.success)
        failed_tasks = total_trials - passed_tasks

        success_rate = passed_tasks / total_trials if total_trials > 0 else 0
        avg_tool_accuracy = (
            sum(r.tool_call_accuracy for r in results) / total_trials
            if total_trials > 0
            else 0
        )
        avg_policy_compliance = (
            sum(r.policy_compliance for r in results) / total_trials
            if total_trials > 0
            else 0
        )
        avg_response_quality = (
            sum(r.response_quality for r in results) / total_trials
            if total_trials > 0
            else 0
        )
        avg_duration = (
            sum(r.duration_ms for r in results) / total_trials if total_trials > 0 else 0
        )

        # Calculate Pass^k metrics
        pass_k_metrics = TauBenchEvaluator.calculate_pass_k(results, [1, 2, 4, 8])

        # Calculate per-domain reports
        domain_reports: dict[TauDomain, DomainReport] = {}
        for domain in TauDomain:
            domain_results = [r for r in results if r.domain == domain]
            if domain_results:
                domain_tasks = len(set(r.task_id for r in domain_results))
                domain_passed = sum(1 for r in domain_results if r.success)
                domain_failed = len(domain_results) - domain_passed

                domain_reports[domain] = DomainReport(
                    domain=domain,
                    total_tasks=domain_tasks,
                    passed_tasks=domain_passed,
                    failed_tasks=domain_failed,
                    success_rate=domain_passed / len(domain_results) if domain_results else 0,
                    average_tool_accuracy=sum(r.tool_call_accuracy for r in domain_results)
                    / len(domain_results),
                    average_policy_compliance=sum(r.policy_compliance for r in domain_results)
                    / len(domain_results),
                    average_response_quality=sum(r.response_quality for r in domain_results)
                    / len(domain_results),
                    average_turns=sum(r.turns_used for r in domain_results)
                    / len(domain_results),
                    average_duration_ms=sum(r.duration_ms for r in domain_results)
                    / len(domain_results),
                    pass_k_metrics=TauBenchEvaluator.calculate_pass_k(domain_results, [1, 2, 4, 8]),
                    results=domain_results,
                )

        # Compare to leaderboard
        comparisons = TauBenchEvaluator.compare_to_leaderboard(results, LEADERBOARD_SCORES)

        # Find closest comparable model
        closest_model = ""
        closest_diff = float("inf")
        for model, diff in comparisons.items():
            if abs(diff) < abs(closest_diff):
                closest_diff = diff
                closest_model = model

        # Generate summary
        key_findings = []
        strengths = []
        weaknesses = []
        recommendations = []

        if success_rate > 0.7:
            key_findings.append("Strong overall performance on Tau-bench tasks")
            strengths.append("High task completion rate")
        elif success_rate > 0.4:
            key_findings.append("Moderate performance with room for improvement")
        else:
            key_findings.append("Significant improvement needed in task completion")
            weaknesses.append("Low overall success rate")
            recommendations.append("Focus on improving tool selection accuracy")

        if avg_tool_accuracy > 0.8:
            strengths.append("Excellent tool selection and parameter extraction")
        elif avg_tool_accuracy < 0.5:
            weaknesses.append("Tool selection needs improvement")
            recommendations.append("Improve parameter extraction from context")

        if avg_policy_compliance > 0.9:
            strengths.append("Strong policy compliance")
        elif avg_policy_compliance < 0.7:
            weaknesses.append("Policy violations occurring")
            recommendations.append("Review and enforce policy constraints")

        # Domain-specific findings
        for domain, report in domain_reports.items():
            if report.success_rate > 0.8:
                strengths.append(f"Strong performance in {domain.value} domain")
            elif report.success_rate < 0.4:
                weaknesses.append(f"Weak performance in {domain.value} domain")

        return TauBenchReport(
            total_tasks=total_tasks,
            total_trials=total_trials,
            passed_tasks=passed_tasks,
            failed_tasks=failed_tasks,
            overall_success_rate=success_rate,
            overall_tool_accuracy=avg_tool_accuracy,
            overall_policy_compliance=avg_policy_compliance,
            overall_response_quality=avg_response_quality,
            average_duration_ms=avg_duration,
            domain_reports=domain_reports,
            pass_k_metrics=pass_k_metrics,
            overall_metrics={
                "total_tokens": sum(r.tokens_used for r in results),
                "average_tokens_per_task": sum(r.tokens_used for r in results) / total_trials
                if total_trials > 0
                else 0,
                "average_turns_per_task": sum(r.turns_used for r in results) / total_trials
                if total_trials > 0
                else 0,
                "average_tool_calls_per_task": sum(len(r.tool_calls_made) for r in results)
                / total_trials
                if total_trials > 0
                else 0,
                "total_duration_seconds": total_duration,
                "memory_peak_mb": memory_stats["peak"] / 1024 / 1024,
                "memory_average_mb": memory_stats["average"] / 1024 / 1024,
            },
            comparison_to_leaderboard={
                "best_comparable_model": closest_model,
                "difference_from_best": closest_diff,
                "comparison_details": comparisons,
            },
            summary={
                "status": "success" if success_rate > 0.7 else "partial" if success_rate > 0.4 else "needs_improvement",
                "key_findings": key_findings,
                "strengths": strengths,
                "weaknesses": weaknesses,
                "recommendations": recommendations,
                "timestamp": datetime.now().isoformat(),
            },
            results=results,
        )

    async def _save_results(self, report: TauBenchReport) -> None:
        """Save benchmark results to files."""
        output_dir = Path(self.config.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        # Save main results JSON
        results_path = output_dir / "tau-bench-results.json"
        results_dict = self._report_to_dict(report)

        with open(results_path, "w") as f:
            json.dump(results_dict, f, indent=2, default=str)

        # Save markdown summary
        summary_path = output_dir / "tau-bench-summary.md"
        summary_md = self._generate_markdown_summary(report)

        with open(summary_path, "w") as f:
            f.write(summary_md)

        # Save detailed results if enabled
        if self.config.save_detailed_logs:
            detailed_path = output_dir / "tau-bench-detailed.json"
            detailed_dict = {
                "results": [self._result_to_dict(r) for r in report.results],
                "domain_reports": {
                    d.value: asdict(r) for d, r in report.domain_reports.items()
                },
            }
            with open(detailed_path, "w") as f:
                json.dump(detailed_dict, f, indent=2, default=str)

        logger.info(f"[TauBenchRunner] Results saved to {output_dir}")

    def _report_to_dict(self, report: TauBenchReport) -> dict:
        """Convert report to dictionary for JSON serialization."""
        return {
            "total_tasks": report.total_tasks,
            "total_trials": report.total_trials,
            "passed_tasks": report.passed_tasks,
            "failed_tasks": report.failed_tasks,
            "overall_success_rate": report.overall_success_rate,
            "overall_tool_accuracy": report.overall_tool_accuracy,
            "overall_policy_compliance": report.overall_policy_compliance,
            "overall_response_quality": report.overall_response_quality,
            "average_duration_ms": report.average_duration_ms,
            "pass_k_metrics": {
                str(k): {"k": v.k, "pass_rate": v.pass_rate, "trials_passed": v.trials_passed}
                for k, v in report.pass_k_metrics.items()
            },
            "overall_metrics": report.overall_metrics,
            "comparison_to_leaderboard": report.comparison_to_leaderboard,
            "summary": report.summary,
        }

    def _result_to_dict(self, result: TauBenchResult) -> dict[str, Any]:
        """Convert result to dictionary."""
        return {
            "task_id": result.task_id,
            "domain": result.domain.value,
            "trial_number": result.trial_number,
            "success": result.success,
            "tool_call_accuracy": result.tool_call_accuracy,
            "policy_compliance": result.policy_compliance,
            "response_quality": result.response_quality,
            "goal_achieved": result.goal_achieved,
            "duration_ms": result.duration_ms,
            "turns_used": result.turns_used,
            "tool_calls_made": [tc.to_dict() for tc in result.tool_calls_made],
            "policy_violations": result.policy_violations,
            "error": result.error,
        }

    def _generate_markdown_summary(self, report: TauBenchReport) -> str:
        """Generate a markdown summary of the benchmark results."""
        md = f"""# Tau-bench Benchmark Results

## Executive Summary

- **Status**: {report.summary['status'].upper()}
- **Overall Success Rate**: {report.overall_success_rate * 100:.1f}%
- **Total Tasks**: {report.total_tasks} ({report.total_trials} trials)
- **Passed**: {report.passed_tasks} | **Failed**: {report.failed_tasks}
- **Duration**: {report.overall_metrics['total_duration_seconds']:.1f}s

## Pass^k Reliability Metrics

| k | Pass Rate | Tasks Passed |
|---|-----------|--------------|
"""
        for k, metrics in sorted(report.pass_k_metrics.items()):
            md += f"| {k} | {metrics.pass_rate * 100:.1f}% | {metrics.trials_passed}/{metrics.total_trials} |\n"

        md += f"""
## Performance Metrics

| Metric | Score |
|--------|-------|
| Tool Selection Accuracy | {report.overall_tool_accuracy * 100:.1f}% |
| Policy Compliance | {report.overall_policy_compliance * 100:.1f}% |
| Response Quality | {report.overall_response_quality * 100:.1f}% |
| Avg. Duration | {report.average_duration_ms:.0f}ms |
| Avg. Turns per Task | {report.overall_metrics['average_turns_per_task']:.1f} |
| Avg. Tool Calls per Task | {report.overall_metrics['average_tool_calls_per_task']:.1f} |

## Domain Results

"""
        for domain, domain_report in report.domain_reports.items():
            md += f"""### {domain.value.title()} Domain

- **Success Rate**: {domain_report.success_rate * 100:.1f}%
- **Tasks**: {domain_report.total_tasks} ({domain_report.passed_tasks} passed)
- **Tool Accuracy**: {domain_report.average_tool_accuracy * 100:.1f}%
- **Policy Compliance**: {domain_report.average_policy_compliance * 100:.1f}%

"""

        md += """## Leaderboard Comparison

| Model | Difference |
|-------|------------|
"""
        for model, diff in sorted(
            report.comparison_to_leaderboard.get("comparison_details", {}).items(),
            key=lambda x: x[1],
            reverse=True,
        ):
            direction = "+" if diff > 0 else ""
            md += f"| {model} | {direction}{diff * 100:.1f}% |\n"

        md += f"""
**Closest Comparable**: {report.comparison_to_leaderboard.get('best_comparable_model', 'N/A')}

## Key Findings

"""
        for finding in report.summary.get("key_findings", []):
            md += f"- {finding}\n"

        md += "\n## Strengths\n\n"
        for strength in report.summary.get("strengths", []):
            md += f"- ✅ {strength}\n"

        md += "\n## Areas for Improvement\n\n"
        for weakness in report.summary.get("weaknesses", []):
            md += f"- ⚠️ {weakness}\n"

        md += "\n## Recommendations\n\n"
        for rec in report.summary.get("recommendations", []):
            md += f"- 💡 {rec}\n"

        md += f"""
---
*Generated on {report.summary.get('timestamp', datetime.now().isoformat())}*
*Benchmark: Tau-bench (Tool-Agent-User Interaction)*
"""
        return md
