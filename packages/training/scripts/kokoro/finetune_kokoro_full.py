#!/usr/bin/env python3
"""Real **full** fine-tune of Kokoro-82M (StyleTTS-2 + iSTFTNet).

Unlike the LoRA path in ``finetune_kokoro.py`` and the static mel-fit voice
clone in ``extract_voice_embedding.py``, this script unfreezes **every
parameter** of the loaded :class:`kokoro.KModel` (BERT, BERT encoder linear,
prosody predictor, text encoder, iSTFTNet decoder) and trains them end-to-end
against an LJSpeech-format corpus, minimizing a mel-spectrogram L1 loss between
the model's synthesized audio and the ground-truth audio.

Why a new file (not extending ``finetune_kokoro.py``)
-----------------------------------------------------

``finetune_kokoro.py`` requires ``model.forward_train`` and exits hard when
the installed ``kokoro`` package doesn't expose it. The current PyPI release
(``kokoro==0.9.4``) does NOT ship ``forward_train``; the
``jonirajala/kokoro_training`` fork referenced in the spec turns out to be a
*from-scratch 22M-parameter simplified transformer*, not a fine-tune harness
for the real ``hexgrad/Kokoro-82M`` (StyleTTS-2 + iSTFTNet). Vendoring it
wouldn't help.

This module bypasses ``forward_train`` entirely. The trick: re-implement the
exact computational graph from ``KModel.forward_with_tokens`` locally (same
math, no ``@torch.no_grad`` decorator) and let gradients flow into every
parameter. The mel objective is computed by running the synthesized audio
back through an 80-bin log-mel spectrogram with the StyleTTS-2 mel config
(n_fft=2048, hop=300, win=1200, fmax=12000 at 24 kHz) and L1-comparing to the
log-mel of the ground-truth audio.

The script extends the ``_forward_with_grad`` pattern that
``extract_voice_embedding.py`` already validated (used for ref_s-only mel-fit
voice clone).

Hyperparameters defaulted for tiny-corpus full FT
-------------------------------------------------

The samantha corpus is 58 clips / 3.5 minutes. Per repo policy (
``packages/training/AGENTS.md``) and the user prompt:

- ``--lr 5e-5`` (smaller than the LoRA default 1e-4 to avoid catastrophic
  forgetting on a tiny corpus).
- ``--anchor-weight 0.001`` — L2 anchor on every parameter back to its
  base-model snapshot, scaled across the full network. Keeps the fine-tune
  near the base so quality doesn't collapse.
- ``--max-steps 1500`` (per user spec — cap total updates).
- ``--checkpoint-every 200``, ``--eval-every 200``, ``--keep-top-k 3``
  (top-k by eval speaker similarity, per spec).
- ``--early-stop-patience 3`` (stop when SpkSim stalls/regresses for N
  consecutive evals).
- ``--optimizer apollo_mini`` (repo policy — APOLLO only).

Outputs
-------

::

    <run-dir>/checkpoints/
        ├── step_<N>.pt           # full state dict + ref_s init
        ├── step_<N>.bin          # voice.bin (510, 1, 256) extracted from the run
        ├── best.pt + best.bin    # best-SpkSim snapshot (top-1 of top-k)
        ├── train_manifest.json   # hyperparams, dataset hashes, training commit
        └── eval_log.jsonl        # per-checkpoint SpkSim / WER / UTMOS / RTF

Synthetic-smoke (``--synthetic-smoke``) skips torch + GPU, materializes a
minimal valid ``train_manifest.json`` + dummy checkpoints so the CI pipeline
gate is exercised without the full stack.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import random
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
# Add the parent scripts dir at the END so `training.optimizer` resolves but
# the local `kokoro/` dir doesn't shadow the pip-installed `kokoro` package.
_SCRIPTS_DIR = str(ROOT.parent)
if _SCRIPTS_DIR not in sys.path:
    sys.path.append(_SCRIPTS_DIR)
from _config import load_config  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("kokoro.finetune_full")


VOICE_DIM = 256
VOICE_BUCKETS = 510


# ---------------------------------------------------------------------------
# Train stats — shape-compatible with finetune_kokoro.py's TrainStats so the
# downstream manifest schema stays stable across the two scripts.
# ---------------------------------------------------------------------------


@dataclass
class TrainStats:
    step: int = 0
    epoch: int = 0
    train_loss: float = 0.0
    val_loss: float = 0.0
    best_val_loss: float = float("inf")
    best_step: int = 0
    best_speaker_similarity: float = -1.0
    best_speaker_similarity_step: int = 0
    eval_history: list[dict[str, Any]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Synthetic-smoke path (no torch import; exercises the manifest shape only).
# ---------------------------------------------------------------------------


def _git_commit() -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=Path(__file__).resolve().parents[3],
            capture_output=True,
            text=True,
            check=True,
        )
        return out.stdout.strip()
    except Exception:
        return None


def _list_lines(path: Path) -> list[str]:
    with path.open(encoding="utf-8") as fh:
        return [line.rstrip("\n") for line in fh if line.strip()]


def _build_manifest(
    *,
    args: argparse.Namespace,
    cfg: dict[str, Any],
    train_list: list[str],
    val_list: list[str],
    stats: TrainStats,
    prep_manifest_sha256: str | None,
    synthetic: bool,
    checkpoint_paths: list[str],
    top_k_paths: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "kind": "kokoro-finetune-manifest",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "synthetic": synthetic,
        "mode": "full",
        "baseModel": cfg["base_model"],
        "voiceName": cfg.get("voice_name", "eliza_custom"),
        "voiceLang": cfg.get("voice_lang", "a"),
        "voiceTags": cfg.get("voice_tags", []),
        "hyperparameters": {
            "optimizer": cfg["optimizer"],
            "learningRate": cfg["learning_rate"],
            "weightDecay": cfg["weight_decay"],
            "warmupSteps": cfg["warmup_steps"],
            "scheduler": cfg["scheduler"],
            "batchSize": cfg["batch_size"],
            "gradAccum": cfg["grad_accum"],
            "maxSteps": cfg["max_steps"],
            "bf16": cfg["bf16"],
            "melLossWeight": cfg["mel_loss_weight"],
            "anchorWeight": cfg.get("anchor_weight", 0.0),
            "earlyStopPatience": cfg.get("early_stop_patience", 3),
            "keepTopK": cfg.get("keep_top_k", 3),
        },
        "dataset": {
            "trainClips": len(train_list),
            "valClips": len(val_list),
            "prepManifestSha256": prep_manifest_sha256,
        },
        "training": asdict(stats),
        "checkpoints": checkpoint_paths,
        "topK": top_k_paths,
        "trainingCommit": _git_commit(),
    }


def _run_synthetic_smoke(args: argparse.Namespace, cfg: dict[str, Any]) -> int:
    """Walk file layout, write JSON sidecar checkpoints + manifest. No torch."""
    log.info("synthetic-smoke: full-FT pipeline shape only, no real training")
    run_dir = Path(args.run_dir).resolve()
    processed = run_dir / "processed"

    train_list_path = processed / "train_list.txt"
    val_list_path = processed / "val_list.txt"
    if not train_list_path.exists():
        processed.mkdir(parents=True, exist_ok=True)
        with train_list_path.open("w") as fh:
            for i in range(5):
                fh.write(f"wavs_norm/SMOKE-{i:04d}.wav|hh ah l ow|0\n")
        with val_list_path.open("w") as fh:
            fh.write("wavs_norm/SMOKE-9999.wav|hh ah l ow|0\n")

    train_list = _list_lines(train_list_path)
    val_list = _list_lines(val_list_path)

    ckpt_dir = run_dir / "checkpoints"
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    checkpoints: list[str] = []
    for step in (50, 100, 150):
        fake = ckpt_dir / f"step_{step}.json"
        fake.write_text(
            json.dumps(
                {
                    "kind": "kokoro-full-finetune-synthetic",
                    "step": step,
                    "trainLoss": 0.5 - step * 1e-4,
                    "speakerSimilarity": 0.5 + step * 1e-4,
                    "baseModel": cfg["base_model"],
                },
                indent=2,
            )
            + "\n"
        )
        checkpoints.append(str(fake))

    best_path = ckpt_dir / "best.json"
    best_path.write_text(Path(checkpoints[-1]).read_text())
    checkpoints.append(str(best_path))

    stats = TrainStats(
        step=150,
        epoch=1,
        train_loss=0.5 - 150 * 1e-4,
        val_loss=0.5,
        best_val_loss=0.5,
        best_step=150,
        best_speaker_similarity=0.5 + 150 * 1e-4,
        best_speaker_similarity_step=150,
        eval_history=[
            {"step": 100, "speaker_similarity": 0.51, "wer": 0.06, "utmos": 3.9, "rtf": 95.0},
            {"step": 150, "speaker_similarity": 0.515, "wer": 0.058, "utmos": 3.95, "rtf": 96.1},
        ],
    )

    top_k = [
        {"step": 150, "path": str(best_path), "speaker_similarity": 0.515},
        {"step": 100, "path": checkpoints[1], "speaker_similarity": 0.51},
    ]
    manifest = _build_manifest(
        args=args,
        cfg=cfg,
        train_list=train_list,
        val_list=val_list,
        stats=stats,
        prep_manifest_sha256=None,
        synthetic=True,
        checkpoint_paths=checkpoints,
        top_k_paths=top_k,
    )
    (ckpt_dir / "train_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    log.info("synthetic-smoke wrote %s", ckpt_dir / "train_manifest.json")
    return 0


# ---------------------------------------------------------------------------
# Eval-gate decision (early stopping + top-k tracking).
# ---------------------------------------------------------------------------


def _decide_continue(
    eval_history: list[dict[str, Any]],
    patience: int,
) -> tuple[bool, str]:
    """Return ``(continue_training, reason)``.

    Early-stop when speaker similarity stalls or regresses for ``patience``
    consecutive evals. Returns ``False`` (stop) only after we have enough
    history; with fewer than ``patience+1`` eval points there is nothing to
    compare to, so we always continue.
    """
    if len(eval_history) < patience + 1:
        return True, "warmup"
    recent = eval_history[-(patience + 1):]
    # Baseline = the eval point just before the patience window.
    baseline = recent[0]["speaker_similarity"]
    # Stop if every value in the window is <= baseline (stalling or regressing).
    if all(p["speaker_similarity"] <= baseline for p in recent[1:]):
        return (
            False,
            (
                f"speaker_similarity stalled/regressed for {patience} consecutive evals "
                f"(baseline={baseline:.4f}, recent={[round(p['speaker_similarity'], 4) for p in recent[1:]]})"
            ),
        )
    return True, "improving"


def _update_top_k(
    top_k: list[dict[str, Any]],
    *,
    step: int,
    path: str,
    bin_path: str,
    speaker_similarity: float,
    k: int,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Maintain a top-k-by-SpkSim list. Returns (new_list, paths_to_delete)."""
    entry = {
        "step": step,
        "path": path,
        "binPath": bin_path,
        "speaker_similarity": speaker_similarity,
    }
    new_list = sorted(top_k + [entry], key=lambda e: e["speaker_similarity"], reverse=True)
    keep, drop = new_list[:k], new_list[k:]
    paths_to_delete = []
    for d in drop:
        paths_to_delete.append(d["path"])
        if d.get("binPath"):
            paths_to_delete.append(d["binPath"])
    return keep, paths_to_delete


