#!/usr/bin/env python3
"""G3 Kokoro sam full-FT pipeline orchestrator.

Implements F2's structural next-step: OmniVoice sam frozen preset as the
distillation teacher (NOT af_bella). In practice, the "OmniVoice sam teacher"
is the Kokoro KPipeline conditioned on the sam mel-fit ref_s, which produces
sam-characteristic audio rather than af_bella-characteristic audio.

Pipeline:
  1. Synthesize ~60 min via Kokoro + sam ref_s teacher → sam-distill/
  2. Merge with augmented real sam corpus (≥80% distilled, ≤20% real)
  3. Train full-FT for 8000 steps (APOLLO, RTX 5080)
  4. Eval vs baseline
  5. If beatsBaseline → push to HF elizaos/eliza-1-voice-kokoro-sam-v01

Usage::

    python3 run_g3_pipeline.py \\
        --sam-voice-bin /tmp/kokoro-f2/melfit-5/af_samantha.bin \\
        --augmented-corpus-dir /tmp/kokoro-f2/augmented \\
        --out-dir /tmp/kokoro-g3 \\
        --baseline-eval artifacts/voice-fine-tune/kokoro-sam-f2/20260515T020000Z/eval-baseline-af_bella.json

    # Dry run (skip actual training):
    python3 run_g3_pipeline.py --dry-run [...]
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import random
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kokoro.run_g3_pipeline")

REPO_ROOT = Path(__file__).resolve().parents[4]
KOKORO_SCRIPTS = Path(__file__).resolve().parent

# G3 target mix ratios (per brief)
DISTILLED_RATIO_TARGET = 0.80   # ≥80% OmniVoice-sam-distilled
REAL_RATIO_MAX = 0.20           # ≤20% augmented real

HF_REPO = "elizaos/eliza-1-voice-kokoro-sam-v01"


def run(cmd: list[str], *, env: dict | None = None, check: bool = True) -> subprocess.CompletedProcess:
    log.info("run: %s", " ".join(str(c) for c in cmd))
    merged_env = {**os.environ, **(env or {})}
    return subprocess.run(cmd, env=merged_env, check=check, text=True, capture_output=False)


def count_lines(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(1 for line in path.read_text(encoding="utf-8").splitlines() if line.strip())


def _build_ratio_merged(
    *,
    distill_dir: Path,
    real_dir: Path | None,
    out_dir: Path,
    distilled_ratio: float = DISTILLED_RATIO_TARGET,
) -> Path:
    """Merge distilled + real at the target ratio by downsampling real clips.

    The merge_corpus.py tool does not enforce ratios; we do it here by
    sampling a subset of real clips so the distilled fraction is ≥80%.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    import os  # noqa: PLC0415

    wavs_out = out_dir / "wavs_norm"
    wavs_out.mkdir(exist_ok=True)

    # Read distilled clips (train only — val stays separate per corpus)
    distill_train = distill_dir / "train_list.txt"
    distill_val = distill_dir / "val_list.txt"
    distill_train_lines = [
        l for l in distill_train.read_text(encoding="utf-8").splitlines() if l.strip()
    ]
    distill_val_lines = (
        [l for l in distill_val.read_text(encoding="utf-8").splitlines() if l.strip()]
        if distill_val.exists() else []
    )

    n_distill = len(distill_train_lines)
    log.info("distilled corpus: %d train + %d val clips", n_distill, len(distill_val_lines))

    # Symlink distilled wavs
    for line in distill_train_lines + distill_val_lines:
        wav_rel = line.split("|")[0]
        src_wav = distill_dir / wav_rel
        dst_wav = wavs_out / Path(wav_rel).name
        if src_wav.exists() and not dst_wav.exists():
            os.symlink(str(src_wav.resolve()), str(dst_wav))

    real_train_lines: list[str] = []
    if real_dir is not None and real_dir.exists():
        real_train_path = real_dir / "train_list.txt"
        all_real = (
            [l for l in real_train_path.read_text(encoding="utf-8").splitlines() if l.strip()]
            if real_train_path.exists() else []
        )
        # Target: real clips ≤ (1 - distilled_ratio) / distilled_ratio × distilled clips
        max_real = int(n_distill * (1 - distilled_ratio) / distilled_ratio)
        if len(all_real) > max_real:
            log.info(
                "downsampling real corpus: %d → %d clips to maintain ≥%.0f%% distilled ratio",
                len(all_real),
                max_real,
                distilled_ratio * 100,
            )
            random.shuffle(all_real)
            real_train_lines = all_real[:max_real]
        else:
            real_train_lines = all_real
            log.info("real corpus: %d clips (within ratio budget)", len(real_train_lines))

        # Symlink real wavs
        real_wavs_src = real_dir / "wavs_norm"
        if real_wavs_src.exists():
            for line in real_train_lines:
                wav_rel = line.split("|")[0]
                src_wav = real_wavs_src / Path(wav_rel).name
                dst_wav = wavs_out / Path(wav_rel).name
                if src_wav.exists() and not dst_wav.exists():
                    os.symlink(str(src_wav.resolve()), str(dst_wav))

    # Combine and shuffle
    all_train = distill_train_lines + real_train_lines
    random.shuffle(all_train)

    actual_distill_frac = n_distill / max(len(all_train), 1)
    log.info(
        "merged corpus: %d train clips (distilled=%.1f%%, real=%.1f%%)",
        len(all_train),
        actual_distill_frac * 100,
        (1 - actual_distill_frac) * 100,
    )

    (out_dir / "train_list.txt").write_text("\n".join(all_train) + "\n", encoding="utf-8")
    (out_dir / "val_list.txt").write_text("\n".join(distill_val_lines) + "\n", encoding="utf-8")

    summary = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "distilledClips": n_distill,
        "realClips": len(real_train_lines),
        "totalTrainClips": len(all_train),
        "valClips": len(distill_val_lines),
        "distilledFraction": round(actual_distill_frac, 4),
        "targetDistilledFraction": distilled_ratio,
    }
    (out_dir / "merge_summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    return out_dir


def run_pipeline(args: argparse.Namespace) -> int:
    random.seed(1337)
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    # Step 1: Synthesize distillation corpus with sam ref_s teacher
    distill_dir = out_dir / "sam-distill"
    if not distill_dir.exists() or not (distill_dir / "synthesis_summary.json").exists():
        log.info("=== STEP 1: Synthesize sam-distill corpus (%.0f min) ===", args.target_min)
        if args.dry_run:
            log.info("[dry-run] skipping synthesis")
            distill_dir.mkdir(parents=True, exist_ok=True)
            (distill_dir / "synthesis_summary.json").write_text(json.dumps({"dry_run": True}) + "\n")
            (distill_dir / "train_list.txt").write_text("wavs_norm/dummy.wav|dummy text|0\n")
            (distill_dir / "val_list.txt").write_text("wavs_norm/dummy.wav|dummy text|0\n")
            (distill_dir / "wavs_norm").mkdir(exist_ok=True)
        else:
            cmd = [
                sys.executable,
                str(KOKORO_SCRIPTS / "synthesize_distillation_corpus_omnivoice.py"),
                "--out-dir", str(distill_dir),
                "--target-min", str(args.target_min),
                "--seed", "1337",
            ]
            if args.sam_voice_bin and Path(args.sam_voice_bin).exists():
                cmd.extend(["--voice-bin", str(args.sam_voice_bin)])
                log.info("teacher: sam ref_s from %s", args.sam_voice_bin)
            else:
                log.warning("sam-voice-bin not found; falling back to stock af_sam voice")
            run(cmd)
    else:
        log.info("sam-distill already exists, skipping synthesis")

    # Step 2: Merge with augmented real corpus at ≥80% distilled ratio
    merged_dir = out_dir / "merged"
    if not merged_dir.exists() or not (merged_dir / "train_list.txt").exists():
        log.info("=== STEP 2: Merge corpora (≥80%% distilled) ===")
        real_dir = Path(args.augmented_corpus_dir) if args.augmented_corpus_dir else None
        _build_ratio_merged(
            distill_dir=distill_dir,
            real_dir=real_dir,
            out_dir=merged_dir,
            distilled_ratio=DISTILLED_RATIO_TARGET,
        )
    else:
        log.info("merged corpus already exists, skipping merge")

    # Step 3: Run full-FT on merged corpus
    run_dir = out_dir / "run"
    run_dir.mkdir(exist_ok=True)

    # Copy merged corpus into run_dir/processed/
    processed_dir = run_dir / "processed"
    if not processed_dir.exists() or not (processed_dir / "train_list.txt").exists():
        log.info("=== STEP 3a: Prep merged corpus into run_dir ===")
        processed_dir.mkdir(parents=True, exist_ok=True)
        import shutil  # noqa: PLC0415

        for fname in ["train_list.txt", "val_list.txt"]:
            src = merged_dir / fname
            if src.exists():
                shutil.copy2(src, processed_dir / fname)

        # Symlink wavs_norm
        wavs_link = processed_dir / "wavs_norm"
        if not wavs_link.exists():
            os.symlink(str((merged_dir / "wavs_norm").resolve()), str(wavs_link))

    ckpt_dir = run_dir / "checkpoints"
    manifest_path = ckpt_dir / "train_manifest.json"

    if manifest_path.exists() and not args.force_retrain:
        log.info("training already complete (%s exists), skipping", manifest_path)
    else:
        log.info("=== STEP 3b: Full-FT training (max_steps=%d) ===", args.max_steps)
        if args.dry_run:
            log.info("[dry-run] skipping training")
        else:
            cmd = [
                sys.executable,
                str(KOKORO_SCRIPTS / "finetune_kokoro_full.py"),
                "--run-dir", str(run_dir),
                "--config", "kokoro_sam_g3.yaml",
                "--init-from-voice", args.init_from_voice,
                "--skip-inline-eval",  # speed up; do full eval in step 4
            ]
            if args.baseline_eval:
                cmd.extend(["--baseline-eval", str(args.baseline_eval)])
            run(cmd)

    # Step 4: Evaluate
    log.info("=== STEP 4: Eval ===")
    best_bin = ckpt_dir / "best.bin" if not args.dry_run else (ckpt_dir / "dummy.bin")
    eval_out = out_dir / "eval-g3.json"

    if args.dry_run:
        log.info("[dry-run] skipping eval")
        beats_baseline = False
    elif not best_bin.exists():
        log.warning("no best.bin found (training may have failed); checking for latest checkpoint")
        pts = sorted(ckpt_dir.glob("step_*.bin")) if ckpt_dir.exists() else []
        if pts:
            best_bin = pts[-1]
            log.info("using latest checkpoint: %s", best_bin)
        else:
            log.error("no checkpoints found; aborting eval")
            return 1

        eval_cmd = [
            sys.executable,
            str(KOKORO_SCRIPTS / "eval_kokoro.py"),
            "--run-dir", str(run_dir),
            "--config", "kokoro_sam_g3.yaml",
            "--voice-bin", str(best_bin),
            "--eval-out", str(eval_out),
            "--allow-gate-fail",
        ]
        if args.baseline_eval:
            eval_cmd.extend(["--baseline-eval", str(args.baseline_eval)])
        proc = subprocess.run(eval_cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            log.error("eval failed (rc=%d):\n%s", proc.returncode, proc.stderr[-2000:])
            beats_baseline = False
        elif eval_out.exists():
            data = json.loads(eval_out.read_text())
            comparison = data.get("comparison") or {}
            beats_baseline = bool(comparison.get("beatsBaseline", False))
            metrics = data.get("metrics", {})
            log.info(
                "eval result: utmos=%.3f wer=%.3f spkSim=%.3f beats_baseline=%s",
                metrics.get("utmos", -1),
                metrics.get("wer", -1),
                metrics.get("speaker_similarity", -1),
                beats_baseline,
            )
        else:
            beats_baseline = False
    else:
        eval_cmd = [
            sys.executable,
            str(KOKORO_SCRIPTS / "eval_kokoro.py"),
            "--run-dir", str(run_dir),
            "--config", "kokoro_sam_g3.yaml",
            "--voice-bin", str(best_bin),
            "--eval-out", str(eval_out),
            "--allow-gate-fail",
        ]
        if args.baseline_eval:
            eval_cmd.extend(["--baseline-eval", str(args.baseline_eval)])
        proc = subprocess.run(eval_cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            log.error("eval failed (rc=%d):\n%s", proc.returncode, proc.stderr[-2000:])
            beats_baseline = False
        elif eval_out.exists():
            data = json.loads(eval_out.read_text())
            comparison = data.get("comparison") or {}
            beats_baseline = bool(comparison.get("beatsBaseline", False))
            metrics = data.get("metrics", {})
            log.info(
                "eval result: utmos=%.3f wer=%.3f spkSim=%.3f beats_baseline=%s",
                metrics.get("utmos", -1),
                metrics.get("wer", -1),
                metrics.get("speaker_similarity", -1),
                beats_baseline,
            )
        else:
            beats_baseline = False

    # Step 5: HF push if beats baseline
    if beats_baseline and not args.dry_run and not args.skip_hf_push:
        log.info("=== STEP 5: HF push (beatsBaseline=True) ===")
        hf_token = os.environ.get("HF_TOKEN", "")
        if not hf_token:
            log.error("HF_TOKEN not set; cannot push to HF")
        else:
            staging_dir = out_dir / "hf-staging"
            staging_dir.mkdir(exist_ok=True)
            import shutil  # noqa: PLC0415

            shutil.copy2(best_bin, staging_dir / "af_sam.bin")
            if eval_out.exists():
                shutil.copy2(eval_out, staging_dir / "eval.json")
            # Write model card
            (staging_dir / "README.md").write_text(
                "# elizaos/eliza-1-voice-kokoro-sam-v01\n\n"
                "Kokoro-82M fine-tuned on the `sam` voice (AI Voices / Her-derived).\n"
                "G3 training: OmniVoice sam teacher distillation (60 min) + augmented real (≤20%).\n"
                f"Generated: {datetime.now(timezone.utc).isoformat()}\n"
            )
            run([
                "huggingface-cli", "upload",
                HF_REPO, str(staging_dir),
                "--repo-type", "model",
                "--token", hf_token,
            ])
            log.info("HF push complete: %s", HF_REPO)
    elif beats_baseline:
        log.info("beats_baseline=True but dry-run or skip-hf-push; not pushing")
    else:
        log.info("beats_baseline=False; HF push blocked")

    log.info("=== G3 PIPELINE COMPLETE (beats_baseline=%s) ===", beats_baseline)
    return 0 if beats_baseline else 2


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument(
        "--sam-voice-bin",
        type=Path,
        default=None,
        help="Path to best sam mel-fit ref_s .bin (teacher). F2 melfit-5 recommended.",
    )
    p.add_argument(
        "--augmented-corpus-dir",
        type=Path,
        default=None,
        help="Path to F2 augmented real sam corpus (with train_list.txt + wavs_norm/).",
    )
    p.add_argument(
        "--out-dir",
        type=Path,
        default=Path("/tmp/kokoro-g3"),
    )
    p.add_argument(
        "--target-min",
        type=float,
        default=60.0,
        help="Target distillation duration in minutes (default 60).",
    )
    p.add_argument(
        "--max-steps",
        type=int,
        default=8000,
        help="Training max steps (default 8000).",
    )
    p.add_argument(
        "--init-from-voice",
        type=str,
        default="af_bella",
        help="Kokoro voice id to seed ref_s (default af_bella).",
    )
    p.add_argument(
        "--baseline-eval",
        type=Path,
        default=Path("artifacts/voice-fine-tune/kokoro-sam-f2/20260515T020000Z/eval-baseline-af_bella.json"),
    )
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--force-retrain", action="store_true")
    p.add_argument("--skip-hf-push", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return run_pipeline(args)


if __name__ == "__main__":
    raise SystemExit(main())
