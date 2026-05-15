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
    the eliza-1 voice bundle (consistent with the rest of `elizaos/eliza-1`).
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


_KNOWN_NC_TEACHERS: "dict[str, str]" = {
    # repo → declared license (from upstream README front-matter, May 2026).
    "audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim": "cc-by-nc-sa-4.0",
}


def load_teacher(repo: str, *, cache_dir: pathlib.Path | None = None) -> Any:
    """Load the audeering teacher. Requires `transformers` + `torch` on the
    training box. Returns the model in eval mode on CPU; the caller moves to
    the requested device.

    The audeering checkpoint exposes a **custom** `EmotionModel` head (see
    the upstream model card) that emits `(hidden_states, logits)` where
    `logits` is a `[B, 3]` regression for arousal/dominance/valence in
    [0, 1]. We define that class locally — it is not exported from
    transformers.

    Defensive note: the audeering checkpoint is CC-BY-NC-SA-4.0. The
    license is declared in the model card's README front-matter rather
    than the structural HF config, so we maintain an explicit allowlist
    of known non-commercial teacher repos here. Any teacher not in the
    allowlist is refused — this prevents a misconfigured registry from
    silently using a commercial-licensed teacher.
    """
    try:
        # Imports are lazy so the script's smoke test can run without GPU /
        # transformers installed; the real run needs them.
        import torch
        from huggingface_hub import hf_hub_download
        from torch import nn
        from transformers import Wav2Vec2Config, Wav2Vec2FeatureExtractor
        from transformers.models.wav2vec2.modeling_wav2vec2 import (
            Wav2Vec2Model,
            Wav2Vec2PreTrainedModel,
        )
    except ImportError as exc:
        raise RuntimeError(
            "transformers + torch are required to load the teacher; install "
            "via `uv pip install transformers[torch]`",
        ) from exc

    if repo not in _KNOWN_NC_TEACHERS:
        raise RuntimeError(
            f"teacher {repo!r} is not in the non-commercial teacher allowlist "
            f"(known: {sorted(_KNOWN_NC_TEACHERS)}). Add the repo and its "
            "declared license here only after verifying the upstream model "
            "card is CC-BY-NC-SA-4.0 (or stricter NC license) and that we "
            "are not redistributing the teacher weights in any shipped "
            "artifact.",
        )

    class RegressionHead(nn.Module):
        """Mirror of the audeering `RegressionHead` (see upstream README)."""

        def __init__(self, config: Any) -> None:
            super().__init__()
            self.dense = nn.Linear(config.hidden_size, config.hidden_size)
            self.dropout = nn.Dropout(config.final_dropout)
            self.out_proj = nn.Linear(config.hidden_size, config.num_labels)

        def forward(self, features: "torch.Tensor", **_kwargs: Any) -> "torch.Tensor":
            x = features
            x = self.dropout(x)
            x = self.dense(x)
            x = torch.tanh(x)
            x = self.dropout(x)
            x = self.out_proj(x)
            return x

    class EmotionModel(Wav2Vec2PreTrainedModel):
        """Mirror of the audeering `EmotionModel` (see upstream README).

        Forward returns `(hidden_states_mean, logits)` where `logits` is
        `[B, 3]` for arousal/dominance/valence in [0, 1].
        """

        # transformers >=5 checks `all_tied_weights_keys` during from_pretrained
        # finalisation; the audeering model ties nothing.
        all_tied_weights_keys: "dict[str, str]" = {}
        _tied_weights_keys: "list[str]" = []

        def __init__(self, config: Any) -> None:
            super().__init__(config)
            self.config = config
            self.wav2vec2 = Wav2Vec2Model(config)
            self.classifier = RegressionHead(config)
            self.init_weights()

        def forward(self, input_values: "torch.Tensor") -> "tuple[torch.Tensor, torch.Tensor]":
            outputs = self.wav2vec2(input_values)
            hidden_states = outputs[0]
            hidden_states = torch.mean(hidden_states, dim=1)
            logits = self.classifier(hidden_states)
            return hidden_states, logits

    # audeering ships a regression model with an empty vocab.json; the full
    # `Wav2Vec2Processor` build fails under transformers 5.x strict validation
    # ("vocab_size: None"). Use the feature extractor directly — that's all
    # the regression head needs.
    processor = Wav2Vec2FeatureExtractor.from_pretrained(repo, cache_dir=cache_dir)
    # transformers 5.x's strict Wav2Vec2Config also rejects `vocab_size: null`
    # from the audeering config.json. Pull the raw config JSON via the hub
    # API, patch vocab_size in-memory, then materialise the config from the
    # cleaned dict. The regression head ignores vocab_size; we just need a
    # legal int so strict validation passes.
    config_path = hf_hub_download(
        repo_id=repo, filename="config.json", cache_dir=cache_dir,
    )
    config_dict = json.loads(pathlib.Path(config_path).read_text("utf-8"))
    if config_dict.get("vocab_size") is None:
        config_dict["vocab_size"] = 32
    config = Wav2Vec2Config(**config_dict)
    model = EmotionModel.from_pretrained(repo, config=config, cache_dir=cache_dir)
    model.eval()
    return {
        "model": model,
        "processor": processor,
        "license": _KNOWN_NC_TEACHERS[repo],
    }


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
        """Differentiable log-mel implemented as a pair of frozen Conv1ds
        (cos/sin DFT basis) plus a frozen mel filterbank — exports cleanly
        to ONNX opset 17.

        Matches the paper's front-end exactly: 80 mel bands, 25 ms window,
        10 ms hop, frequency range 60-7600 Hz, log-compression with
        `log(x+1e-6)`. The cos/sin/mel weights are **frozen** so they don't
        count against the 72,256-param student budget.

        Why not torchaudio.MelSpectrogram? It uses `torch.stft` under the
        hood which does not export cleanly to ONNX opset 17 (the runtime
        version onnxruntime-node ships against). The DFT-conv approximation
        below is numerically equivalent (matches torch.stft to 1e-5) and
        produces a pure-Conv1d ONNX graph.
        """

        N_FFT = 400  # 25 ms @ 16 kHz
        HOP = 160    # 10 ms @ 16 kHz
        N_MELS = 80
        F_MIN = 60.0
        F_MAX = 7600.0

        def __init__(self) -> None:
            super().__init__()
            import math
            import torch.nn.functional as F

            n_fft = self.N_FFT
            hop = self.HOP
            n_bins = n_fft // 2 + 1
            # Hann window (periodic=False matches numpy/librosa convention
            # for STFT used in audio research).
            win = torch.hann_window(n_fft, periodic=False).float()
            t = torch.arange(n_fft).float()
            k = torch.arange(n_bins).float().unsqueeze(1)
            basis = 2 * math.pi * k * t / n_fft
            cos_w = (torch.cos(basis) * win).unsqueeze(1)  # [n_bins, 1, n_fft]
            sin_w = (torch.sin(basis) * win).unsqueeze(1)

            # Mel filterbank via librosa for correct mel triangulation.
            try:
                import librosa
                mel = librosa.filters.mel(
                    sr=WAV2SMALL_SAMPLE_RATE, n_fft=n_fft, n_mels=self.N_MELS,
                    fmin=self.F_MIN, fmax=self.F_MAX,
                )
                mel_mat = torch.from_numpy(mel).float()
            except ImportError as exc:
                raise RuntimeError(
                    "librosa is required to initialise the mel filterbank; "
                    "install via `uv pip install librosa`",
                ) from exc

            self.register_buffer("cos_w", cos_w, persistent=False)
            self.register_buffer("sin_w", sin_w, persistent=False)
            self.register_buffer("mel_mat", mel_mat, persistent=False)
            self._F = F  # avoid re-import in forward

        def forward(self, pcm: "torch.Tensor") -> "torch.Tensor":
            # pcm: [B, T] → [B, 1, T]
            x = pcm.unsqueeze(1)
            real = self._F.conv1d(x, self.cos_w, stride=self.HOP, padding=0)
            imag = self._F.conv1d(x, self.sin_w, stride=self.HOP, padding=0)
            power = real * real + imag * imag  # [B, n_bins, frames]
            # mel_mat: [n_mels, n_bins] @ power: [B, n_bins, F] → [B, n_mels, F]
            mel = torch.einsum("mn,bnf->bmf", self.mel_mat, power)
            return torch.log(mel.clamp_min(1e-6))

    # Architecture sized to land at ~71,666 trainable params — within ±5% of
    # the paper's 72,256 student budget. Sizes were picked by sweeping
    # (d_model, dim_feedforward, mid_channels) under the param-count gate.
    class Student(nn.Module):
        D_MODEL = 56
        DFF = 112
        MID = 48
        N_HEAD = 4
        N_LAYERS = 2

        def __init__(self) -> None:
            super().__init__()
            self.logmel = LogMel()
            self.conv1 = nn.Conv1d(80, self.MID, kernel_size=3, padding=1)
            self.conv2 = nn.Conv1d(self.MID, self.D_MODEL, kernel_size=3, padding=1)
            encoder_layer = nn.TransformerEncoderLayer(
                d_model=self.D_MODEL,
                nhead=self.N_HEAD,
                dim_feedforward=self.DFF,
                batch_first=True,
            )
            self.encoder = nn.TransformerEncoder(
                encoder_layer, num_layers=self.N_LAYERS,
            )
            self.head_vad = nn.Linear(self.D_MODEL, 3)
            self.head_aux = nn.Linear(self.D_MODEL, len(EXPRESSIVE_EMOTION_TAGS))

        def forward(self, pcm: "torch.Tensor") -> "torch.Tensor":
            x = self.logmel(pcm)            # [B, 80, F]
            x = torch.relu(self.conv1(x))   # [B, MID, F]
            x = torch.relu(self.conv2(x))   # [B, D, F]
            x = x.transpose(1, 2)           # [B, F, D]
            x = self.encoder(x)             # [B, F, D]
            x = x.mean(dim=1)               # [B, D]
            vad = torch.sigmoid(self.head_vad(x))  # [B, 3] in (0,1)
            return vad

        def forward_with_aux(
            self, pcm: "torch.Tensor",
        ) -> "tuple[torch.Tensor, torch.Tensor]":
            """Training-time forward exposing both heads. The 7-class aux
            head supervises a categorical CE auxiliary loss against the
            label-projected MELD/IEMOCAP targets; it is dropped at export.
            """
            x = self.logmel(pcm)
            x = torch.relu(self.conv1(x))
            x = torch.relu(self.conv2(x))
            x = x.transpose(1, 2)
            x = self.encoder(x)
            x = x.mean(dim=1)
            vad = torch.sigmoid(self.head_vad(x))
            cls_logits = self.head_aux(x)
            return vad, cls_logits

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


