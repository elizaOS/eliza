#!/usr/bin/env python3
"""End-to-end Wav2Small distillation against the RAVDESS open corpus.

This orchestrator wraps `distill_wav2small.py` for the constrained
environment we have on the RTX 5080 box:

  - Source: `xbgoose/ravdess` HF dataset (already mirrored to local
    parquet at `packages/training/out/emotion-wav2small-v1/corpus/`).
    1,440 clips, 8 emotion classes, ~3-5 second utterances at 48 kHz.
  - Teacher: `audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim`
    (CC-BY-NC-SA-4.0; teacher weights are never redistributed — only
    its V-A-D pseudo-labels are baked into the student).
  - Student: 71,666-param Wav2Small (Wagner et al., arXiv:2408.13920).
  - Eval gate: macro-F1 >= 0.35 on the 7-class projection.

We **decode WAV bytes directly from the parquet** (the parquet stores
raw RIFF/WAVE chunks) so we don't need torchcodec / ffmpeg. Resampling
48 kHz → 16 kHz is via librosa.

The RAVDESS gold-label emotion is used as the auxiliary head's
supervision signal — the V-A-D-only teacher otherwise leaves the 7-class
head untrained. Mapping:

    happy → happy        sad → sad           angry → angry
    calm → calm          fearful → nervous   surprised → excited
    neutral → calm       disgust → DROP (no good mapping)

The disgust class is excluded from training (192 clips) since there's
no expressive tag for it; this is documented limitation, not silent
loss.

Pipeline phases (all gated, all logged):

    1. load parquet shards → list of (pcm@16k, gold_emotion, gold_idx).
    2. teacher pass: for each clip, run audeering model on the 8-sec
       padded window → V-A-D triple. Cache to a single .npy/.json sidecar
       so re-runs of the train phase don't re-pay the teacher cost.
    3. train student: APOLLO-Mini, joint MSE(V-A-D) + CE(aux head),
       deterministic 80/10/10 split, 10 epochs, batch=64.
    4. eval gate: macro-F1 on the test split, refuse to publish if
       under 0.35.
    5. export INT8 ONNX with `expressive_emotion_tags` metadata.
    6. write provenance JSON.

Usage:

    HF_TOKEN=... python packages/training/scripts/emotion/run_distill_ravdess.py \\
        --run-dir packages/training/out/emotion-wav2small-v1 \\
        --epochs 10 \\
        --batch-size 64

The HF push lives in `publish_to_hf.py` — this script just produces
the artifact under `<run-dir>/wav2small-msp-dim-int8.onnx` and the
matching provenance JSON.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import io
import json
import logging
import pathlib
import random
import sys
import time
from typing import Any

# Make sibling-package imports work when invoked as a script.
_REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from packages.training.scripts.emotion import distill_wav2small as dw  # noqa: E402

LOG = logging.getLogger("run_distill_ravdess")

# RAVDESS emotion label → EXPRESSIVE_EMOTION_TAGS index (or None to drop).
# Index order matches `dw.EXPRESSIVE_EMOTION_TAGS`:
#   0: happy   1: sad    2: angry    3: nervous
#   4: calm    5: excited 6: whisper
RAVDESS_TO_EXPRESSIVE: "dict[str, int | None]" = {
    "happy": 0,
    "sad": 1,
    "angry": 2,
    "fearful": 3,        # → nervous
    "calm": 4,
    "neutral": 4,        # neutral → calm (closest V-A-D-wise)
    "surprised": 5,      # → excited
    "disgust": None,     # no good mapping
}

DEFAULT_RUN_DIR = pathlib.Path("packages/training/out/emotion-wav2small-v1")
TEACHER_REPO = dw.DEFAULT_TEACHER


@dataclasses.dataclass
class Clip:
    """One RAVDESS clip resolved to mono 16 kHz PCM + 7-class gold label."""

    clip_id: str
    pcm: Any  # numpy float32 [N]
    gold_idx: int  # 0..6 over EXPRESSIVE_EMOTION_TAGS
    gold_label: str
    actor: int
    source_emotion: str


def _resample_to_16k(pcm: Any, sr: int) -> Any:
    """Resample 48 kHz → 16 kHz with librosa. Mono assumed."""
    import librosa
    if sr == dw.WAV2SMALL_SAMPLE_RATE:
        return pcm
    return librosa.resample(pcm, orig_sr=sr, target_sr=dw.WAV2SMALL_SAMPLE_RATE)


def load_ravdess_clips(corpus_dir: pathlib.Path) -> list[Clip]:
    """Read both RAVDESS parquet shards and return resolved clips.

    Drops clips whose source emotion has no expressive-tag mapping
    (currently only `disgust`). Audio is decoded from raw WAV bytes
    embedded in the parquet (no torchcodec / ffmpeg required).
    """
    import numpy as np
    import pyarrow.parquet as pq
    import soundfile as sf

    shards = sorted(corpus_dir.glob("ravdess-*.parquet"))
    if not shards:
        raise FileNotFoundError(
            f"no RAVDESS parquet shards under {corpus_dir}; expected files "
            "named `ravdess-*.parquet` (e.g. ravdess-00.parquet, "
            "ravdess-01.parquet).",
        )

    clips: list[Clip] = []
    dropped = 0
    for shard in shards:
        table = pq.read_table(str(shard))
        rows = table.to_pylist()
        LOG.info("shard %s rows=%d", shard.name, len(rows))
        for row in rows:
            src_emotion = str(row["emotion"])
            gold_idx = RAVDESS_TO_EXPRESSIVE.get(src_emotion)
            if gold_idx is None:
                dropped += 1
                continue
            audio_blob = row["audio"]["bytes"]
            pcm, sr = sf.read(io.BytesIO(audio_blob), dtype="float32", always_2d=False)
            if pcm.ndim == 2:
                pcm = pcm.mean(axis=1)
            pcm = _resample_to_16k(np.asarray(pcm, dtype="float32"), sr)
            clip_id = pathlib.Path(row["audio"]["path"]).stem
            clips.append(
                Clip(
                    clip_id=clip_id,
                    pcm=pcm,
                    gold_idx=int(gold_idx),
                    gold_label=dw.EXPRESSIVE_EMOTION_TAGS[gold_idx],
                    actor=int(row["actor"]),
                    source_emotion=src_emotion,
                ),
            )
    LOG.info("loaded %d clips, dropped %d (no mapping)", len(clips), dropped)
    return clips


def _pad_to_window(pcm: Any) -> Any:
    """Pad/truncate to one 8-second window (the teacher's training horizon)."""
    import numpy as np
    win = int(dw.TEACHER_WINDOW_SECONDS * dw.WAV2SMALL_SAMPLE_RATE)
    if pcm.shape[0] >= win:
        return pcm[:win].copy()
    out = np.zeros(win, dtype="float32")
    out[: pcm.shape[0]] = pcm
    return out


def teacher_pass(
    clips: list[Clip],
    teacher: Any,
    *,
    device: str,
    cache_path: pathlib.Path,
) -> "tuple[list[list[float]], list[int]]":
    """Run the audeering teacher on every clip and return V-A-D + gold idx.

    Caches results in a JSON sidecar keyed by sha256 of the (clip_id +
    actor) so re-runs of the train phase don't re-pay the teacher cost.
    Cache schema:

        {
          "<key>": {"vad": [v, a, d], "gold_idx": int},
          ...
        }

    Each clip is run as a single 8-second padded window (matching the
    audeering training horizon); RAVDESS clips are short enough that
    striping doesn't help.
    """
    import numpy as np
    import torch

    model = teacher["model"].to(device).eval()
    processor = teacher["processor"]

    cache: dict[str, dict[str, Any]] = {}
    if cache_path.is_file():
        cache = json.loads(cache_path.read_text("utf-8"))
        LOG.info("loaded teacher cache: %d entries", len(cache))

    vad_rows: list[list[float]] = []
    gold_idxs: list[int] = []
    t0 = time.time()
    misses = 0
    for i, clip in enumerate(clips):
        key = hashlib.sha256(f"{clip.clip_id}::{clip.actor}".encode()).hexdigest()
        if key in cache:
            vad = cache[key]["vad"]
        else:
            misses += 1
            padded = _pad_to_window(clip.pcm)
            inputs = processor(
                padded, sampling_rate=dw.WAV2SMALL_SAMPLE_RATE, return_tensors="pt",
            )
            input_values = inputs["input_values"].to(device)
            with torch.no_grad():
                _hidden, logits = model(input_values)
            # audeering order is A-D-V; re-order to V-A-D.
            a, d, v = logits.detach().cpu().float().numpy().reshape(-1).tolist()
            vad = [float(v), float(a), float(d)]
            cache[key] = {"vad": vad, "gold_idx": clip.gold_idx}
            if (i + 1) % 50 == 0 or i == len(clips) - 1:
                elapsed = time.time() - t0
                rate = (i + 1) / max(elapsed, 1e-6)
                LOG.info(
                    "teacher %d/%d  rate=%.1f clip/s  misses=%d",
                    i + 1, len(clips), rate, misses,
                )
        vad_rows.append(vad)
        gold_idxs.append(clip.gold_idx)

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(cache), encoding="utf-8")
    LOG.info(
        "teacher done: %d clips, %d cache misses, %.1f s wall",
        len(clips), misses, time.time() - t0,
    )
    return vad_rows, gold_idxs


