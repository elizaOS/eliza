"""Apply GGUF K-quant ladder to a Qwen3-ASR checkpoint.

ASR (Qwen3-ASR-{0.6B,1.7B}) is a Qwen3 text body + an audio mmproj
projector head. The llama.cpp fork at
``plugins/plugin-local-inference/native/llama.cpp`` already supports the
Qwen3 family and mmproj sidecars (``LLM_ARCH_QWEN3``, ``LLM_ARCH_QWEN3VL``),
so the entire K-quant ladder (Q3_K_M, Q4_K_M, Q5_K_M, Q6_K, Q8_0) is
available through the same two-stage pipeline as the eliza-1 text LM:

  1. ``convert_hf_to_gguf.py`` — turns HuggingFace safetensors into f16
     GGUF for **both** the text body and the audio mmproj sidecar.
  2. ``llama-quantize`` — quantizes each f16 GGUF to the requested level.

R8 §6.2 / §7.3 sequencing: Q4_K_M is already published upstream by the
ggml-org Qwen3-ASR GGUF repos, so the common case is running this only
for Q3_K_M / Q5_K_M / Q6_K (and optionally Q8_0). Pass ``--quant`` to
pick one; pass ``--quant-ladder`` to emit the full Q3..Q8 set in one
invocation. Output layout matches the publish path that
``stage_eliza1_bundle_assets.py`` already expects::

    asr/eliza-1-asr-<level>.gguf
    asr/eliza-1-asr-mmproj-<level>.gguf

The mmproj projector is **always** quantized at Q8_0 regardless of
``--quant`` because the projector is a small dense head and the runtime
RAM win from sub-Q8 is < 100 MB while ASR WER regresses sharply when the
projection layer is over-quantized (R8 §3.6 + AGENTS.md §1 audio mmproj
note). Passing ``--mmproj-quant`` overrides this default.
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
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from _common import write_sidecar  # noqa: E402

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger("gguf_asr_apply")

# K-quant ladder publishable via llama-quantize.
SUPPORTED_QUANTS = ("Q3_K_M", "Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0")

# Default mmproj quant. Q8_0 is the sweet spot for a dense audio
# projection head: trivial RAM savings vs Q4_K_M (~50 MB) and a measurable
# WER regression when the projector is sub-Q8 (R8 §3.6).
DEFAULT_MMPROJ_QUANT = "Q8_0"

# Repo root — four parents up from this file
# (packages/training/scripts/quantization/).
_REPO_ROOT = _HERE.parents[3]
_FORK_LLAMA_CPP = (
    _REPO_ROOT
    / "plugins"
    / "plugin-local-inference"
    / "native"
    / "llama.cpp"
)

_VENDOR_HINT = (
    "The llama.cpp fork submodule lives at "
    "plugins/plugin-local-inference/native/llama.cpp and is checked out by "
    "the repo bootstrap. If it's missing:\n"
    "  git submodule update --init plugins/plugin-local-inference/native/llama.cpp\n"
    "Then build the llama-quantize + llama-cli + llama-mtmd-cli binaries from "
    "it (one-shot, CPU-only is enough):\n"
    "  cmake -S plugins/plugin-local-inference/native/llama.cpp \\\n"
    "        -B plugins/plugin-local-inference/native/llama.cpp/build \\\n"
    "        -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DGGML_NATIVE=OFF "
    "-DBUILD_SHARED_LIBS=OFF\n"
    "  cmake --build plugins/plugin-local-inference/native/llama.cpp/build "
    "--target llama-quantize llama-cli llama-mtmd-cli -j\"$(nproc)\"\n"
    "Or pass --llama-cpp-dir <path-to-checkout> / set LLAMA_CPP_DIR / put the "
    "binaries on PATH."
)


def _find_convert_script(llama_cpp_dir: Path | None) -> Path:
    """Locate convert_hf_to_gguf.py.

    Resolution order matches gguf-q4_k_m_apply.py: explicit ``--llama-cpp-dir``,
    ``$LLAMA_CPP_DIR``, in-repo fork submodule, then PATH.
    """
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


def _find_llama_binary(
    name: str, llama_cpp_dir: Path | None
) -> Path:
    """Locate an executable from a built llama.cpp checkout.

    The in-repo fork's CMake preset writes binaries under
    ``build/<preset>/bin/`` (e.g. ``build/linux-x64-cpu-fused/bin/llama-cli``)
    rather than the upstream default ``build/bin/``. The resolver checks
    both layouts plus a recursive ``build/**/bin/<name>`` scan so that
    operators don't have to know which preset built which binary.
    """
    candidates: list[Path] = []
    if llama_cpp_dir is not None:
        candidates.extend(
            [
                llama_cpp_dir / "build" / "bin" / name,
                llama_cpp_dir / name,
            ]
        )
    env_dir = os.environ.get("LLAMA_CPP_DIR")
    if env_dir:
        candidates.extend(
            [
                Path(env_dir) / "build" / "bin" / name,
                Path(env_dir) / name,
            ]
        )
    candidates.extend(
        [
            _FORK_LLAMA_CPP / "build" / "bin" / name,
            _FORK_LLAMA_CPP / name,
        ]
    )
    # Scan build/<preset>/bin/<name> for both supplied + in-repo roots.
    scan_roots: list[Path] = [_FORK_LLAMA_CPP / "build"]
    if llama_cpp_dir is not None:
        scan_roots.insert(0, llama_cpp_dir / "build")
    if env_dir:
        scan_roots.insert(0, Path(env_dir) / "build")
    for root in scan_roots:
        if not root.is_dir():
            continue
        for child in sorted(root.iterdir()):
            if not child.is_dir():
                continue
            candidates.append(child / "bin" / name)
    which = shutil.which(name)
    if which:
        candidates.append(Path(which))
    for c in candidates:
        if c.exists() and os.access(c, os.X_OK):
            return c
    raise SystemExit(f"{name} binary not found.\n" + _VENDOR_HINT)


def _find_quantize_binary(llama_cpp_dir: Path | None) -> Path:
    return _find_llama_binary("llama-quantize", llama_cpp_dir)


def _run(cmd: list[str | Path]) -> None:
    str_cmd = [str(x) for x in cmd]
    log.info("run: %s", " ".join(shlex.quote(x) for x in str_cmd))
    subprocess.run(str_cmd, check=True)


def _resolve_quants(args: argparse.Namespace) -> tuple[str, ...]:
    """Pick the quant set to emit. ``--quant-ladder`` wins over ``--quant``."""
    if args.quant_ladder:
        return SUPPORTED_QUANTS
    return (args.quant,)


def _convert_to_f16(
    convert: Path,
    model: str,
    f16_path: Path,
    *,
    mmproj: bool,
) -> None:
    """Run convert_hf_to_gguf.py to produce an f16 GGUF.

    The fork's converter already handles Qwen3-ASR's audio mmproj head when
    the ``--mmproj`` flag is passed; without it the converter emits only
    the text body GGUF. This wrapper runs the converter TWICE per source
    model: once for the text body, once for the mmproj.
    """
    cmd: list[str | Path] = [
        sys.executable,
        convert,
        model,
        "--outtype",
        "f16",
        "--outfile",
        str(f16_path),
    ]
    if mmproj:
        cmd.append("--mmproj")
    _run(cmd)


def _quantize(
    quantize: Path,
    f16_path: Path,
    quant_path: Path,
    level: str,
    *,
    imatrix: Path | None,
) -> None:
    cmd: list[str | Path] = [quantize]
    if imatrix is not None and imatrix.suffix == ".imatrix":
        cmd.extend(["--imatrix", str(imatrix)])
    cmd.extend([str(f16_path), str(quant_path), level])
    _run(cmd)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument(
        "--model",
        required=False,
        default=None,
        help=(
            "HF repo id or local path to a Qwen3-ASR checkpoint, e.g. "
            "Qwen/Qwen3-ASR-0.6B or Qwen/Qwen3-ASR-1.7B. Required unless "
            "--source-gguf is passed (in which case the wrapper skips "
            "convert_hf_to_gguf.py and quantizes the provided GGUF directly)."
        ),
    )
    ap.add_argument(
        "--source-gguf",
        type=Path,
        default=None,
        help=(
            "Path to an upstream f16/bf16 GGUF for the ASR text body (e.g. "
            "ggml-org/Qwen3-ASR-1.7B-GGUF / Qwen3-ASR-1.7B-bf16.gguf). When "
            "set, the wrapper skips convert_hf_to_gguf.py entirely and "
            "quantizes this file at each requested K-quant level."
        ),
    )
    ap.add_argument(
        "--source-mmproj-gguf",
        type=Path,
        default=None,
        help=(
            "Companion f16/bf16 GGUF for the audio mmproj projector. Used "
            "only together with --source-gguf. Required unless --skip-mmproj."
        ),
    )
    ap.add_argument(
        "--mmproj-passthrough",
        type=Path,
        default=None,
        help=(
            "Pre-quantized mmproj GGUF to copy verbatim (skip llama-quantize). "
            "Used when the upstream repo already publishes the mmproj at the "
            "target level, e.g. ggml-org/Qwen3-ASR-1.7B-GGUF ships "
            "`mmproj-Qwen3-ASR-1.7B-Q8_0.gguf`. The audio projector uses the "
            "`clip` architecture which llama-quantize does not currently "
            "support, so passthrough is the supported path."
        ),
    )
    ap.add_argument(
        "--output",
        required=True,
        type=Path,
        help="Output directory. Files written under asr/eliza-1-asr-<level>.gguf.",
    )
    ap.add_argument(
        "--quant",
        choices=SUPPORTED_QUANTS,
        default="Q4_K_M",
        help=(
            "Single K-quant level to emit. Default: Q4_K_M (matches the "
            "upstream ggml-org/Qwen3-ASR-{0.6B,1.7B}-GGUF publish). Use "
            "--quant-ladder to emit every level in one run."
        ),
    )
    ap.add_argument(
        "--quant-ladder",
        action="store_true",
        help=(
            "Emit the full K-quant ladder (Q3_K_M, Q4_K_M, Q5_K_M, Q6_K, "
            "Q8_0) in a single invocation. Overrides --quant."
        ),
    )
    ap.add_argument(
        "--mmproj-quant",
        choices=SUPPORTED_QUANTS,
        default=DEFAULT_MMPROJ_QUANT,
        help=(
            "K-quant level for the audio mmproj projector. Defaults to "
            f"{DEFAULT_MMPROJ_QUANT} because sub-Q8 measurably regresses WER "
            "on a small dense projection head (R8 §3.6 + AGENTS.md §1)."
        ),
    )
    ap.add_argument(
        "--calibration",
        type=Path,
        default=None,
        help=(
            "Optional importance-matrix calibration *.imatrix file. JSONL "
            "calibration prompts are accepted for CLI parity but the wrapper "
            "does NOT compute the imatrix from them (use llama-imatrix "
            "beforehand). At Q3_K_M imatrix is strongly recommended."
        ),
    )
    ap.add_argument(
        "--calibration-samples",
        type=int,
        default=128,
        help="(CLI parity with sibling apply scripts; not used.)",
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
    ap.add_argument(
        "--skip-mmproj",
        action="store_true",
        help=(
            "Skip the audio mmproj conversion. Use only when the source "
            "checkpoint has no audio head (rare — Qwen3-ASR always carries "
            "one)."
        ),
    )
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    use_source_gguf = args.source_gguf is not None
    if not use_source_gguf and args.model is None:
        ap.error("--model is required unless --source-gguf is supplied")
    if (
        use_source_gguf
        and not args.skip_mmproj
        and args.source_mmproj_gguf is None
        and args.mmproj_passthrough is None
    ):
        ap.error(
            "--source-mmproj-gguf or --mmproj-passthrough is required when "
            "--source-gguf is set (or pass --skip-mmproj if the source has "
            "no audio head)"
        )

    if args.dry_run:
        plan = {
            **vars(args),
            "quants": _resolve_quants(args),
            "mmproj_quant": args.mmproj_quant,
            "use_source_gguf": use_source_gguf,
        }
        print(json.dumps(plan, indent=2, default=str))
        return 0

    quantize = _find_quantize_binary(args.llama_cpp_dir)
    convert: Path | None = None
    if not use_source_gguf:
        convert = _find_convert_script(args.llama_cpp_dir)

    args.output.mkdir(parents=True, exist_ok=True)
    asr_dir = args.output / "asr"
    asr_dir.mkdir(parents=True, exist_ok=True)

    # 1) Stage the text body f16/bf16 GGUF (convert or use pre-converted).
    if use_source_gguf:
        assert args.source_gguf is not None
        text_f16 = args.source_gguf
        log.info(
            "step 1/N: using pre-converted ASR text GGUF (%s)", text_f16
        )
    else:
        text_f16 = asr_dir / "eliza-1-asr-F16.gguf"
        log.info(
            "step 1/N: convert ASR text body -> f16 GGUF (%s)", text_f16
        )
        assert convert is not None
        _convert_to_f16(convert, args.model, text_f16, mmproj=False)

    # 2) Stage the mmproj f16/bf16 GGUF (convert or use pre-converted).
    # Skipped entirely when --mmproj-passthrough is set, since the projector
    # is copied verbatim in step 3.
    mmproj_f16: Path | None = None
    if not args.skip_mmproj and args.mmproj_passthrough is None:
        if use_source_gguf:
            mmproj_f16 = args.source_mmproj_gguf
            log.info(
                "step 2/N: using pre-converted ASR mmproj GGUF (%s)",
                mmproj_f16,
            )
        else:
            mmproj_f16 = asr_dir / "eliza-1-asr-mmproj-F16.gguf"
            log.info(
                "step 2/N: convert ASR audio mmproj -> f16 GGUF (%s)",
                mmproj_f16,
            )
            assert convert is not None
            _convert_to_f16(convert, args.model, mmproj_f16, mmproj=True)

    # 3) Quantize at each requested level.
    produced: list[dict[str, object]] = []
    for level in _resolve_quants(args):
        quant_path = asr_dir / f"eliza-1-asr-{level}.gguf"
        log.info("step 3/N: llama-quantize ASR text -> %s (%s)", level, quant_path)
        _quantize(
            quantize,
            text_f16,
            quant_path,
            level,
            imatrix=args.calibration,
        )
        produced.append({"role": "text", "level": level, "path": str(quant_path)})

    if args.mmproj_passthrough is not None:
        mmproj_path = asr_dir / f"eliza-1-asr-mmproj-{args.mmproj_quant}.gguf"
        log.info(
            "step 3/N: copying pre-quantized mmproj -> %s (%s)",
            args.mmproj_quant,
            mmproj_path,
        )
        shutil.copy(args.mmproj_passthrough, mmproj_path)
        produced.append(
            {
                "role": "mmproj",
                "level": args.mmproj_quant,
                "path": str(mmproj_path),
                "passthrough_source": str(args.mmproj_passthrough),
            }
        )
    elif mmproj_f16 is not None:
        mmproj_path = asr_dir / f"eliza-1-asr-mmproj-{args.mmproj_quant}.gguf"
        log.info(
            "step 3/N: llama-quantize ASR mmproj -> %s (%s)",
            args.mmproj_quant,
            mmproj_path,
        )
        _quantize(
            quantize,
            mmproj_f16,
            mmproj_path,
            args.mmproj_quant,
            imatrix=None,
        )
        produced.append(
            {"role": "mmproj", "level": args.mmproj_quant, "path": str(mmproj_path)}
        )

    if not args.keep_f16 and not use_source_gguf:
        log.info("removing intermediate %s", text_f16)
        text_f16.unlink(missing_ok=True)
        if mmproj_f16 is not None:
            log.info("removing intermediate %s", mmproj_f16)
            mmproj_f16.unlink(missing_ok=True)

    sidecar = {
        "method": "gguf_asr_kquant_ladder",
        "tool": (
            "llama.cpp/llama-quantize"
            if use_source_gguf
            else "llama.cpp/convert_hf_to_gguf.py + llama-quantize"
        ),
        "convert_script": None if use_source_gguf else str(convert),
        "quantize_binary": str(quantize),
        "source_model": args.model,
        "source_gguf": str(args.source_gguf) if use_source_gguf else None,
        "source_mmproj_gguf": (
            str(args.source_mmproj_gguf)
            if use_source_gguf and args.source_mmproj_gguf is not None
            else None
        ),
        "text_quants": [p for p in produced if p["role"] == "text"],
        "mmproj_quant": next(
            (p for p in produced if p["role"] == "mmproj"), None
        ),
        "imatrix": str(args.calibration)
        if args.calibration and args.calibration.suffix == ".imatrix"
        else None,
        "notes": (
            "Qwen3-ASR is a Qwen3 text body + audio mmproj head. Both are "
            "supported by the in-repo llama.cpp fork (`LLM_ARCH_QWEN3` + "
            "mmproj sidecar). The text body rides the standard llama.cpp "
            "K-quant ladder; the mmproj projector is held at Q8_0 by "
            "default because sub-Q8 measurably regresses ASR WER on a "
            "small dense projection head (R8 §3.6). When the upstream "
            "ggml-org/Qwen3-ASR-*-GGUF repo already publishes the bf16 GGUF, "
            "--source-gguf bypasses convert_hf_to_gguf.py and quantizes "
            "directly with llama-quantize."
        ),
    }
    sidecar_path = write_sidecar(asr_dir, "gguf_asr.json", sidecar)
    log.info("wrote %s", sidecar_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
