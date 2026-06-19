"""Run eliza-1 fine-tuned models against cerebras/gpt-oss-120b on standard benchmarks.

Loads quantized eliza-1 checkpoints and runs them against benchmark prompts,
then optionally compares against the Cerebras gpt-oss-120b model on the same
prompts. Produces a JSON results file and a Markdown report.

Benchmarks supported:
  - clawbench   : OpenCLAW-derived instruction-following prompts
  - eliza_harness_action_selection
                : Eliza native action/tool-call accuracy
  - hermes      : legacy alias for the same native tool-call prompt set
  - all         : both of the above

Cerebras comparison requires CEREBRAS_API_KEY in the environment. When the
key is absent the cerebras column is skipped and noted in the report.

Usage:
    # Benchmark all tiers, all benchmarks, compare vs cerebras
    uv run --extra train python scripts/benchmark_vs_cerebras.py \
        --tiers all \
        --benchmark all \
        --output-dir reports/cerebras-comparison

    # Only Eliza harness action selection, skip cerebras, cap at 100 samples
    uv run --extra train python scripts/benchmark_vs_cerebras.py \
        --tiers qwen3.5-2b,qwen3.5-4b \
        --benchmark eliza_harness_action_selection \
        --max-samples 100 \
        --output-dir reports/eliza-harness-action-selection

    # Dry run (no inference)
    uv run python scripts/benchmark_vs_cerebras.py --tiers qwen3.5-0.8b --dry-run
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = ROOT.parent.parent
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

ELIZA_HARNESS_ACTION_SELECTION = "eliza_harness_action_selection"
BENCHMARK_CHOICES = ("clawbench", ELIZA_HARNESS_ACTION_SELECTION, "hermes", "all")
VARIANT_CHOICES = ("trained", "base", "both")

# Benchmark prompt sets — relative to ROOT/data or discoverable from registry.
BENCHMARK_PROMPT_SOURCES: dict[str, str] = {
    "clawbench": "data/final/test.jsonl",
    ELIZA_HARNESS_ACTION_SELECTION: "data/final/test.jsonl",
    "hermes": "data/final/test.jsonl",
}


def _load_results_store_class():
    module_name = "_eliza_benchmark_vs_cerebras_results_store"
    if module_name in sys.modules:
        return sys.modules[module_name].ResultsStore
    rs_path = REPO_ROOT / "packages" / "benchmarks" / "lib" / "results_store.py"
    spec = importlib.util.spec_from_file_location(module_name, rs_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load ResultsStore from {rs_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module.ResultsStore


def _now_millis() -> int:
    return int(time.time() * 1000)


def _tier_slug(tier: str, eliza_short_name: str | None = None) -> str:
    source = eliza_short_name or tier
    if "27b" in source:
        return "27b"
    if "9b" in source:
        return "9b"
    if "4b" in source:
        return "4b"
    if "2b" in source:
        return "2b"
    if "0_8b" in source or "0.8b" in source or "0-8b" in source:
        return "0_8b"
    if "0b" in source:
        return "0b"
    return tier


def _record_run(
    store: Any,
    *,
    model_id: str,
    benchmark: str,
    score: float,
    dataset_version: str,
    code_commit: str,
    raw_json: dict[str, Any],
    ts: int,
) -> int:
    return int(
        store.record_run(
            model_id=model_id,
            benchmark=benchmark,
            score=score,
            dataset_version=dataset_version,
            code_commit=code_commit,
            raw_json=raw_json,
            ts=ts,
        )
    )


def record_results_to_store(
    results: list[dict[str, Any]],
    *,
    db_path: Path | None,
    dataset_version: str,
    code_commit: str,
    cerebras_model: str,
    ts: int | None = None,
) -> list[dict[str, Any]]:
    """Append benchmark_vs_cerebras results to the shared ResultsStore.

    Eliza tier benchmark accuracy rows are recorded as trained model rows using
    the tier's checkpoint path as provenance. Cerebras rows are recorded under
    ``cerebras/<model>`` when the script produced a quality proxy for the same
    benchmark prompt set.
    """
    ResultsStore = _load_results_store_class()
    store = ResultsStore(db_path=db_path)
    recorded: list[dict[str, Any]] = []
    recorded_ts = ts if ts is not None else _now_millis()
    try:
        for tier_result in results:
            tier = str(tier_result.get("tier") or "")
            for variant_result in _variant_results_for_tier(tier_result):
                variant = str(variant_result.get("variant") or "trained")
                model_id = str(variant_result.get("model_id") or "")
                tier_slug = str(variant_result.get("tier") or _tier_slug(tier, model_id))
                model_path = variant_result.get("model_path")
                if variant not in {"base", "trained"} or not model_id:
                    continue
                for benchmark, bench_result in (
                    variant_result.get("benchmarks") or {}
                ).items():
                    if not isinstance(bench_result, dict):
                        continue
                    score = bench_result.get("tool_call_accuracy")
                    if not isinstance(score, (int, float)):
                        continue
                    row_id = _record_run(
                        store,
                        model_id=model_id,
                        benchmark=str(benchmark),
                        score=float(score),
                        dataset_version=dataset_version,
                        code_commit=code_commit,
                        raw_json={
                            "variant": variant,
                            "tier": tier_slug,
                            "tier_key": tier,
                            "model_path": model_path,
                            "score_source": "tool_call_accuracy",
                            "benchmark_result": bench_result,
                        },
                        ts=recorded_ts,
                    )
                    recorded.append(
                        {
                            "rowId": row_id,
                            "modelId": model_id,
                            "variant": variant,
                            "tier": tier_slug,
                            "benchmark": str(benchmark),
                            "score": float(score),
                        }
                    )
            for benchmark, bench_result in (tier_result.get("benchmarks") or {}).items():
                if not isinstance(bench_result, dict):
                    continue
                cerebras = tier_result.get("cerebras")
                if isinstance(cerebras, dict):
                    c_score = cerebras.get("response_quality_proxy")
                    if isinstance(c_score, (int, float)):
                        c_model_id = (
                            str(cerebras.get("model"))
                            if cerebras.get("model")
                            else f"cerebras/{cerebras_model}"
                        )
                        if "/" not in c_model_id:
                            c_model_id = f"cerebras/{c_model_id}"
                        c_row_id = _record_run(
                            store,
                            model_id=c_model_id,
                            benchmark=str(benchmark),
                            score=float(c_score),
                            dataset_version=dataset_version,
                            code_commit=code_commit,
                            raw_json={
                                "variant": "reference",
                                "provider": "cerebras",
                                "score_source": "response_quality_proxy",
                                "tier_context": _tier_slug(tier),
                                "cerebras": cerebras,
                            },
                            ts=recorded_ts,
                        )
                        recorded.append(
                            {
                                "rowId": c_row_id,
                                "modelId": c_model_id,
                                "variant": "reference",
                                "benchmark": str(benchmark),
                                "score": float(c_score),
                            }
                        )
    finally:
        store.close()
    return recorded


def _variant_results_for_tier(tier_result: dict[str, Any]) -> list[dict[str, Any]]:
    variants = tier_result.get("variant_results")
    if isinstance(variants, list):
        return [variant for variant in variants if isinstance(variant, dict)]
    tier = str(tier_result.get("tier") or "")
    eliza_short_name = str(tier_result.get("eliza_short_name") or tier)
    return [
        {
            "variant": "trained",
            "model_id": eliza_short_name,
            "tier": _tier_slug(tier, eliza_short_name),
            "model_path": tier_result.get("checkpoint"),
            "benchmarks": tier_result.get("benchmarks") or {},
        }
    ]


def _is_dry_run_benchmark_result(bench_result: dict[str, Any]) -> bool:
    raw_summary = bench_result.get("raw_summary")
    return bench_result.get("dry_run") is True or (
        isinstance(raw_summary, dict) and raw_summary.get("dry_run") is True
    )


def _benchmark_score_or_dry_run_zero(bench_result: dict[str, Any]) -> float | None:
    score = bench_result.get("tool_call_accuracy")
    if isinstance(score, (int, float)):
        return float(score)
    if _is_dry_run_benchmark_result(bench_result):
        return 0.0
    return None


def matrix_rows_from_results(results: list[dict[str, Any]], cerebras_model: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for tier_result in results:
        tier_slug = _tier_slug(
            str(tier_result.get("tier") or ""),
            str(tier_result.get("eliza_short_name") or "") or None,
        )
        benchmark_names: set[str] = {
            str(benchmark)
            for benchmark in (tier_result.get("requested_benchmarks") or [])
            if isinstance(benchmark, str) and benchmark
        }
        for variant_result in _variant_results_for_tier(tier_result):
            variant = str(variant_result.get("variant") or "trained")
            model_id = str(variant_result.get("model_id") or "")
            tier_slug = str(variant_result.get("tier") or "")
            if variant not in {"base", "trained"} or not model_id:
                continue
            for benchmark, bench_result in (variant_result.get("benchmarks") or {}).items():
                if not isinstance(bench_result, dict):
                    continue
                benchmark_names.add(str(benchmark))
                score = _benchmark_score_or_dry_run_zero(bench_result)
                if score is not None:
                    dry_run = _is_dry_run_benchmark_result(bench_result)
                    rows.append(
                        {
                            "modelId": model_id,
                            "variant": variant,
                            "tier": tier_slug,
                            "benchmark": str(benchmark),
                            "score": score,
                            **({"metrics": {"dryRun": True}} if dry_run else {}),
                            "raw": {
                                **bench_result,
                                **({"dryRun": True} if dry_run else {}),
                            },
                        }
                    )
        for benchmark, bench_result in (tier_result.get("benchmarks") or {}).items():
            if isinstance(bench_result, dict):
                benchmark_names.add(str(benchmark))
        if not benchmark_names:
            continue
        for benchmark in sorted(benchmark_names):
            cerebras = tier_result.get("cerebras")
            if isinstance(cerebras, dict):
                c_score = cerebras.get("response_quality_proxy")
                c_dry_run = cerebras.get("dry_run") is True
                if isinstance(c_score, (int, float)) or c_dry_run:
                    model_id = str(cerebras.get("model") or cerebras_model)
                    if "/" not in model_id:
                        model_id = f"cerebras/{model_id}"
                    rows.append(
                        {
                            "modelId": model_id,
                            "variant": "reference",
                            "provider": "cerebras",
                            "tier": tier_slug,
                            "benchmark": str(benchmark),
                            "score": float(c_score) if isinstance(c_score, (int, float)) else 0.0,
                            **({"metrics": {"dryRun": True}} if c_dry_run else {}),
                            "raw": {
                                **cerebras,
                                **({"dryRun": True} if c_dry_run else {}),
                            },
                        }
                    )
    return rows


def write_matrix_artifact(
    results: list[dict[str, Any]],
    *,
    output_dir: Path,
    cerebras_model: str,
) -> Path:
    import build_eliza1_benchmark_matrix as matrix

    rows = matrix_rows_from_results(results, cerebras_model)
    artifact = matrix.build_artifact(
        rows=rows,
        reference_model_id=(
            cerebras_model if "/" in cerebras_model else f"cerebras/{cerebras_model}"
        ),
        source={"kind": "benchmark_vs_cerebras"},
    )
    return matrix.write_artifact(artifact, output_dir)


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
            req = record.get("request") if isinstance(record.get("request"), dict) else {}
            messages = req.get("messages") or record.get("messages") or []
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
    variants: str = "trained",
    trained_model_path: Path | None = None,
) -> dict[str, Any]:
    """Run benchmarks for one tier and return the results dict."""
    tier_out = output_dir / tier.replace(".", "_")
    tier_out.mkdir(parents=True, exist_ok=True)

    ckpt = trained_model_path or _find_checkpoint(checkpoints_dir, tier, entry)
    if trained_model_path is not None:
        log.info("[%s] using explicit trained model path: %s", tier, ckpt)
    elif ckpt is None:
        log.warning("[%s] no trained checkpoint found under %s", tier, checkpoints_dir)
    else:
        log.info("[%s] using trained checkpoint: %s", tier, ckpt)
    result: dict[str, Any] = {
        "tier": tier,
        "eliza_short_name": entry.eliza_short_name,
        "base_model_id": entry.hf_id,
        "requested_benchmarks": benchmarks,
        "checkpoint": str(ckpt) if ckpt else None,
        "benchmarks": {},
        "variant_results": [],
        "cerebras": {},
        "error": None if ckpt is not None or variants == "base" else "no checkpoint found",
    }

    test_file = ROOT / "data" / "final" / "test.jsonl"

    variant_plan: list[tuple[str, str, str]] = []
    if variants in {"base", "both"}:
        variant_plan.append(("base", entry.hf_id, entry.hf_id))
    if variants in {"trained", "both"} and (ckpt is not None or dry_run):
        variant_plan.append(
            (
                "trained",
                entry.eliza_short_name,
                str(ckpt) if ckpt is not None else entry.eliza_short_name,
            )
        )

    for variant, model_id, model_path in variant_plan:
        variant_benchmarks: dict[str, Any] = {}
        for bench in benchmarks:
            bench_out = tier_out / variant / bench
            log.info("[%s] running %s benchmark: %s", tier, variant, bench)
            summary = _run_native_tool_bench(
                model_path,
                test_file,
                bench_out,
                max_samples=max_samples,
                dry_run=dry_run,
            )
            tool_accuracy = _extract_tool_call_accuracy(summary) if summary else None
            variant_benchmarks[bench] = {
                "tool_call_accuracy": tool_accuracy,
                "raw_summary": summary,
            }
            log.info(
                "[%s] %s %s tool_call_accuracy=%s",
                tier,
                variant,
                bench,
                tool_accuracy,
            )
        variant_result = {
            "variant": variant,
            "model_id": model_id,
            "model_path": model_path,
            "tier": _tier_slug(tier, entry.eliza_short_name),
            "benchmarks": variant_benchmarks,
        }
        result["variant_results"].append(variant_result)
        if variant == "trained":
            result["benchmarks"] = variant_benchmarks

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
                max_tokens=2048,
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
        headers += ["Cerebras Quality", "Cerebras Latency (ms)"]
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
        "--variants",
        choices=VARIANT_CHOICES,
        default="trained",
        help=(
            "Which Eliza variant(s) to benchmark per tier: trained checkpoint, "
            "base HF model, or both. Default: trained."
        ),
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
        "--trained-model-path",
        help=(
            "Explicit Transformers-compatible trained checkpoint path. "
            "Use with exactly one --tiers entry; GGUF bundle paths are not "
            "accepted by the native Transformers benchmark loader."
        ),
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would run without running inference.",
    )
    ap.add_argument(
        "--results-db",
        help=(
            "Optional shared benchmark ResultsStore SQLite path. When set, "
            "benchmark scores are appended for matrix/trending viewers."
        ),
    )
    ap.add_argument(
        "--dataset-version",
        default="unknown",
        help="Dataset version stored with ResultsStore rows.",
    )
    ap.add_argument(
        "--code-commit",
        default="unknown",
        help="Code commit stored with ResultsStore rows.",
    )
    ap.add_argument(
        "--matrix-output-dir",
        help=(
            "Optional directory where benchmark-matrix.json is written from "
            "this run's results."
        ),
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
    if args.trained_model_path and len(selected_tiers) != 1:
        log.error("--trained-model-path requires exactly one selected tier")
        return 1

    benchmarks: list[str] = (
        ["clawbench", ELIZA_HARNESS_ACTION_SELECTION]
        if args.benchmark == "all"
        else [args.benchmark]
    )

    output_dir = Path(args.output_dir)
    checkpoints_dir = Path(args.checkpoints_dir)
    trained_model_path = (
        Path(args.trained_model_path).expanduser().resolve()
        if args.trained_model_path
        else None
    )
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
            variants=args.variants,
            trained_model_path=trained_model_path,
        )
        all_results.append(r)

    # Write JSON results
    results_path = output_dir / f"benchmark_results_{timestamp}.json"
    results_path.write_text(json.dumps(all_results, indent=2))
    log.info("JSON results written to %s", results_path)

    recorded_rows: list[dict[str, Any]] = []
    if args.results_db:
        recorded_rows = record_results_to_store(
            all_results,
            db_path=Path(args.results_db).expanduser().resolve(),
            dataset_version=args.dataset_version,
            code_commit=args.code_commit,
            cerebras_model=args.cerebras_model,
        )
        recorded_path = output_dir / f"results_store_rows_{timestamp}.json"
        recorded_path.write_text(json.dumps(recorded_rows, indent=2))
        log.info(
            "recorded %d row(s) to ResultsStore and wrote %s",
            len(recorded_rows),
            recorded_path,
        )

    matrix_path: Path | None = None
    if args.matrix_output_dir:
        matrix_path = write_matrix_artifact(
            all_results,
            output_dir=Path(args.matrix_output_dir).expanduser().resolve(),
            cerebras_model=args.cerebras_model,
        )
        log.info("benchmark matrix artifact written to %s", matrix_path)

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
    if recorded_rows:
        print(f"ResultsStore rows: {len(recorded_rows)}")
    if matrix_path:
        print(f"Matrix:  {matrix_path}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
