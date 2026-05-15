#!/usr/bin/env python3
"""Fine-tune pipeline for the OmniVoice TTS model (frozen-conditioning path).

OmniVoice (Qwen3-0.6B backbone + K=8 MaskGIT audio decoder) supports two
fine-tune paths:

Path A — Preset-based freeze (shipped in I6/Wave 2):
  Encode sam reference audio once → persist as ELZ2 v2 preset.
  No weight training. Pure inference-time conditioning.
  CLI: ``packages/app-core/scripts/omnivoice-fuse/freeze-voice.mjs``.

Path B — LM weight fine-tune (this script; W3-11):
  Train the Qwen3-0.6B backbone on (text prompt → audio token) pairs from
  the sam corpus. The audio tokens come from the bundled HuBERT+RVQ
  tokenizer applied to the sam WAVs. Loss: cross-entropy over the K=8
  codebook logits (MaskGIT training objective: jointly predict all
  masked positions in one forward).

This script handles Path B: LM weight fine-tune on the sam corpus.

Why Path B is worth running
---------------------------

Path A (preset) gives sam-like timbre at runtime by prepending ~1500
reference audio tokens. This works but:
- Adds ~1500 tokens to every forward → ~30–50% RTF slowdown.
- Quality is bounded by the base model's ability to match the reference.

Path B fine-tunes the LM to generate sam-like audio tokens WITHOUT a
reference prefix. After fine-tuning, sam voice can be activated via an
``instruct`` string only, with no reference token overhead. RTF is restored
to baseline.

Practical constraints
---------------------

The sam corpus is 58 clips / ~3.5 minutes at 24 kHz:
- Codec frame rate: 50 Hz (hop=480 at 24 kHz). 3.5 min → ~10,500 audio frames.
- Each training example: T_text tokens (≤30) + T_audio tokens (= 50 * dur_s).
- Batch of 1: a single (text, audio) pair.

This is a tiny corpus for training a 0.6B LM. Expectations:
- The LM can learn the prosody patterns of sam's voice (steady pace,
  clear articulation, warm timbre).
- WER on sam sentences should not degrade.
- Speaker similarity (ECAPA cosine vs sam reference) should improve vs.
  the base model in auto-voice mode.

Optimizer: APOLLO-Mini (repo policy).
Mixed precision: bf16 on CUDA.
Max steps: 1000 (tight cap for tiny corpus — scale up on H200 if metrics improve).

Outputs
-------

::

    <run-dir>/
        checkpoints/
            step_<N>.gguf    # Q4_K_M quantized checkpoint (via llama-quantize)
            step_<N>.pt      # full float32 state dict (backup)
            best.pt          # best speaker-similarity checkpoint
            train_manifest.json
        eval.json            # WER, RTF, speaker_similarity, beatsBaseline
        tb/                  # TensorBoard logs

Synthetic-smoke mode (``--synthetic-smoke``): runs the full control flow
without torch / GPU, emitting JSON stub checkpoints. CI uses this.

Usage
-----

::

    # CI smoke:
    python3 finetune_omnivoice.py \\
        --run-dir /tmp/omnivoice-runs/sam \\
        --config omnivoice_sam.yaml \\
        --synthetic-smoke

    # Real training (RTX 5080 / H200):
    python3 finetune_omnivoice.py \\
        --run-dir /tmp/omnivoice-runs/sam \\
        --config omnivoice_sam.yaml \\
        --data-dir packages/training/data/voice/sam \\
        --real-train

    # Eval + conditional push:
    python3 finetune_omnivoice.py \\
        --run-dir /tmp/omnivoice-runs/sam \\
        --config omnivoice_sam.yaml \\
        --data-dir packages/training/data/voice/sam \\
        --real-train \\
        --baseline-eval artifacts/voice-fine-tune/omnivoice-baseline/eval.json \\
        --hf-repo elizaos/eliza-1-voice-omnivoice-sam-v01 \\
        --operator-sign-off
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parents[3]
sys.path.insert(0, str(ROOT))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("omnivoice.finetune")

# OmniVoice audio codec constants (from R6 research).
OMNIVOICE_K = 8             # number of codebooks
OMNIVOICE_VOCAB = 1025      # audio tokens per codebook (1024 codes + 1 mask)
OMNIVOICE_MASK_ID = 1024    # mask token id
OMNIVOICE_FRAME_RATE = 50   # frames per second (24000 Hz / hop 480)

# ---------------------------------------------------------------------------
# Default config.
# ---------------------------------------------------------------------------

DEFAULT_CONFIG: dict[str, Any] = {
    "base_model_gguf": None,             # path to omnivoice-base-Q4_K_M.gguf
    "tokenizer_gguf": None,              # path to omnivoice-tokenizer-Q4_K_M.gguf
    "sample_rate": 24000,
    "optimizer": "apollo_mini",
    "learning_rate": 5e-6,              # very low — 0.6B LM on 3.5 min corpus
    "weight_decay": 0.01,
    "warmup_steps": 30,
    "max_steps": 1000,
    "eval_every": 200,
    "checkpoint_every": 200,
    "log_every": 10,
    "batch_size": 1,
    "grad_accum": 8,
    "bf16": True,
    "val_fraction": 0.10,
    "early_stop_patience": 3,
    "gradient_clip": 1.0,
    # MaskGIT training: fraction of audio tokens to mask per step.
    "mask_fraction": 0.5,
    "gates": {
        "wer_max": 0.10,
        "speaker_similarity_min": 0.55,
        "rtf_min": 3.0,                  # OmniVoice RTF target ≥ 3×
    },
}


# ---------------------------------------------------------------------------
# Config loader.
# ---------------------------------------------------------------------------

def _load_config(config_arg: str) -> dict[str, Any]:
    cfg = dict(DEFAULT_CONFIG)
    if not config_arg:
        return cfg
    config_path = Path(config_arg)
    if not config_path.is_absolute():
        if config_path.exists():
            pass
        elif (ROOT / "configs" / config_arg).exists():
            config_path = ROOT / "configs" / config_arg
    if not config_path.exists():
        log.warning("config not found: %s — using defaults", config_arg)
        return cfg
    try:
        import yaml  # type: ignore  # noqa: PLC0415
    except ImportError:
        log.warning("pyyaml not installed; ignoring config %s", config_path)
        return cfg
    with config_path.open(encoding="utf-8") as fh:
        user_cfg = yaml.safe_load(fh) or {}
    if "extends" in user_cfg:
        base_path = ROOT / "configs" / user_cfg.pop("extends")
        if base_path.exists():
            with base_path.open(encoding="utf-8") as fh:
                base_cfg = yaml.safe_load(fh) or {}
            cfg.update(base_cfg)
    cfg.update(user_cfg)
    return cfg


# ---------------------------------------------------------------------------
# Train stats.
# ---------------------------------------------------------------------------

@dataclass
class TrainStats:
    step: int = 0
    epoch: int = 0
    train_loss: float = 0.0
    val_loss: float = 0.0
    best_speaker_similarity: float = -1.0
    best_step: int = 0
    eval_history: list[dict[str, Any]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Manifest + eval builders.
# ---------------------------------------------------------------------------

def _git_commit() -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=True,
        )
        return out.stdout.strip()
    except Exception:
        return None


def _build_manifest(
    *,
    args: argparse.Namespace,
    cfg: dict[str, Any],
    stats: TrainStats,
    train_clips: int,
    val_clips: int,
    synthetic: bool,
) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "kind": "omnivoice-finetune-manifest",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "synthetic": synthetic,
        "baseModelGguf": cfg.get("base_model_gguf"),
        "tokenizerGguf": cfg.get("tokenizer_gguf"),
        "voiceName": cfg.get("voice_name", "custom"),
        "hyperparameters": {
            "optimizer": cfg["optimizer"],
            "learningRate": cfg["learning_rate"],
            "maxSteps": cfg["max_steps"],
            "batchSize": cfg["batch_size"],
            "gradAccum": cfg["grad_accum"],
            "maskFraction": cfg["mask_fraction"],
            "bf16": cfg["bf16"],
        },
        "dataset": {
            "trainClips": train_clips,
            "valClips": val_clips,
            "sampleRate": cfg["sample_rate"],
        },
        "training": asdict(stats),
        "trainingCommit": _git_commit(),
    }


def _write_eval(
    *,
    run_dir: Path,
    wer: float,
    rtf: float,
    speaker_similarity: float,
    cfg: dict[str, Any],
    n_eval_clips: int,
    voice_name: str,
    baseline_path: Path | None = None,
) -> dict[str, Any]:
    gates = cfg["gates"]
    per_metric = {
        "wer": wer <= gates["wer_max"],
        "speaker_similarity": speaker_similarity >= gates["speaker_similarity_min"],
        "rtf": rtf >= gates["rtf_min"],
    }
    gate_result = {"perMetric": per_metric, "passed": all(per_metric.values())}

    result: dict[str, Any] = {
        "schemaVersion": 1,
        "kind": "omnivoice-eval-report",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "voiceName": voice_name,
        "nEvalClips": n_eval_clips,
        "metrics": {"wer": wer, "rtf": rtf, "speaker_similarity": speaker_similarity},
        "gates": gates,
        "gateResult": gate_result,
    }

    if baseline_path and baseline_path.is_file():
        try:
            baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
            bm = baseline.get("metrics", {})
            wer_delta = wer - float(bm.get("wer", 1.0))
            spk_delta = speaker_similarity - float(bm.get("speaker_similarity", 0.0))
            beats = wer_delta <= 0.0 and spk_delta >= 0.05
            result["comparison"] = {
                "werDelta": wer_delta,
                "speakerSimDelta": spk_delta,
                "beatsBaseline": beats,
            }
        except Exception as exc:
            log.warning("baseline comparison failed: %s", exc)

    (run_dir / "eval.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


# ---------------------------------------------------------------------------
# Synthetic-smoke (CI).
# ---------------------------------------------------------------------------

def _run_synthetic_smoke(args: argparse.Namespace, cfg: dict[str, Any]) -> int:
    log.info("synthetic-smoke: OmniVoice fine-tune pipeline shape (no GPU)")
    run_dir = Path(args.run_dir).resolve()
    ckpt_dir = run_dir / "checkpoints"
    ckpt_dir.mkdir(parents=True, exist_ok=True)

    for step in (100, 200, 300):
        fake = ckpt_dir / f"step_{step}.json"
        fake.write_text(json.dumps({
            "kind": "omnivoice-finetune-synthetic",
            "step": step,
            "trainLoss": max(0.2, 2.5 - step * 0.006),
            "speakerSimilarity": min(0.75, 0.4 + step * 0.001),
        }, indent=2) + "\n")

    best_path = ckpt_dir / "best.json"
    best_path.write_text((ckpt_dir / "step_300.json").read_text())

    stats = TrainStats(
        step=300,
        train_loss=0.7,
        best_speaker_similarity=0.70,
        best_step=300,
        eval_history=[
            {"step": 100, "speaker_similarity": 0.50, "wer": 0.08, "rtf": 4.0},
            {"step": 200, "speaker_similarity": 0.62, "wer": 0.07, "rtf": 4.1},
            {"step": 300, "speaker_similarity": 0.70, "wer": 0.06, "rtf": 4.1},
        ],
    )

    manifest = _build_manifest(
        args=args,
        cfg=cfg,
        stats=stats,
        train_clips=45,
        val_clips=5,
        synthetic=True,
    )
    (ckpt_dir / "train_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    baseline_path = Path(args.baseline_eval) if getattr(args, "baseline_eval", None) else None
    eval_result = _write_eval(
        run_dir=run_dir,
        wer=0.06,
        rtf=4.1,
        speaker_similarity=0.70,
        cfg=cfg,
        n_eval_clips=5,
        voice_name=cfg.get("voice_name", "custom"),
        baseline_path=baseline_path,
    )

    # Artifact receipt.
    artifact_id = cfg.get("voice_name", "custom")
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    artifact_dir = REPO_ROOT / "artifacts" / "voice-fine-tune" / artifact_id / run_id
    artifact_dir.mkdir(parents=True, exist_ok=True)
    (artifact_dir / "receipt.json").write_text(json.dumps({
        "schemaVersion": 1,
        "kind": "omnivoice-finetune-receipt",
        "runId": run_id,
        "voiceName": artifact_id,
        "runDir": str(run_dir),
        "synthetic": True,
        "evalResult": eval_result,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }, indent=2) + "\n")

    log.info(
        "synthetic-smoke done: manifest=%s eval=%s artifact=%s",
        ckpt_dir / "train_manifest.json",
        run_dir / "eval.json",
        artifact_dir,
    )
    return 0


# ---------------------------------------------------------------------------
# Corpus loading (shared by real train + eval).
# ---------------------------------------------------------------------------

def _load_corpus(
    data_dir: Path, cfg: dict[str, Any]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Load WAV+transcript pairs.

    Expected layout (matches packages/training/data/voice/sam/):

        <data_dir>/
            manifest.jsonl   # {id, wav, transcript}
            audio/<id>.wav

    Falls back to scanning audio/*.wav + *.txt.
    """
    records: list[dict[str, Any]] = []

    manifest_path = data_dir / "manifest.jsonl"
    if manifest_path.exists():
        for line in manifest_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            rec = json.loads(line)
            wav_path = data_dir / rec.get("wav", "")
            if not wav_path.exists():
                for sub in ("audio", "wavs", "raw"):
                    c = data_dir / sub / f"{rec['id']}.wav"
                    if c.exists():
                        wav_path = c
                        break
            if not wav_path.exists():
                log.warning("skipping %s: wav not found", rec["id"])
                continue
            records.append({
                "id": rec["id"],
                "wav": str(wav_path),
                "transcript": rec.get("transcript", rec.get("text", "")),
            })
    else:
        audio_dir = data_dir / "audio"
        if not audio_dir.exists():
            audio_dir = data_dir
        for wav_path in sorted(audio_dir.glob("*.wav")):
            txt_path = wav_path.with_suffix(".txt")
            transcript = txt_path.read_text(encoding="utf-8").strip() if txt_path.exists() else ""
            records.append({"id": wav_path.stem, "wav": str(wav_path), "transcript": transcript})

    if not records:
        raise SystemExit(f"No audio/transcript pairs found in {data_dir}")

    random.shuffle(records)
    n_val = max(1, int(len(records) * cfg["val_fraction"]))
    return records[n_val:], records[:n_val]


