"""Apply GGUF Q8_0 quantization to a fine-tuned Qwen checkpoint.

Q8_0 is the highest-quality standard GGUF artifact in the Eliza-1 text
ladder. It is produced directly by llama.cpp's ``convert_hf_to_gguf.py``
with ``--outtype q8_0`` and then load-smoked with ``llama-cli`` when that
binary is available.
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
log = logging.getLogger("gguf_q8_0_apply")

QUANT_LEVEL = "Q8_0"
_REPO_ROOT = _HERE.parents[3]
_FORK_LLAMA_CPP = _REPO_ROOT / "packages" / "inference" / "llama.cpp"

_VENDOR_HINT = (
    "The llama.cpp fork submodule should already be checked out by `bun "
    "install` (scripts/ensure-llama-cpp-submodule.mjs). If it is missing:\n"
    "  git submodule update --init packages/inference/llama.cpp\n"
    "Then install converter deps from "
    "packages/inference/llama.cpp/requirements/requirements-convert_hf_to_gguf.txt."
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
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise SystemExit("convert_hf_to_gguf.py not found.\n" + _VENDOR_HINT)


def _resolve_output_basename(model_id_or_path: str) -> str:
    last = model_id_or_path.rstrip("/").split("/")[-1]
    for suffix in ("-final", "/final", "-sft", "-apollo"):
        if last.endswith(suffix):
            last = last[: -len(suffix)]
    return f"{last}-{QUANT_LEVEL}.gguf"


def _run(cmd: list[str | Path]) -> None:
    str_cmd = [str(x) for x in cmd]
    log.info("run: %s", " ".join(shlex.quote(x) for x in str_cmd))
    subprocess.run(str_cmd, check=True)


def _smoke_load_gguf(gguf_path: Path, convert_script: Path) -> dict[str, object]:
    candidates = [
        convert_script.parent / "build" / "bin" / "llama-cli",
        convert_script.parent / "llama-cli",
    ]
    found = shutil.which("llama-cli")
    if found:
        candidates.append(Path(found))
    cli = next((candidate for candidate in candidates if candidate.exists()), None)
    if cli is None:
        return {"ok": False, "error": "llama-cli not found"}
    cmd = [
        str(cli),
        "-m",
        str(gguf_path),
        "-p",
        "The capital of France is",
        "-n",
        "8",
        "-no-cnv",
        "--temp",
        "0",
        "-t",
        "4",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "llama-cli timed out (180s)"}
    except OSError as exc:
        return {"ok": False, "error": f"llama-cli spawn failed: {exc}"}
    out = (proc.stdout or "").strip()
    if proc.returncode != 0 or not out:
        return {
            "ok": False,
            "error": (
                f"llama-cli rc={proc.returncode}; "
                f"stderr tail: {(proc.stderr or '')[-300:]}"
            ),
        }
    return {"ok": True, "output": out[-200:], "cmd": " ".join(cmd)}


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
        help="Accepted for CLI parity; Q8_0 conversion does not use imatrix.",
    )
    ap.add_argument("--calibration-samples", type=int, default=128)
    ap.add_argument("--llama-cpp-dir", type=Path, default=None)
    ap.add_argument(
        "--no-smoke-load",
        dest="smoke_load",
        action="store_false",
        help="Skip post-conversion llama-cli load-smoke.",
    )
    ap.set_defaults(smoke_load=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    if args.dry_run:
        print(json.dumps({**vars(args), "quant_level": QUANT_LEVEL}, indent=2, default=str))
        return 0

    convert = _find_convert_script(args.llama_cpp_dir)
    args.output.mkdir(parents=True, exist_ok=True)
    quant_path = args.output / _resolve_output_basename(str(args.model))

    _run(
        [
            sys.executable,
            convert,
            str(args.model),
            "--outtype",
            "q8_0",
            "--outfile",
            str(quant_path),
        ]
    )

    smoke: dict[str, object] | None = None
    if args.smoke_load:
        smoke = _smoke_load_gguf(quant_path, convert)
        if smoke.get("ok"):
            log.info("load-smoke OK: %r", smoke.get("output", "")[:80])
        else:
            log.warning("load-smoke FAILED: %s", smoke.get("error"))

    sidecar = {
        "method": "gguf_q8_0",
        "scheme": QUANT_LEVEL,
        "tool": "llama.cpp/convert_hf_to_gguf.py",
        "convert_script": str(convert),
        "source_model": str(args.model),
        "output_file": str(quant_path),
        "smoke_load": smoke,
        "notes": (
            "Q8_0 is the highest-quality standard GGUF artifact in the "
            "Eliza-1 ladder and is published for hosts with enough RAM/VRAM."
        ),
    }
    sidecar_path = write_sidecar(args.output, "gguf_q8_0.json", sidecar)
    log.info("wrote %s", sidecar_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
