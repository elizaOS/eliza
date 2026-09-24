#!/usr/bin/env python3
"""Write TurboQuant runtime-cache metadata into a small GGUF file.

TurboQuant in elizaOS is a runtime KV-cache compressor. The model
weights are unchanged by ``packages/training/scripts/quantization/
turboquant_apply.py``; that script writes a ``turboquant.json`` sidecar
recording the cache geometry and calibration values needed at load
time. This tool validates that sidecar and emits the same contract into
GGUF metadata for loaders that want the cache recipe co-located with a
GGUF artifact.

No tensors are written. Tensor-level TBQ packing is handled by the
elizaOS llama.cpp fork when a caller uses TBQ as an actual GGML tensor
type; the standard TurboQuant training recipe only needs metadata.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


GGML_TYPE_TBQ3_0 = 44
GGML_TYPE_TBQ4_0 = 45
GGML_TYPE_TBQ3_TCQ = 48

QK_TBQ = 32
TURBOQUANT_LIBRARY = "turbokv (import: turboquant) v0.1.0"
TURBOQUANT_PRECONDITION = "wht-32+signs"
TURBOQUANT_SIGNS_SEED = "fork-static-32"


class SidecarError(ValueError):
    """Raised when ``turboquant.json`` does not match the runtime contract."""


def _load_sidecar(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(path)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SidecarError(f"{path} is not valid JSON: {exc}") from exc
    if not isinstance(raw, dict):
        raise SidecarError(f"{path} must contain a JSON object")
    return raw


def _as_int(data: dict[str, Any], key: str, *, minimum: int | None = None) -> int:
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise SidecarError(f"{key!r} must be an integer")
    if minimum is not None and value < minimum:
        raise SidecarError(f"{key!r} must be >= {minimum}")
    return value


def _as_optional_int(
    data: dict[str, Any],
    key: str,
    *,
    minimum: int | None = None,
) -> int | None:
    value = data.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise SidecarError(f"{key!r} must be an integer or null")
    if minimum is not None and value < minimum:
        raise SidecarError(f"{key!r} must be >= {minimum}")
    return value


def _as_float(data: dict[str, Any], key: str, *, minimum: float | None = None) -> float:
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SidecarError(f"{key!r} must be a number")
    out = float(value)
    if minimum is not None and out < minimum:
        raise SidecarError(f"{key!r} must be >= {minimum}")
    return out


def _as_int_list(data: dict[str, Any], key: str) -> list[int]:
    value = data.get(key)
    if not isinstance(value, list):
        raise SidecarError(f"{key!r} must be an array of integers")
    out: list[int] = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, int):
            raise SidecarError(f"{key!r} must be an array of integers")
        if item < 0:
            raise SidecarError(f"{key!r} values must be >= 0")
        out.append(item)
    return sorted(set(out))


def validate_sidecar(data: dict[str, Any]) -> dict[str, Any]:
    method = data.get("method")
    if method not in (None, "turboquant"):
        raise SidecarError(f"method must be 'turboquant', got {method!r}")

    nbits = _as_int(data, "nbits", minimum=1)
    if nbits not in (2, 3, 4):
        raise SidecarError("nbits must be one of 2, 3, or 4")

    residual_length = _as_int(data, "residual_length", minimum=1)
    base_seed = _as_int(data, "base_seed")
    skip_layers = _as_int_list(data, "skip_layers")
    head_dim = _as_int(data, "head_dim", minimum=1)
    num_hidden_layers = _as_int(data, "num_hidden_layers", minimum=1)
    context_length = _as_optional_int(data, "context_length", minimum=1)
    norm_threshold = _as_float(data, "norm_threshold", minimum=0.0)
    trellis = bool(data.get("trellis", False))

    cache_type_k = str(
        data.get("cache_type_k")
        or ("turbo3_tcq" if trellis else f"turbo{nbits}_0")
    )
    allowed_cache_types = {"turbo2_0", "turbo3_0", "turbo4_0", "turbo3_tcq"}
    if cache_type_k not in allowed_cache_types:
        raise SidecarError(
            f"cache_type_k must be one of {sorted(allowed_cache_types)}, "
            f"got {cache_type_k!r}"
        )
    if cache_type_k == "turbo3_tcq" and nbits not in (3, 4):
        raise SidecarError("turbo3_tcq cache requires a 3-bit or 4-bit recipe")

    if any(layer >= num_hidden_layers for layer in skip_layers):
        raise SidecarError(
            "skip_layers contains a layer index outside num_hidden_layers"
        )

    return {
        "method": "turboquant",
        "library": str(data.get("library") or TURBOQUANT_LIBRARY),
        "source_model": str(data.get("source_model") or ""),
        "nbits": nbits,
        "residual_length": residual_length,
        "base_seed": base_seed,
        "skip_layers": skip_layers,
        "head_dim": head_dim,
        "num_hidden_layers": num_hidden_layers,
        "trellis": trellis,
        "context_length": context_length,
        "cache_type_k": cache_type_k,
        "calibration_file": data.get("calibration_file"),
        "calibration_samples": int(data.get("calibration_samples") or 0),
        "norm_threshold": norm_threshold,
    }


def build_metadata(sidecar: dict[str, Any]) -> dict[str, Any]:
    recipe = validate_sidecar(sidecar)
    type_slots = {
        "tbq3_0": GGML_TYPE_TBQ3_0,
        "tbq4_0": GGML_TYPE_TBQ4_0,
        "tbq3_tcq": GGML_TYPE_TBQ3_TCQ,
    }
    recipe["ggml_type_slots"] = type_slots
    recipe["block_size"] = QK_TBQ
    recipe["precondition"] = TURBOQUANT_PRECONDITION
    recipe["signs_seed"] = TURBOQUANT_SIGNS_SEED
    return recipe


def write_gguf_metadata(
    *,
    metadata: dict[str, Any],
    output_path: Path,
    arch: str,
) -> dict[str, Any]:
    try:
        import gguf  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError(
            "The 'gguf' Python package is required to write GGUF. Install "
            "it with `pip install gguf`, or use --dry-run to validate only."
        ) from exc

    output_path.parent.mkdir(parents=True, exist_ok=True)
    writer = gguf.GGUFWriter(str(output_path), arch=arch)

    writer.add_string("turboquant.method", metadata["method"])
    writer.add_string("turboquant.library", metadata["library"])
    writer.add_string("turboquant.source_model", metadata["source_model"])
    writer.add_uint32("turboquant.block_size", metadata["block_size"])
    writer.add_uint32("turboquant.bits", metadata["nbits"])
    writer.add_uint32("turboquant.residual_length", metadata["residual_length"])
    writer.add_uint32("turboquant.base_seed", metadata["base_seed"])
    writer.add_uint32("turboquant.head_dim", metadata["head_dim"])
    writer.add_uint32("turboquant.num_hidden_layers", metadata["num_hidden_layers"])
    writer.add_bool("turboquant.trellis", metadata["trellis"])
    if metadata["context_length"] is not None:
        writer.add_uint32("turboquant.context_length", metadata["context_length"])
    writer.add_string("turboquant.cache_type_k", metadata["cache_type_k"])
    writer.add_float32("turboquant.norm_threshold", metadata["norm_threshold"])
    writer.add_string("turboquant.precondition", metadata["precondition"])
    writer.add_string("turboquant.signs_seed", metadata["signs_seed"])
    writer.add_string("turboquant.skip_layers_json", json.dumps(metadata["skip_layers"]))
    writer.add_string(
        "turboquant.ggml_type_slots_json",
        json.dumps(metadata["ggml_type_slots"], sort_keys=True),
    )
    if metadata["calibration_file"]:
        writer.add_string("turboquant.calibration_file", str(metadata["calibration_file"]))
    writer.add_uint32("turboquant.calibration_samples", metadata["calibration_samples"])

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()

    metadata_keys = 17
    if metadata["context_length"] is not None:
        metadata_keys += 1
    if metadata["calibration_file"]:
        metadata_keys += 1

    return {
        "output": str(output_path),
        "metadata_keys": metadata_keys,
        "n_tensors": 0,
    }


def convert(
    *,
    sidecar_path: Path,
    output_path: Path,
    arch: str = "turboquant",
) -> dict[str, Any]:
    metadata = build_metadata(_load_sidecar(sidecar_path))
    stats = write_gguf_metadata(
        metadata=metadata,
        output_path=output_path,
        arch=arch,
    )
    return {**stats, "cache_type_k": metadata["cache_type_k"]}


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument(
        "--sidecar",
        required=True,
        type=Path,
        help="Path to turboquant.json produced by turboquant_apply.py.",
    )
    parser.add_argument(
        "--output",
        required=True,
        type=Path,
        help="Output metadata-only GGUF path.",
    )
    parser.add_argument(
        "--arch",
        default="turboquant",
        help="Architecture string for the GGUF header.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate the sidecar and print the metadata without writing GGUF.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    metadata = build_metadata(_load_sidecar(args.sidecar))
    if args.dry_run:
        print(json.dumps(metadata, indent=2, sort_keys=True))
        return 0
    stats = write_gguf_metadata(
        metadata=metadata,
        output_path=args.output,
        arch=args.arch,
    )
    print(json.dumps({**stats, "cache_type_k": metadata["cache_type_k"]}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FileNotFoundError, SidecarError, RuntimeError) as exc:
        sys.stderr.write(f"ERROR: {exc}\n")
        raise SystemExit(2)
