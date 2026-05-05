"""
Reporting for RLM benchmark results.

Generates reports in various formats following the paper's presentation style.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import TextIO

from .types import (
    PAPER_OOLONG_SCORES,
    PAPER_S_NIAH_SCORES,
    RLMBenchMetrics,
    RLMBenchResults,
    RLMBenchType,
    RLMStrategy,
)

logger = logging.getLogger("elizaos.rlm-bench")


def save_results(results: RLMBenchResults, output_dir: str) -> str:
    """
    Save benchmark results to files.

    Args:
        results: The benchmark results
        output_dir: Directory to save results

    Returns:
        Path to the main results file
    """
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    # Save JSON results
    json_path = os.path.join(output_dir, f"rlm_bench_results_{timestamp}.json")
    with open(json_path, "w") as f:
        json.dump(_results_to_dict(results), f, indent=2, default=str)

    # Save markdown report
    md_path = os.path.join(output_dir, f"rlm_bench_report_{timestamp}.md")
    with open(md_path, "w") as f:
        RLMBenchReporter(results).write_markdown_report(f)

    logger.info(f"Results saved to {json_path}")
    logger.info(f"Report saved to {md_path}")

    return json_path


def _results_to_dict(results: RLMBenchResults) -> dict:
    """Convert results to dictionary for JSON serialization."""
    return {
        "config": {
            "output_dir": results.config.output_dir,
            "context_lengths": results.config.context_lengths,
            "rlm_backend": results.config.rlm_backend,
            "use_dual_model": results.config.use_dual_model,
        },
        "metrics": {
            "total_tasks": results.metrics.total_tasks,
            "passed_tasks": results.metrics.passed_tasks,
            "overall_accuracy": results.metrics.overall_accuracy,
            "avg_semantic_similarity": results.metrics.avg_semantic_similarity,
            "type_accuracies": {
                k.value: v for k, v in results.metrics.type_accuracies.items()
            },
            "length_accuracies": results.metrics.length_accuracies,
            "s_niah_by_length": results.metrics.s_niah_by_length,
            "oolong_accuracy": results.metrics.oolong_accuracy,
            "oolong_pairs_accuracy": results.metrics.oolong_pairs_accuracy,
            "total_cost_usd": results.metrics.total_cost_usd,
            "avg_latency_ms": results.metrics.avg_latency_ms,
            "avg_iterations": results.metrics.avg_iterations,
        },
        "results": [
            {
                "task_id": r.task_id,
                "bench_type": r.bench_type.value,
                "context_length": r.context_length_tokens,
                "is_correct": r.is_correct,
                "semantic_similarity": r.semantic_similarity,
                "iterations": r.iterations,
                "strategies_used": r.strategies_used,
                "cost_usd": r.cost_usd,
                "latency_ms": r.latency_ms,
                "error": r.error,
            }
            for r in results.results
        ],
        "paper_comparison": results.paper_comparison,
        "cost_analysis": results.cost_analysis,
        "summary": results.summary,
        "metadata": results.metadata,
    }


class RLMBenchReporter:
    """Reporter for generating benchmark reports."""

    def __init__(self, results: RLMBenchResults) -> None:
        """Initialize with results."""
        self.results = results
        self.metrics = results.metrics

    def write_markdown_report(self, f: TextIO) -> None:
        """Write a markdown report to the given file."""
        f.write("# RLM Benchmark Report\n\n")
        f.write(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n")

        self._write_summary(f)
        self._write_s_niah_table(f)
        self._write_oolong_table(f)
        self._write_strategy_analysis(f)
        self._write_cost_analysis(f)
        self._write_paper_comparison(f)

    def _write_summary(self, f: TextIO) -> None:
        """Write summary section."""
        f.write("## Summary\n\n")

        summary = self.results.summary
        if isinstance(summary.get("findings"), list):
            for finding in summary["findings"]:
                f.write(f"- {finding}\n")
        f.write("\n")

        # Key metrics table
        f.write("### Key Metrics\n\n")
        f.write("| Metric | Value |\n")
        f.write("|--------|-------|\n")
        f.write(f"| Total Tasks | {self.metrics.total_tasks} |\n")
        f.write(f"| Passed | {self.metrics.passed_tasks} |\n")
        f.write(f"| Overall Accuracy | {self.metrics.overall_accuracy:.1%} |\n")
        f.write(f"| Avg Semantic Similarity | {self.metrics.avg_semantic_similarity:.3f} |\n")
        f.write(f"| Total Cost (USD) | ${self.metrics.total_cost_usd:.4f} |\n")
        f.write(f"| Avg Latency (ms) | {self.metrics.avg_latency_ms:.1f} |\n")
        f.write(f"| Avg Iterations | {self.metrics.avg_iterations:.1f} |\n")
        f.write(f"| Avg Depth | {self.metrics.avg_depth:.1f} |\n")
        f.write("\n")

    def _write_s_niah_table(self, f: TextIO) -> None:
        """Write S-NIAH results table (Paper Table 1 format)."""
        if not self.metrics.s_niah_by_length:
            return

        f.write("## S-NIAH Results (Paper Table 1)\n\n")
        f.write("Accuracy by context length:\n\n")

        # Build table header
        lengths = ["1K", "10K", "100K", "1M", "10M", "100M"]
        f.write("| Model | " + " | ".join(lengths) + " |\n")
        f.write("|-------|" + "|".join(["-------"] * len(lengths)) + "|\n")

        # This run
        this_run = self.metrics.s_niah_by_length
        row = "| This Run |"
        for length in lengths:
            val = this_run.get(length, 0.0)
            row += f" {val:.1%} |" if val > 0 else " - |"
        f.write(row + "\n")

        # Paper baselines
        for model, scores in PAPER_S_NIAH_SCORES.items():
            row = f"| {model} |"
            for length in lengths:
                key = length.lower()
                val = scores.get(key, 0.0)
                row += f" {val:.1%} |" if val > 0 else " - |"
            f.write(row + "\n")

        f.write("\n")

    def _write_oolong_table(self, f: TextIO) -> None:
        """Write OOLONG results table (Paper Table 2 format)."""
        if self.metrics.oolong_accuracy == 0:
            return

        f.write("## OOLONG Results (Paper Table 2)\n\n")

        f.write("| Model | Retrieval | Pairs |\n")
        f.write("|-------|-----------|-------|\n")

        # This run
        f.write(
            f"| This Run | {self.metrics.oolong_accuracy:.1%} | "
            f"{self.metrics.oolong_pairs_accuracy:.1%} |\n"
        )

        # Paper baselines
        for model, scores in PAPER_OOLONG_SCORES.items():
            f.write(
                f"| {model} | {scores.get('oolong_retrieval', 0):.1%} | "
                f"{scores.get('oolong_pairs', 0):.1%} |\n"
            )

        f.write("\n")

    def _write_strategy_analysis(self, f: TextIO) -> None:
        """Write strategy analysis section (Paper Section 4.1)."""
        if not self.metrics.strategy_metrics:
            return

        f.write("## Strategy Analysis (Paper Section 4.1)\n\n")
        f.write("RLM uses various strategies to process long contexts:\n\n")

        f.write("| Strategy | Usage Count | Success Rate | Avg Latency (ms) |\n")
        f.write("|----------|-------------|--------------|------------------|\n")

        for strategy, sm in sorted(
            self.metrics.strategy_metrics.items(),
            key=lambda x: x[1].usage_count,
            reverse=True,
        ):
            f.write(
                f"| {strategy.value} | {sm.usage_count} | "
                f"{sm.success_rate:.1%} | {sm.avg_latency_ms:.1f} |\n"
            )

        f.write("\n")

        # Strategy descriptions
        f.write("### Strategy Definitions\n\n")
        f.write("- **peek**: Examining prefix/suffix of context (e.g., `prompt[:100]`)\n")
        f.write("- **grep**: Using regex to filter relevant portions\n")
        f.write("- **chunk**: Splitting context for parallel processing\n")
        f.write("- **stitch**: Combining sub-call results\n")
        f.write("- **subcall**: Recursive self-call to process sub-contexts\n")
        f.write("\n")

    def _write_cost_analysis(self, f: TextIO) -> None:
        """Write cost analysis section (Paper Figure 3)."""
        f.write("## Cost Analysis (Paper Figure 3)\n\n")

        cost_analysis = self.results.cost_analysis

        f.write("| Metric | Value |\n")
        f.write("|--------|-------|\n")
        f.write(f"| Total Cost | ${cost_analysis.get('total_cost_usd', 0):.4f} |\n")
        f.write(f"| Avg Cost/Task | ${cost_analysis.get('avg_cost_per_task_usd', 0):.6f} |\n")
        f.write(f"| Cost/1K Tokens | ${cost_analysis.get('cost_per_1k_tokens_usd', 0):.6f} |\n")
        f.write(f"| Accuracy/Dollar | {cost_analysis.get('accuracy_per_dollar', 0):.2f} |\n")
        f.write("\n")

        if self.results.config.use_dual_model:
            f.write("**Dual-Model Configuration** (Paper Section 3.2):\n\n")
            f.write(f"- Root Model: {self.results.config.root_model}\n")
            f.write(f"- Sub-call Model: {self.results.config.subcall_model}\n")
            f.write("\n")

    def _write_paper_comparison(self, f: TextIO) -> None:
        """Write comparison with paper results."""
        if not self.results.paper_comparison:
            return

        f.write("## Paper Comparison\n\n")
        f.write(
            "Comparison of this benchmark run with published results "
            "from arXiv:2512.24601.\n\n"
        )

        for benchmark, data in self.results.paper_comparison.items():
            f.write(f"### {benchmark}\n\n")

            if "this_run" in data:
                this_run = data["this_run"]
                f.write("This run results:\n")
                for k, v in this_run.items():
                    if isinstance(v, float):
                        f.write(f"- {k}: {v:.1%}\n")
                f.write("\n")

        f.write("See the paper for detailed methodology and comparison.\n\n")

    def generate_summary_string(self) -> str:
        """Generate a concise summary string."""
        lines = [
            f"RLM Benchmark: {self.metrics.overall_accuracy:.1%} accuracy",
            f"  Tasks: {self.metrics.passed_tasks}/{self.metrics.total_tasks}",
            f"  Cost: ${self.metrics.total_cost_usd:.4f}",
            f"  Avg Latency: {self.metrics.avg_latency_ms:.1f}ms",
        ]

        if self.metrics.s_niah_by_length:
            s_niah = ", ".join(
                f"{k}:{v:.0%}" for k, v in self.metrics.s_niah_by_length.items()
            )
            lines.append(f"  S-NIAH: {s_niah}")

        return "\n".join(lines)
