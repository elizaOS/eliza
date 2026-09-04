"""Canonical profile-driven GGUF K-quant conversion and artifact verification."""

from __future__ import annotations

import argparse
import json
import logging
import os
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping


REPO_ROOT = Path(__file__).resolve().parents[4]
LLAMA_CPP_RELATIVE_DIR = Path("plugins/plugin-local-inference/native/llama.cpp")
DEFAULT_LLAMA_CPP_DIR = REPO_ROOT / LLAMA_CPP_RELATIVE_DIR


def llama_cpp_vendor_hint() -> str:
    """Return setup instructions for the canonical llama.cpp fork."""

    relative = LLAMA_CPP_RELATIVE_DIR.as_posix()
    return (
        "The llama.cpp fork submodule should already be checked out. If it is "
        f"missing, run: git submodule update --init {relative}. Then build "
        "llama-quantize and llama-completion, or pass --llama-cpp-dir / set "
        "LLAMA_CPP_DIR / place the binaries on PATH."
    )


def _llama_cpp_dirs(llama_cpp_dir: Path | None) -> list[Path]:
    candidates: list[Path] = []
    if llama_cpp_dir is not None:
        candidates.append(llama_cpp_dir)
    if environment_dir := os.environ.get("LLAMA_CPP_DIR"):
        candidates.append(Path(environment_dir))
    candidates.append(DEFAULT_LLAMA_CPP_DIR)
    return candidates


def find_llama_convert_script(llama_cpp_dir: Path | None) -> Path:
    """Locate convert_hf_to_gguf.py using the release-safe resolution order."""

    candidates = [
        directory / "convert_hf_to_gguf.py"
        for directory in _llama_cpp_dirs(llama_cpp_dir)
    ]
    if resolved := shutil.which("convert_hf_to_gguf.py"):
        candidates.append(Path(resolved))
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise SystemExit("convert_hf_to_gguf.py not found.\n" + llama_cpp_vendor_hint())


def find_llama_quantize_binary(llama_cpp_dir: Path | None) -> Path:
    """Locate llama-quantize using the release-safe resolution order."""

    candidates: list[Path] = []
    for directory in _llama_cpp_dirs(llama_cpp_dir):
        candidates.extend(
            [
                directory / "build" / "bin" / "llama-quantize",
                directory / "llama-quantize",
            ]
        )
    if resolved := shutil.which("llama-quantize"):
        candidates.append(Path(resolved))
    for candidate in candidates:
        if candidate.exists() and os.access(candidate, os.X_OK):
            return candidate
    raise SystemExit("llama-quantize binary not found.\n" + llama_cpp_vendor_hint())


def write_sidecar(
    output_dir: Path,
    filename: str,
    payload: Mapping[str, object],
) -> Path:
    """Write a deterministic JSON sidecar adjacent to the quantized model."""

    output = output_dir / filename
    output.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return output


@dataclass(frozen=True)
class QuantProfile:
    """Metadata that differs between public K-quant wrapper commands."""

    level: str
    sidecar_name: str
    notes: str
    calibration_help: str = ""


FindTool = Callable[[Path | None], Path]
RunCommand = Callable[[list[str | Path]], None]
SmokeLoad = Callable[[Path, Path], dict[str, object]]
WriteSidecar = Callable[[Path, str, dict[str, object]], Path]


def resolve_output_basename(model_id_or_path: str, level: str) -> str:
    """Derive the stable publish filename from a checkpoint path or repo id."""

    last = model_id_or_path.rstrip("/").split("/")[-1]
    for suffix in ("-final", "/final", "-sft", "-apollo"):
        if last.endswith(suffix):
            last = last[: -len(suffix)]
    return f"{last}-{level}.gguf"


def run_command(command: list[str | Path], logger: logging.Logger) -> None:
    """Run one checked conversion command with shell-safe diagnostic output."""

    rendered = [str(part) for part in command]
    logger.info("run: %s", " ".join(shlex.quote(part) for part in rendered))
    subprocess.run(rendered, check=True)


def smoke_load_gguf(gguf_path: Path, quantize_bin: Path) -> dict[str, object]:
    """Load a produced GGUF with the fork's noninteractive completion tool."""

    cli = quantize_bin.parent / "llama-completion"
    if not cli.exists():
        found = shutil.which("llama-completion")
        if not found:
            return {
                "ok": False,
                "error": f"llama-completion not found next to {quantize_bin} or on PATH",
            }
        cli = Path(found)
    command = [
        str(cli),
        "-m",
        str(gguf_path),
        "-p",
        "The capital of France is",
        "-n",
        "8",
        "-no-cnv",
        "--no-display-prompt",
        "--temp",
        "0",
        "-t",
        "4",
    ]
    try:
        process = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=180,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "llama-completion timed out (180s)"}
    except OSError as error:
        return {"ok": False, "error": f"llama-completion spawn failed: {error}"}
    output = (process.stdout or "").strip()
    if process.returncode != 0 or not output:
        return {
            "ok": False,
            "error": (
                f"llama-completion rc={process.returncode}; stderr tail: "
                f"{(process.stderr or '')[-300:]}"
            ),
        }
    return {"ok": True, "output": output[-200:], "cmd": " ".join(command)}


