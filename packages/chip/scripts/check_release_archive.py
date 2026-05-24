#!/usr/bin/env python3
"""Validate release archive contents without treating blockers as closed."""

from __future__ import annotations

import argparse
import json
import tarfile
from pathlib import Path

REQUIRED_SUFFIXES = [
    "SHA256SUMS",
    "reports/tool_versions.txt",
    "reports/formal_manifest.json",
    "reports/cocotb/manifest.json",
    "reports/qemu_smoke.log",
    "netlist/e1_chip_synth.v",
    "source/Makefile",
    "source/scripts/check_mvp_status.py",
    "source/scripts/check_no_hardware_action_matrix.py",
    "source/scripts/check_prototype_status_dashboard.py",
    "source/scripts/pipeline_check.py",
    "source/scripts/check_cpu_ap_evidence.py",
    "source/scripts/product_check.py",
    "source/scripts/check_package_cross_probe.py",
    "source/scripts/check_kicad_artifacts.py",
    "source/scripts/check_fpga_release.py",
    "source/scripts/check_openlane_run_preflight.py",
    "source/scripts/check_pd_signoff.py",
    "source/scripts/check_manufacturing_artifacts.py",
    "source/scripts/check_release_archive.py",
    "source/scripts/test_strict_release_gates.py",
    "source/scripts/test_benchmark_calibration.py",
    "source/scripts/test_physical_gates.py",
    "source/scripts/test_software_bsp_checks.py",
    "source/scripts/test_simulator_arch_metrics.py",
    "source/scripts/run_renode.sh",
    "source/benchmarks/metadata/strict-blocked-template.json",
    "source/benchmarks/generate_simulator_arch_metrics.py",
    "source/benchmarks/install_host_benchmark_tools.py",
    "source/benchmarks/metadata/local-host-smoke.json",
    "source/benchmarks/models/mobile_smoke.tflite",
    "source/benchmarks/tools/coremark",
    "source/benchmarks/tools/stream_c.exe",
    "source/benchmarks/tools/bw_mem",
    "source/benchmarks/tools/lat_mem_rd",
    "source/benchmarks/tools/benchmark_model",
    "source/docs/android/bsp-artifact-manifest.json",
    "source/docs/android/bsp-log-evidence-manifest.json",
    "source/docs/manufacturing/artifact-manifest.yaml",
    "source/docs/manufacturing/schemas/artifact-manifest.schema.yaml",
    "source/docs/manufacturing/release-manifest.yaml",
    "source/docs/manufacturing/real-world-verification-gaps.yaml",
    "source/docs/manufacturing/physical-closure-work-order.yaml",
    "source/docs/manufacturing/product-feature-evidence-manifest.yaml",
    "source/docs/project/cpu-ap-blocker-status-2026-05-17.md",
    "source/docs/project/product-feature-gap-audit-2026-05-17.md",
    "source/docs/project/prototype-status-dashboard.md",
    "source/docs/project/no-hardware-action-matrix-2026-05-17.yaml",
    "source/docs/project/cpu-ap-integration-work-order-2026-05-17.yaml",
    "source/docs/project/critical-gap-review-2026-05-17.md",
    "source/docs/project/rtl-soc-critical-gap-audit.md",
    "source/docs/project/board-package-pd-fpga-critical-gap-audit.md",
    "source/docs/toolchain/benchmark-simulator-critical-gap-audit.md",
    "source/docs/architecture-optimization/README.md",
    "source/package/artifact-manifest.yaml",
    "source/package/e1-demo-pinout.yaml",
    "source/docs/package/e1-demo-package.md",
    "source/docs/package/e1-demo-pad-ring.md",
    "source/package/wifi-external-interface.yaml",
    "source/pd/padframe/e1_demo_padframe.yaml",
    "source/docs/pd/padframe/e1_demo_padframe.md",
    "source/pd/pin_order.cfg",
    "source/pd/signoff/manifest.yaml",
    "source/board/fpga/artifact-manifest.yaml",
    "source/board/fpga/e1_demo_fpga.yaml",
    "source/board/fpga/constraints/e1_demo_ulx3s.lpf",
    "source/board/kicad/e1-demo/artifact-manifest.yaml",
    "source/docs/board/kicad/e1-demo/fab-notes.md",
    "source/sim/renode/eliza_e1_smoke.schema.json",
]

