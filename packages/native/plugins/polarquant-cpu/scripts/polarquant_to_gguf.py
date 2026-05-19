#!/usr/bin/env python3
"""Convert a PolarQuant safetensors sidecar into a GGUF file whose
linear-weight tensors are typed Q4_POLAR=45.

Inputs
------
- Base model directory (HF checkpoint): provides architecture metadata
  (`config.json`) and the *shapes* of the linear weight tensors.  We do
  NOT need the model weights themselves; only their shapes are read,
  via the matching `model.safetensors` (or its index).
- PolarQuant sidecar: ``polarquant_artifacts.safetensors`` produced by
  ``packages/training/scripts/quantization/polarquant_apply.py``.  It
  carries int8 codes + fp16 per-block norms + optional 1-bit QJL signs
  for every quantized linear weight.

Output
------
A GGUF file whose Q4_POLAR-typed tensors hold packed ``block_q4_polar``
records (82 bytes per 128-element block: fp16 norm + 64 bytes of 4-bit
codes + 16 bytes of optional 1-bit QJL residual).  Per-tensor the
*element* shape is preserved exactly; only the on-disk byte width
changes.

Type number 45 is claimed but not yet registered in upstream
ggml-common.h -- the first decoder that hits this file must know to
interpret the raw bytes as ``block_q4_polar``.  The integration step
that registers Q4_POLAR=45 in the apothic/llama.cpp-1bit-turboquant
fork is documented in README.md.

Metadata stored in the GGUF header:
- ``polarquant.block_size``      = QK_POLAR (128, locked).
- ``polarquant.bits``            = 4 (locked for this writer).
- ``polarquant.use_qjl``         = 0 / 1 (per file).
- ``polarquant.qjl_seed``        = upstream seed (42).
- ``polarquant.qjl_correction``  = 0.5 (matches polar_quant.py).
- ``polarquant.rotation``        = "wht-128"  (Walsh-Hadamard, n=128).
- ``polarquant.upstream_commit`` = pinned PolarQuant upstream commit.

The decoder is expected to verify these match its compile-time
assumptions and refuse to load otherwise.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from enum import IntEnum
from pathlib import Path

import numpy as np
from safetensors import safe_open

try:
    import gguf  # type: ignore[import-not-found]
except ImportError:
    sys.stderr.write(
        "ERROR: 'gguf' python package is required.  Install with:\n"
        "    pip install gguf  (or `uv pip install gguf` in your venv)\n"
    )
    raise


# Locked block-format constants -- must match include/polarquant/polarquant.h.
QK_POLAR = 128
QJL_RESIDUAL_BYTES = QK_POLAR // 8        # 16
BLOCK_BYTES = 2 + (QK_POLAR // 2) + QJL_RESIDUAL_BYTES   # 82

# Upstream PolarQuant pin (matches polarquant_apply.py).
POLARQUANT_UPSTREAM_COMMIT = "15a12160245d7d3015290c6c5b6dbb7f22094d5e"
POLARQUANT_QJL_SEED = 42
POLARQUANT_QJL_CORRECTION = 0.5


class _Q4PolarType(IntEnum):
    """Custom GGUF type tag.  Value 45 is the on-disk type number we
    will register in ggml-common.h when integrating into the apothic
    llama.cpp fork.  GGUFWriter just packs this through ``struct.pack
    ("I", ...)``, so any IntEnum with the right value works.
    """

    Q4_POLAR = 45


def _fp32_to_fp16_bits(x: np.ndarray) -> np.ndarray:
    """fp32 -> fp16 bits as a uint16 array (no SIMD).  Used for the
    per-block norm.  numpy already implements RNE rounding via
    ``np.float16`` casting, so we just cast and view.
    """
    return x.astype(np.float16).view(np.uint16)


def _pack_block(
    codes: np.ndarray,    # int8, shape (QK_POLAR,), values in [0, 15]
    norm: float,          # fp32 L2 norm
    qjl_bit: int,         # 0 or 1 (sign of the QJL residual projection)
) -> bytes:
    """Build one block_q4_polar record (82 bytes, packed)."""
    if codes.shape != (QK_POLAR,):
        raise ValueError(f"codes shape {codes.shape!r} != ({QK_POLAR},)")

    # fp16 norm, little-endian.
    d_bits = int(_fp32_to_fp16_bits(np.array([norm], dtype=np.float32))[0])
    out = bytearray(BLOCK_BYTES)
    struct.pack_into("<H", out, 0, d_bits)

    # 4-bit codes, two per byte: low nibble even index, high nibble odd.
    nibbles = codes.astype(np.uint8) & 0x0F
    qs_bytes = (nibbles[1::2].astype(np.uint8) << 4) | nibbles[0::2].astype(np.uint8)
    out[2:2 + (QK_POLAR // 2)] = qs_bytes.tobytes()

    # 1-bit QJL residual: bit 0 of qjl[0]; remaining 15 bytes left at
    # zero (forward-compatible header for per-coord bits, see
    # src/polar_quantize_ref.c::quantize_row_q4_polar_ref step 6).
    qjl_off = 2 + (QK_POLAR // 2)
    out[qjl_off] = 1 if qjl_bit else 0

    return bytes(out)


def pack_layer(
    codes: np.ndarray,     # int8, shape (n_elements,), values in [0, 15]
    norms: np.ndarray,     # fp16 viewed as float, shape (n_blocks,)
    qjl: np.ndarray | None,  # uint8, shape (n_blocks,), per-block sign bit
) -> bytes:
    """Concatenate every block's 82-byte record into one bytes blob."""
    if codes.size % QK_POLAR != 0:
        raise ValueError(
            f"layer code count {codes.size} not a multiple of {QK_POLAR}"
        )
    n_blocks = codes.size // QK_POLAR
    if norms.shape != (n_blocks,):
        raise ValueError(
            f"norms shape {norms.shape!r} != ({n_blocks},) for layer with "
            f"{codes.size} codes"
        )
    if qjl is not None and qjl.shape != (n_blocks,):
        raise ValueError(
            f"qjl shape {qjl.shape!r} != ({n_blocks},) for layer with "
            f"{codes.size} codes"
        )

    norms_f = norms.astype(np.float32)
    code_blocks = codes.astype(np.int8).reshape(n_blocks, QK_POLAR)

    parts: list[bytes] = []
    for b in range(n_blocks):
        bit = int(qjl[b]) & 1 if qjl is not None else 0
        parts.append(
            _pack_block(code_blocks[b], float(norms_f[b]), bit)
        )
    return b"".join(parts)


