#!/usr/bin/env python3
"""Rolodex Benchmark v2 — Python edition.

Realistic handles, noise, type accuracy, full traces.

Usage:
    python -m benchmarks.rolodex.python_bench.run              # perfect + rolodex
    python -m benchmarks.rolodex.python_bench.run --eliza       # + eliza (LLM)

Or from the workspace root:
    python benchmarks/rolodex/python_bench/run.py
    python benchmarks/rolodex/python_bench/run.py --eliza
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from .conversations import CONVERSATIONS
from .reporter import (
    header,
    print_comparison,
    print_conv_trace,
    print_metric,
    print_rel_metric,
    print_resolution_trace,
)
from .scorer import (
    compute_metrics,
    score_identities,
    score_relationships,
    score_resolution,
    score_trust,
)
from .types import Extraction, Metrics, RelationshipMetrics
from .world import WORLD


@dataclass
class RunResult:
    """Aggregated results for one handler."""

    identity_m: Metrics
    rel_m: RelationshipMetrics
    trust_m: Metrics
    res_m: Metrics
    fmr: float
    total_time: float


async def run(handler: object) -> RunResult:
    """Run a handler against all conversations and score it."""
    if hasattr(handler, "setup"):
        await handler.setup()  # type: ignore[union-attr]

    extractions: list[Extraction] = []
    id_tp = id_fp = id_fn = 0
    rel_tp = rel_fp = rel_fn = 0
    tr_tp = tr_fp = tr_fn = 0
    type_matches = 0
    total_matches = 0

    for conv in CONVERSATIONS:
        ext = await handler.extract(conv, WORLD)  # type: ignore[union-attr]
        extractions.append(ext)

        id_metrics, id_items = score_identities(conv, ext)
        rel_metrics, rel_items = score_relationships(conv, ext)
        tr_metrics, tr_items = score_trust(conv, ext)

        id_tp += id_metrics.tp
        id_fp += id_metrics.fp
        id_fn += id_metrics.fn
        rel_tp += rel_metrics.tp
        rel_fp += rel_metrics.fp
        rel_fn += rel_metrics.fn
        tr_tp += tr_metrics.tp
        tr_fp += tr_metrics.fp
        tr_fn += tr_metrics.fn

        # Type accuracy tracking
        type_matches += sum(1 for it in rel_items if it.status == "TP")
        total_matches += sum(
            1 for it in rel_items if it.status in ("TP", "PARTIAL")
        )

        print_conv_trace(conv, ext, id_items, rel_items, tr_items)

    identity_m = compute_metrics(id_tp, id_fp, id_fn)
    rel_base = compute_metrics(rel_tp, rel_fp, rel_fn)
    rel_m = RelationshipMetrics(
        tp=rel_base.tp,
        fp=rel_base.fp,
        fn=rel_base.fn,
        precision=rel_base.precision,
        recall=rel_base.recall,
        f1=rel_base.f1,
        type_accuracy=type_matches / total_matches if total_matches > 0 else 1.0,
    )
    trust_m = compute_metrics(tr_tp, tr_fp, tr_fn)

    print_metric("Identity Extraction", identity_m)
    print_rel_metric("Relationship Detection", rel_m)
    print_metric("Trust Detection", trust_m)
    print()

    res = await handler.resolve(extractions, WORLD)  # type: ignore[union-attr]
    res_metrics, fmr, res_items = score_resolution(WORLD, res)
    print_resolution_trace(res_items, res.traces, fmr)
    print_metric("Entity Resolution", res_metrics)
    print()

    if hasattr(handler, "teardown"):
        await handler.teardown()  # type: ignore[union-attr]

    total_time = sum(e.wall_time_ms for e in extractions) + res.wall_time_ms
    return RunResult(
        identity_m=identity_m,
        rel_m=rel_m,
        trust_m=trust_m,
        res_m=res_metrics,
        fmr=fmr,
        total_time=total_time,
    )


async def main() -> None:
    """Entry point."""
    parser = argparse.ArgumentParser(description="Run Rolodex benchmark")
    parser.add_argument("--eliza", action="store_true", help="Include Eliza LLM handler")
    parser.add_argument("--output", type=str, default=None, help="Optional output directory for JSON results")
    args = parser.parse_args()
    use_eliza = args.eliza

    header("ROLODEX BENCHMARK v2 (Python)")
    noise_count = sum(
        1
        for c in CONVERSATIONS
        if not c.expected.identities
        and not c.expected.relationships
        and not c.expected.trust_signals
    )
    print(
        f"  World: {len(WORLD.entities)} entities, "
        f"{len(WORLD.links)} cross-platform links, "
        f"{len(WORLD.anti_links)} anti-links"
    )
    print(f"  Conversations: {len(CONVERSATIONS)} ({noise_count} noise)\n")

    # ── Perfect handler (validation) ──
    from .handlers.perfect import perfect_handler

    header("PERFECT HANDLER (Validation)")
    perfect = await run(perfect_handler)

    ok = (
        perfect.identity_m.f1 == 1.0
        and perfect.rel_m.f1 == 1.0
        and perfect.trust_m.f1 == 1.0
        and perfect.res_m.f1 == 1.0
        and perfect.fmr == 0.0
    )
    if ok:
        print(
            "  \033[32m\u2713 VALIDATION PASSED: Perfect handler = 100% "
            "everywhere.\033[0m\n"
        )
    else:
        print("  \033[31m\u2717 VALIDATION FAILED! Bug in scoring.\033[0m\n")
        sys.exit(1)

    # ── Rolodex handler ──
    from .handlers.rolodex import rolodex_handler

    header("ROLODEX HANDLER (System Under Test)")
    rolodex = await run(rolodex_handler)

    comparison_entries: list[dict[str, float | str]] = [
        {
            "name": "Perfect (Oracle)",
            "id_f1": perfect.identity_m.f1,
            "rel_f1": perfect.rel_m.f1,
            "tr_f1": perfect.trust_m.f1,
            "res_f1": perfect.res_m.f1,
            "fmr": perfect.fmr,
            "type_acc": perfect.rel_m.type_accuracy,
            "ms": perfect.total_time,
        },
        {
            "name": "Rolodex (Algorithmic)",
            "id_f1": rolodex.identity_m.f1,
            "rel_f1": rolodex.rel_m.f1,
            "tr_f1": rolodex.trust_m.f1,
            "res_f1": rolodex.res_m.f1,
            "fmr": rolodex.fmr,
            "type_acc": rolodex.rel_m.type_accuracy,
            "ms": rolodex.total_time,
        },
    ]

    # ── Eliza handler (optional, LLM-based) ──
    eliza_result: RunResult | None = None
    if use_eliza:
        from .handlers.eliza import eliza_handler

        header("ELIZA HANDLER (LLM via AgentRuntime)")
        eliza_result = await run(eliza_handler)
        comparison_entries.append({
            "name": "Eliza (LLM)",
            "id_f1": eliza_result.identity_m.f1,
            "rel_f1": eliza_result.rel_m.f1,
            "tr_f1": eliza_result.trust_m.f1,
            "res_f1": eliza_result.res_m.f1,
            "fmr": eliza_result.fmr,
            "type_acc": eliza_result.rel_m.type_accuracy,
            "ms": eliza_result.total_time,
        })

    # ── Comparison ──
    print_comparison(comparison_entries)

    # ── Verdict ──
    sut_result = eliza_result if eliza_result else rolodex
    sut_name = "Eliza" if eliza_result else "Rolodex"

    all_perfect = (
        sut_result.identity_m.f1 == 1.0
        and sut_result.rel_m.f1 == 1.0
        and sut_result.trust_m.f1 == 1.0
        and sut_result.res_m.f1 == 1.0
        and sut_result.fmr == 0.0
    )

    header("VERDICT")
    if all_perfect:
        print(
            f"  \033[32mALL SUITES AT 100%. {sut_name} verified at all "
            f"difficulty levels.\033[0m"
        )
    else:
        scores = [
            sut_result.identity_m.f1,
            sut_result.rel_m.f1,
            sut_result.trust_m.f1,
            sut_result.res_m.f1,
        ]
        avg = sum(scores) / len(scores)
        print(
            f"  Average F1: {avg * 100:.1f}%  |  "
            f"Resolution: {sut_result.res_m.f1 * 100:.1f}%  |  "
            f"FMR: {sut_result.fmr * 100:.1f}%"
        )
        if sut_result.fmr > 0:
            print("  \033[31mCRITICAL: False merges detected!\033[0m")
        print("  \033[33mGaps remain. Review traces above.\033[0m")
    print()

    if args.output:
        output_dir = Path(args.output)
        output_dir.mkdir(parents=True, exist_ok=True)
        avg_f1 = (
            sut_result.identity_m.f1
            + sut_result.rel_m.f1
            + sut_result.trust_m.f1
            + sut_result.res_m.f1
        ) / 4.0
        payload = {
            "timestamp": datetime.now(UTC).isoformat(),
            "handler": sut_name,
            "overall_score": avg_f1,
            "identity_f1": sut_result.identity_m.f1,
            "relationship_f1": sut_result.rel_m.f1,
            "trust_f1": sut_result.trust_m.f1,
            "resolution_f1": sut_result.res_m.f1,
            "resolution_false_merge_rate": sut_result.fmr,
            "type_accuracy": sut_result.rel_m.type_accuracy,
            "validation_passed": ok,
            "all_suites_perfect": all_perfect,
            "comparison": comparison_entries,
        }
        filename = f"rolodex-results-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}.json"
        out_path = output_dir / filename
        out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(f"Results written to: {out_path}")


if __name__ == "__main__":
    asyncio.run(main())