REQUIRED_TEXT = {
    "source/docs/manufacturing/real-world-verification-gaps.yaml": [
        "cellular_modem_stack",
        "privacy_data_protection_policy",
        "factory_test_provisioning_flow",
        "regulatory_compliance_release",
        "release_blocked",
    ],
    "source/docs/manufacturing/product-feature-evidence-manifest.yaml": [
        "modem_radio",
        "secure_boot_tee_debug",
        "regulatory_sar_ptcrb_fcc",
        "factory_test",
    ],
    "source/docs/manufacturing/artifact-manifest.yaml": [
        "schema: docs/manufacturing/schemas/artifact-manifest.schema.yaml",
        "release_gates",
        "artifact_manifests",
        "pd/signoff/manifest.yaml",
        "board/fpga/artifact-manifest.yaml",
        "board/kicad/e1-demo/artifact-manifest.yaml",
        "package/artifact-manifest.yaml",
    ],
    "source/docs/manufacturing/schemas/artifact-manifest.schema.yaml": [
        "Manufacturing artifact evidence manifest",
        "release_gates",
        "artifact_groups",
        "clean_regex",
        "fail_regex",
    ],
    "source/package/artifact-manifest.yaml": [
        "package_vendor_release",
        "bond_and_cross_probe",
        "status: missing",
        "release_gate: tapeout_release",
    ],
    "source/board/kicad/e1-demo/artifact-manifest.yaml": [
        "kicad_sources",
        "kicad_cli_outputs",
        "board_reviews",
        "status: missing",
        "release_gate: board_fabrication_release",
    ],
    "source/board/fpga/artifact-manifest.yaml": [
        "e1_demo_fpga_bitstream_evidence",
        "bitstream_release",
        "cli_commands",
        "status: missing",
        "release_gate: board_fabrication_release",
    ],
    "source/pd/signoff/manifest.yaml": [
        "blocked_gates",
        "pd_release",
        "tapeout_release",
        "board_fabrication_release",
        "required_artifacts",
    ],
    "source/docs/android/bsp-log-evidence-manifest.json": [
        "cuttlefish_riscv64_boot.log",
        "eliza_ai_soc_checkvintf.log",
    ],
    "source/docs/project/critical-gap-review-2026-05-17.md": [
        "A gap is closed only when",
        "Workstream E: Product Features Not Implemented",
    ],
    "source/docs/project/prototype-status-dashboard.md": [
        "MVP Gate Snapshot",
        "QEMU PASS is qemu-virt software-reference evidence",
        "Benchmark BLOCK means reports are planning or dry-run evidence",
        "make benchmark-sim-metrics",
    ],
    "source/docs/project/no-hardware-action-matrix-2026-05-17.yaml": [
        "eliza.no_hardware_action_matrix.v1",
        "No Android support is claimed",
        "make evidence-regression-test",
    ],
    "source/docs/project/cpu-ap-integration-work-order-2026-05-17.yaml": [
        "eliza.cpu_ap_integration_work_order.v1",
        "cva6",
        "make cpu-ap-evidence-check",
    ],
    "source/benchmarks/generate_simulator_arch_metrics.py": [
        "qemu_virt_liveness_only",
        "not_performance_evidence",
        "target_cycles",
    ],
    "source/sim/renode/eliza_e1_smoke.schema.json": [
        "qemu_virt_reference",
        "eliza_e1_uart.transcript",
    ],
}

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/release_archive.json"
SCHEMA = "eliza.release_archive.v1"
CLAIM_BOUNDARY = "release_archive_validation_only_not_release_evidence"


