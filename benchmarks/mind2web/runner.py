"""
Mind2Web benchmark runner.

Orchestrates benchmark execution and result collection.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

from benchmarks.mind2web.dataset import Mind2WebDataset
from benchmarks.mind2web.eliza_agent import (
    ELIZAOS_AVAILABLE,
    create_mind2web_agent,
)
from benchmarks.mind2web.evaluator import Mind2WebEvaluator
from benchmarks.mind2web.types import (
    Mind2WebConfig,
    Mind2WebReport,
    Mind2WebResult,
    Mind2WebSplit,
    Mind2WebTask,
)

logger = logging.getLogger(__name__)


class Mind2WebRunner:
    """Runner for Mind2Web benchmark."""

    def __init__(
        self,
        config: Mind2WebConfig,
        *,
        use_sample: bool = False,
        use_huggingface: bool = True,
    ) -> None:
        self.config = config
        self.use_sample = use_sample
        self.use_huggingface = use_huggingface

        self.dataset = Mind2WebDataset(split=config.split)
        self.evaluator = Mind2WebEvaluator()
        self._start_time = 0.0
        self._elizaos_mode = not config.use_mock and ELIZAOS_AVAILABLE

    async def run_benchmark(self) -> Mind2WebReport:
        """Run the Mind2Web benchmark.

        Returns:
            Mind2WebReport with results and metrics
        """
        self._start_time = time.time()

        # Load dataset
        await self.dataset.load(
            use_huggingface=self.use_huggingface,
            use_sample=self.use_sample,
        )

        tasks = self.dataset.get_tasks(limit=self.config.max_tasks)
        if not tasks:
            raise RuntimeError("No tasks loaded from dataset")

        logger.info(f"Running Mind2Web benchmark on {len(tasks)} tasks")

        # Run tasks
        results: list[Mind2WebResult] = []
        for task in tasks:
            for trial in range(1, max(1, self.config.num_trials) + 1):
                result = await self._run_task(task, trial_number=trial)
                results.append(result)

                # Log progress
                if result.success:
                    logger.info(
                        f"Task {task.annotation_id} trial {trial}: SUCCESS "
                        f"(step_acc={result.step_accuracy:.2%})"
                    )
                else:
                    logger.info(
                        f"Task {task.annotation_id} trial {trial}: "
                        f"step_acc={result.step_accuracy:.2%}, elem_acc={result.element_accuracy:.2%}"
                    )

        # Generate report
        report = self._generate_report(results)

        # Save results
        await self._save_results(report)

        return report

    async def _run_task(
        self, task: Mind2WebTask, *, trial_number: int
    ) -> Mind2WebResult:
        """Run a single task.

        Args:
            task: The Mind2Web task
            trial_number: Trial number

        Returns:
            Mind2WebResult with evaluation metrics
        """
        start_time = time.time()

        if self.config.model_provider == "milaidy":
            from milaidy_adapter.mind2web import MilaidyMind2WebAgent

            agent = MilaidyMind2WebAgent(self.config)
        else:
            agent = create_mind2web_agent(self.config)

        try:
            await agent.initialize()

            # Run with timeout
            predictions = await asyncio.wait_for(
                agent.process_task(task),
                timeout=self.config.timeout_ms / 1000,
            )

            latency_ms = (time.time() - start_time) * 1000

            # Evaluate predictions
            result = self.evaluator.evaluate_task(
                task,
                predictions,
                trial_number=trial_number,
                latency_ms=latency_ms,
            )

            return result

        except asyncio.TimeoutError:
            return Mind2WebResult(
                task_id=task.annotation_id,
                instruction=task.confirmed_task,
                website=task.website,
                domain=task.domain,
                trial_number=trial_number,
                success=False,
                error="Task timed out",
                latency_ms=(time.time() - start_time) * 1000,
                total_steps=len(task.actions),
            )

        except Exception as e:
            logger.error(f"Error running task {task.annotation_id}: {e}")
            return Mind2WebResult(
                task_id=task.annotation_id,
                instruction=task.confirmed_task,
                website=task.website,
                domain=task.domain,
                trial_number=trial_number,
                success=False,
                error=str(e),
                latency_ms=(time.time() - start_time) * 1000,
                total_steps=len(task.actions),
            )

        finally:
            await agent.close()

    def _generate_report(self, results: list[Mind2WebResult]) -> Mind2WebReport:
        """Generate benchmark report from results."""
        if not results:
            return Mind2WebReport(
                total_tasks=0,
                total_trials=0,
                overall_element_accuracy=0.0,
                overall_operation_accuracy=0.0,
                overall_step_accuracy=0.0,
                overall_task_success_rate=0.0,
                results=[],
            )

        # Aggregate metrics
        metrics = self.evaluator.compute_aggregate_metrics(results)

        # Group by domain
        by_domain: dict[str, dict[str, float]] = {}
        domains = set(r.domain for r in results)
        for domain in domains:
            domain_results = [r for r in results if r.domain == domain]
            domain_metrics = self.evaluator.compute_aggregate_metrics(domain_results)
            by_domain[domain] = domain_metrics

        # Group by website
        by_website: dict[str, dict[str, float]] = {}
        websites = set(r.website for r in results)
        for website in websites:
            website_results = [r for r in results if r.website == website]
            website_metrics = self.evaluator.compute_aggregate_metrics(website_results)
            by_website[website] = website_metrics

        total_tasks = len(set(r.task_id for r in results))
        total_trials = len(results)

        status: str
        success_rate = metrics["overall_task_success_rate"]
        if success_rate >= 0.7:
            status = "excellent"
        elif success_rate >= 0.5:
            status = "good"
        elif success_rate >= 0.3:
            status = "moderate"
        else:
            status = "needs_improvement"

        summary: dict[str, str | int | float | bool] = {
            "status": status,
            "timestamp": datetime.now().isoformat(),
            "mode": "real-llm" if self._elizaos_mode else "mock",
            "split": self.config.split.value,
            "model_provider": self.config.model_provider or "auto",
        }

        return Mind2WebReport(
            total_tasks=total_tasks,
            total_trials=total_trials,
            overall_element_accuracy=metrics["overall_element_accuracy"],
            overall_operation_accuracy=metrics["overall_operation_accuracy"],
            overall_step_accuracy=metrics["overall_step_accuracy"],
            overall_task_success_rate=metrics["overall_task_success_rate"],
            by_domain=by_domain,
            by_website=by_website,
            average_latency_ms=metrics["average_latency_ms"],
            results=results,
            summary=summary,
        )

    async def _save_results(self, report: Mind2WebReport) -> None:
        """Save benchmark results to disk."""
        out_dir = Path(self.config.output_dir)
        out_dir.mkdir(parents=True, exist_ok=True)

        # Save main results JSON
        results_path = out_dir / "mind2web-results.json"
        with open(results_path, "w") as f:
            json.dump(self._report_to_dict(report), f, indent=2, default=str)

        # Save markdown summary
        summary_path = out_dir / "mind2web-summary.md"
        with open(summary_path, "w") as f:
            f.write(self._generate_markdown_summary(report))

        # Save detailed results if enabled
        if self.config.save_detailed_logs:
            detailed_path = out_dir / "mind2web-detailed.json"
            with open(detailed_path, "w") as f:
                # Convert results to serializable format
                detailed = []
                for r in report.results:
                    result_dict = {
                        "task_id": r.task_id,
                        "instruction": r.instruction,
                        "website": r.website,
                        "domain": r.domain,
                        "trial_number": r.trial_number,
                        "success": r.success,
                        "element_accuracy": r.element_accuracy,
                        "operation_accuracy": r.operation_accuracy,
                        "step_accuracy": r.step_accuracy,
                        "steps_completed": r.steps_completed,
                        "total_steps": r.total_steps,
                        "latency_ms": r.latency_ms,
                        "error": r.error,
                        "agent_trajectory": [
                            {
                                "operation": a.operation.value,
                                "element_id": a.element_id,
                                "value": a.value,
                            }
                            for a in r.agent_trajectory
                        ],
                    }
                    detailed.append(result_dict)

                json.dump({"results": detailed}, f, indent=2, default=str)

        logger.info(f"Results saved to {out_dir}")

    def _report_to_dict(self, report: Mind2WebReport) -> dict[str, object]:
        """Convert report to dictionary for JSON serialization."""
        return {
            "total_tasks": report.total_tasks,
            "total_trials": report.total_trials,
            "overall_element_accuracy": report.overall_element_accuracy,
            "overall_operation_accuracy": report.overall_operation_accuracy,
            "overall_step_accuracy": report.overall_step_accuracy,
            "overall_task_success_rate": report.overall_task_success_rate,
            "average_latency_ms": report.average_latency_ms,
            "by_domain": report.by_domain,
            "by_website": report.by_website,
            "summary": report.summary,
        }

    def _generate_markdown_summary(self, report: Mind2WebReport) -> str:
        """Generate markdown summary of results."""
        lines = [
            "# Mind2Web Benchmark Results",
            "",
            "## Summary",
            "",
            "| Metric | Value |",
            "|---|---:|",
            f"| Status | {report.summary.get('status', 'unknown')} |",
            f"| Mode | {report.summary.get('mode', 'unknown')} |",
            f"| Split | {report.summary.get('split', 'unknown')} |",
            f"| Total Tasks | {report.total_tasks} |",
            f"| Total Trials | {report.total_trials} |",
            f"| Task Success Rate | {report.overall_task_success_rate * 100:.1f}% |",
            f"| Step Accuracy | {report.overall_step_accuracy * 100:.1f}% |",
            f"| Element Accuracy | {report.overall_element_accuracy * 100:.1f}% |",
            f"| Operation Accuracy | {report.overall_operation_accuracy * 100:.1f}% |",
            f"| Avg Latency (ms) | {report.average_latency_ms:.0f} |",
            "",
        ]

        if report.by_domain:
            lines.extend([
                "## Results by Domain",
                "",
                "| Domain | Task Success | Step Acc | Element Acc |",
                "|---|---:|---:|---:|",
            ])
            for domain, metrics in sorted(report.by_domain.items()):
                lines.append(
                    f"| {domain} | "
                    f"{metrics.get('overall_task_success_rate', 0) * 100:.1f}% | "
                    f"{metrics.get('overall_step_accuracy', 0) * 100:.1f}% | "
                    f"{metrics.get('overall_element_accuracy', 0) * 100:.1f}% |"
                )
            lines.append("")

        lines.extend([
            "## Notes",
            "",
            "- Task success requires all steps to be correct",
            "- Step accuracy measures element + operation + value correctness",
            "- Element accuracy measures target element selection",
            "",
        ])

        return "\n".join(lines)
