#!/usr/bin/env python3
"""Build a requirement-by-requirement evidence matrix for chip OS bring-up.

This matrix is deliberately stricter than individual static contract gates. A
static PASS can be useful, but it is not proof that Linux/AOSP booted on the
chip emulator, that Eliza is HOME/foreground, or that the agent is live.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPORT_DIR = ROOT / "build/reports"
REPORT = REPORT_DIR / "chip-os-objective-evidence-matrix.json"

SCHEMA = "eliza.chip_os_objective_evidence_matrix.v1"
CLAIM_BOUNDARY = "objective_evidence_matrix_only_not_boot_or_launcher_evidence"

PROVEN = "proven"
BLOCKED = "blocked"
MISSING = "missing"
WEAK = "weak_static_only"


@dataclass(frozen=True)
class Requirement:
    ident: str
    area: str
    description: str
    required_report: str
    required_status: str = "pass"
    proof_kind: str = "runtime"
    static_only: bool = False
    required_fields: tuple[tuple[str, object], ...] = ()
    closure_evidence: str = ""


REQUIREMENTS: tuple[Requirement, ...] = (
    Requirement(
        "environment_preflight",
        "workflow",
        "Host tools, external checkout env vars, smoke commands, and required evidence paths are available for the chip/Linux/AOSP bring-up checks.",
        "chip-os-environment-preflight.json",
        proof_kind="workflow",
        closure_evidence="Environment preflight status=pass with qemu-system-riscv64, renode, verilator, AOSP_DIR, ELIZA_* trees, CHIPYARD_LINUX_BINARY, writable output paths, and launcher runtime evidence inputs available.",
    ),
    Requirement(
        "generated_ap_linux_boot",
        "linux",
        "Generated Chipyard/Eliza AP simulator boots Linux beyond banner to init/userland markers.",
        "chipyard_verilator_linux_smoke.json",
        closure_evidence="Chipyard Verilator smoke report status=pass with accepted OpenSBI, Linux command-line/initramfs/init, and PASS markers.",
    ),
    Requirement(
        "linux_fork_chip_boot",
        "linux",
        "Linux fork boots on the selected Eliza chip/AP emulator target, not only qemu-virt.",
        "os_rv64_chip_boot_contract.json",
        closure_evidence="OS RV64 chip boot contract status=pass with a chip-target boot evidence row and generated-AP/chip-emulator transcript.",
    ),
    Requirement(
        "linux_agent_liveness",
        "linux",
        "Linux fork starts the Eliza agent and proves active service plus health/API readiness.",
        "os_rv64_chip_boot_contract.json",
        closure_evidence="Linux boot evidence includes elizaos-agent-ready or active systemd service plus localhost health/API smoke.",
    ),
    Requirement(
        "software_bsp_external_evidence",
        "linux",
        "Buildroot, Linux, OpenSBI, and AOSP BSP scaffolds are backed by external build/boot evidence.",
        "software_bsp.json",
        closure_evidence="Software BSP report status=pass with no scaffold errors and no missing external evidence blockers.",
    ),
    Requirement(
        "firmware_boot_chain",
        "linux",
        "OpenSBI/U-Boot/rootfs firmware handoff chain is captured for the selected chip/AP target.",
        "linux_firmware_boot_chain_contract.json",
        closure_evidence="Firmware boot-chain contract status=pass with Buildroot, OpenSBI, U-Boot, and handoff transcripts.",
    ),
    Requirement(
        "chip_abi_dts_peripherals",
        "chip",
        "Boot target exposes the e1 chip ABI, memory map, interrupts, UART, NPU/DMA/display nodes, and not only Chipyard reference devices.",
        "chipyard_ap_abi_contract.json",
        closure_evidence="Chipyard/AP ABI contract status=pass or a declared e1-compatible AP DTS/DTB bridge with Linux driver smoke evidence.",
    ),
    Requirement(
        "linux_android_memory_platform",
        "chip",
        "Linux and Android memory/platform projections are backed by build, DTB, serial boot, OpenSBI, Buildroot, and MMIO smoke evidence.",
        "linux_memory_platform_contract.json",
        closure_evidence="Linux memory/platform report status=pass with all required evidence producers present.",
    ),
    Requirement(
        "aosp_full_virtual_device_boot",
        "aosp",
        "AOSP full evidence boots the selected virtual device and completes required Cuttlefish/QEMU/Renode/CTS-VTS stages.",
        "android_sim_boot.json",
        required_fields=(("require_full_evidence", True),),
        closure_evidence="Android simulator boot report status=pass with require_full_evidence=true and every required evidence path attempted.",
    ),
    Requirement(
        "aosp_chip_handoff",
        "aosp",
        "AOSP handoff flow uses a real checkout/toolchain and target-specific QEMU/Renode/chip-emulator boot commands.",
        "aosp_linux_handoff_contract.json",
        closure_evidence="AOSP Linux handoff contract status=pass with AOSP_DIR/tooling and non-placeholder boot commands.",
    ),
    Requirement(
        "android_launcher_foreground",
        "launcher",
        "Android boots to Eliza as HOME/foreground on the selected riscv64/chip-emulator product.",
        "android_launcher_runtime_evidence.json",
        closure_evidence="Launcher runtime evidence status=pass with sys.boot_completed=1, HOME role/resolve, foreground activity, package grants, and clean logcat.",
    ),
    Requirement(
        "android_agent_health",
        "agent",
        "Android Eliza local agent service is running and /api/health reports ready.",
        "android_launcher_runtime_evidence.json",
        closure_evidence="Launcher runtime evidence status=pass with service process, /api/health HTTP 200, ready=true, and no crash loop.",
    ),
    Requirement(
        "android_app_riscv64_payload",
        "agent",
        "Android APK and agent payload contain riscv64 native libraries/assets and aligned package/service/API contracts.",
        "android_app_runtime_contract.json",
        closure_evidence="Android app runtime contract status=pass and booted runtime smoke confirms extraction/start on riscv64.",
    ),
    Requirement(
        "cross_fork_agent_payload_static_contract",
        "agent",
        "Linux and Android consume a shared riscv64 agent payload contract.",
        "cross_fork_agent_payload_contract.json",
        proof_kind="static",
        static_only=True,
        closure_evidence="Static cross-fork payload contract status=pass; runtime liveness still requires separate Linux and Android agent evidence.",
    ),
    Requirement(
        "phone_runtime_surfaces",
        "runtime",
        "Display/HWC/camera/audio/radio/sensor/PMIC/power/thermal runtime surfaces needed for no-issues phone-like operation are proven.",
        "phone_runtime_readiness_contract.json",
        closure_evidence="Phone runtime readiness contract status=pass with real runtime evidence for all required surfaces.",
    ),
    Requirement(
        "os_rv64_qemu_tooling",
        "workflow",
        "OS-side qemu-virt smoke can run in the current environment and validate its evidence.",
        "qemu_virt_smoke.json",
        closure_evidence="qemu_virt_smoke report status=pass with boot_completed=true and required ElizaOS markers.",
    ),
    Requirement(
        "aggregate_blocker_traceability",
        "workflow",
        "Every current nonpassing aggregate gate has a detailed structured report.",
        "chip-os-boot-gap-inventory.json",
        required_status="blocked",
        required_fields=(("summary.uncovered_nonpassing_gates", 0),),
        proof_kind="workflow",
        closure_evidence="Boot-gap inventory reports uncovered_nonpassing_gates=0.",
    ),
)


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def load_json(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def nested(data: dict[str, Any], dotted: str) -> object:
    current: object = data
    for part in dotted.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def report_findings(data: dict[str, Any]) -> list[str]:
    findings = data.get("findings", [])
    if not isinstance(findings, list):
        return []
    codes: list[str] = []
    for finding in findings:
        if isinstance(finding, dict):
            code = finding.get("code")
            if isinstance(code, str):
                codes.append(code)
    return codes


def evaluate_requirement(req: Requirement, report_dir: Path) -> dict[str, Any]:
    path = report_dir / req.required_report
    data = load_json(path)
    if data is None:
        return {
            "id": req.ident,
            "area": req.area,
            "description": req.description,
            "proof_state": MISSING,
            "proof_kind": req.proof_kind,
            "source_report": rel(path),
            "current_status": None,
            "closure_evidence": req.closure_evidence,
            "findings": ["required report is missing or invalid JSON"],
        }

    findings: list[str] = []
    status = data.get("status")
    if status != req.required_status:
        findings.append(f"report status is {status!r}, expected {req.required_status!r}")
    for field, expected in req.required_fields:
        observed = nested(data, field)
        if observed != expected:
            findings.append(f"{field} is {observed!r}, expected {expected!r}")

    if findings:
        proof_state = BLOCKED
    elif req.static_only:
        proof_state = WEAK
        findings.append("static contract passes but does not prove runtime boot, launcher, or agent liveness")
    else:
        proof_state = PROVEN

    blocker_codes = report_findings(data)
    return {
        "id": req.ident,
        "area": req.area,
        "description": req.description,
        "proof_state": proof_state,
        "proof_kind": req.proof_kind,
        "source_report": rel(path),
        "current_status": status,
        "closure_evidence": req.closure_evidence,
        "findings": findings,
        "source_finding_codes": blocker_codes[:25],
    }


def build_matrix(report_dir: Path) -> dict[str, Any]:
    rows = [evaluate_requirement(req, report_dir) for req in REQUIREMENTS]
    counts: dict[str, int] = {}
    areas: dict[str, dict[str, int]] = {}
    for row in rows:
        state = str(row["proof_state"])
        area = str(row["area"])
        counts[state] = counts.get(state, 0) + 1
        areas.setdefault(area, {})
        areas[area][state] = areas[area].get(state, 0) + 1
    status = "pass" if counts == {PROVEN: len(rows)} else "blocked"
    return {
        "schema": SCHEMA,
        "status": status,
        "claim_boundary": CLAIM_BOUNDARY,
        "summary": {
            "requirements": len(rows),
            "proven": counts.get(PROVEN, 0),
            "blocked": counts.get(BLOCKED, 0),
            "missing": counts.get(MISSING, 0),
            "weak_static_only": counts.get(WEAK, 0),
            "areas": areas,
        },
        "requirements": rows,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report-dir", default=str(REPORT_DIR))
    parser.add_argument("--report", default=str(REPORT))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    matrix = build_matrix(Path(args.report_dir))
    output = Path(args.report)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(matrix, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    summary = matrix["summary"]
    print(
        f"STATUS: {str(matrix['status']).upper()} chip_os_objective_evidence_matrix "
        f"requirements={summary['requirements']} proven={summary['proven']} "
        f"blocked={summary['blocked']} missing={summary['missing']} "
        f"weak_static_only={summary['weak_static_only']} report={rel(output)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
