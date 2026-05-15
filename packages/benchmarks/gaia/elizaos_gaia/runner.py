"""
GAIA Benchmark Runner

Orchestrates the complete benchmark execution including dataset loading,
agent execution, evaluation, and report generation. Every LLM/tool call
is routed through the elizaOS TypeScript benchmark bridge
(``packages/app-core/src/benchmark/server.ts``); the legacy Python
``AgentRuntime`` path has been removed.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
import tracemalloc
from dataclasses import asdict, dataclass, is_dataclass
from datetime import datetime
from pathlib import Path

from elizaos_gaia.dataset import DatasetAccessError, GAIADataset
from elizaos_gaia.evaluator import GAIAEvaluator
from elizaos_gaia.metrics import MetricsCalculator
from elizaos_gaia.providers import ModelConfig
from elizaos_gaia.types import (
    GAIABenchmarkResults,
    GAIAConfig,
    GAIALevel,
    GAIAQuestion,
    GAIAResult,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class HarnessRoute:
    harness: str
    backend: str


def normalize_harness_label(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower().replace("_", "-")
    return {
        "eliza": "eliza",
        "eliza-bridge": "eliza",
        "eliza-ts": "eliza",
        "hermes": "hermes",
        "hermes-agent": "hermes",
        "openclaw": "openclaw",
        "open-claw": "openclaw",
    }.get(normalized)


def resolve_harness(config: GAIAConfig | None = None, *, explicit: str | None = None) -> HarnessRoute:
    requested = explicit or (config.harness if config is not None else None)
    harness = normalize_harness_label(requested) or "eliza"
    if harness != "eliza":
        raise ValueError(f"GAIA does not implement native {harness} harness routing")
    return HarnessRoute(harness="eliza", backend="eliza_ts_bridge")


def harness_env_updates(route: HarnessRoute) -> dict[str, str]:
    if route.harness != "eliza":
        raise ValueError(f"GAIA does not implement native {route.harness} harness routing")
    return {
        "BENCHMARK_HARNESS": route.harness,
        "ELIZA_BENCH_HARNESS": route.harness,
        "BENCHMARK_AGENT": route.harness,
    }


class ElizaBridgeGAIAAgent:
    def __init__(self, config: GAIAConfig, route: HarnessRoute) -> None:
        self.config = config
        self.route = route
        self.model_config = ModelConfig.from_model_string(
            config.model_name,
            temperature=config.temperature,
            max_tokens=config.max_tokens,
            api_key=config.api_key or "",
            api_base=config.api_base or "",
        )
        self._client = None

    async def solve(self, question: GAIAQuestion) -> GAIAResult:
        from eliza_adapter.client import ElizaClient

        if self._client is None:
            self._client = ElizaClient()
            self._client.wait_until_ready(timeout=120)
        start = time.time()
        response = self._client.send_message(
            text=(
                "Answer the GAIA benchmark question. Return the final answer only.\n\n"
                f"Question: {question.question}"
            ),
            context={
                "benchmark": "gaia",
                "task_id": question.task_id,
                "question": question.question,
                "level": question.level.value,
                "model_name": self.config.model_name,
            },
        )
        return GAIAResult(
            task_id=question.task_id,
            level=question.level,
            question=question.question,
            predicted_answer=_extract_gaia_answer(response.text or "", response.params),
            expected_answer=question.final_answer,
            is_correct=False,
            latency_ms=(time.time() - start) * 1000,
            token_usage=_latest_telemetry_tokens(),
        )

    async def close(self) -> None:
        self._client = None


def create_gaia_agent(config: GAIAConfig, *, route: HarnessRoute | None = None) -> ElizaBridgeGAIAAgent:
    return ElizaBridgeGAIAAgent(config, route or resolve_harness(config))


def _extract_gaia_answer(text: str, params: dict[str, object]) -> str:
    for key in ("FINAL_ANSWER", "ANSWER", "BENCHMARK_ACTION"):
        value = params.get(key)
        if isinstance(value, dict):
            for field in ("answer", "final_answer", "response"):
                inner = value.get(field)
                if isinstance(inner, str) and inner.strip():
                    return inner.strip()
        elif isinstance(value, str) and value.strip():
            return value.strip()
    match = re.search(r"<final_answer>([\s\S]*?)</final_answer>", text, re.IGNORECASE)
    return match.group(1).strip() if match else text.strip()


def _latest_telemetry_tokens() -> int:
    path = os.environ.get("BENCHMARK_TELEMETRY_JSONL")
    if not path or not os.path.exists(path):
        return 0
    total = 0
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    row = json.loads(line)
                    total = int(row.get("total_tokens") or row.get("totalTokens") or total)
    except Exception:
        return total
    return total


def write_trajectory_artifacts(
    results: object,
    output_dir: Path,
    *,
    timestamp: str,
    run_kind: str,
    latest: bool = True,
) -> dict[str, str]:
    output_dir.mkdir(parents=True, exist_ok=True)
    canonical = output_dir / f"{run_kind}-trajectories-{timestamp}.jsonl"
    native = output_dir / f"{run_kind}-native-trajectories-{timestamp}.jsonl"
    rows = getattr(results, "results", [])
    with open(canonical, "w", encoding="utf-8") as handle:
        for result in rows:
            handle.write(json.dumps(_trajectory_jsonable(result), default=str) + "\n")
    with open(native, "w", encoding="utf-8") as handle:
        for result in rows:
            handle.write(json.dumps(_trajectory_jsonable(result), default=str) + "\n")
    paths = {"canonical": str(canonical), "native": str(native)}
    if latest:
        canonical_latest = output_dir / f"{run_kind}-trajectories-latest.jsonl"
        native_latest = output_dir / f"{run_kind}-native-trajectories-latest.jsonl"
        canonical_latest.write_text(canonical.read_text(encoding="utf-8"), encoding="utf-8")
        native_latest.write_text(native.read_text(encoding="utf-8"), encoding="utf-8")
        paths["canonical_latest"] = str(canonical_latest)
        paths["native_latest"] = str(native_latest)
    return paths


def _trajectory_jsonable(value: object) -> object:
    if is_dataclass(value):
        return _trajectory_jsonable(asdict(value))
    if isinstance(value, dict):
        return {str(k): _trajectory_jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_trajectory_jsonable(v) for v in value]
    if hasattr(value, "value"):
        return value.value
    if isinstance(value, Path):
        return str(value)
    return value


class MemoryTracker:
    """Track memory usage during benchmark execution."""

    def __init__(self, enabled: bool = True):
        self.enabled = enabled
        self.measurements: list[int] = []
        self._running = False
        self._task: asyncio.Task[None] | None = None

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
            return {"peak_bytes": 0, "average_bytes": 0}

        return {
            "peak_bytes": max(self.measurements),
            "average_bytes": sum(self.measurements) // len(self.measurements),
        }


class GAIARunner:
    """
    Main benchmark runner for GAIA evaluation.

    Orchestrates the complete benchmark pipeline:
    1. Load dataset from HuggingFace (or sample/jsonl)
    2. Run agent on each question via the elizaOS TS benchmark bridge
    3. Evaluate answers
    4. Calculate metrics
    5. Generate reports
    """

    def __init__(self, config: GAIAConfig):
        """
        Initialize GAIA runner.

        Args:
            config: Benchmark configuration

        Raises:
            ValueError: If config.split is not 'validation' or 'test'
        """
        if config.split not in ("validation", "test"):
            raise ValueError(f"Invalid split '{config.split}'. Must be 'validation' or 'test'")

        self.config = config

        self.dataset = GAIADataset(cache_dir=config.cache_dir)
        self.harness_route = resolve_harness(config)
        self.agent = create_gaia_agent(config, route=self.harness_route)
        self.evaluator = GAIAEvaluator()
        self.metrics_calculator = MetricsCalculator()
        self.memory_tracker = MemoryTracker(enabled=True)
        self._start_time = 0.0

    async def run_benchmark(
        self,
        hf_token: str | None = None,
    ) -> GAIABenchmarkResults:
        """
        Run the complete GAIA benchmark.

        Args:
            hf_token: Optional HuggingFace token for gated datasets

        Returns:
            GAIABenchmarkResults with all metrics and analysis
        """
        self._start_time = time.time()
        await self.memory_tracker.start()

        logger.info("=" * 60)
        logger.info(
            "GAIA Benchmark - harness=%s backend=%s",
            self.harness_route.harness,
            self.harness_route.backend,
        )
        logger.info("=" * 60)

        try:
            logger.info(
                f"Loading dataset: source={self.config.dataset_source} split={self.config.split}..."
            )
            questions = await self.dataset.load(
                split=self.config.split,
                hf_token=hf_token,
                source=self.config.dataset_source,
                dataset_path=self.config.dataset_path,
            )

            if self.config.levels:
                questions = [q for q in questions if q.level in self.config.levels]

            if self.config.max_questions:
                questions = questions[: self.config.max_questions]

            logger.info(f"Running benchmark on {len(questions)} questions")

            stats = self.dataset.get_stats(self.config.split)
            logger.info(f"Dataset stats: {json.dumps(stats['by_level'])}")

            results = await self._run_evaluation(questions)
            metrics = self.metrics_calculator.calculate(results)

            leaderboard_comparison = None
            if self.config.compare_leaderboard and self.config.dataset_source == "gaia":
                leaderboard_comparison = self.metrics_calculator.compare_with_leaderboard(metrics)
            elif self.config.compare_leaderboard and self.config.dataset_source != "gaia":
                logger.warning(
                    "Leaderboard comparison skipped (dataset_source is not 'gaia'). "
                    "Run with --dataset gaia for official GAIA/leaderboard comparison."
                )

            analysis = self.metrics_calculator.generate_analysis(metrics, leaderboard_comparison)

            memory_stats = self.memory_tracker.get_stats()
            total_duration = time.time() - self._start_time

            provider = self.harness_route.harness
            model_name = self.agent.model_config.model_name
            model_id = f"{provider}_{model_name}".replace("/", "_").replace(":", "_")
            model_provider = self.config.provider or self.agent.model_config.provider.value

            benchmark_results = GAIABenchmarkResults(
                metadata={
                    "timestamp": datetime.now().isoformat(),
                    "duration_seconds": total_duration,
                    "split": self.config.split,
                    "dataset_source": self.config.dataset_source,
                    "total_questions": len(questions),
                    "provider": provider,
                    "model_provider": model_provider,
                    "model": model_name,
                    "model_identifier": model_id,
                    "benchmark_harness": self.harness_route.harness,
                    "harness_backend": self.harness_route.backend,
                    "temperature": self.config.temperature,
                    "max_tokens": self.config.max_tokens,
                    "memory_peak_mb": memory_stats["peak_bytes"] / (1024 * 1024),
                    "memory_avg_mb": memory_stats["average_bytes"] / (1024 * 1024),
                },
                results=results,
                metrics=metrics,
                leaderboard_comparison=leaderboard_comparison,
                summary=analysis,
            )

            if self.config.generate_report:
                await self._save_results(benchmark_results)

            self._print_summary(benchmark_results)

            return benchmark_results

        except DatasetAccessError as e:
            logger.error(str(e))
            raise
        except Exception as e:
            logger.error(f"Benchmark failed: {e}")
            raise
        finally:
            await self.memory_tracker.stop()
            await self.agent.close()

    async def _run_evaluation(
        self,
        questions: list[GAIAQuestion],
    ) -> list[GAIAResult]:
        """Run agent on all questions and evaluate answers."""
        results: list[GAIAResult] = []

        for i, question in enumerate(questions):
            logger.info(
                f"\n[{i+1}/{len(questions)}] "
                f"Question {question.task_id} (Level {question.level.value})"
            )

            try:
                result = await asyncio.wait_for(
                    self.agent.solve(question),
                    timeout=self.config.timeout_per_question_ms / 1000,
                )

                is_correct, norm_pred, norm_exp = self.evaluator.evaluate(
                    result.predicted_answer,
                    question.final_answer,
                )

                result.is_correct = is_correct
                result.normalized_predicted = norm_pred
                result.normalized_expected = norm_exp

                status = "PASS" if is_correct else "FAIL"
                logger.info(f"{status} Answer: '{result.predicted_answer}'")
                if not is_correct:
                    logger.info(f"  Expected: '{question.final_answer}'")

            except TimeoutError:
                logger.warning(f"Question {question.task_id} timed out")
                result = GAIAResult(
                    task_id=question.task_id,
                    level=question.level,
                    question=question.question,
                    predicted_answer="",
                    expected_answer=question.final_answer,
                    is_correct=False,
                    error="Timeout",
                )
            except Exception as e:
                logger.error(f"Error on question {question.task_id}: {e}")
                result = GAIAResult(
                    task_id=question.task_id,
                    level=question.level,
                    question=question.question,
                    predicted_answer="",
                    expected_answer=question.final_answer,
                    is_correct=False,
                    error=str(e),
                )

            results.append(result)

            correct_so_far = sum(1 for r in results if r.is_correct)
            logger.info(
                f"Running accuracy: {correct_so_far}/{len(results)} "
                f"({correct_so_far/len(results)*100:.1f}%)"
            )

        return results

    async def _save_results(self, results: GAIABenchmarkResults) -> None:
        """Save benchmark results to files.

        Results are saved with model identifier in the filename to prevent
        overwriting results from different models.
        """
        output_dir = Path(self.config.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        model_id = str(results.metadata.get("model_identifier", "unknown"))
        dataset_source = str(results.metadata.get("dataset_source", "gaia"))
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        if self.config.include_model_in_output:
            model_dir = output_dir / dataset_source / model_id
            model_dir.mkdir(parents=True, exist_ok=True)

            results_path = model_dir / f"gaia-results_{timestamp}.json"
            details_path = model_dir / f"gaia-detailed-results_{timestamp}.jsonl"
            report_path = model_dir / f"BENCHMARK_RESULTS_{timestamp}.md"

            latest_results_path = model_dir / "gaia-results-latest.json"
            latest_report_path = model_dir / "BENCHMARK_RESULTS.md"
        else:
            results_path = output_dir / "gaia-results.json"
            details_path = output_dir / "gaia-detailed-results.jsonl"
            report_path = output_dir / "BENCHMARK_RESULTS.md"
            latest_results_path = None
            latest_report_path = None

        with open(results_path, "w") as f:
            json.dump(self._to_serializable(results), f, indent=2, default=str)
        logger.info(f"Saved results to {results_path}")

        if latest_results_path:
            with open(latest_results_path, "w") as f:
                json.dump(self._to_serializable(results), f, indent=2, default=str)

        if self.config.save_detailed_logs:
            with open(details_path, "w") as f:
                for result in results.results:
                    f.write(json.dumps(self._to_serializable(result), default=str) + "\n")
            logger.info(f"Saved detailed results to {details_path}")

        if self.config.save_trajectories:
            trajectory_paths = write_trajectory_artifacts(
                results,
                model_dir if self.config.include_model_in_output else output_dir,
                timestamp=timestamp,
                run_kind="gaia",
                latest=self.config.include_model_in_output,
            )
            logger.info(
                "Saved trajectory artifacts: canonical=%s native=%s",
                trajectory_paths["canonical"],
                trajectory_paths["native"],
            )

        markdown = self._generate_markdown_report(results)
        with open(report_path, "w") as f:
            f.write(markdown)
        logger.info(f"Saved report to {report_path}")

        if latest_report_path:
            with open(latest_report_path, "w") as f:
                f.write(markdown)

        await self._update_comparison_index(output_dir / dataset_source, results)

    async def _update_comparison_index(
        self,
        output_dir: Path,
        results: GAIABenchmarkResults,
    ) -> None:
        """Update the model comparison index with latest results."""
        index_path = output_dir / "MODEL_COMPARISON.md"
        data_path = output_dir / "model_comparison.json"

        comparison_data: dict[str, object] = {}
        if data_path.exists():
            try:
                with open(data_path) as f:
                    comparison_data = json.load(f)
            except (json.JSONDecodeError, OSError):
                comparison_data = {}

        model_id = str(results.metadata.get("model_identifier", "unknown"))
        metrics = results.metrics

        current_stats: dict[str, object] = {
            "provider": str(results.metadata.get("provider", "unknown")),
            "model": str(results.metadata.get("model", model_id)),
            "timestamp": str(results.metadata.get("timestamp", "")),
            "overall_accuracy": metrics.overall_accuracy,
            "level_1_accuracy": metrics.level_accuracy.get(GAIALevel.LEVEL_1, 0),
            "level_2_accuracy": metrics.level_accuracy.get(GAIALevel.LEVEL_2, 0),
            "level_3_accuracy": metrics.level_accuracy.get(GAIALevel.LEVEL_3, 0),
            "total_questions": metrics.total_questions,
            "correct_answers": metrics.correct_answers,
            "errors": metrics.errors,
            "avg_latency_ms": metrics.avg_latency_ms,
            "total_tokens": metrics.total_tokens,
        }

        def _as_float(value: object, default: float = 0.0) -> float:
            if isinstance(value, bool):
                return default
            if isinstance(value, (int, float)):
                return float(value)
            if isinstance(value, str):
                try:
                    return float(value)
                except ValueError:
                    return default
            return default

        def _as_int(value: object, default: int = 0) -> int:
            if isinstance(value, bool):
                return default
            if isinstance(value, int):
                return value
            if isinstance(value, float):
                return int(value)
            if isinstance(value, str):
                try:
                    return int(float(value))
                except ValueError:
                    return default
            return default

        def _is_better(a: dict[str, object], b: dict[str, object]) -> bool:
            a_acc = _as_float(a.get("overall_accuracy"), 0.0)
            b_acc = _as_float(b.get("overall_accuracy"), 0.0)
            if a_acc != b_acc:
                return a_acc > b_acc

            a_q = _as_int(a.get("total_questions"), 0)
            b_q = _as_int(b.get("total_questions"), 0)
            if a_q != b_q:
                return a_q > b_q

            a_err = _as_int(a.get("errors"), 0)
            b_err = _as_int(b.get("errors"), 0)
            if a_err != b_err:
                return a_err < b_err

            a_lat = _as_float(a.get("avg_latency_ms"), 0.0)
            b_lat = _as_float(b.get("avg_latency_ms"), 0.0)
            if a_lat != b_lat:
                return a_lat < b_lat

            return False

        existing = comparison_data.get(model_id)
        best_stats: dict[str, object] | None = None

        if isinstance(existing, dict):
            existing_best = existing.get("best")
            existing_latest = existing.get("latest")
            if isinstance(existing_best, dict) and isinstance(existing_latest, dict):
                best_stats = dict(existing_best)
            else:
                best_stats = dict(existing)
        else:
            best_stats = None

        if best_stats is None:
            best_stats = dict(current_stats)
        elif _is_better(current_stats, best_stats):
            best_stats = dict(current_stats)

        comparison_data[model_id] = {
            "provider": str(current_stats.get("provider", "unknown")),
            "model": str(current_stats.get("model", model_id)),
            "best": best_stats,
            "latest": current_stats,
        }

        with open(data_path, "w") as f:
            json.dump(comparison_data, f, indent=2)

        dataset_source = output_dir.name
        md = f"""# GAIA Benchmark - Model Comparison