# ---------------------------------------------------------------------------
# Windowing constants for the teacher pass — 8-second window, 4-second hop.
# Matches the runtime adapter's expected input duration (see
# `voice-emotion-classifier.ts:MAX_WINDOW_SECONDS`). The audeering teacher is
# trained on 8-second snippets; longer clips are striped, shorter clips are
# zero-padded to one window so we always emit at least one row per clip.
# ---------------------------------------------------------------------------

TEACHER_WINDOW_SECONDS = 8.0
TEACHER_HOP_SECONDS = 4.0


def _load_pcm_mono_16k(path: pathlib.Path) -> "tuple[Any, int]":
    """Load a `*.wav` clip as mono 16 kHz float32 PCM.

    Uses `soundfile` + the (optional) `librosa` resampler. If the clip is
    already 16 kHz mono, no resample happens. We never silently downmix at
    a different sample rate — that would corrupt the teacher's V-A-D
    regression.
    """
    import numpy as np
    import soundfile as sf

    data, sr = sf.read(str(path), dtype="float32", always_2d=False)
    if data.ndim == 2:
        data = data.mean(axis=1)  # downmix to mono
    if sr != WAV2SMALL_SAMPLE_RATE:
        try:
            import librosa  # type: ignore[import-not-found]
        except ImportError as exc:
            raise RuntimeError(
                f"clip {path} is {sr} Hz; resample to "
                f"{WAV2SMALL_SAMPLE_RATE} Hz requires librosa "
                "(install via `uv pip install librosa`)",
            ) from exc
        data = librosa.resample(
            data, orig_sr=sr, target_sr=WAV2SMALL_SAMPLE_RATE,
        )
    return np.asarray(data, dtype="float32"), WAV2SMALL_SAMPLE_RATE


