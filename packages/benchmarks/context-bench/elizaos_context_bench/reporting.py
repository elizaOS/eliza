"""Reporting and Visualization for Context Benchmark.

Generates human-readable reports, ASCII visualizations, and markdown output.
"""

from elizaos_context_bench.types import (
    LEADERBOARD_SCORES,
    ContextBenchResults,
    NeedlePosition,
)


class ContextBenchReporter:
    """Generate reports and visualizations for context benchmark results."""

    def __init__(self, results: ContextBenchResults):
        """Initialize the reporter.

        Args:
            results: Benchmark results to report on.

        """
        self.results = results
        self.metrics = results.metrics

    def generate_ascii_heatmap(self) -> str:
        """Generate ASCII heatmap of position vs context length accuracy.

        Returns:
            ASCII string representation of the heatmap.

        """
        if not self.results.position_heatmap:
            return "No heatmap data available"

        heatmap = self.results.position_heatmap

        # Character mapping for accuracy levels
        chars = " ░▒▓█"

        def get_char(val: float) -> str:
            idx = min(int(val * (len(chars) - 1)), len(chars) - 1)
            return chars[idx]

        # Get labels
        if (
            self.results.position_heatmap_positions
            and len(self.results.position_heatmap_positions) == len(heatmap)
        ):
            positions = self.results.position_heatmap_positions
        else:
            positions = list(NeedlePosition)[:len(heatmap)]

        col_count = len(heatmap[0]) if heatmap else 0
        if (
            self.results.position_heatmap_lengths
            and len(self.results.position_heatmap_lengths) == col_count
        ):
            lengths = self.results.position_heatmap_lengths
        else:
            lengths = self.results.config.context_lengths[:col_count]

        # Build header
        lines: list[str] = []
        lines.append("Position/Length Accuracy Heatmap")
        lines.append("(█=100%, ▓=75%, ▒=50%, ░=25%, =0%)")
        lines.append("")

        # Header row with length labels
        header = "         " + "".join(f"{length//1024:>5}K" for length in lengths)
        lines.append(header)
        lines.append("         " + "-" * (len(lengths) * 6))

        # Data rows
        for i, pos in enumerate(positions):
            if i < len(heatmap):
                row_data = "".join(f"  {get_char(v)}   " for v in heatmap[i])
                lines.append(f"{pos.value:>8}|{row_data}")

        lines.append("")
        return "\n".join(lines)

    def generate_context_length_curve(self) -> str:
        """Generate ASCII accuracy vs context length curve.

        Returns:
            ASCII string representation of the curve.

        """
        length_accs = self.metrics.length_accuracies
        if not length_accs:
            return "No context length data available"

        # Sort by length
        sorted_items = sorted(length_accs.items())

        # Build chart (height=10 rows, width based on data points)
        height = 10
        width = len(sorted_items)

        chart: list[list[str]] = [[" " for _ in range(width)] for _ in range(height)]

        for col, (_, acc_data) in enumerate(sorted_items):
            row = int((1 - acc_data.accuracy) * (height - 1))
            row = max(0, min(row, height - 1))
            chart[row][col] = "●"

            # Fill below the point
            for r in range(row + 1, height):
                chart[r][col] = "│"

        lines: list[str] = []
        lines.append("Accuracy vs Context Length")
        lines.append("")
        lines.append("100%|" + "".join([" " * 5 for _ in sorted_items]))

        for row_idx, chart_row in enumerate(chart):
            pct = 100 - (row_idx * 10)
            if pct == 50:
                lines.append(f" 50%|{''.join(c.center(5) for c in chart_row)}")
            elif pct == 0:
                lines.append(f"  0%|{''.join(c.center(5) for c in chart_row)}")
            else:
                lines.append(f"    |{''.join(c.center(5) for c in chart_row)}")

        lines.append("    +" + "-" * (width * 5))
        lines.append(
            "     "
            + "".join(f"{length//1024:>4}K " for length, _ in sorted_items)
        )
        lines.append("")

        return "\n".join(lines)

    def generate_markdown_report(self) -> str:
        """Generate comprehensive markdown report.

        Returns:
            Markdown formatted string.

        """
        lines: list[str] = []

        # Title
        lines.append("# Context Benchmark Results")
        lines.append("")
        lines.append(
            f"*Generated: {self.results.metadata.get('timestamp', 'Unknown')}*"
        )
        lines.append("")

        # Executive Summary
        lines.append("## Executive Summary")
        lines.append("")

        summary = self.results.summary
        lines.append(f"**Status:** {summary.get('status', 'Unknown')}")
        lines.append(
            f"**Overall Accuracy:** {summary.get('overall_accuracy', 'N/A')}"
        )
        lines.append("")

        if summary.get("findings"):
            lines.append("### Key Findings")
            for finding in summary["findings"]:
                lines.append(f"- {finding}")
            lines.append("")

        if summary.get("recommendations"):
            lines.append("### Recommendations")
            for rec in summary["recommendations"]:
                lines.append(f"- {rec}")
            lines.append("")

        # Overall Metrics
        lines.append("## Overall Metrics")
        lines.append("")
        lines.append("| Metric | Value |")
        lines.append("|--------|-------|")
        lines.append(f"| Total Tasks | {self.metrics.total_tasks} |")
        lines.append(f"| Passed Tasks | {self.metrics.passed_tasks} |")
        lines.append(f"| Failed Tasks | {self.metrics.failed_tasks} |")
        lines.append(f"| Overall Accuracy | {self.metrics.overall_accuracy:.1%} |")
        lines.append(
            f"| Avg Semantic Similarity | {self.metrics.avg_semantic_similarity:.3f} |"
        )
        lines.append(
            f"| Lost in Middle Score | {self.metrics.lost_in_middle_score:.1%} |"
        )
        lines.append(
            f"| Context Degradation Rate | {self.metrics.context_degradation_rate:.1%} |"
        )
        lines.append(f"| Avg Latency | {self.metrics.avg_latency_ms:.1f}ms |")
        lines.append(f"| Total Duration | {self.metrics.total_duration_ms:.0f}ms |")
        lines.append("")

        # Position Analysis
        lines.append("## Position Analysis")
        lines.append("")
        lines.append(
            "Accuracy by needle position (detecting 'lost in the middle' effect):"
        )
        lines.append("")
        lines.append("| Position | Tasks | Accuracy | Avg Similarity | Avg Latency |")
        lines.append("|----------|-------|----------|----------------|-------------|")

        for pos in NeedlePosition:
            if pos in self.metrics.position_accuracies:
                pos_acc = self.metrics.position_accuracies[pos]
                lines.append(
                    f"| {pos.value} | {pos_acc.total_tasks} | {pos_acc.accuracy:.1%} | "
                    f"{pos_acc.avg_semantic_similarity:.3f} | {pos_acc.avg_latency_ms:.0f}ms |"
                )
        lines.append("")

        # Context Length Analysis
        lines.append("## Context Length Analysis")
        lines.append("")
        lines.append("| Length | Tasks | Accuracy | Avg Similarity |")
        lines.append("|--------|-------|----------|----------------|")

        for length in sorted(self.metrics.length_accuracies.keys()):
            len_acc = self.metrics.length_accuracies[length]
            lines.append(
                f"| {length//1024}K | {len_acc.total_tasks} | {len_acc.accuracy:.1%} | "
                f"{len_acc.avg_semantic_similarity:.3f} |"
            )
        lines.append("")

        # Benchmark Type Analysis
        if self.metrics.type_accuracies:
            lines.append("## Benchmark Type Analysis")
            lines.append("")
            lines.append("| Type | Accuracy |")
            lines.append("|------|----------|")
            for bench_type, type_acc in self.metrics.type_accuracies.items():
                lines.append(f"| {bench_type.value} | {type_acc:.1%} |")
            lines.append("")

        # Multi-hop Analysis
        if self.metrics.multi_hop_success_rates:
            lines.append("## Multi-hop Reasoning Analysis")
            lines.append("")
            lines.append("| Hops | Success Rate |")
            lines.append("|------|--------------|")
            for hops, rate in sorted(self.metrics.multi_hop_success_rates.items()):
                lines.append(f"| {hops}-hop | {rate:.1%} |")
            lines.append("")

        # Leaderboard Comparison
        lines.append("## Leaderboard Comparison")
        lines.append("")
        lines.append("Comparison to published model scores:")
        lines.append("")
        lines.append("| Model | Overall | vs Ours | Lost in Middle |")
        lines.append("|-------|---------|---------|----------------|")

        for model_name, scores in LEADERBOARD_SCORES.items():
            overall = scores.get("overall", 0)
            diff = self.metrics.overall_accuracy - overall
            diff_str = f"+{diff:.1%}" if diff >= 0 else f"{diff:.1%}"
            lim = scores.get("lost_in_middle", 0)
            lines.append(f"| {model_name} | {overall:.1%} | {diff_str} | {lim:.1%} |")

        lines.append(
            f"| **ElizaOS** | **{self.metrics.overall_accuracy:.1%}** | - | "
            f"**{self.metrics.lost_in_middle_score:.1%}** |"
        )
        lines.append("")

        # Configuration
        lines.append("## Configuration")
        lines.append("")
        lines.append("```")
        lines.append(f"Context Lengths: {self.results.config.context_lengths}")
        lines.append(f"Positions: {[p.value for p in self.results.config.positions]}")
        lines.append(f"Tasks per Position: {self.results.config.tasks_per_position}")
        lines.append(f"Semantic Threshold: {self.results.config.semantic_threshold}")
        lines.append(f"Timeout: {self.results.config.timeout_per_task_ms}ms")
        lines.append("```")
        lines.append("")

        return "\n".join(lines)

    def generate_json_summary(self) -> dict[str, object]:
        """Generate JSON-serializable summary.

        Returns:
            Dictionary with summary data.

        """
        return {
            "overall_accuracy": self.metrics.overall_accuracy,
            "total_tasks": self.metrics.total_tasks,
            "passed_tasks": self.metrics.passed_tasks,
            "failed_tasks": self.metrics.failed_tasks,
            "avg_semantic_similarity": self.metrics.avg_semantic_similarity,
            "lost_in_middle_score": self.metrics.lost_in_middle_score,
            "context_degradation_rate": self.metrics.context_degradation_rate,
            "avg_latency_ms": self.metrics.avg_latency_ms,
            "total_duration_ms": self.metrics.total_duration_ms,
            "position_heatmap": self.results.position_heatmap,
            "position_heatmap_lengths": self.results.position_heatmap_lengths,
            "position_heatmap_positions": (
                [p.value for p in self.results.position_heatmap_positions]
                if self.results.position_heatmap_positions
                else None
            ),
            "position_accuracies": {
                pos.value: {
                    "accuracy": acc.accuracy,
                    "total_tasks": acc.total_tasks,
                }
                for pos, acc in self.metrics.position_accuracies.items()
            },
            "length_accuracies": {
                str(length): {
                    "accuracy": acc.accuracy,
                    "total_tasks": acc.total_tasks,
                }
                for length, acc in self.metrics.length_accuracies.items()
            },
            "multi_hop_success_rates": self.metrics.multi_hop_success_rates,
            "comparison_to_leaderboard": self.results.comparison_to_leaderboard,
            "summary": self.results.summary,
            "metadata": self.results.metadata,
        }

    def print_report(self) -> None:
        """Print a formatted report to stdout."""
        print("\n" + "=" * 60)
        print("CONTEXT BENCHMARK RESULTS")
        print("=" * 60)
        print("")

        # Summary
        print(f"Overall Accuracy: {self.metrics.overall_accuracy:.1%}")
        print(f"Total Tasks: {self.metrics.total_tasks}")
        print(f"Lost in Middle Score: {self.metrics.lost_in_middle_score:.1%}")
        print(f"Duration: {self.metrics.total_duration_ms/1000:.1f}s")
        print("")

        # Heatmap
        print(self.generate_ascii_heatmap())

        # Length curve
        print(self.generate_context_length_curve())

        # Key findings
        if self.results.summary.get("findings"):
            print("Key Findings:")
            for finding in self.results.summary["findings"]:
                print(f"  • {finding}")
            print("")

        print("=" * 60)