def finding_payload(status: str, archive: Path, index: int, finding: str) -> dict:
    payload = {
        "code": f"release_archive_{status}_{index}",
        "severity": "blocker" if status == "blocked" else "error",
        "message": finding,
        "evidence": str(archive),
        "next_step": (
            "Regenerate the release archive from real checked release artifacts "
            "and rerun this checker."
        ),
        "next_command": f"python3 scripts/check_release_archive.py {archive}",
        "next_commands": [
            "scripts/archive_release.sh",
            f"python3 scripts/check_release_archive.py {archive}",
        ],
        "evidence_requirements": {
            "required_suffixes": REQUIRED_SUFFIXES,
            "required_text": REQUIRED_TEXT,
            "claim_boundary": CLAIM_BOUNDARY,
        },
    }
    if finding.startswith("release archive missing: "):
        payload["missing_artifact"] = str(archive)
        payload["next_command"] = "scripts/archive_release.sh"
    elif finding.startswith("missing archive member ending with "):
        suffix = finding.removeprefix("missing archive member ending with ")
        payload["missing_artifact_suffix"] = suffix
        payload["next_step"] = (
            f"Archive a real release artifact ending with {suffix}, regenerate "
            "SHA256SUMS, then rerun this checker."
        )
    elif finding.startswith("SHA256SUMS does not reference "):
        member = finding.removeprefix("SHA256SUMS does not reference ")
        payload["archive_member"] = member
        payload["missing_checksum_entry"] = member
        payload["next_step"] = (
            f"Regenerate SHA256SUMS so it contains the archived member {member}, "
            "then rerun this checker."
        )
    elif " missing required text token: " in finding:
        suffix, token = finding.split(" missing required text token: ", 1)
        payload["archive_member_suffix"] = suffix
        payload["missing_text_token"] = token
        payload["next_step"] = (
            f"Update the archived {suffix} source artifact to include the required "
            f"release-evidence token {token!r}, rebuild the archive, then rerun this checker."
        )
    return payload


def write_report(status: str, archive: Path, findings: list[str]) -> None:
    payload = {
        "schema": SCHEMA,
        "status": status,
        "claim_boundary": CLAIM_BOUNDARY,
        "archive": str(archive),
        "summary": {
            "release_ready": status == "pass",
            "blockers": len(findings) if status == "blocked" else 0,
            "failures": len(findings) if status == "fail" else 0,
        },
        "findings": [
            finding_payload(status, archive, index, finding)
            for index, finding in enumerate(findings, start=1)
        ],
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def suffix_present(names: set[str], suffix: str) -> str | None:
    matches = [
        name
        for name in names
        if name.endswith(suffix) and "/._" not in name and not Path(name).name.startswith("._")
    ]
    if len(matches) == 1:
        return matches[0]
    return None


def read_member_text(tar: tarfile.TarFile, name: str) -> str:
    member = tar.extractfile(name)
    if member is None:
        return ""
    return member.read().decode("utf-8", errors="replace")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()

    if not args.archive.is_file():
        failure = f"release archive missing: {args.archive}"
        write_report("blocked", args.archive, [failure])
        print(f"STATUS: BLOCKED release archive validation: {failure}")
        return 1

    failures: list[str] = []
    with tarfile.open(args.archive, "r:gz") as tar:
        names = set(tar.getnames())
        resolved: dict[str, str] = {}
        for suffix in REQUIRED_SUFFIXES:
            match = suffix_present(names, suffix)
            if match is None:
                failures.append(f"missing archive member ending with {suffix}")
            else:
                resolved[suffix] = match

        checksum_member = resolved.get("SHA256SUMS")
        if checksum_member:
            checksums = read_member_text(tar, checksum_member)
            for suffix in REQUIRED_SUFFIXES:
                if suffix == "SHA256SUMS":
                    continue
                match = resolved.get(suffix)
                if match and match not in checksums:
                    failures.append(f"SHA256SUMS does not reference {match}")

        for suffix, tokens in REQUIRED_TEXT.items():
            match = resolved.get(suffix)
            if not match:
                continue
            text = read_member_text(tar, match)
            for token in tokens:
                if token not in text:
                    failures.append(f"{suffix} missing required text token: {token}")

    if failures:
        write_report("blocked", args.archive, failures)
        print(f"STATUS: BLOCKED release archive validation: {args.archive}")
        print("Release archive validation failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    write_report("pass", args.archive, [])
    print(f"release archive validation ok: {args.archive}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