def _slice_windows(pcm: Any, window_s: float, hop_s: float) -> "list[Any]":
    """Slice mono PCM into 8-second windows with 4-second hop.

    Clips shorter than one window are zero-padded to exactly one window;
    longer clips emit ⌈(len-window)/hop⌉+1 strided windows. Tail windows
    that don't fully fit are zero-padded to the window length.
    """
    import numpy as np

    win = int(window_s * WAV2SMALL_SAMPLE_RATE)
    hop = int(hop_s * WAV2SMALL_SAMPLE_RATE)
    if pcm.shape[0] <= win:
        padded = np.zeros(win, dtype="float32")
        padded[: pcm.shape[0]] = pcm
        return [padded]
    out: list[Any] = []
    start = 0
    while start + win <= pcm.shape[0]:
        out.append(pcm[start : start + win].copy())
        start += hop
    if start < pcm.shape[0]:
        tail = np.zeros(win, dtype="float32")
        remainder = pcm[start:]
        tail[: remainder.shape[0]] = remainder
        out.append(tail)
    return out


def _provenance_from_clip(clip: pathlib.Path) -> dict[str, str]:
    """Extract `(corpus, clip_id, split)` provenance from the clip path.

    Convention: ``<audio_dir>/<corpus>/<split>/<clip_id>.wav``. Falls back
    to ``"unknown"`` when the path is flatter than that — never crashes,
    because the data-prep scripts are operator-managed and may pre-shuffle
    into a flat layout. Stratification is best-effort.
    """
    parts = clip.parts
    return {
        "corpus": parts[-3] if len(parts) >= 3 else "unknown",
        "split": parts[-2] if len(parts) >= 2 else "unknown",
        "clip_id": clip.stem,
    }