**Dataset:** `{dataset_source}`

This table compares results across all tested models for this dataset. Results are sorted by overall accuracy.

## Best per model

| Provider | Model | Overall | Level 1 | Level 2 | Level 3 | Questions | Errors | Tokens | Latency (s) |
|----------|-------|---------|---------|---------|---------|-----------|--------|--------|-------------|
"""

        def _get_best(entry: object) -> dict[str, object]:
            if isinstance(entry, dict):
                best = entry.get("best")
                if isinstance(best, dict):
                    return best
                return entry
            return {}

        def _get_latest(entry: object) -> dict[str, object]:
            if isinstance(entry, dict):
                latest = entry.get("latest")
                if isinstance(latest, dict):
                    return latest
                return entry
            return {}

        sortable: list[tuple[str, dict[str, object], dict[str, object], dict[str, object]]] = []
        for mid, entry in comparison_data.items():
            if not isinstance(mid, str):
                continue
            container = entry if isinstance(entry, dict) else {}
            best = _get_best(container)
            latest = _get_latest(container)
            sortable.append((mid, container, best, latest))

        sortable.sort(
            key=lambda item: (
                _as_float(item[2].get("overall_accuracy"), 0.0),
                _as_int(item[2].get("total_questions"), 0),
            ),
            reverse=True,
        )

        for mid, container, best, _latest in sortable:
            provider = str(container.get("provider", best.get("provider", "?")))
            model = str(container.get("model", best.get("model", mid)))
            overall = _as_float(best.get("overall_accuracy"), 0.0)
            l1 = _as_float(best.get("level_1_accuracy"), 0.0)
            l2 = _as_float(best.get("level_2_accuracy"), 0.0)
            l3 = _as_float(best.get("level_3_accuracy"), 0.0)
            questions = _as_int(best.get("total_questions"), 0)
            errors = _as_int(best.get("errors"), 0)
            tokens = _as_int(best.get("total_tokens"), 0)
            latency = _as_float(best.get("avg_latency_ms"), 0.0) / 1000

            md += (
                f"| {provider} | {model} | {overall:.1%} | {l1:.1%} | {l2:.1%} | "
                f"{l3:.1%} | {questions} | {errors} | {tokens:,} | {latency:.1f} |\n"
            )

        md += """