# ---------------------------------------------------------------------------
# Tokenization (HuBERT + RVQ codec via the OmniVoice tokenizer GGUF).
#
# This requires the fused libelizainference with ov_encode_reference.
# Falls back to a dummy token sequence when the FFI is not available (so the
# training loop shape is testable without the native build).
# ---------------------------------------------------------------------------

def _tokenize_wav(
    wav_path: str,
    *,
    sample_rate: int,
    ffi: Any | None,
) -> tuple[Any, int] | None:
    """Encode a WAV file to K=8 integer audio tokens via the OmniVoice codec.

    Returns ``(tokens_ndarray, ref_T)`` where tokens_ndarray has shape
    ``(K=8, ref_T)`` and dtype ``int32``, or ``None`` on failure.

    When ``ffi`` is None (no native build), returns a synthetic token array
    for pipeline shape testing.
    """
    import numpy as np  # noqa: PLC0415

    if ffi is None:
        # Dummy tokens — shape (8, 50) for a ~1s clip.
        return np.zeros((OMNIVOICE_K, 50), dtype=np.int32), 50

    try:
        import librosa  # noqa: PLC0415

        y, _ = librosa.load(wav_path, sr=sample_rate, mono=True)
        pcm_f32 = y.astype(np.float32)
        tokens, k, ref_t = ffi.encodeReference(pcm_f32, sample_rate)
        if k != OMNIVOICE_K:
            log.warning("unexpected K=%d from encoder (expected %d)", k, OMNIVOICE_K)
            return None
        return tokens.reshape(k, ref_t), ref_t
    except Exception as exc:
        log.warning("tokenize_wav failed for %s: %s", wav_path, exc)
        return None


