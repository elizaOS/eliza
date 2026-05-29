#!/usr/bin/env python3
"""Compute per-benchmark and total run costs for each harness.

Reads the checked-in ``benchmark_results/latest/<benchmark>__<harness>.json``
snapshots, pulls per-benchmark token totals from ``metrics.token_metrics``, and
applies pricing for:

  * Cerebras ``gpt-oss-120b``  ($0.35 / $0.75 per 1M in/out)
  * Anthropic ``claude-opus-4-8`` ($15 / $75 per 1M in/out)

Output: a markdown cost report (per benchmark x harness, plus per-harness
totals and averages) for both models.

Token counts are benchmark-driven and harness-dependent (tool loops, retries),
so they are a sound basis for projecting what an Opus run of the *same* work
would cost on each harness. The ``smithers`` harness has limited real snapshots
(BFCL measured live); where a smithers snapshot is absent we fall back to the
hermes token profile (smithers and hermes share the same per-turn
OpenAI-compatible pattern) and flag the row as projected.

Usage:
    python -m scripts.compute_costs            # from packages/benchmarks
    python scripts/compute_costs.py --json     # machine-readable
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import sys

_HERE = Path(__file__).resolve().parent
_BENCH_ROOT = _HERE.parent
sys.path.insert(0, str(_BENCH_ROOT.parent))  # packages/ for `benchmarks` ns

from benchmarks.lib.pricing import compute_cost_usd  # noqa: E402

GPT_OSS = {"gpt-oss-120b": {"input_per_million_usd": 0.35, "output_per_million_usd": 0.75}}
OPUS = {"opus": {"input_per_million_usd": 15.0, "output_per_million_usd": 75.0}}

HARNESSES = ("eliza", "hermes", "openclaw", "smithers")


def _tokens(snapshot: dict) -> tuple[int, int] | None:
    metrics = snapshot.get("metrics") or {}
    tm = metrics.get("token_metrics") or snapshot.get("token_metrics") or {}
    pt = tm.get("prompt_tokens")
    ct = tm.get("completion_tokens")
    if not isinstance(pt, (int, float)) or not isinstance(ct, (int, float)):
        return None
    if pt == 0 and ct == 0:
        return None
    return int(pt), int(ct)


def load_snapshots(latest_dir: Path) -> dict[str, dict[str, tuple[int, int]]]:
    """Return {benchmark_id: {harness: (prompt_tokens, completion_tokens)}}."""
    out: dict[str, dict[str, tuple[int, int]]] = {}
    for path in sorted(latest_dir.glob("*.json")):
        stem = path.stem
        if "__" not in stem:
            continue
        bench, harness = stem.rsplit("__", 1)
        bench = bench.replace("-", "_")
        try:
            snap = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        toks = _tokens(snap)
        if toks is None:
            continue
        out.setdefault(bench, {})[harness] = toks
    return out


def project_smithers(per_bench: dict[str, dict[str, tuple[int, int]]]) -> set[str]:
    """Fill missing smithers rows from the hermes profile. Returns projected set."""
    projected: set[str] = set()
    for bench, by_harness in per_bench.items():
        if "smithers" in by_harness:
            continue
        proxy = by_harness.get("hermes") or by_harness.get("openclaw") or by_harness.get("eliza")
        if proxy is not None:
            by_harness["smithers"] = proxy
            projected.add(bench)
    return projected


def _cost(toks: tuple[int, int], model: str) -> float:
    pt, ct = toks
    if model == "gpt-oss-120b":
        return compute_cost_usd("gpt-oss-120b", pt, ct, pricing=GPT_OSS) or 0.0
    return compute_cost_usd("opus", pt, ct, pricing=OPUS) or 0.0


def build_report(per_bench, projected, smithers_measured) -> str:
    lines: list[str] = []
    lines.append("# Benchmark cost report\n")
    lines.append(
        "Per-benchmark token totals from `benchmark_results/latest`, priced on "
        "Cerebras `gpt-oss-120b` ($0.35/$0.75 per 1M) and Anthropic "
        "`claude-opus-4-8` ($15/$75 per 1M).\n"
    )
    lines.append(
        "`*` = smithers row projected from the hermes token profile "
        "(no smithers snapshot yet). `†` = smithers measured live.\n"
    )
    lines.append(
        "> **Caveat:** these are the token volumes recorded in the checked-in "
        "snapshots, which were captured at the *calibration sample sizes* "
        "(e.g. `max_examples=2`), not full datasets. A full-dataset run scales "
        "roughly by `(full_N / sample_N)` per benchmark. Treat the totals as the "
        "cost of the recorded configuration and a per-token basis for scaling, "
        "not as the cost of a complete leaderboard run.\n"
    )

    for model_label, model in (("gpt-oss-120b (Cerebras)", "gpt-oss-120b"), ("opus-4.8 (Anthropic)", "opus")):
        lines.append(f"\n## Cost per benchmark — {model_label}\n")
        lines.append("| benchmark | " + " | ".join(HARNESSES) + " |")
        lines.append("|" + "---|" * (len(HARNESSES) + 1))
        totals = {h: 0.0 for h in HARNESSES}
        counts = {h: 0 for h in HARNESSES}
        for bench in sorted(per_bench):
            by_harness = per_bench[bench]
            cells = []
            for h in HARNESSES:
                toks = by_harness.get(h)
                if toks is None:
                    cells.append("—")
                    continue
                c = _cost(toks, model)
                totals[h] += c
                counts[h] += 1
                mark = ""
                if h == "smithers" and bench in projected:
                    mark = "*"
                elif h == "smithers" and bench in smithers_measured:
                    mark = "†"
                cells.append(f"${c:,.4f}{mark}")
            lines.append(f"| {bench} | " + " | ".join(cells) + " |")
        lines.append("| **TOTAL** | " + " | ".join(f"**${totals[h]:,.2f}**" for h in HARNESSES) + " |")
        lines.append(
            "| **AVG/bench** | "
            + " | ".join(
                f"${(totals[h] / counts[h]):,.4f}" if counts[h] else "—" for h in HARNESSES
            )
            + " |"
        )
        lines.append(f"| benchmarks counted | " + " | ".join(str(counts[h]) for h in HARNESSES) + " |")
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--latest", default=str(_BENCH_ROOT / "benchmark_results" / "latest"))
    ap.add_argument("--out", default=str(_BENCH_ROOT / "docs" / "COST_REPORT.md"))
    ap.add_argument("--json", action="store_true", help="print machine-readable summary")
    args = ap.parse_args()

    latest = Path(args.latest)
    per_bench = load_snapshots(latest)
    smithers_measured = {b for b, h in per_bench.items() if "smithers" in h}
    projected = project_smithers(per_bench)

    report = build_report(per_bench, projected, smithers_measured)
    Path(args.out).write_text(report, encoding="utf-8")

    # Summary to stdout.
    summary: dict[str, dict[str, float]] = {}
    for model_label, model in (("gpt_oss_120b", "gpt-oss-120b"), ("opus_4_8", "opus")):
        summary[model_label] = {}
        for h in HARNESSES:
            total = sum(_cost(t, model) for by in per_bench.values() if (t := by.get(h)))
            summary[model_label][h] = round(total, 2)

    if args.json:
        print(json.dumps({"summary": summary, "benchmarks_counted": len(per_bench)}, indent=2))
    else:
        print(f"Wrote {args.out}")
        print(f"Benchmarks with token data: {len(per_bench)}")
        for model_label in summary:
            print(f"\nTotal run cost ({model_label}):")
            for h in HARNESSES:
                print(f"  {h:10s} ${summary[model_label][h]:,.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