def run_quant_profile(
    profile: QuantProfile,
    argv: list[str] | None,
    *,
    find_convert_script: FindTool,
    find_quantize_binary: FindTool,
    write_sidecar: WriteSidecar,
    run: RunCommand | None = None,
    smoke_load: SmokeLoad = smoke_load_gguf,
) -> int:
    """Execute the common convert, quantize, smoke, and sidecar graph."""

    parser = argparse.ArgumentParser(
        description=f"Apply GGUF {profile.level} K-quant to an Eliza-1 checkpoint."
    )
    parser.add_argument(
        "--model",
        required=True,
        help="HF repo id or local HuggingFace causal-LM checkpoint path.",
    )
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--calibration",
        type=Path,
        default=None,
        help=(
            "Optional importance-matrix file. A *.imatrix value is forwarded "
            "to llama-quantize; JSONL is accepted for CLI parity but is not "
            f"converted by this command. {profile.calibration_help}"
        ).strip(),
    )
    parser.add_argument("--calibration-samples", type=int, default=128)
    parser.add_argument(
        "--llama-cpp-dir",
        type=Path,
        default=None,
        help="Path to a llama.cpp checkout (overrides normal resolution).",
    )
    parser.add_argument(
        "--keep-f16",
        action="store_true",
        help="Keep the intermediate f16 GGUF in --output.",
    )
    parser.add_argument(
        "--no-smoke-load",
        dest="smoke_load",
        action="store_false",
        help=(
            "Skip the required post-quantize llama-completion load smoke. The "
            "artifact will be marked ineligible for release."
        ),
    )
    parser.set_defaults(smoke_load=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    if args.dry_run:
        print(
            json.dumps(
                {**vars(args), "quant_level": profile.level},
                indent=2,
                default=str,
            )
        )
        return 0

    logger = logging.getLogger(f"gguf_{profile.level.lower()}_apply")
    convert = find_convert_script(args.llama_cpp_dir)
    quantize = find_quantize_binary(args.llama_cpp_dir)
    execute = run or (lambda command: run_command(command, logger))

    args.output.mkdir(parents=True, exist_ok=True)
    basename = resolve_output_basename(str(args.model), profile.level)
    f16_path = args.output / basename.replace(f"-{profile.level}.gguf", "-F16.gguf")
    quant_path = args.output / basename

    logger.info("step 1/2: convert HF -> f16 GGUF (%s)", f16_path)
    execute(
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

    logger.info("step 2/2: llama-quantize -> %s (%s)", profile.level, quant_path)
    quantize_command: list[str | Path] = [quantize]
    if args.calibration is not None and args.calibration.suffix == ".imatrix":
        quantize_command.extend(["--imatrix", str(args.calibration)])
    quantize_command.extend([str(f16_path), str(quant_path), profile.level])
    execute(quantize_command)

    if not args.keep_f16:
        logger.info("removing intermediate %s", f16_path)
        f16_path.unlink(missing_ok=True)

    if args.smoke_load:
        smoke = smoke_load(quant_path, quantize)
        if not smoke.get("ok"):
            logger.error("load-smoke FAILED: %s", smoke.get("error"))
            return 2
        logger.info("load-smoke OK: %r", str(smoke.get("output", ""))[:80])
    else:
        smoke = {
            "ok": False,
            "skipped": True,
            "release_eligible": False,
            "error": "--no-smoke-load was used; no real-artifact recipe test ran",
        }

    release_eligible = bool(smoke.get("ok"))
    sidecar: dict[str, object] = {
        "method": f"gguf_{profile.level.lower()}",
        "scheme": profile.level,
        "tool": "llama.cpp/convert_hf_to_gguf.py + llama-quantize",
        "convert_script": str(convert),
        "quantize_binary": str(quantize),
        "source_model": str(args.model),
        "output_file": str(quant_path),
        "imatrix": (
            str(args.calibration)
            if args.calibration and args.calibration.suffix == ".imatrix"
            else None
        ),
        "smoke_load": smoke,
        "recipe_test": {
            "name": "llama-completion-load-smoke",
            "status": "passed" if release_eligible else "skipped",
            "release_eligible": release_eligible,
            "artifact": str(quant_path),
            "details": smoke,
        },
        "notes": profile.notes,
    }
    sidecar_path = write_sidecar(args.output, profile.sidecar_name, sidecar)
    logger.info("wrote %s", sidecar_path)
    return 0