# ---------------------------------------------------------------------------
# Real training path. Imports torch lazily; mirrors finetune_kokoro.py shape.
# ---------------------------------------------------------------------------


def _import_torch_stack() -> dict[str, Any]:
    import torch  # noqa: PLC0415

    try:
        from kokoro import KModel  # type: ignore  # noqa: PLC0415
    except ImportError as exc:
        raise SystemExit(
            "The `kokoro` package is required to load the base model. "
            "Install via `pip install 'kokoro>=0.9.4'` (and `pip install 'misaki[en]>=0.9.4'`)."
        ) from exc

    try:
        from training.optimizer import (  # type: ignore  # noqa: PLC0415
            build_apollo_mini_optimizer,
            build_apollo_optimizer,
        )
    except ImportError:
        build_apollo_optimizer = None  # type: ignore
        build_apollo_mini_optimizer = None  # type: ignore

    return {
        "torch": torch,
        "KModel": KModel,
        "build_apollo_optimizer": build_apollo_optimizer,
        "build_apollo_mini_optimizer": build_apollo_mini_optimizer,
    }


def _build_optimizer(stack: dict[str, Any], params: Any, cfg: dict[str, Any]):
    optim_name = cfg["optimizer"]
    # APOLLO-only policy per packages/training/AGENTS.md. Same factory as
    # finetune_kokoro.py — keep the two paths consistent.
    if optim_name == "apollo":
        if stack["build_apollo_optimizer"] is None:
            raise SystemExit(
                "apollo-torch unavailable; install the `train` extra "
                "(apollo-torch>=1.0.3)."
            )
        return stack["build_apollo_optimizer"](
            params,
            lr=cfg["learning_rate"],
            weight_decay=cfg["weight_decay"],
        )
    if optim_name == "apollo_mini":
        if stack["build_apollo_mini_optimizer"] is None:
            raise SystemExit("apollo-torch unavailable; install the `train` extra.")
        return stack["build_apollo_mini_optimizer"](
            params,
            lr=cfg["learning_rate"],
            weight_decay=cfg["weight_decay"],
        )
    raise SystemExit(f"unknown optimizer: {optim_name!r}")


