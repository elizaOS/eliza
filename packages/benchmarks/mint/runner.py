"""
MINT Benchmark Runner

Orchestrates the full MINT benchmark evaluation with ablation study support.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime
from pathlib import Path
from typing import Optional, Protocol, runtime_checkable

from benchmarks.mint.types import (
    MINTBenchmarkResults,
    MINTConfig,
    MINTResult,
    MINTSubtask,
    MINTTask,
    MINTTrajectory,
    ConfigurationResult,
)
from benchmarks.mint.dataset import MINTDataset
from benchmarks.mint.executor import PythonExecutor, MockExecutor
from benchmarks.mint.feedback import FeedbackGenerator
from benchmarks.mint.agent import MINTAgent
from benchmarks.mint.evaluator import MINTEvaluator
from benchmarks.mint.metrics import MetricsCalculator
from benchmarks.mint.reporting import MINTReporter

logger = logging.getLogger(__name__)


@runtime_checkable
class ModelRuntime(Protocol):
    async def use_model(
        self,
        model_type: object,
        params: dict[str, object] | None = None,
        **kwargs: object,
    ) -> object:
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
        if config.max_turns < 1:
            raise ValueError("max_turns must be at least 1")
        if config.timeout_per_task_ms < 1000:
            raise ValueError("timeout_per_task_ms must be at least 1000")

        self.config = config
        self._runtime: Optional[ModelRuntime] = (
            runtime if (runtime is not None and isinstance(runtime, ModelRuntime)) else None
        )

        self._trajectory_logger_service: object | None = trajectory_logger_service
        self._trajectory_dataset: str = trajectory_dataset
        self._trajectory_ids: list[str] = []

        self.dataset = MINTDataset(
            data_path=config.data_path,
            use_sample_tasks=config.use_sample_tasks,
        )

        if config.use_mock_executor:
            logger.warning(
                "[MINTRunner] Using MockExecutor — code is NOT actually "
                "executed. Use only for smoke tests."
            )
            self.executor: PythonExecutor | MockExecutor = MockExecutor()
        else:
            self.executor = PythonExecutor(
                timeout=config.code_timeout_seconds,
                use_docker=config.use_docker,
            )

        feedback_mode = "llm" if (
            self._runtime is not None and config.feedback_mode == "llm"
        ) else "templated"

        self.feedback_generator = FeedbackGenerator(
            runtime=self._runtime,
            use_llm=feedback_mode == "llm",
            feedback_model=config.feedback_model,
            mode=feedback_mode,
        )

        self.agent = MINTAgent(
            runtime=self._runtime,
            tool_executor=self.executor,
            feedback_generator=self.feedback_generator,
            temperature=config.temperature,
            trajectory_logger_service=self._trajectory_logger_service,
            trajectory_ids_sink=self._trajectory_ids,
            allow_ground_truth_mock=config.allow_ground_truth_mock,
        )

        self.evaluator = MINTEvaluator()
        self.metrics_calculator = MetricsCalculator()
        self.reporter = MINTReporter()
        self._start_time = 0.0

    # ------------------------------------------------------------------
    async def run_benchmark(self) -> MINTBenchmarkResults:
        self._start_time = time.time()
        logger.info("[MINTRunner] Starting MINT benchmark")
        logger.info("[MINTRunner] Config: %s", self.config)

        await self.dataset.load()
        tasks = self.dataset.get_tasks(
            subtasks=self.config.subtasks,
            limit=self.config.max_tasks_per_subtask,
        )
        if not tasks:
            raise ValueError("No tasks loaded from dataset")

        tasks = [
            t.replace(max_turns=min(t.max_turns, self.config.max_turns))
            for t in tasks
        ]
        logger.info("[MINTRunner] Loaded %d tasks", len(tasks))

        baseline_results: Optional[ConfigurationResult] = None
        tools_only_results: Optional[ConfigurationResult] = None
        feedback_only_results: Optional[ConfigurationResult] = None
        full_results: Optional[ConfigurationResult] = None

        if self.config.run_ablation:
            logger.info("[MINTRunner] Running baseline (no tools, no feedback)")
            baseline_results = await self._run_configuration(
                tasks, enable_tools=False, enable_feedback=False, name="baseline"
            )
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
        else:
            name = (
                "full"
                if self.config.enable_tools and self.config.enable_feedback
                else "tools_only"
                if self.config.enable_tools
                else "feedback_only"
                if self.config.enable_feedback
                else "baseline"
            )
            logger.info("[MINTRunner] Running single configuration: %s", name)
            selected = await self._run_configuration(
                tasks,
                enable_tools=self.config.enable_tools,
                enable_feedback=self.config.enable_feedback,
                name=name,
            )
            if name == "baseline":
                baseline_results = selected
            elif name == "tools_only":
                tools_only_results = selected
            elif name == "feedback_only":
                feedback_only_results = selected
            else:
                full_results = selected

        if baseline_results is None:
            baseline_results = ConfigurationResult(
                config_name="baseline",
                enable_tools=False,
                enable_feedback=False,
                metrics=self.metrics_calculator.calculate([]),
                results=[],
            )

        comparison = self.metrics_calculator.compare_configurations(
            baseline=baseline_results.metrics,
            with_tools=tools_only_results.metrics if tools_only_results else None,
            with_feedback=feedback_only_results.metrics
            if feedback_only_results
            else None,
            full=full_results.metrics if full_results else None,
        )

        summary = self._generate_summary(
            baseline_results,
            tools_only_results,
            feedback_only_results,
            full_results,
            comparison,
        )

        duration = time.time() - self._start_time
        results = MINTBenchmarkResults(
            metadata={
                "timestamp": datetime.now().isoformat(),
                "duration_seconds": duration,
                "total_tasks": len(tasks),
                "subtasks": [
                    s.value for s in (self.config.subtasks or list(MINTSubtask))
                ],
                "config": {
                    "enable_tools": self.config.enable_tools,
                    "enable_feedback": self.config.enable_feedback,
                    "run_ablation": self.config.run_ablation,
                    "max_turns": self.config.max_turns,
                    "use_docker": self.config.use_docker,
                    "feedback_mode": self.config.feedback_mode,
                    "use_sample_tasks": self.config.use_sample_tasks,
                    "use_mock_executor": self.config.use_mock_executor,
                },
            },
            baseline_results=baseline_results,
            tools_only_results=tools_only_results,
            feedback_only_results=feedback_only_results,
            full_results=full_results,
            comparison=comparison,
            summary=summary,
        )

        await self._save_results(results)

        if self._trajectory_logger_service is not None and self._trajectory_ids:
            logger.info(
                "[MINTRunner] Skipping Python trajectory export; bridge-side "
                "trajectory export owns dataset %s (%d ids)",
                self._trajectory_dataset,
                len(self._trajectory_ids),
            )

        logger.info(
            "[MINTRunner] Benchmark completed in %.1fs. Best success rate: %.1f%%",
            duration,
            self._get_best_success_rate(results) * 100,
        )
        return results

    # ------------------------------------------------------------------
    async def _run_configuration(
        self,
        tasks: list[MINTTask],
        enable_tools: bool,
        enable_feedback: bool,
        name: str,
    ) -> ConfigurationResult:
        results: list[MINTResult] = []
        start_time = time.time()

        for i, task in enumerate(tasks):
            try:
                logger.debug("[MINTRunner] [%s] Task %d/%d: %s", name, i + 1, len(tasks), task.id)
                self.agent.reset_session()
                trajectory = await asyncio.wait_for(
                    self.agent.solve_task(
                        task,
                        enable_tools=enable_tools,
                        enable_feedback=enable_feedback,
                    ),
                    timeout=self.config.timeout_per_task_ms / 1000,
                )
                result = self.evaluator.evaluate_trajectory(task, trajectory)
                results.append(result)
                status = "PASS" if result.success else "FAIL"
                logger.info(
                    "[MINTRunner] [%s] %s %s: turns=%d tools=%d",
                    name,
                    status,
                    task.id,
                    result.turns_used,
                    result.tool_uses,
                )
            except asyncio.TimeoutError:
                logger.warning("[MINTRunner] [%s] Task %s timed out", name, task.id)
                results.append(self._error_result(task, "Timeout", self.config.timeout_per_task_ms))
            except Exception as exc:
                logger.error("[MINTRunner] [%s] Task %s failed: %s", name, task.id, exc)
                results.append(self._error_result(task, str(exc), 0.0))

        metrics = self.metrics_calculator.calculate(results, max_turns=self.config.max_turns)
        duration = time.time() - start_time
        logger.info(
            "[MINTRunner] [%s] Completed: %d/%d passed (%.1f%%) in %.1fs",
            name,
            metrics.passed_tasks,
            metrics.total_tasks,
            metrics.overall_success_rate * 100,
            duration,
        )
        return ConfigurationResult(
            config_name=name,
            enable_tools=enable_tools,
            enable_feedback=enable_feedback,
            metrics=metrics,
            results=results,
        )

    def _error_result(
        self, task: MINTTask, error: str, latency_ms: float
    ) -> MINTResult:
        return MINTResult(
            task_id=task.id,
            subtask=task.subtask,
            trajectory=MINTTrajectory(task_id=task.id),
            success=False,
            turns_used=0,
            tool_uses=0,
            feedback_turns=0,
            latency_ms=float(latency_ms),
            token_usage=0,
            error=error,
        )

    # ------------------------------------------------------------------
    def _generate_summary(
        self,
        baseline: ConfigurationResult,
        tools_only: Optional[ConfigurationResult],
        feedback_only: Optional[ConfigurationResult],
        full: Optional[ConfigurationResult],
        comparison: dict[str, float],
    ) -> dict[str, str | list[str]]:
        key_findings: list[str] = []
        recommendations: list[str] = []

        configs: list[tuple[str, float]] = []
        if baseline.metrics.total_tasks > 0:
            configs.append(("baseline", baseline.metrics.overall_success_rate))
        if tools_only:
            configs.append(("tools", tools_only.metrics.overall_success_rate))
        if feedback_only:
            configs.append(("feedback", feedback_only.metrics.overall_success_rate))
        if full:
            configs.append(("full", full.metrics.overall_success_rate))
        if not configs:
            configs.append(("baseline", baseline.metrics.overall_success_rate))

        best_config = max(configs, key=lambda x: x[1])
        best_rate = best_config[1]

        if best_rate >= 0.7:
            status = "excellent"
        elif best_rate >= 0.5:
            status = "good"
        elif best_rate >= 0.3:
            status = "moderate"
        else:
            status = "needs_improvement"
        key_findings.append(f"Best success rate: {best_rate:.1%} ({best_config[0]})")

        canonical = full or feedback_only or tools_only or baseline
        m = canonical.metrics
        key_findings.append(
            f"Turn-1 SR={m.turn_1_success_rate:.1%} / Turn-3 SR={m.turn_3_success_rate:.1%} / "
            f"Turn-5 SR={m.turn_5_success_rate:.1%} (Δ={m.multi_turn_gain:+.1%})"
        )

        tool_improvement = comparison.get("tool_improvement", 0)
        if tool_improvement > 0.1:
            key_findings.append(f"Tools improve success (+{tool_improvement:.1%})")
        elif tool_improvement < -0.05:
            key_findings.append("Tool use may be hindering performance")
            recommendations.append("Review tool integration and execution accuracy")

        feedback_improvement = comparison.get("feedback_improvement", 0)
        if feedback_improvement > 0.1:
            key_findings.append(f"Feedback improves success (+{feedback_improvement:.1%})")
        elif feedback_improvement < -0.05:
            recommendations.append("Improve feedback quality and relevance")

        for st, rate in canonical.metrics.subtask_success_rates.items():
            if rate >= 0.8:
                key_findings.append(f"Strong performance on {st.value} ({rate:.1%})")
            elif rate < 0.3 and canonical.metrics.subtask_counts.get(st, 0) > 0:
                recommendations.append(f"Improve {st.value} task handling")

        if not recommendations:
            recommendations.append("Continue testing with larger and more diverse datasets")

        return {
            "status": status,
            "best_configuration": best_config[0],
            "best_success_rate": f"{best_rate:.1%}",
            "key_findings": key_findings,
            "recommendations": recommendations,
        }

    def _get_best_success_rate(self, results: MINTBenchmarkResults) -> float:
        rates = [results.baseline_results.metrics.overall_success_rate]
        if results.tools_only_results:
            rates.append(results.tools_only_results.metrics.overall_success_rate)
        if results.feedback_only_results:
            rates.append(results.feedback_only_results.metrics.overall_success_rate)
        if results.full_results:
            rates.append(results.full_results.metrics.overall_success_rate)
        return max(rates) if rates else 0.0

    # ------------------------------------------------------------------
    async def _save_results(self, results: MINTBenchmarkResults) -> None:
        output_dir = Path(self.config.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        json_path = output_dir / "mint-benchmark-results.json"
        results_dict = self._results_to_dict(results)
        with open(json_path, "w") as fh:
            json.dump(results_dict, fh, indent=2, default=str)
        logger.info("[MINTRunner] Saved JSON results to %s", json_path)

        if self.config.generate_report:
            report_path = output_dir / "MINT-BENCHMARK-REPORT.md"
            report = self.reporter.generate_report(results)
            with open(report_path, "w") as fh:
                fh.write(report)
            logger.info("[MINTRunner] Saved markdown report to %s", report_path)

        if self.config.save_trajectories and results.full_results:
            traj_path = output_dir / "trajectories.json"
            trajs = [
                {
                    "task_id": r.task_id,
                    "success": r.success,
                    "turns": r.turns_used,
                    "answer": r.trajectory.final_answer if r.trajectory else None,
                    "per_turn_answers": r.trajectory.per_turn_answers if r.trajectory else [],
                    "cumulative_success_per_turn": r.cumulative_success_per_turn,
                }
                for r in results.full_results.results
            ]
            with open(traj_path, "w") as fh:
                json.dump(trajs, fh, indent=2)

    def _results_to_dict(self, results: MINTBenchmarkResults) -> dict:
        def cr_to_dict(cr: ConfigurationResult) -> dict:
            m = cr.metrics
            return {
                "config_name": cr.config_name,
                "enable_tools": cr.enable_tools,
                "enable_feedback": cr.enable_feedback,
                "metrics": {
                    "overall_success_rate": m.overall_success_rate,
                    "total_tasks": m.total_tasks,
                    "passed_tasks": m.passed_tasks,
                    "failed_tasks": m.failed_tasks,
                    "subtask_success_rates": {
                        k.value: v for k, v in m.subtask_success_rates.items()
                    },
                    "task_type_success_rates": {
                        k.value: v for k, v in m.task_type_success_rates.items()
                    },
                    "avg_turns_to_success": m.avg_turns_to_success,
                    "tool_usage_rate": m.tool_usage_rate,
                    "tool_effectiveness": m.tool_effectiveness,
                    "feedback_usage_rate": m.feedback_usage_rate,
                    "feedback_effectiveness": m.feedback_effectiveness,
                    "multi_turn_gain": m.multi_turn_gain,
                    "turn_1_success_rate": m.turn_1_success_rate,
                    "turn_2_success_rate": m.turn_2_success_rate,
                    "turn_3_success_rate": m.turn_3_success_rate,
                    "turn_4_success_rate": m.turn_4_success_rate,
                    "turn_5_success_rate": m.turn_5_success_rate,
                    "per_turn_success_rates": m.per_turn_success_rates,
                    "avg_latency_ms": m.avg_latency_ms,
                },
                "task_results": [
                    {
                        "task_id": r.task_id,
                        "subtask": r.subtask.value,
                        "success": r.success,
                        "score": r.score,
                        "turns_used": r.turns_used,
                        "tool_uses": r.tool_uses,
                        "feedback_turns": r.feedback_turns,
                        "latency_ms": r.latency_ms,
                        "error": r.error,
                        "cumulative_success_per_turn": r.cumulative_success_per_turn,
                    }
                    for r in cr.results
                ],
            }

        return {
            "metadata": results.metadata,
            "baseline_results": cr_to_dict(results.baseline_results),
            "tools_only_results": cr_to_dict(results.tools_only_results)
            if results.tools_only_results
            else None,
            "feedback_only_results": cr_to_dict(results.feedback_only_results)
            if results.feedback_only_results
            else None,
            "full_results": cr_to_dict(results.full_results)
            if results.full_results
            else None,
            "comparison": results.comparison,
            "summary": results.summary,
        }
