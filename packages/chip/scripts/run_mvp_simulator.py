#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/mvp_simulator.json"
TIMEOUT_WRAPPER = [sys.executable, "scripts/run_with_timeout.py"]
DEFAULT_TIMEOUT_SECONDS = 300
CHIPYARD_OUT = ROOT / "build/chipyard/eliza_rocket"
MVP_NPU_REPORT = ROOT / "build/reports/mvp_npu_ml_smoke.json"
MVP_NPU_TRANSCRIPT = ROOT / "build/reports/mvp_npu_ml_smoke.log"
MVP_NPU_SCALE_REPORT = ROOT / "build/reports/mvp_npu_scale_sim.json"
INTEGRATED_NPU_LINUX_MARKERS = (
    "eliza-evidence: target=generated_chipyard_ap",
    "Linux version",
    "e1-npu",
    "eliza-evidence: workload=gemm_s8_int8_2x2x3",
    "eliza-evidence: status=PASS",
)

STEPS = [
    {
        "name": "android_sim_boot",
        "tier": "os_boot",
        "scope": "android_reference",
        "claim": "Android simulator boot evidence",
        "command": [
            "scripts/boot_android_simulator.sh",
            "--run-cuttlefish",
            "--run-cts",
            "--run-vts",
        ],
        "pass_markers": ["PASS: Android simulator evidence captured and validated"],
        "block_markers": ["BLOCKED:"],
        "timeout_seconds": 1800,
    },
    {
        "name": "android_sim_report_check",
        "tier": "os_boot",
        "scope": "android_reference",
        "claim": "validated Android simulator boot report",
        "command": [sys.executable, "scripts/check_android_sim_boot.py"],
        "pass_markers": ["Android simulator boot check passed"],
        "block_markers": ["Android simulator boot blocked"],
        "timeout_seconds": 120,
    },
    {
        "name": "qemu_os_boot",
        "tier": "os_boot",
        "scope": "qemu_virt_reference",
        "claim": "QEMU qemu-virt reference OS boot to init/login; not e1-chip/AP evidence",
        "command": ["scripts/run_qemu.sh", "--check-os"],
        "pass_markers": ["STATUS: PASS qemu.os_boot"],
        "block_markers": ["STATUS: BLOCKED qemu.os_boot"],
        "timeout_seconds": 120,
    },
    {
        "name": "cpu_ap_linux_evidence",
        "tier": "os_prereq",
        "scope": "our_chip_prereq",
        "claim": "CPU/AP Linux evidence prerequisites",
        "command": [sys.executable, "scripts/check_cpu_ap_evidence.py", "--require-evidence"],
        "pass_markers": ["STATUS: PASS cpu_ap.linux_evidence"],
        "block_markers": ["STATUS: BLOCKED cpu_ap.linux_evidence"],
        "timeout_seconds": 120,
    },
    {
        "name": "chipyard_verilator_preflight",
        "tier": "os_prereq",
        "scope": "our_chip_prereq",
        "claim": "Chipyard Verilator environment can generate ElizaRocketConfig",
        "command": [sys.executable, "scripts/check_chipyard_verilator_preflight.py"],
        "pass_markers": ["STATUS: PASS chipyard.verilator_preflight"],
        "block_markers": ["STATUS: BLOCKED chipyard.verilator_preflight"],
        "timeout_seconds": 180,
    },
    {
        "name": "chipyard_generated_ap",
        "tier": "os_prereq",
        "scope": "our_chip_prereq",
        "claim": "generated CPU/AP simulator input",
        "command": [
            sys.executable,
            "scripts/check_chipyard_generator_manifest.py",
            "--require-generated",
        ],
        "pass_markers": ["STATUS: PASS chipyard.generated_import"],
        "block_markers": [
            "STATUS: BLOCKED chipyard.generated_import",
            "Verilator preflight blocker:",
            "missing generated import manifest:",
        ],
        "timeout_seconds": 120,
    },
    {
        "name": "chipyard_payload_path",
        "tier": "os_prereq",
        "scope": "our_chip_prereq",
        "claim": "generated Chipyard DTS/artifacts are ready for the external OpenSBI/U-Boot/Linux payload path; not RTL boot evidence",
        "command": [sys.executable, "scripts/check_chipyard_payload_path.py"],
        "pass_markers": ["STATUS: PASS chipyard.payload_path"],
        "block_markers": ["STATUS: BLOCKED chipyard.payload_path"],
        "timeout_seconds": 120,
    },
    {
        "name": "chipyard_verilator_linux_attempt",
        "tier": "os_boot",
        "scope": "our_chip_os_boot",
        "claim": (
            "bounded startup attempt of OpenSBI/Linux on generated "
            "ElizaRocketConfig Verilator simulator"
        ),
        "command": ["scripts/run_chipyard_eliza_linux_smoke.sh"],
        "pass_markers": ["STATUS: PASS chipyard.verilator_linux_smoke"],
        "block_markers": [
            "STATUS: BLOCKED chipyard.verilator_linux_smoke",
            "STATUS: BLOCKED chipyard.verilator_linux_smoke_docker",
            "STATUS: REPAIR chipyard.verilator_linux_smoke",
            "STATUS: REPAIR chipyard.verilator_linux_smoke_docker",
            "CHIPYARD_LINUX_BINARY is unset",
            "payload missing:",
        ],
        "timeout_seconds": 1500,
        "artifact_paths": [
            "build/chipyard/eliza_rocket/verilator-linux-smoke.log",
            "build/chipyard/eliza_rocket/verilator-linux-smoke-runner.log",
        ],
    },
    {
        "name": "chipyard_verilator_linux_smoke",
        "tier": "os_boot",
        "scope": "our_chip_os_boot",
        "claim": "OpenSBI/Linux smoke on generated ElizaRocketConfig Verilator simulator",
        "command": [sys.executable, "scripts/check_chipyard_verilator_linux_smoke.py"],
        "pass_markers": ["STATUS: PASS chipyard.verilator_linux_smoke"],
        "block_markers": ["STATUS: BLOCKED chipyard.verilator_linux_smoke"],
        "timeout_seconds": 120,
        "artifact_paths": [
            "build/chipyard/eliza_rocket/verilator-linux-smoke.log",
            "build/chipyard/eliza_rocket/verilator-linux-smoke.json",
            "build/chipyard/eliza_rocket/ElizaRocketConfig.manifest.json",
        ],
    },
    {
        "name": "npu_ml_smoke",
        "tier": "npu_ml",
        "scope": "our_chip_npu_ml_local",
        "claim": "local e1 NPU INT8 GEMM runtime/scratchpad smoke transcript; not integrated generated-AP Linux evidence",
        "command": [sys.executable, "scripts/check_mvp_npu_ml_evidence.py", "--run"],
        "pass_markers": ["STATUS: PASS mvp.npu_ml_smoke"],
        "block_markers": ["STATUS: BLOCKED mvp.npu_ml_smoke"],
        "timeout_seconds": 180,
        "artifact_paths": [
            "build/reports/mvp_npu_ml_smoke.log",
            "build/reports/mvp_npu_ml_smoke.json",
            "build/reports/mvp_npu_scale_sim.json",
            "benchmarks/models/mobile_smoke.tflite",
        ],
    },
    {
        "name": "qemu_firmware_smoke",
        "tier": "firmware_smoke",
        "scope": "qemu_virt_reference",
        "claim": "QEMU qemu-virt firmware serial smoke",
        "command": ["scripts/run_qemu.sh", "--check"],
        "pass_markers": ["STATUS: PASS qemu.check"],
        "block_markers": ["STATUS: BLOCKED qemu.check"],
        "timeout_seconds": 120,
    },
    {
        "name": "renode_firmware_smoke",
        "tier": "firmware_smoke",
        "scope": "renode_reference",
        "claim": "Renode firmware serial smoke on the current Renode reference model; not generated AP/Linux evidence",
        "command": ["scripts/run_renode.sh", "--check"],
        "pass_markers": ["STATUS: PASS renode.check"],
        "block_markers": ["STATUS: BLOCKED renode.check"],
        "timeout_seconds": 120,
    },
    {
        "name": "local_rtl_sim_ladder",
        "tier": "rtl_sim",
        "scope": "our_chip_rtl_sim",
        "claim": "local RTL simulation ladder",
        "command": [sys.executable, "scripts/run_sim_ladder.py"],
        "pass_markers": ["Simulation ladder passed"],
        "block_markers": ["STATUS: BLOCKED sim_ladder"],
        "timeout_seconds": 300,
    },
]

