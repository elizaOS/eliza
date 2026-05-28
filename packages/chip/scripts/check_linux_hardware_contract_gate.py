#!/usr/bin/env python3
"""Fail-closed gate for the local RTL Linux hardware contract boundary."""

from __future__ import annotations

import json
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
GATE = ROOT / "docs/evidence/linux-hardware-contract-gate.yaml"
LINUX_DOC = ROOT / "docs/arch/linux-capable-cpu-contract.md"
CPU_DOC = ROOT / "docs/arch/cpu-subsystem.md"
CPU_RTL = ROOT / "rtl/cpu/e1_tiny_cpu_contract.sv"
CPU_ALIAS_RTL = ROOT / "rtl/cpu/e1_cpu_subsystem_stub.sv"
CONTRACT_RTL = ROOT / "rtl/interconnect/e1_linux_soc_contract.sv"
INTC_RTL = ROOT / "rtl/interrupts/e1_interrupt_controller.sv"
DRAM_RTL = ROOT / "rtl/memory/e1_axi_lite_dram.sv"
QEMU_DOC = ROOT / "docs/sim/qemu/README.md"
QEMU_PAYLOAD_PLAN = ROOT / "docs/evidence/linux/qemu-virt-linux-payload-plan.json"
RUN_QEMU = ROOT / "scripts/run_qemu.sh"
QEMU_OS_ATTEMPT_MANIFEST = ROOT / "build/reports/qemu_os_boot_attempt.json"

REQUIRED_AXES = {
    "rv64gc_privileged_cpu",
    "mmu_sv39_or_stronger",
    "boot_rom_firmware_opensbi",
    "dram_capacity_boot_memory",
    "timer_clint_aclint",
    "interrupt_plic_compat",
    "uart_early_console",
    "dtb_linux_nodes",
    "linux_initramfs_smoke",
}

REQUIRED_DOC_TOKENS = {
    LINUX_DOC: [
        "not a Linux-capable hart",
        "RV64 privileged M-mode",
        "S-mode support",
        "CLINT-compatible",
        "External interrupt target",
        "OpenSBI",
        "Linux early console",
        "Exact Linux-Capable Gate States",
        "cannot satisfy any generated",
        "docs/evidence/linux-hardware-contract-gate.yaml",
    ],
    CPU_DOC: [
        "not a Linux-capable",
        "RV64GC",
        "privilege modes",
        "CLINT",
        "PLIC",
        "MMU",
        "OpenSBI",
    ],
    QEMU_DOC: [
        "qemu-virt software reference only",
        "not the e1-chip hardware ABI",
        "not e1-chip hardware or generated AP evidence",
        "cannot be used as Eliza AP",
    ],
}

CPU_LINUX_FEATURE_TOKENS = {
    "satp",
    "mstatus",
    "mtvec",
    "mepc",
    "mcause",
    "medeleg",
    "mideleg",
    "sstatus",
    "stvec",
    "sepc",
    "scause",
    "sret",
    "mret",
}

CONTRACT_WRAPPER_BLOCKED_TOKENS = {
    "uart": "UART is still declared blocked by the manifest",
    "mtime": "CLINT/ACLINT timer is still declared blocked by the manifest",
    "mtimecmp": "CLINT/ACLINT timer is still declared blocked by the manifest",
    "msip": "CLINT/ACLINT software interrupt is still declared blocked by the manifest",
}


def read(path: Path) -> str:
    return path.read_text(errors="ignore")


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def valid_relative_path(value: object) -> bool:
    if not isinstance(value, str) or not value:
        return False
    path = Path(value)
    return not path.is_absolute() and ".." not in path.parts


def duplicate_top_level_keys(path: Path) -> list[str]:
    seen: set[str] = set()
    duplicates: list[str] = []
    for line in read(path).splitlines():
        if not line or line.startswith((" ", "#")):
            continue
        match = re.match(r"^([A-Za-z0-9_./-]+):", line)
        if not match:
            continue
        key = match.group(1)
        if key in seen and key not in duplicates:
            duplicates.append(key)
        seen.add(key)
    return duplicates


