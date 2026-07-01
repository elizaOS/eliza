#!/usr/bin/env python3
"""Aggregate fail-closed SOTA parity status across phone-SoC domains."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from chip_utils import load_json_object, load_yaml_object

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build/reports/sota_parity_audit.json"


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


REQUIRED_SPECS = {
    "cpu": ROOT / "docs/spec-db/cpu-2028-target.yaml",
    "memory": ROOT / "docs/spec-db/memory-2028-target.yaml",
    "npu": ROOT / "docs/spec-db/npu-2028-target.yaml",
    "security": ROOT / "docs/spec-db/security-2028-target.yaml",
    "mobile_sota": ROOT / "docs/spec-db/mobile-sota-2026.yaml",
    "benchmark_matrix": ROOT / "docs/benchmarks/benchmark-matrix.md",
    "phone_minimum_blocks": ROOT / "docs/project/phone-soc-minimum-blocks.yaml",
}

PARITY_DOMAINS = [
    {
        "id": "cpu_ap",
        "gate_command": "make cpu-ap-completion-gate",
        "evidence_sources": [
            "build/reports/cpu_ap_scope.json",
            "docs/evidence/cpu-ap-evidence-manifest.json",
            "docs/spec-db/cpu-2028-target.yaml",
            "docs/arch/linux-capable-cpu-contract.md",
            "build/evidence/cpu_ap/eliza_e1_linux_boot.log",
            "build/evidence/cpu_ap/eliza_e1_ap_benchmarks.log",
        ],
        "closure_criteria": [
            "RV64GC Linux-capable AP boot evidence",
            "OpenSBI/Linux logs",
            "sustained CPU benchmarks with power and thermal metadata",
        ],
    },
    {
        "id": "npu",
        "gate_command": "make e1-npu-nnapi-proof-check",
        "evidence_sources": [
            "build/reports/npu_scope.json",
            "docs/spec-db/npu-2028-target.yaml",
            "docs/spec-db/npu-2028-roadmap.yaml",
            "docs/benchmarks/capabilities/e1_npu_nnapi.proof.template.json",
            "docs/benchmarks/capabilities/e1_npu_android_proof_manifest.template.json",
            "docs/benchmarks/capabilities/e1_npu_power_thermal_manifest.template.json",
        ],
        "closure_criteria": [
            "real e1-npu accelerator selection",
            "unsupported operator report",
            "CPU fallback at or below target",
            "measured TOPS, latency, power, and thermal traces",
        ],
    },
    {
        "id": "memory_uma",
        "gate_command": "make memory-uma-claim-gate",
        "evidence_sources": [
            "docs/spec-db/memory-2028-target.yaml",
            "docs/evidence/memory/uma-dram-evidence-gate.yaml",
            "docs/evidence/memory/templates/bandwidth-latency-contended-access.template.json",
        ],
        "closure_criteria": [
            "LPDDR-class controller/PHY evidence",
            "training logs",
            "contended CPU/GPU/NPU/display bandwidth",
            "IOMMU and coherency stress evidence",
        ],
    },
    {
        "id": "software_bsp_android_linux",
        "gate_command": "make software-bsp-evidence-check",
        "evidence_sources": [
            "build/reports/software_bsp_scope.json",
            "docs/evidence/software-bsp-evidence-manifest.json",
            "docs/android/bsp-log-evidence-manifest.json",
            "docs/evidence/android/cuttlefish_riscv64_smoke.log",
        ],
        "closure_criteria": [
            "external Buildroot/Linux/AOSP trees",
            "boot transcripts",
            "Android device or virtual-device smoke logs",
            "HAL and SELinux evidence",
        ],
    },
    {
        "id": "benchmarks_efficiency",
        "gate_command": "make benchmarks",
        "evidence_sources": [
            "build/reports/benchmark_efficiency_scope.json",
            "benchmarks/configs/benchmark_plan.json",
            "docs/benchmarks/report-schema.yaml",
            "benchmarks/configs/target-metadata.example.json",
        ],
        "closure_criteria": [
            "schema-valid target benchmark report",
            "calibrated clocks, power, thermal, and memory metadata",
            "raw artifact hashes",
            "no simulator wall-clock phone comparison",
        ],
    },
    {
        "id": "sustained_power_thermal",
        "gate_command": "make power-thermal-evidence-check",
        "evidence_sources": [
            "build/reports/power_thermal_scope.json",
            "benchmarks/power/manifests/e1-npu-sustained-capture.template.json",
            "docs/manufacturing/real-world-verification-gaps.yaml",
        ],
        "closure_criteria": [
            "aligned external power trace",
            "thermal trace",
            "frequency trace",
            "sustained workload window and throttle state",
        ],
    },
    {
        "id": "product_package_board_pd",
        "gate_command": "make product-release-check",
        "evidence_sources": [
            "build/reports/product_release_status.json",
            "pd/signoff/manifest.yaml",
            "docs/manufacturing/release-manifest.yaml",
        ],
        "closure_criteria": [
            "PD signoff",
            "package and KiCad fabrication release evidence",
            "FPGA bitstream release evidence",
            "manufacturing SI/PI/current/thermal evidence",
        ],
    },
    {
        "id": "security",
        "gate_command": "make product-feature-gates-check",
        "evidence_sources": [
            "docs/spec-db/security-2028-target.yaml",
            "docs/manufacturing/product-feature-evidence-manifest.yaml",
            "build/reports/security_lifecycle_scope.json",
        ],
        "closure_criteria": [
            "secure boot chain",
            "debug lock",
            "key ladder or equivalent lifecycle evidence",
            "Android verified boot and rollback policy",
        ],
    },
    {
        "id": "radios_sensors_pmic",
        "gate_command": "make real-world-gates-check",
        "evidence_sources": [
            "docs/manufacturing/real-world-verification-gaps.yaml",
            "docs/architecture-optimization/phone-platform.md",
            "build/reports/radio_sensor_pmic_scope.json",
        ],
        "closure_criteria": [
            "Wi-Fi/BT/GNSS/NFC evidence",
            "sensor hub evidence",
            "battery/PMIC/charger/thermal safety evidence",
            "Android health and power HAL evidence",
        ],
    },
    {
        "id": "gpu_display_isp",
        "gate_command": "make phone-soc-claim-check",
        "evidence_sources": [
            "docs/project/phone-soc-minimum-blocks.yaml",
            "docs/architecture-optimization/phone-platform.md",
            "build/reports/phone_media_pipeline_scope.json",
        ],
        "closure_criteria": [
            "GPU/display conformance and performance evidence",
            "camera/ISP sensor, CSI, tuning, and HAL evidence",
            "concurrent camera/display/NPU QoS evidence",
        ],
    },
    {
        "id": "manufacturing_tapeout",
        "gate_command": "make tapeout-readiness-strict",
        "evidence_sources": [
            "build/reports/manufacturing_tapeout_scope.json",
            "docs/manufacturing/physical-closure-work-order.yaml",
            "docs/manufacturing/release-manifest.yaml",
            "pd/signoff/manifest.yaml",
        ],
        "closure_criteria": [
            "selected PDK extracted timing/power/thermal reports",
            "DRC/LVS/antenna/IR/EM closure",
            "DFT and first-article manufacturing evidence",
        ],
    },
]

FALSE_CLAIM_FLAGS = {
    "sota_claim_allowed": False,
    "phone_class_parity_claim_allowed": False,
    "measured_phone_evidence_claim_allowed": False,
    "runtime_parity_claim_allowed": False,
    "release_claim_allowed": False,
    "production_readiness_claim_allowed": False,
    "tapeout_claim_allowed": False,
    "benchmark_leadership_claim_allowed": False,
}


def run_json(command: list[str]) -> Any:
    result = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if result.returncode not in (0, 1, 2):
        raise RuntimeError(f"{' '.join(command)} failed:\n{result.stdout}")
    return json.loads(result.stdout)


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def spec_summaries() -> dict[str, Any]:
    missing = [rel(path) for path in REQUIRED_SPECS.values() if not path.is_file()]
    if missing:
        raise FileNotFoundError("missing SOTA spec artifacts: " + ", ".join(missing))

    npu = load_yaml_object(REQUIRED_SPECS["npu"])
    cpu = load_yaml_object(REQUIRED_SPECS["cpu"])
    memory = load_yaml_object(REQUIRED_SPECS["memory"])
    security = load_yaml_object(REQUIRED_SPECS["security"])
    phone_blocks = load_yaml_object(REQUIRED_SPECS["phone_minimum_blocks"])
    benchmark_matrix = REQUIRED_SPECS["benchmark_matrix"].read_text(encoding="utf-8")

    return {
        "npu_numeric_targets": npu.get("numeric_targets", {}),
        "npu_current_level": npu.get("current_repo_classification", {}).get("level"),
        "cpu_schema": cpu.get("schema"),
        "memory_schema": memory.get("schema"),
        "security_schema": security.get("schema"),
        "phone_block_count": len(phone_blocks.get("phone_soc_blocks", [])),
        "benchmark_matrix_claim_levels_present": "L6 | Complete phone" in benchmark_matrix,
    }


def code_from_text(text: str, fallback: str) -> str:
    code = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return code or fallback


def structured_findings(domains: list[dict[str, Any]]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for domain in domains:
        if domain.get("status") != "blocked":
            continue
        domain_id = str(domain.get("id", "domain"))
        blockers = domain.get("blockers")
        criteria = domain.get("closure_criteria")
        evidence = domain.get("evidence_sources")
        findings.append(
            {
                "code": f"sota_parity_domain_blocked_{code_from_text(domain_id, 'domain')}",
                "severity": "blocker",
                "message": (
                    f"{domain_id} blocks SOTA/no-issues runtime parity: "
                    + "; ".join(str(blocker) for blocker in blockers if blocker)
                    if isinstance(blockers, list)
                    else f"{domain_id} blocks SOTA/no-issues runtime parity"
                ),
                "evidence": evidence if isinstance(evidence, list) else [],
                "next_step": (
                    "Close the domain gate with measured phone-class target "
                    "evidence covering: " + "; ".join(str(item) for item in criteria if item)
                    if isinstance(criteria, list)
                    else "Close the domain gate with measured phone-class target evidence."
                ),
            }
        )
    return findings


def build_report() -> dict[str, Any]:
    mvp = run_json([sys.executable, "scripts/check_mvp_status.py", "--json"])
    if not isinstance(mvp, list):
        raise ValueError("MVP status JSON must be a list")
    mvp_by_name = {str(item.get("subsystem")): item for item in mvp if isinstance(item, dict)}
    blocked_mvp = sorted(
        name for name, item in mvp_by_name.items() if str(item.get("status")).lower() == "block"
    )

    product_report_path = ROOT / "build/reports/product_release_status.json"
    product_report = load_json_object(product_report_path) if product_report_path.is_file() else {}
    product_blockers = product_report.get("release_blockers", [])
    if not isinstance(product_blockers, list):
        product_blockers = []

    domains: list[dict[str, Any]] = []
    for domain in PARITY_DOMAINS:
        missing_sources = [
            source
            for source in domain["evidence_sources"]
            if not (ROOT / source).exists() and not source.startswith("build/")
        ]
        domain_id_str = str(domain["id"])
        related_mvp_blocks = [
            name
            for name in blocked_mvp
            if name in domain_id_str or domain_id_str in name.replace("-", "_")
        ]
        status = "blocked"
        blockers = ["full parity requires real target evidence, not scaffold/model-only evidence"]
        if missing_sources:
            blockers.append("missing source artifacts: " + ", ".join(missing_sources))
        if domain["id"] == "product_package_board_pd" and product_blockers:
            blockers.append(f"product release blockers: {len(product_blockers)}")
        if related_mvp_blocks:
            blockers.append("related MVP block(s): " + ", ".join(related_mvp_blocks))

        domains.append(
            {
                **domain,
                "status": status,
                "blockers": blockers,
            }
        )

    report = {
        "schema": "eliza.sota_parity_audit.v1",
        "status": "blocked",
        "generated_utc": utc_now(),
        **FALSE_CLAIM_FLAGS,
        "claim_boundary": (
            "Fail-closed aggregate audit for 2023/2028 SOTA parity. A pass here "
            "would require phone-class measured evidence across all domains; "
            "current local scaffold/model evidence is insufficient."
        ),
        "spec_summaries": spec_summaries(),
        "mvp_blocked_subsystems": blocked_mvp,
        "product_release_blocker_count": len(product_blockers),
        "parity_domains": domains,
        "findings": structured_findings(domains),
        "summary": {
            "domain_count": len(domains),
            "blocked_domain_count": len([d for d in domains if d["status"] == "blocked"]),
            "ready_for_sota_claim": False,
        },
        "next_step": (
            "close real CPU/AP, NPU, memory, software BSP, benchmark, power, "
            "product, security, radio/sensor/PMIC, GPU/display/ISP, and "
            "manufacturing evidence gates before any SOTA parity claim"
        ),
    }
    return report


def validate_report(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != "eliza.sota_parity_audit.v1":
        errors.append("wrong schema")
    for flag in FALSE_CLAIM_FLAGS:
        if report.get(flag) is not False:
            errors.append(f"{flag} must be exactly false")
    domains = report.get("parity_domains")
    if not isinstance(domains, list):
        return errors + ["parity_domains must be a list"]
    ids: set[str] = {
        str(domain["id"])
        for domain in domains
        if isinstance(domain, dict) and domain.get("id") is not None
    }
    expected: set[str] = {str(domain["id"]) for domain in PARITY_DOMAINS}
    missing: list[str] = sorted(expected - ids)
    if missing:
        errors.append("missing parity domains: " + ", ".join(missing))
    for domain in domains:
        if not isinstance(domain, dict):
            errors.append("parity domain entries must be objects")
            continue
        domain_id = str(domain.get("id"))
        if domain.get("status") != "blocked":
            errors.append(f"{domain_id}: must remain blocked until evidence closes")
        if not str(domain.get("gate_command", "")).startswith("make "):
            errors.append(f"{domain_id}: gate_command must be a make target")
        for field in ("evidence_sources", "closure_criteria", "blockers"):
            value = domain.get(field)
            if not isinstance(value, list) or not value:
                errors.append(f"{domain_id}: {field} must be a non-empty list")
    summary = report.get("summary")
    if not isinstance(summary, dict):
        errors.append("summary must be an object")
    elif summary.get("ready_for_sota_claim") is not False:
        errors.append("ready_for_sota_claim must be false for current evidence")
    findings = report.get("findings")
    if not isinstance(findings, list) or not findings:
        errors.append("findings must list structured SOTA parity blockers")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--strict", action="store_true", help="exit 2 while parity is blocked")
    parser.add_argument("--json", action="store_true", help="print the audit JSON")
    args = parser.parse_args()

    report = build_report()
    errors = validate_report(report)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    if errors:
        for error in errors:
            print(f"sota parity audit error: {error}")
        return 1
    if args.strict:
        print(f"STATUS: BLOCKED sota_parity report: {rel(OUT)}")
        return 2
    print(f"STATUS: BLOCKED sota_parity report: {rel(OUT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
