"""VisualWebBench benchmark runner."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Any

from benchmarks.visualwebbench.agent import OracleVisualWebBenchAgent
from benchmarks.visualwebbench.dataset import VisualWebBenchDataset
from benchmarks.visualwebbench.evaluator import VisualWebBenchEvaluator
from benchmarks.visualwebbench.types import (
    VisualWebBenchConfig,
    VisualWebBenchPrediction,
    VisualWebBenchReport,
    VisualWebBenchResult,
    VisualWebBenchTask,
)

logger = logging.getLogger(__name__)

_ELIZA_BRIDGE_PROVIDERS = {"eliza", "eliza-bridge", "eliza-ts"}
_ELIZA_APP_HARNESS_PROVIDERS = {
    "app-harness",
    "eliza-app",
    "eliza-app-harness",
    "eliza-browser-app",
}


class VisualWebBenchRunner:
    """Run VisualWebBench tasks and write benchmark artifacts."""

    def __init__(self, config: VisualWebBenchConfig) -> None:
        self.config = config
        self.dataset = VisualWebBenchDataset(
            fixture_path=config.fixture_path,
            hf_repo=config.hf_repo,
            split=config.split,
            task_types=config.task_types,
        )
        self.evaluator = VisualWebBenchEvaluator(
            bbox_iou_threshold=config.bbox_iou_threshold,
        )

    async def run_benchmark(self) -> VisualWebBenchReport:
        """Load, run, score, and save the benchmark."""
        await self.dataset.load(
            use_huggingface=self.config.use_huggingface,
            use_fixture=self.config.use_fixture,
            max_tasks=self.config.max_tasks,
        )
        tasks = self.dataset.get_tasks(self.config.max_tasks)
        if not tasks:
            raise RuntimeError("No VisualWebBench tasks loaded")

        agent = self._create_agent()
        await agent.initialize()
        try:
            results: list[VisualWebBenchResult] = []
            for task in tasks:
                result = await self._run_task(agent, task)
                results.append(result)
                logger.info(
                    "VisualWebBench %s/%s score=%.1f",
                    task.task_type.value,
                    task.id,
                    result.score,
                )
        finally:
            await agent.close()

        report = self._generate_report(results)
        self._save_results(report)
        return report

    def _create_agent(self) -> Any:
        provider = (self.config.provider or "").strip().lower()
        if self.config.dry_run or not provider:
            return OracleVisualWebBenchAgent()
        if provider in _ELIZA_BRIDGE_PROVIDERS:
            from eliza_adapter.visualwebbench import ElizaVisualWebBenchAgent

            return ElizaVisualWebBenchAgent(self.config)
        if provider in _ELIZA_APP_HARNESS_PROVIDERS:
            from eliza_adapter.visualwebbench import ElizaVisualWebBenchAppHarnessAgent

            return ElizaVisualWebBenchAppHarnessAgent(self.config)
        raise ValueError(
            "VisualWebBench supports --dry-run, --provider eliza, or "
            f"--provider eliza-app-harness, got {provider!r}"
        )

    async def _run_task(self, agent: Any, task: VisualWebBenchTask) -> VisualWebBenchResult:
        started = time.time()
        timeout_ms = getattr(agent, "task_timeout_ms", self.config.timeout_ms)
        try:
            prediction = await asyncio.wait_for(
                agent.predict(task),
                timeout=timeout_ms / 1000,
            )
        except asyncio.TimeoutError:
            prediction = VisualWebBenchPrediction(
                task_id=task.id,
                task_type=task.task_type,
                error="Task timed out",
                latency_ms=(time.time() - started) * 1000,
            )
        except Exception as exc:
            logger.exception("VisualWebBench task failed: %s", task.id)
            prediction = VisualWebBenchPrediction(
                task_id=task.id,
                task_type=task.task_type,
                error=str(exc),
                latency_ms=(time.time() - started) * 1000,
            )
        return self.evaluator.evaluate(task, prediction)

    def _generate_report(self, results: list[VisualWebBenchResult]) -> VisualWebBenchReport:
        metrics = self.evaluator.aggregate(results)
        by_task_type: dict[str, dict[str, float]] = {}
        for task_type in sorted({r.task_type.value for r in results}):
            subset = [r for r in results if r.task_type.value == task_type]
            by_task_type[task_type] = {
                "accuracy": sum(r.score for r in subset) / len(subset) if subset else 0.0,
                "total_tasks": float(len(subset)),
            }

        return VisualWebBenchReport(
            total_tasks=len(results),
            overall_accuracy=metrics["overall_accuracy"],
            exact_accuracy=metrics["exact_accuracy"],
            choice_accuracy=metrics["choice_accuracy"],
            bbox_accuracy=metrics["bbox_accuracy"],
            by_task_type=by_task_type,
            average_latency_ms=metrics["average_latency_ms"],
            results=results,
            summary={
                "timestamp": datetime.now().isoformat(),
                "mode": _mode_name(self.config),
                "source": "huggingface" if self.config.use_huggingface else "fixture",
                "hf_repo": self.config.hf_repo,
                "split": self.config.split,
                "model": self.config.model or "",
                "provider": self.config.provider or "",
            },
        )

    def _save_results(self, report: VisualWebBenchReport) -> None:
        out_dir = Path(self.config.output_dir)
        out_dir.mkdir(parents=True, exist_ok=True)

        results_path = out_dir / "visualwebbench-results.json"
        with results_path.open("w", encoding="utf-8") as f:
            json.dump(self._report_to_dict(report), f, indent=2, default=str)

        summary_path = out_dir / "summary.md"
        with summary_path.open("w", encoding="utf-8") as f:
            f.write(self._markdown_summary(report))

        if self.config.save_traces:
            trace_dir = out_dir / "traces"
            trace_dir.mkdir(parents=True, exist_ok=True)
            for result in report.results:
                trace_path = trace_dir / f"{_safe_name(result.task_id)}.json"
                with trace_path.open("w", encoding="utf-8") as f:
                    json.dump(_result_to_dict(result), f, indent=2, default=str)

        logger.info("VisualWebBench results saved to %s", out_dir)

    def _report_to_dict(self, report: VisualWebBenchReport) -> dict[str, Any]:
        return {
            "benchmark": "visualwebbench",
            "total_tasks": report.total_tasks,
            "overall_accuracy": report.overall_accuracy,
            "exact_accuracy": report.exact_accuracy,
            "choice_accuracy": report.choice_accuracy,
            "bbox_accuracy": report.bbox_accuracy,
            "average_latency_ms": report.average_latency_ms,
            "by_task_type": report.by_task_type,
            "summary": report.summary,
            "results": [_result_to_dict(r) for r in report.results],
        }

    def _markdown_summary(self, report: VisualWebBenchReport) -> str:
        lines = [
            "# VisualWebBench Results",
            "",
            "| Metric | Value |",
            "|---|---:|",
            f"| Mode | {report.summary.get('mode', 'unknown')} |",
            f"| Source | {report.summary.get('source', 'unknown')} |",
            f"| Total Tasks | {report.total_tasks} |",
            f"| Overall Accuracy | {report.overall_accuracy * 100:.1f}% |",
            f"| Exact Accuracy | {report.exact_accuracy * 100:.1f}% |",
            f"| Choice Accuracy | {report.choice_accuracy * 100:.1f}% |",
            f"| BBox Accuracy | {report.bbox_accuracy * 100:.1f}% |",
            f"| Avg Latency (ms) | {report.average_latency_ms:.0f} |",
            "",
            "## By Task Type",
            "",
            "| Task Type | Tasks | Accuracy |",
            "|---|---:|---:|",
        ]
        for task_type, metrics in sorted(report.by_task_type.items()):
            lines.append(
                f"| {task_type} | {int(metrics.get('total_tasks', 0))} | "
                f"{metrics.get('accuracy', 0) * 100:.1f}% |"
            )
        lines.extend([
            "",
            "## Notes",
            "",
            "- Exact tasks use normalized exact-match scoring.",
            "- Choice tasks compare option indices with text fallback.",
            "- Grounding tasks accept choice indices or normalized bbox predictions scored by IoU.",
            "",
        ])
        return "\n".join(lines)


def _result_to_dict(result: VisualWebBenchResult) -> dict[str, Any]:
    data = asdict(result)
    data["task_type"] = result.task_type.value
    data["prediction"]["task_type"] = result.prediction.task_type.value
    return data


def _safe_name(value: str) -> str:
    return "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in value)


def _mode_name(config: VisualWebBenchConfig) -> str:
    provider = (config.provider or "").strip().lower()
    if config.dry_run or not provider:
        return "dry-run"
    if provider in _ELIZA_APP_HARNESS_PROVIDERS:
        return "eliza-app-harness"
    return "eliza-bridge"
