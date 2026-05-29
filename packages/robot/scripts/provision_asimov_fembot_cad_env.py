#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_cad_toolchain import (  # noqa: E402
    FEMBOT_CAD_ENV_REQUIREMENTS,
    FEMBOT_CAD_ENV_VENV,
    isolated_cad_env_status,
)


def _run(cmd: list[str]) -> dict[str, object]:
    proc = subprocess.run(cmd, text=True, capture_output=True, check=False)
    return {
        "cmd": cmd,
        "returncode": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Provision the isolated command-line CAD env for ASIMOV fembot."
    )
    parser.add_argument(
        "--create",
        action="store_true",
        help="create/update the isolated CAD venv with uv and install requirements",
    )
    parser.add_argument(
        "--require-ready",
        action="store_true",
        help="fail unless the isolated CAD env can import CadQuery and OCP",
    )
    parser.add_argument("--venv", type=Path, default=FEMBOT_CAD_ENV_VENV)
    parser.add_argument("--requirements", type=Path, default=FEMBOT_CAD_ENV_REQUIREMENTS)
    args = parser.parse_args()

    actions: list[dict[str, object]] = []
    if args.create:
        uv = shutil.which("uv")
        if uv is None:
            report = {
                "ok": False,
                "error": "uv executable not found",
                "status": isolated_cad_env_status(venv=args.venv, requirements=args.requirements),
                "actions": actions,
            }
            print(json.dumps(report, indent=2, sort_keys=True) + "\n", end="")
            return 2
        args.venv.parent.mkdir(parents=True, exist_ok=True)
        actions.append(_run([uv, "venv", str(args.venv), "--python", "3.12"]))
        python = args.venv / "bin" / "python"
        if actions[-1]["returncode"] == 0:
            actions.append(
                _run([uv, "pip", "install", "--python", str(python), "-r", str(args.requirements)])
            )

    status = isolated_cad_env_status(venv=args.venv, requirements=args.requirements)
    report = {
        "ok": bool(status["ready"]),
        "status": status,
        "actions": actions,
    }
    print(json.dumps(report, indent=2, sort_keys=True) + "\n", end="")
    return 0 if status["ready"] or not args.require_ready else 2


if __name__ == "__main__":
    raise SystemExit(main())
