"""Apply GGUF K-quant ladder to a Kokoro-82M TTS checkpoint.

Kokoro-82M (hexgrad/Kokoro-82M) is a StyleTTS-2 / iSTFTNet TTS model whose
language-model backbone is a 12-layer causal transformer. The Eliza-1 fork of
llama.cpp registers it as ``LLM_ARCH_KOKORO`` (R8 §3.1, W3-1 close-out) so
``llama-quantize`` can run the standard K-quant ladder over a converted GGUF.

Current status (W3-1 close-out):
    - ``LLM_ARCH_KOKORO`` is registered in ``llama-arch.h/.cpp`` and has a
      stub model class in ``models/kokoro.cpp``.
    - A Kokoro GGUF does not yet exist. The canonical runtime artifact is
      ``kokoro/model_q4.onnx`` (ONNX path).
    - This script is the K-quant publish pipeline entry point for when a
      Kokoro GGUF *does* exist. It follows the same two-stage pattern as
      ``gguf_asr_apply.py``:
          1. ``convert_hf_to_gguf.py`` → f16 GGUF of the Kokoro LM weights.
          2. ``llama-quantize`` → Q3_K_M / Q4_K_M / Q5_K_M / Q6_K ladder.

Usage (run after a Kokoro GGUF is published):

    python gguf_kokoro_apply.py \\
        --model hexgrad/Kokoro-82M \\
        --output ./quantized/kokoro \\
        --quant-ladder

    # Single level:
    python gguf_kokoro_apply.py \\
        --model ./kokoro-82m-f16.gguf \\
        --output ./quantized \\
        --quant Q4_K_M

Output files::

    kokoro-82m-Q4_K_M.gguf
    kokoro-82m-Q5_K_M.gguf
    …

These land in ``tts/kokoro/`` inside the Eliza-1 bundle via
``stage_eliza1_bundle_assets.py``.
"""

from __future__ import annotations

import argparse
import logging
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_FORK_LLAMA_CPP = (
    _HERE.parent.parent.parent / "plugins" / "plugin-local-inference" / "native" / "llama.cpp"
)
_VENDOR_HINT = (
    "Build the Eliza-1 llama.cpp fork first:\n"
    "  cd plugins/plugin-local-inference && bun run build:native\n"
    "Or set LLAMA_CPP_DIR to the fork root."
)

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger("gguf_kokoro_apply")

# K-quant ladder for the Kokoro-82M LM weights.
# Q4_K_M is the default for on-device deploy; Q3_K_M for aggressive
# memory constraints; Q5_K_M / Q6_K for quality-priority modes.
SUPPORTED_QUANTS = ("Q3_K_M", "Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0")
DEFAULT_QUANT = "Q4_K_M"


def _find_quantize_binary(llama_cpp_dir: Path | None) -> Path:
    candidates: list[Path] = []
    if llama_cpp_dir is not None:
        candidates.extend([
            llama_cpp_dir / "build" / "bin" / "llama-quantize",
            llama_cpp_dir / "llama-quantize",
        ])
    env_dir = os.environ.get("LLAMA_CPP_DIR")
    if env_dir:
        candidates.extend([
            Path(env_dir) / "build" / "bin" / "llama-quantize",
            Path(env_dir) / "llama-quantize",
        ])
    candidates.extend([
        _FORK_LLAMA_CPP / "build" / "bin" / "llama-quantize",
        _FORK_LLAMA_CPP / "llama-quantize",
    ])
    which = shutil.which("llama-quantize")
    if which:
        candidates.append(Path(which))
    for c in candidates:
        if c.exists() and os.access(c, os.X_OK):
            return c
    raise SystemExit("llama-quantize binary not found.\n" + _VENDOR_HINT)


def _find_convert_script(llama_cpp_dir: Path | None) -> Path:
    candidates: list[Path] = []
    if llama_cpp_dir is not None:
        candidates.append(llama_cpp_dir / "convert_hf_to_gguf.py")
    env_dir = os.environ.get("LLAMA_CPP_DIR")
    if env_dir:
        candidates.append(Path(env_dir) / "convert_hf_to_gguf.py")
    candidates.append(_FORK_LLAMA_CPP / "convert_hf_to_gguf.py")
    for c in candidates:
        if c.exists():
            return c
    raise SystemExit("convert_hf_to_gguf.py not found.\n" + _VENDOR_HINT)


def _run(cmd: list[str | Path]) -> None:
    str_cmd = [str(x) for x in cmd]
    log.info("run: %s", " ".join(shlex.quote(x) for x in str_cmd))
    subprocess.run(str_cmd, check=True)


def _resolve_quants(args: argparse.Namespace) -> tuple[str, ...]:
    if args.quant_ladder:
        return SUPPORTED_QUANTS
    return (args.quant,)


def _convert_to_f16(convert: Path, model: str, f16_path: Path) -> None:
    """Run convert_hf_to_gguf.py → f16 GGUF of the Kokoro LM backbone."""
    _run([
        sys.executable,
        convert,
        model,
        "--outfile",
        f16_path,
        "--outtype",
        "f16",
    ])


def _quantize(
    quantize: Path,
    f16_path: Path,
    out_dir: Path,
    stem: str,
    quant: str,
    *,
    dry_run: bool,
) -> Path:
    out_path = out_dir / f"{stem}-{quant}.gguf"
    if dry_run:
        log.info("[dry-run] would quantize %s → %s", f16_path, out_path)
        return out_path
    _run([quantize, f16_path, out_path, quant])
    return out_path


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True,
                    help="HuggingFace repo id (e.g. hexgrad/Kokoro-82M) or path to an f16 GGUF")
    ap.add_argument("--output", required=True, type=Path,
                    help="Output directory for quantized GGUFs")
    ap.add_argument("--quant", default=DEFAULT_QUANT, choices=SUPPORTED_QUANTS,
                    help=f"Single quant level (default: {DEFAULT_QUANT})")
    ap.add_argument("--quant-ladder", action="store_true",
                    help="Emit the full K-quant ladder: " + " ".join(SUPPORTED_QUANTS))
    ap.add_argument("--llama-cpp-dir", type=Path, default=None,
                    help="Path to the llama.cpp fork root (overrides LLAMA_CPP_DIR env)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print commands without executing them")
    ap.add_argument("--skip-convert", action="store_true",
                    help="Skip HF→f16 GGUF conversion; treat --model as an existing f16 GGUF")
    args = ap.parse_args()

    out_dir = args.output
    out_dir.mkdir(parents=True, exist_ok=True)

    quantize = _find_quantize_binary(args.llama_cpp_dir)
    quants = _resolve_quants(args)

    if args.skip_convert:
        f16_path = Path(args.model)
        if not f16_path.exists():
            ap.error(f"--skip-convert specified but GGUF not found: {f16_path}")
    else:
        convert = _find_convert_script(args.llama_cpp_dir)
        stem = Path(args.model).name if Path(args.model).exists() else "kokoro-82m"
        f16_path = out_dir / f"{stem}-f16.gguf"
        if args.dry_run:
            log.info("[dry-run] would convert %s → %s", args.model, f16_path)
        else:
            _convert_to_f16(convert, args.model, f16_path)

    stem = f16_path.stem.replace("-f16", "")
    for quant in quants:
        out = _quantize(quantize, f16_path, out_dir, stem, quant, dry_run=args.dry_run)
        log.info("quantized level=%s → %s", quant, out)

    log.info("done. Output in %s", out_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
