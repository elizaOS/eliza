#!/usr/bin/env python3
"""End-to-end test for polarquant_to_gguf.py.

Builds a synthetic 128 x 128 fp32 "linear" weight, runs the vendored
PolarQuant encoder over it to produce a sidecar, packs the sidecar
into a GGUF via the converter, and reads the GGUF back to verify:

  1. The Q4_POLAR=45 type tag survives the round trip.
  2. The element shape is preserved.
  3. The packed payload bytes are exactly what we get from packing
     the same codes / norms / qjl directly via pack_layer().
  4. The polarquant.* metadata is present and matches the writer's
     compile-time constants.

No real LLM checkpoint is downloaded; the "base model" is a tempdir
with a single-tensor model.safetensors.  This mirrors the way the
real converter resolves shapes without touching CUDA-only weights.
"""

from __future__ import annotations

import shutil
import struct
import sys
import tempfile
from pathlib import Path

import numpy as np
import torch
from safetensors.numpy import save_file as save_safetensors_numpy
from safetensors.torch import save_file as save_safetensors_torch

# Make the converter importable when run directly.
_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))
import polarquant_to_gguf as conv  # noqa: E402

# Make the vendored polarquant python importable too.
_REPO = _HERE.parents[3]  # eliza/
sys.path.insert(
    0,
    str(_REPO / "packages" / "training" / "scripts" / "quantization"),
)
from polarquant.polar_quant import polar_quantize  # noqa: E402

import gguf  # noqa: E402

# gguf.GGUFReader insists on its own enum for tensor types and rejects
# Q4_POLAR=45 with a ValueError on read.  Patch the enum so the
# integration test can round-trip our custom type the same way the
# eventual llama.cpp fork integration will (registering Q4_POLAR=45
# in ggml-common.h).  Done here, not in the converter, because the
# converter writes via _pack("I", ...) which already accepts arbitrary
# ints.
def _patch_gguf_quant_enum() -> None:
    from enum import IntEnum
    QType = gguf.GGMLQuantizationType
    if any(int(m) == 45 for m in QType):
        return
    members = {m.name: int(m) for m in QType}
    members["Q4_POLAR"] = 45
    new_enum = IntEnum("GGMLQuantizationType", members)
    gguf.GGMLQuantizationType = new_enum
    # Patch the reader module too -- it captured the original by name.
    import gguf.gguf_reader as _gr
    _gr.GGMLQuantizationType = new_enum
    # Provide a quant-size entry so the reader's shape inference works.
    # Per-block size: 82 bytes; block element count: 128.
    if hasattr(gguf, "GGML_QUANT_SIZES"):
        sizes = dict(gguf.GGML_QUANT_SIZES)
        sizes[new_enum.Q4_POLAR] = (128, 82)
        gguf.GGML_QUANT_SIZES = sizes
        _gr.GGML_QUANT_SIZES = sizes
        import gguf.constants as _gc
        _gc.GGML_QUANT_SIZES = sizes
        import gguf.quants as _gq
        _gq.GGML_QUANT_SIZES = sizes


_patch_gguf_quant_enum()


def build_synthetic_sidecar(
    workdir: Path, *, layer_name: str = "model.layers.0.mlp.gate_proj.weight"
) -> tuple[Path, Path, np.ndarray]:
    """Synthesize a 128x128 weight, encode via PolarQuant, save sidecar +
    fake base model dir.  Returns (sidecar_path, base_model_dir, weight).
    """
    rng = np.random.default_rng(2026_05_09)
    weight_np = rng.standard_normal((128, 128)).astype(np.float32)
    weight_t = torch.from_numpy(weight_np)

    res = polar_quantize(weight_t, bits=4, block_size=128, use_qjl=True)

    sidecar_dir = workdir / "quantized"
    sidecar_dir.mkdir(parents=True, exist_ok=True)
    sidecar_path = sidecar_dir / "polarquant_artifacts.safetensors"
    sidecar_payload = {
        f"{layer_name}.codes": res.codes.detach().to(torch.int8).cpu().contiguous(),
        f"{layer_name}.norms": res.norms.detach().to(torch.float16).cpu().contiguous(),
    }
    if res.use_qjl and res.qjl_signs is not None:
        sidecar_payload[f"{layer_name}.qjl"] = (
            res.qjl_signs.detach().to(torch.uint8).cpu().contiguous()
        )
    save_safetensors_torch(sidecar_payload, str(sidecar_path))

    base_dir = workdir / "base_model"
    base_dir.mkdir(parents=True, exist_ok=True)
    save_safetensors_numpy(
        {layer_name: weight_np.astype(np.float16)},
        str(base_dir / "model.safetensors"),
    )

    return sidecar_path, base_dir, weight_np


