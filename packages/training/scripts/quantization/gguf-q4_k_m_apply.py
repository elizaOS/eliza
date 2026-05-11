"""Apply GGUF Q4_K_M K-quant to a fine-tuned Qwen checkpoint.

Wraps llama.cpp's two-stage GGUF conversion:

  1. ``convert_hf_to_gguf.py`` — turns a HuggingFace safetensors checkpoint
     into a single-file f16 GGUF.
  2. ``llama-quantize`` (the binary built by ``make quantize`` in the
     llama.cpp tree) — quantizes that f16 GGUF down to Q4_K_M (4-bit
     K-quant, mixed precision).

Output is written to ``<output>/eliza-1-<size>-Q4_K_M.gguf``, matching the
sibling K-quant levels (``-Q5_K_M``, ``-Q6_K``) so the publish layer can
upload them to a single ``elizaos/eliza-1-<size>-gguf-q4_k_m`` HF repo.

Both binaries must be on ``PATH`` (or pointed at via ``--llama-cpp-dir``).
If they are missing the script exits 2 with an actionable diagnostic
("install llama.cpp + run `make quantize`" or pip install
``llama-cpp-python``). ``--calibration`` is accepted for CLI parity with
the rest of the quantization scripts and is forwarded to ``llama-quantize``
as an importance matrix when present (significantly improves PPL at low
bit-rates).
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
log = logging.getLogger("gguf_q4_k_m_apply")

# K-quant level produced by this wrapper. Sibling files in the same dir
# (``gguf-q5_k_m_apply.py`` / ``gguf-q6_k_apply.py``) only differ by this
# constant + sidecar metadata; if you add them, mirror the same shape.
QUANT_LEVEL = "Q4_K_M"


# Vendored stock llama.cpp lives here once scripts/vendor_llama_cpp.sh runs.
_VENDOR_LLAMA_CPP = _HERE.parent.parent / "vendor" / "llama.cpp"  # training/vendor/llama.cpp

_VENDOR_HINT = (
    "Run the vendor script first:\n"
    "  bash scripts/vendor_llama_cpp.sh\n"
    "(clones stock ggml-org/llama.cpp into vendor/llama.cpp, builds "
    "llama-quantize, installs the gguf python deps)\n"
    "Or pass --llama-cpp-dir <path-to-checkout> / set LLAMA_CPP_DIR.\n"
    "NOTE: custom GGML types (Q4_POLAR/QJL1_256/TurboQuant) need the "
    "elizaOS/llama.cpp fork — that's a separate track, not this script."
)


def _find_convert_script(llama_cpp_dir: Path | None) -> Path:
    """Locate convert_hf_to_gguf.py.

    Resolution order: ``--llama-cpp-dir`` (explicit), ``$LLAMA_CPP_DIR``
    (env override), the vendored ``vendor/llama.cpp`` checkout (default,
    populated by ``scripts/vendor_llama_cpp.sh``), then a system PATH
    install (e.g. the llama-cpp-python wheel).
    """
    candidates: list[Path] = []
    if llama_cpp_dir is not None:
        candidates.append(llama_cpp_dir / "convert_hf_to_gguf.py")
    env_dir = os.environ.get("LLAMA_CPP_DIR")
    if env_dir:
        candidates.append(Path(env_dir) / "convert_hf_to_gguf.py")
    candidates.append(_VENDOR_LLAMA_CPP / "convert_hf_to_gguf.py")
    which = shutil.which("convert_hf_to_gguf.py")
    if which:
        candidates.append(Path(which))
    for c in candidates:
        if c.exists():
            return c
    raise SystemExit("convert_hf_to_gguf.py not found.\n" + _VENDOR_HINT)


def _find_quantize_binary(llama_cpp_dir: Path | None) -> Path:
    """Locate the ``llama-quantize`` binary.

    Same resolution order as :func:`_find_convert_script`: explicit
    ``--llama-cpp-dir``, ``$LLAMA_CPP_DIR``, the vendored checkout, then
    PATH.
    """
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
            _VENDOR_LLAMA_CPP / "build" / "bin" / "llama-quantize",
            _VENDOR_LLAMA_CPP / "llama-quantize",
        ]
    )
    which = shutil.which("llama-quantize")
    if which:
        candidates.append(Path(which))
    for c in candidates:
        if c.exists() and os.access(c, os.X_OK):
            return c
    raise SystemExit("llama-quantize binary not found.\n" + _VENDOR_HINT)


def _resolve_output_basename(model_id_or_path: str, output_dir: Path) -> str:
    """Pick the gguf filename from the model dir or HF repo id.

    For elizaos/eliza-1-<size> we want the publishable filename
    ``eliza-1-<size>-Q4_K_M.gguf``. Falls back to <last-path-segment>.
    """
    last = model_id_or_path.rstrip("/").split("/")[-1]
    # Strip common LoRA/SFT subdir suffixes so the gguf filename is clean.
    for suffix in ("-final", "/final", "-sft", "-apollo"):
        if last.endswith(suffix):
            last = last[: -len(suffix)]
    return f"{last}-{QUANT_LEVEL}.gguf"


def _run(cmd: list[str | Path]) -> None:
    str_cmd = [str(x) for x in cmd]
    log.info("run: %s", " ".join(shlex.quote(x) for x in str_cmd))
    subprocess.run(str_cmd, check=True)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument(
        "--model",
        required=True,
        help="HF repo id or local path to a HuggingFace causal-LM checkpoint.",
    )
    ap.add_argument("--output", required=True, type=Path)
    ap.add_argument(
        "--calibration",
        type=Path,
        default=None,
        help=(
            "Optional importance-matrix calibration file or JSONL of prompts. "
            "When a *.imatrix file is passed it is forwarded to "
            "llama-quantize via --imatrix. JSONL prompts are accepted for "
            "CLI parity; the wrapper does NOT compute the imatrix from them "
            "(use llama-imatrix beforehand)."
        ),
    )
    ap.add_argument("--calibration-samples", type=int, default=128)
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
        print(json.dumps({**vars(args), "quant_level": QUANT_LEVEL}, indent=2, default=str))
        return 0

    convert = _find_convert_script(args.llama_cpp_dir)
    quantize = _find_quantize_binary(args.llama_cpp_dir)

    args.output.mkdir(parents=True, exist_ok=True)
    basename = _resolve_output_basename(str(args.model), args.output)
    f16_path = args.output / basename.replace(f"-{QUANT_LEVEL}.gguf", "-F16.gguf")
    quant_path = args.output / basename

    log.info("step 1/2: convert HF -> f16 GGUF (%s)", f16_path)
    _run(
        [
            sys.executable,
            convert,
            str(args.model),
            "--outtype",
            "f16",
            "--outfile",
            str(f16_path),
        ]
    )

    log.info("step 2/2: llama-quantize -> %s (%s)", QUANT_LEVEL, quant_path)
    quantize_cmd: list[str | Path] = [quantize]
    if args.calibration is not None and args.calibration.suffix == ".imatrix":
        quantize_cmd.extend(["--imatrix", str(args.calibration)])
    quantize_cmd.extend([str(f16_path), str(quant_path), QUANT_LEVEL])
    _run(quantize_cmd)

    if not args.keep_f16:
        log.info("removing intermediate %s", f16_path)
        f16_path.unlink(missing_ok=True)

    sidecar = {
        "method": f"gguf_{QUANT_LEVEL.lower()}",
        "scheme": QUANT_LEVEL,
        "tool": "llama.cpp/convert_hf_to_gguf.py + llama-quantize",
        "convert_script": str(convert),
        "quantize_binary": str(quantize),
        "source_model": str(args.model),
        "output_file": str(quant_path),
        "imatrix": str(args.calibration)
        if args.calibration and args.calibration.suffix == ".imatrix"
        else None,
        "notes": (
            "Q4_K_M is the standard sweet-spot K-quant for llama.cpp / Ollama "
            "/ LM Studio. ~4.5 bits per weight on average (mixed precision) "
            "with ~0.5 PPL gap to bf16."
        ),
    }
    sidecar_path = write_sidecar(args.output, "gguf_q4_k_m.json", sidecar)
    log.info("wrote %s", sidecar_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