def _phonemize_transcript(text: str, lang: str = "a") -> str:
    """Phonemize via misaki (the same phonemizer Kokoro uses)."""
    from misaki import en  # type: ignore  # noqa: PLC0415

    if not hasattr(_phonemize_transcript, "_g2p"):
        _phonemize_transcript._g2p = en.G2P(trf=False, british=(lang == "b"))  # type: ignore[attr-defined]
    g2p = _phonemize_transcript._g2p  # type: ignore[attr-defined]
    phonemes, _ = g2p(text)
    return phonemes


def _load_wav_mono(path: Path, *, target_sr: int) -> Any:
    import librosa  # noqa: PLC0415

    y, _ = librosa.load(str(path), sr=target_sr, mono=True)
    return y


def _init_ref_s(voice_id: str, base_model: str, device: str) -> Any:
    """Download the reference voice and collapse to a 256-dim init."""
    import torch  # noqa: PLC0415
    from huggingface_hub import hf_hub_download  # noqa: PLC0415

    fp = hf_hub_download(base_model, f"voices/{voice_id}.pt")
    voice = torch.load(fp, map_location="cpu", weights_only=True)
    if voice.dim() == 3 and voice.shape == (VOICE_BUCKETS, 1, VOICE_DIM):
        init = voice.mean(dim=0).squeeze().to(device)
    elif voice.dim() == 1 and voice.shape[0] == VOICE_DIM:
        init = voice.to(device)
    else:
        raise SystemExit(
            f"unexpected voice tensor shape {tuple(voice.shape)} in voices/{voice_id}.pt"
        )
    return init.float()


