"""
BFCL Reporting Module

Generates reports and visualizations for BFCL benchmark results.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Optional

from benchmarks.bfcl.metrics import MetricsCalculator
from benchmarks.bfcl.types import (
    BFCLBenchmarkResults,
    BFCLCategory,
    BFCLConfig,
    LEADERBOARD_SCORES,
)

logger = logging.getLogger(__name__)


class BFCLReporter:
    """
    Generate reports for BFCL benchmark results.

    Supports:
    - JSON export
    - Markdown reports
    - Leaderboard comparison
    - Console output
    - Best results tracking (preserves best scores per model)
    """

    def __init__(self, config: BFCLConfig):
        """
        Initialize reporter.

        Args:
            config: Benchmark configuration
        """
        self.config = config
        self.output_dir = Path(config.output_dir)
        self.metrics_calculator = MetricsCalculator()
        self.best_results_file = self.output_dir / "bfcl_best_results.json"

    def _get_model_slug(self, model_name: Optional[str]) -> str:
        """Convert model name to a filesystem-safe slug."""
        if not model_name:
            return "unknown"
        # Replace slashes and special chars with underscores
        slug = model_name.replace("/", "_").replace(":", "_")
        slug = slug.replace(" ", "_").replace(".", "_")
        return slug.lower()

    async def _update_best_results(self, results: BFCLBenchmarkResults) -> None:
        """Update the best results file without overwriting better scores from other models."""
        model_name = results.model_name or "unknown"
        
        # Load existing best results
        best_results: dict[str, dict[str, float | int | str | None]] = {}
        if self.best_results_file.exists():
            try:
                with open(self.best_results_file) as f:
                    best_results = json.load(f)
            except json.JSONDecodeError:
                pass
        
        # Get current metrics
        current: dict[str, float | int | str | None] = {
            "model": model_name,
            "provider": results.provider,
            "overall_score": results.metrics.overall_score,
            "ast_accuracy": results.metrics.ast_accuracy,
            "exec_accuracy": results.metrics.exec_accuracy,
            "relevance_accuracy": results.metrics.relevance_accuracy,
            "total_tests": results.metrics.total_tests,
            "timestamp": datetime.now().isoformat(),
        }
        
        # Update this model's best if improved
        if model_name in best_results:
            existing = best_results[model_name]
            existing_score_raw = existing.get("overall_score", 0)
            existing_score = float(existing_score_raw) if existing_score_raw else 0.0
            if results.metrics.overall_score > existing_score:
                best_results[model_name] = current
                logger.info(f"New best score for {model_name}: {results.metrics.overall_score:.2%}")
        else:
            best_results[model_name] = current
            logger.info(f"First result for {model_name}: {results.metrics.overall_score:.2%}")
        
        # Save updated best results
        with open(self.best_results_file, "w") as f:
            json.dump(best_results, f, indent=2, default=str)
        
        logger.info(f"Best results updated: {self.best_results_file}")

    async def generate_report(
        self,
        results: BFCLBenchmarkResults,
    ) -> dict[str, str]:
        """
        Generate all report formats.

        Args:
            results: Benchmark results

        Returns:
            Dict mapping format to file path
        """
        self.output_dir.mkdir(parents=True, exist_ok=True)

        generated_files: dict[str, str] = {}

        # Generate JSON report (with model name in filename)
        json_path = await self._generate_json_report(results)
        generated_files["json"] = json_path

        # Generate Markdown report
        md_path = await self._generate_markdown_report(results)
        generated_files["markdown"] = md_path

        # Generate leaderboard comparison
        if self.config.compare_baselines:
            lb_path = await self._generate_leaderboard_comparison(results)
            generated_files["leaderboard"] = lb_path

        # Update best results (preserves best scores per model)
        await self._update_best_results(results)
        generated_files["best_results"] = str(self.best_results_file)

        # Print summary to console
        self._print_console_summary(results)

        logger.info(f"Reports generated in {self.output_dir}")
        return generated_files

    async def _generate_json_report(
        self,
        results: BFCLBenchmarkResults,
    ) -> str:
        """Generate JSON report with model-specific naming."""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        
        # Include model name in filename to avoid overwriting other model results
        model_slug = self._get_model_slug(results.model_name)
        filename = f"bfcl_results_{model_slug}_{timestamp}.json"
        filepath = self.output_dir / filename

        # Convert results to serializable format
        data = {
            "metadata": results.metadata,
            "config": {
                "version": results.config.version,
                "categories": [c.value for c in results.config.categories] if results.config.categories else None,
                "max_tests_per_category": results.config.max_tests_per_category,
            },
            "metrics": {
                "overall_score": results.metrics.overall_score,
                "ast_accuracy": results.metrics.ast_accuracy,
                "exec_accuracy": results.metrics.exec_accuracy,
                "relevance_accuracy": results.metrics.relevance_accuracy,
                "total_tests": results.metrics.total_tests,
                "passed_tests": results.metrics.passed_tests,
                "failed_tests": results.metrics.failed_tests,
                "latency": {
                    "avg": results.metrics.avg_latency_ms,
                    "p50": results.metrics.latency_p50,
                    "p95": results.metrics.latency_p95,
                    "p99": results.metrics.latency_p99,
                },
                "category_breakdown": {
                    cat.value: {
                        "total": m.total_tests,
                        "ast_accuracy": m.ast_accuracy,
                        "exec_accuracy": m.exec_accuracy,
                        "relevance_accuracy": m.relevance_accuracy,
                        "avg_latency_ms": m.avg_latency_ms,
                    }
                    for cat, m in results.metrics.category_metrics.items()
                },
                "error_analysis": results.metrics.error_counts,
            },
            "baseline_comparison": results.baseline_comparison,
            "summary": results.summary,
        }

        # Add detailed results if configured
        if self.config.save_detailed_logs:
            data["detailed_results"] = [
                {
                    "test_case_id": r.test_case_id,
                    "category": r.category.value,
                    "ast_match": r.ast_match,
                    "exec_success": r.exec_success,
                    "relevance_correct": r.relevance_correct,
                    "latency_ms": r.latency_ms,
                    "predicted_calls": [
                        {"name": c.name, "arguments": c.arguments}
                        for c in r.predicted_calls
                    ],
                    "expected_calls": [
                        {"name": c.name, "arguments": c.arguments}
                        for c in r.expected_calls
                    ],
                    "error": r.error,
                }
                for r in results.results
            ]

        with open(filepath, "w") as f:
            json.dump(data, f, indent=2, default=str)

        logger.info(f"JSON report saved to {filepath}")
        return str(filepath)

    async def _generate_markdown_report(
        self,
        results: BFCLBenchmarkResults,
    ) -> str:
        """Generate Markdown report with model information."""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        model_slug = self._get_model_slug(results.model_name)
        filename = f"bfcl_report_{model_slug}_{timestamp}.md"
        filepath = self.output_dir / filename

        metrics = results.metrics
        model_display = results.model_name or "Unknown Model"

        lines = [
            "# BFCL Benchmark Report",
            "",
            f"**Model:** {model_display}",
            f"**Provider:** {results.provider or 'unknown'}",
            f"**Generated:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
            f"**BFCL Version:** {self.config.version}",
            "",
            "## Overview",
            "",
            "| Metric | Score |",
            "|--------|-------|",
            f"| Overall Score | {metrics.overall_score:.2%} |",
            f"| AST Accuracy | {metrics.ast_accuracy:.2%} |",
            f"| Execution Accuracy | {metrics.exec_accuracy:.2%} |",
            f"| Relevance Accuracy | {metrics.relevance_accuracy:.2%} |",
            "",
            "## Test Summary",
            "",
            f"- **Total Tests:** {metrics.total_tests}",
            f"- **Passed:** {metrics.passed_tests}",
            f"- **Failed:** {metrics.failed_tests}",
            f"- **Pass Rate:** {metrics.passed_tests / max(metrics.total_tests, 1):.2%}",
            "",
            "## Category Breakdown",
            "",
            "| Category | Tests | AST | Exec | Relevance | Latency |",
            "|----------|-------|-----|------|-----------|---------|",
        ]

        for category in BFCLCategory:
            cat_metrics = metrics.category_metrics.get(category)
            if cat_metrics:
                lines.append(
                    f"| {category.value} | {cat_metrics.total_tests} | "
                    f"{cat_metrics.ast_accuracy:.1%} | "
                    f"{cat_metrics.exec_accuracy:.1%} | "
                    f"{cat_metrics.relevance_accuracy:.1%} | "
                    f"{cat_metrics.avg_latency_ms:.0f}ms |"
                )

        lines.extend([
            "",
            "## Latency Statistics",
            "",
            f"- **Average:** {metrics.avg_latency_ms:.1f}ms",
            f"- **P50:** {metrics.latency_p50:.1f}ms",
            f"- **P95:** {metrics.latency_p95:.1f}ms",
            f"- **P99:** {metrics.latency_p99:.1f}ms",
            "",
        ])

        # Add baseline comparison
        if results.baseline_comparison:
            lines.extend([
                "## Baseline Comparison",
                "",
                "| Model | Difference |",
                "|-------|------------|",
            ])
            for model, diff in sorted(
                results.baseline_comparison.items(),
                key=lambda x: x[1],
                reverse=True,
            ):
                sign = "+" if diff > 0 else ""
                lines.append(f"| {model} | {sign}{diff:.2%} |")
            lines.append("")

        # Add summary
        if results.summary:
            lines.extend([
                "## Summary",
                "",
                f"**Status:** {results.summary.get('status', 'unknown')}",
                "",
            ])

            findings = results.summary.get("key_findings", [])
            if findings:
                lines.append("### Key Findings")
                lines.append("")
                for finding in findings:
                    lines.append(f"- {finding}")
                lines.append("")

            recommendations = results.summary.get("recommendations", [])
            if recommendations:
                lines.append("### Recommendations")
                lines.append("")
                for rec in recommendations:
                    lines.append(f"- {rec}")
                lines.append("")

        # Add error analysis
        if metrics.error_counts:
            lines.extend([
                "## Error Analysis",
                "",
                "| Error Type | Count |",
                "|------------|-------|",
            ])
            for error_type, count in sorted(
                metrics.error_counts.items(),
                key=lambda x: x[1],
                reverse=True,
            ):
                if count > 0:
                    lines.append(f"| {error_type} | {count} |")
            lines.append("")

        content = "\n".join(lines)
        with open(filepath, "w") as f:
            f.write(content)

        logger.info(f"Markdown report saved to {filepath}")
        return str(filepath)

    async def _generate_leaderboard_comparison(
        self,
        results: BFCLBenchmarkResults,
    ) -> str:
        """Generate leaderboard comparison report."""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"bfcl_leaderboard_{timestamp}.md"
        filepath = self.output_dir / filename

        metrics = results.metrics
        position, closest = self.metrics_calculator.calculate_leaderboard_position(metrics)

        lines = [
            "# BFCL Leaderboard Comparison",
            "",
            f"**ElizaOS Position:** #{position}",
            f"**Closest Model:** {closest}",
            "",
            "## Score Comparison",
            "",
            "| Rank | Model | Overall | AST | Exec |",
            "|------|-------|---------|-----|------|",
        ]

        # Add leaderboard entries
        sorted_baselines = sorted(
            LEADERBOARD_SCORES.items(),
            key=lambda x: x[1].overall,
            reverse=True,
        )

        elizaos_added = False
        for i, (model_name, baseline) in enumerate(sorted_baselines, 1):
            # Insert ElizaOS in the right position
            if not elizaos_added and metrics.overall_score > baseline.overall:
                lines.append(
                    f"| **{i}** | **ElizaOS** | "
                    f"**{metrics.overall_score:.2%}** | "
                    f"**{metrics.ast_accuracy:.2%}** | "
                    f"**{metrics.exec_accuracy:.2%}** |"
                )
                elizaos_added = True
                i += 1

            lines.append(
                f"| {i} | {baseline.model_name} | "
                f"{baseline.overall:.2%} | "
                f"{baseline.ast:.2%} | "
                f"{baseline.exec:.2%} |"
            )

        # Add ElizaOS at the end if not added
        if not elizaos_added:
            lines.append(
                f"| **{len(sorted_baselines) + 1}** | **ElizaOS** | "
                f"**{metrics.overall_score:.2%}** | "
                f"**{metrics.ast_accuracy:.2%}** | "
                f"**{metrics.exec_accuracy:.2%}** |"
            )

        lines.extend([
            "",
            "## Category Comparison",
            "",
        ])

        # Add category comparison with GPT-4o as reference
        gpt4o = LEADERBOARD_SCORES.get("gpt-5")
        if gpt4o:
            lines.extend([
                "### vs GPT-4o",
                "",
                "| Category | ElizaOS | GPT-4o | Difference |",
                "|----------|---------|--------|------------|",
            ])

            category_score_map = {
                BFCLCategory.SIMPLE: gpt4o.simple,
                BFCLCategory.MULTIPLE: gpt4o.multiple,
                BFCLCategory.PARALLEL: gpt4o.parallel,
                BFCLCategory.PARALLEL_MULTIPLE: gpt4o.parallel_multiple,
                BFCLCategory.RELEVANCE: gpt4o.relevance,
                BFCLCategory.REST_API: gpt4o.rest_api,
                BFCLCategory.SQL: gpt4o.sql,
                BFCLCategory.JAVA: gpt4o.java,
                BFCLCategory.JAVASCRIPT: gpt4o.javascript,
            }

            for category, gpt_score in category_score_map.items():
                cat_metrics = metrics.category_metrics.get(category)
                if cat_metrics:
                    eliza_score = cat_metrics.ast_accuracy
                    diff = eliza_score - gpt_score
                    sign = "+" if diff > 0 else ""
                    lines.append(
                        f"| {category.value} | {eliza_score:.2%} | "
                        f"{gpt_score:.2%} | {sign}{diff:.2%} |"
                    )

        content = "\n".join(lines)
        with open(filepath, "w") as f:
            f.write(content)

        logger.info(f"Leaderboard comparison saved to {filepath}")
        return str(filepath)

    def _print_console_summary(self, results: BFCLBenchmarkResults) -> None:
        """Print summary to console."""
        metrics = results.metrics
        model_display = results.model_name or "Unknown"

        print("\n" + "=" * 60)
        print("BFCL BENCHMARK RESULTS")
        print("=" * 60)
        print(f"\nModel: {model_display}")
        if results.provider:
            print(f"Provider: {results.provider}")
        print(f"\nOverall Score: {metrics.overall_score:.2%}")
        print(f"AST Accuracy:  {metrics.ast_accuracy:.2%}")
        print(f"Exec Accuracy: {metrics.exec_accuracy:.2%}")
        print(f"Relevance:     {metrics.relevance_accuracy:.2%}")
        print(f"\nTests: {metrics.passed_tests}/{metrics.total_tests} passed")
        print(f"Avg Latency: {metrics.avg_latency_ms:.1f}ms")

        if results.baseline_comparison:
            print("\nBaseline Comparison:")
            for model, diff in sorted(
                results.baseline_comparison.items(),
                key=lambda x: x[1],
                reverse=True,
            )[:3]:
                sign = "+" if diff > 0 else ""
                print(f"  vs {model}: {sign}{diff:.2%}")

        print("=" * 60 + "\n")


def print_results(results: BFCLBenchmarkResults) -> None:
    """Convenience function to print results to console."""
    reporter = BFCLReporter(results.config)
    reporter._print_console_summary(results)
