"""
MINT Benchmark Runner

Orchestrates the full MINT benchmark evaluation with ablation study support.
"""

import asyncio
import json
import logging
import time
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from typing import Optional, Protocol, runtime_checkable

from benchmarks.mint.types import (
    MINTCategory,
    MINTConfig,
    MINTBenchmarkResults,
    MINTResult,
    MINTTask,
    MINTTrajectory,
    ConfigurationResult,
)
from benchmarks.mint.dataset import MINTDataset
from benchmarks.mint.executor import PythonExecutor
from benchmarks.mint.feedback import FeedbackGenerator
from benchmarks.mint.agent import MINTAgent
from benchmarks.mint.evaluator import MINTEvaluator
from benchmarks.mint.metrics import MetricsCalculator
from benchmarks.mint.reporting import MINTReporter

logger = logging.getLogger(__name__)


@runtime_checkable
class ModelRuntime(Protocol):
    """Protocol for model runtime that can generate text."""

    async def use_model(
        self,
        model_type: object,
        params: dict[str, object] | None = None,
        **kwargs: object,
    ) -> object:
        """Use a model to generate text."""
        ...


class MINTRunner:
    """Run the complete MINT benchmark evaluation."""

    def __init__(
        self,
        config: MINTConfig,
        runtime: Optional[ModelRuntime] = None,
        trajectory_logger_service: object | None = None,
        trajectory_dataset: str = "mint-benchmark",
    ) -> None:
        """
        Initialize the MINT benchmark runner.

        Args:
            config: Benchmark configuration
            runtime: Optional ElizaOS runtime for model interactions
        """
        # Validate config
        if config.max_turns < 1:
            raise ValueError("max_turns must be at least 1")
        if config.timeout_per_task_ms < 1000:
            raise ValueError("timeout_per_task_ms must be at least 1000")

        self.config = config
        self._runtime: Optional[ModelRuntime] = None
        if runtime is not None and isinstance(runtime, ModelRuntime):
            self._runtime = runtime

        # Optional: elizaOS trajectory logger plugin service (Python)
        self._trajectory_logger_service: object | None = trajectory_logger_service
        self._trajectory_dataset: str = trajectory_dataset
        self._trajectory_ids: list[str] = []

        # MINT uses the canonical Eliza runtime + `compose_state`/`use_model`.
        # Core runtime already logs providers + LLM calls when a trajectory step is bound.
        # We therefore do NOT monkeypatch the runtime here.

        # Initialize components
        self.dataset = MINTDataset(config.data_path)
        self.executor = PythonExecutor(
            timeout=config.code_timeout_seconds,
            use_docker=config.use_docker,
        )
        self.feedback_generator = FeedbackGenerator(
            runtime=self._runtime,
            use_llm=self._runtime is not None and self.config.use_llm_feedback,
            feedback_model=config.feedback_model,
        )
        self.agent = MINTAgent(
            runtime=self._runtime,
            tool_executor=self.executor,
            feedback_generator=self.feedback_generator,
            temperature=config.temperature,
            trajectory_logger_service=self._trajectory_logger_service,
            trajectory_ids_sink=self._trajectory_ids,
        )
        self.evaluator = MINTEvaluator()
        self.metrics_calculator = MetricsCalculator()
        self.reporter = MINTReporter()

        self._start_time = 0.0

    async def run_benchmark(self) -> MINTBenchmarkResults:
        """
        Run the complete MINT benchmark with optional ablation study.

        Returns:
            MINTBenchmarkResults with all configurations
        """
        self._start_time = time.time()

        logger.info("[MINTRunner] Starting MINT benchmark")
        logger.info(f"[MINTRunner] Config: {self.config}")

        # Load dataset
        await self.dataset.load()
        tasks = self.dataset.get_tasks(
            categories=self.config.categories,
            limit=self.config.max_tasks_per_category,
        )

        if not tasks:
            raise ValueError("No tasks loaded from dataset")

        # Apply global max_turns cap from config.
        # (Tasks may specify their own max_turns; config should never exceed it.)
        tasks = [replace(t, max_turns=min(t.max_turns, self.config.max_turns)) for t in tasks]

        logger.info(f"[MINTRunner] Loaded {len(tasks)} tasks")

        # Run baseline (no tools, no feedback)
        logger.info("[MINTRunner] Running baseline configuration (no tools, no feedback)")
        baseline_results = await self._run_configuration(
            tasks, enable_tools=False, enable_feedback=False, name="baseline"
        )

        # Optional ablation configurations
        tools_only_results: Optional[ConfigurationResult] = None
        feedback_only_results: Optional[ConfigurationResult] = None
        full_results: Optional[ConfigurationResult] = None

        if self.config.run_ablation:
            if self.config.enable_tools:
                logger.info("[MINTRunner] Running tools-only configuration")
                tools_only_results = await self._run_configuration(
                    tasks, enable_tools=True, enable_feedback=False, name="tools_only"
                )

            if self.config.enable_feedback:
                logger.info("[MINTRunner] Running feedback-only configuration")
                feedback_only_results = await self._run_configuration(
                    tasks, enable_tools=False, enable_feedback=True, name="feedback_only"
                )

            if self.config.enable_tools and self.config.enable_feedback:
                logger.info("[MINTRunner] Running full configuration (tools + feedback)")
                full_results = await self._run_configuration(
                    tasks, enable_tools=True, enable_feedback=True, name="full"
                )

        elif self.config.enable_tools or self.config.enable_feedback:
            # Single configuration run
            full_results = await self._run_configuration(
                tasks,
                enable_tools=self.config.enable_tools,
                enable_feedback=self.config.enable_feedback,
                name="full",
            )

        # Calculate comparisons
        comparison = self.metrics_calculator.compare_configurations(
            baseline=baseline_results.metrics,
            with_tools=tools_only_results.metrics if tools_only_results else None,
            with_feedback=feedback_only_results.metrics if feedback_only_results else None,
            full=full_results.metrics if full_results else None,
        )

        # Generate summary
        summary = self._generate_summary(
            baseline_results,
            tools_only_results,
            feedback_only_results,
            full_results,
            comparison,
        )

        # Build results
        duration = time.time() - self._start_time
        results = MINTBenchmarkResults(
            metadata={
                "timestamp": datetime.now().isoformat(),
                "duration_seconds": duration,
                "total_tasks": len(tasks),
                "categories": [c.value for c in (self.config.categories or list(MINTCategory))],
                "config": {
                    "enable_tools": self.config.enable_tools,
                    "enable_feedback": self.config.enable_feedback,
                    "run_ablation": self.config.run_ablation,
                    "max_turns": self.config.max_turns,
                    "use_docker": self.config.use_docker,
                    "use_llm_feedback": self.config.use_llm_feedback,
                },
            },
            baseline_results=baseline_results,
            tools_only_results=tools_only_results,
            feedback_only_results=feedback_only_results,
            full_results=full_results,
            comparison=comparison,
            summary=summary,
        )

        # Save results
        if self.config.generate_report:
            await self._save_results(results)

        # Export elizaOS trajectories (ART + GRPO) for training use.
        if self._trajectory_logger_service is not None and self._trajectory_ids:
            try:
                # Prefer the plugin service export API if available.
                from elizaos_plugin_trajectory_logger.runtime_service import (
                    TrajectoryExportConfig,
                    TrajectoryLoggerRuntimeService,
                )

                out_dir = Path(self.config.output_dir) / "eliza_trajectories"
                out_dir.mkdir(parents=True, exist_ok=True)

                svc = self._trajectory_logger_service
                if isinstance(svc, TrajectoryLoggerRuntimeService):
                    # Export both formats for training pipelines.
                    art_res = svc.export(
                        TrajectoryExportConfig(
                            dataset_name=self._trajectory_dataset,
                            export_format="art",
                            output_dir=str(out_dir),
                            max_trajectories=len(self._trajectory_ids),
                        )
                    )
                    grpo_res = svc.export(
                        TrajectoryExportConfig(
                            dataset_name=self._trajectory_dataset,
                            export_format="grpo",
                            output_dir=str(out_dir),
                            max_trajectories=len(self._trajectory_ids),
                        )
                    )
                    logger.info(
                        f"[MINTRunner] Exported trajectories for training: "
                        f"art={art_res.dataset_url} grpo={grpo_res.dataset_url}"
                    )
            except Exception as e:
                logger.warning(f"[MINTRunner] Failed to export elizaOS trajectories: {e}")

        logger.info(
            f"[MINTRunner] Benchmark completed in {duration:.1f}s. "
            f"Best success rate: {self._get_best_success_rate(results):.1%}"
        )

        return results

    async def _run_configuration(
        self,
        tasks: list[MINTTask],
        enable_tools: bool,
        enable_feedback: bool,
        name: str,
    ) -> ConfigurationResult:
        """Run benchmark with a specific configuration."""
        results: list[MINTResult] = []
        start_time = time.time()

        for i, task in enumerate(tasks):
            try:
                logger.debug(
                    f"[MINTRunner] [{name}] Task {i + 1}/{len(tasks)}: {task.id}"
                )

                # Reset agent session for each task (canonical Eliza: new room per task)
                self.agent.reset_session()

                # Solve the task
                trajectory = await asyncio.wait_for(
                    self.agent.solve_task(
                        task,
                        enable_tools=enable_tools,
                        enable_feedback=enable_feedback,
                    ),
                    timeout=self.config.timeout_per_task_ms / 1000,
                )

                # Evaluate the result
                result = self.evaluator.evaluate_trajectory(task, trajectory)
                results.append(result)

                status = "✓" if result.success else "✗"
                logger.info(
                    f"[MINTRunner] [{name}] {status} {task.id}: "
                    f"turns={result.turns_used}, tools={result.tool_uses}"
                )

            except asyncio.TimeoutError:
                logger.warning(f"[MINTRunner] [{name}] Task {task.id} timed out")
                error_trajectory = MINTTrajectory(task_id=task.id)
                results.append(MINTResult(
                    task_id=task.id,
                    category=task.category,
                    trajectory=error_trajectory,
                    success=False,
                    turns_used=0,
                    tool_uses=0,
                    feedback_turns=0,
                    latency_ms=float(self.config.timeout_per_task_ms),
                    token_usage=0,
                    error="Timeout",
                ))

            except Exception as e:
                logger.error(f"[MINTRunner] [{name}] Task {task.id} failed: {e}")
                error_trajectory = MINTTrajectory(task_id=task.id)
                results.append(MINTResult(
                    task_id=task.id,
                    category=task.category,
                    trajectory=error_trajectory,
                    success=False,
                    turns_used=0,
                    tool_uses=0,
                    feedback_turns=0,
                    latency_ms=0.0,
                    token_usage=0,
                    error=str(e),
                ))

        # Calculate metrics
        metrics = self.metrics_calculator.calculate(results)
        duration = time.time() - start_time

        logger.info(
            f"[MINTRunner] [{name}] Completed: "
            f"{metrics.passed_tasks}/{metrics.total_tasks} passed "
            f"({metrics.overall_success_rate:.1%}) in {duration:.1f}s"
        )

        return ConfigurationResult(
            config_name=name,
            enable_tools=enable_tools,
            enable_feedback=enable_feedback,
            metrics=metrics,
            results=results,
        )

    def _generate_summary(
        self,
        baseline: ConfigurationResult,
        tools_only: Optional[ConfigurationResult],
        feedback_only: Optional[ConfigurationResult],
        full: Optional[ConfigurationResult],
        comparison: dict[str, float],
    ) -> dict[str, str | list[str]]:
        """Generate a summary of the benchmark results."""
        key_findings: list[str] = []
        recommendations: list[str] = []

        # Determine best configuration
        configs = [
            ("baseline", baseline.metrics.overall_success_rate),
        ]
        if tools_only:
            configs.append(("tools", tools_only.metrics.overall_success_rate))
        if feedback_only:
            configs.append(("feedback", feedback_only.metrics.overall_success_rate))
        if full:
            configs.append(("full", full.metrics.overall_success_rate))

        best_config = max(configs, key=lambda x: x[1])
        best_rate = best_config[1]

        # Status determination
        if best_rate >= 0.7:
            status = "excellent"
            key_findings.append(f"Excellent performance with {best_rate:.1%} success rate")
        elif best_rate >= 0.5:
            status = "good"
            key_findings.append(f"Good performance with {best_rate:.1%} success rate")
        elif best_rate >= 0.3:
            status = "moderate"
            key_findings.append(f"Moderate performance with {best_rate:.1%} success rate")
        else:
            status = "needs_improvement"
            key_findings.append(f"Performance needs improvement ({best_rate:.1%} success rate)")

        # Tool effectiveness analysis
        tool_improvement = comparison.get("tool_improvement", 0)
        if tool_improvement > 0.1:
            key_findings.append(f"Tools provide significant improvement (+{tool_improvement:.1%})")
        elif tool_improvement > 0:
            key_findings.append(f"Tools provide modest improvement (+{tool_improvement:.1%})")
        elif tool_improvement < -0.05:
            key_findings.append("Tool use may be hindering performance")
            recommendations.append("Review tool integration and code execution accuracy")

        # Feedback effectiveness analysis
        feedback_improvement = comparison.get("feedback_improvement", 0)
        if feedback_improvement > 0.1:
            key_findings.append(
                f"Feedback significantly improves performance (+{feedback_improvement:.1%})"
            )
        elif feedback_improvement > 0:
            key_findings.append(f"Feedback provides modest improvement (+{feedback_improvement:.1%})")
        elif feedback_improvement < -0.05:
            key_findings.append("Feedback may not be effective")
            recommendations.append("Improve feedback quality and relevance")

        # Synergy analysis
        synergy = comparison.get("synergy", 0)
        if synergy > 0.05:
            key_findings.append("Tools and feedback work synergistically")
        elif synergy < -0.05:
            key_findings.append("Tools and feedback may be interfering with each other")

        # Category analysis
        if full:
            for cat, rate in full.metrics.category_success_rates.items():
                if rate >= 0.8:
                    key_findings.append(f"Strong performance in {cat.value} tasks ({rate:.1%})")
                elif rate < 0.3:
                    recommendations.append(f"Improve {cat.value} task handling")

        # Multi-turn analysis
        if full and full.metrics.multi_turn_gain > 0.1:
            key_findings.append(
                f"Multi-turn interaction provides {full.metrics.multi_turn_gain:.1%} improvement"
            )

        # Default recommendations
        if not recommendations:
            recommendations.append("Continue testing with larger and more diverse datasets")
            recommendations.append("Compare with additional model configurations")

        return {
            "status": status,
            "best_configuration": best_config[0],
            "best_success_rate": f"{best_rate:.1%}",
            "key_findings": key_findings,
            "recommendations": recommendations,
        }

    def _get_best_success_rate(self, results: MINTBenchmarkResults) -> float:
        """Get the best success rate from all configurations."""
        rates = [results.baseline_results.metrics.overall_success_rate]
        if results.tools_only_results:
            rates.append(results.tools_only_results.metrics.overall_success_rate)
        if results.feedback_only_results:
            rates.append(results.feedback_only_results.metrics.overall_success_rate)
        if results.full_results:
            rates.append(results.full_results.metrics.overall_success_rate)
        return max(rates)

    async def _save_results(self, results: MINTBenchmarkResults) -> None:
        """Save benchmark results to files."""
        output_dir = Path(self.config.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        # Save JSON results
        json_path = output_dir / "mint-benchmark-results.json"
        results_dict = self._results_to_dict(results)
        with open(json_path, "w") as f:
            json.dump(results_dict, f, indent=2, default=str)
        logger.info(f"[MINTRunner] Saved JSON results to {json_path}")

        # Generate and save markdown report
        report_path = output_dir / "MINT-BENCHMARK-REPORT.md"
        report = self.reporter.generate_report(results)
        with open(report_path, "w") as f:
            f.write(report)
        logger.info(f"[MINTRunner] Saved markdown report to {report_path}")

        # Save trajectories if configured
        if self.config.save_trajectories and results.full_results:
            trajectories_path = output_dir / "trajectories.json"
            trajectories = [
                {
                    "task_id": r.task_id,
                    "success": r.success,
                    "turns": r.turns_used,
                    "answer": r.trajectory.final_answer if r.trajectory else None,
                }
                for r in results.full_results.results
            ]
            with open(trajectories_path, "w") as f:
                json.dump(trajectories, f, indent=2)

    def _results_to_dict(self, results: MINTBenchmarkResults) -> dict:
        """Convert results to a serializable dictionary."""

        def config_result_to_dict(cr: ConfigurationResult) -> dict:
            return {
                "config_name": cr.config_name,
                "enable_tools": cr.enable_tools,
                "enable_feedback": cr.enable_feedback,
                "metrics": {
                    "overall_success_rate": cr.metrics.overall_success_rate,
                    "total_tasks": cr.metrics.total_tasks,
                    "passed_tasks": cr.metrics.passed_tasks,
                    "failed_tasks": cr.metrics.failed_tasks,
                    "category_success_rates": {
                        k.value: v for k, v in cr.metrics.category_success_rates.items()
                    },
                    "avg_turns_to_success": cr.metrics.avg_turns_to_success,
                    "tool_usage_rate": cr.metrics.tool_usage_rate,
                    "tool_effectiveness": cr.metrics.tool_effectiveness,
                    "feedback_usage_rate": cr.metrics.feedback_usage_rate,
                    "feedback_effectiveness": cr.metrics.feedback_effectiveness,
                    "multi_turn_gain": cr.metrics.multi_turn_gain,
                    "avg_latency_ms": cr.metrics.avg_latency_ms,
                },
                "task_results": [
                    {
                        "task_id": r.task_id,
                        "category": r.category.value,
                        "success": r.success,
                        "score": r.score,
                        "turns_used": r.turns_used,
                        "tool_uses": r.tool_uses,
                        "feedback_turns": r.feedback_turns,
                        "latency_ms": r.latency_ms,
                        "error": r.error,
                    }
                    for r in cr.results
                ],
            }

        return {
            "metadata": results.metadata,
            "baseline_results": config_result_to_dict(results.baseline_results),
            "tools_only_results": (
                config_result_to_dict(results.tools_only_results)
                if results.tools_only_results else None
            ),
            "feedback_only_results": (
                config_result_to_dict(results.feedback_only_results)
                if results.feedback_only_results else None
            ),
            "full_results": (
                config_result_to_dict(results.full_results)
                if results.full_results else None
            ),
            "comparison": results.comparison,
            "summary": results.summary,
        }