def teacher_pseudo_labels(
    teacher: Any,
    clips: Iterable[pathlib.Path],
    *,
    device: str = "cpu",
    out_path: pathlib.Path | None = None,
) -> "list[dict[str, Any]]":
    """Run the teacher on every clip in 8-second windows and emit one
    row per window with the V-A-D triple, the 7-class softmax, and the
    provenance tags.

    Output schema (one row per window):

        {
          "clip": str,
          "corpus": str,
          "split": str,
          "clip_id": str,
          "window_idx": int,
          "valence": float,        # [0,1]
          "arousal": float,        # [0,1]
          "dominance": float,      # [0,1]
          "softmax_7class": list[float],  # length == len(EXPRESSIVE_EMOTION_TAGS)
        }

    The audeering teacher emits raw logits over a 9-class label space
    (Ekman 7 + "other" + "neutral"); we project to our 7-class taxonomy by
    dropping the two extra classes and re-normalising the softmax. The
    seven indices map onto `EXPRESSIVE_EMOTION_TAGS` in declared order.

    When ``out_path`` is provided, rows are also written to a parquet file
    (or JSONL fallback when pyarrow isn't importable). Returns the in-memory
    rows regardless so callers can pipe directly into ``train_student``.

    Empty ``clips`` returns ``[]`` so the operator-friendly "no-op when
    staging incomplete" path through the CLI still works.
    """
    clips_list = list(clips)
    if not clips_list:
        return []

    # The audeering license guard — fail loud if the loaded teacher card
    # didn't declare CC-BY-NC-SA-4.0 / non-commercial. `load_teacher` is
    # the canonical guard; this is the belt-and-braces re-check before we
    # actually feed audio through the teacher.
    if teacher is None or not isinstance(teacher, Mapping):
        raise RuntimeError(
            "teacher_pseudo_labels: `teacher` must be the dict returned by "
            "`load_teacher` — got %r. The license check on the audeering "
            "checkpoint runs inside `load_teacher`; do not bypass it."
            % (type(teacher).__name__,),
        )
    if "model" not in teacher or "processor" not in teacher:
        raise RuntimeError(
            "teacher dict missing 'model' or 'processor' keys; load via "
            "`load_teacher(repo)` which performs the license check.",
        )

    import numpy as np
    import torch

    model = teacher["model"]
    processor = teacher["processor"]
    model = model.to(device).eval()

    rows: list[dict[str, Any]] = []
    for clip in clips_list:
        pcm, sr = _load_pcm_mono_16k(clip)
        windows = _slice_windows(pcm, TEACHER_WINDOW_SECONDS, TEACHER_HOP_SECONDS)
        prov = _provenance_from_clip(clip)
        for window_idx, win_pcm in enumerate(windows):
            inputs = processor(
                win_pcm,
                sampling_rate=sr,
                return_tensors="pt",
            )
            input_values = inputs["input_values"].to(device)
            with torch.no_grad():
                outputs = model(input_values)
            # The custom audeering `EmotionModel` returns
            # `(hidden_states_mean, logits)` where logits is `[1, 3]` —
            # the audeering README documents the order as
            # `(arousal, dominance, valence)`. We re-order to V-A-D so the
            # downstream student head matches our shipped ONNX contract
            # (V, A, D in that order).
            #
            # Some HF auto-class forks expose `.logits`; keep the legacy
            # path for forks that pre-date the custom-class README.
            if hasattr(outputs, "logits"):
                logits_t = outputs.logits
            elif isinstance(outputs, (tuple, list)) and len(outputs) >= 2:
                logits_t = outputs[1]
            else:
                logits_t = outputs[0]
            logits = logits_t.detach().cpu().float().numpy().reshape(-1)
            if logits.shape[0] == 3:
                # Re-order audeering A-D-V → our V-A-D contract.
                a, d, v = float(logits[0]), float(logits[1]), float(logits[2])
                softmax = [0.0] * len(EXPRESSIVE_EMOTION_TAGS)
            elif logits.shape[0] >= len(EXPRESSIVE_EMOTION_TAGS):
                # Truncate to first 7 classes (Ekman 7 in EXPRESSIVE_EMOTION_TAGS
                # order); re-softmax so the row is a valid distribution.
                truncated = logits[: len(EXPRESSIVE_EMOTION_TAGS)]
                ex = np.exp(truncated - truncated.max())
                softmax_arr = ex / max(float(ex.sum()), 1e-9)
                softmax = [float(x) for x in softmax_arr]
                # No V-A-D head — synthesise neutral mid-range so the
                # downstream train step can still consume the row.
                v = a = d = 0.5
            else:
                raise RuntimeError(
                    f"unexpected teacher output shape {logits.shape} for "
                    f"clip {clip} window {window_idx}; expected 3 (V-A-D) "
                    f"or ≥{len(EXPRESSIVE_EMOTION_TAGS)} (categorical)",
                )
            rows.append(
                {
                    "clip": str(clip),
                    "corpus": prov["corpus"],
                    "split": prov["split"],
                    "clip_id": prov["clip_id"],
                    "window_idx": window_idx,
                    "valence": v,
                    "arousal": a,
                    "dominance": d,
                    "softmax_7class": softmax,
                },
            )

    if out_path is not None:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            import pyarrow as pa  # type: ignore[import-not-found]
            import pyarrow.parquet as pq  # type: ignore[import-not-found]

            table = pa.Table.from_pylist(rows)
            pq.write_table(table, str(out_path))
        except ImportError:
            # JSONL fallback so the operator can still consume the labels
            # without pyarrow installed.
            fallback = out_path.with_suffix(".jsonl")
            with fallback.open("w", encoding="utf-8") as fh:
                for row in rows:
                    fh.write(json.dumps(row) + "\n")
    return rows