def discover_layer_names(sidecar_path: Path) -> list[str]:
    """Return the unique layer base names present in the sidecar.

    Sidecar tensor keys look like ``model.layers.<i>.<x>.weight.codes``,
    ``....weight.norms``, optionally ``....weight.qjl``.  We strip the
    ``.codes`` / ``.norms`` / ``.qjl`` suffix and dedupe.
    """
    names: set[str] = set()
    with safe_open(str(sidecar_path), framework="numpy") as f:
        for k in f.keys():
            for suf in (".codes", ".norms", ".qjl"):
                if k.endswith(suf):
                    names.add(k[: -len(suf)])
                    break
    return sorted(names)


def load_layer_tensors(
    sidecar_path: Path, layer_name: str
) -> tuple[np.ndarray, np.ndarray, np.ndarray | None]:
    """Pull (codes, norms, qjl) for one layer out of the sidecar."""
    with safe_open(str(sidecar_path), framework="numpy") as f:
        codes = f.get_tensor(f"{layer_name}.codes")
        norms = f.get_tensor(f"{layer_name}.norms")
        try:
            qjl = f.get_tensor(f"{layer_name}.qjl")
        except Exception:
            qjl = None
    return codes, norms, qjl


def get_layer_shape(
    base_model_dir: Path, layer_name: str
) -> tuple[int, ...] | None:
    """Look up the original element shape for a quantized linear from the
    base model's safetensors index.  Returns None if the model dir is
    not a HF safetensors checkpoint.
    """
    index_path = base_model_dir / "model.safetensors.index.json"
    single_path = base_model_dir / "model.safetensors"

    if index_path.exists():
        with index_path.open("r", encoding="utf-8") as f:
            idx = json.load(f)
        weight_map = idx.get("weight_map", {})
        shard = weight_map.get(layer_name)
        if shard is None:
            return None
        with safe_open(str(base_model_dir / shard), framework="numpy") as g:
            t = g.get_tensor(layer_name)
            return tuple(t.shape)

    if single_path.exists():
        with safe_open(str(single_path), framework="numpy") as g:
            try:
                t = g.get_tensor(layer_name)
                return tuple(t.shape)
            except Exception:
                return None
    return None


