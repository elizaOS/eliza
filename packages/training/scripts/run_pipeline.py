"""End-to-end training pipeline: corpus → train → quantize → benchmark → (publish).

Stages (skippable individually; see flags):

  0. From-scratch corpus build (--from-scratch)   → data/final/{train,val,test}.jsonl
  1. Pre-train benchmark (base model)             → benchmarks/<run>/base/
  2. Full-parameter SFT with APOLLO               → checkpoints/<run>/final/
  3. Post-train benchmark (fine-tuned)            → benchmarks/<run>/finetuned/
  4. Aggregate evals + gate report                → checkpoints/<run>/evals/aggregate.json,
                                                     checkpoints/<run>/gate_report.json
  5. PolarQuant + TurboQuant + QJL quantization   → checkpoints/<run>/final-<q>/
  6. Quantized benchmark                          → benchmarks/<run>/<q>/
  6b. Eliza-1-typed GGUF bundle (--eliza1-bundle,  → checkpoints/<run>/eliza1-optimized/
      auto-on if the elizaOS/llama.cpp fork is       (Q4_POLAR GGUF + qjl_config.json +
      found): optimize_for_eliza1.py +                turboquant.json + eliza1_manifest.json),
      optional DFlash drafter (--dflash-drafter)     checkpoints/<run>/dflash/drafter-<tier>.gguf
  6c. Throughput bench (llama-bench on the GGUFs)  → checkpoints/<run>/evals/throughput.json
      — prefill + gen tokens/sec, CUDA build if       (best -fa 1 -b 2048 -ngl 99 on GPU)
      available; --skip-throughput-bench to skip
  7. Publish (--publish, requires --bundle-dir)   → python -m scripts.publish.orchestrator

Usage:
    # Validation smoke on the smallest Eliza-1 size, tiny 1k-per-source mix.
    uv run --extra train python scripts/run_pipeline.py \
        --registry-key qwen3-0.6b \
        --from-scratch --sample-per-source 1000 \
        --epochs 1 --eval-mode smoke

    # Only build the validation dataset (skip everything else).
    uv run python scripts/run_pipeline.py \
        --registry-key qwen3-0.6b --from-scratch --sample-per-source 1000 \
        --skip-base-bench --skip-finetune --skip-quantize --skip-bench

    # Production run on eliza-1-2b.
    uv run --extra train python scripts/run_pipeline.py \
        --registry-key eliza-1-2b --epochs 3

    # Train from runtime trajectory export(s)
    uv run --extra train python scripts/run_pipeline.py \
        --registry-key eliza-1-2b \
        --trajectory-export ../trajectories/export.jsonl --epochs 1

    # Cloud-tier run on eliza-1-27b — needs 2× H200 SXM,
    # use scripts/train_nebius.sh which wraps run_pipeline.py with FSDP.
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

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from training.model_registry import get as registry_get  # noqa: E402
from benchmarks.eliza1_gates import apply_gates, normalize_tier  # noqa: E402

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("pipeline")


def run(cmd: list[str], *, env: dict | None = None, cwd: Path | None = None) -> int:
    log.info("$ %s", " ".join(cmd))
    t0 = time.perf_counter()
    rc = subprocess.run(cmd, env=env, cwd=str(cwd) if cwd else None).returncode
    log.info("  → exit=%d (%.1fs)", rc, time.perf_counter() - t0)
    return rc


def _read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def _resolve_eliza1_llama_cpp() -> Path | None:
    """Locate the elizaOS/llama.cpp fork (Q4_POLAR / QJL1_256 / dflash GGML
    types). Order: $LLAMA_CPP_DIR → in-repo fork submodule
    (packages/inference/llama.cpp) → ~/.cache/eliza-dflash/milady-llama-cpp →
    ~/src/milady-llama.cpp. Returns None if none has a convert_hf_to_gguf.py."""
    import os
    cands: list[Path] = []
    env = os.environ.get("LLAMA_CPP_DIR")
    if env:
        cands.append(Path(env))
    for p in Path(__file__).resolve().parents:
        cand = p / "packages" / "inference" / "llama.cpp"
        if cand.is_dir():
            cands.append(cand)
            break
    cands += [
        Path.home() / ".cache" / "eliza-dflash" / "milady-llama-cpp",
        Path.home() / "src" / "milady-llama.cpp",
    ]
    for c in cands:
        if (c / "convert_hf_to_gguf.py").is_file():
            return c
    return None


def _resolve_llama_bench(fork_dir: Path | None) -> Path | None:
    """Find a `llama-bench` binary, preferring the fastest backend available:
    a CUDA build > the fork's Vulkan build > the stock CPU build > $PATH."""
    import shutil
    cands: list[Path] = []
    vendor = ROOT / "vendor" / "llama.cpp"
    cands += [vendor / "build-cuda" / "bin" / "llama-bench"]
    if fork_dir is not None:
        cands += [
            fork_dir / "build-cuda" / "bin" / "llama-bench",
            fork_dir / "build" / "linux-x64-cuda" / "bin" / "llama-bench",
            fork_dir / "build" / "linux-x64-vulkan" / "bin" / "llama-bench",
        ]
    cands += [vendor / "build" / "bin" / "llama-bench"]
    for c in cands:
        if c.is_file() and os.access(c, os.X_OK):
            return c
    w = shutil.which("llama-bench")
    return Path(w) if w else None