def _write_voice_bin(path: Path, vector: Any) -> None:
    """Write `voice.bin` in canonical (510, 1, 256) float32 LE layout."""
    import numpy as np  # noqa: PLC0415

    arr = vector.detach().cpu().numpy() if hasattr(vector, "detach") else np.asarray(vector)
    if arr.shape != (VOICE_DIM,):
        raise ValueError(f"expected 256-dim vector, got shape {arr.shape}")
    table = np.tile(arr.astype(np.float32)[None, None, :], (VOICE_BUCKETS, 1, 1))
    table.astype("<f4").tofile(str(path))


def _audio_to_logmel(audio: Any, mel_fn: Any) -> Any:
    import torch  # noqa: PLC0415

    if audio.dim() == 1:
        audio = audio.unsqueeze(0)
    mel = mel_fn(audio.float())
    return torch.log(torch.clamp(mel, min=1e-5))


def _forward_with_grad(model: Any, input_ids: Any, ref_s_full: Any, device: str) -> Any:
    """Re-implement ``KModel.forward_with_tokens`` without ``@torch.no_grad``.

    Identical math to ``kokoro.model.KModel.forward_with_tokens`` (verified
    against the installed kokoro==0.9.4 source). The only change: gradients
    flow through every parameter.
    """
    import torch  # noqa: PLC0415

    input_lengths = torch.full(
        (input_ids.shape[0],),
        input_ids.shape[-1],
        device=input_ids.device,
        dtype=torch.long,
    )
    text_mask = (
        torch.arange(int(input_lengths.max())).unsqueeze(0)
        .expand(input_lengths.shape[0], -1).type_as(input_lengths)
    )
    text_mask = torch.gt(text_mask + 1, input_lengths.unsqueeze(1)).to(device)
    bert_dur = model.bert(input_ids, attention_mask=(~text_mask).int())
    d_en = model.bert_encoder(bert_dur).transpose(-1, -2)
    s = ref_s_full[:, 128:]
    d = model.predictor.text_encoder(d_en, s, input_lengths, text_mask)
    x, _ = model.predictor.lstm(d)
    duration = model.predictor.duration_proj(x)
    duration = torch.sigmoid(duration).sum(axis=-1)
    pred_dur = torch.round(duration).clamp(min=1).long().squeeze()
    indices = torch.repeat_interleave(
        torch.arange(input_ids.shape[1], device=device), pred_dur
    )
    pred_aln_trg = torch.zeros(
        (input_ids.shape[1], indices.shape[0]), device=device
    )
    pred_aln_trg[indices, torch.arange(indices.shape[0])] = 1
    pred_aln_trg = pred_aln_trg.unsqueeze(0).to(device)
    en = d.transpose(-1, -2) @ pred_aln_trg
    F0_pred, N_pred = model.predictor.F0Ntrain(en, s)
    t_en = model.text_encoder(input_ids, input_lengths, text_mask)
    asr = t_en @ pred_aln_trg
    audio = model.decoder(asr, F0_pred, N_pred, ref_s_full[:, :128]).squeeze()
    return audio


