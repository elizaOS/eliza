#!/usr/bin/env python3
"""Kokoro Samantha LoRA training entry point.

Drives the existing `finetune_kokoro_full.py` pipeline in `mode=lora`,
gated on:

  - the prep_manifest.json from prep_corpus.py being present + valid,
  - the privacy filter having run (no `privacy_filter=skipped` records),
  - the phonemizer being misaki (no `phonemizer=passthrough` records),
  - the APOLLO optimizer being available (`pip install apollo-torch`).

Why APOLLO: packages/training/AGENTS.md and the workspace CLAUDE.md
mandate APOLLO for every Eliza-1 training run. APOLLO-mini fits the
adapter + small-corpus profile (lower memory footprint than full APOLLO).
LoRA-specific reasons to deviate: none — APOLLO works on any subset of
trainable parameters, including PEFT adapter weights.

Defaults are tuned for a 24 GB consumer GPU (RTX 4090 / 5080 / 5090):

    --rank 16         # Kokoro adapter LoRA rank — proven to converge on
                      # 1.5–3 h corpora; bump to 32 for >5 h.
    --alpha 32        # 2 * rank, the community default scaling.
    --max-steps 2000  # ~30 min at default batch on a 4090.
    --batch-size 4    # 24 GB-safe; lower to 2 for 16 GB.
    --lr 1.0e-4       # APOLLO-mini LoRA-friendly LR.
    --eval-every 200

Usage:

    python3 train_lora.py \\
        --run-dir ~/eliza-training/samantha-lora-baseline \\
        --config configs/kokoro_samantha_lora.yaml

Outputs (under --run-dir):

    checkpoints/step_<N>/         # PEFT adapter shards + tokenizer state
    checkpoints/best/             # symlink to the lowest-val-loss checkpoint
    train_manifest.json           # hyperparams + dataset hashes + git SHA

Exit codes:
    0  — training reached completion (best checkpoint emitted).
    1  — training error (precondition failure, mid-run NaN, OOM after
         all retries).
    2  — invocation error.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

log = logging.getLogger("samantha_lora.train")

HERE = Path(__file__).resolve().parent
TRAINING_ROOT = HERE.parent.parent.parent
KOKORO_TRAINER = TRAINING_ROOT / "scripts" / "kokoro" / "finetune_kokoro_full.py"


def _git_sha() -> str:
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=TRAINING_ROOT, text=True
        )
        return out.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _load_prep_manifest(run_dir: Path) -> dict[str, Any]:
    manifest_path = run_dir / "processed" / "prep_manifest.json"
    if not manifest_path.is_file():
        raise SystemExit(
            f"[train_lora] prep_manifest.json missing at {manifest_path}. "
            "Run prep_corpus.py first."
        )
    with manifest_path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def _gate_preconditions(prep: dict[str, Any]) -> None:
    if prep.get("privacy_filter") != "applied":
        raise SystemExit(
            f"[train_lora] prep_manifest.privacy_filter={prep.get('privacy_filter')!r}; "
            "the privacy filter must be applied (re-run prep_corpus.py without --skip-privacy)."
        )
    if prep.get("phonemizer") == "passthrough":
        raise SystemExit(
            "[train_lora] prep_manifest.phonemizer=passthrough; misaki must run "
            "(re-run prep_corpus.py without --no-phonemize)."
        )
    sample_rate = prep.get("sample_rate")
    if sample_rate != 24_000:
        raise SystemExit(
            f"[train_lora] prep_manifest.sample_rate={sample_rate}; Kokoro requires 24000."
        )
    train_count = prep.get("split", {}).get("train", 0)
    if train_count < 5:
        raise SystemExit(
            f"[train_lora] prep_manifest reports only {train_count} train clips; "
            "need at least 5 to run a meaningful step (validator floors enforce >= 10)."
        )


def _check_apollo_available() -> None:
    """Refuse to start without APOLLO. AGENTS.md mandate."""
    try:
        import apollo_torch  # type: ignore  # noqa: F401
    except ImportError as exc:
        raise SystemExit(
            "[train_lora] APOLLO optimizer not installed. Repo policy mandates "
            "APOLLO; install via `pip install apollo-torch` before training."
        ) from exc


def _emit_train_manifest(
    *,
    run_dir: Path,
    args: argparse.Namespace,
    prep: dict[str, Any],
    config_path: Path | None,
) -> Path:
    manifest = {
        "schema": "samantha_lora.train_manifest.v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "git_sha": _git_sha(),
        "run_dir": str(run_dir),
        "config_path": str(config_path) if config_path else None,
        "config_sha256": _sha256_file(config_path) if config_path else None,
        "lora": {
            "rank": args.rank,
            "alpha": args.alpha,
            "dropout": args.dropout,
            "target_modules": args.target_modules.split(",") if args.target_modules else None,
        },
        "optimizer": {"name": "apollo_mini", "lr": args.lr},
        "training": {
            "max_steps": args.max_steps,
            "batch_size": args.batch_size,
            "eval_every": args.eval_every,
            "seed": args.seed,
            "max_vram_gb": args.max_vram_gb,
        },
        "prep_manifest": prep,
    }
    out = run_dir / "train_manifest.json"
    with out.open("w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    return out


def _run_finetune(args: argparse.Namespace, run_dir: Path) -> int:
    if not KOKORO_TRAINER.is_file():
        raise SystemExit(
            f"[train_lora] kokoro full-trainer not found at {KOKORO_TRAINER}. "
            "Repo layout changed; update train_lora.py to the new path."
        )

    cmd = [
        sys.executable,
        str(KOKORO_TRAINER),
        "--run-dir",
        str(run_dir),
        "--mode",
        "lora",
        "--lora-rank",
        str(args.rank),
        "--lora-alpha",
        str(args.alpha),
        "--lora-dropout",
        str(args.dropout),
        "--learning-rate",
        f"{args.lr:.6g}",
        "--max-steps",
        str(args.max_steps),
        "--batch-size",
        str(args.batch_size),
        "--eval-every",
        str(args.eval_every),
        "--seed",
        str(args.seed),
        "--optimizer",
        "apollo_mini",
        "--voice-name",
        args.voice_name,
        "--max-vram-gb",
        str(args.max_vram_gb),
    ]
    if args.config:
        cmd.extend(["--config", str(args.config)])
    if args.target_modules:
        cmd.extend(["--lora-target-modules", args.target_modules])
    if args.init_from_voice:
        cmd.extend(["--init-from-voice", args.init_from_voice])
    if args.dry_run:
        cmd.append("--synthetic-smoke")

    log.info("invoking finetune_kokoro_full: %s", " ".join(cmd))
    return subprocess.call(cmd)


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--config", type=Path, default=None)
    parser.add_argument("--rank", type=int, default=16)
    parser.add_argument("--alpha", type=int, default=32)
    parser.add_argument("--dropout", type=float, default=0.05)
    parser.add_argument(
        "--target-modules",
        type=str,
        default="prosody_predictor,style_projection",
        help="Comma-separated module names that get LoRA adapters.",
    )
    parser.add_argument("--lr", type=float, default=1.0e-4)
    parser.add_argument("--max-steps", type=int, default=2000)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--eval-every", type=int, default=200)
    parser.add_argument("--seed", type=int, default=0xE1124)
    parser.add_argument(
        "--max-vram-gb",
        type=float,
        default=24.0,
        help="VRAM budget the trainer keeps under. Lower for 16 GB cards.",
    )
    parser.add_argument(
        "--voice-name",
        type=str,
        default="af_same",
        help="Kokoro voice id the adapter targets; matches the runtime catalog.",
    )
    parser.add_argument(
        "--init-from-voice",
        type=str,
        default="af_bella",
        help="Stock Kokoro voice used as the ref_s init for the LoRA pass.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Run the full control flow with the synthetic-smoke trainer (no real training).",
    )
    parser.add_argument(
        "--skip-precondition-check",
        action="store_true",
        help="DANGEROUS — testing only. Skips prep-manifest gating.",
    )
    parser.add_argument("--log-level", default=os.environ.get("LOG_LEVEL", "INFO"))
    args = parser.parse_args(list(argv) if argv is not None else None)

    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    run_dir = args.run_dir.resolve()
    run_dir.mkdir(parents=True, exist_ok=True)

    prep = _load_prep_manifest(run_dir)
    if not args.skip_precondition_check:
        _gate_preconditions(prep)
        if not args.dry_run:
            _check_apollo_available()

    manifest_path = _emit_train_manifest(
        run_dir=run_dir,
        args=args,
        prep=prep,
        config_path=args.config.resolve() if args.config else None,
    )
    log.info("wrote train manifest: %s", manifest_path)

    rc = _run_finetune(args, run_dir)
    if rc != 0:
        log.error("finetune exited with code %d", rc)
        return 1
    log.info("LoRA training complete; checkpoints under %s/checkpoints/", run_dir)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