## Latest run per model

| Provider | Model | Overall | Questions | Errors | Tokens | Latency (s) | Timestamp |
|----------|-------|---------|-----------|--------|--------|-------------|-----------|
"""

        for mid, container, _best, latest in sortable:
            provider = str(container.get("provider", latest.get("provider", "?")))
            model = str(container.get("model", latest.get("model", mid)))
            overall = _as_float(latest.get("overall_accuracy"), 0.0)
            questions = _as_int(latest.get("total_questions"), 0)
            errors = _as_int(latest.get("errors"), 0)
            tokens = _as_int(latest.get("total_tokens"), 0)
            latency = _as_float(latest.get("avg_latency_ms"), 0.0) / 1000
            ts = str(latest.get("timestamp", ""))

            md += (
                f"| {provider} | {model} | {overall:.1%} | {questions} | {errors} | "
                f"{tokens:,} | {latency:.1f} | {ts} |\n"
            )

        if dataset_source == "gaia":
            md += """
## Reference Scores (Official GAIA)

| System | Overall | Level 1 | Level 2 | Level 3 |
|--------|---------|---------|---------|---------|
| Human Performance | 92% | 95% | 92% | 88% |
| h2oGPTe Agent (best AI) | 65% | 75% | 62% | 48% |
| GPT-4 + Plugins | 15% | 25% | 12% | 5% |
"""
        else:
            md += """
