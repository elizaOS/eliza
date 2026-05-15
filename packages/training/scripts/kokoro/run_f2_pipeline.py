#!/usr/bin/env python3
"""F2 Kokoro same fine-tune retry pipeline.

Orchestrates:
  1. Acoustic augmentation (3.5 min → ~20 min)
  2. Self-distillation synthesis (30 min same-voiced audio from Kokoro)
  3. Merge corpora
  4. Mel-fit voice clone with hyperparameter sweep
  5. Full-FT training (best hparam config)
  6. Eval vs af_bella baseline
  7. HF push if beats baseline

Run dir: /tmp/kokoro-f2-<timestamp>/

Usage:
    python3 run_f2_pipeline.py \\
        --corpus-dir packages/training/data/voice/same \\
        [--hf-token <token>] \\
        [--skip-synthesis]     # skip distillation if already done \\
        [--skip-augmentation]  # skip augmentation if already done \\
        [--dry-run-hf]         # don't push to HF even if beats baseline
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("kokoro.f2_pipeline")

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[3]

CORPUS_DIR = REPO_ROOT / "packages/training/data/voice/same"
HF_REPO = "elizaos/eliza-1"

# Mel-fit hyperparameter sweep grid (based on Q1 re-eval diagnosis)
MELFIT_SWEEP = [
    {"anchor_weight": 0.0, "lr": 0.005, "steps": 1200, "init": "af_bella"},
    {"anchor_weight": 0.05, "lr": 0.005, "steps": 1200, "init": "af_bella"},
    {"anchor_weight": 0.1, "lr": 0.005, "steps": 1600, "init": "af_bella"},
    {"anchor_weight": 0.0, "lr": 0.01, "steps": 800, "init": "af_nicole"},
    {"anchor_weight": 0.1, "lr": 0.01, "steps": 1200, "init": "af_nicole"},
    {"anchor_weight": 0.0, "lr": 0.002, "steps": 2000, "init": "af_bella"},
]


def _run(cmd: list[str], *, check: bool = True, **kwargs) -> subprocess.CompletedProcess:
    log.info("$ %s", " ".join(str(c) for c in cmd))
    return subprocess.run(cmd, check=check, **kwargs)


def _py(*args: str, **kwargs) -> subprocess.CompletedProcess:
    return _run([sys.executable, *args], **kwargs)


def run_pipeline(args: argparse.Namespace) -> int:  # noqa: C901
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    base_dir = Path(f"/tmp/kokoro-f2-{run_id}")
    base_dir.mkdir(parents=True, exist_ok=True)

    corpus_dir = args.corpus_dir.resolve()
    aug_dir = base_dir / "corpus-augmented"
    synth_dir = base_dir / "corpus-distilled"
    merged_dir = base_dir / "corpus-merged"

    artifacts_dir = (
        REPO_ROOT / f"artifacts/voice-fine-tune/kokoro-same-f2/{run_id}"
    )
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    timeline: list[dict] = []

    def _record(phase: str, result: dict) -> None:
        timeline.append({"phase": phase, "ts": datetime.now(timezone.utc).isoformat(), **result})
        (artifacts_dir / "timeline.jsonl").write_text(
            "\n".join(json.dumps(e) for e in timeline) + "\n"
        )

    # ------------------------------------------------------------------
    # Phase 1: Acoustic augmentation
    # ------------------------------------------------------------------
    if not args.skip_augmentation:
        log.info("=== Phase 1: Acoustic augmentation ===")
        t0 = time.time()
        _py(
            str(SCRIPT_DIR / "augment_corpus.py"),
            "--corpus-dir", str(corpus_dir),
            "--out-dir", str(aug_dir),
            "--val-fraction", "0.10",
            "--seed", "1337",
        )
        aug_summary = json.loads((aug_dir / "augmentation_summary.json").read_text())
        _record("augmentation", aug_summary)
        log.info(
            "augmentation done: %d clips / %.1f min in %.0fs",
            aug_summary["totalClips"],
            aug_summary["totalDurationMin"],
            time.time() - t0,
        )
    else:
        log.info("skipping augmentation (--skip-augmentation)")
        aug_dir = args.prebuilt_aug_dir or aug_dir

    # ------------------------------------------------------------------
    # Phase 2: Self-distillation synthesis
    # ------------------------------------------------------------------
    if not args.skip_synthesis:
        log.info("=== Phase 2: Self-distillation synthesis (target 30 min) ===")
        t0 = time.time()
        synth_args = [
            str(SCRIPT_DIR / "synthesize_distillation_corpus.py"),
            "--out-dir", str(synth_dir),
            "--voice-id", "af_bella",
            "--target-min", "30",
            "--val-fraction", "0.10",
            "--seed", "42",
        ]
        _py(*synth_args)
        synth_summary = json.loads((synth_dir / "synthesis_summary.json").read_text())
        _record("synthesis", synth_summary)
        log.info(
            "synthesis done: %d clips / %.1f min in %.0fs",
            synth_summary["totalClips"],
            synth_summary["totalDurationMin"],
            time.time() - t0,
        )
    else:
        log.info("skipping synthesis (--skip-synthesis)")
        synth_dir = args.prebuilt_synth_dir or synth_dir

    # ------------------------------------------------------------------
    # Phase 3: Merge corpora
    # ------------------------------------------------------------------
    log.info("=== Phase 3: Merge corpora ===")
    merge_inputs = []
    if aug_dir.exists():
        merge_inputs.append(str(aug_dir))
    if synth_dir.exists():
        merge_inputs.append(str(synth_dir))

    merge_cmd = [str(SCRIPT_DIR / "merge_corpus.py"), "--out", str(merged_dir)]
    for inp in merge_inputs:
        merge_cmd.extend(["--input", inp])
    _py(*merge_cmd)
    merge_summary = json.loads((merged_dir / "merge_summary.json").read_text())
    _record("merge", merge_summary)
    log.info(
        "merge done: %d train + %d val lines",
        merge_summary["trainLines"],
        merge_summary["valLines"],
    )

    # ------------------------------------------------------------------
    # Phase 4: Mel-fit voice clone sweep
    # ------------------------------------------------------------------
    log.info("=== Phase 4: Mel-fit voice clone sweep (%d configs) ===", len(MELFIT_SWEEP))

    # First run baseline eval (af_bella) for comparison
    baseline_eval_path = artifacts_dir / "eval-baseline-af_bella.json"
    if not baseline_eval_path.exists():
        log.info("running baseline eval (af_bella)...")
        _py(
            str(SCRIPT_DIR / "eval_kokoro.py"),
            "--run-dir", str(base_dir),
            "--config", "kokoro_same.yaml",
            "--eval-out", str(baseline_eval_path),
            "--allow-gate-fail",
            check=False,
        )

    best_melfit: dict | None = None
    best_melfit_sim = -999.0
    melfit_results: list[dict] = []

    for i, hparams in enumerate(MELFIT_SWEEP):
        log.info(
            "mel-fit sweep %d/%d: anchor=%.2f lr=%.4f steps=%d init=%s",
            i + 1,
            len(MELFIT_SWEEP),
            hparams["anchor_weight"],
            hparams["lr"],
            hparams["steps"],
            hparams["init"],
        )
        run_dir = base_dir / f"melfit-{i}"
        run_dir.mkdir(exist_ok=True)

        # Run extract_voice_embedding.py
        clips_dir = corpus_dir / "audio"
        out_bin = run_dir / "af_same.bin"
        melfit_cmd = [
            str(SCRIPT_DIR / "extract_voice_embedding.py"),
            "--clips-dir", str(clips_dir),
            "--out", str(out_bin),
            "--steps", str(hparams["steps"]),
            "--lr", str(hparams["lr"]),
            "--anchor-weight", str(hparams["anchor_weight"]),
            "--init-from-voice", hparams["init"],
        ]
        rc = _py(*melfit_cmd, check=False).returncode
        if rc != 0 or not out_bin.exists():
            log.warning("mel-fit sweep %d failed (rc=%d)", i, rc)
            continue

        # Eval
        eval_out = run_dir / "eval.json"
        eval_cmd = [
            str(SCRIPT_DIR / "eval_kokoro.py"),
            "--run-dir", str(run_dir),
            "--config", "kokoro_same.yaml",
            "--voice-bin", str(out_bin),
            "--eval-out", str(eval_out),
            "--allow-gate-fail",
        ]
        if baseline_eval_path.exists():
            eval_cmd.extend(["--baseline-eval", str(baseline_eval_path)])
        _py(*eval_cmd, check=False)

        result_entry: dict = {"sweep_idx": i, "hparams": hparams}
        if eval_out.exists():
            eval_data = json.loads(eval_out.read_text())
            metrics = eval_data.get("metrics", {})
            comparison = eval_data.get("comparison", {})
            spk_sim = float(metrics.get("speaker_similarity", -999))
            beats_baseline = bool(comparison.get("beatsBaseline", False))
            result_entry.update({
                "metrics": metrics,
                "beatsBaseline": beats_baseline,
                "voiceBin": str(out_bin),
            })

            if spk_sim > best_melfit_sim:
                best_melfit_sim = spk_sim
                best_melfit = result_entry
                log.info(
                    "new best mel-fit: SpkSim=%.4f (sweep %d, anchor=%.2f lr=%.4f)",
                    spk_sim,
                    i,
                    hparams["anchor_weight"],
                    hparams["lr"],
                )

            if beats_baseline:
                log.info("mel-fit sweep %d BEATS BASELINE!", i)

        melfit_results.append(result_entry)

    _record("melfit_sweep", {"configs": melfit_results, "best": best_melfit})

    # ------------------------------------------------------------------
    # Phase 5: Full-FT on merged corpus (best LR config)
    # ------------------------------------------------------------------
    log.info("=== Phase 5: Full-FT on merged corpus ===")

    ft_run_dir = base_dir / "fullft-run"
    ft_run_dir.mkdir(exist_ok=True)

    # Prep processed/ directory for finetune_kokoro_full.py
    _py(
        str(SCRIPT_DIR / "prep_merged_corpus.py"),
        "--corpus-dir", str(merged_dir),
        "--run-dir", str(ft_run_dir),
    )

    # Config: use low LR + more steps on larger corpus
    ft_config_path = SCRIPT_DIR / "configs" / "kokoro_same_f2.yaml"
    _write_f2_config(ft_config_path)

    ft_cmd = [
        str(SCRIPT_DIR / "finetune_kokoro_full.py"),
        "--run-dir", str(ft_run_dir),
        "--config", "kokoro_same_f2.yaml",
        "--init-from-voice", "af_bella",
        "--skip-inline-eval",
    ]
    if baseline_eval_path.exists():
        ft_cmd.extend(["--baseline-eval", str(baseline_eval_path)])

    t0 = time.time()
    rc = _py(*ft_cmd, check=False).returncode
    ft_wall = time.time() - t0
    log.info("full-FT completed in %.0fs (rc=%d)", ft_wall, rc)

    # Find best checkpoint
    ckpt_dir = ft_run_dir / "checkpoints"
    best_bin = ckpt_dir / "best.bin"
    if not best_bin.exists():
        # Fall back to last .bin
        bins = sorted(ckpt_dir.glob("*.bin"), key=lambda p: p.stat().st_mtime)
        if bins:
            best_bin = bins[-1]

    ft_eval_out = artifacts_dir / "eval-fullft.json"
    ft_eval_data: dict = {}
    if best_bin.exists():
        eval_cmd = [
            str(SCRIPT_DIR / "eval_kokoro.py"),
            "--run-dir", str(ft_run_dir),
            "--config", "kokoro_same_f2.yaml",
            "--voice-bin", str(best_bin),
            "--eval-out", str(ft_eval_out),
            "--allow-gate-fail",
        ]
        if baseline_eval_path.exists():
            eval_cmd.extend(["--baseline-eval", str(baseline_eval_path)])
        _py(*eval_cmd, check=False)
        if ft_eval_out.exists():
            ft_eval_data = json.loads(ft_eval_out.read_text())

    _record("fullft", {
        "rc": rc,
        "wallSec": round(ft_wall, 1),
        "bestBin": str(best_bin) if best_bin.exists() else None,
        "eval": ft_eval_data,
    })

    # ------------------------------------------------------------------
    # Phase 6: Determine best candidate + HF push decision
    # ------------------------------------------------------------------
    log.info("=== Phase 6: Best candidate + HF push decision ===")

    # Pick the best voice: prefer full-FT if it beats baseline, else best mel-fit
    best_candidate_bin: Path | None = None
    best_candidate_beats = False
    best_candidate_metrics: dict = {}

    if ft_eval_data:
        ft_beats = bool((ft_eval_data.get("comparison") or {}).get("beatsBaseline", False))
        if ft_beats:
            best_candidate_bin = best_bin
            best_candidate_beats = True
            best_candidate_metrics = ft_eval_data.get("metrics", {})
            log.info("full-FT beats baseline — using as candidate")
        else:
            log.info("full-FT does NOT beat baseline")

    if not best_candidate_beats and best_melfit is not None:
        melfit_beats = best_melfit.get("beatsBaseline", False)
        if melfit_beats:
            best_candidate_bin = Path(best_melfit["voiceBin"])
            best_candidate_beats = True
            best_candidate_metrics = best_melfit.get("metrics", {})
            log.info("best mel-fit beats baseline — using as candidate")
        else:
            log.info(
                "best mel-fit does NOT beat baseline (SpkSim=%.4f)",
                best_melfit_sim,
            )

    # HF push
    hf_pushed = False
    if best_candidate_beats and best_candidate_bin and best_candidate_bin.exists():
        hf_token = args.hf_token or os.environ.get("HF_TOKEN")
        if not hf_token:
            log.warning("HF_TOKEN not set — skipping HF push")
        elif args.dry_run_hf:
            log.info("dry-run-hf: would push %s to %s", best_candidate_bin, HF_REPO)
        else:
            log.info("pushing %s to HF repo %s", best_candidate_bin, HF_REPO)
            push_rc = _py(
                str(SCRIPT_DIR / "push_voice_to_hf.py"),
                "--release-dir", str(artifacts_dir),
                "--hf-repo", HF_REPO,
                check=False,
            ).returncode
            hf_pushed = push_rc == 0
            log.info("HF push rc=%d", push_rc)

    _record("hf_push", {
        "beatsBaseline": best_candidate_beats,
        "pushed": hf_pushed,
        "candidateBin": str(best_candidate_bin) if best_candidate_bin else None,
        "metrics": best_candidate_metrics,
    })

    # ------------------------------------------------------------------
    # Phase 7: Write F2 artifacts + post-mortem
    # ------------------------------------------------------------------
    log.info("=== Phase 7: Write artifacts ===")

    final_report = {
        "runId": run_id,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "beatsBaseline": best_candidate_beats,
        "hfPushed": hf_pushed,
        "hfRepo": HF_REPO if hf_pushed else None,
        "candidateBin": str(best_candidate_bin) if best_candidate_bin else None,
        "timeline": timeline,
        "melfitSweep": melfit_results,
        "fullFTEval": ft_eval_data,
    }

    report_path = artifacts_dir / "f2-report.json"
    report_path.write_text(json.dumps(final_report, indent=2) + "\n")
    log.info("final report: %s", report_path)

    # Copy eval files to artifacts
    if baseline_eval_path.exists():
        import shutil
        shutil.copy(str(baseline_eval_path), str(artifacts_dir / "eval-baseline.json"))
    if best_candidate_bin and best_candidate_bin.exists():
        best_candidate_eval = best_candidate_bin.with_suffix(".eval.json")
        if best_candidate_eval.exists():
            import shutil
            shutil.copy(str(best_candidate_eval), str(artifacts_dir / "eval-best-candidate.json"))

    if best_candidate_beats:
        log.info(
            "SUCCESS: candidate beats baseline! SpkSim=%.4f WER=%.4f UTMOS=%.4f",
            best_candidate_metrics.get("speaker_similarity", -1),
            best_candidate_metrics.get("wer", -1),
            best_candidate_metrics.get("utmos", -1),
        )
    else:
        log.warning(
            "FAIL: no candidate beat baseline after mel-fit sweep + full-FT. "
            "Post-mortem committed to artifacts."
        )

    return 0 if best_candidate_beats else 1


def _write_f2_config(path: Path) -> None:
    """Write the F2 full-FT config with settings tuned for larger augmented corpus."""
    content = """\
