"""Apply GGUF Q3_K_M K-quant to a fine-tuned Eliza-1/Gemma checkpoint.

Wraps llama.cpp's two-stage GGUF conversion:

  1. ``convert_hf_to_gguf.py`` — turns a HuggingFace safetensors checkpoint
     into a single-file f16 GGUF.
  2. ``llama-quantize`` — quantizes that f16 GGUF down to Q3_K_M (3-bit
     K-quant, mixed precision: 3-bit body + 4–5-bit attention.w + Q6_K
     embed_tokens). This is the *smallest* sibling in the canonical
     llama.cpp K-quant ladder (Q3_K_M, Q4_K_M, Q5_K_M, Q6_K) and trades
     ~2 PPL for ~30% smaller file size vs Q4_K_M.

Output is written to ``<output>/eliza-1-<size>-Q3_K_M.gguf``, matching the
sibling K-quant levels (``-Q4_K_M``, ``-Q5_K_M``, ``-Q6_K``) so the publish
layer can upload them under the single ``elizaos/eliza-1`` bundle repo.

The converter + binary come from the in-repo llama.cpp fork submodule at
``plugins/plugin-local-inference/native/llama.cpp`` — the single canonical llama.cpp checkout
for the whole repo. ``convert_hf_to_gguf.py`` is the fork's own script
(the fork is itself a llama.cpp fork, so it carries all the standard
tooling). ``llama-quantize`` is built from that submodule with a one-shot
CPU-only cmake build (see ``_VENDOR_HINT``). Resolution falls back to
``--llama-cpp-dir`` / ``$LLAMA_CPP_DIR`` / ``PATH`` if the submodule build
isn't present. If nothing resolves the script exits 2 with an actionable
diagnostic. ``--calibration`` is accepted for CLI parity with the rest of
the quantization scripts and is forwarded to ``llama-quantize`` as an
importance matrix when present (significantly improves PPL at low
bit-rates — for Q3_K_M an imatrix is *strongly* recommended).
"""

from __future__ import annotations

import argparse
import json
import logging
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from _common import (  # noqa: E402
    DEFAULT_LLAMA_CPP_DIR,
    find_llama_convert_script,
    find_llama_quantize_binary,
    llama_cpp_vendor_hint,
    write_sidecar,
)

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger("gguf_q3_k_m_apply")

# K-quant level produced by this wrapper. This file is a byte-for-byte
# clone of ``gguf-q4_k_m_apply.py`` differing only by QUANT_LEVEL +
# sidecar notes. If you change this script, mirror the change in the
# Q4/Q5/Q6 siblings.
QUANT_LEVEL = "Q3_K_M"


_FORK_LLAMA_CPP = DEFAULT_LLAMA_CPP_DIR
_VENDOR_HINT = llama_cpp_vendor_hint()


def _find_convert_script(llama_cpp_dir: Path | None) -> Path:
    """Locate convert_hf_to_gguf.py.

    Resolution order: ``--llama-cpp-dir`` (explicit), ``$LLAMA_CPP_DIR``
    (env override), the in-repo llama.cpp fork submodule
    (``plugins/plugin-local-inference/native/llama.cpp``, the canonical
    checkout), then a
    system PATH install (e.g. the llama-cpp-python wheel).
    """
    return find_llama_convert_script(llama_cpp_dir)


def _find_quantize_binary(llama_cpp_dir: Path | None) -> Path:
    """Locate the ``llama-quantize`` binary.

    Same resolution order as :func:`_find_convert_script`: explicit
    ``--llama-cpp-dir``, ``$LLAMA_CPP_DIR``, the in-repo fork submodule's
    ``build/bin`` (a one-shot CPU cmake build — see :data:`_VENDOR_HINT`),
    then PATH.
    """
    return find_llama_quantize_binary(llama_cpp_dir)


def _resolve_output_basename(model_id_or_path: str, output_dir: Path) -> str:
    """Pick the gguf filename from the model dir or HF repo id.

    For elizaos/eliza-1 bundles we want the publishable filename
    ``eliza-1-<size>-Q3_K_M.gguf``. Falls back to <last-path-segment>.
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
            "(use llama-imatrix beforehand). For Q3_K_M an imatrix is "
            "strongly recommended — without one expect ~2 PPL above Q4_K_M."
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
        help="Skip the post-quantize llama-cli load-smoke. This is a local "
             "debug escape hatch; release/publish runs must keep the default "
             "artifact load test enabled.",
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
            log.error("load-smoke FAILED: %s", smoke.get("error"))
            return 2
    else:
        smoke = {
            "ok": False,
            "skipped": True,
            "release_eligible": False,
            "error": "--no-smoke-load was used; no real-artifact recipe test ran",
        }

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
            "Q3_K_M is the smallest viable K-quant in the canonical "
            "llama.cpp ladder (~3.9 bits per weight on average, mixed "
            "precision). Trades ~2 PPL for ~30% smaller file vs Q4_K_M; "
            "imatrix calibration is strongly recommended at this bit-rate."
        ),
    }
    sidecar_path = write_sidecar(args.output, "gguf_q3_k_m.json", sidecar)
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
