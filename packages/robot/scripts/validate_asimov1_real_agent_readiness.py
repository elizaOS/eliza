#!/usr/bin/env python3
"""Validate ASIMOV-1 real-agent readiness contracts."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def _run(name: str, argv: list[str], *, cwd: Path = ROOT) -> dict[str, Any]:
    proc = subprocess.run(argv, cwd=cwd, text=True, capture_output=True, check=False)
    parsed = None
    try:
        parsed = json.loads(proc.stdout)
    except Exception:
        parsed = None
    return {
        "name": name,
        "argv": argv,
        "returncode": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "passed": proc.returncode == 0,
        "parsed": parsed,
    }


def validate_asimov1_real_agent_readiness(
    *,
    checkpoint: Path | None = None,
    production_min_steps: int = 1_000_000,
    hardware_evidence: Path | None = None,
    require_production: bool = False,
    require_hardware: bool = False,
    max_steps: int = 2,
) -> dict[str, Any]:
    py = sys.executable
    checkpoint_path = checkpoint.resolve() if checkpoint is not None else None
    hardware_evidence_path = hardware_evidence.resolve() if hardware_evidence is not None else None
    steps: list[dict[str, Any]] = [
        _run("server_command_surface", [py, "scripts/validate_asimov1_server_command_surface.py"]),
        _run("real_bridge_dry_run", [py, "scripts/validate_asimov1_real_bridge_dry_run.py"]),
        _run("real_prereqs", [py, "scripts/check_asimov1_real_prereqs.py"]),
    ]
    policy_loop_argv = [
        py,
        "scripts/validate_asimov1_policy_loop.py",
        "--max-steps",
        str(max_steps),
    ]
    if checkpoint_path is not None:
        policy_loop_argv.extend(["--checkpoint", str(checkpoint_path)])
    steps.append(_run("policy_loop", policy_loop_argv))

    production_validation = None
    if checkpoint_path is not None:
        production_validation = _run(
            "production_checkpoint",
            [
                py,
                "scripts/validate_asimov1_production_checkpoint.py",
                str(checkpoint_path),
                "--min-steps",
                str(production_min_steps),
            ],
        )
        steps.append(production_validation)

    hardware_validation = None
    if hardware_evidence_path is not None:
        hardware_validation = _run(
            "real_hardware_evidence",
            [
                py,
                "scripts/validate_asimov1_real_hardware_evidence.py",
                str(hardware_evidence_path),
            ],
        )
        steps.append(hardware_validation)

    step_ok = {step["name"]: bool(step["passed"]) for step in steps}
    checks = {
        "server_command_surface": step_ok.get("server_command_surface", False),
        "real_bridge_dry_run": step_ok.get("real_bridge_dry_run", False),
        "real_prereqs_contract": step_ok.get("real_prereqs", False),
        "policy_loop": step_ok.get("policy_loop", False),
        "production_checkpoint": (
            production_validation is not None and production_validation["passed"]
        )
        if require_production
        else True,
        "real_hardware_evidence": (
            hardware_validation is not None and hardware_validation["passed"]
        )
        if require_hardware
        else True,
    }
    production_ready = (
        all(checks.values())
        and production_validation is not None
        and production_validation["passed"]
        and hardware_validation is not None
        and hardware_validation["passed"]
    )
    return {
        "ok": all(checks.values()),
        "profile_id": "asimov-1",
        "checkpoint": str(checkpoint_path) if checkpoint_path else None,
        "hardware_evidence": str(hardware_evidence_path) if hardware_evidence_path else None,
        "require_production": require_production,
        "require_hardware": require_hardware,
        "production_ready": production_ready,
        "checks": checks,
        "steps": steps,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, default=None)
    parser.add_argument("--production-min-steps", type=int, default=1_000_000)
    parser.add_argument("--hardware-evidence", type=Path, default=None)
    parser.add_argument("--require-production", action="store_true")
    parser.add_argument("--require-hardware", action="store_true")
    parser.add_argument("--max-steps", type=int, default=2)
    args = parser.parse_args()
    report = validate_asimov1_real_agent_readiness(
        checkpoint=args.checkpoint,
        production_min_steps=args.production_min_steps,
        hardware_evidence=args.hardware_evidence,
        require_production=args.require_production,
        require_hardware=args.require_hardware,
        max_steps=args.max_steps,
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