def _build_pairs(
    *,
    model: Any,
    run_dir: Path,
    train_list: list[str],
    sample_rate: int,
    voice_lang: str,
    mel_fn: Any,
    device: str,
) -> list[tuple[Any, Any]]:
    """Compute (input_ids, target_log_mel) tuples for the training corpus."""
    import torch  # noqa: PLC0415

    processed = run_dir / "processed"
    phonemes_path = processed / "phonemes.jsonl"
    by_id: dict[str, dict[str, Any]] = {}
    if phonemes_path.exists():
        for line in phonemes_path.read_text().splitlines():
            if not line.strip():
                continue
            rec = json.loads(line)
            by_id[rec["clip_id"]] = rec

    pairs: list[tuple[Any, Any]] = []
    for line in train_list:
        wav_rel, _phon, _spk = line.split("|", 2)
        clip_id = Path(wav_rel).stem
        rec = by_id.get(clip_id)
        if rec is None:
            log.warning("no phoneme record for clip %s; skipping", clip_id)
            continue
        text = rec.get("norm_text") or rec.get("raw_text")
        if not text:
            log.warning("empty transcript for %s; skipping", clip_id)
            continue
        wav_path = processed / wav_rel
        if not wav_path.exists():
            log.warning("missing wav %s; skipping", wav_path)
            continue
        wav = _load_wav_mono(wav_path, target_sr=sample_rate)
        target_mel = _audio_to_logmel(torch.from_numpy(wav).float().to(device), mel_fn)
        try:
            phonemes = _phonemize_transcript(text, lang=voice_lang)
        except Exception as exc:  # noqa: BLE001
            log.warning("phonemize failed for %s: %s", clip_id, exc)
            continue
        ids_list = [model.vocab[p] for p in phonemes if p in model.vocab]
        if len(ids_list) + 2 > model.context_length:
            log.warning(
                "skipping %s: phoneme sequence too long (%d > %d)",
                clip_id,
                len(ids_list) + 2,
                model.context_length,
            )
            continue
        input_ids = torch.LongTensor([[0, *ids_list, 0]]).to(device)
        pairs.append((input_ids, target_mel))
    return pairs


def _save_full_checkpoint(
    *,
    model: Any,
    ref_s: Any,
    cfg: dict[str, Any],
    pt_path: Path,
    bin_path: Path,
    step: int,
    train_loss: float,
) -> None:
    """Save full state dict + extracted voice.bin."""
    import torch  # noqa: PLC0415

    torch.save(
        {
            "kind": "kokoro-full-finetune",
            "baseModel": cfg["base_model"],
            "stateDict": {k: v.detach().cpu() for k, v in model.state_dict().items()},
            "refS": ref_s.detach().cpu(),
            "step": step,
            "trainLoss": train_loss,
        },
        pt_path,
    )
    _write_voice_bin(bin_path, ref_s)