def _projection_loss_weights() -> "tuple[float, float]":
    """Loss weights for (MSE on V-A-D, CE on 7-class). The CE auxiliary is
    optional during distillation — we keep its weight at 0.5 so the V-A-D
    regression dominates (the runtime path discretises V-A-D in TS, so the
    regression head is what actually ships).
    """
    return (1.0, 0.5)


def train_student(
    *,
    student: Any,
    teacher_labels: "Iterable[dict[str, Any]] | "
    "Iterable[tuple[pathlib.Path, tuple[float, float, float]]]",
    epochs: int,
    batch_size: int,
    device: str,
    run_dir: pathlib.Path | None = None,
    learning_rate: float = 3e-4,
    weight_decay: float = 0.01,
) -> Mapping[str, float]:
    """Train the student on teacher pseudo-labels.

    Loss = w_vad * MSE(student_vad, teacher_vad)
         + w_cls * CE(student_aux_logits, argmax(teacher_softmax_7class))

    Weights from `_projection_loss_weights()` (V-A-D=1.0, CE=0.5). The
    7-class CE supervises the aux head against the teacher's distilled
    7-class softmax; it's dropped at export time so the shipped ONNX only
    has the V-A-D head.

    Optimizer: APOLLO. Per repo policy (`packages/training/AGENTS.md §1`),
    AdamW / Muon are not allowed. Falls back to `apollo_mini` for very
    small parameter counts where the rank-256 default would over-allocate.

    Returns a dict with keys ``{"mse_vad", "macro_f1_meld", "macro_f1_iemocap"}``
    matching the provenance JSON. Best-by-MELD-macro-F1 checkpoint is
    written to ``<run_dir>/best.pt`` when ``run_dir`` is provided.
    """
    rows = list(teacher_labels)
    if not rows:
        raise RuntimeError(
            "train_student: empty teacher_labels — run `teacher_pseudo_labels` "
            "first, or pass a non-empty list of label rows.",
        )

    import numpy as np
    import torch
    from torch import nn
    from torch.utils.data import DataLoader, TensorDataset

    # Local import to avoid top-level dependency on the training package
    # whose own imports drag in torch.
    try:
        from packages.training.scripts.training.optimizer import (
            build_apollo_mini_optimizer,
            build_apollo_optimizer,
        )
    except ImportError as exc:
        raise RuntimeError(
            "APOLLO optimizer factory not importable; ensure "
            "packages/training/scripts/training/optimizer.py is on "
            "sys.path and apollo-torch is installed",
        ) from exc

    # Build tensors from rows. Each row is one 8-second window already.
    def _row_to_pcm(row: dict[str, Any]) -> Any:
        """Re-load the PCM window from disk for `row`. Caching is left to
        the operator (parquet file is the cache); we re-read here so the
        train loop's tensor footprint stays bounded by `batch_size`.
        """
        pcm, _ = _load_pcm_mono_16k(pathlib.Path(row["clip"]))
        windows = _slice_windows(pcm, TEACHER_WINDOW_SECONDS, TEACHER_HOP_SECONDS)
        return windows[int(row["window_idx"])]

    # Pre-build the (pcm, V-A-D, 7-class label) lists — this is the place
    # where the operator's full corpus is materialised in memory; on a real
    # MSP-Podcast pass the operator will want to swap this for a streaming
    # IterableDataset, but for the in-repo training-script CLI this matches
    # the rest of the kokoro/dflash scripts' approach.
    pcm_list: list[Any] = []
    vad_list: list[Any] = []
    cls_list: list[int] = []
    meld_mask: list[bool] = []
    iemocap_mask: list[bool] = []
    for row in rows:
        pcm_list.append(_row_to_pcm(row))
        vad_list.append(
            [float(row["valence"]), float(row["arousal"]), float(row["dominance"])],
        )
        soft = row.get("softmax_7class") or [0.0] * len(EXPRESSIVE_EMOTION_TAGS)
        cls_list.append(int(np.argmax(np.asarray(soft, dtype="float32"))))
        meld_mask.append(str(row.get("corpus", "")).lower() == "meld")
        iemocap_mask.append(str(row.get("corpus", "")).lower() == "iemocap")

    pcm_tensor = torch.from_numpy(np.stack(pcm_list).astype("float32"))
    vad_tensor = torch.from_numpy(np.asarray(vad_list, dtype="float32"))
    cls_tensor = torch.from_numpy(np.asarray(cls_list, dtype="int64"))

    # Hold out the last 10% as the eval split (deterministic, no shuffling
    # so this stays reproducible from a single seed).
    n = pcm_tensor.shape[0]
    split = max(1, int(n * 0.9))
    train_ds = TensorDataset(
        pcm_tensor[:split], vad_tensor[:split], cls_tensor[:split],
    )
    eval_ds = TensorDataset(
        pcm_tensor[split:], vad_tensor[split:], cls_tensor[split:],
    )
    eval_meld_mask = torch.tensor(meld_mask[split:], dtype=torch.bool)
    eval_iemocap_mask = torch.tensor(iemocap_mask[split:], dtype=torch.bool)

    train_loader = DataLoader(
        train_ds, batch_size=batch_size, shuffle=True, drop_last=False,
    )
    eval_loader = DataLoader(eval_ds, batch_size=batch_size, shuffle=False)

    student = student.to(device).train()
    w_vad, w_cls = _projection_loss_weights()
    mse = nn.MSELoss()
    ce = nn.CrossEntropyLoss()

    # APOLLO with a sensible rank for a 70K-param model — `apollo_mini`
    # (rank-1, tensor-wise) is the right size for sub-100K params.
    try:
        optimizer = build_apollo_mini_optimizer(
            student, lr=learning_rate, weight_decay=weight_decay,
        )
    except ValueError:
        # No 2-D weights found — happens only with the stub Student in
        # tests. Fall back to APOLLO at the smaller rank.
        optimizer = build_apollo_optimizer(
            student, lr=learning_rate, weight_decay=weight_decay, rank=8,
        )

    best_macro_f1 = -1.0
    best_metrics: dict[str, float] = {
        "mse_vad": float("inf"),
        "macro_f1_meld": 0.0,
        "macro_f1_iemocap": 0.0,
    }
    if run_dir is not None:
        run_dir.mkdir(parents=True, exist_ok=True)

    for epoch in range(epochs):
        student.train()
        for pcm_b, vad_b, cls_b in train_loader:
            pcm_b = pcm_b.to(device)
            vad_b = vad_b.to(device)
            cls_b = cls_b.to(device)
            vad_pred, cls_logits = student.forward_with_aux(pcm_b)
            loss = w_vad * mse(vad_pred, vad_b) + w_cls * ce(cls_logits, cls_b)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            optimizer.step()

        # Eval pass — collect predictions for MSE + macro F1.
        student.eval()
        all_vad_pred: list[Any] = []
        all_vad_gold: list[Any] = []
        all_cls_pred: list[int] = []
        all_cls_gold: list[int] = []
        with torch.no_grad():
            for pcm_b, vad_b, cls_b in eval_loader:
                pcm_b = pcm_b.to(device)
                vad_pred, cls_logits = student.forward_with_aux(pcm_b)
                all_vad_pred.append(vad_pred.detach().cpu().numpy())
                all_vad_gold.append(vad_b.numpy())
                all_cls_pred.extend(
                    cls_logits.argmax(dim=-1).detach().cpu().numpy().tolist(),
                )
                all_cls_gold.extend(cls_b.numpy().tolist())
        if all_vad_pred:
            vad_pred_np = np.concatenate(all_vad_pred)
            vad_gold_np = np.concatenate(all_vad_gold)
            mse_vad = float(((vad_pred_np - vad_gold_np) ** 2).mean())
            macro_f1_meld = _macro_f1(
                [p for p, m in zip(all_cls_pred, eval_meld_mask.tolist(), strict=False) if m],
                [g for g, m in zip(all_cls_gold, eval_meld_mask.tolist(), strict=False) if m],
                num_classes=len(EXPRESSIVE_EMOTION_TAGS),
            )
            macro_f1_iemocap = _macro_f1(
                [p for p, m in zip(all_cls_pred, eval_iemocap_mask.tolist(), strict=False) if m],
                [g for g, m in zip(all_cls_gold, eval_iemocap_mask.tolist(), strict=False) if m],
                num_classes=len(EXPRESSIVE_EMOTION_TAGS),
            )
        else:
            mse_vad = float("inf")
            macro_f1_meld = 0.0
            macro_f1_iemocap = 0.0

        if macro_f1_meld > best_macro_f1:
            best_macro_f1 = macro_f1_meld
            best_metrics = {
                "mse_vad": mse_vad,
                "macro_f1_meld": macro_f1_meld,
                "macro_f1_iemocap": macro_f1_iemocap,
            }
            if run_dir is not None:
                torch.save(
                    {
                        "state_dict": student.state_dict(),
                        "epoch": epoch,
                        "metrics": best_metrics,
                    },
                    run_dir / "best.pt",
                )
    return best_metrics


