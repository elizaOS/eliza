"""Emit a Milady-typed GGUF using the milady-ai/llama.cpp fork's converter.

The milady-ai/llama.cpp v0.4.0-milady fork registers the following
non-upstream GGML types:

    - ``Q4_POLAR=47``  PolarQuant 4-bit weight blocks
    - ``QJL1_256=46``  QJL 1-bit JL-projected K-cache blocks
    - ``TBQ4_0=44``    TurboQuant 4-bit V-cache blocks
    - ``TBQ3_0=43``    TurboQuant 3-bit V-cache blocks

Weights live in the GGUF file itself (so the converter is what writes
them); cache types are runtime-only (set via ``llama-server
--cache-type-{k,v}``) so they ride in metadata, not in tensor blocks.

This script is a thin wrapper around the fork's
``convert_hf_to_gguf.py`` that:

  1. Verifies the convert script exists and has Milady type support
     (looks for ``Q4_POLAR`` in the script source — the fork adds it
     to ``GGMLQuantizationType`` directly).
  2. Reads the upstream PolarQuant codes sidecar
     (``polarquant_artifacts.safetensors``) so the converter can pack
     the int8 codes + fp16 norms directly as ``Q4_POLAR`` blocks rather
     than recomputing them.
  3. Reads the QJL config sidecar (``qjl_config.json``) and emits a GGUF
     metadata block recording the K-cache projection geometry the
     runtime needs.
  4. Reads the TurboQuant config sidecar (``turboquant.json``) and emits
     a GGUF metadata block recording the V-cache calibration.

Where the fork's converter natively handles a step, we delegate. Where
it doesn't, this script writes a minimal extension JSON next to the
GGUF describing the unwritten metadata and warns the user. The runtime
loader (``milady-ai/llama.cpp`` ≥ v0.4.0-milady) reads the extension
JSON if the GGUF metadata block is missing — this is the migration shim
described in ``docs/porting/unified-fork-strategy.md`` §H step 8.

This script is **CPU-only safe**. PolarQuant codes are already produced
by ``polarquant_apply.py``, the QJL sidecar is data, and the converter
itself runs in pure Python.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("gguf_milady_apply")


# Source-of-truth slot numbers for the Milady-added GGML types. Mirrors
# packages/app-core/scripts/aosp/compile-libllama.mjs (preamble) and the
# milady-ai/llama.cpp fork's gguf-py/gguf/constants.py.
MILADY_GGML_TYPES = {
    "TBQ3_0": 43,
    "TBQ4_0": 44,
    "QJL1_256": 46,
    "Q4_POLAR": 47,
}


def _load_sidecar(path: Path) -> dict[str, object] | None:
    """Read a JSON sidecar; return None if not present or unparseable."""
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("could not parse sidecar %s: %s", path, exc)
        return None


def _resolve_convert_script(llama_cpp_dir: Path | None) -> Path:
    """Locate ``convert_hf_to_gguf.py`` in the milady fork checkout."""
    if llama_cpp_dir is not None:
        cand = llama_cpp_dir / "convert_hf_to_gguf.py"
        if cand.exists():
            return cand
    env_dir = os.environ.get("LLAMA_CPP_DIR")
    if env_dir:
        cand = Path(env_dir) / "convert_hf_to_gguf.py"
        if cand.exists():
            return cand
    which = shutil.which("convert_hf_to_gguf.py")
    if which:
        return Path(which)
    raise FileNotFoundError(
        "convert_hf_to_gguf.py not found. Pass --llama-cpp-dir <path> or "
        "set LLAMA_CPP_DIR=<path-to-milady-ai/llama.cpp checkout>."
    )


def _convert_script_supports_milady(convert_path: Path) -> bool:
    """Best-effort detection of fork-vs-upstream convert script.

    The fork adds Milady type symbols directly to the GGUF Python
    constants module; the upstream script does not. We grep for
    ``Q4_POLAR`` because it's the most reliably present marker.
    """
    try:
        text = convert_path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return False
    return "Q4_POLAR" in text or "q4_polar" in text


def _build_ext_metadata(
    *,
    base_model: str,
    polar_sidecar: dict[str, object] | None,
    qjl_sidecar: dict[str, object] | None,
    tbq_sidecar: dict[str, object] | None,
) -> dict[str, object]:
    """Compose the extension-JSON metadata block.

    This block lives next to the GGUF as ``<file>.milady.json`` and the
    fork's runtime loader merges it into the model's metadata table at
    load time. Once the fork's converter learns to emit the same fields
    natively, the extension JSON becomes redundant — but until the
    convert script is patched in lock-step with every kernel landing,
    the extension JSON is the only way the runtime sees the QJL
    projection seed and TurboQuant skip-layer set.
    """
    out: dict[str, object] = {
        "schema_version": 1,
        "produced_by": "scripts/quantization/gguf_milady_apply.py",
        "base_model": base_model,
        "ggml_type_slots": MILADY_GGML_TYPES,
    }
    if polar_sidecar is not None:
        out["polarquant"] = {
            "bits": polar_sidecar.get("recipe", {}).get("bits", 4),  # type: ignore[union-attr]
            "block_size": polar_sidecar.get("recipe", {}).get("block_size", 128),  # type: ignore[union-attr]
            "use_qjl": polar_sidecar.get("recipe", {}).get("use_qjl", True),  # type: ignore[union-attr]
            "n_layers_quantized": polar_sidecar.get("n_layers_quantized"),
            "average_block_mse": polar_sidecar.get("average_block_mse"),
        }
    if qjl_sidecar is not None:
        out["qjl"] = {
            "projection_dim_per_head": qjl_sidecar.get("projection_dim_per_head", 256),
            "projection_dim_per_head_initial": qjl_sidecar.get(
                "projection_dim_per_head_initial", 512
            ),
            "initial_layers_count": qjl_sidecar.get("initial_layers_count", 15),
            "outlier_count_general": qjl_sidecar.get("outlier_count_general", 8),
            "outlier_count_initial_layers": qjl_sidecar.get(
                "outlier_count_initial_layers", 8
            ),
            "group_size": qjl_sidecar.get("group_size", 32),
            "buffer_size": qjl_sidecar.get("buffer_size", 128),
            "projection_seed": qjl_sidecar.get("projection_seed", 42),
            "key_bits": qjl_sidecar.get("key_bits", 1),
            "value_bits": qjl_sidecar.get("value_bits", 4),
            "kv_reduction_factor_estimated": qjl_sidecar.get(
                "kv_reduction_factor_estimated"
            ),
        }
    if tbq_sidecar is not None:
        out["turboquant"] = {
            "nbits": tbq_sidecar.get("nbits", 4),
            "residual_length": tbq_sidecar.get("residual_length", 128),
            "base_seed": tbq_sidecar.get("base_seed", 42),
            "skip_layers": tbq_sidecar.get("skip_layers", [0]),
            "norm_threshold": tbq_sidecar.get("norm_threshold", 5.0),
        }
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=(
            "Emit a Milady-typed GGUF (Q4_POLAR weights + sidecar metadata "
            "for QJL1_256 K-cache + TBQ V-cache)."
        ),
    )
    ap.add_argument(
        "--checkpoint",
        type=Path,
        required=True,
        help="HF checkpoint dir (post-PolarQuant; must contain "
             "polarquant_artifacts.safetensors).",
    )
    ap.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Output GGUF file path (e.g. .../qwen3-0.6b-milady-Q4_POLAR.gguf).",
    )
    ap.add_argument(
        "--llama-cpp-dir",
        type=Path,
        default=None,
        help="Path to the milady-ai/llama.cpp v0.4.0-milady checkout.",
    )
    ap.add_argument(
        "--qjl-sidecar",
        type=Path,
        default=None,
        help="Path to qjl_config.json. Defaults to <checkpoint>/qjl_config.json.",
    )
    ap.add_argument(
        "--turboquant-sidecar",
        type=Path,
        default=None,
        help="Path to turboquant.json. Defaults to <checkpoint>/turboquant.json.",
    )
    ap.add_argument(
        "--outtype",
        default="q4_polar",
        choices=["q4_polar", "f16", "bf16", "f32", "auto"],
        help="GGUF tensor type. Default q4_polar (Milady-only).",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the resolved plan without invoking the converter.",
    )
    args = ap.parse_args(argv)

    if not args.checkpoint.exists() or not args.checkpoint.is_dir():
        raise SystemExit(f"--checkpoint must be a directory: {args.checkpoint}")

    polar_sidecar_path = args.checkpoint / "polarquant_config.json"
    qjl_sidecar_path = args.qjl_sidecar or (args.checkpoint / "qjl_config.json")
    tbq_sidecar_path = args.turboquant_sidecar or (
        args.checkpoint / "turboquant.json"
    )

    polar_sidecar = _load_sidecar(polar_sidecar_path)
    qjl_sidecar = _load_sidecar(qjl_sidecar_path)
    tbq_sidecar = _load_sidecar(tbq_sidecar_path)

    if args.outtype == "q4_polar" and polar_sidecar is None:
        log.warning(
            "outtype=q4_polar but %s is missing — falling back to f16",
            polar_sidecar_path,
        )
        args.outtype = "f16"

    convert_path: Path | None
    fork_supports_milady = False
    try:
        convert_path = _resolve_convert_script(args.llama_cpp_dir)
        fork_supports_milady = _convert_script_supports_milady(convert_path)
    except FileNotFoundError as exc:
        log.error("%s", exc)
        if not args.dry_run:
            return 2
        convert_path = None

    if convert_path is not None and not fork_supports_milady:
        log.warning(
            "convert script %s does not advertise Q4_POLAR support; "
            "the converter will likely reject --outtype q4_polar. "
            "Use a milady-ai/llama.cpp v0.4.0-milady checkout.",
            convert_path,
        )

    base_model = args.checkpoint.name
    if polar_sidecar:
        base_model = str(polar_sidecar.get("source_model") or base_model)
    elif qjl_sidecar:
        base_model = str(qjl_sidecar.get("source_model") or base_model)

    ext_metadata = _build_ext_metadata(
        base_model=base_model,
        polar_sidecar=polar_sidecar,
        qjl_sidecar=qjl_sidecar,
        tbq_sidecar=tbq_sidecar,
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    ext_path = args.output.with_suffix(args.output.suffix + ".milady.json")

    if args.dry_run:
        plan = {
            "checkpoint": str(args.checkpoint),
            "output": str(args.output),
            "convert_script": str(convert_path) if convert_path else None,
            "fork_supports_milady": fork_supports_milady,
            "outtype": args.outtype,
            "ext_metadata_path": str(ext_path),
            "ext_metadata": ext_metadata,
        }
        print(json.dumps(plan, indent=2))
        return 0

    ext_path.write_text(json.dumps(ext_metadata, indent=2), encoding="utf-8")
    log.info("wrote extension metadata → %s", ext_path)

    cmd = [
        sys.executable,
        str(convert_path),
        str(args.checkpoint),
        "--outtype",
        args.outtype,
        "--outfile",
        str(args.output),
    ]
    log.info("running converter: %s", " ".join(cmd))
    rc = subprocess.run(cmd, check=False).returncode
    if rc != 0:
        log.error("convert_hf_to_gguf.py exited %d", rc)
        return rc

    log.info("gguf produced: %s (size=%d bytes)", args.output, args.output.stat().st_size)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
