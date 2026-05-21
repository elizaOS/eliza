#!/usr/bin/env python3
"""Fail closed on silent RTL/sim/verification placeholders.

This intentionally covers only Worker A owned paths. It allows named stubs only
when they have an executable test, fail-closed behavior, or a documented blocker.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/stub_audit.json"
OWNED_ROOTS = (ROOT / "rtl", ROOT / "sim", ROOT / "verify")
SKIP_PARTS = {
    "__pycache__",
    "sim_build_e1_chip_top_test_e1_chip.EkHwvK",
    "sim_build",
    "model",
    "engine_0",
    "src",
}
SKIP_SUFFIXES = {".pyc", ".sqlite", ".log", ".xml"}
TERMS = re.compile(
    r"\b(stub|placeholder|TODO|FIXME|not implemented|dummy|mock|scaffold)\b", re.IGNORECASE
)
REQUIRED_GAP_AREAS = (
    "cpu",
    "interconnect",
    "display",
    "dma",
    "npu",
    "bootrom",
    "dram",
    "pass_gates",
)
REQUIRED_GAP_CATEGORIES = {
    "rtl_stub",
    "incomplete_subsystem",
    "test_gap",
    "proof_gap",
    "misleading_pass_gate",
}
REQUIRED_GAP_SEVERITIES = {"critical", "high", "medium", "low"}


@dataclass(frozen=True)
class AllowedFinding:
    path: str
    pattern: str
    rationale: str


ALLOWLIST = (
    AllowedFinding(
        "rtl/cpu/e1_cpu_subsystem_stub.sv",
        "e1_cpu_subsystem_stub",
        "Executable tiny CPU model; covered by verify/cocotb/test_tiny_cpu_execution.py.",
    ),
    AllowedFinding(
        "verify/cocotb/Makefile",
        "e1_cpu_subsystem_stub",
        "Builds the executable tiny CPU model into cocotb simulations.",
    ),
    AllowedFinding(
        "verify/cocotb/e1_tiny_cpu_contract_tb.sv",
        "e1_cpu_subsystem_stub",
        "Testbench instantiates the executable tiny CPU model.",
    ),
    AllowedFinding(
        "docs/sim/qemu/README.md",
        "--build-stub",
        "QEMU README documents the compatibility alias while the preferred path is firmware.",
    ),
    AllowedFinding(
        "verify/cocotb/test_clint_timer_irq.py",
        "CLINT timer interrupt entry contract scaffold",
        "Skipped fail-closed test contract for future CLINT integration.",
    ),
    AllowedFinding(
        "verify/cocotb/test_plic_claim_threshold.py",
        "PLIC enable/threshold/claim contract scaffold",
        "Executable PLIC contract test plus documented future threshold extension.",
    ),
    AllowedFinding(
        "rtl/cpu/e1_cva6_wrapper.sv",
        "same external port list as the stub",
        "CVA6 wrapper documents compatibility with the executable tiny CPU model.",
    ),
    AllowedFinding(
        "rtl/cpu/e1_cva6_wrapper.sv",
        "Stub: safe idle outputs",
        "Fail-closed CVA6-disabled mode ties CPU master outputs idle.",
    ),
    AllowedFinding(
        "rtl/top/e1_soc_top.sv",
        "a stub with all AXI master outputs tied to idle",
        "Top-level CPU integration documents CVA6-disabled fail-closed behavior.",
    ),
    AllowedFinding(
        "rtl/top/e1_soc_top.sv",
        "AXI-Lite scaffold exposes",
        "Interrupt wiring documents the current executable PLIC-lite contract.",
    ),
    AllowedFinding(
        "rtl/top/e1_soc_top.sv",
        "This is a placeholder",
        "Interrupt-complete path is tracked as a known PLIC integration gap.",
    ),
    AllowedFinding(
        "rtl/top/e1_soc_top.sv",
        "replace the stub AXI-Lite mux",
        "CPU/DMA arbitration is tracked as a known interconnect integration gap.",
    ),
    AllowedFinding(
        "rtl/cache/l1d/e1_l1d_cache.sv",
        "corrector is a stub",
        "L1D ECC correction is tracked as a cache implementation gap.",
    ),
    AllowedFinding(
        "rtl/cache/prefetch/e1_pythia_stub.sv",
        "stub",
        "Pythia prefetcher module is explicitly a bounded integration stub.",
    ),
    AllowedFinding(
        "rtl/cpu/cluster/e1_cluster_top.sv",
        "stub",
        "Cluster core wrappers are explicit fail-closed integration placeholders.",
    ),
    AllowedFinding(
        "rtl/cpu/cluster/e1_cluster_top.sv",
        "placeholder",
        "Cluster lite variant is a documented non-production integration placeholder.",
    ),
    AllowedFinding(
        "rtl/cpu/csr/ztso_ctrl.sv",
        "stub",
        "Ztso CSR control is a documented CPU feature gap.",
    ),
    AllowedFinding(
        "rtl/cpu/rvv/rvv_unit_stub.sv",
        "stub",
        "RVV unit is explicitly blocked and covered by CPU/AP evidence docs.",
    ),
    AllowedFinding(
        "rtl/cpu/rvv/rvv_unit_stub.sv",
        "placeholder",
        "RVV unit is explicitly blocked and covered by CPU/AP evidence docs.",
    ),
    AllowedFinding(
        "rtl/interconnect/axi4/e1_axi4_interconnect.sv",
        "scaffold",
        "AXI4 interconnect currently preserves the existing AXI-Lite scaffold boundary.",
    ),
    AllowedFinding(
        "rtl/iommu/e1_riscv_iommu.sv",
        "stub",
        "RISC-V IOMMU model is a bounded verification implementation.",
    ),
    AllowedFinding(
        "rtl/memory/dram_ctrl/e1_dram_ctrl.sv",
        "stub",
        "DRAM controller is a DFI-facing scaffold with blocked production memory evidence.",
    ),
    AllowedFinding(
        "rtl/top/e1_soc_integrated.sv",
        "scaffold",
        "Integrated SoC top carries the documented AXI-Lite scaffold boundary.",
    ),
    AllowedFinding(
        "rtl/top/e1_soc_pkg.sv",
        "scaffold",
        "Shared localparams extracted from both SoC tops' v0 MMIO debug scaffold.",
    ),
    AllowedFinding(
        "rtl/peripherals/e1_clint.sv",
        "scaffold",
        "Bring-up CLINT register block extracted from both SoC tops' v0 MMIO debug scaffold.",
    ),
    AllowedFinding(
        "rtl/peripherals/e1_mmio_decode.sv",
        "scaffold",
        "Shared MMIO address decode extracted from both SoC tops' v0 MMIO debug scaffold.",
    ),
    AllowedFinding(
        "rtl/memory/e1_behavioral_dram.sv",
        "scaffold",
        "Behavioural scratch-DRAM model extracted from both SoC tops' v0 MMIO debug scaffold.",
    ),
    AllowedFinding(
        "rtl/top/e1_soc_integrated.sv",
        "synthesises to a stub that drives the counters",
        "CVA6-disabled integrated SoC shape drives slot-0 observability counters safe-idle.",
    ),
    AllowedFinding(
        "rtl/top/e1_soc_integrated.sv",
        "Stub the CVA6 slot-0 observability ports to zero",
        "CVA6-disabled integrated SoC shape drives slot-0 observability ports safe-idle.",
    ),
    AllowedFinding(
        "verify/cocotb/axi4/e1_dram_ctrl_tb.sv",
        "stub",
        "DFI cocotb test documents the current DRAM-controller scaffold behavior.",
    ),
    AllowedFinding(
        "verify/cocotb/axi4/test_dfi_traffic.py",
        "stub",
        "DFI cocotb test documents the current DRAM-controller scaffold behavior.",
    ),
    AllowedFinding(
        "verify/cocotb/cpu/README.md",
        "stub",
        "CPU cocotb README documents tests that remain blocked on a real core.",
    ),
    AllowedFinding(
        "verify/cocotb/cpu/README.md",
        "placeholder",
        "CPU cocotb README documents tests that remain blocked on a real core.",
    ),
    AllowedFinding(
        "verify/cocotb/cpu/test_csr_trap.py",
        "stub",
        "CSR trap test is explicitly fail-closed until a real CPU wrapper is present.",
    ),
    AllowedFinding(
        "verify/cocotb/cpu/test_csr_trap.py",
        "placeholder",
        "CSR trap test rejects empty core placeholders.",
    ),
    AllowedFinding(
        "verify/cocotb/cpu/test_mmu_sv39.py",
        "stub",
        "Sv39 test is explicitly blocked until a real MMU-capable CPU is present.",
    ),
    AllowedFinding(
        "verify/cocotb/integration/test_cross_domain_interfaces.py",
        "scaffold",
        "Cross-domain integration tests name the current AXI-Lite scaffold boundary.",
    ),
    AllowedFinding(
        "verify/cocotb/integration/test_cross_domain_interfaces.py",
        "stub",
        "Cross-domain integration tests name the current safe-idle CPU fallback.",
    ),
    AllowedFinding(
        "verify/cocotb/integration/test_opensbi_mpxy_to_pmc_rpmi.py",
        "stub-out",
        "PMC RPMI integration tests explicitly block on the remaining SPMI binding work order.",
    ),
    AllowedFinding(
        "verify/cocotb/power/test_pmc_rpmi_envelope.py",
        "placeholder",
        "PMC RPMI test payload uses a non-release rail id marker.",
    ),
)


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def allowed(path: Path, line: str) -> str | None:
    path_s = rel(path)
    for finding in ALLOWLIST:
        if finding.path == path_s and finding.pattern.lower() in line.lower():
            return finding.rationale
    return None


def iter_files() -> list[Path]:
    paths: list[Path] = []
    for root in OWNED_ROOTS:
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            if path.resolve() == Path(__file__).resolve():
                continue
            if path == ROOT / "verify/rtl_gap_work_order.yaml":
                continue
            if any(part in SKIP_PARTS for part in path.parts):
                continue
            if path.suffix in SKIP_SUFFIXES:
                continue
            paths.append(path)
    return sorted(paths)


def check_placeholder_terms() -> tuple[list[str], list[str]]:
    errors: list[str] = []
    inventory: list[str] = []
    for path in iter_files():
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except UnicodeDecodeError:
            continue
        if path == ROOT / "verify/rtl_gap_work_order.yaml":
            continue
        for lineno, line in enumerate(lines, start=1):
            if not TERMS.search(line):
                continue
            rationale = allowed(path, line)
            if rationale is None:
                errors.append(f"{rel(path)}:{lineno}: silent placeholder term: {line.strip()}")
            else:
                inventory.append(f"{rel(path)}:{lineno}: {rationale}")

    print("Allowed placeholder/stub inventory:")
    for item in inventory:
        print(f"  - {item}")
    return errors, inventory


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def check_renode_scaffold() -> list[str]:
    errors: list[str] = []
    readme = (ROOT / "docs/sim/renode/README.md").read_text(encoding="utf-8").lower()
    repl = (ROOT / "sim/renode/eliza_e1.repl").read_text(encoding="utf-8").lower()
    resc = (ROOT / "sim/renode/eliza_e1.resc").read_text(encoding="utf-8").lower()

    require(
        "qemu-virt reference target" in readme,
        "Renode README must label the flow as qemu-virt reference.",
        errors,
    )
    require(
        "not the e1-chip hardware abi" in readme,
        "Renode README must state this is not the e1-chip hardware ABI.",
        errors,
    )
    require(
        "0x80000000" in repl and "0x100000" in repl,
        "Renode REPL must define RAM at the qemu-virt load window.",
        errors,
    )
    require(
        "0x10000000" in repl and ("ns16550" in repl or "litex_uart" in repl),
        "Renode REPL must define the qemu-virt UART window.",
        errors,
    )
    require(
        "loadplatformdescription" in resc and "eliza_e1.repl" in resc,
        "Renode RESC must load the checked-in REPL.",
        errors,
    )
    require("start" in resc, "Renode RESC must start the machine explicitly.", errors)
    return errors


def check_gap_work_order() -> list[str]:
    errors: list[str] = []
    path = ROOT / "verify/rtl_gap_work_order.yaml"
    require(
        path.exists(), "RTL gap work order must exist at verify/rtl_gap_work_order.yaml.", errors
    )
    if errors:
        return errors

    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    require(isinstance(data, dict), "RTL gap work order must be a YAML mapping.", errors)
    if not isinstance(data, dict):
        return errors

    require(
        data.get("fail_closed_required") is True,
        "RTL gap work order must require fail-closed behavior.",
        errors,
    )
    audit_doc = data.get("audit_doc")
    require(
        isinstance(audit_doc, str) and bool(audit_doc),
        "RTL gap work order must name audit_doc.",
        errors,
    )
    if isinstance(audit_doc, str) and audit_doc:
        require((ROOT / audit_doc).is_file(), f"RTL gap audit doc missing: {audit_doc}.", errors)
    required_gap_fields = data.get("required_gap_fields")
    require(
        isinstance(required_gap_fields, list) and bool(required_gap_fields),
        "RTL gap work order must list required_gap_fields.",
        errors,
    )
    areas = data.get("areas")
    require(isinstance(areas, dict), "RTL gap work order must define an areas mapping.", errors)
    if not isinstance(areas, dict):
        return errors

    for area in REQUIRED_GAP_AREAS:
        entry = areas.get(area)
        require(isinstance(entry, dict), f"RTL gap work order missing area: {area}.", errors)
        if not isinstance(entry, dict):
            continue
        require(
            bool(entry.get("current_posture")), f"{area} must describe current_posture.", errors
        )
        require(bool(entry.get("fail_closed")), f"{area} must list fail_closed behavior.", errors)
        require(bool(entry.get("checks")), f"{area} must list executable checks.", errors)
        gaps = entry.get("critical_gaps")
        require(isinstance(gaps, list) and bool(gaps), f"{area} must list critical_gaps.", errors)
        if not isinstance(gaps, list):
            continue
        for gap in gaps:
            require(
                isinstance(gap, dict), f"{area} critical_gaps entries must be mappings.", errors
            )
            if not isinstance(gap, dict):
                continue
            gap_id = gap.get("id", "<missing>")
            if isinstance(required_gap_fields, list):
                for field in required_gap_fields:
                    require(bool(gap.get(field)), f"{area}:{gap_id} must include {field}.", errors)
            require(
                gap.get("status") == "open",
                f"{area}:{gap_id} must remain status=open until closed by RTL and checks.",
                errors,
            )
            require(
                gap.get("category") in REQUIRED_GAP_CATEGORIES,
                f"{area}:{gap_id} has invalid category.",
                errors,
            )
            require(
                gap.get("severity") in REQUIRED_GAP_SEVERITIES,
                f"{area}:{gap_id} has invalid severity.",
                errors,
            )
            affected_paths = gap.get("affected_paths")
            require(
                isinstance(affected_paths, list) and bool(affected_paths),
                f"{area}:{gap_id} must list affected_paths.",
                errors,
            )
            if isinstance(affected_paths, list):
                for affected in affected_paths:
                    require(
                        isinstance(affected, str) and bool(affected),
                        f"{area}:{gap_id} affected path must be a string.",
                        errors,
                    )
                    if isinstance(affected, str) and affected:
                        require(
                            (ROOT / affected).exists(),
                            f"{area}:{gap_id} affected path does not exist: {affected}.",
                            errors,
                        )
    return errors


def finding_code(error: str) -> str:
    if "silent placeholder term" in error:
        return "silent_placeholder_term"
    if "Renode" in error or "REPL" in error or "RESC" in error:
        return "renode_scaffold_contract_gap"
    if "RTL gap work order" in error or "critical_gaps" in error:
        return "rtl_gap_work_order_contract_gap"
    return "stub_audit_contract_gap"


def build_report(errors: list[str], inventory: list[str]) -> dict[str, object]:
    return {
        "schema": "eliza.stub_audit.v1",
        "status": "pass" if not errors else "fail",
        "claim_boundary": "stub_inventory_only_not_rtl_completion_or_os_boot_evidence",
        "summary": {
            "errors": len(errors),
            "allowed_placeholder_inventory": len(inventory),
        },
        "findings": [
            {
                "code": finding_code(error),
                "severity": "blocker",
                "message": "stub audit found an undocumented placeholder/stub/scaffold gap",
                "evidence": error,
                "next_step": (
                    "Either remove the placeholder/stub/scaffold term by completing the implementation, "
                    "or add a precise allowlist rationale tied to an executable fail-closed test or work order."
                ),
            }
            for error in errors
        ],
        "allowed_placeholder_inventory": inventory,
    }


def write_report(report: dict[str, object]) -> None:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    errors, inventory = check_placeholder_terms()
    errors.extend(check_renode_scaffold())
    errors.extend(check_gap_work_order())
    write_report(build_report(errors, inventory))

    if errors:
        print("Stub audit failed:")
        for error in errors:
            print(f"  - {error}")
        return 1

    print("Stub audit passed: no silent owned RTL/sim/verification placeholders.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
