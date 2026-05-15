#!/usr/bin/env python3
"""Convert openWakeWord's three streaming graphs (melspectrogram,
embedding model, classifier head) into three GGUF files the
wakeword-cpp runtime will load through its ggml dispatcher.

This is a SKELETON. The TODO blocks below mark the work the real
conversion will do; they intentionally raise NotImplementedError so a
caller cannot mistake the stub for a working converter.

Upstream
--------
Repo:    https://github.com/dscripka/openWakeWord  (Apache-2.0)
Release: openwakeword-models-v0.1
         https://github.com/dscripka/openWakeWord/releases/tag/v0.5.1

Three ONNX graphs are bundled per wake-word model:

  1. melspectrogram.onnx — 16 kHz PCM → 32-bin log-mel frames at a
     10 ms (160-sample) hop, 25 ms (400-sample) window. Model-agnostic;
     ships once per bundle.
  2. embedding_model.onnx — sliding 76-mel-frame window → 96-dim
     embedding. Model-agnostic; ships once per bundle.
  3. <wake-phrase>.onnx — a 2-or-3-layer dense head over the last 16
     embeddings → P(wake) ∈ [0, 1]. ONE per wake phrase. The
     placeholder shipped today (`wake/hey-eliza.onnx`) is the upstream
     `hey_jarvis_v0.1.onnx` renamed; a real "hey eliza" head is
     trained by `packages/training/scripts/wakeword/train_eliza1_wakeword_head.py`.

Inputs
------
- ``--melspec-onnx``: path to ``melspectrogram.onnx`` from the
  openWakeWord release.
- ``--embedding-onnx``: path to ``embedding_model.onnx`` from the
  openWakeWord release.
- ``--classifier-onnx``: path to ``<wake-phrase>.onnx`` (e.g.
  ``hey-eliza.onnx`` from the staged eliza-1 bundle, or
  ``hey_jarvis_v0.1.onnx`` from the upstream release).

Outputs
-------
Three GGUF files written next to the inputs (or to ``--out-dir``):

- ``<phrase>.melspec.gguf``    — frozen Hann window + mel filter bank
                                 + STFT params metadata.
- ``<phrase>.embedding.gguf``  — embedding-CNN weights (fp16) +
                                 architecture metadata (kernel sizes,
                                 strides, channel counts).
- ``<phrase>.classifier.gguf`` — classifier-head weights (fp16) +
                                 input shape (1, 16, 96) and threshold.

Each GGUF carries a small set of metadata keys the runtime uses to
refuse a mismatched build:

- ``wakeword.upstream_commit`` = pinned dscripka/openWakeWord commit
                                 (TODO: record at conversion time so
                                 the runtime can refuse loads from an
                                 older or newer fork).
- ``wakeword.phrase``          = wake phrase the classifier was trained
                                 on (e.g. "hey eliza").
- ``wakeword.melspec_n_mels``  = 32 (locked).
- ``wakeword.melspec_hop``     = 160 (locked, 10 ms @ 16 kHz).
- ``wakeword.melspec_win``     = 400 (locked, 25 ms @ 16 kHz).
- ``wakeword.embedding_dim``   = 96 (locked).
- ``wakeword.embedding_window``= 76 (locked, mel frames).
- ``wakeword.head_window``     = 16 (locked, embeddings).
"""

from __future__ import annotations

import argparse
from pathlib import Path


# ── Locked constants — the runtime refuses GGUFs that disagree ─────────────
# These mirror the openWakeWord upstream graph dimensions (NOT the
# 80-mel / 0–8000 Hz first-pass C reference; the C reference lives in
# `src/wakeword_melspec.c` and is part of Phase 2, not the GGUF
# contract). See `src/wakeword_internal.h` for why those numbers
# diverge today and how Phase 2 will reconcile them.
MELSPEC_N_MELS = 32
MELSPEC_HOP = 160
MELSPEC_WIN = 400
EMBEDDING_DIM = 96
EMBEDDING_WINDOW = 76
HEAD_WINDOW = 16

# Pinned upstream commit. Update when re-pulling the openWakeWord
# release and re-test parity against the openWakeWord Python
# reference. The runtime reads this key from the GGUF and refuses to
# load an unknown commit.
WAKEWORD_UPSTREAM_COMMIT = "TODO: pin dscripka/openWakeWord commit at conversion time"
WAKEWORD_RELEASE_URL = (
    "https://github.com/dscripka/openWakeWord/releases/tag/v0.5.1"
)


def discover_melspec_tensors(onnx_path: Path) -> dict[str, object]:
    """Walk the melspectrogram ONNX and return a {name: tensor} map of
    the static tensors the C-side melspec replicates (Hann window, mel
    filter bank).

    TODO:
      - Open the ONNX with ``onnx.load(str(onnx_path))``.
      - Extract the Hann window initializer (length 400).
      - Extract the mel filter bank initializer (32 × 201) — the
        fmin/fmax are baked into the upstream graph, so we recover them
        from the filter-bank centres rather than as a separate metadata
        key.
      - Refuse any unexpected initializer — silent acceptance hides
        upstream renames.
      - Return a stable, sorted mapping keyed by GGUF tensor name.
    """
    raise NotImplementedError("discover_melspec_tensors: see TODO")


