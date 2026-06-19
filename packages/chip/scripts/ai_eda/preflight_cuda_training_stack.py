#!/usr/bin/env python3
"""Record local readiness for AI-EDA training and inference runs.

This preflight is safe on macOS laptops and CUDA hosts. It installs nothing and
does not download datasets or models.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import platform
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/cuda_training_preflight"
CLAIM_BOUNDARY = "training_stack_preflight_only_no_training_inference_or_performance_claim"

COMMANDS = (
    "git",
    "git-lfs",
    "python3",
    "cmake",
    "ninja",
    "conda",
    "uv",
    "huggingface-cli",
    "nvidia-smi",
    "nvcc",
    "yosys",
    "openroad",
    "verilator",
)

PYTHON_MODULES = (
    "torch",
    "tensorflow",
    "jax",
    "numpy",
    "scipy",
    "pandas",
    "sklearn",
    "yaml",
    "datasets",
    "huggingface_hub",
    "transformers",
    "accelerate",
    "wandb",
    "dgl",
    "torch_geometric",
)


def run_version(command: str) -> dict[str, Any]:
    path = shutil.which(command)
    if path is None:
        return {"command": command, "status": "MISSING", "path": None, "version": None}
    version = None
    for flag in ("--version", "-version", "-v"):
        try:
            result = subprocess.run(
                [path, flag],
                check=False,
                capture_output=True,
                text=True,
                timeout=10,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        output = (result.stdout or result.stderr).strip()
        if output:
            version = output.splitlines()[0][:240]
            break
    return {"command": command, "status": "PRESENT", "path": path, "version": version}


def module_status(module: str) -> dict[str, Any]:
    spec = importlib.util.find_spec(module)
    item: dict[str, Any] = {
        "module": module,
        "status": "PRESENT" if spec is not None else "MISSING",
        "origin": getattr(spec, "origin", None) if spec is not None else None,
    }
    if module == "torch" and spec is not None:
        try:
            import torch

            item["torch_version"] = getattr(torch, "__version__", "unknown")
            item["cuda_available"] = bool(torch.cuda.is_available())
            item["cuda_device_count"] = int(torch.cuda.device_count())
            if torch.cuda.is_available():
                item["cuda_device_name"] = torch.cuda.get_device_name(0)
            item["mps_available"] = bool(
                hasattr(torch.backends, "mps")
                and torch.backends.mps.is_available()
                and torch.backends.mps.is_built()
            )
        except Exception as exc:  # pragma: no cover - diagnostic path
            item["status"] = "PRESENT_BUT_IMPORT_FAILED"
            item["error"] = str(exc)
    return item


def memory_bytes() -> int | None:
    system = platform.system().lower()
    if system == "darwin":
        try:
            result = subprocess.run(
                ["sysctl", "-n", "hw.memsize"],
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode == 0:
                return int(result.stdout.strip())
        except (OSError, ValueError, subprocess.TimeoutExpired):
            return None
    if system == "linux":
        meminfo = Path("/proc/meminfo")
        if meminfo.exists():
            for line in meminfo.read_text(encoding="utf-8").splitlines():
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) * 1024
    return None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    commands = [run_version(command) for command in COMMANDS]
    modules = [module_status(module) for module in PYTHON_MODULES]
    command_missing = [item["command"] for item in commands if item["status"] == "MISSING"]
    module_missing = [item["module"] for item in modules if item["status"] == "MISSING"]
    torch_item = next((item for item in modules if item["module"] == "torch"), {})
    has_cuda = bool(torch_item.get("cuda_available")) or any(
        item["command"] == "nvidia-smi" and item["status"] == "PRESENT" for item in commands
    )
    mem = memory_bytes()
    report = {
        "schema": "eliza.ai_eda.cuda_training_preflight.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "status": "PASS_WITH_BLOCKERS_RECORDED",
        "host": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "python": sys.version.split()[0],
            "memory_bytes": mem,
            "memory_gib": round(mem / (1024**3), 2) if mem is not None else None,
        },
        "cuda": {
            "available": has_cuda,
            "release_use_allowed": False,
            "large_training_ready": bool(has_cuda and not module_missing),
        },
        "commands": commands,
        "python_modules": modules,
        "blockers": {
            "missing_commands": command_missing,
            "missing_python_modules": module_missing,
            "notes": [
                "macOS M-series hosts are valid for metadata, dry-run, converter, and small CPU/MPS tests.",
                "CUDA training requires a Linux host with NVIDIA driver, nvidia-smi, CUDA-compatible torch, and pinned datasets.",
            ],
        },
    }
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "cuda_training_preflight.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.cuda_training_preflight {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
