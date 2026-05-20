"""Run eliza-1 fine-tuned models against cerebras/gpt-oss-120b on standard benchmarks.

Loads quantized eliza-1 checkpoints and runs them against benchmark prompts,
then optionally compares against the Cerebras gpt-oss-120b model on the same
prompts. Produces a JSON results file and a Markdown report.

Benchmarks supported:
  - clawbench   : OpenCLAW-derived instruction-following prompts
  - hermes      : Hermes-adapter native tool-call accuracy (structural + content)
  - all         : both of the above

Cerebras comparison requires CEREBRAS_API_KEY in the environment. When the
key is absent the cerebras column is skipped and noted in the report.

Usage:
    # Benchmark all tiers, all benchmarks, compare vs cerebras
    uv run --extra train python scripts/benchmark_vs_cerebras.py \
        --tiers all \
        --benchmark all \
        --output-dir reports/cerebras-comparison

    # Only hermes, skip cerebras, cap at 100 samples
    uv run --extra train python scripts/benchmark_vs_cerebras.py \
        --tiers qwen3.5-2b,qwen3.5-4b \
        --benchmark hermes \
        --max-samples 100 \
        --output-dir reports/hermes-only

    # Dry run (no inference)
    uv run python scripts/benchmark_vs_cerebras.py --tiers qwen3.5-0.8b --dry-run
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("benchmark_vs_cerebras")

ALL_TIERS: list[str] = [
    "qwen3.5-0.8b",
    "qwen3.5-2b",
    "qwen3.5-4b",
    "qwen3.5-9b",
    "qwen3.6-27b",
]

BENCHMARK_CHOICES = ("clawbench", "hermes", "all")

# Benchmark prompt sets — relative to ROOT/data or discoverable from registry.
BENCHMARK_PROMPT_SOURCES: dict[str, str] = {
    "clawbench": "data/final/test.jsonl",
    "hermes": "data/final/test.jsonl",
}


def _find_checkpoint(output_dir: Path, tier: str, entry: Any) -> Path | None:
    """Locate the quantized or plain final checkpoint for a tier.

    Search order: polarquant → fused_turboquant → turboquant → plain final.
    Returns None if no checkpoint is found.

    Matches directories starting with any of:
    - entry.eliza_short_name (e.g. "eliza-1-0_8b")
    - tier with dots→dashes (e.g. "qwen3-5-0-8b")
    - tier safe variant (e.g. "eliza-1-qwen3_5_0_8b" for APOLLO runs)
    """
    eliza_name = entry.eliza_short_name
    safe_tier = tier.replace(".", "_").replace("-", "_")
    apollo_prefix = f"eliza-1-{safe_tier}"
    candidates: list[Path] = []
    if output_dir.exists():
        for d in sorted(output_dir.iterdir(), reverse=True):
            if d.is_dir() and (
                d.name.startswith(eliza_name)
                or d.name.startswith(tier.replace(".", "-"))
                or d.name.startswith(apollo_prefix)
            ):
                candidates.append(d)

    for run_dir in candidates:
        for quant in ("polarquant", "fused_turboquant", "turboquant", "final"):
            ckpt = run_dir / f"final-{quant}" if quant != "final" else run_dir / "final"
            if ckpt.exists():
                return ckpt
    return None


def _run_native_tool_bench(
    model_path: str,
    test_file: Path,
    out_dir: Path,
    *,
    max_samples: int,
    dry_run: bool,
) -> dict[str, Any] | None:
    """Run the native tool-call benchmark and return the summary dict."""
    bench_script = ROOT / "scripts" / "benchmark" / "native_tool_call_bench.py"
    if not bench_script.exists():
        log.warning("benchmark script not found: %s", bench_script)
        return None
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        sys.executable, str(bench_script),
        "--model", model_path,
        "--test-file", str(test_file),
        "--out-dir", str(out_dir),
        "--max-per-bucket", str(max_samples),
    ]
    log.info("$ %s", " ".join(cmd))
    if dry_run:
        log.info("  [dry-run] skipping")
        return {"dry_run": True}
    t0 = time.perf_counter()
    rc = subprocess.run(cmd, cwd=str(ROOT)).returncode
    elapsed = time.perf_counter() - t0
    log.info("  → exit=%d (%.1fs)", rc, elapsed)
    if rc != 0:
        return None
    summary_path = out_dir / "summary.json"
    if summary_path.exists():
        try:
            return json.loads(summary_path.read_text())
        except json.JSONDecodeError:
            return None
    return None


def _extract_tool_call_accuracy(summary: dict[str, Any] | None) -> float | None:
    """Extract micro-averaged tool-call structure accuracy from a bench summary."""
    if not summary:
        return None
    buckets = summary.get("buckets") or {}
    num = 0
    den = 0
    for b in buckets.values():
        if not isinstance(b, dict):
            continue
        n = int(b.get("n") or 0)
        if n <= 0:
            continue
        ok = b.get("structure_ok")
        if ok is None:
            continue
        num += int(ok)
        den += n
    return round(num / den, 4) if den > 0 else None


def _call_cerebras_on_prompts(
    prompts: list[str],
    cerebras_model: str,
    *,
    max_tokens: int = 512,
) -> list[dict[str, Any]]:
    """Call Cerebras on a list of prompts. Returns a list of result dicts."""
    from cerebras_client import CerebrasClient, CerebrasError

    client = CerebrasClient(model=cerebras_model)
    results: list[dict[str, Any]] = []
    for i, prompt in enumerate(prompts):
        t0 = time.perf_counter()
        try:
            text = client.chat(
                [{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=max_tokens,
            )
            latency_ms = (time.perf_counter() - t0) * 1000
            results.append({
                "prompt_idx": i,
                "response": text,
                "latency_ms": round(latency_ms, 1),
                "error": None,
            })
        except CerebrasError as e:
            latency_ms = (time.perf_counter() - t0) * 1000
            log.warning("cerebras error on prompt %d: %s", i, e)
            results.append({
                "prompt_idx": i,
                "response": None,
                "latency_ms": round(latency_ms, 1),
                "error": str(e),
            })
    return results


def _load_prompts(test_file: Path, max_samples: int) -> list[str]:
    """Load prompt strings from a JSONL file."""
    prompts: list[str] = []
    if not test_file.exists():
        return prompts
    with test_file.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            # Extract the last user turn as the prompt
            messages = record.get("messages", [])
            if messages:
                for m in reversed(messages):
                    if m.get("role") == "user":
                        content = m.get("content", "")
                        if isinstance(content, str):
                            prompts.append(content)
                        break
            if len(prompts) >= max_samples:
                break
    return prompts


def _compute_response_quality_proxy(responses: list[dict[str, Any]]) -> float | None:
    """Proxy response quality: fraction of non-empty, non-error responses."""
    if not responses:
        return None
    good = sum(1 for r in responses if r.get("response") and not r.get("error"))
    return round(good / len(responses), 4)


def _latency_ms_per_token(
    responses: list[dict[str, Any]],
) -> float | None:
    """Average ms/response (proxy for ms/token — actual tokenization not run here)."""
    latencies = [r["latency_ms"] for r in responses if r.get("latency_ms") is not None]
    return round(sum(latencies) / len(latencies), 1) if latencies else None


def benchmark_tier(
    tier: str,
    entry: Any,
    checkpoints_dir: Path,
    output_dir: Path,
    benchmarks: list[str],
    *,
    cerebras_model: str,
    max_samples: int,
    dry_run: bool,
    cerebras_available: bool,
) -> dict[str, Any]:
    """Run benchmarks for one tier and return the results dict."""
    timestamp = int(time.time())
    tier_out = output_dir / tier.replace(".", "_")
    tier_out.mkdir(parents=True, exist_ok=True)

    ckpt = _find_checkpoint(checkpoints_dir, tier, entry)
    if ckpt is None:
        log.warning("[%s] no checkpoint found under %s", tier, checkpoints_dir)
        return {
            "tier": tier,
            "eliza_short_name": entry.eliza_short_name,
            "checkpoint": None,
            "benchmarks": {},
            "cerebras": {},
            "error": "no checkpoint found",
        }

    log.info("[%s] using checkpoint: %s", tier, ckpt)
    result: dict[str, Any] = {
        "tier": tier,
        "eliza_short_name": entry.eliza_short_name,
        "checkpoint": str(ckpt),
        "benchmarks": {},
        "cerebras": {},
        "error": None,
    }

    test_file = ROOT / "data" / "final" / "test.jsonl"

    for bench in benchmarks:
        bench_out = tier_out / bench
        log.info("[%s] running benchmark: %s", tier, bench)
        summary = _run_native_tool_bench(
            str(ckpt),
            test_file,
            bench_out,
            max_samples=max_samples,
            dry_run=dry_run,
        )
        tool_accuracy = _extract_tool_call_accuracy(summary) if summary else None
        result["benchmarks"][bench] = {
            "tool_call_accuracy": tool_accuracy,
            "raw_summary": summary,
        }
        log.info("[%s] %s tool_call_accuracy=%s", tier, bench, tool_accuracy)

    # Cerebras comparison
    if cerebras_available:
        log.info("[%s] running cerebras comparison (%s)", tier, cerebras_model)
        prompts = _load_prompts(test_file, max_samples)
        if not prompts:
            log.warning("[%s] no prompts loaded from %s", tier, test_file)
        elif dry_run:
            log.info("[%s] [dry-run] skipping cerebras inference", tier)
            result["cerebras"] = {"dry_run": True, "n_prompts": len(prompts)}
        else:
            t0 = time.perf_counter()
            cerebras_results = _call_cerebras_on_prompts(
                prompts,
                cerebras_model,
                max_tokens=512,
            )
            elapsed = time.perf_counter() - t0
            quality = _compute_response_quality_proxy(cerebras_results)
            avg_latency = _latency_ms_per_token(cerebras_results)
            result["cerebras"] = {
                "model": cerebras_model,
                "n_prompts": len(prompts),
                "response_quality_proxy": quality,
                "avg_latency_ms": avg_latency,
                "elapsed_s": round(elapsed, 1),
            }
            log.info(
                "[%s] cerebras quality=%s avg_latency=%.1f ms",
                tier, quality, avg_latency or 0,
            )
    else:
        result["cerebras"] = {"skipped": "CEREBRAS_API_KEY not set"}

    return result


def _write_markdown_report(
    results: list[dict[str, Any]],
    benchmarks: list[str],
    cerebras_model: str,
    cerebras_available: bool,
    output_path: Path,
) -> None:
    lines: list[str] = [
        "# eliza-1 vs Cerebras Benchmark Report",
        "",
        f"Generated: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}",
        f"Cerebras model: {cerebras_model if cerebras_available else 'N/A (CEREBRAS_API_KEY not set)'}",
        f"Benchmarks: {', '.join(benchmarks)}",
        "",
        "## Results",
        "",
    ]

    # Header row
    headers = ["Tier", "Checkpoint", "Tool-call Acc"]
    for b in benchmarks:
        headers.append(f"{b} Acc")
    if cerebras_available:
        headers += [f"Cerebras Quality", "Cerebras Latency (ms)"]
    lines.append("| " + " | ".join(headers) + " |")
    lines.append("| " + " | ".join(["---"] * len(headers)) + " |")

    for r in results:
        tier_name = r.get("eliza_short_name", r.get("tier", "?"))
        ckpt = Path(r["checkpoint"]).name if r.get("checkpoint") else "missing"
        if r.get("error") and not r.get("benchmarks"):
            row = [tier_name, ckpt] + ["error"] * (len(headers) - 2)
            lines.append("| " + " | ".join(row) + " |")
            continue

        # Take first benchmark's tool_call_accuracy for the summary column
        first_acc = "n/a"
        bench_accs: list[str] = []
        for b in benchmarks:
            acc = r["benchmarks"].get(b, {}).get("tool_call_accuracy")
            val = f"{acc:.3f}" if acc is not None else "n/a"
            bench_accs.append(val)
            if first_acc == "n/a" and acc is not None:
                first_acc = f"{acc:.3f}"

        row = [tier_name, ckpt, first_acc] + bench_accs
        if cerebras_available:
            c = r.get("cerebras", {})
            q = c.get("response_quality_proxy")
            lat = c.get("avg_latency_ms")
            row += [
                f"{q:.3f}" if q is not None else "n/a",
                f"{lat:.0f}" if lat is not None else "n/a",
            ]
        lines.append("| " + " | ".join(str(x) for x in row) + " |")

    if not cerebras_available:
        lines += [
            "",
            "> **Note:** Cerebras comparison skipped — `CEREBRAS_API_KEY` not set.",
            "> Export the key and re-run to include the Cerebras column.",
        ]

    output_path.write_text("\n".join(lines) + "\n")
    log.info("Markdown report written to %s", output_path)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Benchmark eliza-1 fine-tuned models vs cerebras/gpt-oss-120b.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        "--tiers",
        default="all",
        help="Comma-separated tier keys. Default: all.",
    )
    ap.add_argument(
        "--benchmark",
        choices=BENCHMARK_CHOICES,
        default="all",
        help="Which benchmark to run. Default: all.",
    )
    ap.add_argument(
        "--cerebras-model",
        default="gpt-oss-120b",
        help="Cerebras model id to compare against. Default: gpt-oss-120b.",
    )
    ap.add_argument(
        "--max-samples",
        type=int,
        default=500,
        help="Max benchmark prompts per tier per benchmark. Default: 500.",
    )
    ap.add_argument(
        "--output-dir",
        default=str(ROOT / "reports" / "cerebras-comparison"),
        help="Output directory for results and report.",
    )
    ap.add_argument(
        "--checkpoints-dir",
        default=str(ROOT / "checkpoints"),
        help="Root directory to search for tier checkpoints.",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would run without running inference.",
    )
    args = ap.parse_args()

    from training.model_registry import REGISTRY, get as registry_get

    if args.tiers == "all":
        selected_tiers = ALL_TIERS
    else:
        selected_tiers = [t.strip() for t in args.tiers.split(",") if t.strip()]
        for t in selected_tiers:
            try:
                registry_get(t)
            except KeyError:
                log.error("unknown tier %r; known: %s", t, sorted(REGISTRY))
                return 1

    benchmarks: list[str] = (
        ["clawbench", "hermes"] if args.benchmark == "all" else [args.benchmark]
    )

    output_dir = Path(args.output_dir)
    checkpoints_dir = Path(args.checkpoints_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Check Cerebras availability
    cerebras_api_key = os.environ.get("CEREBRAS_API_KEY")
    cerebras_available = bool(cerebras_api_key)
    if not cerebras_available:
        log.info(
            "CEREBRAS_API_KEY not set — cerebras comparison will be skipped. "
            "Export CEREBRAS_API_KEY to enable it."
        )

    timestamp = int(time.time())
    all_results: list[dict[str, Any]] = []

    for tier in selected_tiers:
        entry = registry_get(tier)
        log.info("=" * 60)
        log.info("benchmarking tier: %s (%s)", tier, entry.eliza_short_name)
        r = benchmark_tier(
            tier, entry, checkpoints_dir, output_dir, benchmarks,
            cerebras_model=args.cerebras_model,
            max_samples=args.max_samples,
            dry_run=args.dry_run,
            cerebras_available=cerebras_available,
        )
        all_results.append(r)

    # Write JSON results
    results_path = output_dir / f"benchmark_results_{timestamp}.json"
    results_path.write_text(json.dumps(all_results, indent=2))
    log.info("JSON results written to %s", results_path)

    # Write Markdown report
    report_path = output_dir / f"benchmark_report_{timestamp}.md"
    _write_markdown_report(
        all_results, benchmarks,
        args.cerebras_model, cerebras_available,
        report_path,
    )

    # Print summary table
    print("\n" + "=" * 70)
    print(f"{'TIER':<20} {'TOOL-CALL ACC':>14} {'CEREBRAS QUALITY':>18}")
    print("=" * 70)
    for r in all_results:
        tier_name = r.get("eliza_short_name", r.get("tier", "?"))
        first_acc = None
        for b in benchmarks:
            acc = r.get("benchmarks", {}).get(b, {}).get("tool_call_accuracy")
            if acc is not None:
                first_acc = acc
                break
        acc_str = f"{first_acc:.3f}" if first_acc is not None else "n/a"
        c_quality = r.get("cerebras", {}).get("response_quality_proxy")
        c_str = f"{c_quality:.3f}" if c_quality is not None else "n/a"
        print(f"{tier_name:<20} {acc_str:>14} {c_str:>18}")
    print("=" * 70)
    print(f"\nResults: {results_path}")
    print(f"Report:  {report_path}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
