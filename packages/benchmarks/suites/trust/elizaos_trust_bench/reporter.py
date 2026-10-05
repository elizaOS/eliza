"""Reporter for the agent trust & security benchmark.

Formats benchmark results as a readable table with per-category metrics,
overall scores, difficulty breakdown, and detailed failure analysis.
"""

from __future__ import annotations

from datetime import datetime, timezone

from elizaos_trust_bench.types import (
    BenchmarkResult,
    DetectionResult,
    TrustTestCase,
)


def _pad_right(s: str, width: int) -> str:
    return s[:width] if len(s) >= width else s + " " * (width - len(s))


def _pad_left(s: str, width: int) -> str:
    return s[:width] if len(s) >= width else " " * (width - len(s)) + s


def _pct(n: float) -> str:
    return f"{n * 100:.1f}%"


def format_report(
    result: BenchmarkResult,
    corpus: list[TrustTestCase],
    detections: list[DetectionResult],
) -> str:
    """Format benchmark results as a human-readable report.

    Args:
        result: The scored benchmark result.
        corpus: The test cases that were run.
        detections: The raw detection results.

    Returns:
        Multi-line string with formatted report.
    """
    det_map: dict[str, DetectionResult] = {d.test_id: d for d in detections}
    lines: list[str] = []

    # Header
    lines.append("")
    lines.append("=" * 80)
    lines.append(f"  Agent Trust & Security Benchmark -- {result.handler_name}")
    ts = datetime.fromtimestamp(result.timestamp, tz=timezone.utc).isoformat()
    lines.append(f"  {ts}")
    lines.append("=" * 80)
    lines.append("")

    # Category summary table
    header = (
        _pad_right("Category", 24)
        + _pad_left("TP", 5)
        + _pad_left("FP", 5)
        + _pad_left("FN", 5)
        + _pad_left("TN", 5)
        + _pad_left("Prec", 8)
        + _pad_left("Recall", 8)
        + _pad_left("F1", 8)
    )
    lines.append(header)
    lines.append("-" * 68)

    for cat in result.categories:
        row = (
            _pad_right(cat.category.value, 24)
            + _pad_left(str(cat.true_positives), 5)
            + _pad_left(str(cat.false_positives), 5)
            + _pad_left(str(cat.false_negatives), 5)
            + _pad_left(str(cat.true_negatives), 5)
            + _pad_left(_pct(cat.precision), 8)
            + _pad_left(_pct(cat.recall), 8)
            + _pad_left(_pct(cat.f1), 8)
        )
        lines.append(row)

    lines.append("-" * 68)
    lines.append("")

    # Overall metrics
    lines.append(f"  Overall Macro F1:        {_pct(result.overall_f1)}")
    lines.append(f"  False Positive Rate:     {_pct(result.false_positive_rate)}")
    lines.append(f"  Total Test Cases:        {result.total_tests}")
    lines.append("")

    # Difficulty breakdown
    db = result.difficulty_breakdown
    lines.append("  Difficulty Breakdown:")
    if db.easy_total > 0:
        lines.append(
            f"    Easy:   {db.easy_correct}/{db.easy_total} "
            f"({db.easy_correct / db.easy_total * 100:.1f}%)"
        )
    if db.medium_total > 0:
        lines.append(
            f"    Medium: {db.medium_correct}/{db.medium_total} "
            f"({db.medium_correct / db.medium_total * 100:.1f}%)"
        )
    if db.hard_total > 0:
        lines.append(
            f"    Hard:   {db.hard_correct}/{db.hard_total} "
            f"({db.hard_correct / db.hard_total * 100:.1f}%)"
        )
    lines.append("")

    # Detailed failures
    misses: list[str] = []
    false_positives: list[str] = []

    for tc in corpus:
        det = det_map.get(tc.id)
        if det is None:
            if tc.expected_malicious:
                misses.append(f"  MISS  [{tc.id}] {tc.description} (no result)")
            continue

        if tc.expected_malicious and not det.detected:
            misses.append(
                f"  MISS  [{tc.id}] {tc.description} (conf: {det.confidence:.2f})"
            )
        elif not tc.expected_malicious and det.detected:
            false_positives.append(
                f"  FP    [{tc.id}] {tc.description} (conf: {det.confidence:.2f})"
            )

    if misses or false_positives:
        lines.append("Failures:")
        lines.append("-" * 80)
        lines.extend(misses)
        lines.extend(false_positives)
        lines.append("")
    else:
        lines.append("No failures -- perfect score!")
        lines.append("")

    lines.append("=" * 80)

    return "\n".join(lines)
