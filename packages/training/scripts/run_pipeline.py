"""End-to-end training pipeline: train → quantize → benchmark for any model in the registry.

Single command does:
  1. Pre-train benchmark (base model)            → benchmarks/<run>/base/
  2. Full-parameter SFT with APOLLO              → checkpoints/<run>/final/
  3. Post-train benchmark (fine-tuned)           → benchmarks/<run>/finetuned/
  4. PolarQuant + TurboQuant quantization        → checkpoints/<run>/{final-polarquant,final-turboquant}/
  5. Quantized benchmark                          → benchmarks/<run>/{polarquant,turboquant}/

Usage:
    # Smoke test on Qwen3.5-2B (smallest eliza-1 size, trains on 16 GB)
    uv run --extra train python scripts/run_pipeline.py \
        --registry-key qwen3.5-2b \
        --max-samples 1000 --epochs 1 --skip-base-bench

    # Production run on Qwen3.5-2B (eliza-1-2b)
    uv run --extra train python scripts/run_pipeline.py \
        --registry-key qwen3.5-2b \
        --epochs 3

    # Train from runtime trajectory export(s)
    uv run --extra train python scripts/run_pipeline.py \
        --registry-key qwen3.5-2b \
        --trajectory-export ../trajectories/export.jsonl \
        --epochs 1

    # Cloud-tier run on Qwen3.6-27B (eliza-1-27b) — needs 2× H200 SXM,
    # use scripts/train_nebius.sh which wraps run_pipeline.py with FSDP.
"""

from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from training.model_registry import get as registry_get  # noqa: E402

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("pipeline")


