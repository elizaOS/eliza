#!/usr/bin/env python3
"""Convert mindee/doctr detection (db_resnet50) and recognition
(crnn_vgg16_bn) checkpoints into a single GGUF the doctr-cpp runtime
loads through its in-house tensor reader (see ``src/doctr_gguf.c``).

This used to be a skeleton that raised NotImplementedError. It is now
a working converter against ``python-doctr`` >= 1.0:

  pip install --break-system-packages python-doctr

Default usage downloads pretrained weights from the doctr static
mirror and writes a single GGUF that holds both heads:

  python3 doctr_to_gguf.py --output /tmp/doctr.gguf

The runtime refuses to load a GGUF whose ``doctr.detector`` /
``doctr.recognizer`` / ``doctr.detector_input_size`` /
``doctr.recognizer_input_h`` keys disagree with the C ABI.

Tensors are emitted as fp32 for the first pass. Phase 3 will layer
Q4_POLAR / TurboQuant on top using the same scaffolding
``polarquant_to_gguf.py`` demonstrates (the GGUF format already
supports per-tensor type overrides).

Per-tensor name convention (read by ``doctr_gguf.c``):

  det.<dotted state_dict key>     for detector tensors
  rec.<dotted state_dict key>     for recognizer tensors

The dotted key is the PyTorch ``state_dict`` key verbatim. The C
runtime indexes by string, so renames here are renames in the C
runtime too — keep them stable.

Vocab is stored as ``doctr.vocab`` — a single UTF-8 string of all
non-blank symbols concatenated in order. Position 0 is implicitly the
CTC blank. Storing as a single string keeps the GGUF reader simple in
C; splitting it back up on the runtime side is a NUL-free byte walk.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

# ── Locked block-format constants ───────────────────────────────────────────
DETECTOR_NAME = "db_resnet50"
RECOGNIZER_NAME = "crnn_vgg16_bn"
DETECTOR_INPUT_SIZE = 1024
RECOGNIZER_INPUT_HEIGHT = 32

# Pinned upstream commit. python-doctr >= 1.0.1 ships these as the
# pretrained variants; the wheel itself is the pin. The runtime reads
# this key from the GGUF and refuses to load an unknown commit.
DOCTR_UPSTREAM_PIN = "python-doctr==1.0.1"


def discover_detector_tensors(checkpoint_path: Path | None) -> dict[str, np.ndarray]:
    """Walk the db_resnet50 state_dict and return a {name: np.ndarray}
    map keyed by the GGUF tensor name (``det.<dotted key>``).

    If ``checkpoint_path`` is None the doctr default pretrained
    checkpoint is downloaded; otherwise we ``torch.load`` the file.
    """
    state_dict = _load_state_dict(checkpoint_path, kind="detector")
    out: dict[str, np.ndarray] = {}
    for key, tensor in state_dict.items():
        # num_batches_tracked is a 0-d int64 scalar that BN never
        # consumes during inference — drop it.
        if key.endswith(".num_batches_tracked"):
            continue
        out[f"det.{key}"] = _to_numpy(tensor)
    _sanity_check_detector(out)
    return out


def discover_recognizer_tensors(checkpoint_path: Path | None) -> dict[str, np.ndarray]:
    """Walk the crnn_vgg16_bn state_dict and return a {name: np.ndarray}
    map keyed by the GGUF tensor name (``rec.<dotted key>``)."""
    state_dict = _load_state_dict(checkpoint_path, kind="recognizer")
    out: dict[str, np.ndarray] = {}
    for key, tensor in state_dict.items():
        if key.endswith(".num_batches_tracked"):
            continue
        out[f"rec.{key}"] = _to_numpy(tensor)
    _sanity_check_recognizer(out)
    return out


def load_vocab(vocab_path: Path | None) -> str:
    """Return the recognizer vocab as a single Unicode string. Position
    0 of the CTC head is the blank; the string here lists positions
    1..N (the non-blank symbols) in order."""
    if vocab_path is None:
        # Default: doctr's crnn_vgg16_bn ships with a 126-symbol French
        # superset. Pull it directly off the model rather than
        # hard-coding so it stays in sync with python-doctr.
        from doctr.models.recognition import crnn_vgg16_bn
        m = crnn_vgg16_bn(pretrained=False)
        return m.vocab
    text = vocab_path.read_text(encoding="utf-8")
    # One symbol per line, blank line is rejected.
    symbols = []
    for line in text.splitlines():
        if not line:
            raise ValueError(f"empty line in vocab {vocab_path}")
        if line in symbols:
            raise ValueError(f"duplicate symbol {line!r} in {vocab_path}")
        symbols.append(line)
    return "".join(symbols)


def write_gguf(
    *,
    detector_tensors: dict[str, np.ndarray],
    recognizer_tensors: dict[str, np.ndarray],
    vocab: str,
    output_path: Path,
) -> dict[str, object]:
    """Emit the GGUF file. Returns a small stats dict."""
    import gguf

    writer = gguf.GGUFWriter(str(output_path), arch="doctr")

    # ── metadata ─────────────────────────────────────────────────────
    writer.add_string("doctr.detector", DETECTOR_NAME)
    writer.add_string("doctr.recognizer", RECOGNIZER_NAME)
    writer.add_uint32("doctr.detector_input_size", DETECTOR_INPUT_SIZE)
    writer.add_uint32("doctr.recognizer_input_h", RECOGNIZER_INPUT_HEIGHT)
    writer.add_string("doctr.vocab", vocab)
    writer.add_uint32("doctr.vocab_size", len(vocab))
    writer.add_string("doctr.upstream_pin", DOCTR_UPSTREAM_PIN)

    # ── tensors ──────────────────────────────────────────────────────
    # Sorted for determinism; the C reader looks tensors up by name so
    # write order is irrelevant for correctness.
    for name in sorted(detector_tensors.keys()):
        writer.add_tensor(name, detector_tensors[name].astype(np.float32))
    for name in sorted(recognizer_tensors.keys()):
        writer.add_tensor(name, recognizer_tensors[name].astype(np.float32))

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()

    return {
        "n_tensors_detector": len(detector_tensors),
        "n_tensors_recognizer": len(recognizer_tensors),
        "vocab_size": len(vocab),
        "output_path": str(output_path),
    }


# ── helpers ─────────────────────────────────────────────────────────────────

def _load_state_dict(checkpoint_path: Path | None, *, kind: str) -> dict:
    """Either load the supplied torch checkpoint or pull down doctr's
    pretrained default. Returns a plain ``{str: torch.Tensor}`` dict
    with any ``module.``/``model.`` prefix stripped."""
    import torch
    if checkpoint_path is not None:
        raw = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
        if isinstance(raw, dict) and "model" in raw and isinstance(raw["model"], dict):
            raw = raw["model"]
    else:
        if kind == "detector":
            from doctr.models.detection import db_resnet50
            model = db_resnet50(pretrained=True)
        elif kind == "recognizer":
            from doctr.models.recognition import crnn_vgg16_bn
            model = crnn_vgg16_bn(pretrained=True)
        else:
            raise ValueError(kind)
        raw = model.state_dict()
    # Strip common DDP / model wrapper prefixes.
    cleaned: dict[str, "torch.Tensor"] = {}
    for k, v in raw.items():
        nk = k
        if nk.startswith("module."):
            nk = nk[len("module."):]
        if nk.startswith("model."):
            nk = nk[len("model."):]
        cleaned[nk] = v
    return cleaned


def _to_numpy(t) -> np.ndarray:
    arr = t.detach().cpu().numpy()
    # GGUF doesn't carry int dtypes for our use; everything is fp32.
    if arr.dtype != np.float32:
        arr = arr.astype(np.float32)
    return np.ascontiguousarray(arr)


# Reference shapes (from doctr 1.0.1) — we use these to refuse silent
# upstream renames. Keep these in sync with python-doctr when bumping.
_DET_REQUIRED = {
    "det.feat_extractor.conv1.weight": (64, 3, 7, 7),
    "det.feat_extractor.bn1.weight": (64,),
    "det.feat_extractor.layer1.0.conv1.weight": (64, 64, 1, 1),
    "det.feat_extractor.layer4.2.conv3.weight": (2048, 512, 1, 1),
    "det.fpn.in_branches.3.0.weight": (256, 2048, 1, 1),
    "det.fpn.out_branches.3.0.weight": (64, 256, 3, 3),
    "det.prob_head.0.weight": (64, 256, 3, 3),
    "det.prob_head.6.weight": (64, 1, 2, 2),
}

_REC_REQUIRED = {
    "rec.feat_extractor.0.weight": (64, 3, 3, 3),
    "rec.feat_extractor.40.weight": (512, 512, 3, 3),
    "rec.decoder.weight_ih_l0": (512, 512),
    "rec.decoder.weight_hh_l0": (512, 128),
    "rec.decoder.weight_ih_l0_reverse": (512, 512),
    "rec.decoder.weight_ih_l1": (512, 256),
    "rec.linear.weight": (127, 256),  # vocab+blank = 127 for doctr default vocab
    "rec.linear.bias": (127,),
}


def _sanity_check_detector(tensors: dict[str, np.ndarray]) -> None:
    for name, expected_shape in _DET_REQUIRED.items():
        if name not in tensors:
            raise KeyError(
                f"detector missing required tensor {name!r}; "
                f"upstream rename or wrong checkpoint?")
        if tuple(tensors[name].shape) != expected_shape:
            raise ValueError(
                f"detector tensor {name} has shape {tensors[name].shape}, "
                f"expected {expected_shape}")


def _sanity_check_recognizer(tensors: dict[str, np.ndarray]) -> None:
    for name, expected_shape in _REC_REQUIRED.items():
        if name not in tensors:
            raise KeyError(
                f"recognizer missing required tensor {name!r}; "
                f"upstream rename or wrong checkpoint?")
        if tuple(tensors[name].shape) != expected_shape:
            raise ValueError(
                f"recognizer tensor {name} has shape {tensors[name].shape}, "
                f"expected {expected_shape}")


def convert(
    *,
    detector_checkpoint: Path | None,
    recognizer_checkpoint: Path | None,
    vocab_path: Path | None,
    output_path: Path,
) -> dict[str, object]:
    """Drive the conversion. Returns a small stats dict."""
    output_path.parent.mkdir(parents=True, exist_ok=True)

    detector_tensors = discover_detector_tensors(detector_checkpoint)
    recognizer_tensors = discover_recognizer_tensors(recognizer_checkpoint)
    vocab = load_vocab(vocab_path)

    # The recognizer's CTC head must have vocab+blank rows.
    head = recognizer_tensors["rec.linear.weight"]
    if head.shape[0] != len(vocab) + 1:
        raise ValueError(
            f"recognizer CTC head has {head.shape[0]} rows but vocab "
            f"has {len(vocab)} symbols (blank not counted); shapes disagree")

    return write_gguf(
        detector_tensors=detector_tensors,
        recognizer_tensors=recognizer_tensors,
        vocab=vocab,
        output_path=output_path,
    )


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    p.add_argument(
        "--detector-checkpoint", type=Path, default=None,
        help="Optional path to a doctr db_resnet50 checkpoint. "
             "If omitted, downloads doctr's pretrained default.",
    )
    p.add_argument(
        "--recognizer-checkpoint", type=Path, default=None,
        help="Optional path to a doctr crnn_vgg16_bn checkpoint. "
             "If omitted, downloads doctr's pretrained default.",
    )
    p.add_argument(
        "--vocab", type=Path, default=None,
        help="Optional vocab file (one symbol per line). "
             "If omitted, uses doctr's crnn_vgg16_bn default vocab.",
    )
    p.add_argument(
        "--output", type=Path, required=True,
        help="Output GGUF path.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    stats = convert(
        detector_checkpoint=args.detector_checkpoint,
        recognizer_checkpoint=args.recognizer_checkpoint,
        vocab_path=args.vocab,
        output_path=args.output,
    )
    print(f"[doctr_to_gguf] wrote {stats['output_path']}")
    print(f"  n_tensors_detector  = {stats['n_tensors_detector']}")
    print(f"  n_tensors_recognizer= {stats['n_tensors_recognizer']}")
    print(f"  vocab_size          = {stats['vocab_size']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
