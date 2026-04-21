"""
GAIA Benchmark Runner

Orchestrates the complete benchmark execution including dataset loading,
agent execution, evaluation, and report generation.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import tracemalloc
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime

from elizaos_gaia.agent import GAIAAgent
from elizaos_gaia.dataset import DatasetAccessError, GAIADataset
from elizaos_gaia.evaluator import GAIAEvaluator
from elizaos_gaia.metrics import MetricsCalculator
from elizaos_gaia.types import (
    GAIABenchmarkResults,
    GAIAConfig,
    GAIALevel,
    GAIAQuestion,
    GAIAResult,
)

logger = logging.getLogger(__name__)


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
    1. Load dataset from HuggingFace
    2. Run agent on each question
    3. Evaluate answers
    4. Calculate metrics
    5. Generate reports
    """

    def __init__(
        self,
        config: GAIAConfig,
        runtime: AgentRuntime | None = None,
    ):
        """
        Initialize GAIA runner.

        Args:
            config: Benchmark configuration
            runtime: Optional ElizaOS runtime for LLM access

        Raises:
            ValueError: If config.split is not 'validation' or 'test'
        """
        # Validate config
        if config.split not in ("validation", "test"):
            raise ValueError(f"Invalid split '{config.split}'. Must be 'validation' or 'test'")

        self.config = config
        self.runtime = runtime
        self._runtime_initialized = False

        # If requested and no runtime was provided, build a canonical Eliza runtime.
        if self.runtime is None and self.config.use_eliza_runtime:
            from elizaos.runtime import AgentRuntime as _AgentRuntime
            from elizaos.types.agent import Character
            from elizaos.prompts import MESSAGE_HANDLER_TEMPLATE

            from elizaos_gaia.inmemory_adapter import InMemoryBenchmarkAdapter
            from elizaos_gaia.plugin import gaia_plugin

            # Minimal character for benchmarking. The canonical MESSAGE_HANDLER_TEMPLATE
            # enforces XML response format; we add GAIA-specific requirements here.
            system = (
                "You are an ElizaOS agent running the GAIA benchmark.\n"
                "This is an evaluation harness: do NOT chit-chat, do NOT ask 'why are you curious', and do NOT roleplay.\n"
                "Your job is to solve the user's task using the available actions when needed.\n"
                "When you are ready to answer, put the final answer in your <text> as:\n"
                "FINAL ANSWER: <answer>\n"
                "Keep the final answer concise and do not include extra explanation in the final answer line."
            )

            # Tighten message handler rules for benchmark determinism and correct tool params.
            benchmark_instructions = (
                "\n\nGAIA BENCHMARK RULES:\n"
                "- When you provide the answer, your <text> MUST start with 'FINAL ANSWER:' and contain ONLY the answer.\n"
                "- If you select an action with required parameters, you MUST include a <params> block with ALL required params.\n"
                "- For CALCULATE <expression>, use pure math only (no units like km/h). Use '**' for exponentiation.\n"
                "- For WEB_SEARCH <query>, always provide a clear natural-language query string.\n"
                "- For EXECUTE_CODE <code>, provide valid Python code as a string.\n"
            )
            message_handler_template = MESSAGE_HANDLER_TEMPLATE.replace(
                "</instructions>",
                benchmark_instructions + "\n</instructions>",
            )

            character = Character(
                name="GAIABenchmarkAgent",
                bio="GAIA benchmark agent",
                system=system,
                templates={"messageHandlerTemplate": message_handler_template},
            )

            adapter = InMemoryBenchmarkAdapter()
            self.runtime = _AgentRuntime(
                character=character,
                adapter=adapter,
                plugins=[gaia_plugin],
                disable_basic_capabilities=False,
                enable_autonomy=False,
                log_level="ERROR",
            )

            # Configure model selection on the runtime for the model handler to use
            if self.config.provider:
                self.runtime.set_setting("GAIA_PROVIDER", self.config.provider)
            if self.config.model_name:
                self.runtime.set_setting("GAIA_MODEL", self.config.model_name)
            self.runtime.set_setting("GAIA_TEMPERATURE", self.config.temperature)
            self.runtime.set_setting("GAIA_MAX_TOKENS", self.config.max_tokens)
        self.dataset = GAIADataset(cache_dir=config.cache_dir)
        self.agent = GAIAAgent(config, self.runtime)
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
        logger.info("GAIA Benchmark - ElizaOS Python")
        logger.info("=" * 60)

        try:
            # Initialize runtime/plugins once (canonical Eliza agent mode)
            if self.runtime is not None and self.config.use_eliza_runtime and not self._runtime_initialized:
                await self.runtime.initialize()
                self._runtime_initialized = True

            # Load dataset
            logger.info(
                f"Loading dataset: source={self.config.dataset_source} split={self.config.split}..."
            )
            questions = await self.dataset.load(
                split=self.config.split,
                hf_token=hf_token,
                source=self.config.dataset_source,
                dataset_path=self.config.dataset_path,
            )

            # Filter by level if specified
            if self.config.levels:
                questions = [
                    q for q in questions
                    if q.level in self.config.levels
                ]

            # Limit number of questions if specified
            if self.config.max_questions:
                questions = questions[:self.config.max_questions]

            logger.info(f"Running benchmark on {len(questions)} questions")

            # Print dataset stats
            stats = self.dataset.get_stats(self.config.split)
            logger.info(f"Dataset stats: {json.dumps(stats['by_level'])}")

            # Run evaluation
            results = await self._run_evaluation(questions)

            # Calculate metrics
            metrics = self.metrics_calculator.calculate(results)

            # Compare with leaderboard
            leaderboard_comparison = None
            if self.config.compare_leaderboard and self.config.dataset_source == "gaia":
                leaderboard_comparison = self.metrics_calculator.compare_with_leaderboard(
                    metrics
                )
            elif self.config.compare_leaderboard and self.config.dataset_source != "gaia":
                logger.warning(
                    "Leaderboard comparison skipped (dataset_source is not 'gaia'). "
                    "Run with --dataset gaia for official GAIA/leaderboard comparison."
                )

            # Generate analysis
            analysis = self.metrics_calculator.generate_analysis(
                metrics,
                leaderboard_comparison,
            )

            # Build final results
            memory_stats = self.memory_tracker.get_stats()
            total_duration = time.time() - self._start_time

            # Get model identifier for output naming
            model_id = self.agent.model_identifier
            provider = self.agent.model_config.provider.value
            model_name = self.agent.model_config.model_name

            benchmark_results = GAIABenchmarkResults(
                metadata={
                    "timestamp": datetime.now().isoformat(),
                    "duration_seconds": total_duration,
                    "split": self.config.split,
                    "dataset_source": self.config.dataset_source,
                    "total_questions": len(questions),
                    # Full model info
                    "provider": provider,
                    "model": model_name,
                    "model_identifier": model_id,
                    "temperature": self.config.temperature,
                    "max_tokens": self.config.max_tokens,
                    # Memory stats
                    "memory_peak_mb": memory_stats["peak_bytes"] / (1024 * 1024),
                    "memory_avg_mb": memory_stats["average_bytes"] / (1024 * 1024),
                },
                results=results,
                metrics=metrics,
                leaderboard_comparison=leaderboard_comparison,
                summary=analysis,
            )

            # Save results
            if self.config.generate_report:
                await self._save_results(benchmark_results)

            # Print summary
            self._print_summary(benchmark_results)

            return benchmark_results

        except DatasetAccessError as e:
            # Provide a crisp error message (and allow sample fallback via config if desired)
            logger.error(str(e))
            raise
        except Exception as e:
            logger.error(f"Benchmark failed: {e}")
            raise
        finally:
            await self.memory_tracker.stop()
            await self.agent.close()
            if self.config.use_eliza_runtime:
                try:
                    from elizaos_gaia.plugin import close_gaia_plugin_tools

                    await close_gaia_plugin_tools()
                except Exception:
                    # Never fail benchmark teardown due to cleanup
                    pass

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
                # Set timeout for the question
                result = await asyncio.wait_for(
                    self.agent.solve(question),
                    timeout=self.config.timeout_per_question_ms / 1000,
                )

                # Evaluate the answer
                is_correct, norm_pred, norm_exp = self.evaluator.evaluate(
                    result.predicted_answer,
                    question.final_answer,
                )

                result.is_correct = is_correct
                result.normalized_predicted = norm_pred
                result.normalized_expected = norm_exp

                # Log result
                status = "✓" if is_correct else "✗"
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

            # Log running accuracy
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

        # Get model identifier for unique filenames
        model_id = str(results.metadata.get("model_identifier", "unknown"))
        dataset_source = str(results.metadata.get("dataset_source", "gaia"))
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        # Determine file naming based on config
        if self.config.include_model_in_output:
            # Create model-specific subdirectory
            model_dir = output_dir / dataset_source / model_id
            model_dir.mkdir(parents=True, exist_ok=True)

            # Save with timestamp to preserve history
            results_path = model_dir / f"gaia-results_{timestamp}.json"
            details_path = model_dir / f"gaia-detailed-results_{timestamp}.jsonl"
            report_path = model_dir / f"BENCHMARK_RESULTS_{timestamp}.md"

            # Also save latest version for easy access
            latest_results_path = model_dir / "gaia-results-latest.json"
            latest_report_path = model_dir / "BENCHMARK_RESULTS.md"
        else:
            # Legacy mode - overwrite
            results_path = output_dir / "gaia-results.json"
            details_path = output_dir / "gaia-detailed-results.jsonl"
            report_path = output_dir / "BENCHMARK_RESULTS.md"
            latest_results_path = None
            latest_report_path = None

        # Save detailed JSON results
        with open(results_path, "w") as f:
            json.dump(self._to_serializable(results), f, indent=2, default=str)
        logger.info(f"Saved results to {results_path}")

        # Save latest version
        if latest_results_path:
            with open(latest_results_path, "w") as f:
                json.dump(self._to_serializable(results), f, indent=2, default=str)

        # Save individual results
        if self.config.save_detailed_logs:
            with open(details_path, "w") as f:
                for result in results.results:
                    f.write(json.dumps(self._to_serializable(result), default=str) + "\n")
            logger.info(f"Saved detailed results to {details_path}")

        # Generate markdown report
        markdown = self._generate_markdown_report(results)
        with open(report_path, "w") as f:
            f.write(markdown)
        logger.info(f"Saved report to {report_path}")

        # Save latest report
        if latest_report_path:
            with open(latest_report_path, "w") as f:
                f.write(markdown)

        # Update comparison index
        await self._update_comparison_index(output_dir / dataset_source, results)

    async def _update_comparison_index(
        self,
        output_dir: Path,
        results: GAIABenchmarkResults,
    ) -> None:
        """Update the model comparison index with latest results.

        Creates/updates a comparison table across all tested models.
        """
        index_path = output_dir / "MODEL_COMPARISON.md"
        data_path = output_dir / "model_comparison.json"

        # Load existing comparison data
        comparison_data: dict[str, object] = {}
        if data_path.exists():
            try:
                with open(data_path) as f:
                    comparison_data = json.load(f)
            except (json.JSONDecodeError, OSError):
                comparison_data = {}

        # Add current results
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
            """Return True if a should replace b as the best run."""
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

        # Upgrade legacy data and keep both best + latest (do NOT overwrite best)
        existing = comparison_data.get(model_id)
        best_stats: dict[str, object] | None = None

        if isinstance(existing, dict):
            existing_best = existing.get("best")
            existing_latest = existing.get("latest")
            if isinstance(existing_best, dict) and isinstance(existing_latest, dict):
                best_stats = dict(existing_best)
            else:
                # Legacy single-record format: treat as both best and latest
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

        # Save updated data
        with open(data_path, "w") as f:
            json.dump(comparison_data, f, indent=2)

        # Generate comparison markdown
        dataset_source = output_dir.name
        md = f"""# GAIA Benchmark - Model Comparison

**Dataset:** `{dataset_source}`

This table compares results across all tested models for this dataset. Results are sorted by overall accuracy.

## Best per model

| Provider | Model | Overall | Level 1 | Level 2 | Level 3 | Questions | Errors | Tokens | Latency (s) |
|----------|-------|---------|---------|---------|---------|-----------|--------|--------|-------------|
"""

        # Normalize + sort by best overall accuracy (then by best question count)
        def _get_best(entry: object) -> dict[str, object]:
            if isinstance(entry, dict):
                best = entry.get("best")
                if isinstance(best, dict):
                    return best
                # Legacy fallback
                return entry
            return {}

        def _get_latest(entry: object) -> dict[str, object]:
            if isinstance(entry, dict):
                latest = entry.get("latest")
                if isinstance(latest, dict):
                    return latest
                # Legacy fallback
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

        # Latest table: show what happened most recently for each model id
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
*Updated automatically by ElizaOS GAIA Benchmark Runner*
"""

        with open(index_path, "w") as f:
            f.write(md)

        logger.info(f"Updated model comparison at {index_path}")

    def _to_serializable(self, obj) -> dict | list | str | int | float | bool | None:
        """Convert dataclass/enum to JSON-serializable dict."""
        if hasattr(obj, "__dataclass_fields__"):
            return {
                k: self._to_serializable(v)
                for k, v in asdict(obj).items()
            }
        elif isinstance(obj, dict):
            return {
                str(k): self._to_serializable(v)
                for k, v in obj.items()
            }
        elif isinstance(obj, list):
            return [self._to_serializable(item) for item in obj]
        elif hasattr(obj, "value"):  # Enum
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

        md = f"""# GAIA Benchmark Results - ElizaOS Python

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
            # Sort by overall score
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

                # Highlight our entry
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
*Generated by ElizaOS GAIA Benchmark Runner*
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
        # If GAIA is gated, fall back to sample dataset for E2E validation.
        if config.dataset_source == "gaia" and e.is_gated:
            logger.warning(
                "GAIA dataset is gated; running built-in sample dataset for quick test instead. "
                "Set HF_TOKEN (and request access) to run the official GAIA benchmark."
            )
            config.dataset_source = "sample"
            runner = GAIARunner(config)
            return await runner.run_benchmark(hf_token=hf_token)
        raise