# F2 Kokoro same full fine-tune config.
# Tuned for augmented+distilled corpus (~50+ min vs original 3.5 min).
extends: base.yaml

voice_name: af_same
voice_display_name: Sam (AI Voices) — F2 Full FT
voice_lang: a
voice_tags:
  - female
  - same
  - eliza-1-voice
  - ai-voices-derived
  - research-only
  - full-finetune
  - f2-retry

mode: full
# Larger corpus → larger LR and more steps
learning_rate: 3.0e-5
max_steps: 5000
eval_every: 500
checkpoint_every: 500
log_every: 25
warmup_steps: 200
val_fraction: 0.10
batch_size: 1
grad_accum: 4

# Light anchor regularization: larger corpus gives more signal,
# so we can reduce the anchor constraint vs the tiny-corpus 0.001.
anchor_weight: 0.0005

early_stop_patience: 3
keep_top_k: 3

mel_loss_weight: 1.0
duration_loss_weight: 0.0
f0_loss_weight: 0.0

gates:
  utmos_min: 3.8
  wer_max: 0.10
  speaker_similarity_min: 0.40
  rtf_min: 0.5
"""
    path.write_text(content, encoding="utf-8")
    log.info("wrote F2 config: %s", path)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--corpus-dir",
        type=Path,
        default=CORPUS_DIR,
    )
    p.add_argument("--hf-token", type=str, default=None)
    p.add_argument("--dry-run-hf", action="store_true")
    p.add_argument("--skip-synthesis", action="store_true")
    p.add_argument("--skip-augmentation", action="store_true")
    p.add_argument("--prebuilt-aug-dir", type=Path, default=None)
    p.add_argument("--prebuilt-synth-dir", type=Path, default=None)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return run_pipeline(args)


if __name__ == "__main__":
    raise SystemExit(main())
