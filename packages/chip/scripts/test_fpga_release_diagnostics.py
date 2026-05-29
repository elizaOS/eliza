#!/usr/bin/env python3
"""Tests for e1-demo FPGA release blocker diagnostics."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECK_PATH = ROOT / "scripts/check_fpga_release.py"

spec = importlib.util.spec_from_file_location("check_fpga_release", CHECK_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"unable to import {CHECK_PATH}")
check_fpga_release = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = check_fpga_release
spec.loader.exec_module(check_fpga_release)


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


class FpgaReleaseDiagnosticsTest(unittest.TestCase):
    def test_report_provenance_sanitizer_strips_host_local_paths(self) -> None:
        payload = {
            "path": "/home/shaw/milady/eliza/packages/chip/external/oss-cad-suite/bin/yosys",
            "command": (
                "PATH=/home/shaw/milady/eliza/packages/chip/external/oss-cad-suite/bin:$PATH "
                "TOP=e1_chip_top make -C board/fpga synth"
            ),
            "tmp": "/tmp/fpga-release/run.log",
        }

        sanitized = check_fpga_release.provenance_safe_value(payload)
        encoded = json.dumps(sanitized, sort_keys=True)

        self.assertNotIn("/home/shaw", encoded)
        self.assertNotIn("/tmp/fpga-release", encoded)
        self.assertIn("packages/chip/external/oss-cad-suite/bin/yosys", encoded)

    def test_release_report_groups_blockers_and_quarantines_diagnostics(self) -> None:
        result = run(["python3", "scripts/check_fpga_release.py", "--release"])
        self.assertEqual(result.returncode, 2, result.stdout)

        report = json.loads((ROOT / "build/reports/fpga_release.json").read_text())
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(
            report["blocked_state"],
            "known_fail_closed_release_evidence_blocked",
        )
        self.assertFalse(report["release_credit"])
        self.assertFalse(report["summary"]["release_ready"])
        self.assertFalse(report["summary"]["release_credit"])
        self.assertGreaterEqual(report["summary"]["blocker_groups"], 3)
        self.assertGreaterEqual(report["summary"]["blocker_category_count"], 10)
        self.assertIn("blocker_category_counts", report["summary"])
        self.assertEqual(
            report["summary"]["blocker_category_counts"]["missing_bitstream_evidence"],
            3,
        )
        self.assertEqual(report["summary"]["missing_locate_comp_assignment_count"], 0)
        self.assertEqual(report["summary"]["missing_programming_evidence_count"], 2)
        self.assertEqual(report["summary"]["repo_generatable_now_count"], 0)
        self.assertEqual(report["blocker_dependency_counts"]["repo_artifact_generation"], 0)
        self.assertEqual(
            report["blocker_dependency_counts"]["actionable_external_dependency"],
            report["summary"]["blockers"],
        )
        self.assertGreaterEqual(report["summary"]["blocked_repo_generation_count"], 15)
        self.assertGreaterEqual(report["summary"]["present_but_nonrelease_artifact_count"], 1)
        self.assertIn("release_artifacts", report["blocker_groups"])
        self.assertEqual(
            report["blocker_groups"]["release_artifacts"]["dependency_type"],
            "actionable_external_dependency",
        )
        self.assertIn("synthesis_runtime", report["blocker_groups"])
        self.assertNotIn("rtl_synthesis", report["blocker_groups"])
        self.assertNotIn("toolchain", report["blocker_groups"])
        self.assertNotIn("manifest_commands", report["blocker_groups"])
        self.assertEqual(
            report["diagnostic_evidence"]["release_credit"],
            False,
        )
        self.assertEqual(
            report["toolchain_summary"]["status"],
            "tools_available",
        )
        self.assertEqual(report["toolchain_summary"]["missing_required_tools"], [])
        self.assertEqual(
            report["tool_availability"]["yosys"]["source"],
            "repo_local_oss_cad_suite",
        )
        self.assertTrue(report["tool_availability"]["yosys"]["available"])
        self.assertEqual(
            report["release_commands"]["synth"]["command"],
            "TOP=e1_chip_top make -C board/fpga synth",
        )
        self.assertTrue(report["release_commands"]["synth"]["manifest_matches_release_top"])
        self.assertEqual(
            report["release_artifact_requirements"]["bitstream"]["unblock_command"],
            "TOP=e1_chip_top make -C board/fpga pack",
        )
        categories = report["release_blocker_categories"]
        self.assertEqual(categories["scaffold_target"]["current_value"], "scaffold")
        self.assertEqual(categories["unassigned_exact_revision"]["count"], 1)
        self.assertEqual(categories["missing_locate_comp_assignments"]["count"], 0)
        self.assertEqual(categories["missing_iobuf_declarations"]["count"], 0)
        self.assertEqual(categories["missing_bitstream_evidence"]["count"], 3)
        self.assertEqual(categories["missing_timing_evidence"]["count"], 3)
        self.assertEqual(categories["missing_route_evidence"]["count"], 1)
        self.assertEqual(categories["missing_pack_evidence"]["count"], 1)
        self.assertEqual(categories["missing_programming_evidence"]["count"], 2)
        self.assertEqual(categories["missing_tool_version_evidence"]["count"], 2)
        self.assertEqual(categories["pin_release_flag_blocked"]["count"], 1)
        self.assertEqual(categories["manifest_not_promoted"]["count"], 1)
        self.assertEqual(categories["nonrelease_build_probe_blocked"]["count"], 1)
        self.assertGreaterEqual(categories["present_but_nonrelease_artifacts"]["count"], 1)
        generation = report["repo_artifact_generation_plan"]
        self.assertFalse(generation["release_credit"])
        self.assertEqual(generation["repo_generatable_now_count"], 0)
        self.assertEqual(generation["can_close_from_current_repo_count"], 0)
        self.assertEqual(generation["missing_required_tool_count"], 0)
        self.assertGreaterEqual(generation["blocked_generation_count"], 15)
        self.assertGreaterEqual(generation["blocked_by_final_pins_or_board_revision_count"], 1)
        self.assertGreaterEqual(generation["blocked_by_release_artifact_evidence_count"], 10)
        generation_rows = {row["category"]: row for row in generation["rows"]}
        self.assertIn("missing_bitstream_evidence", generation_rows)
        self.assertFalse(generation_rows["missing_bitstream_evidence"]["repo_generatable_now"])
        self.assertIn(
            "final_pins_or_board_revision",
            generation_rows["missing_bitstream_evidence"]["blocked_by"],
        )
        self.assertIn("nonrelease_build_probe_blocked", generation_rows)
        self.assertIn(
            "synthesis_runtime_or_rtl_closure",
            generation_rows["nonrelease_build_probe_blocked"]["blocked_by"],
        )
        self.assertFalse(categories["missing_programming_evidence"]["release_credit"])
        self.assertEqual(
            categories["missing_programming_evidence"]["unblock_command"],
            "openFPGALoader -b ulx3s build/fpga/e1_demo/e1_chip_top.bit",
        )
        bitstream_requirement = report["release_artifact_requirements"]["bitstream"]
        self.assertEqual(
            bitstream_requirement["source_manifest"],
            "board/fpga/artifact-manifest.yaml",
        )
        self.assertEqual(
            bitstream_requirement["expected_command_output"]["accepted_exit_code"],
            0,
        )
        self.assertIn(
            "build/fpga/e1_demo/**/*.bit",
            bitstream_requirement["patterns"],
        )
        programming_requirement = report["release_artifact_requirements"]["programming transcript"]
        self.assertEqual(
            programming_requirement["unblock_command"],
            "openFPGALoader -b ulx3s build/fpga/e1_demo/e1_chip_top.bit",
        )
        self.assertTrue(programming_requirement["missing"])
        self.assertIn("accepted_artifact_paths", bitstream_requirement)
        archive = report["release_evidence_archive_contract"]
        self.assertFalse(archive["release_credit"])
        self.assertEqual(archive["status"], "blocked")
        self.assertEqual(
            archive["next_action_id"],
            "fpga-release-evidence-archive-001",
        )
        self.assertIn("exact_board_revision_recorded", archive["blocked_preconditions"])
        self.assertIn("pin_block_flag_cleared", archive["blocked_preconditions"])
        self.assertIn("release_evidence.bitstream_path", archive["blocked_fields"])
        self.assertIn("release_evidence.bitstream_sha256", archive["blocked_fields"])
        self.assertIn("release_evidence.programming_transcript", archive["blocked_fields"])
        archive_fields = {item["field"]: item for item in archive["required_fields"]}
        self.assertEqual(
            archive_fields["release_evidence.bitstream_path"]["producer_command"],
            "TOP=e1_chip_top make -C board/fpga pack",
        )
        self.assertEqual(
            archive_fields["release_evidence.bitstream_sha256"]["required_value_type"],
            "sha256_hex",
        )
        self.assertIn(
            "build/fpga/e1_demo/e1_chip_top.bit",
            archive_fields["release_evidence.bitstream_sha256"]["validation_command"],
        )
        self.assertTrue(archive_fields["release_evidence.timing_report"]["artifact_missing"])
        self.assertEqual(
            archive_fields["release_evidence.archived_tool_versions"]["expected_path_pattern"],
            "board/fpga/reports/tool_versions.txt",
        )
        self.assertEqual(
            archive_fields["release_evidence.programming_transcript"]["producer_command"],
            "openFPGALoader -b ulx3s build/fpga/e1_demo/e1_chip_top.bit",
        )
        glob_audit = report["manifest_artifact_glob_audit"]
        self.assertFalse(glob_audit["release_credit"])
        self.assertEqual(glob_audit["status"], "blocked")
        self.assertEqual(glob_audit["next_action_id"], "fpga-manifest-globs-001")
        self.assertIn("bitstream", glob_audit["blocked_artifacts"])
        self.assertIn("nextpnr_timing_report", glob_audit["blocked_artifacts"])
        glob_rows = {item["name"]: item for item in glob_audit["artifacts"]}
        self.assertIn(
            "board/fpga/build/e1_demo_smoke/**/*.bit",
            glob_rows["bitstream"]["diagnostic_only_globs"],
        )
        self.assertIn(
            "board/fpga/reports/e1_demo_smoke/**/*timing*.txt",
            glob_rows["nextpnr_timing_report"]["diagnostic_only_globs"],
        )
        self.assertTrue(glob_rows["nextpnr_timing_report"]["missing_release_glob"])
        self.assertFalse(glob_rows["fpga_tool_versions"]["missing_release_glob"])
        pin_diag = report["pin_constraint_diagnostics"]
        self.assertFalse(pin_diag["release_credit"])
        self.assertTrue(pin_diag["lpf_complete_for_required_ports"])
        self.assertTrue(pin_diag["lpf_conflict_free"])
        self.assertTrue(pin_diag["non_release_build_probe_allowed"])
        self.assertFalse(pin_diag["release_safe_pin_assignment"])
        self.assertIn(
            "exact FPGA board revision is unassigned",
            pin_diag["release_safe_pin_assignment_blockers"],
        )
        self.assertEqual(pin_diag["conflicting_locate_ports"], {})
        self.assertEqual(pin_diag["conflicting_iobuf_ports"], {})
        self.assertEqual(pin_diag["duplicate_sites"], {})
        handoff = report["pin_board_revision_handoff_contract"]
        self.assertFalse(handoff["release_credit"])
        self.assertEqual(handoff["next_action_id"], "fpga-pin-board-001")
        self.assertIn("exact board revision evidence", handoff["review_packet"])
        self.assertIn(
            "python3 scripts/check_fpga_release.py --release",
            handoff["bounded_validation_commands"],
        )
        handoff_fields = {item["field"]: item for item in handoff["required_fields"]}
        self.assertEqual(handoff_fields["board.exact_revision"]["status"], "missing")
        self.assertEqual(
            handoff_fields["constraints.bitstream_release_blocked_until_pins_assigned"]["status"],
            "blocking",
        )
        self.assertEqual(
            handoff["pin_diagnostic_summary"]["release_safe_pin_assignment_blockers"],
            pin_diag["release_safe_pin_assignment_blockers"],
        )
        promotion = report["target_status_promotion_contract"]
        self.assertFalse(promotion["release_credit"])
        self.assertEqual(promotion["status"], "blocked")
        self.assertEqual(promotion["next_action_id"], "fpga-target-promotion-001")
        self.assertEqual(promotion["current_target_status"], "scaffold")
        self.assertEqual(promotion["required_target_status"], "release_ready")
        self.assertIn("board/fpga/e1_demo_fpga.yaml", promotion["source_manifests"])
        self.assertIn("board/fpga/artifact-manifest.yaml", promotion["source_manifests"])
        self.assertGreaterEqual(promotion["blocked_count"], 10)
        self.assertIn("target-status-001", promotion["blocked_criteria"])
        self.assertIn(
            "target-status-release-evidence-bitstream-path",
            promotion["blocked_criteria"],
        )
        self.assertIn(
            "target-status-artifact-bitstream",
            promotion["blocked_criteria"],
        )
        promotion_criteria = {item["id"]: item for item in promotion["criteria"]}
        self.assertEqual(
            promotion_criteria["target-status-001"]["field"],
            "board/fpga/e1_demo_fpga.yaml:status",
        )
        self.assertEqual(
            promotion_criteria["target-status-002"]["field"],
            "board.exact_revision",
        )
        for criterion in promotion["criteria"]:
            self.assertFalse(criterion["release_credit"])
            self.assertIn("source_manifest", criterion)
            self.assertIn("accepted_artifact_paths", criterion)
            self.assertIn("expected_command_output", criterion)
            self.assertEqual(
                criterion["expected_command_output"]["accepted_exit_code"],
                0,
            )
        self.assertEqual(
            promotion_criteria["target-status-008"]["current_value"],
            "draft",
        )
        self.assertEqual(
            promotion_criteria["target-status-010"]["current_value"],
            "timed_out_non_release",
        )
        self.assertEqual(
            promotion_criteria["target-status-release-evidence-bitstream-sha256"]["current_value"],
            "unassigned",
        )
        self.assertEqual(
            promotion_criteria["target-status-release-evidence-programming-transcript"][
                "current_value"
            ],
            "unassigned",
        )
        build_probe = report["latest_non_release_build_probe"]
        self.assertFalse(build_probe["release_credit"])
        self.assertEqual(build_probe["status"], "timed_out_non_release")
        self.assertIsNotNone(build_probe["latest"])
        latest_probe = build_probe["latest"]
        self.assertEqual(
            latest_probe["failure_class"],
            "timeout_or_interrupted_post_abc9_oversize",
        )
        self.assertEqual(latest_probe["failure_stage"], "post_abc9_autoname")
        self.assertTrue(latest_probe["abc9_completed"])
        self.assertTrue(latest_probe["autoname_reached"])
        self.assertEqual(latest_probe["last_yosys_pass"], "AUTONAME")
        self.assertEqual(latest_probe["errors"], [])
        diagnostics = {item["id"]: item for item in report["bounded_synthesis_diagnostics"]}
        self.assertIn("preabc_profile", diagnostics)
        profile = diagnostics["preabc_profile"]
        self.assertFalse(profile["release_credit"])
        self.assertIn("make -C board/fpga synth-profile", profile["exact_command"])
        self.assertIn("Stop before synth_ecp5", profile["diagnostic_goal"])
        if profile["status"] != "not_run":
            self.assertEqual(profile["failure_class"], "none")
            self.assertEqual(profile["failure_stage"], "completed_yosys_synthesis")
            self.assertTrue(profile["profile_summary"]["completed_stat"])
            self.assertGreaterEqual(profile["profile_summary"]["module_count"], 1)
            self.assertTrue(profile["profile_summary"]["largest_modules_by_cells"])
            self.assertFalse(profile["profile_summary"]["release_credit"])
            pressure = profile["profile_summary"]["memory_rom_synthesis_pressure"]
            self.assertFalse(pressure["release_credit"])
            self.assertGreaterEqual(pressure["total_memory_bits"], 524416)
            self.assertGreaterEqual(pressure["memory_replaced_with_registers_count"], 1)
            self.assertGreaterEqual(pressure["meminit_v2_cells"], 1)
            pressure_by_module = {item["module"]: item for item in pressure["modules"]}
            self.assertIn("e1_behavioral_dram", pressure_by_module)
            self.assertIn("e1_bootrom", pressure_by_module)
            self.assertIn("e1_weight_buffer_sram", pressure_by_module)
            self.assertEqual(
                pressure_by_module["e1_behavioral_dram"]["pressure_class"],
                "memory_or_rom_expansion",
            )
            self.assertIn(
                "FPGA-specific BRAM/external-memory model",
                pressure_by_module["e1_behavioral_dram"]["next_step"],
            )
            self.assertEqual(
                pressure_by_module["e1_behavioral_dram"]["next_action_id"],
                "fpga-memory-001",
            )
            next_actions = pressure["next_actions"]
            self.assertGreaterEqual(len(next_actions), 3)
            actions_by_module = {item["module"]: item for item in next_actions}
            self.assertIn("e1_behavioral_dram", actions_by_module)
            self.assertIn("e1_bootrom", actions_by_module)
            self.assertIn("e1_weight_buffer_sram", actions_by_module)
            dram_action = actions_by_module["e1_behavioral_dram"]
            self.assertFalse(dram_action["release_credit"])
            self.assertEqual(dram_action["action_id"], "fpga-memory-001")
            self.assertEqual(dram_action["task_type"], "external_sram_or_bram_model")
            self.assertIn("external SRAM shim", dram_action["remediation_target"])
            self.assertIn("preabc profile", dram_action["acceptance_check"])
            self.assertIn("synth-profile", dram_action["bounded_diagnostic_command"])
            self.assertEqual(
                dram_action["validation_command"],
                "python3 scripts/check_fpga_release.py --release",
            )
            priorities = [item["priority"] for item in next_actions]
            self.assertEqual(priorities, sorted(priorities))
        self.assertIn("noabc9", diagnostics)
        noabc9 = diagnostics["noabc9"]
        self.assertFalse(noabc9["release_credit"])
        self.assertIn("SYNTH_ECP5_FLAGS=-noabc9", noabc9["exact_command"])
        if noabc9["status"] != "not_run":
            self.assertEqual(
                noabc9["failure_class"],
                "timeout_or_interrupted_classic_abc_mapping",
            )
            self.assertEqual(noabc9["failure_stage"], "classic_abc_mapping")
            self.assertTrue(noabc9["runtime_markers"]["observed_runtime_pressure"])
            self.assertGreaterEqual(noabc9["runtime_markers"]["max_hashed_cells"], 600000)

        inventory = report["artifact_inventory"]
        self.assertIn("FPGA tool versions", inventory)
        self.assertIn("programming transcript", inventory)
        self.assertFalse(inventory["programming transcript"]["release_credit"])
        self.assertTrue(inventory["programming transcript"]["missing"])
        self.assertFalse(inventory["FPGA tool versions"]["release_credit"])
        self.assertTrue(inventory["FPGA tool versions"]["matches"])
        self.assertEqual(
            len({match["path"] for match in inventory["FPGA tool versions"]["matches"]}),
            len(inventory["FPGA tool versions"]["matches"]),
        )
        self.assertTrue(
            all(match["diagnostic_only"] for match in inventory["FPGA tool versions"]["matches"])
        )
        timing = inventory["nextpnr timing report"]
        self.assertTrue(timing["matches"])
        self.assertFalse(timing["release_credit"])
        self.assertTrue(any(match["diagnostic_only"] for match in timing["matches"]))

        for finding in report["findings"]:
            self.assertIn("group", finding)
            self.assertEqual(finding["dependency_type"], "actionable_external_dependency")

    def test_diagnostic_generator_writes_non_release_credit_transcripts(self) -> None:
        result = run(["python3", "scripts/generate_e1_demo_fpga_blocked_cli_evidence.py"])
        self.assertEqual(result.returncode, 0, result.stdout)

        transcript = ROOT / "board/fpga/reports/diagnostics/e1-demo-fpga-command-transcript.txt"
        tools = ROOT / "board/fpga/reports/diagnostics/e1-demo-fpga-tool-availability.txt"
        for path in (transcript, tools):
            self.assertTrue(path.is_file(), path)
            text = path.read_text(encoding="utf-8")
            self.assertIn("release_credit: false", text)
            self.assertIn("not release", text)
        transcript_text = transcript.read_text(encoding="utf-8")
        self.assertIn("required_release_top: e1_chip_top", transcript_text)
        self.assertIn(
            "source_manifests: [board/fpga/e1_demo_fpga.yaml, board/fpga/artifact-manifest.yaml]",
            transcript_text,
        )
        self.assertIn("TOP=e1_chip_top make -C board/fpga pack", transcript_text)
        self.assertIn(
            "exact_toolchain_command: source scripts/env_oss_cad_suite.sh", transcript_text
        )
        self.assertIn("exact_non_release_probe_command:", transcript_text)
        self.assertIn("latest_non_release_build_probe:", transcript_text)
        self.assertIn("failure_class: timeout_or_interrupted_post_abc9_oversize", transcript_text)
        self.assertIn("failure_stage: post_abc9_autoname", transcript_text)
        self.assertIn("timed_out_or_interrupted: true", transcript_text)
        self.assertIn("bounded_synthesis_diagnostics:", transcript_text)
        self.assertIn("id: preabc_profile", transcript_text)
        self.assertIn("make -C board/fpga synth-profile", transcript_text)
        self.assertIn("profile_completed_stat:", transcript_text)
        self.assertIn("memory_rom_pressure_top_module:", transcript_text)
        self.assertIn("memory_replaced_with_registers_count:", transcript_text)
        self.assertIn("meminit_v2_cells:", transcript_text)
        self.assertIn("memory_rom_next_actions:", transcript_text)
        self.assertIn("action_id: fpga-memory-001", transcript_text)
        self.assertIn("module: e1_behavioral_dram", transcript_text)
        self.assertIn("task_type: external_sram_or_bram_model", transcript_text)
        self.assertIn("pin_board_revision_handoff_contract:", transcript_text)
        self.assertIn("next_action_id: fpga-pin-board-001", transcript_text)
        self.assertIn("field: board.exact_revision", transcript_text)
        self.assertIn("field: constraints.final_lpf", transcript_text)
        self.assertIn("release_safe_pin_assignment: false", transcript_text)
        self.assertIn("target_status_promotion_contract:", transcript_text)
        self.assertIn("next_action_id: fpga-target-promotion-001", transcript_text)
        self.assertIn("source_manifest: board/fpga/e1_demo_fpga.yaml", transcript_text)
        self.assertIn("accepted_artifact_paths:", transcript_text)
        self.assertIn("expected_command_output:", transcript_text)
        self.assertIn("current_target_status: scaffold", transcript_text)
        self.assertIn("field: board/fpga/e1_demo_fpga.yaml:status", transcript_text)
        self.assertIn("id: target-status-artifact-bitstream", transcript_text)
        self.assertIn("release_artifact_requirements:", transcript_text)
        self.assertIn("label: bitstream", transcript_text)
        self.assertIn("source_manifest: board/fpga/artifact-manifest.yaml", transcript_text)
        self.assertIn("accepted_exit_code: 0", transcript_text)
        self.assertIn("manifest_artifact_glob_audit:", transcript_text)
        self.assertIn("next_action_id: fpga-manifest-globs-001", transcript_text)
        self.assertIn("name: nextpnr_timing_report", transcript_text)
        self.assertIn("missing_release_glob: true", transcript_text)
        self.assertIn("board/fpga/reports/e1_demo_smoke/**/*timing*.txt", transcript_text)
        self.assertIn("release_evidence_archive_contract:", transcript_text)
        self.assertIn("next_action_id: fpga-release-evidence-archive-001", transcript_text)
        self.assertIn("field: release_evidence.bitstream_path", transcript_text)
        self.assertIn("expected_path_pattern: build/fpga/e1_demo/e1_chip_top.bit", transcript_text)
        self.assertIn("producer_command: TOP=e1_chip_top make -C board/fpga pack", transcript_text)
        self.assertIn("SYNTH_ECP5_FLAGS=-noabc9", transcript_text)
        self.assertIn("manifest_commands:", transcript_text)
        tools_text = tools.read_text(encoding="utf-8")
        self.assertIn("missing_required_tools: []", tools_text)
        self.assertIn("source: repo_local_oss_cad_suite", tools_text)


if __name__ == "__main__":
    unittest.main()
