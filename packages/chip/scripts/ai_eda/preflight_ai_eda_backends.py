#!/usr/bin/env python3
"""Check local readiness of selected AI/EDA backends without installing assets."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/backend_preflight"
CLAIM_BOUNDARY = "local_backend_preflight_only_no_external_import_or_release_use"

BACKENDS = (
    {
        "id": "zigzag",
        "source_id": "zigzag",
        "kind": "accelerator_dse",
        "python_modules": ("zigzag",),
        "commands": (),
        "local_paths": ("external/repos/zigzag/payload",),
        "required_for": ("p1-zigzag-npu-dse",),
    },
    {
        "id": "timeloop_accelergy",
        "source_id": "timeloop-accelergy",
        "kind": "accelerator_modeling",
        "python_modules": ("accelergy",),
        "commands": ("timeloop-model", "timeloop-mapper", "accelergy"),
        "local_paths": ("external/repos/timeloop-accelergy/payload",),
        "required_for": ("p1-zigzag-npu-dse", "p1-simulator-benchmark-optimization"),
    },
    {
        "id": "rtlmul",
        "source_id": "rtlmul",
        "kind": "ppa_reward_model",
        "python_modules": ("transformers", "torch"),
        "commands": (),
        "local_paths": ("external/models/rtlmul/payload",),
        "required_for": ("p1-simulator-benchmark-optimization", "p2-power-thermal-ai-watch"),
    },
    {
        "id": "llm4dv",
        "source_id": "llm4dv",
        "kind": "verification_stimulus",
        "python_modules": (),
        "commands": (),
        "local_paths": ("external/repos/llm4dv/payload",),
        "required_for": ("p1-llm4dv-cocotb-stimulus-loop",),
    },
    {
        "id": "assertllm",
        "source_id": "assertllm",
        "kind": "assertion_generation",
        "python_modules": (),
        "commands": (),
        "local_paths": ("external/repos/assertllm/payload",),
        "required_for": ("p1-assertion-candidate-review",),
    },
    {
        "id": "fault_dft",
        "source_id": "fault-dft",
        "kind": "dft_atpg",
        "python_modules": (),
        "commands": ("fault",),
        "local_paths": ("external/repos/fault-dft/payload",),
        "required_for": ("p2-dft-atpg-watch",),
    },
)


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def command_version(command: str) -> dict[str, Any]:
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
                timeout=5,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        output = (result.stdout or result.stderr).strip()
        if output:
            version = output.splitlines()[0][:200]
            break
    return {"command": command, "status": "PRESENT", "path": path, "version": version}


def module_status(module: str) -> dict[str, Any]:
    spec = importlib.util.find_spec(module)
    return {
        "module": module,
        "status": "PRESENT" if spec is not None else "MISSING",
        "origin": getattr(spec, "origin", None) if spec is not None else None,
    }


def local_path_status(path_text: str) -> dict[str, Any]:
    path = ROOT / path_text
    return {
        "path": path_text,
        "status": "PRESENT" if path.exists() else "MISSING",
        "is_dir": path.is_dir(),
    }


def backend_status(backend: dict[str, Any]) -> dict[str, Any]:
    modules = [module_status(module) for module in backend["python_modules"]]
    commands = [command_version(command) for command in backend["commands"]]
    local_paths = [local_path_status(path) for path in backend["local_paths"]]
    module_ok = all(item["status"] == "PRESENT" for item in modules) if modules else False
    command_ok = all(item["status"] == "PRESENT" for item in commands) if commands else False
    path_ok = any(item["status"] == "PRESENT" for item in local_paths)
    runnable = module_ok or command_ok or path_ok
    if runnable:
        status = "LOCAL_BACKEND_CANDIDATE_PRESENT"
        next_action = "pin_version_and_add_executed_dry_run_harness"
    else:
        status = "BLOCKED_BACKEND_NOT_INSTALLED"
        next_action = "install_or_checkout_backend_after_license_review"
    return {
        "id": backend["id"],
        "source_id": backend["source_id"],
        "kind": backend["kind"],
        "status": status,
        "release_use_allowed": False,
        "required_for": list(backend["required_for"]),
        "python_modules": modules,
        "commands": commands,
        "local_paths": local_paths,
        "next_action": next_action,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    backends = [backend_status(backend) for backend in BACKENDS]
    status_counts: dict[str, int] = {}
    for backend in backends:
        status = backend["status"]
        status_counts[status] = status_counts.get(status, 0) + 1
    report = {
        "schema": "eliza.ai_eda.backend_preflight.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "mode": "local-preflight",
        "status": "PASS_WITH_BLOCKERS_RECORDED",
        "claim_boundary": CLAIM_BOUNDARY,
        "policy": {
            "installs_packages": False,
            "clones_repositories": False,
            "downloads_model_weights": False,
            "release_use_allowed": False,
            "external_api_required": False,
        },
        "environment": {
            "python_executable": sys.executable,
            "path_checked": os.environ.get("PATH", ""),
        },
        "backend_count": len(backends),
        "status_counts": status_counts,
        "backends": backends,
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "backend_preflight_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.backend_preflight {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
