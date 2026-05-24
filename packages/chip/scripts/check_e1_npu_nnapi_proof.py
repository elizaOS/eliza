#!/usr/bin/env python3
"""Check the e1-npu NNAPI capability proof gate.

This is a readiness and validation check, not a proof generator. It validates
the configured capability artifact when present and records concrete local
blockers when proof cannot be produced from this machine.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

CAPTURE_COMMANDS = {
    "adb_devices": "adb devices",
    "nnapi_accelerator_query": "adb shell cmd neuralnetworks list",
    "benchmark_model_nnapi": (
        "adb shell benchmark_model --graph=/data/local/tmp/mobile_smoke.tflite "
        "--use_nnapi=true --nnapi_accelerator_name=e1-npu "
        "--enable_op_profiling=true --verbose=true"
    ),
    "dma_trace": "adb shell cat /sys/bus/platform/devices/10020000.npu/dma_trace",
}
DEFAULT_STATUS_JSON = Path("build/reports/e1_npu_nnapi_proof_readiness.json")


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config", type=Path, default=Path("benchmarks/configs/benchmark_plan.json")
    )
    parser.add_argument(
        "--status-json",
        type=Path,
        default=DEFAULT_STATUS_JSON,
        help=(
            "Output path for the readiness JSON. Defaults to "
            "build/reports/e1_npu_nnapi_proof_readiness.json."
        ),
    )
    parser.add_argument(
        "--allow-host-smoke-tools",
        action="store_true",
        help="Include repo-local host smoke tools in dependency diagnostics.",
    )
    parser.add_argument(
        "--probe-adb",
        action="store_true",
        help="Run 'adb devices' if adb is installed and include the result in diagnostics.",
    )
    return parser.parse_args(argv)


def find_benchmark(config: dict[str, Any], name: str) -> dict[str, Any]:
    for bench in config["benchmarks"]:
        if bench["name"] == name:
            return bench
    raise ValueError(f"benchmark plan missing {name}")


def adb_probe() -> dict[str, Any]:
    adb = shutil.which("adb")
    status: dict[str, Any] = {
        "adb": adb,
        "status": "blocked",
        "devices": [],
    }
    if not adb:
        status["blocked_reason"] = "adb_not_installed"
        return status
    result = subprocess.run(
        [adb, "devices"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
        timeout=15,
    )
    status["returncode"] = result.returncode
    status["stdout"] = result.stdout
    if result.returncode != 0:
        status["blocked_reason"] = "adb_devices_failed"
        return status
    devices = []
    for line in result.stdout.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 2 and parts[1] == "device":
            devices.append(parts[0])
    status["devices"] = devices
    if devices:
        status["status"] = "available"
        status.pop("blocked_reason", None)
    else:
        status["blocked_reason"] = "no_adb_device"
    return status


def proof_json_state(artifact_status: dict[str, Any]) -> str:
    if artifact_status.get("available"):
        return "valid"
    reason = artifact_status.get("blocked_reason", "unavailable")
    if reason == "missing_e1_npu_nnapi_accelerator":
        return "missing"
    if reason == "invalid_capability_proof":
        return "invalid"
    return str(reason)


def benchmark_model_state(dependencies: list[dict[str, Any]]) -> str:
    for item in dependencies:
        if item.get("kind") != "executable" or item.get("name") != "benchmark_model":
            continue
        if item.get("available"):
            return "real_tool_available"
        if item.get("blocked_reason") == "repo_local_host_smoke_tool":
            return "host_smoke_rejected"
        return str(item.get("blocked_reason", "missing"))
    return "missing"


def adb_state(probe: dict[str, Any] | None) -> str:
    if probe is None:
        return "not_probed"
    if probe.get("status") == "available":
        return "device_available"
    return str(probe.get("blocked_reason", "adb_unavailable"))


def blocker_code(blocker: dict[str, Any]) -> str:
    raw = blocker.get("blocker_id") or blocker.get("blocked_reason") or blocker.get("name")
    text = str(raw or "nnapi_proof_blocker")
    cleaned = "".join(char.lower() if char.isalnum() else "_" for char in text)
    parts = [part for part in cleaned.split("_") if part]
    return "e1_npu_nnapi_" + ("_".join(parts[:10]) or "proof_blocker")


def structured_findings(local_blockers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    seen: set[str] = set()
    for blocker in local_blockers:
        code = blocker_code(blocker)
        if code in seen:
            continue
        seen.add(code)
        name = str(blocker.get("name", "NNAPI proof blocker"))
        reason = str(blocker.get("blocked_reason", "unavailable"))
        findings.append(
            {
                "code": code,
                "severity": "blocker",
                "message": f"{name} is blocked: {reason}",
                "evidence": {
                    "name": blocker.get("name"),
                    "kind": blocker.get("kind"),
                    "blocked_reason": blocker.get("blocked_reason"),
                    "blocker_id": blocker.get("blocker_id"),
                },
                "next_step": blocker.get(
                    "resolution",
                    "Capture the required e1-npu NNAPI target proof and rerun make e1-npu-nnapi-proof-check.",
                ),
            }
        )
    return findings


def main(argv: list[str]) -> int:
    root = repo_root()
    sys.path.insert(0, str(root))
    from benchmarks import run_benchmarks

    args = parse_args(argv)
    config_path = args.config if args.config.is_absolute() else root / args.config
    config = run_benchmarks.load_config(config_path)
    bench = find_benchmark(config, "tflite_e1_npu")
    artifacts = bench.get("capability_artifacts", [])
    if len(artifacts) != 1:
        raise ValueError("tflite_e1_npu must have exactly one capability artifact")
    proof_config = artifacts[0].get("proof", {})
    required_fields = set(proof_config.get("required_json_fields", []))
    missing_capture_fields = sorted(
        f"capture.commands.{name}"
        for name in CAPTURE_COMMANDS
        if f"capture.commands.{name}" not in required_fields
    )

    artifact_status = run_benchmarks.capability_artifact_status(artifacts[0], root)
    dependencies = run_benchmarks.dependency_status(
        bench,
        root,
        allow_host_smoke=args.allow_host_smoke_tools,
    )
    missing_details = run_benchmarks.missing_dependency_details(dependencies)
    blocked_assets = run_benchmarks.blocked_assets(dependencies)

    local_blockers: list[dict[str, Any]] = []
    if not artifact_status.get("available"):
        local_blockers.append(
            {
                "name": artifact_status["name"],
                "kind": artifact_status["kind"],
                "blocked_reason": artifact_status.get("blocked_reason", "unavailable"),
                "blocker_id": artifact_status.get("blocker_id"),
                "resolution": artifact_status.get("resolution", ""),
            }
        )
    for blocker in missing_details + blocked_assets:
        if blocker.get("name") != artifact_status["name"]:
            local_blockers.append(blocker)

    probe = adb_probe() if args.probe_adb else None
    if probe and probe.get("status") != "available":
        local_blockers.append(
            {
                "name": "adb_devices",
                "kind": "target_probe",
                "blocked_reason": probe.get("blocked_reason", "adb_unavailable"),
                "resolution": "Connect an Android target that exposes e1-npu over NNAPI.",
            }
        )

    real_tool_ready = not any(
        blocker.get("kind") == "executable" and blocker.get("name") == "benchmark_model"
        for blocker in missing_details
    )
    target_ready = bool(probe and probe.get("status") == "available")
    local_capture_state = (
        "ready"
        if real_tool_ready and target_ready
        else "blocked"
        if args.probe_adb
        else "not_probed"
    )

    status = {
        "schema": "eliza.e1_npu_nnapi_proof_readiness.v1",
        "benchmark": "tflite_e1_npu",
        "status": "proof_valid" if artifact_status.get("available") else "blocked",
        "proof_json_state": proof_json_state(artifact_status),
        "benchmark_model_state": benchmark_model_state(dependencies),
        "adb_state": adb_state(probe),
        "local_capture_state": local_capture_state,
        "proof_valid": bool(artifact_status.get("available")),
        "can_generate_locally": bool(real_tool_ready and target_ready),
        "config_capture_command_fields_required": not missing_capture_fields,
        "missing_capture_command_fields": missing_capture_fields,
        "proof_artifact": artifact_status,
        "dependencies": dependencies,
        "local_blockers": local_blockers,
        "findings": structured_findings(local_blockers),
        "adb_probe": probe,
        "required_capture_commands": CAPTURE_COMMANDS,
    }

    output = json.dumps(status, indent=2, sort_keys=True) + "\n"
    status_path = args.status_json if args.status_json.is_absolute() else root / args.status_json
    status_path.parent.mkdir(parents=True, exist_ok=True)
    status_path.write_text(output, encoding="utf-8")
    print(output, end="")
    return 0 if status["proof_valid"] else 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
