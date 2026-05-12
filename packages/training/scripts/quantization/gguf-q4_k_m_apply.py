"""Apply GGUF Q4_K_M K-quant to a fine-tuned Qwen checkpoint.

Wraps llama.cpp's two-stage GGUF conversion:

  1. ``convert_hf_to_gguf.py`` — turns a HuggingFace safetensors checkpoint
     into a single-file f16 GGUF.
  2. ``llama-quantize`` — quantizes that f16 GGUF down to Q4_K_M (4-bit
     K-quant, mixed precision).

Output is written to ``<output>/eliza-1-<size>-Q4_K_M.gguf``, matching the
sibling K-quant levels (``-Q5_K_M``, ``-Q6_K``) so the publish layer can
upload them to a single ``elizaos/eliza-1-<size>-gguf-q4_k_m`` HF repo.

The converter + binary come from the in-repo llama.cpp fork submodule at
``packages/inference/llama.cpp`` — the single canonical llama.cpp checkout
for the whole repo. ``convert_hf_to_gguf.py`` is the fork's own script
(the fork is itself a llama.cpp fork, so it carries all the standard
tooling). ``llama-quantize`` is built from that submodule with a one-shot
CPU-only cmake build (see ``_VENDOR_HINT``). Resolution falls back to
``--llama-cpp-dir`` / ``$LLAMA_CPP_DIR`` / ``PATH`` if the submodule build
isn't present. If nothing resolves the script exits 2 with an actionable
diagnostic. ``--calibration`` is accepted for CLI parity with the rest of
the quantization scripts and is forwarded to ``llama-quantize`` as an
importance matrix when present (significantly improves PPL at low
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


# The in-repo llama.cpp fork submodule — the single canonical llama.cpp
# checkout for the whole repo (.gitmodules: packages/inference/llama.cpp,
# url=https://github.com/elizaOS/llama.cpp.git). `bun install` inits it via
# scripts/ensure-llama-cpp-submodule.mjs. From this file
# (packages/training/scripts/quantization/) the repo root is four parents up.
_REPO_ROOT = _HERE.parents[3]
_FORK_LLAMA_CPP = _REPO_ROOT / "packages" / "inference" / "llama.cpp"

_VENDOR_HINT = (
    "The llama.cpp fork submodule should already be checked out by `bun "
    "install` (scripts/ensure-llama-cpp-submodule.mjs). If it's missing:\n"
    "  git submodule update --init packages/inference/llama.cpp\n"
    "Then build the llama-quantize + llama-cli binaries from it (one-shot, "
    "CPU-only is enough):\n"
    "  cmake -S packages/inference/llama.cpp -B packages/inference/llama.cpp/build \\\n"
    "        -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DGGML_NATIVE=OFF "
    "-DBUILD_SHARED_LIBS=OFF\n"
    "  cmake --build packages/inference/llama.cpp/build --target llama-quantize "
    "llama-cli -j\"$(nproc)\"\n"
    "Or pass --llama-cpp-dir <path-to-checkout> / set LLAMA_CPP_DIR / put the "
    "binaries on PATH.\n"
    "(convert_hf_to_gguf.py needs the `gguf` + `mistral_common` python deps; "
    "`uv pip install -r packages/inference/llama.cpp/requirements/"
    "requirements-convert_hf_to_gguf.txt`.)"
)


def _find_convert_script(llama_cpp_dir: Path | None) -> Path:
    """Locate convert_hf_to_gguf.py.

    Resolution order: ``--llama-cpp-dir`` (explicit), ``$LLAMA_CPP_DIR``
    (env override), the in-repo llama.cpp fork submodule
    (``packages/inference/llama.cpp``, the canonical checkout), then a
    system PATH install (e.g. the llama-cpp-python wheel).
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


def _find_quantize_binary(llama_cpp_dir: Path | None) -> Path:
    """Locate the ``llama-quantize`` binary.

    Same resolution order as :func:`_find_convert_script`: explicit
    ``--llama-cpp-dir``, ``$LLAMA_CPP_DIR``, the in-repo fork submodule's
    ``build/bin`` (a one-shot CPU cmake build — see :data:`_VENDOR_HINT`),
    then PATH.
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
    ap.add_argument(
        "--no-smoke-load",
        dest="smoke_load",
        action="store_false",
        help="Skip the post-quantize llama-cli load-smoke (default: run it — "
             "load the produced GGUF and generate a few tokens to confirm the "
             "quantized weights are valid).",
    )
    ap.set_defaults(smoke_load=True)
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

    smoke: dict[str, object] | None = None
    if args.smoke_load:
        smoke = _smoke_load_gguf(quant_path, quantize)
        if smoke.get("ok"):
            log.info("load-smoke OK: %r", smoke.get("output", "")[:80])
        else:
            log.warning("load-smoke FAILED: %s", smoke.get("error"))

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
        "smoke_load": smoke,
        "notes": (
            "Q4_K_M is the standard sweet-spot K-quant for llama.cpp / Ollama "
            "/ LM Studio. ~4.5 bits per weight on average (mixed precision) "
            "with ~0.5 PPL gap to bf16."
        ),
    }
    sidecar_path = write_sidecar(args.output, "gguf_q4_k_m.json", sidecar)
    log.info("wrote %s", sidecar_path)
    return 0


def _smoke_load_gguf(gguf_path: Path, quantize_bin: Path) -> dict[str, object]:
    """Load the produced GGUF in llama-cli and generate a few tokens. Returns
    {ok, output, error}. Best-effort — a missing llama-cli is reported, not
    fatal (the quantize step already validated the GGUF structure)."""
    cli = quantize_bin.parent / "llama-cli"
    if not cli.exists():
        found = shutil.which("llama-cli")
        if not found:
            return {"ok": False, "error": f"llama-cli not found next to {quantize_bin} or on PATH"}
        cli = Path(found)
    cmd = [str(cli), "-m", str(gguf_path), "-p", "The capital of France is",
           "-n", "8", "-no-cnv", "--temp", "0", "-t", "4"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "llama-cli timed out (180s)"}
    except OSError as e:
        return {"ok": False, "error": f"llama-cli spawn failed: {e}"}
    out = (proc.stdout or "").strip()
    if proc.returncode != 0 or not out:
        return {"ok": False, "error": f"llama-cli rc={proc.returncode}; stderr tail: {(proc.stderr or '')[-300:]}"}
    return {"ok": True, "output": out[-200:], "cmd": " ".join(cmd)}


if __name__ == "__main__":
    raise SystemExit(main())
