#!/usr/bin/env python3
"""Regression tests for the product release status report artifact."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/product_release_status.json"


def run_product_check(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["python3", "scripts/product_check.py", *args],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def load_report() -> dict[str, object]:
    return json.loads(REPORT.read_text(encoding="utf-8"))


def assert_blocked_report(report: dict[str, object], *, release_mode: bool) -> None:
    assert report["schema"] == "eliza.product_release_status.v1"
    assert report["status"] == "blocked"
    assert report["release_mode"] is release_mode
    assert isinstance(report["release_blockers"], list)
    assert report["release_blockers"]
    assert report["claim_boundary"]
    findings = report.get("findings")
    assert isinstance(findings, list)
    assert findings
    codes = [finding["code"] for finding in findings if isinstance(finding, dict)]
    assert any(code.startswith("product_release_blocker_") for code in codes)
    for finding in findings:
        assert isinstance(finding, dict)
        assert isinstance(finding.get("next_command"), str)
        assert finding["next_command"].startswith("python3 ")
    repo_groups = report.get("repo_artifact_generation_groups")
    assert isinstance(repo_groups, list)
    assert repo_groups
    group_map = {group.get("family"): group for group in repo_groups if isinstance(group, dict)}
    for family in (
        "manufacturing_release_artifacts",
        "kicad_fabrication_artifacts",
        "package_vendor_cross_probe_release",
        "fpga_bitstream_artifacts",
        "pd_signoff_artifacts",
    ):
        assert family in group_map
        group = group_map[family]
        assert group.get("name") == family
        assert isinstance(group.get("count"), int)
        assert group["count"] > 0
        assert isinstance(group.get("generation_commands"), list)
        assert group["generation_commands"]
        assert all(
            isinstance(command, str) and command.startswith("python3 ")
            for command in group["generation_commands"]
        )
        assert isinstance(group.get("primary_paths"), list)
        assert group["primary_paths"]
        assert isinstance(group.get("sample_messages"), list)
        assert group["sample_messages"]
        category_counts = group.get("repo_generation_category_counts")
        assert isinstance(category_counts, dict)
        assert set(category_counts) == {
            "repo_generatable_now",
            "blocked_by_external_evidence",
            "blocked_by_live_hardware",
            "blocked_by_release_approval",
        }
        assert sum(category_counts.values()) == group["count"]
        nested_summaries = group.get("nested_report_generation_summaries")
        assert isinstance(nested_summaries, list)
    assert "python3_scripts_product_check_py_release" not in group_map
    assert "python3_scripts_check_package_cross_probe_py_release" not in group_map
    assert not any(str(family).startswith("python3_scripts_") for family in group_map)

    release_plan = report.get("release_execution_plan")
    assert isinstance(release_plan, list)
    phase_map = {phase.get("phase"): phase for phase in release_plan if isinstance(phase, dict)}
    for phase in (
        "chip_pd_signoff",
        "fpga_board_bitstream_release",
        "manufacturing_package_release",
        "package_vendor_cross_probe_release",
        "phone_fabrication_enclosure_release",
        "end_to_end_runtime_release",
    ):
        assert phase in phase_map
        row = phase_map[phase]
        assert row["release_credit"] is False
        assert row["blocker_count"] > 0
        repo_generation_counts = row.get("repo_generation_category_counts")
        assert isinstance(repo_generation_counts, dict)
        assert set(repo_generation_counts) == {
            "repo_generatable_now",
            "blocked_by_external_evidence",
            "blocked_by_live_hardware",
            "blocked_by_release_approval",
        }
        assert sum(repo_generation_counts.values()) == row["blocker_dependency_counts"].get(
            "repo_artifact_generation", 0
        )
        assert row["primary_commands"]
        assert row["primary_paths"]
        assert row["acceptance_commands"]
        assert all(
            isinstance(command, str) and command.startswith("python3 ")
            for command in row["acceptance_commands"]
        )
        assert row["sample_findings"]
    assert (
        "python3 scripts/check_package_cross_probe.py --release"
        in phase_map["package_vendor_cross_probe_release"]["acceptance_commands"]
    )
    assert (
        "python3 scripts/check_phone_runtime_readiness_contract.py"
        in phase_map["end_to_end_runtime_release"]["acceptance_commands"]
    )
    assert (
        "python3 scripts/check_e1_phone_fabrication_release.py"
        in phase_map["phone_fabrication_enclosure_release"]["primary_commands"]
    )
    assert (
        "python3 scripts/check_fpga_release.py --release"
        in phase_map["fpga_board_bitstream_release"]["acceptance_commands"]
    )
    assert (
        "python3 scripts/check_pd_release_evidence.py"
        in phase_map["chip_pd_signoff"]["acceptance_commands"]
    )
    assert (
        "python3 scripts/check_kicad_artifacts.py --release"
        in phase_map["manufacturing_package_release"]["acceptance_commands"]
    )
    if release_mode:
        manufacturing_phase = phase_map["manufacturing_package_release"]
        manufacturing_generation_counts = manufacturing_phase["repo_generation_category_counts"]
        assert manufacturing_generation_counts["repo_generatable_now"] == 0
        assert (
            manufacturing_generation_counts["blocked_by_external_evidence"]
            + manufacturing_generation_counts["blocked_by_release_approval"]
            + manufacturing_generation_counts["blocked_by_live_hardware"]
        ) > 0
        manufacturing_details = manufacturing_phase.get("manufacturing_artifact_details")
        assert isinstance(manufacturing_details, dict)
        assert (
            manufacturing_details.get("report_path") == "build/reports/manufacturing_artifacts.json"
        )
        artifact_state_summary = manufacturing_details.get("artifact_state_summary")
        assert isinstance(artifact_state_summary, dict)
        state_counts = artifact_state_summary.get("state_counts")
        assert isinstance(state_counts, dict)
        assert state_counts.get("true_missing_generated_file", 0) > 0
        assert state_counts.get("present_fail_closed_non_release_artifact", 0) > 0
        assert manufacturing_phase.get("manufacturing_artifact_state_counts") == state_counts
        manifest_matrix = manufacturing_details.get("manifest_unblock_matrix")
        assert isinstance(manifest_matrix, list)
        assert manifest_matrix
        assert all(
            isinstance(row, dict)
            and isinstance(row.get("generation_commands"), list)
            and row["generation_commands"]
            and isinstance(row.get("primary_paths"), list)
            and row["primary_paths"]
            for row in manifest_matrix
        )

        top_level_manufacturing = report.get("manufacturing_artifact_details")
        assert isinstance(top_level_manufacturing, dict)
        assert top_level_manufacturing.get("artifact_state_summary") == artifact_state_summary

        phone_phase = phase_map["phone_fabrication_enclosure_release"]
        phone_generation_counts = phone_phase["repo_generation_category_counts"]
        assert phone_generation_counts["repo_generatable_now"] == 0
        assert (
            phone_generation_counts["blocked_by_external_evidence"]
            + phone_generation_counts["blocked_by_release_approval"]
            + phone_generation_counts["blocked_by_live_hardware"]
        ) > 0

    detail_checks = report["detail_checks"]
    assert isinstance(detail_checks, dict)
    assert "pd_signoff" in detail_checks
    assert "manufacturing_release" in detail_checks
    for name in ("pd_signoff", "manufacturing_release"):
        assert isinstance(detail_checks[name].get("blocked_status"), bool)
    assert detail_checks["pd_signoff"]["blocked_status"] is True
    assert detail_checks["manufacturing_release"]["blocked_status"] is True
    assert "release_checks" in detail_checks
    release_checks = detail_checks["release_checks"]
    assert isinstance(release_checks, list)
    for check in release_checks:
        assert isinstance(check, dict)
        assert isinstance(check.get("blocked_status"), bool)
    scripts = {check.get("script") for check in release_checks if isinstance(check, dict)}
    assert "scripts/check_pd_release_evidence.py" in scripts
    assert "scripts/check_e1_phone_fabrication_release.py" in scripts
    assert "scripts/check_e1_phone_release_approval_signatures.py" in scripts
    assert "scripts/check_e1_phone_supplier_return_content.py" in scripts
    assert "scripts/check_e1_phone_routed_output_content.py" in scripts
    assert "scripts/check_e1_phone_factory_output_content.py" in scripts
    assert "scripts/check_e1_phone_first_article_content.py" in scripts
    assert "scripts/check_e1_phone_enclosure_mechanical_content.py" in scripts
    assert "scripts/check_phone_runtime_readiness_contract.py" in scripts

    if release_mode:
        preflight_checks = report["preflight_checks"]
        assert isinstance(preflight_checks, list)
        antenna_preflight = next(
            check
            for check in preflight_checks
            if isinstance(check, dict)
            and isinstance(check.get("command"), list)
            and check["command"][-1] == "scripts/check_antenna_metadata.py"
        )
        assert antenna_preflight["blocked_status"] is True
        assert any(
            blocker.startswith(
                "product preflight check reported blocked state: scripts/check_antenna_metadata.py"
            )
            for blocker in report["release_blockers"]
        )
        assert not any(
            blocker == "product preflight check failed: scripts/check_antenna_metadata.py"
            for blocker in report["release_blockers"]
        )


def main() -> int:
    scaffold = run_product_check()
    assert scaffold.returncode == 0, scaffold.stdout[-4000:]
    assert "release blockers remain documented" in scaffold.stdout
    assert_blocked_report(load_report(), release_mode=False)

    release = run_product_check("--release")
    assert release.returncode == 1, release.stdout[-4000:]
    assert "STATUS: BLOCKED product release check" in release.stdout
    assert "product release check failed" in release.stdout
    assert_blocked_report(load_report(), release_mode=True)

    json_only = run_product_check("--release", "--json-only")
    assert json_only.returncode == 1, json_only.stdout[-4000:]
    payload = json.loads(json_only.stdout)
    assert payload["schema"] == "eliza.product_release_status.v1"
    assert payload["status"] == "blocked"
    assert payload["release_mode"] is True
    assert json_only.stdout.lstrip().startswith("{")
    assert "product release check failed" not in json_only.stdout
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