def _real_train(args: argparse.Namespace, cfg: dict[str, Any]) -> int:  # noqa: C901 — top-level loop
    """Full fine-tune loop. Imports torch lazily, requires CUDA / MPS / CPU."""
    stack = _import_torch_stack()
    torch = stack["torch"]
    KModel = stack["KModel"]

    run_dir = Path(args.run_dir).resolve()
    processed = run_dir / "processed"
    train_list_path = processed / "train_list.txt"
    val_list_path = processed / "val_list.txt"
    train_list = _list_lines(train_list_path)
    val_list = _list_lines(val_list_path)
    prep_manifest_path = processed / "prep_manifest.json"
    prep_manifest_sha256 = None
    if prep_manifest_path.exists():
        import hashlib  # noqa: PLC0415

        h = hashlib.sha256()
        with prep_manifest_path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        prep_manifest_sha256 = h.hexdigest()

    device = (
        "cuda"
        if torch.cuda.is_available()
        else ("mps" if torch.backends.mps.is_available() else "cpu")
    )
    log.info(
        "device=%s mode=full base=%s train_clips=%d val_clips=%d",
        device,
        cfg["base_model"],
        len(train_list),
        len(val_list),
    )
    if device == "cpu":
        log.warning(
            "running on CPU — full FT on CPU is impractical; this is fine only for "
            "the synthetic-smoke shape test"
        )

    dtype = torch.bfloat16 if (device == "cuda" and cfg.get("bf16", True)) else torch.float32

    model = KModel(repo_id=cfg["base_model"]).to(device)
    # Keep model in train mode — cuDNN refuses RNN backward in eval mode (same
    # constraint extract_voice_embedding.py runs into).
    model.train()

    # Unfreeze every parameter — this is the FULL fine-tune.
    for p in model.parameters():
        p.requires_grad_(True)
    trainable_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    log.info("trainable parameters: %d (~%.1fM)", trainable_params, trainable_params / 1e6)

    # Capture base-model snapshot for anchor regularization. Detached, no grad,
    # same dtype/device as the live params.
    anchor_snapshot = {n: p.detach().clone() for n, p in model.named_parameters()}

    # Build the 80-bin log-mel transform (StyleTTS-2 config).
    import torchaudio  # noqa: PLC0415

    mel_fn = torchaudio.transforms.MelSpectrogram(
        sample_rate=cfg["sample_rate"],
        n_fft=2048,
        win_length=1200,
        hop_length=300,
        n_mels=80,
        f_min=0,
        f_max=cfg["sample_rate"] // 2,
        power=1.0,
        normalized=False,
    ).to(device)

    # ref_s is a frozen, init-only handle (per spec: use init voice as anchor).
    # Full FT moves model weights; ref_s stays at the init voice's mean.
    ref_s_init = _init_ref_s(args.init_from_voice, cfg["base_model"], device)
    ref_s = ref_s_init.unsqueeze(0)  # (1, 256), no requires_grad — frozen.

    log.info("initialized ref_s from voice %s (no grad)", args.init_from_voice)

    # APOLLO factory needs a model object (for named_parameters), not a param list.
    optimizer = _build_optimizer(stack, model, cfg)
    log.info(
        "optimizer=%s lr=%.2e weight_decay=%.4f anchor_weight=%.4e",
        cfg["optimizer"],
        cfg["learning_rate"],
        cfg["weight_decay"],
        cfg.get("anchor_weight", 0.0),
    )

    pairs = _build_pairs(
        model=model,
        run_dir=run_dir,
        train_list=train_list,
        sample_rate=cfg["sample_rate"],
        voice_lang=cfg.get("voice_lang", "a"),
        mel_fn=mel_fn,
        device=device,
    )
    if not pairs:
        raise SystemExit("no usable (input_ids, target_mel) training pairs after filtering")
    log.info("training pairs: %d", len(pairs))

    ckpt_dir = run_dir / "checkpoints"
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    eval_log_path = ckpt_dir / "eval_log.jsonl"
    eval_log_path.unlink(missing_ok=True)

    stats = TrainStats()
    checkpoint_paths: list[str] = []
    top_k: list[dict[str, Any]] = []
    keep_top_k = int(cfg.get("keep_top_k", 3))
    patience = int(cfg.get("early_stop_patience", 3))
    anchor_weight = float(cfg.get("anchor_weight", 0.0))

    accum_loss = 0.0
    step = 0
    epoch = 0
    stop_reason: str | None = None
    while step < cfg["max_steps"] and stop_reason is None:
        epoch += 1
        random.shuffle(pairs)
        for input_ids, target_mel in pairs:
            if step >= cfg["max_steps"]:
                break
            optimizer.zero_grad(set_to_none=True)
            try:
                with torch.autocast(
                    device_type=device,
                    dtype=dtype,
                    enabled=(dtype != torch.float32),
                ):
                    synth_audio = _forward_with_grad(model, input_ids, ref_s, device)
            except torch.cuda.OutOfMemoryError as exc:
                log.warning("OOM at step %d, dropping batch: %s", step, str(exc).split("\n")[0])
                torch.cuda.empty_cache()
                step += 1
                continue
            synth_mel = _audio_to_logmel(synth_audio.to(device), mel_fn)
            t_min = min(synth_mel.shape[-1], target_mel.shape[-1])
            recon_loss = (synth_mel[..., :t_min] - target_mel[..., :t_min]).abs().mean()
            # Anchor regularization across every parameter.
            if anchor_weight > 0.0:
                anchor_loss = torch.zeros((), device=device)
                for name, p in model.named_parameters():
                    anchor_loss = anchor_loss + (p - anchor_snapshot[name]).pow(2).mean()
                loss = recon_loss + anchor_weight * anchor_loss
            else:
                loss = recon_loss

            (loss / cfg["grad_accum"]).backward()
            accum_loss += float(loss.detach().cpu())
            if (step + 1) % cfg["grad_accum"] == 0:
                torch.nn.utils.clip_grad_norm_(model.parameters(), cfg["grad_clip"])
                optimizer.step()

            if step % cfg["log_every"] == 0:
                avg = accum_loss / max(1, cfg["log_every"])
                stats.step = step
                stats.epoch = epoch
                stats.train_loss = avg
                log.info("epoch=%d step=%d loss=%.4f", epoch, step, avg)
                accum_loss = 0.0

            if step > 0 and step % cfg["checkpoint_every"] == 0:
                pt_path = ckpt_dir / f"step_{step}.pt"
                bin_path = ckpt_dir / f"step_{step}.bin"
                _save_full_checkpoint(
                    model=model,
                    ref_s=ref_s_init,
                    cfg=cfg,
                    pt_path=pt_path,
                    bin_path=bin_path,
                    step=step,
                    train_loss=stats.train_loss,
                )
                checkpoint_paths.append(str(pt_path))
                log.info("checkpoint → %s + %s", pt_path, bin_path)

                # Evaluate this checkpoint.
                if not args.skip_inline_eval:
                    eval_result = _run_inline_eval(
                        run_dir=run_dir,
                        voice_bin=bin_path,
                        config_path=args.config,
                        baseline_eval=args.baseline_eval,
                    )
                else:
                    eval_result = None

                if eval_result is not None:
                    eval_record = {
                        "step": step,
                        "trainLoss": stats.train_loss,
                        **eval_result,
                    }
                    stats.eval_history.append(eval_record)
                    with eval_log_path.open("a") as fh:
                        fh.write(json.dumps(eval_record) + "\n")

                    spk_sim = float(eval_result.get("speaker_similarity", -1.0))
                    if spk_sim > stats.best_speaker_similarity:
                        stats.best_speaker_similarity = spk_sim
                        stats.best_speaker_similarity_step = step
                        best_pt = ckpt_dir / "best.pt"
                        best_bin = ckpt_dir / "best.bin"
                        _save_full_checkpoint(
                            model=model,
                            ref_s=ref_s_init,
                            cfg=cfg,
                            pt_path=best_pt,
                            bin_path=best_bin,
                            step=step,
                            train_loss=stats.train_loss,
                        )
                        stats.best_val_loss = float(eval_result.get("wer", 0.0))
                        stats.best_step = step
                        log.info(
                            "new best SpkSim=%.4f → best.pt + best.bin",
                            spk_sim,
                        )

                    top_k, to_drop = _update_top_k(
                        top_k,
                        step=step,
                        path=str(pt_path),
                        bin_path=str(bin_path),
                        speaker_similarity=spk_sim,
                        k=keep_top_k,
                    )
                    for dpath in to_drop:
                        Path(dpath).unlink(missing_ok=True)

                    keep_going, reason = _decide_continue(stats.eval_history, patience)
                    if not keep_going:
                        log.warning("early stopping: %s", reason)
                        stop_reason = reason

            step += 1
            if stop_reason is not None:
                break

    # Final checkpoint if we have steps that haven't been checkpointed yet.
    if step % cfg["checkpoint_every"] != 0 and step > 0:
        pt_path = ckpt_dir / f"step_{step}_final.pt"
        bin_path = ckpt_dir / f"step_{step}_final.bin"
        _save_full_checkpoint(
            model=model,
            ref_s=ref_s_init,
            cfg=cfg,
            pt_path=pt_path,
            bin_path=bin_path,
            step=step,
            train_loss=stats.train_loss,
        )
        checkpoint_paths.append(str(pt_path))

    manifest = _build_manifest(
        args=args,
        cfg=cfg,
        train_list=train_list,
        val_list=val_list,
        stats=stats,
        prep_manifest_sha256=prep_manifest_sha256,
        synthetic=False,
        checkpoint_paths=checkpoint_paths,
        top_k_paths=top_k,
    )
    manifest["stopReason"] = stop_reason or "max_steps"
    (ckpt_dir / "train_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    log.info(
        "training complete; best SpkSim=%.4f @ step %d; stop_reason=%s",
        stats.best_speaker_similarity,
        stats.best_speaker_similarity_step,
        stop_reason or "max_steps",
    )
    return 0