def load_gate(errors: list[str]) -> dict[str, object]:
    if not GATE.is_file():
        errors.append(f"missing {GATE.relative_to(ROOT)}")
        return {}
    duplicates = duplicate_top_level_keys(GATE)
    require(
        not duplicates,
        f"duplicate top-level keys in {GATE.relative_to(ROOT)}: {duplicates}",
        errors,
    )
    data = yaml.safe_load(read(GATE))
    require(isinstance(data, dict), f"{GATE.relative_to(ROOT)} must contain a mapping", errors)
    return data if isinstance(data, dict) else {}


def check_gate(errors: list[str]) -> None:
    data = load_gate(errors)
    if not data:
        return

    require(
        data.get("schema") == "eliza.linux_hardware_contract_gate.v1",
        "unexpected linux gate schema",
        errors,
    )
    require(
        data.get("status") == "scaffold_only_linux_boot_blocked",
        "linux gate must remain scaffold_only_linux_boot_blocked",
        errors,
    )
    require(
        data.get("claim_boundary") == "local_rtl_scaffold_is_not_linux_boot_evidence",
        "linux gate claim_boundary must forbid local scaffold as Linux evidence",
        errors,
    )

    current = data.get("current_scaffold")
    require(isinstance(current, dict), "current_scaffold must be a mapping", errors)
    if isinstance(current, dict):
        for key in ("cpu_rtl", "linux_contract_wrapper", "memory_rtl", "interrupt_rtl"):
            value = current.get(key)
            require(
                valid_relative_path(value),
                f"current_scaffold.{key} must be a repo-relative path",
                errors,
            )
            if isinstance(value, str):
                require(
                    (ROOT / value).is_file(),
                    f"current_scaffold.{key} does not exist: {value}",
                    errors,
                )
        require(
            current.get("allowed_claim") == "scaffold_checks_only_linux_boot_blocked",
            "current_scaffold.allowed_claim must stay non-claiming",
            errors,
        )

    axes = data.get("blocked_linux_boot_axes")
    require(isinstance(axes, list), "blocked_linux_boot_axes must be a list", errors)
    seen: set[str] = set()
    if isinstance(axes, list):
        for axis in axes:
            require(isinstance(axis, dict), f"axis must be a mapping: {axis!r}", errors)
            if not isinstance(axis, dict):
                continue
            axis_id = axis.get("id")
            require(isinstance(axis_id, str), f"axis missing string id: {axis!r}", errors)
            if isinstance(axis_id, str):
                seen.add(axis_id)
            require(axis.get("status") == "blocked", f"{axis_id} must remain blocked", errors)
            require(
                isinstance(axis.get("current_gap"), str) and axis["current_gap"],
                f"{axis_id} missing current_gap",
                errors,
            )
            evidence = axis.get("required_evidence")
            require(
                isinstance(evidence, list) and bool(evidence),
                f"{axis_id} must list required_evidence",
                errors,
            )
            if isinstance(evidence, list):
                for path in evidence:
                    require(
                        valid_relative_path(path),
                        f"{axis_id} evidence path must be repo-relative: {path!r}",
                        errors,
                    )
            pass_requires = axis.get("pass_requires")
            require(
                isinstance(pass_requires, list) and bool(pass_requires),
                f"{axis_id} must list pass_requires",
                errors,
            )

    require(
        seen == REQUIRED_AXES,
        f"linux gate axes mismatch: missing={sorted(REQUIRED_AXES - seen)} extra={sorted(seen - REQUIRED_AXES)}",
        errors,
    )

    rules = data.get("claim_rules")
    require(
        isinstance(rules, list) and len(rules) >= 3,
        "claim_rules must fail closed with at least three rules",
        errors,
    )
    rules_text = "\n".join(str(rule) for rule in rules) if isinstance(rules, list) else ""
    for token in ("QEMU", "Placeholder", "Linux-capable claim"):
        require(token.lower() in rules_text.lower(), f"claim_rules must mention {token}", errors)

    qemu_boundary = data.get("qemu_reference_boundary")
    require(isinstance(qemu_boundary, dict), "qemu_reference_boundary must be a mapping", errors)
    if isinstance(qemu_boundary, dict):
        require(
            qemu_boundary.get("status") == "reference_only_not_chip_rtl_boot",
            "qemu_reference_boundary.status must remain reference-only",
            errors,
        )
        expected_paths = {
            "run_script": "scripts/run_qemu.sh",
            "os_attempt_manifest": "build/reports/qemu_os_boot_attempt.json",
            "payload_plan": "docs/evidence/linux/qemu-virt-linux-payload-plan.json",
            "qemu_docs": "docs/sim/qemu/README.md",
        }
        for key, expected in expected_paths.items():
            require(
                qemu_boundary.get(key) == expected, f"qemu_reference_boundary.{key} drifted", errors
            )
        require(
            qemu_boundary.get("os_attempt_schema") == "eliza.qemu_virt_os_boot_attempt.v1",
            "qemu OS attempt schema must stay explicit",
            errors,
        )
        require(
            qemu_boundary.get("required_claim_boundary")
            == "qemu_virt_reference_only_not_e1_chip_rtl",
            "qemu OS attempt claim boundary must exclude e1-chip RTL",
            errors,
        )
        require(
            qemu_boundary.get("payload_plan_claim_boundary")
            == "qemu_virt_prebuilt_payload_only_not_e1_hardware",
            "qemu payload plan claim boundary must exclude e1 hardware",
            errors,
        )
        forbidden = qemu_boundary.get("forbidden_as_chip_evidence")
        require(
            isinstance(forbidden, list) and bool(forbidden),
            "qemu boundary must list forbidden chip evidence artifacts",
            errors,
        )
        if isinstance(forbidden, list):
            for path in forbidden:
                require(
                    valid_relative_path(path),
                    f"forbidden qemu artifact must be repo-relative: {path!r}",
                    errors,
                )