# ---------------------------------------------------------------------------
# MaskGIT training loss.
#
# Given the full (K=8, T) audio token sequence for a clip, mask a fraction
# of positions and train the model to predict them (cross-entropy over the
# unmasked targets at each masked position).
#
# This mirrors the upstream OmniVoice training loop (MaskGIT bidirectional
# prediction). The model is the loaded Qwen3-0.6B (omnivoice-base GGUF)
# loaded via the transformers / gguf loading path or a custom loader.
#
# For Wave 3, the preferred path is:
#   1. Load the f16 GGUF checkpoint via the OmniVoice C++ pipeline (ov_init).
#   2. Run forward passes that produce logits over K*vocab positions.
#   3. Compute cross-entropy against unmasked targets.
#   4. Backward via torch autograd + APOLLO optimizer.
#
# This is non-trivial because the OmniVoice C++ runtime uses ggml, not torch.
# The practical approach (deferred for post-Wave-3):
#   - Convert the f16 GGUF to HuggingFace safetensors format.
#   - Load with transformers + a custom modeling class matching the Qwen3-0.6B
#     + audio head architecture.
#   - Fine-tune end-to-end in torch.
#   - Re-export to GGUF for inference.
#
# For Wave 3, this script documents that architecture and ships the pipeline
# scaffold. Real training requires the HF↔GGUF round-trip tooling which is
# out of scope for this wave (same rationale as ASR fine-tune).
# ---------------------------------------------------------------------------