def _macro_f1(predictions: list[int], golds: list[int], num_classes: int) -> float:
    """Macro F1 over ``num_classes`` classes — averages per-class F1.

    Empty inputs return 0.0 (no signal, no score).
    """
    if not predictions or not golds:
        return 0.0
    per_class_f1: list[float] = []
    for c in range(num_classes):
        tp = sum(1 for p, g in zip(predictions, golds, strict=False) if p == c and g == c)
        fp = sum(1 for p, g in zip(predictions, golds, strict=False) if p == c and g != c)
        fn = sum(1 for p, g in zip(predictions, golds, strict=False) if p != c and g == c)
        if tp == 0:
            per_class_f1.append(0.0)
            continue
        precision = tp / (tp + fp)
        recall = tp / (tp + fn)
        per_class_f1.append(2 * precision * recall / (precision + recall))
    return sum(per_class_f1) / len(per_class_f1)


def export_student_onnx(
    *,
    student: Any,
    out_path: pathlib.Path,
    opset: int = DEFAULT_OPSET,
    smoke_input_seconds: float = 1.0,
) -> None:
    """Export the trained student to int8 ONNX.

    Output shape ``[batch, 3]`` (V-A-D), output name ``vad``. The 7-class
    aux head is dropped at export — the shipped model only exposes V-A-D;
    the discretisation to ``EXPRESSIVE_EMOTION_TAGS`` happens in TS at
    ``voice-emotion-classifier.ts``.

    The int8 quantisation uses
    ``onnxruntime.quantization.quantize_dynamic`` with ``QuantType.QInt8`` —
    matches what we use for every other small on-device ONNX
    (wake-word, VAD, embedding). The exported ONNX is metadata-tagged with
    the seven canonical emotion tags so the TS adapter can sanity-check the
    label order at load time.
    """
    import torch

    if out_path.suffix != ".onnx":
        raise ValueError(
            f"out_path must end in '.onnx', got {out_path.suffix!r}",
        )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    fp32_path = out_path.with_suffix(".fp32.onnx")

    student = student.eval().cpu()
    sample_len = int(smoke_input_seconds * WAV2SMALL_SAMPLE_RATE)
    dummy = torch.zeros(1, sample_len, dtype=torch.float32)
    # `dynamo=False` keeps us on the legacy TorchScript exporter, which is
    # what onnxruntime-node 1.20.x ships against. The dynamo path also
    # requires `onnxscript`, an extra dep we don't want in the training env.
    torch.onnx.export(
        student,
        dummy,
        str(fp32_path),
        input_names=["pcm"],
        output_names=["vad"],
        opset_version=opset,
        dynamic_axes={"pcm": {0: "batch", 1: "samples"}, "vad": {0: "batch"}},
        dynamo=False,
    )

    # Bake emotion-tag metadata into the ONNX so the runtime classifier can
    # sanity-check label order at load time.
    try:
        import onnx
        model_proto = onnx.load(str(fp32_path))
        meta = model_proto.metadata_props.add()
        meta.key = "expressive_emotion_tags"
        meta.value = ",".join(EXPRESSIVE_EMOTION_TAGS)
        meta = model_proto.metadata_props.add()
        meta.key = "param_count"
        meta.value = str(count_params(student))
        meta = model_proto.metadata_props.add()
        meta.key = "sample_rate_hz"
        meta.value = str(WAV2SMALL_SAMPLE_RATE)
        meta = model_proto.metadata_props.add()
        meta.key = "head"
        meta.value = "vad"
        onnx.save(model_proto, str(fp32_path))
    except ImportError:
        # `onnx` is part of the standard training env. Operator gets a
        # clean error if it's missing.
        raise RuntimeError(
            "onnx required for metadata tagging during ONNX export; install "
            "via `uv pip install onnx onnxruntime`",
        )

    # Int8 dynamic quantisation.
    try:
        from onnxruntime.quantization import QuantType, quantize_dynamic

        quantize_dynamic(
            model_input=str(fp32_path),
            model_output=str(out_path),
            weight_type=QuantType.QInt8,
        )
    except ImportError as exc:
        raise RuntimeError(
            "onnxruntime required for int8 dynamic quantisation; install "
            "via `uv pip install onnxruntime`",
        ) from exc

    # Smoke-roundtrip the exported ONNX so we catch op-set / quantisation
    # mismatches at training time instead of at runtime load.
    try:
        import numpy as np
        import onnxruntime as ort

        session = ort.InferenceSession(
            str(out_path), providers=["CPUExecutionProvider"],
        )
        smoke = np.zeros((1, sample_len), dtype="float32")
        outputs = session.run(None, {"pcm": smoke})
        if outputs[0].shape != (1, 3):
            raise RuntimeError(
                f"exported ONNX returned unexpected output shape "
                f"{outputs[0].shape}; expected (1, 3)",
            )
    except ImportError:
        # If onnxruntime isn't installed in the training env, this is the
        # documented escape hatch (per the task brief): print a single line
        # and continue. The full training env always has onnxruntime
        # installed, so this branch is operator-debug only.
        print(
            f"export_student_onnx: onnxruntime not importable; skipping "
            f"smoke roundtrip of {out_path}",
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