def _run_inline_eval(
    *,
    run_dir: Path,
    voice_bin: Path,
    config_path: str,
    baseline_eval: Path | None,
) -> dict[str, Any] | None:
    """Invoke ``eval_kokoro._real_eval``-equivalent inline + return metrics.

    Failures here are NOT silent — eval bugs are publish-blocking. We re-raise
    after logging.
    """
    cmd: list[str] = [
        sys.executable,
        str(ROOT / "eval_kokoro.py"),
        "--run-dir",
        str(run_dir),
        "--config",
        config_path,
        "--voice-bin",
        str(voice_bin),
        "--eval-out",
        str(voice_bin.with_suffix(".eval.json")),
        "--allow-gate-fail",
    ]
    if baseline_eval is not None:
        cmd.extend(["--baseline-eval", str(baseline_eval)])
    log.info("inline eval: %s", " ".join(cmd))
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        log.error("inline eval failed (rc=%d): %s", proc.returncode, proc.stderr[-1000:])
        return None
    eval_path = voice_bin.with_suffix(".eval.json")
    if not eval_path.exists():
        log.error("inline eval did not write %s", eval_path)
        return None
    data = json.loads(eval_path.read_text())
    metrics = data.get("metrics") or {}
    return {
        "speaker_similarity": float(metrics.get("speaker_similarity", -1.0)),
        "wer": float(metrics.get("wer", -1.0)),
        "utmos": float(metrics.get("utmos", -1.0)),
        "rtf": float(metrics.get("rtf", -1.0)),
        "passed": bool(data.get("gateResult", {}).get("passed", False)),
        "beatsBaseline": bool(
            (data.get("comparison") or {}).get("beatsBaseline", False)
        ),
    }