def run_test() -> int:
    failures: list[str] = []

    with tempfile.TemporaryDirectory(prefix="polarquant_conv_test_") as tmp:
        workdir = Path(tmp)
        layer_name = "model.layers.0.mlp.gate_proj.weight"

        sidecar, base_model, weight = build_synthetic_sidecar(
            workdir, layer_name=layer_name
        )
        gguf_path = workdir / "out.gguf"

        # ----- run the converter -----
        stats = conv.convert(
            sidecar_path=sidecar,
            base_model_dir=base_model,
            output_path=gguf_path,
            use_qjl=True,
            arch="polarquant",
        )

        if stats["type_number"] != 45:
            failures.append(f"type_number {stats['type_number']} != 45")
        if stats["n_layers"] != 1:
            failures.append(f"n_layers {stats['n_layers']} != 1")
        if not stats["use_qjl"]:
            failures.append("use_qjl flag did not survive")

        # ----- read the GGUF back -----
        reader = gguf.GGUFReader(str(gguf_path))

        # metadata sanity
        kv = {f.name: f for f in reader.fields.values()}

        def _u32(name: str) -> int:
            f = kv[name]
            return int(f.parts[f.data[0]][0])

        def _f32(name: str) -> float:
            f = kv[name]
            return float(f.parts[f.data[0]][0])

        def _str(name: str) -> str:
            f = kv[name]
            return bytes(f.parts[f.data[0]]).decode("utf-8")

        if _u32("polarquant.block_size") != 128:
            failures.append("polarquant.block_size mismatch")
        if _u32("polarquant.bits") != 4:
            failures.append("polarquant.bits mismatch")
        if _u32("polarquant.use_qjl") != 1:
            failures.append("polarquant.use_qjl mismatch")
        if _u32("polarquant.qjl_seed") != 42:
            failures.append("polarquant.qjl_seed mismatch")
        if abs(_f32("polarquant.qjl_correction") - 0.5) > 1e-6:
            failures.append("polarquant.qjl_correction mismatch")
        if _str("polarquant.rotation") != "wht-128":
            failures.append("polarquant.rotation mismatch")

        # tensor info
        tensors = list(reader.tensors)
        if len(tensors) != 1:
            failures.append(f"tensor count {len(tensors)} != 1")
        else:
            t = tensors[0]
            if t.name != layer_name:
                failures.append(f"tensor name {t.name!r} != {layer_name!r}")
            if int(t.tensor_type) != 45:
                failures.append(f"tensor type {int(t.tensor_type)} != 45")
            shape_tuple = tuple(int(x) for x in t.shape)
            # GGUF stores shape with little-end-axis-first; 128x128 is
            # symmetric so we accept either order without ambiguity.
            if sorted(shape_tuple) != [128, 128]:
                failures.append(f"tensor shape {shape_tuple} not 128x128")

            # ----- payload bit parity -----
            # Re-derive the expected bytes from the same sidecar via
            # pack_layer() and compare to what the GGUF reader exposes.
            codes, norms, qjl = conv.load_layer_tensors(sidecar, layer_name)
            expected = conv.pack_layer(codes, norms, qjl)
            actual = bytes(t.data.tobytes())
            if expected != actual:
                # Report the first divergence point so debugging is
                # easy if the layout ever drifts.
                first = next(
                    (i for i in range(min(len(expected), len(actual)))
                     if expected[i] != actual[i]),
                    -1,
                )
                failures.append(
                    f"payload mismatch: len_expected={len(expected)} "
                    f"len_actual={len(actual)} first_diff_at={first}"
                )

            # ----- spot-check one block by hand -----
            # Block 0 starts at offset 0 in the packed bytes.  d should
            # equal fp16(np.linalg.norm(weight.flatten()[:128])).
            row0 = weight.flatten()[:128]
            expected_d = np.float16(np.linalg.norm(row0))
            d_bits = struct.unpack_from("<H", actual, 0)[0]
            actual_d = np.frombuffer(
                struct.pack("<H", d_bits), dtype=np.float16
            )[0]
            if abs(float(actual_d) - float(expected_d)) > 1e-3:
                failures.append(
                    f"block 0 d-norm: actual={float(actual_d)!r} "
                    f"expected={float(expected_d)!r}"
                )

    if failures:
        for line in failures:
            print(f"FAIL: {line}")
        return 1
    print("[converter] all checks passed:")
    print(f"  type_number = {stats['type_number']}")
    print(f"  n_layers    = {stats['n_layers']}")
    print(f"  use_qjl     = {stats['use_qjl']}")
    print(f"  output      = {stats['output']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(run_test())
