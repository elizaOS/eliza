#!/usr/bin/env python3
"""Convert an audio-side end-of-turn (EOT) detector checkpoint to a
GGUF file the voice-classifier-cpp runtime will load through its ggml
dispatcher.

This converter writes the locked audio-EOT metadata block and packs
encoder/head tensors from PyTorch or safetensors checkpoints. The C
runtime currently validates the GGUF metadata and keeps scoring
fail-closed until an upstream audio-turn graph is selected; preserving
the tensor payload here lets the selected graph land without changing
the file contract again.

Suggested upstreams
-------------------
- `livekit/turn-detector` audio variants (the published HF repo today
  ships text-side variants — see
  `plugins/plugin-local-inference/src/services/voice/eot-classifier.ts`
  for the text-side wiring; this library targets the audio-side
  detector that pairs with them).
- `pipecat-ai/turn` — open-source turn-detection-from-audio model.
- A whisper-derived turn-completion classifier built on top of a
  Distil-Whisper or whisper-small encoder with a sigmoid head.

Inputs
------
- ``--encoder-checkpoint``: path to the upstream audio encoder
  checkpoint (PyTorch / safetensors).
- ``--head-checkpoint``: path to the binary turn-completion head
  (linear → sigmoid). May be the same file as --encoder-checkpoint.

Output
------
A GGUF file with one model bundle plus a small set of metadata keys
the runtime uses to refuse a mismatched build:

- ``voice_eot.variant``         = upstream identifier (locked).
- ``voice_eot.sample_rate``     = 16000 (locked).
- ``voice_eot.n_mels``          = 80   (locked, mel front-end).
- ``voice_eot.n_fft``           = 512  (locked).
- ``voice_eot.hop``             = 160  (locked).
- ``voice_eot.upstream_commit`` = upstream commit supplied at conversion time.

Type number for encoder + head is left as fp16 for the first pass.
"""

from __future__ import annotations

import argparse
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import numpy as np

import gguf


# ── Locked block-format constants ───────────────────────────────────────────
# Mirror the C-side header
# (`include/voice_classifier/voice_classifier.h`). The runtime checks
# each against the GGUF metadata.

VOICE_EOT_VARIANT = "audio-eot-unpinned"
SAMPLE_RATE = 16000
N_MELS = 80
N_FFT = 512
HOP = 160

# Pinned upstream commit. Update when re-pulling weights and re-test
# parity. The runtime reads this key from the GGUF and refuses to load
# an unknown commit.
VOICE_EOT_UPSTREAM_COMMIT = "unselected-upstream"


def _to_numpy(value: object) -> np.ndarray:
    """Convert a tensor-like checkpoint value to a contiguous fp32 ndarray."""
    if hasattr(value, "detach"):
        value = value.detach()
    if hasattr(value, "cpu"):
        value = value.cpu()
    if hasattr(value, "numpy"):
        value = value.numpy()
    arr = np.asarray(value)
    if arr.dtype.kind not in {"f", "i", "u", "b"}:
        raise TypeError(f"unsupported tensor dtype {arr.dtype}")
    return np.ascontiguousarray(arr.astype(np.float32, copy=False))


def _load_checkpoint(path: Path) -> Mapping[str, object]:
    suffix = path.suffix.lower()
    if suffix == ".safetensors":
        from safetensors.numpy import load_file

        return load_file(str(path))

    import torch

    loaded = torch.load(path, map_location="cpu", weights_only=True)
    if isinstance(loaded, Mapping):
        for key in ("state_dict", "model_state_dict", "module"):
            nested = loaded.get(key)
            if isinstance(nested, Mapping):
                return nested
        return loaded
    raise TypeError(f"checkpoint {path} did not contain a tensor mapping")


def _normalize_tensor_name(name: str, *, prefix: str) -> str:
    clean = name
    for candidate in ("module.", "model.", "encoder.", "head."):
        if clean.startswith(candidate):
            clean = clean[len(candidate):]
    clean = clean.replace("/", ".")
    return f"{prefix}.{clean}"


def _discover_tensors(checkpoint_path: Path, *, prefix: str) -> dict[str, np.ndarray]:
    raw = _load_checkpoint(checkpoint_path)
    tensors: dict[str, np.ndarray] = {}
    for name, value in raw.items():
        if not isinstance(name, str):
            continue
        try:
            tensors[_normalize_tensor_name(name, prefix=prefix)] = _to_numpy(value)
        except TypeError:
            continue
    if not tensors:
        raise ValueError(f"checkpoint {checkpoint_path} did not expose numeric tensors")
    return dict(sorted(tensors.items()))