TIER_RANK = {
    "os_boot": 4,
    "os_prereq": 3,
    "npu_ml": 3,
    "firmware_smoke": 2,
    "rtl_sim": 1,
}

ON_CHIP_OS_BOOT_REQUIRED_STEPS = {
    "cpu_ap_linux_evidence",
    "chipyard_verilator_preflight",
    "chipyard_generated_ap",
    "chipyard_payload_path",
    "chipyard_verilator_linux_attempt",
    "chipyard_verilator_linux_smoke",
}


def display_path(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def file_artifact(path: Path) -> dict[str, Any]:
    item: dict[str, Any] = {"path": display_path(path), "exists": path.is_file()}
    if path.is_file():
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        item.update({"sha256": digest.hexdigest(), "bytes": path.stat().st_size})
    return item


def step_artifacts(step: dict[str, Any]) -> list[dict[str, Any]]:
    paths = step.get("artifact_paths", [])
    if not isinstance(paths, list):
        return []
    return [file_artifact(ROOT / path) for path in paths if isinstance(path, str)]


def classify(returncode: int, output: str, step: dict[str, Any]) -> str:
    pass_markers = step["pass_markers"]
    block_markers = step["block_markers"]
    assert isinstance(pass_markers, list)
    assert isinstance(block_markers, list)
    if returncode == 0 and all(
        isinstance(marker, str) and marker in output for marker in pass_markers
    ):
        return "pass"
    if returncode == 2 or any(
        isinstance(marker, str) and marker in output for marker in block_markers
    ):
        return "blocked"
    if returncode == 124 and "[timeout-wrapper]" in output and "status=timeout" in output:
        return "blocked"
    return "fail"


def timeout_seconds(step: dict[str, Any]) -> int:
    name = str(step["name"]).upper()
    env_key = f"MVP_SIMULATOR_TIMEOUT_{name}_SECONDS"
    raw = (
        os.environ.get("MVP_SIMULATOR_FORCE_TIMEOUT_SECONDS")
        or os.environ.get(env_key)
        or os.environ.get("MVP_SIMULATOR_DEFAULT_TIMEOUT_SECONDS")
        or step.get("timeout_seconds")
        or DEFAULT_TIMEOUT_SECONDS
    )
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT_SECONDS
    return max(1, value)


def wrapped_command(step: dict[str, Any]) -> list[str]:
    command = step["command"]
    assert isinstance(command, list)
    return [
        *TIMEOUT_WRAPPER,
        "--timeout-seconds",
        str(timeout_seconds(step)),
        "--label",
        f"mvp.{step['name']}",
        "--",
        *[str(part) for part in command],
    ]


def skip_reason(step: dict[str, Any]) -> str | None:
    name = str(step["name"]).upper()
    raw = os.environ.get(f"MVP_SIMULATOR_SKIP_{name}") or os.environ.get(
        "MVP_SIMULATOR_SKIP_LONG_STEPS"
    )
    if raw not in {"1", "true", "TRUE", "yes", "YES"}:
        return None
    return f"STATUS: BLOCKED mvp.{step['name']} - skipped by bounded aggregate refresh"


def run_step(step: dict[str, Any]) -> dict[str, Any]:
    command = step["command"]
    assert isinstance(command, list)
    executed_command = wrapped_command(step)
    skipped = skip_reason(step)
    if skipped is not None:
        return {
            "name": step["name"],
            "tier": step["tier"],
            "scope": step["scope"],
            "claim": step["claim"],
            "command": command,
            "executed_command": executed_command,
            "timeout_seconds": timeout_seconds(step),
            "status": "blocked",
            "returncode": 2,
            "elapsed_seconds": 0.0,
            "artifacts": step_artifacts(step),
            "log_tail": [
                skipped,
                "next_command: " + " ".join(str(part) for part in command),
            ],
        }
    start = time.time()
    result = subprocess.run(
        executed_command,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    elapsed = round(time.time() - start, 3)
    status = classify(result.returncode, result.stdout, step)
    return {
        "name": step["name"],
        "tier": step["tier"],
        "scope": step["scope"],
        "claim": step["claim"],
        "command": command,
        "executed_command": executed_command,
        "timeout_seconds": timeout_seconds(step),
        "status": status,
        "returncode": result.returncode,
        "elapsed_seconds": elapsed,
        "artifacts": step_artifacts(step),
        "log_tail": result.stdout.splitlines()[-40:],
    }


def best_executable_evidence(results: list[dict[str, object]]) -> dict[str, object] | None:
    passing = [
        item
        for item in results
        if item.get("status") == "pass"
        and item.get("scope")
        in {"our_chip_prereq", "our_chip_os_boot", "our_chip_npu_ml_local", "our_chip_rtl_sim"}
    ]
    if not passing:
        return None
    return max(passing, key=lambda item: TIER_RANK.get(str(item.get("tier")), 0))


def best_reference_evidence(results: list[dict[str, object]]) -> dict[str, object] | None:
    passing = [
        item
        for item in results
        if item.get("status") == "pass"
        and item.get("scope") in {"qemu_virt_reference", "renode_reference", "android_reference"}
    ]
    if not passing:
        return None
    return max(passing, key=lambda item: TIER_RANK.get(str(item.get("tier")), 0))


def on_chip_os_boot_claim(results: list[dict[str, object]]) -> bool:
    by_name = {str(item.get("name")): item for item in results}
    return all(
        by_name.get(name, {}).get("status") == "pass" for name in ON_CHIP_OS_BOOT_REQUIRED_STEPS
    )


def blocked_items(results: list[dict[str, object]]) -> list[dict[str, object]]:
    items = []
    for item in results:
        if item.get("status") != "blocked":
            continue
        tail = item.get("log_tail", [])
        detail = ""
        if isinstance(tail, list) and tail:
            status_lines = [
                str(line)
                for line in tail
                if str(line).startswith("STATUS: BLOCKED ") or str(line).startswith("BLOCKED:")
            ]
            detail = status_lines[-1] if status_lines else str(tail[-1])
        command = item.get("command", [])
        if not isinstance(command, list):
            command = []
        items.append(
            {
                "name": item.get("name"),
                "tier": item.get("tier"),
                "detail": detail,
                "next_command": " ".join(str(part) for part in command),
            }
        )
    return items


def integrated_linux_npu_ml_claim() -> tuple[bool, list[str]]:
    log = CHIPYARD_OUT / "verilator-linux-smoke.log"
    if not log.is_file():
        return False, [f"missing generated-AP Linux/NPU transcript: {display_path(log)}"]
    text = log.read_text(encoding="utf-8", errors="replace")
    missing = [marker for marker in INTEGRATED_NPU_LINUX_MARKERS if marker not in text]
    return not missing, [
        f"{display_path(log)} lacks required integrated Linux+NPU marker: {marker}"
        for marker in missing
    ]


def evidence_artifacts() -> dict[str, dict[str, Any]]:
    return {
        "aggregate_report": file_artifact(REPORT),
        "generated_ap_manifest": file_artifact(CHIPYARD_OUT / "ElizaRocketConfig.manifest.json"),
        "boot_transcript": file_artifact(CHIPYARD_OUT / "verilator-linux-smoke.log"),
        "boot_manifest": file_artifact(CHIPYARD_OUT / "verilator-linux-smoke.json"),
        "npu_ml_transcript": file_artifact(MVP_NPU_TRANSCRIPT),
        "npu_ml_manifest": file_artifact(MVP_NPU_REPORT),
        "npu_scale_report": file_artifact(MVP_NPU_SCALE_REPORT),
    }


def failed_items(results: list[dict[str, object]]) -> list[dict[str, object]]:
    items = []
    for item in results:
        if item.get("status") != "fail":
            continue
        tail = item.get("log_tail", [])
        detail = ""
        if isinstance(tail, list) and tail:
            status_lines = [
                str(line)
                for line in tail
                if str(line).startswith("STATUS: FAIL ") or str(line).startswith("FAIL:")
            ]
            detail = status_lines[-1] if status_lines else str(tail[-1])
        command = item.get("command", [])
        if not isinstance(command, list):
            command = []
        items.append(
            {
                "name": item.get("name"),
                "tier": item.get("tier"),
                "detail": detail,
                "next_command": " ".join(str(part) for part in command),
            }
        )
    return items


def nonpassing_items(results: list[dict[str, object]]) -> list[dict[str, object]]:
    return [*blocked_items(results), *failed_items(results)]


def main() -> int:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    results = []
    for step in STEPS:
        item = run_step(step)
        results.append(item)

    statuses = {item["status"] for item in results}
    if "fail" in statuses:
        overall = "fail"
        code = 1
    elif "blocked" in statuses or len(results) != len(STEPS):
        overall = "blocked"
        code = 2
    else:
        overall = "pass"
        code = 0

    best = best_executable_evidence(results)
    best_reference = best_reference_evidence(results)
    qemu_reference_os_boot_passed = any(
        item.get("name") == "qemu_os_boot" and item.get("status") == "pass" for item in results
    )
    android_reference_os_boot_passed = any(
        item.get("scope") == "android_reference" and item.get("status") == "pass"
        for item in results
    )
    on_chip_os_boot_passed = on_chip_os_boot_claim(results)
    npu_ml_smoke_passed = any(
        item.get("name") == "npu_ml_smoke" and item.get("status") == "pass" for item in results
    )
    integrated_npu_claim, integrated_npu_blockers = integrated_linux_npu_ml_claim()
    on_chip_blockers = [
        item
        for item in nonpassing_items(results)
        if any(
            result.get("name") == item.get("name")
            and result.get("scope") in {"our_chip_prereq", "our_chip_os_boot"}
            for result in results
        )
    ]
    minimum_target_blockers = list(on_chip_blockers)
    if not npu_ml_smoke_passed:
        minimum_target_blockers.extend(
            item for item in nonpassing_items(results) if item.get("name") == "npu_ml_smoke"
        )
    if not integrated_npu_claim:
        minimum_target_blockers.append(
            {
                "name": "integrated_linux_npu_ml_transcript",
                "tier": "npu_ml",
                "detail": "; ".join(integrated_npu_blockers),
                "next_command": "python3 scripts/run_mvp_simulator.py",
            }
        )

    report = {
        "schema": "eliza.mvp_simulator.v1",
        "status": overall,
        "strongest_attempted": "os_boot",
        "best_executable_evidence": best["name"] if best else "none",
        "best_executable_tier": best["tier"] if best else "none",
        "best_reference_evidence": best_reference["name"] if best_reference else "none",
        "best_reference_tier": best_reference["tier"] if best_reference else "none",
        "os_boot_claim": bool(on_chip_os_boot_passed),
        "on_chip_os_boot_claim": bool(on_chip_os_boot_passed),
        "reference_qemu_virt_os_boot_claim": bool(qemu_reference_os_boot_passed),
        "reference_android_os_boot_claim": bool(android_reference_os_boot_passed),
        "npu_ml_smoke_claim": bool(npu_ml_smoke_passed),
        "integrated_linux_npu_ml_claim": bool(integrated_npu_claim),
        "minimum_linux_npu_target_claim": bool(
            on_chip_os_boot_passed and npu_ml_smoke_passed and integrated_npu_claim
        ),
        "qemu_virt_reference_only": True,
        "renode_reference_only": True,
        "blockers_to_on_chip_os_boot": on_chip_blockers,
        "blockers_to_minimum_linux_npu_target": minimum_target_blockers,
        "remaining_blockers": blocked_items(results),
        "failures": failed_items(results),
        "artifacts": evidence_artifacts(),
        "manifest_paths": [
            "build/reports/mvp_simulator.json",
            "build/chipyard/eliza_rocket/verilator-linux-smoke.json",
            "build/reports/mvp_npu_ml_smoke.json",
            "build/chipyard/eliza_rocket/ElizaRocketConfig.manifest.json",
        ],
        "claim_boundary": "Simulator MVP separates qemu-virt/Renode/Android reference evidence from OS running on generated Eliza AP/e1-chip RTL. qemu_os_boot may be claimed only as reference_qemu_virt_os_boot_claim. Renode smoke is renode_reference_only unless a generated e1-chip hardware model and transcript are archived. OS on our chip may be claimed only when on_chip_os_boot_claim is true from generated AP/Linux evidence; qemu-virt, Renode, and Android simulator evidence do not satisfy that claim. The minimum Linux+NPU target may be claimed only when minimum_linux_npu_target_claim is true from one generated-AP Linux transcript that also contains the e1 NPU ML smoke PASS markers; local NPU runtime smoke alone does not satisfy the integrated target. It is not a fabrication or phone-class performance claim.",
        "results": results,
    }
    tmp = REPORT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    tmp.replace(REPORT)

    print(f"MVP simulator {overall}; wrote {REPORT.relative_to(ROOT)}")
    print(f"  strongest_attempted: {report['strongest_attempted']}")
    print(
        f"  best_executable_evidence: {report['best_executable_evidence']} "
        f"({report['best_executable_tier']})"
    )
    print(
        f"  best_reference_evidence: {report['best_reference_evidence']} "
        f"({report['best_reference_tier']})"
    )
    print(
        f"  reference_qemu_virt_os_boot_claim: {str(report['reference_qemu_virt_os_boot_claim']).lower()}"
    )
    print(f"  on_chip_os_boot_claim: {str(report['on_chip_os_boot_claim']).lower()}")
    print(f"  npu_ml_smoke_claim: {str(report['npu_ml_smoke_claim']).lower()}")
    print(
        f"  integrated_linux_npu_ml_claim: {str(report['integrated_linux_npu_ml_claim']).lower()}"
    )
    print(
        f"  minimum_linux_npu_target_claim: {str(report['minimum_linux_npu_target_claim']).lower()}"
    )
    for item in results:
        print(f"  - {item['name']}: {item['status']}")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
