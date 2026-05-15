#!/usr/bin/env python3
"""Path A — Wav2Small distillation against the **CREMA-D + RAVDESS** combined
corpus.

G-emotion missed the macro-F1 gate (0.319 vs 0.35) using RAVDESS alone
(1,248 clips after the disgust-drop). CREMA-D adds 7,442 clips across 6
emotions (anger / disgust / fear / happy / neutral / sad — no surprise or
calm) for ~5× more training data with 91 different speakers (RAVDESS has 24
actors).

Source: `confit/cremad-parquet` on HF — split into 3 standard-layout parquet
files (train 5,209 / validation 1,116 / test 1,117). Same row schema as
`xbgoose/ravdess`: `{file, audio: {bytes, path}, emotion, label}`.

Mapping CREMA-D emotions → `EXPRESSIVE_EMOTION_TAGS`:

    anger    → angry        sad      → sad
    happy    → happy        fear     → nervous
    neutral  → calm         disgust  → DROP (no expressive-tag mapping;
                                         same as the RAVDESS recipe)

Combined-corpus class distribution (after disgust drop, before train/val/test
split):

    happy   ~1,461 (RAVDESS 192 + CREMA 1,271)
    sad     ~1,463
    angry   ~1,463
    nervous ~1,463 (RAVDESS fearful + CREMA fear)
    calm    ~1,309 (RAVDESS calm+neutral + CREMA neutral)
    excited ~192   (RAVDESS surprised only — CREMA has no surprise)
    whisper 0      (no corpus carries it)

`excited` is severely under-represented and `whisper` is empty, so we
class-weight CE to keep the head from collapsing to the majority classes.

Pipeline reuses every helper from `run_distill_ravdess.py`; only the corpus
loader differs.
"""

from __future__ import annotations

import argparse
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
from packages.training.scripts.emotion import run_distill_ravdess as rdr  # noqa: E402

LOG = logging.getLogger("run_distill_combined")

DEFAULT_RUN_DIR = pathlib.Path("packages/training/out/emotion-wav2small-final")
TEACHER_REPO = dw.DEFAULT_TEACHER

CREMAD_HF_REPO = "confit/cremad-parquet"
CREMAD_HF_FILES = (
    "data/train-00000-of-00001.parquet",
    "data/validation-00000-of-00001.parquet",
    "data/test-00000-of-00001.parquet",
)

# CREMA-D string emotion → EXPRESSIVE_EMOTION_TAGS index (or None to drop).
# Mirrors RAVDESS_TO_EXPRESSIVE so disgust is the only dropped class.
CREMAD_TO_EXPRESSIVE: "dict[str, int | None]" = {
    "anger": 2,      # → angry
    "sad": 1,        # → sad
    "happy": 0,      # → happy
    "fear": 3,       # → nervous (matches RAVDESS fearful mapping)
    "neutral": 4,    # → calm (matches RAVDESS neutral mapping)
    "disgust": None,
}


def load_cremad_clips(
    cache_dir: pathlib.Path | None = None,
    hf_token: str | None = None,
) -> list[rdr.Clip]:
    """Download (cached) and decode the CREMA-D parquet shards into Clips.

    CREMA-D ships at 16 kHz mono already (per the AudioWAV release), so no
    resampling is needed in practice — but we still run it through
    `_resample_to_16k` in case a mirror re-encoded at a different rate.
    Actor id is parsed out of the filename prefix (e.g. `1082_TAI_DIS_XX.wav`
    → actor 1082) so we can later opt into an actor-disjoint split if we want
    one; CREMA-D has 91 actors.
    """
    import numpy as np
    import pyarrow.parquet as pq
    import soundfile as sf
    from huggingface_hub import hf_hub_download

    clips: list[rdr.Clip] = []
    dropped = 0
    for filename in CREMAD_HF_FILES:
        LOG.info("downloading CREMA-D shard %s", filename)
        path = hf_hub_download(
            repo_id=CREMAD_HF_REPO,
            filename=filename,
            repo_type="dataset",
            cache_dir=str(cache_dir) if cache_dir else None,
            token=hf_token,
        )
        table = pq.read_table(path)
        rows = table.to_pylist()
        LOG.info("shard %s rows=%d", filename, len(rows))
        for row in rows:
            src_emotion = str(row["emotion"])
            gold_idx = CREMAD_TO_EXPRESSIVE.get(src_emotion)
            if gold_idx is None:
                dropped += 1
                continue
            audio_blob = row["audio"]["bytes"]
            pcm, sr = sf.read(
                io.BytesIO(audio_blob), dtype="float32", always_2d=False,
            )
            if pcm.ndim == 2:
                pcm = pcm.mean(axis=1)
            pcm = rdr._resample_to_16k(np.asarray(pcm, dtype="float32"), sr)
            audio_name = pathlib.Path(row["audio"]["path"]).stem
            # CREMA-D filename schema: <ActorID>_<Sentence>_<Emotion>_<Intensity>
            try:
                actor = int(audio_name.split("_")[0])
            except (ValueError, IndexError):
                actor = -1
            clip_id = f"cremad-{audio_name}"
            clips.append(
                rdr.Clip(
                    clip_id=clip_id,
                    pcm=pcm,
                    gold_idx=int(gold_idx),
                    gold_label=dw.EXPRESSIVE_EMOTION_TAGS[gold_idx],
                    actor=actor,
                    source_emotion=src_emotion,
                ),
            )
    LOG.info(
        "CREMA-D done: loaded %d clips, dropped %d (no mapping)", len(clips), dropped,
    )
    return clips


