"""Fine-tune all eliza-1 tiers sequentially or in parallel.

Orchestrates full-parameter APOLLO SFT for each of the 5 eliza-1 tiers
(qwen3.5-0.8b, qwen3.5-2b, qwen3.5-4b, qwen3.5-9b, qwen3.6-27b), then
optionally runs eval and quantization on each produced checkpoint.

The actual training is delegated to train_local.py (which owns the
APOLLO optimizer, Liger kernel, and SFTTrainer logic). This script is
a pure orchestrator — it does not re-implement any training logic.

Usage:
    # Dry run — print what would be executed
    uv run python scripts/finetune_all_tiers.py --dry-run \
        --data-path data/final

    # Fine-tune all tiers sequentially (GPU is required)
    uv run --extra train python scripts/finetune_all_tiers.py \
        --data-path data/final --output-dir checkpoints

    # Fine-tune only the two smallest tiers, skip quantization
    uv run --extra train python scripts/finetune_all_tiers.py \
        --tiers qwen3.5-0.8b,qwen3.5-2b \
        --data-path data/final --skip-quant

    # Route all tiers to Nebius
    uv run python scripts/finetune_all_tiers.py \
        --nebius --data-path data/final --output-dir checkpoints
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
log = logging.getLogger("finetune_all_tiers")

# Canonical ordered list of eliza-1 tiers.
ALL_TIERS: list[str] = [
    "qwen3.5-0.8b",
    "qwen3.5-2b",
    "qwen3.5-4b",
    "qwen3.5-9b",
    "qwen3.6-27b",
]

# Quantization pipeline order matches AGENTS.md §3.
# fused_turboquant is excluded: incompatible with Qwen3.5 hybrid linear+full
# attention architecture (18 linear + 6 full attention layers).
QUANT_PIPELINE: list[str] = [
    "turboquant",
    "polarquant",
    "qjl",
]


def _run(
    cmd: list[str],
    *,
    log_file: Path | None = None,
    dry_run: bool = False,
    cwd: Path | None = None,
) -> int:
    """Run a subprocess, optionally capturing stdout+stderr to a log file."""
    log.info("$ %s", " ".join(cmd))
    if dry_run:
        log.info("  [dry-run] skipping")
        return 0
    t0 = time.perf_counter()
    if log_file:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        with log_file.open("w") as fh:
            proc = subprocess.run(
                cmd,
                stdout=fh,
                stderr=subprocess.STDOUT,
                cwd=str(cwd) if cwd else None,
            )
    else:
        proc = subprocess.run(cmd, cwd=str(cwd) if cwd else None)
    elapsed = time.perf_counter() - t0
    log.info("  → exit=%d (%.1fs)", proc.returncode, elapsed)
    return proc.returncode


def _nebius_manifest(
    tier: str,
    entry: Any,
    data_path: Path,
    output_dir: Path,
    timestamp: int,
) -> dict[str, Any]:
    """Generate a Nebius job manifest dict for a single tier."""
    run_name = f"{entry.eliza_short_name}-apollo-{timestamp}"
    return {
        "registry_key": tier,
        "run_name": run_name,
        "hf_id": entry.hf_id,
        "eliza_short_name": entry.eliza_short_name,
        "optimizer": entry.optimizer,
        "optimizer_rank": entry.optimizer_rank,
        "tier": entry.tier.value,
        "train_mem_gb_budget": entry.train_mem_gb_budget,
        "seq_len": entry.seq_len,
        "data_path": str(data_path),
        "output_dir": str(output_dir),
        "launch_command": (
            f"REGISTRY_KEY={tier} RUN_NAME={run_name} "
            f"bash scripts/train_nebius.sh full"
        ),
    }


def _print_nebius_manifests(
    manifests: list[dict[str, Any]],
    output_dir: Path,
    timestamp: int,
) -> None:
    out_file = output_dir / f"nebius_jobs_{timestamp}.json"
    output_dir.mkdir(parents=True, exist_ok=True)
    out_file.write_text(json.dumps(manifests, indent=2))
    log.info("Nebius job manifests written to %s", out_file)
    print("\nNebius submission commands:")
    for m in manifests:
        print(f"  {m['launch_command']}")
    print(f"\nFull manifests: {out_file}")


def finetune_tier(
    tier: str,
    entry: Any,
    data_path: Path,
    output_dir: Path,
    timestamp: int,
    *,
    skip_eval: bool,
    skip_quant: bool,
    dry_run: bool,
) -> dict[str, Any]:
    """Fine-tune one tier: SFT → eval → quantize. Returns a result dict."""
    log_dir = output_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)

    run_name = f"{entry.eliza_short_name}-apollo-{timestamp}"
    checkpoint_dir = output_dir / run_name / "final"
    log_prefix = f"finetune_{tier.replace('.', '_')}_{timestamp}"

    result: dict[str, Any] = {
        "tier": tier,
        "eliza_short_name": entry.eliza_short_name,
        "run_name": run_name,
        "checkpoint": str(checkpoint_dir),
        "eval_score": None,
        "quant_status": {},
        "passed": False,
        "error": None,
    }

    # Stage 1: SFT via run_pipeline.py (delegates to train_local.py internally).
    train_log = log_dir / f"{log_prefix}.log"
    log.info("[%s] starting SFT → %s", tier, train_log)
    train_cmd = [
        sys.executable, "scripts/run_pipeline.py",
        "--registry-key", tier,
        "--run-name", run_name,
        "--train-file", str(data_path / "train.jsonl"),
        "--val-file", str(data_path / "val.jsonl"),
        "--test-file", str(data_path / "test.jsonl"),
        "--eval-mode", "smoke",
        "--skip-quantize",
        "--skip-publish",
        "--skip-throughput-bench",
    ]
    # 27b requires FSDP — flag for the user but do not inject FSDP args here;
    # the user should use train_nebius.sh for cloud tiers.
    if entry.tier.value == "cloud" and os.environ.get("ELIZA_FORCE_LOCAL_TRAIN") != "1":
        log.warning(
            "[%s] tier=%s cannot train locally; set ELIZA_FORCE_LOCAL_TRAIN=1 "
            "to override or use --nebius",
            tier, entry.tier.value,
        )
        result["error"] = "cloud tier requires ELIZA_FORCE_LOCAL_TRAIN=1 or --nebius"
        return result

    rc = _run(train_cmd, log_file=train_log, dry_run=dry_run, cwd=ROOT)
    if rc != 0:
        result["error"] = f"SFT failed (exit {rc})"
        log.error("[%s] SFT failed (exit=%d); see %s", tier, rc, train_log)
        return result
    log.info("[%s] SFT complete → %s", tier, checkpoint_dir)

    # Stage 2: eval_checkpoint.py
    if not skip_eval:
        eval_log = log_dir / f"{log_prefix}_eval.log"
        eval_out = output_dir / run_name / "eval_result.json"
        eval_cmd = [
            sys.executable, "scripts/eval_checkpoint.py",
            "--checkpoint", str(checkpoint_dir),
            "--registry-key", tier,
            "--val-jsonl", str(data_path / "val.jsonl"),
            "--out", str(eval_out),
        ]
        rc = _run(eval_cmd, log_file=eval_log, dry_run=dry_run, cwd=ROOT)
        if rc != 0:
            log.warning("[%s] eval_checkpoint failed (exit=%d)", tier, rc)
        elif not dry_run and eval_out.exists():
            try:
                eval_data = json.loads(eval_out.read_text())
                result["eval_score"] = eval_data.get("format_ok")
            except (json.JSONDecodeError, OSError):
                pass
        log.info("[%s] eval score: %s", tier, result["eval_score"])

    # Stage 3: quantization pipeline (turboquant → polarquant → qjl)
    if not skip_quant:
        quant_pipeline = [q for q in entry.quantization_after if q in QUANT_PIPELINE]
        for quant in quant_pipeline:
            apply_script = ROOT / "scripts" / "quantization" / f"{quant}_apply.py"
            if not apply_script.exists():
                log.warning("[%s] quantizer script not found: %s", tier, apply_script)
                result["quant_status"][quant] = "script_missing"
                continue
            quant_out = output_dir / run_name / f"final-{quant}"
            quant_log = log_dir / f"{log_prefix}_{quant}.log"
            quant_cmd = [
                sys.executable, str(apply_script),
                "--model", str(checkpoint_dir),
                "--output", str(quant_out),
                "--calibration", str(data_path / "val.jsonl"),
                "--calibration-samples", "128",
            ]
            rc = _run(quant_cmd, log_file=quant_log, dry_run=dry_run, cwd=ROOT)
            status = "ok" if rc == 0 else f"failed(exit={rc})"
            result["quant_status"][quant] = status
            if rc != 0:
                log.warning("[%s] quantizer %s failed (exit=%d)", tier, quant, rc)
            else:
                log.info("[%s] quantizer %s done → %s", tier, quant, quant_out)

    result["passed"] = result["error"] is None
    return result


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Fine-tune all eliza-1 tiers (0.8b → 27b) with APOLLO SFT.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument(
        "--tiers",
        default="all",
        help=(
            "Comma-separated list of registry keys to fine-tune. "
            "Default: all (qwen3.5-0.8b,qwen3.5-2b,qwen3.5-4b,qwen3.5-9b,qwen3.6-27b)."
        ),
    )
    ap.add_argument(
        "--data-path",
        default=str(ROOT / "data" / "final"),
        help="Directory containing train.jsonl / val.jsonl / test.jsonl.",
    )
    ap.add_argument(
        "--output-dir",
        default=str(ROOT / "checkpoints"),
        help="Root directory for checkpoints and logs.",
    )
    ap.add_argument(
        "--skip-quant",
        action="store_true",
        help="Skip post-training quantization pipeline.",
    )
    ap.add_argument(
        "--skip-eval",
        action="store_true",
        help="Skip eval_checkpoint.py after each SFT run.",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be executed without running anything.",
    )
    ap.add_argument(
        "--nebius",
        action="store_true",
        help=(
            "Generate Nebius job manifests and print submission commands "
            "instead of running training locally."
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

    data_path = Path(args.data_path)
    output_dir = Path(args.output_dir)
    timestamp = int(time.time())

    log.info(
        "finetune_all_tiers: tiers=%s data=%s output=%s skip_quant=%s skip_eval=%s "
        "dry_run=%s nebius=%s",
        selected_tiers, data_path, output_dir,
        args.skip_quant, args.skip_eval, args.dry_run, args.nebius,
    )

    if not args.dry_run and not data_path.exists():
        log.error("data-path does not exist: %s", data_path)
        return 1

    if args.nebius:
        manifests: list[dict[str, Any]] = []
        for tier in selected_tiers:
            entry = registry_get(tier)
            m = _nebius_manifest(tier, entry, data_path, output_dir, timestamp)
            manifests.append(m)
            log.info("[%s] Nebius manifest generated", tier)
        _print_nebius_manifests(manifests, output_dir, timestamp)
        return 0

    results: list[dict[str, Any]] = []
    for tier in selected_tiers:
        entry = registry_get(tier)
        log.info("=" * 60)
        log.info("tier: %s (%s, %.0f GB GPU budget)", tier, entry.eliza_short_name, entry.train_mem_gb_budget)
        log.info("=" * 60)
        r = finetune_tier(
            tier, entry, data_path, output_dir, timestamp,
            skip_eval=args.skip_eval,
            skip_quant=args.skip_quant,
            dry_run=args.dry_run,
        )
        results.append(r)

    # Final summary
    print("\n" + "=" * 70)
    print(f"{'TIER':<20} {'CHECKPOINT':<35} {'EVAL':>6} {'QUANT':<20} {'STATUS'}")
    print("=" * 70)
    any_failed = False
    for r in results:
        eval_str = f"{r['eval_score']:.3f}" if r["eval_score"] is not None else "n/a"
        quant_ok = all(v == "ok" for v in r["quant_status"].values()) if r["quant_status"] else True
        quant_str = "ok" if quant_ok else "partial"
        status = "PASS" if r["passed"] and (r["error"] is None) else "FAIL"
        if status == "FAIL":
            any_failed = True
        ckpt = Path(r["checkpoint"]).name if r["checkpoint"] else "n/a"
        print(f"{r['eliza_short_name']:<20} {ckpt:<35} {eval_str:>6} {quant_str:<20} {status}")
        if r.get("error"):
            print(f"  error: {r['error']}")
    print("=" * 70)

    summary_path = output_dir / f"finetune_all_summary_{timestamp}.json"
    if not args.dry_run:
        output_dir.mkdir(parents=True, exist_ok=True)
        summary_path.write_text(json.dumps(results, indent=2))
        log.info("summary written to %s", summary_path)

    return 1 if any_failed else 0


if __name__ == "__main__":
    sys.exit(main())
