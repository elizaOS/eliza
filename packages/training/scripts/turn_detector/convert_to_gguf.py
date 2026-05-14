#!/usr/bin/env python3
"""Convert a turn-detector checkpoint to GGUF via the in-repo llama.cpp fork.

The two ship targets for the semantic end-of-turn detector are:

  - ``livekit/turn-detector`` — SmolLM2-135M distill (EN) at revision
    ``v1.2.2-en`` for the 0_8b / 2b tiers; pruned Qwen2.5-0.5B at
    ``v0.4.1-intl`` for ≥4b tiers.
  - ``latishab/turnsense`` — Apache-2.0 fallback (binary classifier on a
    SmolLM2-135M head).

R8 §3.2 / §6.5 / §7.4: all three candidates are Llama-shaped (SmolLM2 is
a LLaMA-2-style arch by Hugging Face's classification) or qwen2-shaped
(pruned Qwen2.5), and the in-repo llama.cpp fork at
``packages/inference/llama.cpp`` already supports both via
``LLM_ARCH_LLAMA`` and ``LLM_ARCH_QWEN2``. ``convert_hf_to_gguf.py``
handles the LM body conversion natively; the sequence-classification head
is exposed through the standard ``forward()`` path so the runtime reads
``[CLS]`` / last-token logits via ``llama-cli --pooling none``.

Pipeline:

  1. ``convert_hf_to_gguf.py`` — turns the HF checkpoint into f16 GGUF.
  2. ``llama-quantize`` — emits the K-quant ladder (Q3_K_M, Q4_K_M,
     Q5_K_M, Q6_K, Q8_0). Default is Q4_K_M to match the LM publish
     story; the EOT classifier is tiny enough that Q6_K is also
     reasonable for the desktop tiers.

Output layout matches what the runtime resolver (``eot-classifier.ts``,
``turnDetectorRevisionForTier``) and the bundle stager
(``stage_eliza1_bundle_assets.py``) expect once the GGUF lineage lands::

    turn/<repo-basename>-<level>.gguf

Until I1 wires the GGUF lineage into the bundle layout, the runtime
falls back to the ONNX export at ``turn/onnx/model_q8.onnx`` (which is
the path the upstream LiveKit / turnsense repos ship).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
# packages/training/scripts/turn_detector/ -> repo root is four parents up.
_REPO_ROOT = _HERE.parents[3]
_QUANT_DIR = _REPO_ROOT / "packages" / "training" / "scripts" / "quantization"

if str(_QUANT_DIR) not in sys.path:
    sys.path.insert(0, str(_QUANT_DIR))

# Reuse the same write_sidecar helper as the LM K-quant siblings so the
# manifest pipeline can parse turn-detector sidecars identically.
from _common import write_sidecar  # noqa: E402

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger("turn_detector_convert_to_gguf")

# K-quant ladder publishable via llama-quantize.
SUPPORTED_QUANTS = ("Q3_K_M", "Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0")

# Default — matches the LM publish baseline. Override with --quant or
# --quant-ladder.
DEFAULT_QUANT = "Q4_K_M"

# In-repo llama.cpp fork submodule. Same path the K-quant LM siblings use.
_FORK_LLAMA_CPP = _REPO_ROOT / "packages" / "inference" / "llama.cpp"

_VENDOR_HINT = (
    "The llama.cpp fork submodule should already be checked out by `bun "
    "install` (scripts/ensure-llama-cpp-submodule.mjs). If it's missing:\n"
    "  git submodule update --init packages/inference/llama.cpp\n"
    "Then build the llama-quantize binary from it:\n"
    "  cmake -S packages/inference/llama.cpp -B packages/inference/llama.cpp/build \\\n"
    "        -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DGGML_NATIVE=OFF "
    "-DBUILD_SHARED_LIBS=OFF\n"
    "  cmake --build packages/inference/llama.cpp/build --target llama-quantize "
    "-j\"$(nproc)\""
)


def _find_convert_script(llama_cpp_dir: Path | None) -> Path:
    candidates: list[Path] = []
    if llama_cpp_dir is not None:
        candidates.append(llama_cpp_dir / "convert_hf_to_gguf.py")
    env_dir = os.environ.get("LLAMA_CPP_DIR")
    if env_dir:
        candidates.append(Path(env_dir) / "convert_hf_to_gguf.py")
    candidates.append(_FORK_LLAMA_CPP / "convert_hf_to_gguf.py")
    which = shutil.which("convert_hf_to_gguf.py")
    if which:
        candidates.append(Path(which))
    for c in candidates:
        if c.exists():
            return c
    raise SystemExit("convert_hf_to_gguf.py not found.\n" + _VENDOR_HINT)


def _find_quantize_binary(llama_cpp_dir: Path | None) -> Path:
    candidates: list[Path] = []
    if llama_cpp_dir is not None:
        candidates.extend(
            [
                llama_cpp_dir / "build" / "bin" / "llama-quantize",
                llama_cpp_dir / "llama-quantize",
            ]
        )
    env_dir = os.environ.get("LLAMA_CPP_DIR")
    if env_dir:
        candidates.extend(
            [
                Path(env_dir) / "build" / "bin" / "llama-quantize",
                Path(env_dir) / "llama-quantize",
            ]
        )
    candidates.extend(
        [
            _FORK_LLAMA_CPP / "build" / "bin" / "llama-quantize",
            _FORK_LLAMA_CPP / "llama-quantize",
        ]
    )
    which = shutil.which("llama-quantize")
    if which:
        candidates.append(Path(which))
    for c in candidates:
        if c.exists() and os.access(c, os.X_OK):
            return c
    raise SystemExit("llama-quantize binary not found.\n" + _VENDOR_HINT)


def _run(cmd: list[str | Path]) -> None:
    str_cmd = [str(x) for x in cmd]
    log.info("run: %s", " ".join(shlex.quote(x) for x in str_cmd))
    subprocess.run(str_cmd, check=True)


def _basename_for(model_id_or_path: str) -> str:
    """Pick the GGUF filename stem from the HF repo id or local path.

    ``livekit/turn-detector`` -> ``turn-detector``;
    ``latishab/turnsense``    -> ``turnsense``;
    ``/path/to/sft-out``      -> ``sft-out``.
    """
    last = model_id_or_path.rstrip("/").split("/")[-1]
    for suffix in ("-final", "/final", "-sft", "-apollo"):
        if last.endswith(suffix):
            last = last[: -len(suffix)]
    return last


def _resolve_quants(args: argparse.Namespace) -> tuple[str, ...]:
    if args.quant_ladder:
        return SUPPORTED_QUANTS
    return (args.quant,)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument(
        "--model",
        required=True,
        help=(
            "HF repo id or local path to a turn-detector checkpoint, e.g. "
            "livekit/turn-detector, latishab/turnsense, or a local "
            "fine-tuned SFT directory."
        ),
    )
    ap.add_argument(
        "--revision",
        default=None,
        help=(
            "Optional HF revision (e.g. v1.2.2-en for the EN SmolLM2 "
            "distill, v0.4.1-intl for the multilingual pruned Qwen2.5). "
            "Ignored when --model is a local path."
        ),
    )
    ap.add_argument(
        "--output",
        required=True,
        type=Path,
        help=(
            "Output directory. Files written under turn/<basename>-<level>.gguf."
        ),
    )
    ap.add_argument(
        "--quant",
        choices=SUPPORTED_QUANTS,
        default=DEFAULT_QUANT,
        help=(
            "Single K-quant level. Default Q4_K_M matches the LM publish "
            "baseline. Q6_K is also reasonable for the desktop tiers — the "
            "turn-detector classifier is small enough that the size delta "
            "is < 100 MB."
        ),
    )
    ap.add_argument(
        "--quant-ladder",
        action="store_true",
        help="Emit the full Q3..Q8 ladder. Overrides --quant.",
    )
    ap.add_argument(
        "--llama-cpp-dir",
        type=Path,
        default=None,
        help="Path to a llama.cpp checkout (overrides PATH lookup).",
    )
    ap.add_argument(
        "--keep-f16",
        action="store_true",
        help="Keep the intermediate f16 GGUF in --output (default: delete it).",
    )
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    if args.dry_run:
        plan = {
            **vars(args),
            "quants": _resolve_quants(args),
            "basename": _basename_for(args.model),
        }
        print(json.dumps(plan, indent=2, default=str))
        return 0

    convert = _find_convert_script(args.llama_cpp_dir)
    quantize = _find_quantize_binary(args.llama_cpp_dir)

    turn_dir = args.output / "turn"
    turn_dir.mkdir(parents=True, exist_ok=True)
    basename = _basename_for(args.model)
    f16_path = turn_dir / f"{basename}-F16.gguf"

    # Step 1: HF -> f16 GGUF. convert_hf_to_gguf.py picks up the arch from
    # the HF config (`model_type`); both SmolLM2 (llama) and pruned Qwen2.5
    # (qwen2) are handled natively by the fork.
    model_for_convert: str | Path = args.model
    if args.revision:
        # The converter takes the source as a HF repo id with no revision
        # selector; revisions are passed as env vars (`HF_HUB_OFFLINE`) or
        # via a pre-resolved local path. For non-default revisions we
        # require the caller to materialize the snapshot locally via
        # `huggingface_hub.snapshot_download(repo_id, revision=...)` and
        # pass the resulting path as --model.
        log.warning(
            "--revision is informational only here. To pin a revision, "
            "snapshot-download the repo at that revision locally and pass "
            "the resulting path as --model. Continuing with --model=%s.",
            args.model,
        )
        model_for_convert = args.model

    log.info("step 1/2: convert HF -> f16 GGUF (%s)", f16_path)
    _run(
        [
            sys.executable,
            convert,
            str(model_for_convert),
            "--outtype",
            "f16",
            "--outfile",
            str(f16_path),
        ]
    )

    # Step 2: llama-quantize per requested level.
    produced: list[dict[str, object]] = []
    for level in _resolve_quants(args):
        quant_path = turn_dir / f"{basename}-{level}.gguf"
        log.info("step 2/2: llama-quantize -> %s (%s)", level, quant_path)
        _run([quantize, str(f16_path), str(quant_path), level])
        produced.append({"level": level, "path": str(quant_path)})

    if not args.keep_f16:
        log.info("removing intermediate %s", f16_path)
        f16_path.unlink(missing_ok=True)

    sidecar = {
        "method": "gguf_turn_detector_kquant",
        "tool": "llama.cpp/convert_hf_to_gguf.py + llama-quantize",
        "convert_script": str(convert),
        "quantize_binary": str(quantize),
        "source_model": args.model,
        "source_revision": args.revision,
        "quants": produced,
        "notes": (
            "Turn-detector GGUF conversion via the in-repo llama.cpp fork. "
            "Supports the LiveKit Turn Detector lineage (SmolLM2-135M @ "
            "v1.2.2-en for 0_8b/2b tiers; pruned Qwen2.5-0.5B @ v0.4.1-intl "
            "for >=4b tiers) and the Apache-2.0 latishab/turnsense fallback. "
            "Both lineages are Llama-shaped or qwen2-shaped and ride the "
            "fork's existing LM arch tags without any new ops."
        ),
    }
    sidecar_path = write_sidecar(turn_dir, "gguf_turn_detector.json", sidecar)
    log.info("wrote %s", sidecar_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
