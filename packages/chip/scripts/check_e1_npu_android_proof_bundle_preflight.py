#!/usr/bin/env python3
"""Preflight the Android e1-NPU proof bundle capture environment."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1_npu_android_proof_bundle_preflight.json"
TRADEFED_BUILD_COMMAND = "scripts/android/build_cts_vts_tradefed.sh"
TRADEFED_BUILD_LOG = "docs/evidence/android/e1-npu/cts-vts-tradefed-build.log"
REQUIRED_COUNTER_ENVS = (
    "E1_NPU_MACS_PER_INFERENCE",
    "E1_NPU_CYCLES",
    "E1_NPU_HZ",
    "E1_NPU_DMA_BYTES_READ",
    "E1_NPU_DMA_BYTES_WRITTEN",
    "E1_NPU_NNAPI_DELEGATED_NODE_COUNT",
    "E1_NPU_NNAPI_TOTAL_NODE_COUNT",
    "E1_NPU_DATAFLOW_NAME",
    "E1_NPU_GENERATED_BY",
    "E1_NPU_TARGET",
)


def default_aosp_tree(env: dict[str, str]) -> str:
    value = env.get("AOSP_TREE") or env.get("AOSP_DIR") or ""
    if value:
        return value
    candidate = Path("/home/shaw/aosp")
    return str(candidate) if candidate.is_dir() else ""


def adb_state(env: dict[str, str], probe: bool) -> dict[str, Any]:
    adb = shutil.which("adb")
    state: dict[str, Any] = {"adb": adb, "ready_devices": [], "status": "blocked"}
    if not adb:
        state["blocked_reason"] = "adb_not_found"
        return state
    if not probe:
        state["status"] = "not_probed"
        return state
    result = subprocess.run(
        [adb, "devices"],
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
        timeout=15,
    )
    state["returncode"] = result.returncode
    state["stdout"] = result.stdout
    if result.returncode != 0:
        state["blocked_reason"] = "adb_devices_failed"
        return state
    devices = []
    for line in result.stdout.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 2 and parts[1] == "device":
            devices.append(parts[0])
    state["ready_devices"] = devices
    if len(devices) == 1:
        state["status"] = "ready"
    else:
        state["blocked_reason"] = f"expected_exactly_one_ready_adb_device_found_{len(devices)}"
    return state


def executable(path: Path) -> bool:
    return path.is_file() and os.access(path, os.X_OK)


def tradefed_artifact_report(aosp_tree: Path) -> list[dict[str, str]]:
    return [
        {
            "name": "cts-tradefed",
            "path": str(aosp_tree / "out/host/linux-x86/cts/android-cts/tools/cts-tradefed"),
            "status": "ready"
            if executable(aosp_tree / "out/host/linux-x86/cts/android-cts/tools/cts-tradefed")
            else "missing",
        },
        {
            "name": "vts-tradefed",
            "path": str(aosp_tree / "out/host/linux-x86/vts/android-vts/tools/vts-tradefed"),
            "status": "ready"
            if executable(aosp_tree / "out/host/linux-x86/vts/android-vts/tools/vts-tradefed")
            else "missing",
        },
    ]


def build_report(args: argparse.Namespace, env: dict[str, str]) -> tuple[int, dict[str, Any]]:
    blockers: list[dict[str, str]] = []
    warnings: list[str] = []
    aosp_tree_text = args.aosp_tree or default_aosp_tree(env)
    aosp_tree = Path(aosp_tree_text).expanduser().resolve() if aosp_tree_text else None

    def block(code: str, message: str, evidence: str, next_step: str) -> None:
        blockers.append(
            {"code": code, "message": message, "evidence": evidence, "next_step": next_step}
        )

    if aosp_tree is None:
        block(
            "aosp_tree_missing",
            "AOSP_TREE/AOSP_DIR is not set and /home/shaw/aosp is unavailable",
            "AOSP_TREE",
            "Set AOSP_TREE to the built riscv64 AOSP checkout.",
        )
    elif not aosp_tree.is_dir():
        block("aosp_tree_not_directory", "AOSP tree path does not exist", str(aosp_tree), "Build or mount the AOSP tree.")
    else:
        if not (aosp_tree / "build/envsetup.sh").is_file():
            block("aosp_envsetup_missing", "AOSP tree is missing build/envsetup.sh", str(aosp_tree), "Use a complete AOSP checkout.")
        for rel, code in (
            ("out/host/linux-x86/cts/android-cts/tools/cts-tradefed", "cts_tradefed_missing"),
            ("out/host/linux-x86/vts/android-vts/tools/vts-tradefed", "vts_tradefed_missing"),
            ("out/host/linux-x86/bin/checkvintf", "checkvintf_missing"),
        ):
            path = aosp_tree / rel
            if not executable(path):
                next_step = "Build the required AOSP host tools."
                if code in {"cts_tradefed_missing", "vts_tradefed_missing"}:
                    next_step = (
                        f"Run AOSP_TREE={aosp_tree} {TRADEFED_BUILD_COMMAND}; "
                        f"it writes {TRADEFED_BUILD_LOG}."
                    )
                block(code, f"{rel} is missing or not executable", str(path), next_step)

    model = Path(env.get("E1_NPU_TFLITE_MODEL", str(ROOT / "benchmarks/models/mobile_smoke.tflite")))
    if not model.is_absolute():
        model = ROOT / model
    if not model.is_file() or model.stat().st_size == 0:
        block("mobile_smoke_model_missing", "mobile_smoke.tflite is missing or empty", str(model), "Generate or restore the pinned TFLite smoke model.")

    adb = adb_state(env, probe=not args.no_adb_probe)
    if adb.get("status") != "ready" and not args.no_adb_probe:
        block(
            str(adb.get("blocked_reason", adb.get("status", "adb_not_ready"))),
            "ADB does not expose exactly one ready Android target",
            "adb devices",
            "Boot/connect the Android target that exposes e1-npu over NNAPI.",
        )
    elif adb.get("status") == "not_probed":
        warnings.append("ADB was not probed; target readiness remains unverified")

    if env.get("E1_NPU_WRITE_PROOF_JSON") == "1":
        for name in REQUIRED_COUNTER_ENVS:
            if not env.get(name):
                block(
                    f"missing_env_{name.lower()}",
                    f"{name} is required when E1_NPU_WRITE_PROOF_JSON=1",
                    name,
                    "Export measured target counters before running the bundle.",
                )
    else:
        warnings.append("E1_NPU_WRITE_PROOF_JSON is not 1; NNAPI capability proof JSON will not be emitted")

    report = {
        "schema": "eliza.e1_npu_android_proof_bundle_preflight.v1",
        "status": "pass" if not blockers else "blocked",
        "aosp_tree": str(aosp_tree) if aosp_tree else "",
        "adb": adb,
        "model": str(model),
        "tradefed_artifacts": tradefed_artifact_report(aosp_tree) if aosp_tree else [],
        "tradefed_build_command": TRADEFED_BUILD_COMMAND,
        "tradefed_build_log": TRADEFED_BUILD_LOG,
        "blockers": blockers,
        "warnings": warnings,
        "bundle_command": "scripts/android/capture_e1_npu_android_proof_bundle.sh",
    }
    return (0 if not blockers else 2), report


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--aosp-tree")
    parser.add_argument("--report", type=Path, default=REPORT)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--no-adb-probe", action="store_true")
    args = parser.parse_args(argv)
    rc, report = build_report(args, dict(os.environ))
    out = args.report if args.report.is_absolute() else ROOT / args.report
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(
            f"STATUS: {report['status'].upper()} e1_npu_android_proof_bundle_preflight "
            f"blockers={len(report['blockers'])} report={out.relative_to(ROOT)}"
        )
        for blocker in report["blockers"]:
            print(f"- {blocker['code']}: {blocker['message']}")
    return rc


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