def convert(
    *,
    sidecar_path: Path,
    base_model_dir: Path,
    output_path: Path,
    use_qjl: bool | None = None,
    arch: str = "polarquant",
) -> dict[str, object]:
    """Drive the conversion.  Returns a small stats dict."""
    if not sidecar_path.exists():
        raise FileNotFoundError(sidecar_path)
    if not base_model_dir.exists():
        raise FileNotFoundError(base_model_dir)

    layer_names = discover_layer_names(sidecar_path)
    if not layer_names:
        raise RuntimeError(
            f"No PolarQuant tensors found in sidecar {sidecar_path}.  "
            "Expected keys ending in .codes / .norms / .qjl."
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    writer = gguf.GGUFWriter(str(output_path), arch)

    writer.add_uint32("polarquant.block_size", QK_POLAR)
    writer.add_uint32("polarquant.bits", 4)
    writer.add_uint32("polarquant.qjl_seed", POLARQUANT_QJL_SEED)
    writer.add_float32("polarquant.qjl_correction", POLARQUANT_QJL_CORRECTION)
    writer.add_string("polarquant.rotation", "wht-128")
    writer.add_string("polarquant.upstream_commit", POLARQUANT_UPSTREAM_COMMIT)

    # First pass: discover whether all layers carry QJL bits, so the
    # file-level use_qjl flag is consistent.
    has_qjl_per_layer: list[bool] = []
    layer_shapes: dict[str, tuple[int, ...]] = {}

    for name in layer_names:
        codes, norms, qjl = load_layer_tensors(sidecar_path, name)
        has_qjl_per_layer.append(qjl is not None)
        shape = get_layer_shape(base_model_dir, name)
        if shape is None:
            n = codes.size
            shape = (n,)
        else:
            n_expected = int(np.prod(shape))
            if n_expected != codes.size:
                raise RuntimeError(
                    f"shape mismatch for {name}: base model says "
                    f"{shape} ({n_expected} elements) but sidecar has "
                    f"{codes.size} codes"
                )
        layer_shapes[name] = shape

    file_use_qjl = (
        use_qjl
        if use_qjl is not None
        else (all(has_qjl_per_layer) and any(has_qjl_per_layer))
    )
    writer.add_uint32("polarquant.use_qjl", 1 if file_use_qjl else 0)

    # Second pass: pack and add each tensor.
    for name in layer_names:
        codes, norms, qjl = load_layer_tensors(sidecar_path, name)
        packed = pack_layer(codes, norms, qjl if file_use_qjl else None)
        shape = layer_shapes[name]

        # Bypass GGUFWriter.add_tensor's auto byte-shape conversion.
        # We tell add_tensor_info the *element* shape directly and
        # provide ``raw_dtype`` so it does not try to infer a dtype
        # from the np.uint8 buffer.
        writer.add_tensor_info(
            name=name,
            tensor_shape=shape,
            tensor_dtype=np.dtype(np.float16),  # placeholder; overridden by raw_dtype
            tensor_nbytes=len(packed),
            raw_dtype=_Q4PolarType.Q4_POLAR,
        )
        # Keep the bytes alongside the tensor info; the writer's
        # write_tensors_to_file path expects each tensor info entry
        # to carry its data on the .tensor attribute.
        writer.tensors[-1][name].tensor = np.frombuffer(packed, dtype=np.uint8)

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()

    return {
        "output": str(output_path),
        "n_layers": len(layer_names),
        "use_qjl": bool(file_use_qjl),
        "type_number": int(_Q4PolarType.Q4_POLAR),
    }


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    p.add_argument(
        "--sidecar", type=Path, required=True,
        help="Path to polarquant_artifacts.safetensors.",
    )
    p.add_argument(
        "--base-model", type=Path, required=True,
        help="Base HF model dir (used for tensor shapes only).",
    )
    p.add_argument(
        "--output", type=Path, required=True, help="Output GGUF path.",
    )
    p.add_argument(
        "--arch", default="polarquant",
        help="Architecture string for the GGUF header.",
    )
    p.add_argument(
        "--use-qjl",
        choices=["auto", "on", "off"],
        default="auto",
        help="Whether to embed the 1-bit residual.  'auto' picks 'on' "
             "when every layer in the sidecar has QJL bits.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    use_qjl: bool | None = (
        None if args.use_qjl == "auto" else (args.use_qjl == "on")
    )
    stats = convert(
        sidecar_path=args.sidecar,
        base_model_dir=args.base_model,
        output_path=args.output,
        use_qjl=use_qjl,
        arch=args.arch,
    )
    print(json.dumps(stats, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