def discover_embedding_tensors(onnx_path: Path) -> dict[str, object]:
    """Walk the embedding ONNX and return a {name: tensor} map of the
    small CNN's weights (Conv2D + BN + ReLU stack ending in a 96-dim
    pooled output).

    TODO:
      - Same load path as the melspec.
      - Sanity-check the output shape is (1, 96, 1, 1) so the runtime
        flatten matches.
      - Convert weights to fp16; the embedding CNN is small enough
        that the quality cost of fp16 is irrelevant.
      - Return a stable, sorted mapping keyed by GGUF tensor name.
    """
    raise NotImplementedError("discover_embedding_tensors: see TODO")


def discover_classifier_tensors(onnx_path: Path) -> dict[str, object]:
    """Walk the classifier ONNX and return a {name: tensor} map of the
    dense head's weights (typically 2–3 fully-connected layers on top
    of the (16, 96) embedding window).

    TODO:
      - Same load path as the others.
      - Sanity-check the input shape is (1, 16, 96) so the runtime
        feeder matches.
      - Sanity-check the output shape is a single scalar in [0, 1].
      - Convert weights to fp16.
    """
    raise NotImplementedError("discover_classifier_tensors: see TODO")


def write_gguf(
    *,
    arch: str,
    tensors: dict[str, object],
    metadata: dict[str, object],
    output_path: Path,
) -> dict[str, object]:
    """Emit a single GGUF file.

    TODO:
      - Initialize ``gguf.GGUFWriter(str(output_path), arch=arch)``.
      - Write every key in ``metadata``.
      - Pack the tensors as fp16 by default; mirror the layering in
        ``packages/native-plugins/doctr-cpp/scripts/doctr_to_gguf.py``.
      - Return a small stats dict (n_tensors, output_path).
    """
    raise NotImplementedError("write_gguf: see TODO")


def convert(
    *,
    melspec_onnx: Path,
    embedding_onnx: Path,
    classifier_onnx: Path,
    phrase: str,
    out_dir: Path,
) -> dict[str, object]:
    """Drive the conversion. Returns a small stats dict."""
    for p, label in [
        (melspec_onnx, "--melspec-onnx"),
        (embedding_onnx, "--embedding-onnx"),
        (classifier_onnx, "--classifier-onnx"),
    ]:
        if not p.exists():
            raise FileNotFoundError(f"{label} not found: {p}")

    out_dir.mkdir(parents=True, exist_ok=True)
    base = phrase.replace(" ", "-").lower()

    melspec_tensors = discover_melspec_tensors(melspec_onnx)
    embedding_tensors = discover_embedding_tensors(embedding_onnx)
    classifier_tensors = discover_classifier_tensors(classifier_onnx)

    common_meta = {
        "wakeword.upstream_commit": WAKEWORD_UPSTREAM_COMMIT,
        "wakeword.phrase": phrase,
        "wakeword.release_url": WAKEWORD_RELEASE_URL,
        "wakeword.melspec_n_mels": MELSPEC_N_MELS,
        "wakeword.melspec_hop": MELSPEC_HOP,
        "wakeword.melspec_win": MELSPEC_WIN,
        "wakeword.embedding_dim": EMBEDDING_DIM,
        "wakeword.embedding_window": EMBEDDING_WINDOW,
        "wakeword.head_window": HEAD_WINDOW,
    }

    stats = {
        "melspec": write_gguf(
            arch="wakeword-melspec",
            tensors=melspec_tensors,
            metadata=common_meta,
            output_path=out_dir / f"{base}.melspec.gguf",
        ),
        "embedding": write_gguf(
            arch="wakeword-embedding",
            tensors=embedding_tensors,
            metadata=common_meta,
            output_path=out_dir / f"{base}.embedding.gguf",
        ),
        "classifier": write_gguf(
            arch="wakeword-classifier",
            tensors=classifier_tensors,
            metadata=common_meta,
            output_path=out_dir / f"{base}.classifier.gguf",
        ),
    }
    return stats


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    p.add_argument(
        "--melspec-onnx", type=Path, required=True,
        help="Path to openWakeWord's melspectrogram.onnx.",
    )
    p.add_argument(
        "--embedding-onnx", type=Path, required=True,
        help="Path to openWakeWord's embedding_model.onnx.",
    )
    p.add_argument(
        "--classifier-onnx", type=Path, required=True,
        help="Path to the wake-phrase classifier ONNX (e.g. hey-eliza.onnx).",
    )
    p.add_argument(
        "--phrase", type=str, default="hey eliza",
        help="Wake phrase the classifier was trained on (default: 'hey eliza').",
    )
    p.add_argument(
        "--out-dir", type=Path, required=True,
        help="Directory the three GGUFs are written to.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    convert(
        melspec_onnx=args.melspec_onnx,
        embedding_onnx=args.embedding_onnx,
        classifier_onnx=args.classifier_onnx,
        phrase=args.phrase,
        out_dir=args.out_dir,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