def load_combined_clips(
    corpus_dir: pathlib.Path,
    *,
    hf_token: str | None,
    cache_dir: pathlib.Path | None,
) -> list[rdr.Clip]:
    """Load and merge RAVDESS + CREMA-D into a single Clip list."""
    ravdess = rdr.load_ravdess_clips(corpus_dir)
    LOG.info("RAVDESS clips: %d", len(ravdess))
    # Reassign RAVDESS clip_ids so they can't collide with CREMA-D's even by
    # filename coincidence.
    ravdess = [
        rdr.Clip(
            clip_id=f"ravdess-{c.clip_id}",
            pcm=c.pcm,
            gold_idx=c.gold_idx,
            gold_label=c.gold_label,
            actor=c.actor,
            source_emotion=c.source_emotion,
        )
        for c in ravdess
    ]
    cremad = load_cremad_clips(cache_dir=cache_dir, hf_token=hf_token)
    combined = ravdess + cremad
    LOG.info("combined: %d clips (RAVDESS %d + CREMA-D %d)",
             len(combined), len(ravdess), len(cremad))
    return combined


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
        "--ravdess-corpus-dir", type=pathlib.Path,
        default=rdr.DEFAULT_RUN_DIR / "corpus",
        help="Directory containing the RAVDESS parquet shards "
             "(reuses G-emotion's mirror by default).",
    )
    parser.add_argument(
        "--cache-dir", type=pathlib.Path, default=None,
        help="HF download cache for CREMA-D (default: ~/.cache/huggingface).",
    )
    parser.add_argument("--teacher", default=TEACHER_REPO)
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--cls-loss-weight", type=float, default=1.0)
    parser.add_argument("--vad-loss-weight", type=float, default=0.5)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument(
        "--eval-gate-macro-f1", type=float, default=0.35,
        help="Refuse to write final ONNX if test gate metric < this.",
    )
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument(
        "--skip-train", action="store_true",
        help="Re-export ONNX from an existing best.pt; skip phases 1-3.",
    )
    parser.add_argument(
        "--skip-corpus-reload", action="store_true",
        help="Skip the corpus load + teacher pass if teacher-cache.json "
             "already contains enough entries (development convenience).",
    )
    parser.add_argument(
        "--allow-below-gate", action="store_true",
        help="Write ONNX even if eval gate fails (for diagnostic runs).",
    )
    parser.add_argument(
        "--head", choices=("vad", "cls7"), default="cls7",
        help="Which head to export and gate on. Default 'cls7' — the aux "
             "classifier head, which is the Path-B contract (G-emotion's V-A-D "
             "projection metric capped at the teacher's compressed range).",
    )
    parser.add_argument(
        "--export-name", default=None,
        help="Override the ONNX filename in <run-dir>.",
    )
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

    default_name = (
        "wav2small-msp-dim-int8.onnx" if args.head == "vad"
        else "wav2small-cls7-int8.onnx"
    )
    onnx_path = args.run_dir / (args.export_name or default_name)

    hf_token = (
        # NEVER log or persist the token. Env-var only.
        __import__("os").environ.get("HF_TOKEN")
    )

    test_metrics: dict[str, float]
    if args.skip_train and (args.run_dir / "test-metrics.json").is_file():
        test_metrics = json.loads((args.run_dir / "test-metrics.json").read_text("utf-8"))
        ckpt = torch.load(args.run_dir / "best.pt", map_location=args.device, weights_only=False)
        student.load_state_dict(ckpt["state_dict"])
        LOG.info("skipped train; loaded best.pt — test_metrics=%s", test_metrics)
    else:
        LOG.info("phase 1: loading combined corpus (RAVDESS + CREMA-D)")
        clips = load_combined_clips(
            args.ravdess_corpus_dir, hf_token=hf_token, cache_dir=args.cache_dir,
        )
        # Log the class distribution so the operator sees the data shape up front.
        import collections as _co
        class_counts = _co.Counter(c.gold_idx for c in clips)
        LOG.info(
            "class counts (all): %s",
            {dw.EXPRESSIVE_EMOTION_TAGS[c]: int(class_counts.get(c, 0))
             for c in range(len(dw.EXPRESSIVE_EMOTION_TAGS))},
        )

        LOG.info("phase 2: teacher pass on %s", args.teacher)
        teacher = dw.load_teacher(args.teacher)
        cache_path = args.run_dir / "teacher-cache.json"
        vad_rows, gold_idxs = rdr.teacher_pass(
            clips, teacher, device=args.device, cache_path=cache_path,
        )
        # Free teacher VRAM before training the student.
        del teacher
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

        LOG.info("phase 3: train student")
        test_metrics = rdr.train_eval(
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

    gate_metric_key = "macro_f1_aux" if args.head == "cls7" else "macro_f1"
    gate_value = float(test_metrics.get(gate_metric_key, 0.0))
    LOG.info(
        "phase 4: eval gate (head=%s, %s=%.4f >= %.2f)",
        args.head, gate_metric_key, gate_value, args.eval_gate_macro_f1,
    )
    if gate_value < args.eval_gate_macro_f1 and not args.allow_below_gate:
        LOG.error(
            "EVAL GATE FAIL: test %s %.4f < gate %.2f.",
            gate_metric_key, gate_value, args.eval_gate_macro_f1,
        )
        return 2

    LOG.info("phase 5: export INT8 ONNX → %s (head=%s)", onnx_path, args.head)
    dw.export_student_onnx(student=student, out_path=onnx_path, head=args.head)
    sha = sha256_of(onnx_path)
    size = onnx_path.stat().st_size
    LOG.info("ONNX sha256=%s size=%d bytes", sha, size)

    LOG.info("phase 6: write provenance + eval.json")
    prov = dw.StudentProvenance(
        teacher_repo=args.teacher,
        teacher_revision="HEAD",
        teacher_license="CC-BY-NC-SA-4.0",
        student_version="0.2.0",
        corpora=("xbgoose/ravdess", "confit/cremad-parquet"),
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
    prov_path = args.run_dir / (
        "wav2small-msp-dim-int8.json" if args.head == "vad" else "wav2small-cls7-int8.json"
    )
    dw.write_provenance(prov_path, prov)

    # eval.json — the required deliverable format. The `macro_f1` field is
    # always the gate-passing metric for the head we shipped, so it can be
    # read directly without knowing which head was selected.
    eval_blob = {
        "head": args.head,
        "macro_f1": gate_value,
        "macro_f1_proj": float(test_metrics.get("macro_f1", 0.0)),
        "macro_f1_aux": float(test_metrics.get("macro_f1_aux", 0.0)),
        "accuracy": float(test_metrics.get("accuracy", 0.0)),
        "accuracy_aux": float(test_metrics.get("accuracy_aux", 0.0)),
        "mse_vad": float(test_metrics.get("mse_vad", 0.0)),
        "abstain_rate": float(test_metrics.get("abstain_rate", 0.0)),
        "eval_gate_pass": bool(gate_value >= args.eval_gate_macro_f1),
        "eval_gate_threshold": args.eval_gate_macro_f1,
        "corpus": ["xbgoose/ravdess", "confit/cremad-parquet"],
        "teacher_repo": args.teacher,
        "teacher_license": "CC-BY-NC-SA-4.0",
        "param_count": param_count,
        "onnx_path": str(onnx_path.resolve()),
        "onnx_sha256": sha,
        "onnx_size_bytes": size,
        "class_labels": list(dw.EXPRESSIVE_EMOTION_TAGS),
    }
    (args.run_dir / "eval.json").write_text(
        json.dumps(eval_blob, indent=2) + "\n", encoding="utf-8",
    )

    summary = {
        "param_count": param_count,
        "test_metrics": test_metrics,
        "onnx_sha256": sha,
        "onnx_size_bytes": size,
        "onnx_path": str(onnx_path.resolve()),
        "teacher_repo": args.teacher,
        "teacher_license": "CC-BY-NC-SA-4.0",
        "corpus": ["xbgoose/ravdess", "confit/cremad-parquet"],
        "head": args.head,
        "gate_metric": gate_metric_key,
        "gate_value": gate_value,
        "eval_gate_pass": bool(gate_value >= args.eval_gate_macro_f1),
        "eval_gate_threshold": args.eval_gate_macro_f1,
    }
    (args.run_dir / "summary.json").write_text(json.dumps(summary, indent=2), "utf-8")
    LOG.info("DONE: %s", json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