## Notes

- This comparison is for a **non-official dataset source** (e.g. sample/jsonl).
- Official GAIA leaderboard scores are **not comparable** unless `--dataset gaia` is used.
"""

        md += """

---
*Updated automatically by the elizaOS GAIA Benchmark Runner*
"""

        with open(index_path, "w") as f:
            f.write(md)

        logger.info(f"Updated model comparison at {index_path}")

    def _to_serializable(self, obj) -> dict | list | str | int | float | bool | None:
        """Convert dataclass/enum to JSON-serializable dict."""
        if hasattr(obj, "__dataclass_fields__"):
            return {k: self._to_serializable(v) for k, v in asdict(obj).items()}
        elif isinstance(obj, dict):
            return {str(k): self._to_serializable(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [self._to_serializable(item) for item in obj]
        elif hasattr(obj, "value"):
            return obj.value
        elif isinstance(obj, Path):
            return str(obj)
        else:
            return obj

    def _generate_markdown_report(self, results: GAIABenchmarkResults) -> str:
        """Generate a comprehensive markdown report."""
        metrics = results.metrics
        comparison = results.leaderboard_comparison
        summary = results.summary
        metadata = results.metadata

        md = f"""# GAIA Benchmark Results - elizaOS TS bridge

**Generated:** {metadata.get('timestamp', 'N/A')}

