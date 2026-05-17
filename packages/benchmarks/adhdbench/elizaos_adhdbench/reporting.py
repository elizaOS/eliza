"""Report generation: scaling curves, markdown, JSON."""

from __future__ import annotations

import json
import logging
from pathlib import Path

from elizaos_adhdbench.config import ADHDBenchConfig
from elizaos_adhdbench.types import BenchmarkResults, ScalingCurvePoint

logger = logging.getLogger("adhdbench")


class ADHDBenchReporter:
    """Generates human-readable reports from benchmark results."""

    def __init__(self, config: ADHDBenchConfig) -> None:
        self.config = config

    def generate_report(self, results: BenchmarkResults) -> Path:
        """Generate a full markdown report and save to disk."""
        output_dir = Path(self.config.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        report = self._build_markdown_report(results)

        report_path = output_dir / f"adhdbench_report_{results.timestamp.replace(':', '-')}.md"
        with open(report_path, "w") as f:
            f.write(report)

        # Also save JSON summary
        summary = self._build_json_summary(results)
        json_path = output_dir / f"adhdbench_summary_{results.timestamp.replace(':', '-')}.json"
        with open(json_path, "w") as f:
            json.dump(summary, f, indent=2, default=str)

        logger.info(f"Report saved to {report_path}")
        logger.info(f"Summary saved to {json_path}")

        # Print to console
        self._print_console_report(results)

        return report_path

    def _build_markdown_report(self, results: BenchmarkResults) -> str:
        """Build the full markdown report string."""
        lines: list[str] = []
        lines.append("# ADHDBench Report")
        lines.append("")
        lines.append(f"**Model**: {results.metadata.get('model', 'unknown')}")
        lines.append(f"**Provider**: {results.metadata.get('provider', 'unknown')}")
        lines.append(f"**Timestamp**: {results.timestamp}")
        lines.append(f"**Total Scenarios Run**: {results.metadata.get('total_scenarios', 0)}")
        lines.append(f"**Duration**: {results.metadata.get('duration_ms', 0):.0f}ms")
        lines.append("")

        # Baselines
        lines.append("## Baselines")
        lines.append("")
        lines.append(f"| Baseline | Score |")
        lines.append(f"|----------|-------|")
        for name, score in results.baselines.items():
            lines.append(f"| {name} | {score:.1%} |")
        lines.append("")

        # Scaling curves
        lines.append("## Attention Scaling Curves")
        lines.append("")
        for config_name, points in results.scaling_curves.items():
            lines.append(f"### Config: {config_name}")
            lines.append("")
            lines.append(self._render_ascii_curve(points, config_name))
            lines.append("")
            lines.append("| Scale Point | Actions | Providers | Prefill | Score | Latency (ms) | Scenarios |")
            lines.append("|-------------|---------|-----------|---------|-------|-------------|-----------|")
            for p in points:
                lines.append(
                    f"| {p.scale_label} | {p.action_count} | {p.provider_count} | "
                    f"{p.conversation_prefill} | {p.score:.1%} | {p.latency_ms:.0f} | {p.scenario_count} |"
                )
            lines.append("")

        # Per-level breakdown
        lines.append("## Per-Level Breakdown")
        lines.append("")
        level_scores: dict[str, dict[str, list[float]]] = {}
        for sr in results.results:
            level_name = sr.level.name
            config = sr.config_name
            key = f"{config}/{level_name}"
            level_scores.setdefault(key, {}).setdefault(sr.scale_point.label, []).append(sr.score)

        lines.append("| Config/Level | Scale Point | Avg Score | Count |")
        lines.append("|-------------|-------------|-----------|-------|")
        for key in sorted(level_scores.keys()):
            for sp_label in sorted(level_scores[key].keys()):
                scores = level_scores[key][sp_label]
                avg = sum(scores) / len(scores)
                lines.append(f"| {key} | {sp_label} | {avg:.1%} | {len(scores)} |")
        lines.append("")

        # Worst-performing scenarios
        lines.append("## Lowest Scoring Scenarios")
        lines.append("")
        sorted_results = sorted(results.results, key=lambda r: r.score)
        lines.append("| Scenario | Config | Scale | Score | Error |")
        lines.append("|----------|--------|-------|-------|-------|")
        for sr in sorted_results[:20]:
            error_str = sr.error[:50] if sr.error else "-"
            lines.append(
                f"| {sr.scenario_id}: {sr.scenario_name} | {sr.config_name} | "
                f"{sr.scale_point.label} | {sr.score:.1%} | {error_str} |"
            )
        lines.append("")

        # Detailed turn-level results for failing scenarios
        lines.append("## Failed Outcome Details")
        lines.append("")
        for sr in sorted_results[:10]:
            if sr.score >= 1.0:
                continue
            lines.append(f"### {sr.scenario_id}: {sr.scenario_name} ({sr.config_name}, {sr.scale_point.label})")
            lines.append("")
            for tr in sr.turn_results:
                if not tr.outcome_results:
                    continue
                failed = [o for o in tr.outcome_results if not o.passed]
                if not failed:
                    continue
                lines.append(f"**Turn {tr.turn_index}** (actions: {', '.join(tr.actions_selected) or 'none'})")
                for o in failed:
                    lines.append(f"  - FAIL [{o.outcome.outcome_type.value}]: {o.detail[:200]}")
                lines.append("")

        return "\n".join(lines)

    def _render_ascii_curve(self, points: list[ScalingCurvePoint], config_name: str) -> str:
        """Render an ASCII art scaling curve."""
        if not points:
            return "(no data)"

        height = 10

        scores = [min(max(p.score, 0.0), 1.0) for p in points]
        max_score = 1.0

        lines: list[str] = []
        lines.append(f"```")
        lines.append(f"  Attention Scaling Curve ({config_name})")
        lines.append(f"")

        # Y-axis labels and bars
        for row in range(height, -1, -1):
            threshold = row / height * max_score
            label = f"{threshold:5.0%}"
            bar_chars: list[str] = []
            for i, score in enumerate(scores):
                if i > 0:
                    bar_chars.append("    ")
                if score >= threshold:
                    bar_chars.append("  ##  ")
                else:
                    bar_chars.append("      ")
            lines.append(f"  {label} |{''.join(bar_chars)}")

        # X-axis
        x_labels = "".join(f"  {p.scale_label:^10}" for p in points)
        lines.append(f"        +{'------' * len(points)}---")
        lines.append(f"        {x_labels}")
        lines.append(f"```")
        return "\n".join(lines)

    def _build_json_summary(self, results: BenchmarkResults) -> dict[str, object]:
        """Build a JSON-serialisable summary."""
        summary: dict[str, object] = {
            "metadata": results.metadata,
            "baselines": results.baselines,
            "timestamp": results.timestamp,
            "scaling_curves": {},
            "per_scenario": {},
        }

        for config_name, points in results.scaling_curves.items():
            summary["scaling_curves"][config_name] = [  # type: ignore[index]
                {
                    "scale_label": p.scale_label,
                    "action_count": p.action_count,
                    "score": round(p.score, 4),
                    "latency_ms": round(p.latency_ms, 1),
                    "scenario_count": p.scenario_count,
                }
                for p in points
            ]

        for sr in results.results:
            key = f"{sr.scenario_id}/{sr.config_name}/{sr.scale_point.label}"
            summary["per_scenario"][key] = {  # type: ignore[index]
                "score": round(sr.score, 4),
                "latency_ms": round(sr.total_latency_ms, 1),
                "actions_selected": [
                    tr.actions_selected for tr in sr.turn_results if tr.actions_selected
                ],
            }

        return summary

    def _print_console_report(self, results: BenchmarkResults) -> None:
        """Print a compact report to the console."""
        print()
        print("=" * 60)
        print("  ADHDBench Results")
        print(f"  Model: {results.metadata.get('model', 'unknown')}")
        print(f"  Duration: {results.metadata.get('duration_ms', 0):.0f}ms")
        print("=" * 60)
        print()

        # Baselines
        print("  Baselines:")
        for name, score in results.baselines.items():
            print(f"    {name:20s}: {score:.1%}")
        print()

        # Scaling curves
        for config_name, points in results.scaling_curves.items():
            print(f"  Scaling Curve ({config_name}):")
            for p in points:
                bar_len = int(p.score * 40)
                bar = "#" * bar_len + "." * (40 - bar_len)
                print(f"    {p.scale_label:20s} [{bar}] {p.score:.1%}  ({p.latency_ms:.0f}ms)")
            print()

        # Summary stats
        if results.results:
            all_scores = [r.score for r in results.results]
            avg = sum(all_scores) / len(all_scores)
            perfect = sum(1 for s in all_scores if s >= 1.0)
            failed = sum(1 for s in all_scores if s < 0.5)
            print(f"  Overall: avg={avg:.1%}, perfect={perfect}/{len(all_scores)}, failed={failed}/{len(all_scores)}")
        print()