def save_results(
    results: ContextBenchResults,
    output_dir: str,
    prefix: str = "context_bench",
) -> dict[str, str]:
    """Save results to files.

    Args:
        results: Benchmark results.
        output_dir: Directory to save files.
        prefix: Filename prefix.

    Returns:
        Dictionary mapping file types to paths.

    """
    import json
    import os
    from datetime import datetime

    os.makedirs(output_dir, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    reporter = ContextBenchReporter(results)
    paths: dict[str, str] = {}

    # Save markdown report
    md_path = os.path.join(output_dir, f"{prefix}_{timestamp}.md")
    with open(md_path, "w") as f:
        f.write(reporter.generate_markdown_report())
    paths["markdown"] = md_path

    # Save JSON summary
    json_path = os.path.join(output_dir, f"{prefix}_{timestamp}.json")
    with open(json_path, "w") as f:
        json.dump(reporter.generate_json_summary(), f, indent=2)
    paths["json"] = json_path

    # Save detailed results
    results_path = os.path.join(output_dir, f"{prefix}_{timestamp}_detailed.json")
    with open(results_path, "w") as f:
        detailed = {
            "metadata": results.metadata,
            "summary": results.summary,
            "metrics": {
                "overall_accuracy": results.metrics.overall_accuracy,
                "total_tasks": results.metrics.total_tasks,
                "lost_in_middle_score": results.metrics.lost_in_middle_score,
            },
            "results": [
                {
                    "task_id": r.task_id,
                    "bench_type": r.bench_type.value,
                    "context_length": r.context_length,
                    "needle_position": r.needle_position.value,
                    "expected_answer": r.expected_answer,
                    "predicted_answer": r.predicted_answer,
                    "retrieval_success": r.retrieval_success,
                    "semantic_similarity": r.semantic_similarity,
                    "latency_ms": r.latency_ms,
                    "error": r.error,
                }
                for r in results.results
            ],
        }
        json.dump(detailed, f, indent=2)
    paths["detailed"] = results_path

    return paths