## Executive Summary

| Metric | Value |
|--------|-------|
| **Overall Accuracy** | {metrics.overall_accuracy:.1%} |
| **Total Questions** | {metrics.total_questions} |
| **Correct Answers** | {metrics.correct_answers} |
| **Human Baseline** | 92% |
| **Best AI (h2oGPTe)** | 65% |

## Results by Level

| Level | Questions | Correct | Accuracy |
|-------|-----------|---------|----------|
"""
        for level in GAIALevel:
            count = metrics.level_counts.get(level, 0)
            correct = metrics.level_correct.get(level, 0)
            acc = metrics.level_accuracy.get(level, 0)
            md += f"| Level {level.value} | {count} | {correct} | {acc:.1%} |\n"

        md += f"""
## Performance Metrics

- **Average Latency:** {metrics.avg_latency_ms/1000:.1f} seconds
- **Average Steps:** {metrics.avg_steps:.1f} per question
- **Average Tools Used:** {metrics.avg_tools_per_question:.1f} per question
- **Total Tokens:** {metrics.total_tokens:,}
- **Average Tokens:** {metrics.avg_tokens_per_question:.0f} per question
- **Error Rate:** {metrics.error_rate:.1%}
"""

        if metrics.tool_usage:
            md += "\n## Tool Usage\n\n| Tool | Uses | Success Rate |\n|------|------|-------------|\n"
            for tool in sorted(metrics.tool_usage.keys(), key=lambda t: metrics.tool_usage.get(t, 0), reverse=True):
                uses = metrics.tool_usage.get(tool, 0)
                success = metrics.tool_success_rate.get(tool, 0)
                md += f"| {tool.value if hasattr(tool, 'value') else tool} | {uses} | {success:.1%} |\n"

        if comparison:
            md += f"""
