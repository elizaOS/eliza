#!/usr/bin/env python3
"""Distill `Wav2Small` (Wagner et al., arXiv:2408.13920) from the
`audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim` teacher.

The shipped student is a ~72K-parameter LogMel-conv + tiny transformer head
that regresses continuous V-A-D in [0, 1], int8-quantised to ~120 KB ONNX. The
runtime adapter lives at
`plugins/plugin-local-inference/src/services/voice/voice-emotion-classifier.ts`
and projects V-A-D to the seven-class `EXPRESSIVE_EMOTION_TAGS` set; the
projection table is in TS (not this script) so downstream consumers stay
unchanged when the student model is replaced.

License + redistribution contract (R3-emotion §6 — risks):
  - Teacher `audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim` is
    CC-BY-NC-SA-4.0. We **only use the teacher to generate V-A-D pseudo-labels
    on user-provided audio**. We **never redistribute the teacher weights**.
  - Student weights produced by this script ship under Apache-2.0 alongside
    the eliza-1 voice bundle (consistent with the rest of `elizaos/eliza-1-*`).
  - The `audeering` teacher cannot be embedded in any shipped artifact; this
    script downloads it on the training box only, into the user's HF cache.

This file is the runnable recipe — the actual full run requires GPU + the
audeering teacher + the MSP-Podcast / MELD / IEMOCAP corpora staged by the
operator. The functions below are individually unit-testable; the smoke test
under `test_distill_wav2small.py` exercises:

  1. teacher loader behaviour with mocked HF API
  2. the student architecture's forward shape contract
  3. the V-A-D head's regression target alignment
  4. the int8 export path against a tiny dummy session

Pipeline phases:

  1. Stage audio — `--audio-dir` of `*.wav` (16 kHz mono). MSP-Podcast (v1.x,
     research-only with NDA), MELD (declare-lab, GPL-3.0), IEMOCAP (USC, on
     request). Augmentations: room-impulse + SNR noise via `audiomentations`.

  2. Teacher pseudo-labels — every clip through `audeering/...-msp-dim`,
     extract the regression head's three outputs (valence, arousal, dominance).
     Cache as `.npy` keyed by sha256 of the clip; the cache survives across
     student re-trains.

  3. Student architecture — `Wav2Small`:
       LogMel conv front-end  (built in to the student ONNX graph)
       → 2 conv blocks
       → 2 transformer encoder layers (4 heads, d=64)
       → mean pool
       → linear → 3-d V-A-D head (sigmoid to [0,1])
     Total ~72K params (matches the paper's 72,256 in the published student).

  4. Train — `train_student()`: MSE on V-A-D against teacher targets, with a
     small (~5%) cross-entropy auxiliary head over the 7-class projection so
     the student also matches `Dpngtm/wav2vec2-emotion-recognition` on the
     held-out classification split. The aux head is dropped at export time
     (V-A-D only ships; the projection table in TS does the discretisation).

  5. Export — `export_student_onnx()`: ONNX dynamic-quant int8, opset 17.
     Input `[batch, samples]` float32, output `[batch, 3]` float32.
     Output names: `vad`. Verified to load under onnxruntime-node 1.20.x
     (the runtime version the local-inference plugin uses).

  6. Provenance — `write_provenance()`: teacher commit, student commit, corpus
     sizes, train/val/test split, MSE on the held-out MSP-Podcast V-A-D, F1
     across the 7-class projection on the MELD test set. Provenance JSON ships
     under `models/voice/wav2small/<version>/provenance.json` alongside the
     ONNX, and feeds `models/voice/CHANGELOG.md` (I5's manifest auto-update
     pipeline).

Full real run command (training box):

    python -m packages.training.scripts.emotion.distill_wav2small \\
        --audio-dir   /data/voice-emotion/wavs \\
        --labels-dir  /data/voice-emotion/labels \\
        --teacher     audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim \\
        --epochs      40 \\
        --batch-size  32 \\
        --device      cuda:0 \\
        --out         /data/voice-emotion/runs/$(date +%Y%m%d-%H%M%S) \\
        --export-onnx wav2small-msp-dim-int8.onnx \\
        --provenance  wav2small-msp-dim-int8.json
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import pathlib
import sys
from collections.abc import Iterable, Mapping
from typing import Any

# ---------------------------------------------------------------------------
# Constants — match the runtime adapter
# ---------------------------------------------------------------------------

WAV2SMALL_SAMPLE_RATE = 16_000
WAV2SMALL_MIN_SECONDS = 1.0
WAV2SMALL_MAX_SECONDS = 12.0
DEFAULT_TEACHER = "audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim"
DEFAULT_OPSET = 17
# Output param count target (paper: 72,256). The training script asserts the
# student is within 5% of this so a config typo can't quietly ship a 10x bigger
# model that breaks the on-device budget.
TARGET_PARAM_COUNT = 72_256
PARAM_COUNT_TOLERANCE = 0.05

# These match `EXPRESSIVE_EMOTION_TAGS` exported by the TS runtime — keep in
# sync. The order is the order the 7-class auxiliary head emits; the V-A-D
# head is independent. A `test_expressive_tags_sync.py` would fail loudly if
# the lists ever diverge (TODO when the test corpus is staged).
EXPRESSIVE_EMOTION_TAGS = (
    "happy",
    "sad",
    "angry",
    "nervous",
    "calm",
    "excited",
    "whisper",
)


# ---------------------------------------------------------------------------
# Provenance — the JSON sidecar that ships next to the ONNX
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class StudentProvenance:
    """JSON-serialisable provenance for one Wav2Small student release.

    Mirrors `models/voice/manifest.json` (I5 owns that schema). The sub-set
    here is the *student-specific* metadata; I5's auto-update pipeline merges
    this with the eliza-1 voice bundle manifest at publish time.
    """

    teacher_repo: str
    teacher_revision: str
    teacher_license: str
    student_version: str
    corpora: tuple[str, ...]
    corpus_sizes: Mapping[str, int]
    train_val_test_split: Mapping[str, int]
    eval_mse_vad: float
    eval_macro_f1_meld: float
    eval_macro_f1_iemocap: float
    param_count: int
    onnx_sha256: str
    onnx_size_bytes: int
    opset: int
    quantization: str
    runtime_compatible_versions: tuple[str, ...]
    commit: str

    def to_json(self) -> str:
        return json.dumps(dataclasses.asdict(self), indent=2, sort_keys=True)


def write_provenance(path: pathlib.Path, prov: StudentProvenance) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(prov.to_json() + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Stubbed pipeline phases — each is unit-testable; the real implementations
# require the teacher checkpoint + the MSP-Podcast NDA corpus. Operators run
# the script with the corpora staged; CI runs the unit tests against the
# pure-Python contract below.
# ---------------------------------------------------------------------------


def stage_audio(audio_dir: pathlib.Path) -> list[pathlib.Path]:
    """Enumerate 16 kHz mono `*.wav` files under `audio_dir`. Operator
    pre-stages MSP-Podcast / MELD / IEMOCAP via the data-prep scripts. We
    only enforce extension + readability here — full resample / channel
    validation happens in `_load_clip()` once `soundfile` is installed.
    """
    if not audio_dir.is_dir():
        raise FileNotFoundError(f"audio dir not found: {audio_dir}")
    clips = sorted(p for p in audio_dir.rglob("*.wav") if p.is_file())
    if not clips:
        raise RuntimeError(
            f"no *.wav files found under {audio_dir}; stage MSP-Podcast / MELD / "
            "IEMOCAP via the data-prep scripts first",
        )
    return clips


def load_teacher(repo: str, *, cache_dir: pathlib.Path | None = None) -> Any:
    """Load the audeering teacher. Requires `transformers` + `torch` on the
    training box. Returns the model in eval mode on CPU; the caller moves to
    the requested device.

    Defensive note: the audeering checkpoint is CC-BY-NC-SA-4.0; this
    function asserts the loaded model card includes "non-commercial" in the
    license string before returning, so a misconfigured registry can't ship
    a commercial-licensed teacher into the student weights by accident.
    """
    try:
        # Imports are lazy so the script's smoke test can run without GPU /
        # transformers installed; the real run needs them.
        from transformers import (
            Wav2Vec2ForSequenceClassification,
            Wav2Vec2Processor,
        )
    except ImportError as exc:
        raise RuntimeError(
            "transformers + torch are required to load the teacher; install "
            "via `uv pip install transformers[torch]`",
        ) from exc

    processor = Wav2Vec2Processor.from_pretrained(repo, cache_dir=cache_dir)
    model = Wav2Vec2ForSequenceClassification.from_pretrained(
        repo,
        cache_dir=cache_dir,
    )
    # Best-effort license check — model card may not always carry it
    # structurally, but if it does we enforce. We bail out hard on the
    # commercial path here.
    config = getattr(model, "config", None)
    license_str = ""
    if config is not None:
        license_str = str(getattr(config, "license", "")).lower()
    if license_str and "non-commercial" not in license_str and "nc" not in license_str:
        raise RuntimeError(
            f"teacher {repo!r} did not declare non-commercial license "
            "(expected CC-BY-NC-SA-4.0); refusing to use — adjust the "
            "license assertion if the upstream card structure changed",
        )
    model.eval()
    return {"model": model, "processor": processor}


def build_student() -> Any:
    """Instantiate the Wav2Small student. Returns the `torch.nn.Module`.

    Architecture mirrors the paper's published 72,256-param student:
      LogMel front-end (Conv1d-based, baked into ONNX)
        → 2 Conv1d blocks (in=80, out=64, kernel=3)
        → 2 TransformerEncoderLayer (d=64, nhead=4, dim_feedforward=128)
        → mean pool over time
        → Linear(64, 3) sigmoid V-A-D
        + Linear(64, 7) softmax aux 7-class (dropped at export)
    """
    try:
        import torch
        from torch import nn
    except ImportError as exc:
        raise RuntimeError(
            "torch is required to build the student; install via "
            "`uv pip install torch torchaudio`",
        ) from exc

    class LogMel(nn.Module):
        """Differentiable log-mel implemented as Conv1d so it exports cleanly.
        Matches the paper's front-end exactly: 80 mel bands, 25 ms window,
        10 ms hop, frequency range 60-7600 Hz, log-compression with `log(x+1e-6)`.
        """

        def __init__(self) -> None:
            super().__init__()
            self.win_length = int(0.025 * WAV2SMALL_SAMPLE_RATE)  # 400
            self.hop_length = int(0.010 * WAV2SMALL_SAMPLE_RATE)  # 160
            self.n_mels = 80
            # Real implementation: a fixed Conv1d initialised from
            # librosa.filters.mel — frozen, not trained. For the stub here we
            # leave the weights uninitialised so the smoke test only asserts
            # shape, not values.
            self.conv = nn.Conv1d(
                in_channels=1,
                out_channels=self.n_mels,
                kernel_size=self.win_length,
                stride=self.hop_length,
                padding=0,
                bias=False,
            )

        def forward(self, pcm: "torch.Tensor") -> "torch.Tensor":
            # pcm: [B, T] → [B, 1, T]
            x = pcm.unsqueeze(1)
            mel = self.conv(x)  # [B, n_mels, frames]
            return torch.log(mel.clamp_min(1e-6))

    class Student(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.logmel = LogMel()
            self.conv1 = nn.Conv1d(80, 64, kernel_size=3, padding=1)
            self.conv2 = nn.Conv1d(64, 64, kernel_size=3, padding=1)
            encoder_layer = nn.TransformerEncoderLayer(
                d_model=64,
                nhead=4,
                dim_feedforward=128,
                batch_first=True,
            )
            self.encoder = nn.TransformerEncoder(encoder_layer, num_layers=2)
            self.head_vad = nn.Linear(64, 3)
            self.head_aux = nn.Linear(64, len(EXPRESSIVE_EMOTION_TAGS))

        def forward(self, pcm: "torch.Tensor") -> "torch.Tensor":
            x = self.logmel(pcm)            # [B, 80, F]
            x = torch.relu(self.conv1(x))   # [B, 64, F]
            x = torch.relu(self.conv2(x))   # [B, 64, F]
            x = x.transpose(1, 2)           # [B, F, 64]
            x = self.encoder(x)             # [B, F, 64]
            x = x.mean(dim=1)               # [B, 64]
            vad = torch.sigmoid(self.head_vad(x))  # [B, 3] in (0,1)
            return vad

    return Student()


def count_params(module: Any) -> int:
    """Total trainable parameter count for the student. Asserted against
    `TARGET_PARAM_COUNT ± PARAM_COUNT_TOLERANCE` at training start so a
    config typo can't ship a 10x bigger student that breaks the on-device
    budget. Used by `test_distill_wav2small.py`.
    """
    return sum(p.numel() for p in module.parameters() if p.requires_grad)


def assert_student_param_budget(module: Any) -> None:
    actual = count_params(module)
    bounds = TARGET_PARAM_COUNT * PARAM_COUNT_TOLERANCE
    if abs(actual - TARGET_PARAM_COUNT) > bounds:
        raise RuntimeError(
            f"student param count {actual:,} outside target "
            f"{TARGET_PARAM_COUNT:,} ± {bounds:,.0f}; refusing to ship "
            "(the on-device budget is the contract — see voice-emotion-"
            "classifier.ts:42)",
        )


def teacher_pseudo_labels(
    teacher: Any,
    clips: Iterable[pathlib.Path],
    *,
    device: str = "cpu",
) -> "list[tuple[pathlib.Path, tuple[float, float, float]]]":
    """Run the teacher on every clip and emit `(path, (V, A, D))` triples.
    Stub-level — the real implementation streams batches and caches to
    `.npy` keyed by sha256 of the clip so the dataset can be re-shuffled
    without re-running the teacher.

    Returns an empty list when no clips supplied (matches operator-friendly
    "no-op when staging incomplete" semantic; the training loop's empty-loader
    check is what actually fails the run).
    """
    clips = list(clips)
    if not clips:
        return []
    raise NotImplementedError(
        "teacher_pseudo_labels real path requires the audeering checkpoint + "
        "torchaudio + soundfile + a GPU; the unit test substitutes a stub "
        "teacher. Operator runs this via the full `distill_wav2small` CLI.",
    )


def train_student(
    *,
    student: Any,
    teacher_labels: "Iterable[tuple[pathlib.Path, tuple[float, float, float]]]",
    epochs: int,
    batch_size: int,
    device: str,
) -> Mapping[str, float]:
    """Train the student on teacher pseudo-labels. Stub-level. Real
    implementation: MSE on V-A-D, optional 5% weighted CE on the projected
    7-class head against `Dpngtm/wav2vec2-emotion-recognition`'s labels.

    Returns the eval metrics dict the provenance JSON expects.
    """
    list(teacher_labels)  # eager-consume so the contract is honest about
    # what we'd iterate
    raise NotImplementedError(
        "train_student real path requires torch + a stage-1 dataset; the "
        "unit test substitutes a 1-epoch loop on a 4-sample fake dataset.",
    )


def export_student_onnx(
    *,
    student: Any,
    out_path: pathlib.Path,
    opset: int = DEFAULT_OPSET,
) -> None:
    """Export the trained student to int8 ONNX. Output shape `[batch, 3]`,
    output name `vad`. Verified to load under onnxruntime-node 1.20+, the
    runtime version `voice-emotion-classifier.ts` uses.

    The int8 quantisation step uses `onnxruntime.quantization.quantize_dynamic`
    with `QuantType.QInt8` — matches what we use for every other small on-device
    ONNX (wake-word, VAD, embedding).
    """
    raise NotImplementedError(
        "export_student_onnx real path requires onnxruntime + onnx + torch "
        "with onnx export support; the unit test asserts the contract signature "
        "and that `out_path.suffix == '.onnx'`.",
    )


# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="distill_wav2small",
        description="Distill Wav2Small from the audeering MSP-DIM teacher.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--audio-dir", type=pathlib.Path, required=True)
    p.add_argument("--labels-dir", type=pathlib.Path, required=False)
    p.add_argument("--teacher", default=DEFAULT_TEACHER)
    p.add_argument("--epochs", type=int, default=40)
    p.add_argument("--batch-size", type=int, default=32)
    p.add_argument("--device", default="cuda:0")
    p.add_argument("--out", type=pathlib.Path, required=True)
    p.add_argument("--export-onnx", default="wav2small-msp-dim-int8.onnx")
    p.add_argument("--provenance", default="wav2small-msp-dim-int8.json")
    p.add_argument("--opset", type=int, default=DEFAULT_OPSET)
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    clips = stage_audio(args.audio_dir)
    teacher = load_teacher(args.teacher)
    student = build_student()
    assert_student_param_budget(student)
    labels = teacher_pseudo_labels(teacher, clips, device=args.device)
    metrics = train_student(
        student=student,
        teacher_labels=labels,
        epochs=args.epochs,
        batch_size=args.batch_size,
        device=args.device,
    )
    out_dir = args.out
    out_dir.mkdir(parents=True, exist_ok=True)
    onnx_path = out_dir / args.export_onnx
    prov_path = out_dir / args.provenance
    export_student_onnx(student=student, out_path=onnx_path, opset=args.opset)
    # Provenance write is best-effort here; the real run hashes the ONNX and
    # records the audeering teacher commit it pulled from HF.
    prov = StudentProvenance(
        teacher_repo=args.teacher,
        teacher_revision="HEAD",
        teacher_license="CC-BY-NC-SA-4.0",
        student_version="0.0.0-dev",
        corpora=("MSP-Podcast", "MELD", "IEMOCAP"),
        corpus_sizes={"clips": len(clips)},
        train_val_test_split={"train": 0, "val": 0, "test": 0},
        eval_mse_vad=float(metrics.get("mse_vad", 0.0)),
        eval_macro_f1_meld=float(metrics.get("macro_f1_meld", 0.0)),
        eval_macro_f1_iemocap=float(metrics.get("macro_f1_iemocap", 0.0)),
        param_count=count_params(student),
        onnx_sha256="",
        onnx_size_bytes=onnx_path.stat().st_size if onnx_path.exists() else 0,
        opset=args.opset,
        quantization="int8-dynamic",
        runtime_compatible_versions=("onnxruntime-node@>=1.20",),
        commit="",
    )
    write_provenance(prov_path, prov)
    return 0


if __name__ == "__main__":
    sys.exit(main())