def _cuda_available() -> bool:
    try:
        import torch  # type: ignore
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def _throughput_bench(gguf: Path, bench_bin: Path, *, gpu: bool) -> dict | None:
    """Run llama-bench on a GGUF and return {backend, results:[{n_prompt,n_gen,
    avg_ts,stddev_ts}], cmd}. Best-effort — returns None on any failure."""
    cmd = [str(bench_bin), "-m", str(gguf), "-p", "256,512", "-n", "64,128",
           "-o", "json"]
    if gpu:
        cmd += ["-ngl", "99", "-fa", "1", "-b", "2048"]
    else:
        cmd += ["-t", str(min(8, os.cpu_count() or 4))]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    except (subprocess.TimeoutExpired, OSError) as e:
        log.warning("llama-bench failed for %s: %s", gguf, e)
        return None
    if proc.returncode != 0:
        log.warning("llama-bench rc=%d for %s; stderr tail: %s",
                    proc.returncode, gguf, (proc.stderr or "")[-300:])
        return None
    try:
        rows = json.loads(proc.stdout)
    except json.JSONDecodeError:
        log.warning("llama-bench output not JSON for %s", gguf)
        return None
    backend = rows[0].get("backend") if rows else None
    results = [
        {"n_prompt": r.get("n_prompt"), "n_gen": r.get("n_gen"),
         "avg_ts": r.get("avg_ts"), "stddev_ts": r.get("stddev_ts")}
        for r in rows
    ]
    return {"gguf": str(gguf), "backend": backend, "results": results,
            "cmd": " ".join(cmd)}