## Leaderboard Comparison

**Rank:** #{comparison.rank} of {comparison.total_entries} entries
**Percentile:** {comparison.percentile:.0f}th

| System | Level 1 | Level 2 | Level 3 | Overall |
|--------|---------|---------|---------|---------|
"""
            sorted_entries = sorted(
                comparison.comparison.items(),
                key=lambda x: x[1].get("overall", 0),
                reverse=True,
            )

            for name, scores in sorted_entries:
                l1 = scores.get("level_1", 0)
                l2 = scores.get("level_2", 0)
                l3 = scores.get("level_3", 0)
                overall = scores.get("overall", 0)

                if name == "ElizaOS Agent":
                    name = f"**{name}**"

                md += f"| {name} | {l1:.1%} | {l2:.1%} | {l3:.1%} | {overall:.1%} |\n"

        if summary:
            md += "\n## Analysis\n\n### Key Findings\n"
            for finding in summary.get("key_findings", []):
                md += f"- {finding}\n"

            md += "\n### Strengths\n"
            for strength in summary.get("strengths", []):
                md += f"- {strength}\n"

            md += "\n### Areas for Improvement\n"
            for weakness in summary.get("weaknesses", []):
                md += f"- {weakness}\n"

            md += "\n### Recommendations\n"
            for rec in summary.get("recommendations", []):
                md += f"- {rec}\n"

        if metrics.error_categories:
            md += "\n## Error Analysis\n\n| Category | Count |\n|----------|-------|\n"
            for category, count in sorted(metrics.error_categories.items(), key=lambda x: x[1], reverse=True):
                md += f"| {category} | {count} |\n"

        md += f"""
