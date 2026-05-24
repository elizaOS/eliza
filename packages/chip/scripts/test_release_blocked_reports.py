#!/usr/bin/env python3
"""Regression tests for script-owned structured release blocker reports."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def load_report(path: str) -> dict:
    report = ROOT / path
    if not report.is_file():
        raise AssertionError(f"missing report: {path}")
    payload = json.loads(report.read_text(encoding="utf-8"))
    if payload.get("status") != "blocked":
        raise AssertionError(f"{path} status is not blocked: {payload}")
    if payload.get("summary", {}).get("release_ready") is not False:
        raise AssertionError(f"{path} must not claim release_ready: {payload}")
    findings = payload.get("findings")
    if not isinstance(findings, list) or not findings:
        raise AssertionError(f"{path} missing structured findings: {payload}")
    for finding in findings:
        if not isinstance(finding, dict):
            raise AssertionError(f"{path} finding is not structured: {finding}")
    return payload


def assert_blocked_report(
    name: str,
    command: list[str],
    report_path: str,
    expected_codes: set[int],
) -> None:
    result = run(command)
    if result.returncode not in expected_codes:
        raise AssertionError(
            f"{name}: exit {result.returncode} not in {sorted(expected_codes)}\n{result.stdout}"
        )
    load_report(report_path)
    print(f"PASS {name} writes {report_path}")


def test_blocked_reports() -> None:
    assert_blocked_report(
        "release archive",
        ["python3", "scripts/check_release_archive.py", "build/missing-release-archive.tar.gz"],
        "build/reports/release_archive.json",
        {1},
    )
    release_archive = load_report("build/reports/release_archive.json")
    release_archive_finding = release_archive["findings"][0]
    assert release_archive_finding["missing_artifact"] == "build/missing-release-archive.tar.gz"
    assert release_archive_finding["next_command"] == "scripts/archive_release.sh"
    assert "scripts/archive_release.sh" in release_archive_finding["next_commands"]

    assert_blocked_report(
        "manufacturing artifacts release",
        ["python3", "scripts/check_manufacturing_artifacts.py", "--release"],
        "build/reports/manufacturing_artifacts.json",
        {2},
    )
    manufacturing = load_report("build/reports/manufacturing_artifacts.json")
    assert manufacturing["resolved_manifest"] == "build/reports/manufacturing-resolved-artifacts.json"
    resolved = ROOT / manufacturing["resolved_manifest"]
    assert resolved.is_file()
    resolved_payload = json.loads(resolved.read_text(encoding="utf-8"))
    assert "not release readiness" in resolved_payload["claim"]
    assert resolved_payload["manifests"]
    action_summary = manufacturing["release_unblock_action_summary"]
    assert action_summary["release_credit"] is False
    buckets = action_summary["bucket_counts"]
    assert buckets["artifact_status_promotion"] > 0
    assert buckets["phone_release_output_generation"] > 0
    assert buckets["metadata_completion"] > 0
    assert manufacturing["summary"]["action_buckets"] == buckets
    class_summary = manufacturing["release_blocker_class_summary"]
    assert class_summary["release_credit"] is False
    classes = class_summary["class_counts"]
    assert manufacturing["summary"]["blocker_classes"] == classes
    assert classes["present_non_release_planning_artifact"] > 0
    assert classes["missing_generated_release_output"] > 0
    assert classes["external_approval_metadata_blocker"] > 0
    assert classes["external_release_gate_blocker"] > 0
    for bucket in action_summary["action_buckets"]:
        assert bucket["next_command"] == "python3 scripts/check_manufacturing_artifacts.py --release"
        assert bucket["sample_findings"]
    matrix = manufacturing["manifest_unblock_matrix"]
    assert isinstance(matrix, list)
    assert manufacturing["summary"]["blocked_manifest_count"] == len(matrix)
    matrix_map = {row["manifest"]: row for row in matrix}
    for manifest in (
        "manufacturing_physical_evidence",
        "package_vendor_padframe_evidence",
        "e1_demo_kicad_board_evidence",
        "board/kicad/e1-phone/artifact-manifest.yaml",
        "e1_demo_fpga_bitstream_evidence",
    ):
        assert manifest in matrix_map
        row = matrix_map[manifest]
        assert row["release_credit"] is False
        assert row["blocker_count"] > 0
        assert row["bucket_counts"]
        assert row["sample_findings"]
        assert row["next_steps"]
        assert row["next_command"] == "python3 scripts/check_manufacturing_artifacts.py --release"
    packets = manufacturing["blocker_execution_packets"]
    assert isinstance(packets, list)
    assert len(packets) == manufacturing["summary"]["blockers"]
    packet_map = {packet["manifest"]: packet for packet in packets}
    assert packet_map["manufacturing_physical_evidence"]["manifest_path"] == (
        "docs/manufacturing/artifact-manifest.yaml"
    )
    assert packet_map["package_vendor_padframe_evidence"]["manifest_path"] == (
        "package/artifact-manifest.yaml"
    )
    assert packet_map["e1_demo_kicad_board_evidence"]["manifest_path"] == (
        "board/kicad/e1-demo/artifact-manifest.yaml"
    )
    assert packet_map["board/kicad/e1-phone/artifact-manifest.yaml"]["manifest_path"] == (
        "board/kicad/e1-phone/artifact-manifest.yaml"
    )
    assert packet_map["e1_demo_fpga_bitstream_evidence"]["manifest_path"] == (
        "board/fpga/artifact-manifest.yaml"
    )
    for packet in packets:
        assert packet["release_credit"] is False
        assert packet["source_selector"]
        assert packet["blocker_class"]
        assert packet["validation_commands"]
        assert (
            "python3 scripts/check_manufacturing_artifacts.py --release"
            in packet["validation_commands"]
        )
    for finding in manufacturing["findings"]:
        assert finding["next_command"] == "python3 scripts/check_manufacturing_artifacts.py --release"
        assert finding["release_blocker_class"]
        assert finding["release_action_bucket"]
        assert "python3 scripts/check_manufacturing_artifacts.py --release" in finding[
            "next_commands"
        ]
    assert_blocked_report(
        "PD signoff artifacts",
        ["python3", "scripts/check_pd_signoff.py"],
        "build/reports/pd_signoff.json",
        {2},
    )
    assert_blocked_report(
        "antenna metadata release",
        ["python3", "scripts/check_antenna_metadata.py", "--release"],
        "build/reports/antenna_metadata.json",
        {2},
    )
    assert_blocked_report(
        "PDN workload signoff",
        ["python3", "scripts/check_pdn_workload_signoff.py", "--allow-blocked"],
        "build/reports/pdn_workload_signoff.json",
        {0},
    )
    assert_blocked_report(
        "FPGA release",
        ["python3", "scripts/check_fpga_release.py", "--release"],
        "build/reports/fpga_release.json",
        {2},
    )


def main() -> None:
    test_blocked_reports()


if __name__ == "__main__":
    main()
