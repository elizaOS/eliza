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
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPORT_DIR = ROOT / "build/reports"
REPORT = REPORT_DIR / "chip-os-objective-evidence-matrix.json"

SCHEMA = "eliza.chip_os_objective_evidence_matrix.v1"
CLAIM_BOUNDARY = "objective_evidence_matrix_only_not_boot_or_launcher_evidence"
FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "boot_claim_allowed": False,
    "linux_boot_claim_allowed": False,
    "android_boot_claim_allowed": False,
    "launcher_runtime_claim_allowed": False,
    "agent_liveness_claim_allowed": False,
    "hardware_boot_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}

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
        "Generated Chipyard/Eliza AP simulator reaches the accepted Linux completion boundary for its current smoke mode.",
        "chipyard_verilator_linux_smoke.json",
        closure_evidence="Chipyard Verilator smoke report status=pass with either accepted OpenSBI/Linux command-line/initramfs/init markers or the intentionally quiet FireMarshal workload/TestDriver completion boundary; OS fork and launcher/agent proof remain separate requirements.",
    ),
    Requirement(
        "cpu_ap_completion_scope",
        "chip",
        "CPU/AP completion scope allows the generated Rocket AP Linux/NPU/AP-benchmark bring-up claim instead of a scaffold or incomplete transcript claim.",
        "cpu_ap_scope.json",
        closure_evidence="CPU/AP scope report must reach status=pass with generated_ap_scope_claim_allowed=true, release_claim_allowed=false, completion claimed, required generated AP transcripts present, and no missing Linux/RV64GC/AP benchmark evidence; phone-class, Android, power, thermal, process-corner, silicon, and release claims remain blocked separately.",
    ),
    Requirement(
        "cpu_ap_boot_readiness",
        "chip",
        "Generated AP boot readiness combines generated artifacts, Verilator Linux smoke, and Linux boot artifact prerequisites without creating boot evidence itself.",
        "cpu_ap_boot_readiness.json",
        closure_evidence="CPU/AP boot readiness report status=pass with generated manifest/verilog/DTS present, generated AP Linux smoke passing, and Linux boot artifact manifest entries present.",
    ),
    Requirement(
        "chipyard_payload_path_completeness",
        "chip",
        "Generated Chipyard payload path has the CPU/AP evidence logs needed before external OpenSBI/U-Boot/Linux payload claims can be reviewed.",
        "chipyard_payload_path.json",
        closure_evidence="Chipyard payload path report status=pass with Linux boot, OpenSBI boot, trap/timer/IRQ, ISA/cache/MMU, and AP benchmark evidence captured from exact external commands.",
    ),
    Requirement(
        "core_selection_phone_class_pin",
        "chip",
        "Selected CPU/AP core path has a real upstream pin or explicitly chosen alternative capable of the phone-class Linux/AOSP objective.",
        "core_selection.json",
        proof_kind="static",
        closure_evidence="Core selection report status=pass with a real big-core upstream commit or an explicitly selected phone-class CPU path, not a license/procurement blocker.",
    ),
    Requirement(
        "rva23_aosp_profile_readiness",
        "chip",
        "RISC-V RVA23/toolchain/AOSP profile inputs are pinned and checked for Android/Linux compatibility.",
        "rva23_compliance.json",
        proof_kind="static",
        closure_evidence="RVA23 compliance report status=pass with required RISC-V toolchain, profile matrix, and AOSP branch inputs pinned and checked.",
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
        "Buildroot, Linux, OpenSBI, U-Boot, and AOSP BSP scaffolds are backed by external build/boot evidence.",
        "software_bsp_scope.json",
        closure_evidence="Software BSP scope report status=pass only after external Buildroot image, Linux kernel/DTB/boot, OpenSBI handoff, U-Boot boot-chain, AOSP boot/compatibility, CTS/VTS, NNAPI, and release-claim evidence are all present.",
    ),
    Requirement(
        "linux_multiarch_gui_parity",
        "linux",
        "Debian arm64 and riscv64 ISO builds both carry the graphical kiosk payload and have promoted multiarch boot evidence.",
        "linux_multiarch_gui_parity.json",
        closure_evidence="Linux multiarch GUI parity report status=pass with arm64 and riscv64 GUI/kiosk ISO reports passing and each architecture promoted to candidate in the multiarch boot matrix with ISO plus boot evidence.",
    ),
    Requirement(
        "software_bsp_scaffold_inventory",
        "linux",
        "Local software BSP scaffold inventory remains tracked but cannot be promoted as Linux/AOSP boot or compatibility evidence.",
        "software_bsp.json",
        proof_kind="static",
        closure_evidence="Software BSP scaffold inventory status=pass remains only scaffold coverage; external Buildroot/Linux/OpenSBI/AOSP evidence must pass separately before readiness claims.",
    ),
    Requirement(
        "firmware_boot_chain",
        "linux",
        "OpenSBI/U-Boot/rootfs firmware handoff chain is captured for the selected chip/AP target.",
        "linux_firmware_boot_chain_contract.json",
        closure_evidence="Firmware boot-chain contract status=pass with Buildroot, OpenSBI, U-Boot, and handoff transcripts.",
    ),
    Requirement(
        "linux_boot_artifact_manifest",
        "linux",
        "Linux kernel, DTB, OpenSBI handoff, rootfs/initramfs, generated-AP serial boot, and e1 MMIO smoke artifacts are captured from the selected target.",
        "linux_boot_artifacts.json",
        closure_evidence="Linux boot artifact report status=pass with kernel build, dtbs_check, OpenSBI handoff, rootfs/initramfs manifest, generated-AP serial boot, and e1 MMIO smoke artifacts captured without placeholder/BLOCKED sidecars.",
    ),
    Requirement(
        "minimum_linux_kernel_target",
        "linux",
        "Minimum Linux target has kernel build, DTB check, serial boot, and e1 MMIO smoke evidence for the chip/AP target.",
        "minimum-linux-kernel-target.json",
        closure_evidence="Minimum Linux kernel target report status=pass with kernel build, dtbs_check, serial OpenSBI/Linux boot transcript, and e1 MMIO smoke transcript captured from the selected target.",
    ),
    Requirement(
        "platform_contract_consistency",
        "chip",
        "Platform contract boot ROM words, generated artifacts, RTL consumers, and OS DTS consumers agree before any OS handoff claim.",
        "platform_contract.json",
        proof_kind="static",
        closure_evidence="Platform contract report status=pass with boot ROM identity/version/vector words matching the contract and generated RTL/OS consumers regenerated from the same source.",
    ),
    Requirement(
        "boot_security_chain_contract",
        "chip",
        "Boot/reset/security chain is compatible with a CPU-capable AP target and has no placeholder boot-vector or spec-only secure-boot links.",
        "boot_security_chain_contract.json",
        proof_kind="static",
        closure_evidence="Boot security-chain contract status=pass with CPU-capable platform contract, non-placeholder reset ROM handoff, secure boot/AVB/rollback/key provisioning implementation evidence, and negative tamper transcripts.",
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
        "aosp_hal_service_liveness",
        "aosp",
        "AOSP product packages, declares, starts, and validates chip HAL services against the selected e1 Linux ABI.",
        "aosp_hal_service_contract.json",
        closure_evidence="AOSP HAL service contract status=pass with generated HIDL/interface packaging, VINTF, init, SELinux, PRODUCT_PACKAGES, Linux ABI constants, and booted checkvintf/lshal/service evidence aligned.",
    ),
    Requirement(
        "android_evidence_capture_strictness",
        "aosp",
        "Android evidence capture rejects version-only QEMU logs, source-scan CTS/VTS placeholders, and non-launcher runtime evidence.",
        "android_evidence_capture_contract.json",
        proof_kind="workflow",
        closure_evidence="Android evidence-capture contract status=pass with real AOSP boot transcripts, launcher runtime evidence, agent health evidence, and Tradefed CTS/VTS output replacing source/version placeholders.",
    ),
    Requirement(
        "android_release_readiness",
        "aosp",
        "Android release manifests, installers, and post-flash checks include the chip/riscv64 target plus launcher and agent validation.",
        "android_release_readiness_contract.json",
        proof_kind="workflow",
        closure_evidence="Android release readiness contract status=pass with real hashes/sizes, chip/riscv64 artifact, boot validation, HOME/foreground checks, agent health, logcat, and SELinux scans in release and post-flash flows.",
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
        "android_system_apk_payload",
        "agent",
        "Staged AOSP system APK carries the riscv64 local-agent payload, native loader libraries, and build provenance needed by the chip product image.",
        "android_system_apk_payload.json",
        proof_kind="static",
        closure_evidence="Android system APK payload report status=pass with assets/agent/riscv64, lib/riscv64 runtime entries, manifest package, and META-INF/eliza/aosp-build-provenance.json present before booted extraction/start smoke.",
    ),
    Requirement(
        "android_identity_contract",
        "launcher",
        "Android app, AOSP vendor layer, chip smoke scripts, and operator docs agree on package id, HOME role target, service component, and health endpoint.",
        "chip-os-identity-contract.json",
        proof_kind="workflow",
        closure_evidence="Identity contract status=pass with one package id, one ElizaAgentService component, HOME overlays/permissions/scripts aligned, /api/health primary, and no stale legacy identity docs.",
    ),
    Requirement(
        "cross_fork_agent_payload_static_contract",
        "agent",
        "Linux and Android consume a shared riscv64 agent payload contract.",
        "cross_fork_agent_payload_contract.json",
        proof_kind="static",
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
        "minimum_linux_npu_target",
        "runtime",
        "Minimum Linux+NPU target proves target-side e1 NPU ML smoke on generated-AP Linux before NNAPI or phone-class acceleration claims.",
        "minimum_linux_npu_target.json",
        closure_evidence="Minimum Linux+NPU target report status=pass with minimum Linux target passing, target-side e1-npu ML smoke transcript, and generated-AP Linux/NPU evidence captured.",
    ),
    Requirement(
        "android_simulated_peripheral_evidence",
        "runtime",
        "Required Android phone peripheral probes pass on the selected target instead of archived blocked logs.",
        "android_simulated_peripheral_evidence.json",
        closure_evidence="Android simulated peripheral evidence status=pass with RESULT=0/status=PASS logs for camera, microphone, speaker, Wi-Fi, Bluetooth, and cellular surfaces or an explicitly scoped product milestone that removes them from the objective.",
    ),
    Requirement(
        "android_system_bridge_runtime",
        "runtime",
        "Android system bridge is packaged, permissioned, registered, and consumed by the launcher on a booted product rather than only statically contracted.",
        "android_system_bridge_contract.json",
        proof_kind="static",
        static_only=True,
        closure_evidence="Static Android system bridge contract remains pass, and separate booted runtime evidence proves the bridge service is registered, privileged, non-mock in production, and consumed by the UI.",
    ),
    Requirement(
        "optimization_runtime_evidence",
        "runtime",
        "CPU/AP, NPU, memory, cache, power, thermal, benchmark, and SOTA optimization evidence is target-specific enough to support no-issues runtime claims.",
        "chip-os-optimization-gap-inventory.json",
        proof_kind="workflow",
        closure_evidence="Optimization gap inventory status=pass with no modeled/reference-only, local-host, missing target measurement, false readiness, timeout, or release-blocked optimization evidence for the selected Linux/AOSP chip-emulator target.",
    ),
    Requirement(
        "os_rv64_qemu_tooling",
        "workflow",
        "OS-side qemu-virt smoke can run in the current environment and validate its evidence.",
        "qemu_virt_smoke.json",
        closure_evidence="qemu_virt_smoke report status=pass with boot_completed=true and required ElizaOS markers.",
    ),
    Requirement(
        "mvp_simulator_claim_boundary",
        "workflow",
        "MVP simulator orchestration separates reference QEMU/Renode/Android evidence from generated-AP/chip boot evidence and does not hide failed prerequisite stages.",
        "mvp_simulator.json",
        proof_kind="workflow",
        closure_evidence="MVP simulator report status=pass with Android/QEMU/generated-AP stages either passing within their declared claim boundary or explicitly excluded from readiness claims; no timed-out, failed, or stale prerequisite stage may be promoted.",
    ),
    Requirement(
        "evidence_provenance_hygiene",
        "workflow",
        "Evidence artifacts are portable, timestamped, claim-scoped, and free of placeholder/blocked markers before they are used for boot or launcher claims.",
        "chip-os-evidence-provenance.json",
        proof_kind="workflow",
        closure_evidence="Evidence provenance audit status=pass with no host-local paths, missing timestamps, missing claim boundaries, reference-only scope leaks, placeholders, or blocked/fail markers in the surveyed evidence surface.",
    ),
    Requirement(
        "gap_marker_inventory",
        "workflow",
        "Source-level open-task, stub, placeholder, unsupported, deferred, and blocked markers across chip, Linux, AOSP, and app paths are classified or removed before readiness claims.",
        "chip-os-gap-keyword-inventory.json",
        proof_kind="workflow",
        closure_evidence="Gap keyword inventory status=pass with no unclassified open-task/stub/placeholder/mock/fake/unsupported/deferred/blocked markers in the surveyed chip, OS, Android vendor, and launcher/agent source paths.",
    ),
    Requirement(
        "report_freshness_hygiene",
        "workflow",
        "Survey and aggregate detail reports are regenerated after checker/source edits before being used as current boot, launcher, agent, or optimization evidence.",
        "chip-os-report-freshness.json",
        proof_kind="workflow",
        closure_evidence="Report freshness audit status=pass with no missing, stale, or source-missing reports across base survey reports and aggregate gate detail reports.",
    ),
    Requirement(
        "pd_evidence_schema_hygiene",
        "workflow",
        "PD evidence manifests are well-formed and cannot be mistaken for release support while required blockers/source artifacts are absent.",
        "pd_evidence_gates.json",
        proof_kind="workflow",
        closure_evidence="PD evidence gate status=pass with every PD manifest declaring valid status, release_use, source_artifacts, and release_blockers fields before any physical evidence is used as readiness support.",
    ),
    Requirement(
        "product_feature_manifest_hygiene",
        "workflow",
        "Product-feature evidence manifest and referenced scope reports remain fail-closed and structurally complete.",
        "product_feature_gates.json",
        proof_kind="workflow",
        closure_evidence="Product feature gate status=pass with security lifecycle and other feature scope reports containing required fail-closed terms and no missing readiness blockers.",
    ),
    Requirement(
        "prototype_dashboard_freshness",
        "workflow",
        "Prototype/status dashboard rows match current gate output and cannot show stale PASS rows for failing blockers.",
        "prototype_status_dashboard.json",
        proof_kind="workflow",
        closure_evidence="Prototype dashboard status=pass with MVP rows regenerated from current gate output, including platform-contract and other strict blocker states.",
    ),
    Requirement(
        "aggregate_blocker_traceability",
        "workflow",
        "Every current nonpassing aggregate gate and nonpassing detail report has structured blocker rows.",
        "chip-os-boot-gap-inventory.json",
        required_status="blocked",
        required_fields=(
            ("summary.uncovered_nonpassing_gates", 0),
            ("summary.nonpassing_reports_without_structured_details", 0),
        ),
        proof_kind="workflow",
        closure_evidence="Boot-gap inventory reports uncovered_nonpassing_gates=0 and nonpassing_reports_without_structured_details=0.",
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


def code_from_text(text: str, fallback: str) -> str:
    cleaned = "".join(char.lower() if char.isalnum() else "_" for char in text)
    parts = [part for part in cleaned.split("_") if part]
    return "_".join(parts[:10]) or fallback


def code_from_struct(kind: str, value: dict[str, Any]) -> str:
    raw = value.get("code") or value.get("name") or value.get("gate")
    if not isinstance(raw, str) or not raw:
        raw = str(value.get("message") or value.get("detail") or kind)
    return code_from_text(f"{kind}_{raw}", kind)


def detail_kind_for_key(key: str) -> str:
    if key == "entries":
        return "entry"
    return key[:-1] if key.endswith("s") else key


def list_values(value: object) -> list[object]:
    return value if isinstance(value, list) else []


def report_findings(data: dict[str, Any]) -> list[str]:
    codes: list[str] = []
    seen: set[str] = set()
    for key in (
        "findings",
        "blockers",
        "errors",
        "failures",
        "entries",
        "blockers_to_on_chip_os_boot",
        "blockers_to_minimum_linux_npu_target",
    ):
        values = data.get(key, [])
        if not isinstance(values, list):
            continue
        kind = detail_kind_for_key(key)
        for value in values:
            code: str | None = None
            if isinstance(value, dict):
                raw_code = value.get("code")
                code = (
                    raw_code
                    if isinstance(raw_code, str) and raw_code
                    else code_from_struct(kind, value)
                )
            elif isinstance(value, str) and value.strip():
                code = code_from_text(value, kind)
            if code and code not in seen:
                seen.add(code)
                codes.append(code)
    return codes


def report_next_commands(data: dict[str, Any]) -> list[str]:
    commands: list[str] = []
    for value in list_values(data.get("findings")):
        if not isinstance(value, dict):
            continue
        next_command = value.get("next_command")
        if isinstance(next_command, str) and next_command:
            commands.append(next_command)
        for command in list_values(value.get("next_commands")):
            if isinstance(command, str) and command:
                commands.append(command)
    for batch in list_values(data.get("next_command_plan")):
        if not isinstance(batch, dict):
            continue
        for command in list_values(batch.get("commands")):
            if isinstance(command, str) and command:
                commands.append(command)
    return list(dict.fromkeys(commands))


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
            "primary_report": rel(path),
            "source_report": rel(path),
            "current_status": None,
            "closure_evidence": req.closure_evidence,
            "findings": ["required report is missing or invalid JSON"],
            "next_command": None,
            "next_commands": [],
        }

    findings: list[str] = []
    status = data.get("status")
    normalized_status = status.lower() if isinstance(status, str) else status
    if normalized_status != req.required_status:
        findings.append(f"report status is {status!r}, expected {req.required_status!r}")
    for field, expected in req.required_fields:
        observed = nested(data, field)
        if observed != expected:
            findings.append(f"{field} is {observed!r}, expected {expected!r}")

    if findings:
        proof_state = BLOCKED
    elif req.static_only:
        proof_state = WEAK
        findings.append(
            "static contract passes but does not prove runtime boot, launcher, or agent liveness"
        )
    else:
        proof_state = PROVEN

    blocker_codes = report_findings(data)
    next_commands = report_next_commands(data)
    return {
        "id": req.ident,
        "area": req.area,
        "description": req.description,
        "proof_state": proof_state,
        "proof_kind": req.proof_kind,
        "primary_report": rel(path),
        "source_report": rel(path),
        "current_status": status,
        "closure_evidence": req.closure_evidence,
        "findings": findings,
        "source_finding_codes": blocker_codes[:25],
        "next_command": next_commands[0] if next_commands else None,
        "next_commands": next_commands[:25],
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
        "generated_utc": datetime.now(UTC).isoformat(),
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
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
    parser.add_argument("--json-only", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    matrix = build_matrix(Path(args.report_dir))
    output = Path(args.report)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(matrix, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if args.json_only:
        print(json.dumps(matrix, indent=2, sort_keys=True))
        return 0
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