def check_docs(errors: list[str]) -> None:
    for path, tokens in REQUIRED_DOC_TOKENS.items():
        require(path.is_file(), f"missing doc {path.relative_to(ROOT)}", errors)
        if not path.is_file():
            continue
        text = read(path)
        for token in tokens:
            require(token in text, f"{path.relative_to(ROOT)} missing token: {token}", errors)

    linux_doc = read(LINUX_DOC) if LINUX_DOC.is_file() else ""
    require(
        "docs/evidence/linux-hardware-contract-gate.yaml" in linux_doc,
        "linux contract doc must reference the machine-readable Linux hardware gate",
        errors,
    )


def check_qemu_reference_boundary(errors: list[str]) -> None:
    require(QEMU_PAYLOAD_PLAN.is_file(), f"missing {QEMU_PAYLOAD_PLAN.relative_to(ROOT)}", errors)
    if QEMU_PAYLOAD_PLAN.is_file():
        try:
            payload_plan = json.loads(read(QEMU_PAYLOAD_PLAN))
        except json.JSONDecodeError as exc:
            errors.append(f"{QEMU_PAYLOAD_PLAN.relative_to(ROOT)} is invalid JSON: {exc}")
            payload_plan = {}
        require(
            payload_plan.get("schema") == "eliza.qemu_virt_linux_payload_plan.v1",
            "QEMU Linux payload plan schema drifted",
            errors,
        )
        require(
            payload_plan.get("claim_boundary") == "qemu_virt_prebuilt_payload_only_not_e1_hardware",
            "QEMU Linux payload plan must remain excluded from e1 hardware claims",
            errors,
        )
        not_claimed = payload_plan.get("not_claimed", [])
        for token in (
            "e1-chip hardware boot",
            "selected AP generated-target boot",
            "Eliza BSP driver runtime proof",
        ):
            require(
                token in not_claimed, f"QEMU payload plan not_claimed must include {token}", errors
            )

    require(RUN_QEMU.is_file(), f"missing {RUN_QEMU.relative_to(ROOT)}", errors)
    if RUN_QEMU.is_file():
        run_qemu = read(RUN_QEMU)
        for token in (
            '"schema": "eliza.qemu_virt_os_boot_attempt.v1"',
            '"claim_boundary": "qemu_virt_reference_only_not_e1_chip_rtl"',
            "qemu-system-riscv64 -machine virt",
            "check=qemu.os_boot",
            "evidence_kind=qemu-os-boot-attempt",
        ):
            require(
                token in run_qemu,
                f"scripts/run_qemu.sh missing QEMU reference boundary token: {token}",
                errors,
            )

    if QEMU_OS_ATTEMPT_MANIFEST.is_file():
        try:
            attempt = json.loads(read(QEMU_OS_ATTEMPT_MANIFEST))
        except json.JSONDecodeError as exc:
            errors.append(f"{QEMU_OS_ATTEMPT_MANIFEST.relative_to(ROOT)} is invalid JSON: {exc}")
            return
        require(
            attempt.get("schema") == "eliza.qemu_virt_os_boot_attempt.v1",
            "QEMU OS attempt manifest schema drifted",
            errors,
        )
        require(
            attempt.get("claim_boundary") == "qemu_virt_reference_only_not_e1_chip_rtl",
            "QEMU OS attempt manifest must not be chip RTL evidence",
            errors,
        )
        require(
            attempt.get("check") == "qemu.os_boot",
            "QEMU OS attempt manifest check must remain qemu.os_boot",
            errors,
        )