def deterministic_split(
    n: int, *, seed: int = 7,
) -> "tuple[list[int], list[int], list[int]]":
    """Stratification-agnostic 80/10/10 split with a fixed seed."""
    rng = random.Random(seed)
    idx = list(range(n))
    rng.shuffle(idx)
    n_train = int(n * 0.8)
    n_val = int(n * 0.1)
    return idx[:n_train], idx[n_train : n_train + n_val], idx[n_train + n_val :]


def train_eval(
    clips: list[Clip],
    vad_rows: "list[list[float]]",
    gold_idxs: list[int],
    *,
    student: Any,
    run_dir: pathlib.Path,
    epochs: int,
    batch_size: int,
    device: str,
    lr: float,
    weight_decay: float,
    cls_loss_weight: float = 1.0,
    vad_loss_weight: float = 0.5,
) -> dict[str, float]:
    """Joint V-A-D regression + 7-class classification training loop.

    Returns the final test-split metrics dict. The best-by-val-macro-F1
    checkpoint is written to `<run-dir>/best.pt`.
    """
    import numpy as np
    import torch
    from torch import nn
    from torch.utils.data import DataLoader, TensorDataset

    try:
        from packages.training.scripts.training.optimizer import (
            build_apollo_mini_optimizer,
            build_apollo_optimizer,
        )
    except ImportError as exc:
        raise RuntimeError(
            "APOLLO optimizer factory not importable; ensure "
            "packages/training/scripts/training/optimizer.py is on sys.path "
            "and apollo-torch is installed",
        ) from exc

    n = len(clips)
    win = int(dw.TEACHER_WINDOW_SECONDS * dw.WAV2SMALL_SAMPLE_RATE)
    LOG.info("materialising %d 8-sec windows into a [N, win=%d] tensor", n, win)
    pcm_arr = np.zeros((n, win), dtype="float32")
    for i, clip in enumerate(clips):
        pcm_arr[i] = _pad_to_window(clip.pcm)
    pcm_t = torch.from_numpy(pcm_arr)
    vad_t = torch.from_numpy(np.asarray(vad_rows, dtype="float32"))
    cls_t = torch.from_numpy(np.asarray(gold_idxs, dtype="int64"))

    train_ids, val_ids, test_ids = deterministic_split(n)
    LOG.info(
        "split: train=%d val=%d test=%d", len(train_ids), len(val_ids), len(test_ids),
    )

    train_ds = TensorDataset(pcm_t[train_ids], vad_t[train_ids], cls_t[train_ids])
    val_ds = TensorDataset(pcm_t[val_ids], vad_t[val_ids], cls_t[val_ids])
    test_ds = TensorDataset(pcm_t[test_ids], vad_t[test_ids], cls_t[test_ids])
    train_loader = DataLoader(train_ds, batch_size=batch_size, shuffle=True)
    val_loader = DataLoader(val_ds, batch_size=batch_size)
    test_loader = DataLoader(test_ds, batch_size=batch_size)

    student = student.to(device)
    w_vad, w_cls = float(vad_loss_weight), float(cls_loss_weight)
    LOG.info("loss weights: vad=%.3f cls=%.3f", w_vad, w_cls)

    # Class-balanced CE weights against the training-set class distribution.
    # The mapping collapses RAVDESS neutral+calm → expressive `calm`, so the
    # raw distribution is heavily biased; class weighting keeps the head from
    # collapsing to the majority class.
    import collections as _co
    class_counts = _co.Counter(gold_idxs[i] for i in train_ids)
    n_classes = len(dw.EXPRESSIVE_EMOTION_TAGS)
    class_weights = np.zeros(n_classes, dtype="float32")
    total = sum(class_counts.values())
    for c in range(n_classes):
        cnt = class_counts.get(c, 0)
        # Inverse-frequency weights (smoothed). Unrepresented classes get 0
        # so they don't dominate when their support is empty.
        class_weights[c] = (total / max(1, cnt)) / n_classes if cnt > 0 else 0.0
    LOG.info(
        "class counts (train): %s",
        {dw.EXPRESSIVE_EMOTION_TAGS[c]: int(class_counts.get(c, 0)) for c in range(n_classes)},
    )
    LOG.info(
        "class weights: %s",
        {dw.EXPRESSIVE_EMOTION_TAGS[c]: round(float(class_weights[c]), 3) for c in range(n_classes)},
    )

    mse = nn.MSELoss()
    ce = nn.CrossEntropyLoss(weight=torch.tensor(class_weights, device=device))
    try:
        optimizer = build_apollo_mini_optimizer(student, lr=lr, weight_decay=weight_decay)
        LOG.info("optimizer: APOLLO-Mini (rank-1 tensor-wise)")
    except ValueError:
        optimizer = build_apollo_optimizer(student, lr=lr, weight_decay=weight_decay, rank=8)
        LOG.info("optimizer: APOLLO (rank-8 fallback)")

    # Cosine schedule with linear warmup over 5% of total steps.
    steps_per_epoch = max(1, len(train_loader))
    total_steps = steps_per_epoch * epochs
    warmup_steps = max(1, int(0.05 * total_steps))

    def _lr_at(step: int) -> float:
        if step < warmup_steps:
            return step / warmup_steps
        progress = (step - warmup_steps) / max(1, total_steps - warmup_steps)
        import math
        return 0.5 * (1 + math.cos(math.pi * min(1.0, progress)))

    scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, lr_lambda=_lr_at)
    LOG.info("schedule: cosine + %d-step warmup over %d total steps", warmup_steps, total_steps)

    def _eval(loader: DataLoader) -> dict[str, float]:
        student.eval()
        all_vad_pred: list[Any] = []
        all_vad_gold: list[Any] = []
        all_cls_pred: list[int] = []
        all_cls_gold: list[int] = []
        with torch.no_grad():
            for pcm_b, vad_b, cls_b in loader:
                pcm_b = pcm_b.to(device)
                vad_pred, cls_logits = student.forward_with_aux(pcm_b)
                all_vad_pred.append(vad_pred.detach().cpu().numpy())
                all_vad_gold.append(vad_b.numpy())
                all_cls_pred.extend(cls_logits.argmax(dim=-1).detach().cpu().numpy().tolist())
                all_cls_gold.extend(cls_b.numpy().tolist())
        vad_pred_np = np.concatenate(all_vad_pred)
        vad_gold_np = np.concatenate(all_vad_gold)
        mse_vad = float(((vad_pred_np - vad_gold_np) ** 2).mean())
        f1 = dw._macro_f1(
            all_cls_pred, all_cls_gold, num_classes=len(dw.EXPRESSIVE_EMOTION_TAGS),
        )
        acc = float(sum(1 for p, g in zip(all_cls_pred, all_cls_gold) if p == g) / max(1, len(all_cls_gold)))
        return {"mse_vad": mse_vad, "macro_f1": f1, "accuracy": acc}

    best_f1 = -1.0
    best_metrics: dict[str, float] = {"mse_vad": float("inf"), "macro_f1": 0.0}
    history: list[dict[str, Any]] = []

    for epoch in range(epochs):
        t0 = time.time()
        student.train()
        train_loss = 0.0
        n_batches = 0
        for pcm_b, vad_b, cls_b in train_loader:
            pcm_b = pcm_b.to(device)
            vad_b = vad_b.to(device)
            cls_b = cls_b.to(device)
            vad_pred, cls_logits = student.forward_with_aux(pcm_b)
            loss = w_vad * mse(vad_pred, vad_b) + w_cls * ce(cls_logits, cls_b)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            optimizer.step()
            scheduler.step()
            train_loss += float(loss.item())
            n_batches += 1
        train_loss /= max(1, n_batches)

        val = _eval(val_loader)
        history.append({"epoch": epoch, "train_loss": train_loss, "val": val})
        LOG.info(
            "epoch %d/%d  train_loss=%.4f  val_mse_vad=%.4f  val_macro_f1=%.4f  val_acc=%.4f  wall=%.1fs",
            epoch + 1, epochs, train_loss, val["mse_vad"], val["macro_f1"], val["accuracy"], time.time() - t0,
        )

        if val["macro_f1"] > best_f1:
            best_f1 = val["macro_f1"]
            best_metrics = {
                "mse_vad": val["mse_vad"],
                "macro_f1": val["macro_f1"],
                "accuracy": val["accuracy"],
                "epoch": float(epoch),
            }
            run_dir.mkdir(parents=True, exist_ok=True)
            torch.save(
                {"state_dict": student.state_dict(), "epoch": epoch, "val": val},
                run_dir / "best.pt",
            )

    # Load best for final test eval.
    ckpt = torch.load(run_dir / "best.pt", map_location=device, weights_only=False)
    student.load_state_dict(ckpt["state_dict"])
    test_metrics = _eval(test_loader)
    LOG.info(
        "TEST  mse_vad=%.4f  macro_f1=%.4f  accuracy=%.4f  (best val_f1=%.4f at epoch %d)",
        test_metrics["mse_vad"], test_metrics["macro_f1"], test_metrics["accuracy"],
        best_f1, int(best_metrics.get("epoch", -1)),
    )
    (run_dir / "history.json").write_text(json.dumps(history, indent=2), "utf-8")
    (run_dir / "test-metrics.json").write_text(json.dumps(test_metrics, indent=2), "utf-8")
    return test_metrics