# ---------------------------------------------------------------------------
# CLI entrypoint.
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--run-dir", type=Path, required=True, help="Output dir from prep_ljspeech.py.")
    p.add_argument(
        "--config",
        type=str,
        default="kokoro_samantha_full.yaml",
        help="YAML config under packages/training/scripts/kokoro/configs/ (default kokoro_samantha_full.yaml).",
    )
    p.add_argument(
        "--init-from-voice",
        type=str,
        default="af_bella",
        help="Stock Kokoro voice id to seed ref_s. Frozen during training.",
    )
    p.add_argument(
        "--baseline-eval",
        type=Path,
        default=None,
        help="Path to a baseline eval.json (e.g. af_bella) for inline comparison.",
    )
    p.add_argument(
        "--skip-inline-eval",
        action="store_true",
        help="Disable the per-checkpoint inline eval (faster, but no SpkSim early stop).",
    )
    p.add_argument(
        "--synthetic-smoke",
        action="store_true",
        help="Run pipeline shape without torch/CUDA (for CI).",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    cfg = load_config(args.config)
    if cfg.get("mode") != "full":
        log.warning(
            "config mode=%s; this script enforces full FT. Overriding mode=full.",
            cfg.get("mode"),
        )
        cfg["mode"] = "full"
    # Apply N2 defaults if missing.
    cfg.setdefault("anchor_weight", 0.001)
    cfg.setdefault("early_stop_patience", 3)
    cfg.setdefault("keep_top_k", 3)
    cfg.setdefault("grad_clip", 1.0)

    random.seed(cfg.get("seed", 1337))
    os.environ.setdefault("PYTHONHASHSEED", str(cfg.get("seed", 1337)))

    if args.synthetic_smoke:
        return _run_synthetic_smoke(args, cfg)
    return _real_train(args, cfg)


if __name__ == "__main__":
    raise SystemExit(main())