def run(cmd: list[str], *, env: dict | None = None) -> int:
    log.info("$ %s", " ".join(cmd))
    t0 = time.perf_counter()
    rc = subprocess.run(cmd, env=env).returncode
    log.info("  → exit=%d (%.1fs)", rc, time.perf_counter() - t0)
    return rc


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--registry-key", required=True,
                    help="One of: qwen3.5-2b (eliza-1-2b), qwen3.5-9b "
                         "(eliza-1-9b), qwen3.6-27b (eliza-1-27b).")
    ap.add_argument("--run-name", default=None,
                    help="Default: <registry-key>-apollo-<unix-ts>.")
    ap.add_argument("--epochs", type=float, default=3.0)
    ap.add_argument(
        "--lr", type=float, default=1e-5,
        help="Learning rate for full-parameter SFT with APOLLO. Default "
             "1e-5 follows the APOLLO paper §5 SFT recipe — train_local.py's "
             "own default of 2e-4 is the LoRA rate and would diverge here.",
    )
    ap.add_argument("--max-samples", type=int, default=0,
                    help="Cap training samples (0 = full corpus).")
    ap.add_argument("--train-file", default=None,
                    help="Training JSONL. Defaults to data/final/train.jsonl "
                         "unless --trajectory-export is provided.")
    ap.add_argument("--val-file", default=None,
                    help="Validation JSONL. Defaults to data/final/val.jsonl "
                         "unless --trajectory-export is provided.")
    ap.add_argument("--test-file", default=None,
                    help="Benchmark JSONL. Defaults to data/final/test.jsonl "
                         "unless --trajectory-export is provided.")
    ap.add_argument(
        "--trajectory-export",
        action="append",
        default=[],
        help="Runtime trajectory export JSON/JSONL file or directory. Repeat "
             "to merge multiple exports into one SFT split set.",
    )
    ap.add_argument(
        "--trajectory-tasks",
        default="",
        help="Optional comma-separated task_type allowlist for trajectory "
             "exports before train/val/test splitting.",
    )
    ap.add_argument("--bench-per-bucket", type=int, default=200)
    ap.add_argument("--skip-base-bench", action="store_true")
    ap.add_argument("--skip-finetune", action="store_true")
    ap.add_argument("--skip-quantize", action="store_true")
    ap.add_argument("--skip-bench", action="store_true")
    ap.add_argument(
        "--quantizers", default="polarquant,fused_turboquant,qjl",
        help="Comma-separated list of quantizers to apply post-training. "
             "Default = full stack: polarquant (4-bit weights) + "
             "fused_turboquant (4-bit V cache, Triton kernels) + qjl "
             "(1-bit K cache). Pass `polarquant,turboquant` for the "
             "pure-PyTorch path if Triton is unavailable.",
    )
    args = ap.parse_args()

    entry = registry_get(args.registry_key)
    if not entry.can_train_locally and not args.skip_finetune:
        raise SystemExit(
            f"{entry.short_name} (tier={entry.tier.value}) cannot train locally. "
            f"Use train_nebius.sh or pass --skip-finetune."
        )

    run_name = args.run_name or f"{entry.short_name}-apollo-{int(time.time())}"
    ckpt_dir = ROOT / "checkpoints" / run_name
    bench_dir = ROOT / "benchmarks" / run_name
    bench_dir.mkdir(parents=True, exist_ok=True)

    summary = {
        "registry_key": entry.short_name,
        "model": entry.hf_id,
        "run_name": run_name,
        "started": time.time(),
        "stages": {},
    }

    train_file = Path(args.train_file) if args.train_file else ROOT / "data" / "final" / "train.jsonl"
    val_file = Path(args.val_file) if args.val_file else ROOT / "data" / "final" / "val.jsonl"
    test_file = Path(args.test_file) if args.test_file else ROOT / "data" / "final" / "test.jsonl"

    if args.trajectory_export:
        trajectory_data_dir = ROOT / "data" / "trajectory-runs" / run_name
        cmd = [
            "uv", "run", "--extra", "train", "python",
            "scripts/trajectories_to_sft.py",
            "--output-dir", str(trajectory_data_dir),
        ]
        for input_path in args.trajectory_export:
            cmd += ["--input", input_path]
        if args.max_samples:
            cmd += ["--max-records", str(args.max_samples)]
        if args.trajectory_tasks:
            cmd += ["--tasks", args.trajectory_tasks]
        rc = run(cmd)
        summary["stages"]["trajectory_dataset"] = {
            "exit": rc,
            "output_dir": str(trajectory_data_dir),
        }
        if rc != 0:
            log.error("trajectory dataset build failed; aborting")
            (bench_dir / "pipeline-summary.json").write_text(json.dumps(summary, indent=2))
            return 1
        train_file = trajectory_data_dir / "train.jsonl"
        val_file = trajectory_data_dir / "val.jsonl"
        test_file = trajectory_data_dir / "test.jsonl"

    summary["train_file"] = str(train_file)
    summary["val_file"] = str(val_file)
    summary["test_file"] = str(test_file)

    # 1. Base benchmark
    if not args.skip_base_bench and not args.skip_bench:
        rc = run([
            "uv", "run", "--extra", "train", "python",
            "scripts/benchmark/native_tool_call_bench.py",
            "--model", entry.hf_id,
            "--test-file", str(test_file),
            "--out-dir", str(bench_dir / "base"),
            "--max-per-bucket", str(args.bench_per_bucket),
        ])
        summary["stages"]["base_bench"] = {"exit": rc}
        if rc != 0:
            log.error("base benchmark failed")

    # 2. Fine-tune
    if not args.skip_finetune:
        cmd = [
            "uv", "run", "--extra", "train", "python",
            "scripts/train_local.py",
            "--registry-key", entry.short_name,
            "--epochs", str(args.epochs),
            "--lr", str(args.lr),
            "--run-name", run_name,
            "--full-finetune",
            "--use-liger", "on",
            "--train-file", str(train_file),
            "--val-file", str(val_file),
        ]
        if args.max_samples and not args.trajectory_export:
            cmd += ["--max-samples", str(args.max_samples)]
        rc = run(cmd)
        summary["stages"]["finetune"] = {"exit": rc, "checkpoint": str(ckpt_dir / "final")}
        if rc != 0:
            log.error("finetune failed; aborting")
            (bench_dir / "pipeline-summary.json").write_text(json.dumps(summary, indent=2))
            return 1

    # 3. Fine-tuned benchmark
    if not args.skip_bench:
        rc = run([
            "uv", "run", "--extra", "train", "python",
            "scripts/benchmark/native_tool_call_bench.py",
            "--model", str(ckpt_dir / "final"),
            "--test-file", str(test_file),
            "--out-dir", str(bench_dir / "finetuned"),
            "--max-per-bucket", str(args.bench_per_bucket),
        ])
        summary["stages"]["finetuned_bench"] = {"exit": rc}

    # 4. Quantize
    quantizers = [q.strip() for q in args.quantizers.split(",") if q.strip()]
    if not args.skip_quantize:
        for q in quantizers:
            if q not in entry.quantization_after:
                log.warning("registry says %s is not in quant list for %s; running anyway",
                            q, entry.short_name)
            apply_script = ROOT / "scripts" / "quantization" / f"{q}_apply.py"
            if not apply_script.exists():
                log.error("missing quantizer script %s", apply_script)
                continue
            out_path = ckpt_dir / f"final-{q}"
            rc = run([
                "uv", "run", "--extra", "train", "python", str(apply_script),
                "--model", str(ckpt_dir / "final"),
                "--output", str(out_path),
                "--calibration", str(val_file),
                "--calibration-samples", "128",
            ])
            summary["stages"][f"quantize_{q}"] = {"exit": rc, "output": str(out_path)}

    # 5. Quantized benchmarks (where the runner supports the format)
    if not args.skip_bench:
        for q in quantizers:
            ck = ckpt_dir / f"final-{q}"
            if not ck.exists():
                continue
            rc = run([
                "uv", "run", "--extra", "train", "python",
                "scripts/benchmark/native_tool_call_bench.py",
                "--model", str(ck),
                "--test-file", str(test_file),
                "--out-dir", str(bench_dir / q),
                "--max-per-bucket", str(args.bench_per_bucket),
            ])
            summary["stages"][f"{q}_bench"] = {"exit": rc}

    summary["finished"] = time.time()
    summary["elapsed_s"] = summary["finished"] - summary["started"]
    (bench_dir / "pipeline-summary.json").write_text(json.dumps(summary, indent=2))
    log.info("pipeline complete: %s", bench_dir / "pipeline-summary.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
