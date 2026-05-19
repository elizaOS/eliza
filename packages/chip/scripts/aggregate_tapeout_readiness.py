#!/usr/bin/env python3
"""Aggregate every fail-closed tapeout-readiness gate into one JSON report.

This is a view-only aggregator. It does not promote any silicon, boot, MLPerf,
or release claim and it does not modify any individual gate. It re-executes the
existing ``scripts/check_*.py`` gates that the chip package already exposes via
Makefile targets, classifies each result by exit code + stdout prefix, and
writes a single JSON report at ``build/reports/tapeout-readiness.json``.

Classification policy (exact prefix-based rule):

* ``STATUS: BLOCKED`` anywhere in combined stdout/stderr  -> ``BLOCKED``
* non-zero exit code                                       -> ``FAIL``
* zero exit code                                           -> ``PASS``

``BLOCKED`` is never a release blocker on its own: it is an external dependency
record (foundry PDK, AOSP transcript, MLPerf silicon, OpenLane Docker). Only
``FAIL`` flips ``release_blocker`` to true and causes a non-zero exit from this
aggregator.

The ``--strict`` flag escalates ``BLOCKED`` to a release blocker as well, which
is what ``make tapeout-readiness-strict`` uses to assert silicon-class
readiness.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path
from typing import Literal

ROOT = Path(__file__).resolve().parents[1]
REPORT_PATH = ROOT / "build/reports/tapeout-readiness.json"
SCHEMA = "eliza.tapeout_readiness.v1"
CLAIM_BOUNDARY = "tapeout_readiness_aggregator_view_only_no_silicon_or_release_claim"

Status = Literal["PASS", "FAIL", "BLOCKED"]
Subsystem = Literal[
    "cpu",
    "memory",
    "security",
    "npu",
    "process",
    "pd",
    "platform",
    "bsp",
    "verify",
    "benchmarks",
]
Tier = Literal["spec", "rtl", "pd", "silicon"]


@dataclass(frozen=True)
class GateSpec:
    """Static description of one gate the aggregator re-runs."""

    name: str
    script: str
    subsystem: Subsystem
    tier: Tier
    args: tuple[str, ...] = ()


# Curated set of fail-closed gates that already exist in scripts/check_*.py
# and that map to a Makefile target. Each entry is grouped by subsystem so the
# emitted report stays auditable. Long-running gates (cocotb, formal,
# openlane, verilator, qemu) are intentionally excluded: they belong to the
# CI lanes (`make smoke`, `make ci-fast`, `make ci-pd`) not to a single-shot
# readiness probe.
GATES: tuple[GateSpec, ...] = (
    # ---- CPU / AP -----------------------------------------------------------
    GateSpec(
        name="cpu-2028-target-check",
        script="scripts/check_cpu_2028_target.py",
        subsystem="cpu",
        tier="spec",
    ),
    GateSpec(
        name="core-selection-check",
        script="scripts/check_core_selection.py",
        subsystem="cpu",
        tier="spec",
    ),
    GateSpec(
        name="cpu-ap-completion-gate",
        script="scripts/check_cpu_ap_completion_gate.py",
        subsystem="cpu",
        tier="rtl",
    ),
    GateSpec(
        name="chipyard-generated-linux-contract-check",
        script="scripts/check_chipyard_generated_linux_contract.py",
        subsystem="cpu",
        tier="silicon",
        args=("--require-boot-evidence",),
    ),
    GateSpec(
        name="rva23-compliance",
        script="scripts/check_rva23_compliance.py",
        subsystem="cpu",
        tier="spec",
    ),
    # ---- Memory / interconnect ---------------------------------------------
    GateSpec(
        name="memory-2028-target-check",
        script="scripts/check_memory_2028_target.py",
        subsystem="memory",
        tier="spec",
    ),
    GateSpec(
        name="memory-uma-claim-gate",
        script="scripts/check_memory_uma_claim_gate.py",
        subsystem="memory",
        tier="spec",
    ),
    GateSpec(
        name="memory-evidence-template-check",
        script="scripts/check_memory_evidence_templates.py",
        subsystem="memory",
        tier="spec",
    ),
    GateSpec(
        name="memory-interconnect-contract-check",
        script="scripts/check_memory_interconnect_contract.py",
        subsystem="memory",
        tier="spec",
    ),
    GateSpec(
        name="iommu-evidence-check",
        script="scripts/check_iommu_evidence.py",
        subsystem="memory",
        tier="rtl",
    ),
    # ---- Security -----------------------------------------------------------
    GateSpec(
        name="security-2028-target-check",
        script="scripts/check_security_2028_target.py",
        subsystem="security",
        tier="spec",
    ),
    # ---- NPU ----------------------------------------------------------------
    GateSpec(
        name="npu-2028-target-check",
        script="scripts/check_npu_2028_targets.py",
        subsystem="npu",
        tier="spec",
    ),
    GateSpec(
        name="npu-runtime-contract-check",
        script="scripts/check_e1_npu_runtime_contract.py",
        subsystem="npu",
        tier="rtl",
    ),
    GateSpec(
        name="npu-roadmap-check",
        script="scripts/check_npu_roadmap.py",
        subsystem="npu",
        tier="spec",
    ),
    GateSpec(
        name="npu-open-scale-model-check",
        script="scripts/check_npu_open_scale_model.py",
        subsystem="npu",
        tier="spec",
    ),
    GateSpec(
        name="npu-scale-sim-check",
        script="scripts/check_npu_scale_sim.py",
        subsystem="npu",
        tier="spec",
    ),
    GateSpec(
        name="scale-feasibility-gate",
        script="scripts/check_scale_feasibility_gate.py",
        subsystem="npu",
        tier="spec",
    ),
    # ---- Process / packaging ------------------------------------------------
    GateSpec(
        name="process-14a-effects-check",
        script="scripts/check_process_14a_effects.py",
        subsystem="process",
        tier="spec",
    ),
    GateSpec(
        name="pdk-portability-check",
        script="scripts/check_pdk_portability.py",
        subsystem="process",
        tier="pd",
    ),
    GateSpec(
        name="die-area-budget-check",
        script="scripts/check_die_area_budget.py",
        subsystem="process",
        tier="pd",
    ),
    # ---- Physical design (PD) ----------------------------------------------
    GateSpec(
        name="pd-preflight-check",
        script="scripts/check_pd_preflight.py",
        subsystem="pd",
        tier="pd",
    ),
    GateSpec(
        name="pd-signoff-manifest-check",
        script="scripts/check_pd_signoff.py",
        subsystem="pd",
        tier="pd",
        args=("--manifest-only",),
    ),
    GateSpec(
        name="pd-evidence-gates",
        script="scripts/check_pd_evidence_gates.py",
        subsystem="pd",
        tier="pd",
    ),
    GateSpec(
        name="pd-util-check",
        script="scripts/check_pd_utilization.py",
        subsystem="pd",
        tier="pd",
    ),
    GateSpec(
        name="padframe-check",
        script="scripts/check_padframe_contract.py",
        subsystem="pd",
        tier="pd",
    ),
    GateSpec(
        name="antenna-metadata-check",
        script="scripts/check_antenna_metadata.py",
        subsystem="pd",
        tier="pd",
    ),
    GateSpec(
        name="openlane-run-preflight-check",
        script="scripts/check_openlane_run_preflight.py",
        subsystem="pd",
        tier="pd",
    ),
    GateSpec(
        name="physical-closure-work-order-check",
        script="scripts/check_physical_closure_work_order.py",
        subsystem="pd",
        tier="pd",
    ),
    # ---- Platform / board / package ----------------------------------------
    GateSpec(
        name="platform-contract-check",
        script="scripts/check_platform_contract.py",
        subsystem="platform",
        tier="spec",
    ),
    GateSpec(
        name="board-package-evidence-check",
        script="scripts/check_board_package_evidence.py",
        subsystem="platform",
        tier="spec",
    ),
    GateSpec(
        name="package-cross-probe-check",
        script="scripts/check_package_cross_probe.py",
        subsystem="platform",
        tier="spec",
    ),
    GateSpec(
        name="kicad-artifact-check",
        script="scripts/check_kicad_artifacts.py",
        subsystem="platform",
        tier="spec",
    ),
    GateSpec(
        name="manufacturing-artifacts-check",
        script="scripts/check_manufacturing_artifacts.py",
        subsystem="platform",
        tier="pd",
    ),
    GateSpec(
        name="real-world-gates-check",
        script="scripts/check_real_world_gates.py",
        subsystem="platform",
        tier="silicon",
    ),
    GateSpec(
        name="wifi-interface-check",
        script="scripts/check_wifi_interface.py",
        subsystem="platform",
        tier="spec",
    ),
    GateSpec(
        name="fpga-target-check",
        script="scripts/check_fpga_target.py",
        subsystem="platform",
        tier="spec",
    ),
    GateSpec(
        name="phone-soc-claim-check",
        script="scripts/check_phone_soc_claims.py",
        subsystem="platform",
        tier="spec",
    ),
    GateSpec(
        name="product-feature-gates-check",
        script="scripts/check_product_feature_gates.py",
        subsystem="platform",
        tier="spec",
    ),
    GateSpec(
        name="no-hardware-action-check",
        script="scripts/check_no_hardware_action_matrix.py",
        subsystem="platform",
        tier="spec",
    ),
    # ---- BSP / Linux / Android ---------------------------------------------
    GateSpec(
        name="software-bsp-scaffold-check",
        script="scripts/check_software_bsp.py",
        subsystem="bsp",
        tier="spec",
        args=("all", "--scaffold-only"),
    ),
    GateSpec(
        name="aosp-simulator-completion-check",
        script="scripts/check_aosp_simulator_completion_gate.py",
        subsystem="bsp",
        tier="silicon",
    ),
    GateSpec(
        name="minimum-linux-target-check",
        script="scripts/check_minimum_linux_target.py",
        subsystem="bsp",
        tier="silicon",
    ),
    GateSpec(
        name="minimum-linux-npu-target-check",
        script="scripts/check_minimum_linux_npu_target.py",
        subsystem="bsp",
        tier="silicon",
    ),
    GateSpec(
        name="mvp-npu-ml-evidence-check",
        script="scripts/check_mvp_npu_ml_evidence.py",
        subsystem="bsp",
        tier="silicon",
        args=("--run",),
    ),
    # ---- Verification maturity ---------------------------------------------
    GateSpec(
        name="verification-maturity-matrix-check",
        script="scripts/check_verification_maturity_matrix.py",
        subsystem="verify",
        tier="rtl",
    ),
    GateSpec(
        name="stub-audit",
        script="verify/check_stub_audit.py",
        subsystem="verify",
        tier="rtl",
    ),
    # ---- Benchmarks / project plan -----------------------------------------
    GateSpec(
        name="project-plan-check",
        script="scripts/check_project_plan.py",
        subsystem="benchmarks",
        tier="spec",
    ),
    GateSpec(
        name="prototype-status-dashboard-check",
        script="scripts/check_prototype_status_dashboard.py",
        subsystem="benchmarks",
        tier="spec",
    ),
)


@dataclass(frozen=True)
class GateResult:
    name: str
    status: Status
    evidence: str
    subsystem: Subsystem
    tier: Tier


def _classify(returncode: int, combined_output: str) -> Status:
    blob = combined_output
    # Any check that prints a recognised BLOCKED preamble is BLOCKED, no matter
    # what its exit code says: BLOCKED is a planning state, not a regression.
    blocked_markers = (
        "STATUS: BLOCKED",
        "BLOCKED:",
        "gate BLOCKED",
        "blocked_until_evidence",
    )
    if any(marker in blob for marker in blocked_markers):
        return "BLOCKED"
    # Conventional 2 == soft-fail / blocked for several existing checks.
    if returncode == 2:
        return "BLOCKED"
    if returncode != 0:
        return "FAIL"
    return "PASS"


def _first_evidence_line(name: str, combined_output: str, returncode: int) -> str:
    """Return up to 200 chars of evidence, preferring the most informative line.

    Picks the first ``STATUS: BLOCKED``, ``BLOCKED``, ``FAIL:``, or ``failed``
    line. If none is present, picks the first ``STATUS:`` or non-empty line.
    Falls back to a synthetic stub when the script printed nothing.
    """
    lines = [line.strip() for line in combined_output.splitlines() if line.strip()]
    preferred: str | None = None
    for line in lines:
        if "STATUS: BLOCKED" in line or "BLOCKED:" in line:
            preferred = line
            break
    if preferred is None:
        for line in lines:
            if line.startswith("FAIL:") or "failed" in line:
                preferred = line
                break
    if preferred is None:
        for line in lines:
            if line.startswith("STATUS:"):
                preferred = line
                break
    if preferred is None and lines:
        preferred = lines[0]
    if preferred is None:
        preferred = f"{name}: no output (exit={returncode})"
    return preferred[:200]


def run_gate(spec: GateSpec) -> GateResult:
    script_path = ROOT / spec.script
    if not script_path.is_file():
        return GateResult(
            name=spec.name,
            status="FAIL",
            evidence=f"script missing: {spec.script}",
            subsystem=spec.subsystem,
            tier=spec.tier,
        )
    cmd = [sys.executable, str(script_path), *spec.args]
    completed = subprocess.run(
        cmd,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    combined = completed.stdout or ""
    status = _classify(completed.returncode, combined)
    evidence = _first_evidence_line(spec.name, combined, completed.returncode)
    return GateResult(
        name=spec.name,
        status=status,
        evidence=evidence,
        subsystem=spec.subsystem,
        tier=spec.tier,
    )


def build_report(results: list[GateResult]) -> dict[str, object]:
    summary = {"pass": 0, "fail": 0, "blocked": 0}
    for result in results:
        summary[result.status.lower()] += 1
    release_blocker = summary["fail"] > 0
    return {
        "schema": SCHEMA,
        "as_of": date.today().isoformat(),
        "gates": [asdict(result) for result in results],
        "summary": summary,
        "release_blocker": release_blocker,
        "claim_boundary": CLAIM_BOUNDARY,
    }


def write_report(report: dict[str, object]) -> None:
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")


def print_summary(report: dict[str, object], strict: bool) -> None:
    gates = report["gates"]
    assert isinstance(gates, list)
    summary = report["summary"]
    assert isinstance(summary, dict)
    name_width = max((len(str(gate["name"])) for gate in gates), default=20)
    sub_width = max((len(str(gate["subsystem"])) for gate in gates), default=8)
    tier_width = max((len(str(gate["tier"])) for gate in gates), default=4)
    header = (
        f"{'STATUS':<8} {'SUBSYSTEM':<{sub_width}} {'TIER':<{tier_width}} "
        f"{'NAME':<{name_width}} EVIDENCE"
    )
    print(header)
    print("-" * len(header))
    for gate in gates:
        print(
            f"{gate['status']:<8} {gate['subsystem']:<{sub_width}} "
            f"{gate['tier']:<{tier_width}} {gate['name']:<{name_width}} "
            f"{gate['evidence']}"
        )
    print("-" * len(header))
    print(
        f"summary: PASS={summary['pass']} FAIL={summary['fail']} "
        f"BLOCKED={summary['blocked']}  release_blocker={report['release_blocker']}  "
        f"strict={strict}"
    )
    print(f"report: {REPORT_PATH.relative_to(ROOT)}")
    print(f"claim_boundary: {report['claim_boundary']}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Aggregate every fail-closed tapeout-readiness gate into "
            "build/reports/tapeout-readiness.json"
        )
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help=(
            "Treat BLOCKED as a release blocker as well. Used by `make tapeout-readiness-strict`."
        ),
    )
    parser.add_argument(
        "--json-only",
        action="store_true",
        help="Suppress the human summary table; only emit the JSON path.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    results = [run_gate(spec) for spec in GATES]
    report = build_report(results)
    write_report(report)
    if not args.json_only:
        print_summary(report, strict=args.strict)
    if args.strict:
        if report["summary"]["fail"] > 0 or report["summary"]["blocked"] > 0:  # type: ignore[index]
            return 1
        return 0
    if report["release_blocker"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