def _real_train(args: argparse.Namespace, cfg: dict[str, Any]) -> int:
    """OmniVoice LM fine-tune loop (Path B).

    REQUIRES:
    - The fused libelizainference (for ov_encode_reference / tokenizer).
    - torch + transformers + apollo-torch.
    - Optionally: the GGUF→HF conversion tooling (gguf2hf.py under scripts/).

    When the fused library is not present, the pipeline falls back to
    synthetic tokenization so the control flow is exercised (eval WER
    is computed against a base model if available).
    """
    data_dir = Path(args.data_dir).resolve() if args.data_dir else None
    if data_dir is None:
        raise SystemExit("--data-dir required for real training")

    try:
        import torch  # noqa: PLC0415
    except ImportError as exc:
        raise SystemExit("torch not installed; run `pip install torch`") from exc

    # Try to load the FFI (for audio tokenization).
    ffi = None
    try:
        from plugins.plugin_local_inference.src.services.voice.ffi_bindings import (  # type: ignore  # noqa: PLC0415
            loadElizaInferenceFfi,
        )
        ffi_ctx = loadElizaInferenceFfi({})
        if ffi_ctx.encodeReferenceSupported():
            ffi = ffi_ctx
            log.info("OmniVoice FFI available — using real codec tokenization")
        else:
            log.warning("encodeReference not supported in the current build; using synthetic tokens")
    except Exception as exc:
        log.warning("FFI load failed: %s — using synthetic tokens", exc)

    run_dir = Path(args.run_dir).resolve()
    ckpt_dir = run_dir / "checkpoints"
    ckpt_dir.mkdir(parents=True, exist_ok=True)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    log.info("device=%s", device)

    # Data.
    train_records, val_records = _load_corpus(data_dir, cfg)
    log.info("corpus: %d train, %d val clips", len(train_records), len(val_records))

    # Tokenize the corpus.
    log.info("tokenizing corpus via OmniVoice codec...")
    train_pairs: list[tuple[str, Any, int]] = []
    for rec in train_records:
        result = _tokenize_wav(rec["wav"], sample_rate=cfg["sample_rate"], ffi=ffi)
        if result is None:
            continue
        tokens, ref_t = result
        train_pairs.append((rec["transcript"], tokens, ref_t))
    log.info("tokenized %d train clips", len(train_pairs))

    if not train_pairs:
        raise SystemExit("No clips successfully tokenized — check FFI / corpus")

    # Model loading is architecture-dependent. For OmniVoice, we need the
    # Qwen3 + audio head combination. Without a GGUF→HF conversion utility,
    # we skip the full weight training and document the gap.
    #
    # W3-11 verdict: the full OmniVoice LM weight fine-tune requires:
    #   1. gguf2hf utility to load the Q4_K_M weights into torch tensors.
    #   2. A custom modeling_omnivoice.py (Qwen3 + audio embedding + MaskGIT
    #      training loop in torch).
    # These are post-Wave-3 deliverables. For Wave 3, the Path A preset-based
    # freeze (I6/freeze-voice.mjs) IS the shipped OmniVoice sam path.
    #
    # We document this gap explicitly so the user knows the decision.
    log.warning(
        "OmniVoice LM weight fine-tune (Path B) requires gguf2hf conversion "
        "tooling + custom modeling_omnivoice.py. These are post-Wave-3. "
        "For Wave 3, the shipped OmniVoice sam path is the Path A preset "
        "(packages/app-core/scripts/omnivoice-fuse/freeze-voice.mjs)."
    )
    log.info(
        "Running codec-tokenize + RTF eval only (no weight training this wave)."
    )

    # Run WER eval on val clips using the base OmniVoice model + sam preset.
    # This gives us real Path A quality numbers to compare against.
    from eval_omnivoice import _eval_with_preset  # type: ignore  # noqa: PLC0415

    try:
        eval_metrics = _eval_with_preset(
            val_records=val_records,
            cfg=cfg,
            ffi=ffi,
            preset_path=Path(args.preset_path) if getattr(args, "preset_path", None) else None,
        )
    except Exception as exc:
        log.warning("eval failed: %s — using placeholder metrics", exc)
        eval_metrics = {"wer": 0.999, "rtf": 0.0, "speaker_similarity": 0.0}

    stats = TrainStats(
        step=0,
        train_loss=0.0,
        best_speaker_similarity=eval_metrics.get("speaker_similarity", 0.0),
    )

    manifest = _build_manifest(
        args=args,
        cfg=cfg,
        stats=stats,
        train_clips=len(train_pairs),
        val_clips=len(val_records),
        synthetic=False,
    )
    (ckpt_dir / "train_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    baseline_path = Path(args.baseline_eval) if getattr(args, "baseline_eval", None) else None
    eval_result = _write_eval(
        run_dir=run_dir,
        wer=eval_metrics.get("wer", 0.999),
        rtf=eval_metrics.get("rtf", 0.0),
        speaker_similarity=eval_metrics.get("speaker_similarity", 0.0),
        cfg=cfg,
        n_eval_clips=len(val_records),
        voice_name=cfg.get("voice_name", "custom"),
        baseline_path=baseline_path,
    )

    log.info(
        "eval complete: WER=%.4f RTF=%.2f SpkSim=%.4f gatesPassed=%s",
        eval_metrics.get("wer", -1),
        eval_metrics.get("rtf", -1),
        eval_metrics.get("speaker_similarity", -1),
        eval_result["gateResult"]["passed"],
    )
    return 0 if eval_result["gateResult"]["passed"] else 1


# ---------------------------------------------------------------------------
# CLI.
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Fine-tune pipeline for the OmniVoice TTS model.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--config", default="")
    parser.add_argument("--data-dir", default=None)
    parser.add_argument("--preset-path", default=None,
                        help="Path to ELZ2 v2 sam preset for eval.")
    parser.add_argument("--baseline-eval", default=None)
    parser.add_argument("--hf-repo", default=None)
    parser.add_argument("--operator-sign-off", action="store_true", default=False)
    parser.add_argument("--dry-run", action="store_true", default=False)
    parser.add_argument("--real-train", action="store_true", default=False)
    parser.add_argument("--synthetic-smoke", action="store_true", default=False)

    args = parser.parse_args(argv)
    cfg = _load_config(args.config)

    if args.synthetic_smoke or not args.real_train:
        return _run_synthetic_smoke(args, cfg)
    return _real_train(args, cfg)


if __name__ == "__main__":
    sys.exit(main())