def sha256_of(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=pathlib.Path, default=DEFAULT_RUN_DIR)
    parser.add_argument(
        "--corpus-dir", type=pathlib.Path, default=DEFAULT_RUN_DIR / "corpus",
    )
    parser.add_argument("--teacher", default=TEACHER_REPO)
    parser.add_argument("--epochs", type=int, default=10)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument(
        "--cls-loss-weight", type=float, default=1.0,
        help="Override aux 7-class CE weight (default 0.5 in distill script).",
    )
    parser.add_argument(
        "--vad-loss-weight", type=float, default=0.5,
        help="Override V-A-D MSE weight.",
    )
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument(
        "--eval-gate-macro-f1", type=float, default=0.35,
        help="Refuse to write final ONNX if test macro-F1 < this.",
    )
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--skip-train", action="store_true",
                        help="Re-export ONNX from an existing best.pt; skip phases 1-3.")
    parser.add_argument("--allow-below-gate", action="store_true",
                        help="Write ONNX even if eval gate fails (for diagnostic runs).")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    args.run_dir.mkdir(parents=True, exist_ok=True)

    import numpy as np
    import torch
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    random.seed(args.seed)

    student = dw.build_student()
    dw.assert_student_param_budget(student)
    param_count = dw.count_params(student)
    LOG.info("student param count: %d (target %d)", param_count, dw.TARGET_PARAM_COUNT)

    onnx_path = args.run_dir / "wav2small-msp-dim-int8.onnx"

    test_metrics: dict[str, float]
    if args.skip_train and (args.run_dir / "test-metrics.json").is_file():
        test_metrics = json.loads((args.run_dir / "test-metrics.json").read_text("utf-8"))
        ckpt = torch.load(args.run_dir / "best.pt", map_location=args.device, weights_only=False)
        student.load_state_dict(ckpt["state_dict"])
        LOG.info("skipped train; loaded best.pt — test_metrics=%s", test_metrics)
    else:
        LOG.info("phase 1: loading RAVDESS corpus from %s", args.corpus_dir)
        clips = load_ravdess_clips(args.corpus_dir)

        LOG.info("phase 2: teacher pass on %s", args.teacher)
        teacher = dw.load_teacher(args.teacher)
        cache_path = args.run_dir / "teacher-cache.json"
        vad_rows, gold_idxs = teacher_pass(
            clips, teacher, device=args.device, cache_path=cache_path,
        )
        # Free teacher VRAM before training the student.
        del teacher
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

        LOG.info("phase 3: train student")
        test_metrics = train_eval(
            clips, vad_rows, gold_idxs,
            student=student,
            run_dir=args.run_dir,
            epochs=args.epochs,
            batch_size=args.batch_size,
            device=args.device,
            lr=args.lr,
            weight_decay=args.weight_decay,
            cls_loss_weight=args.cls_loss_weight,
            vad_loss_weight=args.vad_loss_weight,
        )

    LOG.info("phase 4: eval gate (macro_f1 >= %.2f)", args.eval_gate_macro_f1)
    if test_metrics["macro_f1"] < args.eval_gate_macro_f1 and not args.allow_below_gate:
        LOG.error(
            "EVAL GATE FAIL: test macro_f1 %.4f < gate %.2f. "
            "Re-run with --allow-below-gate to write the diagnostic ONNX, "
            "or escalate to a larger corpus / more epochs.",
            test_metrics["macro_f1"], args.eval_gate_macro_f1,
        )
        return 2

    LOG.info("phase 5: export INT8 ONNX → %s", onnx_path)
    dw.export_student_onnx(student=student, out_path=onnx_path)
    sha = sha256_of(onnx_path)
    size = onnx_path.stat().st_size
    LOG.info("ONNX sha256=%s size=%d bytes", sha, size)

    LOG.info("phase 6: write provenance")
    prov = dw.StudentProvenance(
        teacher_repo=args.teacher,
        teacher_revision="HEAD",
        teacher_license="CC-BY-NC-SA-4.0",
        student_version="0.1.0",
        corpora=("xbgoose/ravdess",),
        corpus_sizes={"clips_after_drop": int(test_metrics.get("n_clips", 0))},
        train_val_test_split={"train": 0, "val": 0, "test": 0},
        eval_mse_vad=float(test_metrics["mse_vad"]),
        eval_macro_f1_meld=float(test_metrics["macro_f1"]),
        eval_macro_f1_iemocap=0.0,
        param_count=param_count,
        onnx_sha256=sha,
        onnx_size_bytes=size,
        opset=dw.DEFAULT_OPSET,
        quantization="int8-dynamic",
        runtime_compatible_versions=("onnxruntime-node@>=1.20",),
        commit="",
    )
    dw.write_provenance(args.run_dir / "wav2small-msp-dim-int8.json", prov)

    summary = {
        "param_count": param_count,
        "test_metrics": test_metrics,
        "onnx_sha256": sha,
        "onnx_size_bytes": size,
        "onnx_path": str(onnx_path.relative_to(_REPO_ROOT)),
        "teacher_repo": args.teacher,
        "teacher_license": "CC-BY-NC-SA-4.0",
        "corpus": "xbgoose/ravdess",
        "eval_gate_pass": bool(test_metrics["macro_f1"] >= args.eval_gate_macro_f1),
        "eval_gate_threshold": args.eval_gate_macro_f1,
    }
    (args.run_dir / "summary.json").write_text(json.dumps(summary, indent=2), "utf-8")
    LOG.info("DONE: %s", json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