## Configuration

- **Dataset Source:** {metadata.get('dataset_source', 'gaia')}
- **Provider:** {metadata.get('provider', 'N/A')}
- **Model:** {metadata.get('model', 'N/A')}
- **Temperature:** {metadata.get('temperature', 'N/A')}
- **Max Tokens:** {metadata.get('max_tokens', 'N/A')}
- **Split:** {metadata.get('split', 'N/A')}
- **Duration:** {metadata.get('duration_seconds', 0):.0f} seconds
- **Peak Memory:** {metadata.get('memory_peak_mb', 0):.1f} MB

---
*Generated by the elizaOS GAIA Benchmark Runner*
"""
        return md

    def _print_summary(self, results: GAIABenchmarkResults) -> None:
        """Print summary to console."""
        metrics = results.metrics

        print("\n" + "=" * 60)
        print("GAIA Benchmark - Final Results")
        print("=" * 60)
        print(f"\nOverall Accuracy: {metrics.overall_accuracy:.1%}")
        print(f"Total Questions: {metrics.total_questions}")
        print(f"Correct: {metrics.correct_answers}")
        print(f"Errors: {metrics.errors}")

        print("\nBy Level:")
        for level in GAIALevel:
            acc = metrics.level_accuracy.get(level, 0)
            count = metrics.level_counts.get(level, 0)
            print(f"  Level {level.value}: {acc:.1%} ({count} questions)")

        if results.leaderboard_comparison:
            print(f"\nLeaderboard Rank: #{results.leaderboard_comparison.rank}")
            print(f"Percentile: {results.leaderboard_comparison.percentile:.0f}th")

        print("\n" + "=" * 60)


async def run_quick_test(
    config: GAIAConfig | None = None,
    num_questions: int = 5,
    hf_token: str | None = None,
) -> GAIABenchmarkResults:
    """
    Run a quick test with a few questions.

    Args:
        config: Optional configuration (defaults will be used)
        num_questions: Number of questions to test

    Returns:
        Benchmark results
    """
    if config is None:
        config = GAIAConfig(
            max_questions=num_questions,
            output_dir="./benchmark_results/gaia_quick_test",
        )
    else:
        config.max_questions = num_questions

    runner = GAIARunner(config)
    try:
        return await runner.run_benchmark(hf_token=hf_token)
    except DatasetAccessError as e:
        if config.dataset_source == "gaia" and e.is_gated:
            logger.warning(
                "GAIA dataset is gated; running built-in sample dataset for quick test instead. "
                "Set HF_TOKEN (and request access) to run the official GAIA benchmark."
            )
            config.dataset_source = "sample"
            runner = GAIARunner(config)
            return await runner.run_benchmark(hf_token=hf_token)
        raise