def contains_word(text: str, token: str) -> bool:
    return re.search(rf"\b{re.escape(token)}\b", text, flags=re.IGNORECASE) is not None


def check_rtl_scaffold(errors: list[str]) -> None:
    for path in (CPU_RTL, CPU_ALIAS_RTL, CONTRACT_RTL, INTC_RTL, DRAM_RTL):
        require(path.is_file(), f"missing RTL artifact {path.relative_to(ROOT)}", errors)
    if errors:
        return

    cpu = read(CPU_RTL)
    contract = read(CONTRACT_RTL)
    intc = read(INTC_RTL)
    dram = read(DRAM_RTL)

    require(
        "module e1_tiny_cpu_contract" in cpu,
        "tiny CPU contract module name changed; update gate",
        errors,
    )
    alias = read(CPU_ALIAS_RTL)
    require(
        "module e1_cpu_subsystem_stub" in alias and "e1_tiny_cpu_contract" in alias,
        "legacy CPU stub alias must wrap e1_tiny_cpu_contract",
        errors,
    )
    for token in CPU_LINUX_FEATURE_TOKENS:
        require(
            not contains_word(cpu, token),
            f"CPU scaffold now mentions {token}; keep Linux gate blocked and add executable CSR/trap evidence before claiming support",
            errors,
        )

    require(
        "e1_axi_lite_dram" in contract,
        "Linux contract wrapper no longer instantiates checked memory model",
        errors,
    )
    require(
        "e1_interrupt_controller" in contract,
        "Linux contract wrapper no longer instantiates checked interrupt scaffold",
        errors,
    )
    lowered_contract = contract.lower()
    for token, reason in CONTRACT_WRAPPER_BLOCKED_TOKENS.items():
        require(
            token not in lowered_contract,
            f"Linux contract wrapper now mentions {token}; {reason}, so update manifest and evidence gate",
            errors,
        )

    require(
        re.search(r"parameter\s+int(?:\s+unsigned)?\s+DEPTH_WORDS\s*=\s*1024", dram) is not None,
        "DRAM scaffold is no longer the checked 4 KiB default; update Linux memory capacity gate",
        errors,
    )

    lowered_intc = intc.lower()
    for token in ("priority", "threshold", "context"):
        require(
            token not in lowered_intc,
            f"interrupt scaffold now mentions {token}; PLIC compatibility remains blocked until executable evidence exists",
            errors,
        )


def main() -> int:
    errors: list[str] = []
    check_gate(errors)
    check_docs(errors)
    check_qemu_reference_boundary(errors)
    check_rtl_scaffold(errors)
    if errors:
        print("STATUS: FAIL linux_hardware_contract_gate")
        for error in errors:
            print(f"  - {error}")
        return 1
    print(
        "STATUS: PASS linux_hardware_contract_gate - local RTL remains a non-Linux scaffold and all Linux boot axes are blocked"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