def _infer_head_shape(head_tensors: Mapping[str, np.ndarray]) -> str:
    for name, tensor in head_tensors.items():
        shape = tuple(int(dim) for dim in tensor.shape)
        if shape in {(1,), (1, 1)} or (shape and shape[0] == 1):
            return "sigmoid"
        if shape in {(2,), (2, 1)} or (shape and shape[0] == 2):
            return "softmax2"
        if name.endswith((".bias", ".weight")) and shape and shape[-1] in {1, 2}:
            return "sigmoid" if shape[-1] == 1 else "softmax2"
    raise ValueError(
        "could not infer voice_eot.head_shape from head tensors; "
        "pass --head-shape sigmoid or --head-shape softmax2"
    )


def discover_encoder_tensors(checkpoint_path: Path) -> dict[str, object]:
    """Walk the audio encoder checkpoint and return a {name: tensor}
    map.
    """
    return _discover_tensors(checkpoint_path, prefix="encoder")


def discover_head_tensors(checkpoint_path: Path) -> dict[str, object]:
    """Walk the binary EOT head checkpoint and return a {name: tensor}
    map.
    """
    return _discover_tensors(checkpoint_path, prefix="head")


def write_gguf(
    *,
    encoder_tensors: dict[str, object],
    head_tensors: dict[str, object],
    output_path: Path,
    variant: str = VOICE_EOT_VARIANT,
    upstream_commit: str = VOICE_EOT_UPSTREAM_COMMIT,
    head_shape: str | None = None,
) -> dict[str, object]:
    """Emit the GGUF file.
    """
    typed_encoder = {name: _to_numpy(tensor) for name, tensor in encoder_tensors.items()}
    typed_head = {name: _to_numpy(tensor) for name, tensor in head_tensors.items()}
    resolved_head_shape = head_shape or _infer_head_shape(typed_head)
    if resolved_head_shape not in {"sigmoid", "softmax2"}:
        raise ValueError("head_shape must be 'sigmoid' or 'softmax2'")

    writer = gguf.GGUFWriter(str(output_path), arch="voice_eot")
    writer.add_uint32("voice_eot.sample_rate", SAMPLE_RATE)
    writer.add_uint32("voice_eot.n_mels", N_MELS)
    writer.add_uint32("voice_eot.n_fft", N_FFT)
    writer.add_uint32("voice_eot.hop", HOP)
    writer.add_string("voice_eot.variant", variant)
    writer.add_string("voice_eot.upstream_commit", upstream_commit)
    writer.add_string("voice_eot.head_shape", resolved_head_shape)

    n_params = 0
    for name, tensor in sorted({**typed_encoder, **typed_head}.items()):
        writer.add_tensor(name, tensor, raw_dtype=gguf.GGMLQuantizationType.F32)
        n_params += int(tensor.size)

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()

    return {
        "n_tensors_encoder": len(typed_encoder),
        "n_tensors_head": len(typed_head),
        "n_params": n_params,
        "head_shape": resolved_head_shape,
        "variant": variant,
        "upstream_commit": upstream_commit,
        "output_path": str(output_path),
    }


def convert(
    *,
    encoder_checkpoint: Path,
    head_checkpoint: Path,
    output_path: Path,
    variant: str = VOICE_EOT_VARIANT,
    upstream_commit: str = VOICE_EOT_UPSTREAM_COMMIT,
    head_shape: str | None = None,
) -> dict[str, object]:
    """Drive the conversion. Returns a small stats dict."""
    if not encoder_checkpoint.exists():
        raise FileNotFoundError(encoder_checkpoint)
    if not head_checkpoint.exists():
        raise FileNotFoundError(head_checkpoint)

    output_path.parent.mkdir(parents=True, exist_ok=True)

    encoder_tensors = discover_encoder_tensors(encoder_checkpoint)
    head_tensors = discover_head_tensors(head_checkpoint)

    return write_gguf(
        encoder_tensors=encoder_tensors,
        head_tensors=head_tensors,
        output_path=output_path,
        variant=variant,
        upstream_commit=upstream_commit,
        head_shape=head_shape,
    )


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    p.add_argument(
        "--encoder-checkpoint", type=Path, required=True,
        help="Path to the upstream audio encoder checkpoint.",
    )
    p.add_argument(
        "--head-checkpoint", type=Path, required=True,
        help=(
            "Path to the binary EOT head checkpoint (may be the same "
            "file as --encoder-checkpoint)."
        ),
    )
    p.add_argument(
        "--output", type=Path, required=True,
        help="Output GGUF path.",
    )
    p.add_argument(
        "--variant", default=VOICE_EOT_VARIANT,
        help="Upstream model identifier to write as voice_eot.variant.",
    )
    p.add_argument(
        "--upstream-commit", default=VOICE_EOT_UPSTREAM_COMMIT,
        help="Pinned upstream commit or immutable artifact id.",
    )
    p.add_argument(
        "--head-shape", choices=["sigmoid", "softmax2"],
        help="Decoder shape for the EOT head; inferred when omitted.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    convert(
        encoder_checkpoint=args.encoder_checkpoint,
        head_checkpoint=args.head_checkpoint,
        output_path=args.output,
        variant=args.variant,
        upstream_commit=args.upstream_commit,
        head_shape=args.head_shape,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