def _format_ok_rate(summary: dict | None) -> float | None:
    """Extract a 0..1 parsable-output rate from a benchmark summary.json.

    Handles both benchmark scripts:
      - native_tool_call_bench.py: buckets[*].{structure_ok,n}
      - eliza_bench.py:            buckets[*].{format_ok,n}
    Returns the micro-averaged rate over all buckets, or None when there
    are no scored records.
    """
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
            ok = b.get("format_ok")
        if ok is None:
            continue
        num += int(ok)
        den += n
    if den == 0:
        return None
    return round(num / den, 4)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--registry-key", required=True,
                    help="One of: qwen3-0.6b, eliza-1-2b, eliza-1-9b, "
                         "eliza-1-27b. Internal upstream keys are aliases.")
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
    ap.add_argument(
        "--from-scratch", action="store_true",
        help="Stage 0: rebuild data/final/{train,val,test}.jsonl from raw "
             "sources. Re-downloads only if data/raw/ is empty; otherwise "
             "re-normalizes + re-packs what is already on disk. Pass "
             "--sample-per-source N for a tiny sampled mix.",
    )
    ap.add_argument(
        "--sample-per-source", type=int, default=0,
        help="When >0, limit each input source to ~N records during the "
             "from-scratch corpus build (passthrough to normalize.py and "
             "pack_dataset.py). Implies pack_dataset.py --smoke.",
    )
    ap.add_argument(
        "--eval-mode", choices=("smoke", "full"), default="smoke",
        help="Eval-gate mode written into evals/aggregate.json and used for "
             "the gate report. smoke = structural gates only (default).",
    )
    pub = ap.add_mutually_exclusive_group()
    pub.add_argument("--publish", dest="publish", action="store_true",
                     help="Stage 7: run the publish orchestrator at the tail "
                          "(requires --bundle-dir).")
    pub.add_argument("--skip-publish", dest="publish", action="store_false",
                     help="Do not publish (default).")
    ap.set_defaults(publish=False)
    ap.add_argument("--bundle-dir", default=None,
                    help="Assembled bundle dir for --publish.")
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
    mb = ap.add_mutually_exclusive_group()
    mb.add_argument("--eliza1-bundle", dest="eliza1_bundle", action="store_true",
                    help="Stage 6b: assemble the Eliza-1-typed GGUF bundle via "
                         "optimize_for_eliza1.py — PolarQuant 4-bit weights + "
                         "QJL1_256 K-cache + TBQ V-cache sidecars + "
                         "eliza1_manifest.json. Needs the elizaOS/llama.cpp "
                         "fork (auto-detected; set $LLAMA_CPP_DIR to override).")
    mb.add_argument("--no-eliza1-bundle", dest="eliza1_bundle", action="store_false",
                    help="Skip the Eliza-1 GGUF bundle stage.")
    ap.set_defaults(eliza1_bundle=None)  # None ⇒ auto (on iff the fork is found)
    ap.add_argument("--dflash-drafter", action="store_true",
                    help="Also distill a DFlash speculative-decode drafter for "
                         "this tier (distill_dflash_drafter.py). Needs a GPU for "
                         "a real run; uses --synthetic-smoke when --eval-mode "
                         "smoke so the pipeline still validates on CPU.")
    ap.add_argument("--skip-throughput-bench", action="store_true",
                    help="Skip stage 6c (llama-bench tokens/sec on the produced "
                         "GGUFs — prefill + generation t/s, CUDA build if "
                         "available, written to checkpoints/<run>/evals/"
                         "throughput.json).")
    args = ap.parse_args()

    if args.publish and not args.bundle_dir:
        raise SystemExit("--publish requires --bundle-dir")

    entry = registry_get(args.registry_key)
    if not entry.can_train_locally and not args.skip_finetune:
        raise SystemExit(
            f"{entry.public_name} (tier={entry.tier.value}) cannot train locally. "
            f"Use train_nebius.sh or pass --skip-finetune."
        )

    tier_id = normalize_tier(entry.public_name)
    run_name = args.run_name or f"{entry.public_name}-apollo-{int(time.time())}"
    ckpt_dir = ROOT / "checkpoints" / run_name
    bench_dir = ROOT / "benchmarks" / run_name
    bench_dir.mkdir(parents=True, exist_ok=True)

    summary = {
        "registry_key": entry.public_name,
        "model": entry.hf_id,
        "tier": tier_id,
        "run_name": run_name,
        "eval_mode": args.eval_mode,
        "started": time.time(),
        "stages": {},
    }

    train_file = Path(args.train_file) if args.train_file else ROOT / "data" / "final" / "train.jsonl"
    val_file = Path(args.val_file) if args.val_file else ROOT / "data" / "final" / "val.jsonl"
    test_file = Path(args.test_file) if args.test_file else ROOT / "data" / "final" / "test.jsonl"

    # ───────────── stage 0: from-scratch corpus build ─────────────────
    if args.from_scratch:
        raw_dir = ROOT / "data" / "raw"
        populated = raw_dir.exists() and any(
            (p / ".done").exists() for p in raw_dir.iterdir() if p.is_dir()
        )
        if not populated:
            cmd = ["uv", "run", "python", "scripts/download_datasets.py"]
            if args.sample_per_source:
                cmd += ["--sample-per-source", str(args.sample_per_source)]
            rc = run(cmd, cwd=ROOT)
            summary["stages"]["download"] = {"exit": rc}
            if rc != 0:
                log.error("download_datasets failed; aborting")
                (bench_dir / "pipeline-summary.json").write_text(json.dumps(summary, indent=2))
                return 1
        else:
            log.info("data/raw/ already populated — skipping download, "
                     "re-normalize + re-pack only")
            summary["stages"]["download"] = {"skipped": "raw already populated"}

        cmd = ["uv", "run", "python", "scripts/normalize.py"]
        if args.sample_per_source:
            cmd += ["--sample-per-source", str(args.sample_per_source)]
        rc = run(cmd, cwd=ROOT)
        summary["stages"]["normalize"] = {"exit": rc}
        if rc != 0:
            log.error("normalize failed; aborting")
            (bench_dir / "pipeline-summary.json").write_text(json.dumps(summary, indent=2))
            return 1

        cmd = ["uv", "run", "python", "scripts/pack_dataset.py"]
        if args.sample_per_source:
            cmd += ["--sample-per-source", str(args.sample_per_source), "--smoke"]
        rc = run(cmd, cwd=ROOT)
        summary["stages"]["pack"] = {"exit": rc}
        if rc != 0:
            log.error("pack_dataset failed; aborting")
            (bench_dir / "pipeline-summary.json").write_text(json.dumps(summary, indent=2))
            return 1
        # Stage 0 regenerates the canonical final splits.
        train_file = ROOT / "data" / "final" / "train.jsonl"
        val_file = ROOT / "data" / "final" / "val.jsonl"
        test_file = ROOT / "data" / "final" / "test.jsonl"

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
        rc = run(cmd, cwd=ROOT)
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

    finetuned_model = ckpt_dir / "final"

    def _bench(model: str, out_sub: str) -> dict[str, int]:
        """Run both benchmark scripts against `model` into benchmarks/<run>/<out_sub>/."""
        out_base = bench_dir / out_sub
        rc_native = run([
            "uv", "run", "--extra", "train", "python",
            "scripts/benchmark/native_tool_call_bench.py",
            "--model", model,
            "--test-file", str(test_file),
            "--out-dir", str(out_base / "native_tool_call"),
            "--max-per-bucket", str(args.bench_per_bucket),
        ], cwd=ROOT)
        rc_eliza = run([
            "uv", "run", "--extra", "train", "python",
            "scripts/benchmark/eliza_bench.py",
            "--model", model,
            "--test-file", str(test_file),
            "--out-dir", str(out_base / "eliza_bench"),
            "--max-per-bucket", str(args.bench_per_bucket),
        ], cwd=ROOT)
        return {"native_tool_call": rc_native, "eliza_bench": rc_eliza}

    def _bench_format_ok(out_sub: str) -> float | None:
        out_base = bench_dir / out_sub
        rate = _format_ok_rate(_read_json(out_base / "native_tool_call" / "summary.json"))
        if rate is None:
            rate = _format_ok_rate(_read_json(out_base / "eliza_bench" / "summary.json"))
        return rate

    # ───────────── stage 1: base benchmark ─────────────────────────────
    if not args.skip_base_bench and not args.skip_bench:
        rcs = _bench(entry.hf_id, "base")
        summary["stages"]["base_bench"] = {"exit": rcs}
        if any(rc != 0 for rc in rcs.values()):
            log.error("base benchmark failed (exit=%s)", rcs)

    # ───────────── stage 2: fine-tune ──────────────────────────────────
    if not args.skip_finetune:
        cmd = [
            "uv", "run", "--extra", "train", "python",
            "scripts/train_local.py",
            "--registry-key", entry.public_name,
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
        rc = run(cmd, cwd=ROOT)
        summary["stages"]["finetune"] = {"exit": rc, "checkpoint": str(finetuned_model)}
        if rc != 0:
            log.error("finetune failed; aborting")
            (bench_dir / "pipeline-summary.json").write_text(json.dumps(summary, indent=2))
            return 1

    # ───────────── stage 3: fine-tuned benchmark ──────────────────────
    if not args.skip_bench:
        rcs = _bench(str(finetuned_model), "finetuned")
        summary["stages"]["finetuned_bench"] = {"exit": rcs}

    # ───────────── stage 4: aggregate evals + gate report ─────────────
    base_rate = _bench_format_ok("base")
    finetuned_rate = _bench_format_ok("finetuned")
    evals_dir = ckpt_dir / "evals"
    evals_dir.mkdir(parents=True, exist_ok=True)
    results: dict[str, float] = {}
    if finetuned_rate is not None:
        results["format_ok"] = finetuned_rate
    if base_rate is not None:
        results["format_ok_base"] = base_rate
        results["format_ok_finetuned"] = finetuned_rate if finetuned_rate is not None else base_rate
    aggregate = {
        "tier": tier_id,
        "mode": args.eval_mode,
        "results": results,
        "benchmarks": {
            "base": _read_json(bench_dir / "base" / "native_tool_call" / "summary.json")
                    or _read_json(bench_dir / "base" / "eliza_bench" / "summary.json"),
            "finetuned": _read_json(bench_dir / "finetuned" / "native_tool_call" / "summary.json")
                         or _read_json(bench_dir / "finetuned" / "eliza_bench" / "summary.json"),
        },
        "run_name": run_name,
        "model": entry.hf_id,
    }
    aggregate_path = evals_dir / "aggregate.json"
    aggregate_path.write_text(json.dumps(aggregate, indent=2))
    summary["stages"]["evals"] = {"aggregate": str(aggregate_path), "results": results}
    log.info("wrote %s", aggregate_path)

    # Non-blocking gate report — record it, never abort on it.
    try:
        report = apply_gates(aggregate, tier_id, mode=args.eval_mode)
        gate_blob = {
            "tier": report.tier,
            "mode": report.mode,
            "passed": report.passed,
            "failures": report.failures,
            "gates": [
                {
                    "name": g.name, "passed": g.passed, "reason": g.reason,
                    "metric": g.metric, "observed": g.observed,
                    "threshold": g.threshold, "op": g.op,
                    "provisional": g.provisional, "skipped": g.skipped,
                    "required": g.required,
                }
                for g in report.gates
            ],
        }
    except Exception as e:  # noqa: BLE001 — record gate failures, never block
        log.warning("apply_gates raised: %s", e)
        gate_blob = {"tier": tier_id, "mode": args.eval_mode, "error": repr(e)}
    gate_report_path = ckpt_dir / "gate_report.json"
    gate_report_path.write_text(json.dumps(gate_blob, indent=2))
    summary["stages"]["gate_report"] = {"path": str(gate_report_path),
                                        "passed": gate_blob.get("passed")}
    log.info("wrote %s (passed=%s)", gate_report_path, gate_blob.get("passed"))

    # ───────────── stage 5: quantize ──────────────────────────────────
    quantizers = [q.strip() for q in args.quantizers.split(",") if q.strip()]
    if not args.skip_quantize:
        for q in quantizers:
            if q not in entry.quantization_after:
                log.warning("registry says %s is not in quant list for %s; running anyway",
                            q, entry.public_name)
            apply_script = ROOT / "scripts" / "quantization" / f"{q}_apply.py"
            if not apply_script.exists():
                log.error("missing quantizer script %s", apply_script)
                continue
            out_path = ckpt_dir / f"final-{q}"
            rc = run([
                "uv", "run", "--extra", "train", "python", str(apply_script),
                "--model", str(finetuned_model),
                "--output", str(out_path),
                "--calibration", str(val_file),
                "--calibration-samples", "128",
            ], cwd=ROOT)
            summary["stages"][f"quantize_{q}"] = {"exit": rc, "output": str(out_path)}

    # ───────────── stage 6: quantized benchmarks ──────────────────────
    if not args.skip_bench:
        for q in quantizers:
            ck = ckpt_dir / f"final-{q}"
            if not ck.exists():
                continue
            rcs = _bench(str(ck), q)
            summary["stages"][f"{q}_bench"] = {"exit": rcs}

    # ───────────── stage 6b: Eliza-1-typed GGUF bundle ─────────────────
    # PolarQuant 4-bit weights packed via the fork's Q4_POLAR GGML type +
    # QJL1_256 K-cache & TBQ V-cache JSON sidecars + eliza1_manifest.json,
    # optionally paired with a DFlash drafter. optimize_for_eliza1.py is the
    # canonical orchestrator (it re-runs polarquant→qjl→turboquant idempotently
    # and then converts via the fork) — run_pipeline just delegates to it.
    fork_dir = _resolve_eliza1_llama_cpp()
    want_bundle = args.eliza1_bundle if args.eliza1_bundle is not None else (fork_dir is not None)
    if want_bundle and not args.skip_quantize:
        if fork_dir is None:
            log.error("--eliza1-bundle requested but no elizaOS/llama.cpp fork "
                      "found (set $LLAMA_CPP_DIR or clone milady-llama-cpp); "
                      "skipping the Eliza-1 GGUF bundle")
            summary["stages"]["eliza1_bundle"] = {"skipped": "fork not found"}
        elif not finetuned_model.exists():
            log.warning("no fine-tuned checkpoint at %s — skipping Eliza-1 bundle",
                        finetuned_model)
            summary["stages"]["eliza1_bundle"] = {"skipped": "no checkpoint"}
        else:
            opt_dir = ckpt_dir / "eliza1-optimized"
            drafter_gguf: Path | None = None
            if args.dflash_drafter:
                dflash_dir = ckpt_dir / "dflash"
                d_cmd = [
                    "uv", "run", "--extra", "train", "python",
                    "scripts/distill_dflash_drafter.py",
                    "--tier", tier_id,
                    "--target-checkpoint", str(finetuned_model),
                    "--dataset", str(train_file),
                    "--out-dir", str(dflash_dir),
                ]
                if args.eval_mode == "smoke":
                    d_cmd.append("--synthetic-smoke")
                rc = run(d_cmd, cwd=ROOT)
                summary["stages"]["dflash_drafter"] = {"exit": rc, "output": str(dflash_dir)}
                cand = dflash_dir / f"drafter-{tier_id}.gguf"
                drafter_gguf = cand if cand.exists() else None
            o_cmd = [
                "uv", "run", "--extra", "train", "python",
                "scripts/optimize_for_eliza1.py",
                "--base-model", str(finetuned_model),
                "--output-dir", str(opt_dir),
                "--apply", "polarquant", "qjl", "turboquant",
                "--calibration", str(test_file if test_file.exists() else val_file),
                "--calibration-samples", "128",
                "--llama-cpp-dir", str(fork_dir),
            ]
            if drafter_gguf is not None:
                o_cmd += ["--drafter-repo", str(drafter_gguf)]
            if args.publish and getattr(entry, "eliza_repo_id", None):
                o_cmd += ["--hf-repo", entry.eliza_repo_id]
            rc = run(o_cmd, cwd=ROOT)
            manifest = opt_dir / "eliza1_manifest.json"
            summary["stages"]["eliza1_bundle"] = {
                "exit": rc, "output": str(opt_dir),
                "manifest": str(manifest) if manifest.exists() else None,
            }
            log.info("Eliza-1 bundle exit=%d → %s", rc, opt_dir)

    # ───────────── stage 6c: throughput bench (tokens/sec) ────────────
    # llama-bench on every produced GGUF: prefill (pp) + generation (tg) t/s.
    # Picks the fastest backend available (CUDA build > fork Vulkan > CPU) and
    # the optimal flags (-fa 1 -b 2048 -ngl 99 on GPU). Written to
    # checkpoints/<run>/evals/throughput.json — gives the pipeline a tokens/sec
    # number alongside the format/structure eval rates.
    if not args.skip_throughput_bench:
        bench_bin = _resolve_llama_bench(fork_dir)
        ggufs = sorted({p for p in ckpt_dir.rglob("*.gguf")})
        if bench_bin is None:
            summary["stages"]["throughput_bench"] = {"skipped": "no llama-bench binary"}
        elif not ggufs:
            summary["stages"]["throughput_bench"] = {"skipped": "no GGUF produced"}
        else:
            gpu = _cuda_available() or "vulkan" in bench_bin.parts or "cuda" in str(bench_bin)
            tp = {"bench_binary": str(bench_bin), "gpu_flags": gpu, "ggufs": []}
            for g in ggufs:
                log.info("llama-bench %s (%s)", g.name, "GPU" if gpu else "CPU")
                r = _throughput_bench(g, bench_bin, gpu=gpu)
                if r is not None:
                    tp["ggufs"].append(r)
            tp_path = ckpt_dir / "evals" / "throughput.json"
            tp_path.parent.mkdir(parents=True, exist_ok=True)
            tp_path.write_text(json.dumps(tp, indent=2))
            # Headline numbers: best pp + best tg across produced GGUFs.
            best_pp = max((res["avg_ts"] for gg in tp["ggufs"] for res in gg["results"]
                           if res.get("n_gen") in (0, None) and res.get("avg_ts")), default=None)
            best_tg = max((res["avg_ts"] for gg in tp["ggufs"] for res in gg["results"]
                           if res.get("n_prompt") in (0, None) and res.get("avg_ts")), default=None)
            summary["stages"]["throughput_bench"] = {
                "path": str(tp_path), "backend": (tp["ggufs"][0]["backend"] if tp["ggufs"] else None),
                "best_prompt_ts": best_pp, "best_gen_ts": best_tg,
            }
            log.info("throughput: best prefill=%.1f t/s, best gen=%.1f t/s (%s)",
                     best_pp or 0.0, best_tg or 0.0,
                     tp["ggufs"][0]["backend"] if tp["ggufs"] else "?")

    # ───────────── stage 7: publish ───────────────────────────────────
    if args.publish:
        rc = run([
            "uv", "run", "python", "-m", "scripts.publish.orchestrator",
            "--tier", tier_id,
            "--bundle-dir", str(args.bundle_dir),
        ], cwd=ROOT)
        summary["stages"]["publish"] = {"exit": rc}
        if rc != 0:
            log.error("publish orchestrator failed (exit=%d)", rc)

    summary["finished"] = time.time()
    summary["elapsed_s"] = summary["finished"] - summary["started"]
    (bench_dir / "pipeline-summary.json").write_text(json.dumps(summary, indent=2))
    log.info("pipeline complete: %s", bench_dir / "pipeline-summary.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
