"""Emit a Eliza-typed GGUF using the elizaOS/llama.cpp fork's converter.

The elizaOS/llama.cpp v1.0.0-eliza fork registers the following
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

  1. Verifies the convert script exists and has Eliza type support
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
loader (``elizaOS/llama.cpp`` ≥ v1.0.0-eliza) reads the extension
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
log = logging.getLogger("gguf_eliza1_apply")


# Source-of-truth slot numbers for the Eliza-added GGML types. Mirrors
# packages/app-core/scripts/aosp/compile-libllama.mjs (preamble) and the
# elizaOS/llama.cpp fork's gguf-py/gguf/constants.py.
ELIZA1_GGML_TYPES = {
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
    """Locate ``convert_hf_to_gguf.py`` in the elizaOS/llama.cpp fork checkout.

    Resolution order: --llama-cpp-dir → $LLAMA_CPP_DIR → the in-repo fork
    submodule (``packages/inference/llama.cpp``, the single canonical
    llama.cpp checkout) → the standalone clone at
    ``~/.cache/eliza-dflash/eliza-llama-cpp`` (used when the build scripts'
    ELIZA_DFLASH_LLAMA_CPP_REMOTE/_REF override forces one) → $PATH.
    """
    cands: list[Path] = []
    if llama_cpp_dir is not None:
        cands.append(llama_cpp_dir)
    env_dir = os.environ.get("LLAMA_CPP_DIR")
    if env_dir:
        cands.append(Path(env_dir))
    # packages/inference/llama.cpp is the canonical fork submodule
    # (.gitmodules: url=https://github.com/elizaOS/llama.cpp.git).
    here = Path(__file__).resolve()
    for p in here.parents:
        cand = p / "packages" / "inference" / "llama.cpp"
        if cand.is_dir():
            cands.append(cand)
            break
    cands.append(Path.home() / ".cache" / "eliza-dflash" / "eliza-llama-cpp")
    for c in cands:
        cand = c / "convert_hf_to_gguf.py"
        if cand.exists():
            return cand
    which = shutil.which("convert_hf_to_gguf.py")
    if which:
        return Path(which)
    raise FileNotFoundError(
        "convert_hf_to_gguf.py not found. Pass --llama-cpp-dir <path>, set "
        "LLAMA_CPP_DIR=<elizaOS/llama.cpp checkout>, or run "
        "`git submodule update --init packages/inference/llama.cpp`."
    )


def _convert_script_supports_eliza1(convert_path: Path) -> bool:
    """Best-effort detection of fork-vs-upstream convert script.

    The fork adds Eliza type symbols directly to the GGUF Python
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

    This block lives next to the GGUF as ``<file>.eliza1.json`` and the
    fork's runtime loader merges it into the model's metadata table at
    load time. Once the fork's converter learns to emit the same fields
    natively, the extension JSON becomes redundant — but until the
    convert script is patched in lock-step with every kernel landing,
    the extension JSON is the only way the runtime sees the QJL
    projection seed and TurboQuant skip-layer set.
    """
    out: dict[str, object] = {
        "schema_version": 1,
        "produced_by": "scripts/quantization/gguf_eliza1_apply.py",
        "base_model": base_model,
        "ggml_type_slots": ELIZA1_GGML_TYPES,
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
            "Emit a Eliza-typed GGUF (Q4_POLAR weights + sidecar metadata "
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
        help="Output GGUF file path (e.g. .../qwen3-0.6b-eliza-Q4_POLAR.gguf).",
    )
    ap.add_argument(
        "--llama-cpp-dir",
        type=Path,
        default=None,
        help="Path to the elizaOS/llama.cpp v1.0.0-eliza checkout (defaults to the in-repo submodule packages/inference/llama.cpp).",
    )
    ap.add_argument(
        "--polarquant-sidecar",
        type=Path,
        default=None,
        help="Path to polarquant_config.json. Defaults to "
             "<checkpoint>/polarquant_config.json (pass this when --checkpoint "
             "is a later optimization stage that doesn't carry the polar config).",
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
        choices=["q4_polar", "q8_0", "f16", "bf16", "f32", "auto"],
        help="GGUF tensor type. Default q4_polar (Eliza-only); falls back to "
             "q8_0 automatically when the fork's converter can't emit it yet.",
    )
    # Eliza-1 v1 = the upstream BASE models, GGUF-converted + fully optimized
    # (every quant/kernel trick in inference/AGENTS.md §3), NOT fine-tuned.
    # When `--release-state base-v1` is set, write a `<file>.provenance.json`
    # next to the GGUF recording that the bytes are derived from an upstream
    # base model (not a trained Eliza-1 checkpoint), with `finetuned=false`.
    # The publish path / manifest builder fold this into the bundle's
    # `provenance.sourceModels` block.
    ap.add_argument(
        "--release-state",
        default=None,
        choices=["base-v1", "finetuned-v2"],
        help=(
            "Release lineage of the produced GGUF. `base-v1` records a "
            "<file>.provenance.json with finetuned=false + the upstream "
            "source repo; `finetuned-v2` records finetuned=true."
        ),
    )
    ap.add_argument(
        "--source-repo",
        default=None,
        help=(
            "Upstream HF repo the base weights come from (e.g. "
            "unsloth/Qwen3.5-9B-GGUF). Recorded in the provenance JSON for "
            "--release-state base-v1. Defaults to the source_model field in "
            "the polarquant/qjl sidecar."
        ),
    )
    ap.add_argument(
        "--force",
        action="store_true",
        help=(
            "Re-run the converter even if the output GGUF already exists. "
            "By default the run is idempotent: if --output already exists "
            "the converter is skipped (only the sidecar JSONs are refreshed)."
        ),
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the resolved plan without invoking the converter.",
    )
    args = ap.parse_args(argv)

    if not args.checkpoint.exists() or not args.checkpoint.is_dir():
        raise SystemExit(f"--checkpoint must be a directory: {args.checkpoint}")

    polar_sidecar_path = args.polarquant_sidecar or (args.checkpoint / "polarquant_config.json")
    qjl_sidecar_path = args.qjl_sidecar or (args.checkpoint / "qjl_config.json")
    tbq_sidecar_path = args.turboquant_sidecar or (
        args.checkpoint / "turboquant.json"
    )

    polar_sidecar = _load_sidecar(polar_sidecar_path)
    qjl_sidecar = _load_sidecar(qjl_sidecar_path)
    tbq_sidecar = _load_sidecar(tbq_sidecar_path)

    requested_outtype = args.outtype
    fallback_reason: str | None = None
    if args.outtype == "q4_polar" and polar_sidecar is None:
        fallback_reason = f"polarquant codebook ({polar_sidecar_path}) missing"
        log.warning("outtype=q4_polar but %s — falling back to f16", fallback_reason)
        args.outtype = "f16"

    convert_path: Path | None
    fork_supports_eliza1 = False
    try:
        convert_path = _resolve_convert_script(args.llama_cpp_dir)
        fork_supports_eliza1 = _convert_script_supports_eliza1(convert_path)
    except FileNotFoundError as exc:
        log.error("%s", exc)
        if not args.dry_run:
            return 2
        convert_path = None

    if args.outtype == "q4_polar" and convert_path is not None and not fork_supports_eliza1:
        # The fork's runtime (ggml.h) defines GGML_TYPE_Q4_POLAR, but its
        # convert_hf_to_gguf.py may not yet emit it (the converter-side wiring
        # lags the kernel work). Don't crash — fall back to q8_0 (the best
        # quant the stock converter does support) and record the deferral so
        # the manifest is honest. Re-run when the fork's converter ships
        # --outtype q4_polar.
        fallback_reason = (
            f"{convert_path} does not support --outtype q4_polar yet "
            "(ggml runtime has GGML_TYPE_Q4_POLAR=47 but the converter does not "
            "emit it); using q8_0 — re-run when the fork's converter is updated"
        )
        log.warning("Q4_POLAR conversion unavailable: %s", fallback_reason)
        args.outtype = "q8_0"

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
    ext_metadata["weight_quant"] = {
        "requested": requested_outtype,
        "actual": args.outtype,
        "deferred": requested_outtype != args.outtype,
        "deferral_reason": fallback_reason,
        # PolarQuant codebook is still available as a sidecar even when the GGUF
        # body is q8_0/f16 — the runtime can apply it once the fork's converter
        # (or a runtime-side path) lands.
        "polarquant_artifacts": str(polar_sidecar_path) if polar_sidecar else None,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    ext_path = args.output.with_suffix(args.output.suffix + ".eliza1.json")
    provenance_path = args.output.with_suffix(args.output.suffix + ".provenance.json")

    source_repo = args.source_repo
    if source_repo is None:
        # Fall back to whatever source_model the recipe sidecars recorded.
        for sc in (polar_sidecar, qjl_sidecar, tbq_sidecar):
            if isinstance(sc, dict) and sc.get("source_model"):
                source_repo = str(sc.get("source_model"))
                break
    provenance: dict[str, object] | None = None
    if args.release_state is not None:
        provenance = {
            "schema_version": 1,
            "produced_by": "scripts/quantization/gguf_eliza1_apply.py",
            "releaseState": args.release_state,
            # base-v1 is the upstream base model, GGUF + fully optimized,
            # NOT fine-tuned. finetuned-v2 records the trained checkpoint.
            "finetuned": args.release_state == "finetuned-v2",
            "sourceRepo": source_repo,
            "convertedVia": str(convert_path) if convert_path else None,
            "outtype": args.outtype,
            "ggmlTypeSlots": ELIZA1_GGML_TYPES,
        }

    if args.dry_run:
        plan = {
            "checkpoint": str(args.checkpoint),
            "output": str(args.output),
            "convert_script": str(convert_path) if convert_path else None,
            "fork_supports_eliza1": fork_supports_eliza1,
            "outtype": args.outtype,
            "ext_metadata_path": str(ext_path),
            "ext_metadata": ext_metadata,
            "provenance_path": str(provenance_path) if provenance is not None else None,
            "provenance": provenance,
        }
        print(json.dumps(plan, indent=2))
        return 0

    ext_path.write_text(json.dumps(ext_metadata, indent=2), encoding="utf-8")
    log.info("wrote extension metadata → %s", ext_path)
    if provenance is not None:
        provenance_path.write_text(json.dumps(provenance, indent=2), encoding="utf-8")
        log.info("wrote provenance → %s", provenance_path)

    # Idempotent: if the output GGUF already exists, don't re-run the
    # (expensive, deterministic-for-a-fixed-checkpoint) converter — only the
    # sidecar JSONs are refreshed. --force overrides.
    if args.output.is_file() and not args.force:
        log.info(
            "output GGUF already exists (%d bytes); skipping converter "
            "(pass --force to re-run): %s",
            args.output.stat().st_size,
            args.output,
        )
        return 0

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
