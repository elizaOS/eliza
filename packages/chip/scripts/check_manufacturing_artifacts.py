#!/usr/bin/env python3
import hashlib
import json
import re
import sys
from argparse import ArgumentParser
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/manufacturing_artifacts.json"
DEFAULT_RESOLVED_MANIFEST = ROOT / "build/reports/manufacturing-resolved-artifacts.json"
SCHEMA = "eliza.manufacturing_artifacts.v1"
CLAIM_BOUNDARY = "manufacturing_artifact_inventory_only_not_fabrication_release_evidence"
DEFAULT_MANIFESTS = [
    "docs/manufacturing/artifact-manifest.yaml",
    "package/artifact-manifest.yaml",
    "board/kicad/e1-demo/artifact-manifest.yaml",
    "board/kicad/e1-phone/artifact-manifest.yaml",
    "board/fpga/artifact-manifest.yaml",
]
MANIFEST_OWNER_PATHS = {
    "manufacturing_physical_evidence": "docs/manufacturing/artifact-manifest.yaml",
    "package_vendor_padframe_evidence": "package/artifact-manifest.yaml",
    "e1_demo_kicad_board_evidence": "board/kicad/e1-demo/artifact-manifest.yaml",
    "board/kicad/e1-phone/artifact-manifest.yaml": "board/kicad/e1-phone/artifact-manifest.yaml",
    "e1_demo_fpga_bitstream_evidence": "board/fpga/artifact-manifest.yaml",
}
MANIFEST_GENERATION_GUIDANCE = {
    "manufacturing_physical_evidence": {
        "primary_paths": [
            "docs/manufacturing/artifact-manifest.yaml",
            "docs/manufacturing/release-manifest.yaml",
            "docs/manufacturing/evidence/",
        ],
        "generation_commands": [
            "python3 scripts/check_manufacturing_artifacts.py --resolved-manifest build/reports/manufacturing-resolved-artifacts.json",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
    "package_vendor_padframe_evidence": {
        "primary_paths": [
            "package/artifact-manifest.yaml",
            "package/e1-demo-pinout.yaml",
            "docs/package/e1-demo-package.md",
            "docs/package/e1-demo-pad-ring.md",
            "docs/manufacturing/evidence/package/",
            "build/reports/package_cross_probe.json",
        ],
        "generation_commands": [
            "python3 scripts/check_package_cross_probe.py --release",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
    "e1_demo_kicad_board_evidence": {
        "primary_paths": [
            "board/kicad/e1-demo/artifact-manifest.yaml",
            "board/kicad/e1-demo/",
            "docs/board/kicad/e1-demo/fab-notes.md",
            "docs/manufacturing/evidence/board/",
            "build/reports/kicad_artifacts.json",
        ],
        "generation_commands": [
            "python3 scripts/check_kicad_artifacts.py --release",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
    "board/kicad/e1-phone/artifact-manifest.yaml": {
        "primary_paths": [
            "board/kicad/e1-phone/artifact-manifest.yaml",
            "board/kicad/e1-phone/routed-release-plan.yaml",
            "board/kicad/e1-phone/production/routed-output-candidate-manifest-2026-05-22.yaml",
            "board/kicad/e1-phone/production/factory-output-candidate-manifest-2026-05-22.yaml",
            "mechanical/e1-phone/review/mechanical-cad-evidence-inventory-2026-05-22.yaml",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_routed_output_content.py",
            "python3 scripts/check_e1_phone_factory_output_content.py",
            "python3 scripts/check_e1_phone_enclosure_mechanical_content.py",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
    "e1_demo_fpga_bitstream_evidence": {
        "primary_paths": [
            "board/fpga/artifact-manifest.yaml",
            "board/fpga/e1_demo_fpga.yaml",
            "board/fpga/constraints/e1_demo_ulx3s.lpf",
            "build/reports/fpga_release.json",
        ],
        "generation_commands": [
            "python3 scripts/check_fpga_release.py --release",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
}
TRUE_MISSING_STATES = {
    "true_missing_generated_file",
    "true_missing_release_output",
    "true_missing_checksum_manifest",
}
PHONE_RELEASE_OUTPUT_GENERATION_PLAN = {
    "schematic_erc_report": {
        "generation_status": "blocked_by_schematic_release_gate",
        "can_generate_from_repo_now": False,
        "required_before_generation": [
            "complete non-scaffold hierarchical schematic",
            "clean KiCad ERC transcript from the release schematic",
            "approval metadata for board revision and ERC result",
        ],
        "generation_commands": [
            "python3 scripts/generate_e1_phone_schematic.py",
            "python3 scripts/generate_e1_phone_routed_release_plan.py",
            "python3 scripts/check_e1_phone_board_package.py",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
    "pcb_drc_report": {
        "generation_status": "blocked_by_routed_pcb_release_gate",
        "can_generate_from_repo_now": False,
        "required_before_generation": [
            "routed KiCad PCB with filled zones",
            "clean KiCad DRC transcript from the release PCB",
            "approval metadata for board revision and DRC result",
        ],
        "generation_commands": [
            "python3 scripts/generate_e1_phone_routed_release_plan.py",
            "python3 scripts/check_e1_phone_routed_output_content.py",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
    "routed_kicad_pcb": {
        "generation_status": "blocked_by_routed_pcb_release_gate",
        "can_generate_from_repo_now": False,
        "required_before_generation": [
            "real routed PCB implementation",
            "release approval metadata for routed board revision",
        ],
        "generation_commands": [
            "python3 scripts/generate_e1_phone_routed_pcb_implementation_execution.py",
            "python3 scripts/check_e1_phone_routed_output_content.py",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
    "filled_zones": {
        "generation_status": "blocked_by_routed_pcb_release_gate",
        "can_generate_from_repo_now": False,
        "required_before_generation": [
            "routed KiCad PCB with release copper pours",
            "zone-fill evidence captured from the routed board",
        ],
        "generation_commands": [
            "python3 scripts/generate_e1_phone_routed_pcb_implementation_execution.py",
            "python3 scripts/check_e1_phone_routed_output_content.py",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
    "gerber_x2": {
        "generation_status": "blocked_by_fabrication_release_gate",
        "can_generate_from_repo_now": False,
        "required_before_generation": [
            "approved routed PCB",
            "KiCad/KiBot fabrication export with signed release metadata",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_routed_output_content.py",
            "python3 scripts/check_e1_phone_fabrication_release.py",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
    "ipc_2581_or_odbpp": {
        "generation_status": "blocked_by_fabrication_release_gate",
        "can_generate_from_repo_now": False,
        "required_before_generation": [
            "approved routed PCB",
            "assembler-neutral fabrication export from release sources",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_routed_output_content.py",
            "python3 scripts/check_e1_phone_fabrication_release.py",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
    "nc_drill_slots": {
        "generation_status": "blocked_by_fabrication_release_gate",
        "can_generate_from_repo_now": False,
        "required_before_generation": [
            "approved routed PCB",
            "KiCad/KiBot drill export with signed release metadata",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_routed_output_content.py",
            "python3 scripts/check_e1_phone_fabrication_release.py",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
    "stackup_impedance_report": {
        "generation_status": "blocked_by_external_fabricator_stackup",
        "can_generate_from_repo_now": False,
        "required_before_generation": [
            "selected fabricator stackup",
            "impedance table and coupon geometry from fabricator or field solver",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_supplier_return_content.py",
            "python3 scripts/check_e1_phone_fabrication_release.py",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
    "position_file": {
        "generation_status": "blocked_by_routed_pcb_release_gate",
        "can_generate_from_repo_now": False,
        "required_before_generation": [
            "approved routed PCB with real footprints",
            "pick-and-place export and convention review",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_routed_output_content.py",
            "python3 scripts/check_e1_phone_fabrication_release.py",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
    "production_bom_avl": {
        "generation_status": "blocked_by_supplier_and_avl_release",
        "can_generate_from_repo_now": False,
        "required_before_generation": [
            "production BOM from final schematic/PCB",
            "approved supplier AVL with exact MPNs, lifecycle, MOQ, lead time, and substitutes",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_supplier_return_content.py",
            "python3 scripts/check_e1_phone_factory_output_content.py",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
    "assembly_drawing": {
        "generation_status": "blocked_by_factory_output_release",
        "can_generate_from_repo_now": False,
        "required_before_generation": [
            "approved routed PCB and BOM",
            "assembly drawing with polarity, DNP, connector, shield, and inspection notes",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_factory_output_content.py",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
    "split_interconnect_assembly_drawing": {
        "generation_status": "blocked_by_enclosure_and_factory_output_release",
        "can_generate_from_repo_now": False,
        "required_before_generation": [
            "approved flex/interconnect supplier drawings",
            "approved enclosure mating order and strain relief evidence",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_enclosure_mechanical_content.py",
            "python3 scripts/check_e1_phone_factory_output_content.py",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
    "board_step_with_supplier_models": {
        "generation_status": "blocked_by_supplier_models_and_routed_step",
        "can_generate_from_repo_now": False,
        "required_before_generation": [
            "routed board STEP",
            "approved supplier 3D models for connectors, modules, shields, and tall components",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_enclosure_mechanical_content.py",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
    "supplier_component_3d_model_manifest": {
        "generation_status": "blocked_by_supplier_models_and_metadata",
        "can_generate_from_repo_now": False,
        "required_before_generation": [
            "approved supplier 3D model files for all production components",
            "component/model traceability manifest with reviewer disposition",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_supplier_return_content.py",
            "python3 scripts/check_e1_phone_enclosure_mechanical_content.py",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
    "enclosure_clearance_report_using_routed_step": {
        "generation_status": "blocked_by_routed_step_and_enclosure_validation",
        "can_generate_from_repo_now": False,
        "required_before_generation": [
            "routed board STEP with supplier models",
            "enclosure clearance run using final component heights",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_enclosure_mechanical_content.py",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
    "si_pi_reports": {
        "generation_status": "blocked_by_post_route_simulation",
        "can_generate_from_repo_now": False,
        "required_before_generation": [
            "post-route USB/MIPI/PCIe/LPDDR/UFS topology",
            "SI/PI simulation and reviewer disposition",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_routed_output_content.py",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
    "rf_reports": {
        "generation_status": "blocked_by_external_rf_measurements",
        "can_generate_from_repo_now": False,
        "required_before_generation": [
            "antenna match and conducted RF measurements",
            "coexistence/GNSS/SAR pre-scan evidence",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_supplier_return_content.py",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
    "power_thermal_measurements": {
        "generation_status": "blocked_by_first_article_measurements",
        "can_generate_from_repo_now": False,
        "required_before_generation": [
            "first-article bench logs",
            "rail sequencing, load-step, charge, discharge, and thermal measurements",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_first_article_content.py",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
    "factory_test_limits": {
        "generation_status": "blocked_by_first_article_measurements",
        "can_generate_from_repo_now": False,
        "required_before_generation": [
            "factory test specification",
            "limits derived from first-article measurements and approved fixture map",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_factory_output_content.py",
            "python3 scripts/check_e1_phone_first_article_content.py",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
    "first_article_traveler": {
        "generation_status": "blocked_by_physical_first_article_build",
        "can_generate_from_repo_now": False,
        "required_before_generation": [
            "EVT1 physical build record",
            "current limits, stop-on-fail rules, and signed traveler disposition",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_first_article_content.py",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
    "fab_assembler_quote": {
        "generation_status": "blocked_by_external_supplier_quote",
        "can_generate_from_repo_now": False,
        "required_before_generation": [
            "fabricator and assembler quote tied to released design package",
            "layer count, HDI, impedance, finish, tolerances, assembly, and test terms",
        ],
        "generation_commands": [
            "python3 scripts/check_e1_phone_supplier_return_content.py",
            "python3 scripts/check_e1_phone_fabrication_release.py",
            "python3 scripts/check_manufacturing_artifacts.py --release",
        ],
    },
}
ALLOWED_STATUS = {"missing", "draft", "complete"}
ALLOWED_MANIFEST_STATUS = {
    "missing",
    "draft",
    "scaffold",
    "pipeline_scaffold",
    "release_blocked",
    "complete",
}


def write_report(
    status: str,
    mode: str,
    manifests: list[str],
    findings: list[str],
    resolved_manifest_path: Path | None = None,
) -> None:
    action_summary = summarize_release_actions(findings)
    manifest_matrix = manifest_unblock_matrix(findings)
    blocker_class_counts = classify_release_blockers(findings)
    payload = {
        "schema": SCHEMA,
        "status": status,
        "generated_utc": datetime.now(UTC).isoformat(),
        "claim_boundary": CLAIM_BOUNDARY,
        "mode": mode,
        "manifests": manifests,
        "resolved_manifest": (
            str(resolved_manifest_path.relative_to(ROOT))
            if resolved_manifest_path is not None and resolved_manifest_path.is_absolute()
            else str(resolved_manifest_path)
            if resolved_manifest_path is not None
            else None
        ),
        "summary": {
            "release_ready": status == "pass" and mode == "release",
            "blockers": len(findings) if status == "blocked" else 0,
            "failures": len(findings) if status == "fail" else 0,
            "action_buckets": action_summary["bucket_counts"],
            "blocker_classes": blocker_class_counts,
            "artifact_state_counts": artifact_state_counts(findings),
            "blocked_manifest_count": len(manifest_matrix),
        },
        "release_unblock_action_summary": action_summary,
        "release_blocker_class_summary": {
            "release_credit": False,
            "class_counts": blocker_class_counts,
            "classes": [
                {
                    "class": blocker_class,
                    "count": blocker_class_counts[blocker_class],
                    "next_step": release_blocker_class_next_step(blocker_class),
                }
                for blocker_class in blocker_class_counts
            ],
        },
        "artifact_state_summary": artifact_state_summary(findings),
        "manifest_unblock_matrix": manifest_matrix,
        "blocker_execution_packets": blocker_execution_packets(findings),
        "findings": [
            {
                **{
                    "code": f"manufacturing_artifacts_{status}_{index}",
                    "severity": "blocker" if status == "blocked" else "error",
                    "message": finding,
                    "evidence": manifests[min(index - 1, len(manifests) - 1)] if manifests else "",
                    "next_step": (
                        "Archive complete package, board, FPGA, SI/PI, current, thermal, "
                        "and fabrication evidence before using this gate as release proof."
                    ),
                    "next_command": "python3 scripts/check_manufacturing_artifacts.py --release",
                    "evidence_requirements": {
                        "manifests": manifests,
                        "required_manifest_status": "complete" if status == "blocked" else None,
                        "required_artifact_status": "complete" if status == "blocked" else None,
                        "required_release_gates": sorted(ALLOWED_RELEASE_GATES),
                    },
                },
                **classify_finding(finding),
            }
            for index, finding in enumerate(findings, start=1)
        ],
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def release_action_bucket(finding: str) -> str:
    if ".release_gates." in finding or ": release gate remains " in finding:
        return "release_gate_closure"
    if ": release output remains missing: " in finding:
        return "phone_release_output_generation"
    if (
        ": release artifact files are missing" in finding
        or ": current artifact file is missing: " in finding
    ):
        return "artifact_file_generation"
    if ": release checksum_manifest is missing: " in finding:
        return "checksum_manifest_generation"
    if ": release requires metadata fields or metadata_globs for: " in finding:
        return "metadata_completion"
    if ": release/status complete cannot reference a dirty working tree revision" in finding:
        return "clean_source_revision"
    if ": release requires manifest status complete, got " in finding:
        return "manifest_status_promotion"
    if ": release requires group status complete, got " in finding:
        return "group_status_promotion"
    if ": release requires status complete, got " in finding:
        return "artifact_status_promotion"
    return "other_release_blocker"


def release_action_next_step(bucket: str) -> str:
    steps = {
        "release_gate_closure": (
            "Close the referenced upstream release gate with real signoff evidence, then rerun "
            "the manufacturing release checker."
        ),
        "phone_release_output_generation": (
            "Generate the missing routed/fabrication/enclosure phone release output from the "
            "production source package and attach approval metadata."
        ),
        "artifact_file_generation": (
            "Create or restore the exact artifact files from real tool/vendor outputs before "
            "promoting the corresponding manifest row."
        ),
        "checksum_manifest_generation": (
            "Generate the required checksum manifest from the final approved artifact files."
        ),
        "metadata_completion": (
            "Attach the required release metadata fields from signed vendor, reviewer, or tool "
            "records."
        ),
        "clean_source_revision": (
            "Regenerate the artifact from a clean committed source revision and record that "
            "revision in metadata."
        ),
        "manifest_status_promotion": (
            "Promote the manifest to complete only after every child group, artifact, checksum, "
            "and release gate is backed by approved evidence."
        ),
        "group_status_promotion": (
            "Promote the artifact group only after all child artifact rows are backed by "
            "approved files and metadata."
        ),
        "artifact_status_promotion": (
            "Promote the artifact row only after its files, checksums, and required metadata are "
            "present and approved."
        ),
        "other_release_blocker": (
            "Resolve the release blocker shown in the finding message, then rerun the checker."
        ),
    }
    return steps[bucket]


def release_blocker_class_next_step(blocker_class: str) -> str:
    steps = {
        "external_release_gate_blocker": (
            "Close the named upstream release gate with signed release evidence; keep this "
            "manufacturing gate blocked until the upstream checker passes."
        ),
        "missing_generated_release_output": (
            "Generate the named routed, fabrication, enclosure, or factory output from the "
            "approved source package and attach release metadata."
        ),
        "missing_generated_artifact_file": (
            "Create or restore the exact artifact file from the real tool or vendor output "
            "before promoting its manifest row."
        ),
        "missing_checksum_manifest": (
            "Generate the checksum manifest from the final approved artifact files."
        ),
        "external_approval_metadata_blocker": (
            "Attach required signed vendor, DFM, reviewer, revision, or checksum metadata."
        ),
        "dirty_source_revision_blocker": (
            "Regenerate and record evidence from a clean committed source revision."
        ),
        "present_non_release_planning_artifact": (
            "Keep the existing local/planning artifact as non-release evidence until review, "
            "approval metadata, and release disposition are present."
        ),
        "non_release_manifest_or_group": (
            "Promote the manifest or group only after all child artifact files, metadata, "
            "checksums, and release gates are complete."
        ),
        "other_release_blocker": (
            "Resolve the specific finding while preserving fail-closed release behavior."
        ),
    }
    return steps.get(blocker_class, steps["other_release_blocker"])


def artifact_state_for_finding(finding: str) -> str:
    blocker_class = release_blocker_class(finding)
    states = {
        "missing_generated_artifact_file": "true_missing_generated_file",
        "missing_generated_release_output": "true_missing_release_output",
        "missing_checksum_manifest": "true_missing_checksum_manifest",
        "present_non_release_planning_artifact": "present_fail_closed_non_release_artifact",
        "external_approval_metadata_blocker": "present_or_declared_but_missing_release_metadata",
        "dirty_source_revision_blocker": "present_but_dirty_source_revision",
        "external_release_gate_blocker": "external_release_gate_open",
        "non_release_manifest_or_group": "manifest_or_group_not_release_promoted",
    }
    return states.get(blocker_class, "blocked_release_condition")


def artifact_state_next_step(state: str) -> str:
    steps = {
        "true_missing_generated_file": (
            "Generate or restore the exact file from the authoritative tool, vendor, or lab "
            "output and keep the manifest row blocked until checksums and metadata are present."
        ),
        "true_missing_release_output": (
            "Generate the named release output from the routed/approved production source "
            "package, then attach approval metadata before promotion."
        ),
        "true_missing_checksum_manifest": (
            "Create the checksum manifest from final approved files and record the manifest "
            "path in the artifact row."
        ),
        "present_fail_closed_non_release_artifact": (
            "Do not regenerate blindly: the file exists but is still draft/planning evidence; "
            "obtain review, approval metadata, checksums, and release disposition first."
        ),
        "present_or_declared_but_missing_release_metadata": (
            "Attach the required signed vendor, reviewer, revision, disposition, and checksum "
            "metadata or metadata glob."
        ),
        "present_but_dirty_source_revision": (
            "Regenerate from a clean committed source revision and update source_revision."
        ),
        "external_release_gate_open": (
            "Close the upstream gate with signed release evidence before this package gate can pass."
        ),
        "manifest_or_group_not_release_promoted": (
            "Promote the manifest/group only after child files, checksums, metadata, and gates are complete."
        ),
        "blocked_release_condition": (
            "Resolve the specific blocker while preserving fail-closed release behavior."
        ),
    }
    return steps[state]


def artifact_state_counts(findings: list[str]) -> dict[str, int]:
    counts = Counter(artifact_state_for_finding(finding) for finding in findings)
    ordered = sorted(counts, key=lambda state: (-counts[state], state))
    return {state: counts[state] for state in ordered}


def artifact_state_summary(findings: list[str]) -> dict[str, object]:
    counts = artifact_state_counts(findings)
    examples: dict[str, list[str]] = {}
    for finding in findings:
        state = artifact_state_for_finding(finding)
        examples.setdefault(state, [])
        if len(examples[state]) < 6:
            examples[state].append(finding)
    return {
        "release_credit": False,
        "state_counts": counts,
        "states": [
            {
                "state": state,
                "count": count,
                "next_step": artifact_state_next_step(state),
                "sample_findings": examples.get(state, []),
            }
            for state, count in counts.items()
        ],
        "true_missing_generation_plan": true_missing_generation_plan(findings),
    }


def _dedupe_commands(commands: list[str]) -> list[str]:
    deduped: list[str] = []
    for command in commands:
        if command not in deduped:
            deduped.append(command)
    return deduped


def generation_plan_for_missing_finding(finding: str) -> dict[str, object]:
    state = artifact_state_for_finding(finding)
    selector = blocker_source_selector(finding)
    plan: dict[str, object] = {
        "release_credit": False,
        "artifact_state": state,
        "source_selector": selector,
        "can_generate_from_repo_now": False,
        "generation_status": "not_a_true_missing_artifact",
        "required_before_generation": [],
        "generation_commands": blocker_next_commands(finding),
    }
    if state not in TRUE_MISSING_STATES:
        return plan

    context = artifact_context_for_selector(selector)
    manifest = finding_manifest_owner(finding)
    plan["artifact_context"] = context

    if state == "true_missing_checksum_manifest":
        plan.update(
            {
                "generation_status": "blocked_until_final_approved_files_exist",
                "can_generate_from_repo_now": False,
                "required_before_generation": [
                    "final approved artifact files matching the manifest glob",
                    "release metadata and reviewer/vendor disposition for the artifact",
                ],
                "generation_commands": _dedupe_commands(
                    blocker_next_commands(finding)
                    + ["python3 scripts/check_manufacturing_artifacts.py --release"]
                ),
            }
        )
        return plan

    if selector.startswith("required_release_output_manifest."):
        output = selector.rsplit(".", 1)[1]
        output_plan = PHONE_RELEASE_OUTPUT_GENERATION_PLAN.get(output, {})
        plan.update(
            {
                "generation_status": output_plan.get(
                    "generation_status", "blocked_by_phone_release_prerequisites"
                ),
                "can_generate_from_repo_now": output_plan.get("can_generate_from_repo_now", False),
                "required_before_generation": list(
                    output_plan.get(
                        "required_before_generation",
                        ["approved phone release source package"],
                    )
                ),
                "generation_commands": _dedupe_commands(
                    list(output_plan.get("generation_commands", []))
                    + blocker_next_commands(finding)
                ),
            }
        )
        return plan

    if manifest == "package_vendor_padframe_evidence":
        plan.update(
            {
                "generation_status": "blocked_external_vendor_or_foundry_evidence_required",
                "can_generate_from_repo_now": False,
                "required_before_generation": [
                    "vendor/foundry package drawing, land pattern, material constraints, bond diagram, or signed cross-probe evidence",
                    "metadata required by package/artifact-manifest.yaml",
                ],
                "generation_commands": _dedupe_commands(
                    [
                        "python3 scripts/check_package_cross_probe.py --release",
                        "python3 scripts/check_manufacturing_artifacts.py --release",
                    ]
                ),
            }
        )
        return plan

    if manifest == "e1_demo_fpga_bitstream_evidence":
        plan.update(
            {
                "generation_status": "repo_diagnostic_generator_available_but_release_output_blocked",
                "can_generate_from_repo_now": False,
                "required_before_generation": [
                    "full-chip FPGA synthesis reaches place-route and pack",
                    "bitstream, nextpnr route report, ecppack transcript, timing report, and tool versions are produced from the release target",
                ],
                "generation_commands": _dedupe_commands(
                    [
                        "python3 scripts/generate_e1_demo_fpga_blocked_cli_evidence.py",
                        "python3 scripts/check_fpga_release.py --release",
                        "python3 scripts/check_manufacturing_artifacts.py --release",
                    ]
                ),
            }
        )
        return plan

    plan.update(
        {
            "generation_status": "blocked_no_safe_repo_generator_identified",
            "can_generate_from_repo_now": False,
            "required_before_generation": [
                "authoritative non-draft release source artifact",
                "release metadata and checksum evidence",
            ],
            "generation_commands": blocker_next_commands(finding),
        }
    )
    return plan


def true_missing_generation_plan(findings: list[str]) -> dict[str, object]:
    plans = [
        generation_plan_for_missing_finding(finding)
        for finding in findings
        if artifact_state_for_finding(finding) in TRUE_MISSING_STATES
    ]
    status_counts = Counter(str(plan["generation_status"]) for plan in plans)
    repo_generatable_now = [
        plan for plan in plans if plan.get("can_generate_from_repo_now") is True
    ]
    return {
        "release_credit": False,
        "target_artifact_count": len(plans),
        "repo_generatable_now_count": len(repo_generatable_now),
        "blocked_generation_count": len(plans) - len(repo_generatable_now),
        "generation_status_counts": {
            status: status_counts[status]
            for status in sorted(status_counts, key=lambda key: (-status_counts[key], key))
        },
        "plans": plans,
    }


def classify_release_blockers(findings: list[str]) -> dict[str, int]:
    counts = Counter(release_blocker_class(finding) for finding in findings)
    ordered = sorted(counts, key=lambda blocker_class: (-counts[blocker_class], blocker_class))
    return {blocker_class: counts[blocker_class] for blocker_class in ordered}


def summarize_release_actions(findings: list[str]) -> dict[str, object]:
    bucket_counts = Counter(release_action_bucket(finding) for finding in findings)
    examples: dict[str, list[str]] = {}
    for finding in findings:
        bucket = release_action_bucket(finding)
        examples.setdefault(bucket, [])
        if len(examples[bucket]) < 5:
            examples[bucket].append(finding)

    ordered_buckets = sorted(bucket_counts, key=lambda bucket: (-bucket_counts[bucket], bucket))
    return {
        "release_credit": False,
        "bucket_counts": {bucket: bucket_counts[bucket] for bucket in ordered_buckets},
        "action_buckets": [
            {
                "bucket": bucket,
                "count": bucket_counts[bucket],
                "next_step": release_action_next_step(bucket),
                "sample_findings": examples[bucket],
                "next_command": "python3 scripts/check_manufacturing_artifacts.py --release",
            }
            for bucket in ordered_buckets
        ],
    }


def finding_owner(finding: str) -> str:
    return finding.split(":", 1)[0]


def finding_manifest_owner(finding: str) -> str:
    owner = finding_owner(finding)
    if owner.startswith("board/kicad/e1-phone/artifact-manifest.yaml"):
        return "board/kicad/e1-phone/artifact-manifest.yaml"
    return owner.split(".", 1)[0]


def manifest_unblock_matrix(findings: list[str]) -> list[dict[str, object]]:
    grouped: dict[str, dict[str, object]] = {}
    for finding in findings:
        manifest = finding_manifest_owner(finding)
        bucket = release_action_bucket(finding)
        row = grouped.setdefault(
            manifest,
            {
                "manifest": manifest,
                "manifest_path": MANIFEST_OWNER_PATHS.get(manifest, manifest),
                "release_credit": False,
                "blocker_count": 0,
                "bucket_counts": Counter(),
                "artifact_state_counts": Counter(),
                "sample_findings": [],
                "next_command": "python3 scripts/check_manufacturing_artifacts.py --release",
                "generation_commands": list(
                    MANIFEST_GENERATION_GUIDANCE.get(manifest, {}).get(
                        "generation_commands",
                        ["python3 scripts/check_manufacturing_artifacts.py --release"],
                    )
                ),
                "primary_paths": list(
                    MANIFEST_GENERATION_GUIDANCE.get(manifest, {}).get(
                        "primary_paths",
                        [MANIFEST_OWNER_PATHS.get(manifest, manifest)],
                    )
                ),
            },
        )
        row["blocker_count"] = int(row["blocker_count"]) + 1
        row["bucket_counts"][bucket] += 1
        row["artifact_state_counts"][artifact_state_for_finding(finding)] += 1
        if len(row["sample_findings"]) < 6:
            row["sample_findings"].append(finding)

    rows: list[dict[str, object]] = []
    for row in grouped.values():
        bucket_counts = row["bucket_counts"]
        assert isinstance(bucket_counts, Counter)
        state_counts = row["artifact_state_counts"]
        assert isinstance(state_counts, Counter)
        ordered = sorted(bucket_counts, key=lambda bucket: (-bucket_counts[bucket], bucket))
        ordered_states = sorted(state_counts, key=lambda state: (-state_counts[state], state))
        rows.append(
            {
                **row,
                "bucket_counts": {bucket: bucket_counts[bucket] for bucket in ordered},
                "artifact_state_counts": {state: state_counts[state] for state in ordered_states},
                "next_steps": [
                    {
                        "bucket": bucket,
                        "count": bucket_counts[bucket],
                        "next_step": release_action_next_step(bucket),
                    }
                    for bucket in ordered
                ],
                "state_next_steps": [
                    {
                        "state": state,
                        "count": state_counts[state],
                        "next_step": artifact_state_next_step(state),
                    }
                    for state in ordered_states
                ],
            }
        )
    return sorted(rows, key=lambda row: (-int(row["blocker_count"]), str(row["manifest"])))


def blocker_source_selector(finding: str) -> str:
    owner = finding_owner(finding)
    if ": release output remains missing: " in finding:
        output = finding.rsplit(": release output remains missing: ", 1)[1]
        return f"required_release_output_manifest.{output}"
    if ".release_gates." in owner:
        return owner.split(".release_gates.", 1)[1]
    if ": release requires metadata fields or metadata_globs for: " in finding:
        return owner
    if ": release checksum_manifest is missing: " in finding:
        return owner
    if ": release artifact files are missing" in finding:
        return owner
    return owner


def blocker_next_commands(finding: str) -> list[str]:
    manifest = finding_manifest_owner(finding)
    commands = list(
        MANIFEST_GENERATION_GUIDANCE.get(manifest, {}).get(
            "generation_commands",
            ["python3 scripts/check_manufacturing_artifacts.py --release"],
        )
    )
    if "python3 scripts/check_manufacturing_artifacts.py --release" not in commands:
        commands.append("python3 scripts/check_manufacturing_artifacts.py --release")
    if manifest == "board/kicad/e1-phone/artifact-manifest.yaml":
        commands.extend(
            [
                "python3 scripts/check_e1_phone_routed_output_content.py",
                "python3 scripts/check_e1_phone_factory_output_content.py",
                "python3 scripts/check_e1_phone_enclosure_mechanical_content.py",
            ]
        )
    elif manifest == "e1_demo_fpga_bitstream_evidence":
        commands.append("python3 scripts/check_fpga_release.py --release")
    elif manifest == "e1_demo_kicad_board_evidence":
        commands.append("python3 scripts/check_kicad_artifacts.py --release")
    deduped: list[str] = []
    for command in commands:
        if command not in deduped:
            deduped.append(command)
    return deduped


def manifest_path_for_owner(owner: str) -> Path | None:
    manifest_name = finding_manifest_owner(owner)
    manifest_path = MANIFEST_OWNER_PATHS.get(manifest_name)
    if manifest_path is None:
        return None
    return ROOT / manifest_path


def _string_list(value: object) -> list[str]:
    return value if isinstance(value, list) and all(isinstance(item, str) for item in value) else []


def artifact_context_for_selector(selector: str) -> dict[str, object]:
    parts = selector.split(".")
    if len(parts) < 3:
        return {"selector": selector, "kind": "manifest_or_group"}
    manifest_name, group_name, artifact_name = parts[0], parts[1], parts[2]
    manifest_path = manifest_path_for_owner(manifest_name)
    if manifest_path is None or not manifest_path.is_file():
        return {
            "selector": selector,
            "kind": "artifact",
            "manifest_path": str(manifest_path) if manifest_path else None,
            "files_present": False,
            "file_paths": [],
        }
    try:
        manifest = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
    except yaml.YAMLError:
        return {
            "selector": selector,
            "kind": "artifact",
            "manifest_path": manifest_path.relative_to(ROOT).as_posix(),
            "files_present": False,
            "file_paths": [],
        }
    groups = manifest.get("artifact_groups", {}) if isinstance(manifest, dict) else {}
    group = groups.get(group_name, {}) if isinstance(groups, dict) else {}
    artifacts = group.get("artifacts", []) if isinstance(group, dict) else []
    for artifact in artifacts if isinstance(artifacts, list) else []:
        if not isinstance(artifact, dict) or artifact.get("name") != artifact_name:
            continue
        files = []
        for pattern in _string_list(artifact.get("globs")):
            files.extend(sorted(path for path in ROOT.glob(pattern) if path.is_file()))
        return {
            "selector": selector,
            "kind": "artifact",
            "manifest_path": manifest_path.relative_to(ROOT).as_posix(),
            "group": group_name,
            "artifact": artifact_name,
            "declared_status": artifact.get("status"),
            "files_present": bool(files),
            "file_paths": [path.relative_to(ROOT).as_posix() for path in files],
            "required_metadata": _string_list(artifact.get("required_metadata")),
            "checksum_manifest": artifact.get("checksum_manifest"),
        }
    return {
        "selector": selector,
        "kind": "artifact",
        "manifest_path": manifest_path.relative_to(ROOT).as_posix(),
        "group": group_name,
        "artifact": artifact_name,
        "files_present": False,
        "file_paths": [],
    }


def release_blocker_class(finding: str) -> str:
    bucket = release_action_bucket(finding)
    if bucket == "release_gate_closure":
        return "external_release_gate_blocker"
    if bucket == "phone_release_output_generation":
        return "missing_generated_release_output"
    if bucket == "artifact_file_generation":
        return "missing_generated_artifact_file"
    if bucket == "checksum_manifest_generation":
        return "missing_checksum_manifest"
    if bucket == "metadata_completion":
        return "external_approval_metadata_blocker"
    if bucket == "clean_source_revision":
        return "dirty_source_revision_blocker"
    if bucket == "artifact_status_promotion":
        selector = finding.split(": release requires status complete, got ", 1)[0]
        context = artifact_context_for_selector(selector)
        if context.get("files_present"):
            return "present_non_release_planning_artifact"
        return "missing_generated_artifact_file"
    if bucket in {"manifest_status_promotion", "group_status_promotion"}:
        return "non_release_manifest_or_group"
    return "other_release_blocker"


def blocker_execution_packets(findings: list[str]) -> list[dict[str, object]]:
    packets: list[dict[str, object]] = []
    for index, finding in enumerate(findings, start=1):
        manifest = finding_manifest_owner(finding)
        bucket = release_action_bucket(finding)
        guidance = MANIFEST_GENERATION_GUIDANCE.get(manifest, {})
        selector = blocker_source_selector(finding)
        repo_generation_plan = generation_plan_for_missing_finding(finding)
        generation_commands = (
            list(repo_generation_plan["generation_commands"])
            if artifact_state_for_finding(finding) in TRUE_MISSING_STATES
            else list(guidance.get("generation_commands", blocker_next_commands(finding)))
        )
        packets.append(
            {
                "id": f"manufacturing_artifact_blocker_{index:03d}",
                "release_credit": False,
                "manifest": manifest,
                "manifest_path": MANIFEST_OWNER_PATHS.get(manifest, manifest),
                "source_selector": selector,
                "bucket": bucket,
                "blocker_class": release_blocker_class(finding),
                "artifact_state": artifact_state_for_finding(finding),
                "finding": finding,
                "next_step": release_action_next_step(bucket),
                "state_next_step": artifact_state_next_step(artifact_state_for_finding(finding)),
                "class_next_step": release_blocker_class_next_step(release_blocker_class(finding)),
                "validation_commands": blocker_next_commands(finding),
                "generation_commands": generation_commands,
                "primary_paths": list(
                    guidance.get("primary_paths", [MANIFEST_OWNER_PATHS.get(manifest, manifest)])
                ),
                "artifact_context": artifact_context_for_selector(selector),
                "repo_generation_plan": repo_generation_plan,
            }
        )
    return packets


REQUIRED_KICAD_COMMANDS = {"erc", "drc", "gerbers", "drill", "bom", "position"}
REQUIRED_FPGA_COMMANDS = {"synth", "place_route", "pack"}
ALLOWED_RELEASE_GATES = {"pd_release", "tapeout_release", "board_fabrication_release"}
ALLOWED_FAIL_CLOSED_PHONE_RELEASE_GATE_STATUSES = {
    "missing",
    "blocked_local_routed_candidate_not_release",
    "blocked_local_cad_passes_but_release_requires_supplier_models_routed_clearance_and_first_article",
}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
CHECKSUM_METADATA_RE = re.compile(r"(^|_)checksum$")
DIRTY_SOURCE_RE = re.compile(r"(\+working-tree|dirty|uncommitted)", re.I)
REQUIRED_GROUP_ARTIFACT_ALIASES = {
    "manufacturing_physical_evidence": {
        "kicad_project": [
            {"kicad_project", "project"},
            {"kicad_schematic", "schematic"},
            {"kicad_pcb", "pcb"},
            {"kicad_symbol_and_footprint_libraries", "vendor_derived_footprint"},
        ],
        "kicad_fabrication_outputs": [
            {"erc_transcript", "erc_report"},
            {"drc_transcript", "drc_report"},
            {"gerber_archive", "gerbers"},
            {"drill_archive", "drill"},
            {"fabrication_bom", "bom"},
            {"pick_and_place", "position"},
        ],
    },
    "e1_demo_kicad_board_evidence": {
        "kicad_sources": [
            {"project", "kicad_project"},
            {"schematic", "kicad_schematic"},
            {"pcb", "kicad_pcb"},
            {"vendor_derived_footprint", "kicad_symbol_and_footprint_libraries"},
        ],
        "kicad_cli_outputs": [
            {"erc_report", "erc_transcript"},
            {"drc_report", "drc_transcript"},
            {"gerbers", "gerber_archive"},
            {"drill", "drill_archive"},
            {"bom", "fabrication_bom"},
            {"pick_and_place", "position"},
        ],
    },
    "e1_demo_fpga_bitstream_evidence": {
        "target_contract": [
            {"fpga_target_contract"},
            {"pin_constraints", "final_pin_constraints"},
        ],
        "bitstream_release": [
            {"bitstream", "ecppack_bitstream"},
            {"nextpnr_timing_report", "nextpnr_timing"},
            {"nextpnr_route_report", "nextpnr_route"},
            {"ecppack_transcript", "pack_transcript"},
            {"fpga_tool_versions", "tool_versions"},
        ],
    },
}


def classify_finding(finding: str) -> dict[str, object]:
    payload: dict[str, object] = {
        "release_action_bucket": release_action_bucket(finding),
        "release_blocker_class": release_blocker_class(finding),
        "artifact_state": artifact_state_for_finding(finding),
        "artifact_state_next_step": artifact_state_next_step(artifact_state_for_finding(finding)),
        "class_next_step": release_blocker_class_next_step(release_blocker_class(finding)),
        "next_commands": blocker_next_commands(finding),
        "primary_paths": list(
            MANIFEST_GENERATION_GUIDANCE.get(finding_manifest_owner(finding), {}).get(
                "primary_paths",
                [
                    MANIFEST_OWNER_PATHS.get(
                        finding_manifest_owner(finding), finding_manifest_owner(finding)
                    )
                ],
            )
        ),
    }
    if ": current artifact file is missing: " in finding:
        path = finding.rsplit(": current artifact file is missing: ", 1)[1]
        payload["missing_artifact"] = path
        payload["next_step"] = (
            f"Restore or generate the exact current artifact {path}, then rerun the "
            "manufacturing release checker."
        )
    elif ": release artifact files are missing" in finding:
        field = finding.split(": release artifact files are missing", 1)[0]
        payload["missing_artifact_selector"] = field
        payload["artifact_context"] = artifact_context_for_selector(field)
        payload["next_step"] = (
            f"Populate real files for artifact selector {field}, then rerun the "
            "manufacturing release checker."
        )
    elif ": status complete but artifact files are missing" in finding:
        field = finding.split(": status complete but artifact files are missing", 1)[0]
        payload["missing_artifact_selector"] = field
        payload["next_step"] = (
            f"Either add the files backing {field} or lower the manifest status until "
            "real files exist."
        )
    elif ": release checksum_manifest is missing: " in finding:
        path = finding.rsplit(": release checksum_manifest is missing: ", 1)[1]
        payload["missing_artifact"] = path
        payload["artifact_context"] = artifact_context_for_selector(
            finding.split(": release checksum_manifest is missing: ", 1)[0]
        )
        payload["next_step"] = (
            f"Generate the checksum manifest {path} from real release outputs, then "
            "rerun the manufacturing release checker."
        )
    elif ": referenced artifact manifest is missing: " in finding:
        path = finding.rsplit(": referenced artifact manifest is missing: ", 1)[1]
        payload["missing_artifact"] = path
        payload["next_step"] = (
            f"Restore referenced artifact manifest {path}, then rerun the manufacturing "
            "release checker."
        )
    elif finding.startswith("missing manifest: "):
        path = finding.removeprefix("missing manifest: ")
        payload["missing_artifact"] = path
        payload["next_step"] = (
            f"Restore manifest {path}, then rerun the manufacturing release checker."
        )
    elif ": release requires status complete, got " in finding:
        field = finding.split(": release requires status complete, got ", 1)[0]
        payload["incomplete_artifact"] = field
        payload["artifact_context"] = artifact_context_for_selector(field)
    elif ": release requires group status complete, got " in finding:
        field = finding.split(": release requires group status complete, got ", 1)[0]
        payload["incomplete_artifact_group"] = field
    elif ": release requires manifest status complete, got " in finding:
        field = finding.split(": release requires manifest status complete, got ", 1)[0]
        payload["incomplete_manifest"] = field
    return payload


def as_list(value: object) -> list[str]:
    return value if isinstance(value, list) and all(isinstance(item, str) for item in value) else []


def repo_path(value: str) -> Path:
    return ROOT / value


def validate_schema_ref(manifest_name: str, schema_ref: object, failures: list[str]) -> None:
    if not isinstance(schema_ref, str) or not schema_ref:
        failures.append(f"{manifest_name}: missing schema")
        return
    path = Path(schema_ref)
    if path.is_absolute() or ".." in path.parts:
        failures.append(f"{manifest_name}: schema must be a relative repo path: {schema_ref}")
    elif not repo_path(schema_ref).is_file():
        failures.append(f"{manifest_name}: referenced schema is missing: {schema_ref}")


def validate_globs(field: str, globs: object, failures: list[str]) -> list[str]:
    glob_list = as_list(globs)
    if not glob_list:
        failures.append(f"{field}: missing globs")
        return []
    for pattern in glob_list:
        path = Path(pattern)
        if path.is_absolute() or ".." in path.parts:
            failures.append(f"{field}: glob must be a relative repo path: {pattern}")
    return glob_list


def validate_metadata(
    field: str,
    artifact: dict,
    status: object,
    release: bool,
    failures: list[str],
) -> None:
    required_metadata = artifact.get("required_metadata", [])
    required_keys = as_list(required_metadata)
    if required_metadata and not required_keys:
        failures.append(f"{field}: required_metadata must be a list of strings")
        return

    metadata = artifact.get("metadata", {})
    if metadata and not isinstance(metadata, dict):
        failures.append(f"{field}: metadata must be a mapping")
        metadata = {}
    if isinstance(metadata, dict):
        for key, value in metadata.items():
            if not isinstance(key, str) or not key:
                failures.append(f"{field}: metadata keys must be non-empty strings")
            if value is None or value == "":
                failures.append(f"{field}.metadata.{key}: metadata value must be non-empty")

    metadata_globs = artifact.get("metadata_globs", [])
    metadata_glob_list = as_list(metadata_globs)
    if metadata_globs and not metadata_glob_list:
        failures.append(f"{field}: metadata_globs must be a list of strings")
    for pattern in metadata_glob_list:
        path = Path(pattern)
        if path.is_absolute() or ".." in path.parts:
            failures.append(f"{field}: metadata glob must be a relative repo path: {pattern}")

    if required_keys and (release or status == "complete"):
        metadata_keys = set(metadata) if isinstance(metadata, dict) else set()
        missing_keys = sorted(set(required_keys) - metadata_keys)
        metadata_files = matching_files(metadata_glob_list)
        if missing_keys and not metadata_files:
            mode = "release" if release else "status complete"
            failures.append(
                f"{field}: {mode} requires metadata fields or metadata_globs for: "
                + ", ".join(missing_keys)
            )

    if isinstance(metadata, dict):
        for key in sorted(k for k in required_keys if CHECKSUM_METADATA_RE.search(k)):
            value = metadata.get(key)
            if value is None or value == "":
                continue
            if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
                failures.append(
                    f"{field}.metadata.{key}: checksum must be a lowercase sha256 hex digest"
                )
        source_revision = metadata.get("source_revision")
        if (
            (release or status == "complete")
            and isinstance(source_revision, str)
            and DIRTY_SOURCE_RE.search(source_revision)
        ):
            failures.append(
                f"{field}.metadata.source_revision: release/status complete cannot "
                "reference a dirty working tree revision"
            )

    checksum_manifest = artifact.get("checksum_manifest")
    if checksum_manifest is not None:
        if not isinstance(checksum_manifest, str) or not checksum_manifest:
            failures.append(f"{field}: checksum_manifest must be a repo-relative path")
        else:
            path = Path(checksum_manifest)
            if path.is_absolute() or ".." in path.parts:
                failures.append(
                    f"{field}: checksum_manifest must be a relative repo path: {checksum_manifest}"
                )
            elif release and not repo_path(checksum_manifest).is_file():
                failures.append(
                    f"{field}: release checksum_manifest is missing: {checksum_manifest}"
                )


def matching_files(globs: list[str]) -> list[Path]:
    files: list[Path] = []
    for pattern in globs:
        files.extend(sorted(path for path in ROOT.glob(pattern) if path.is_file()))
    return files


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def check_report_markers(
    artifact_name: str, artifact: dict, files: list[Path], failures: list[str]
) -> None:
    fail_regex = artifact.get("fail_regex")
    clean_regex = artifact.get("clean_regex")
    fail_pattern = re.compile(fail_regex) if isinstance(fail_regex, str) and fail_regex else None
    clean_pattern = (
        re.compile(clean_regex) if isinstance(clean_regex, str) and clean_regex else None
    )
    for path in files:
        text = path.read_text(errors="ignore")
        rel = path.relative_to(ROOT)
        if fail_pattern and fail_pattern.search(text):
            failures.append(f"{artifact_name}: report matched failure regex: {rel}")
        if clean_pattern and not clean_pattern.search(text):
            failures.append(f"{artifact_name}: report missing clean marker: {rel}")


def validate_required_artifact_names(
    manifest_name: str,
    group_name: str,
    artifacts: list[object],
    failures: list[str],
) -> None:
    required_by_group = REQUIRED_GROUP_ARTIFACT_ALIASES.get(manifest_name, {})
    required_aliases = required_by_group.get(group_name)
    if not required_aliases:
        return

    names = {
        artifact.get("name")
        for artifact in artifacts
        if isinstance(artifact, dict) and isinstance(artifact.get("name"), str)
    }
    missing = [
        "/".join(sorted(aliases)) for aliases in required_aliases if names.isdisjoint(aliases)
    ]
    if missing:
        failures.append(
            f"{manifest_name}.{group_name}: missing required artifact names: " + ", ".join(missing)
        )


def validate_artifact(
    manifest_name: str,
    group_name: str,
    artifact: object,
    release: bool,
    failures: list[str],
) -> None:
    field = f"{manifest_name}.{group_name}"
    if not isinstance(artifact, dict):
        failures.append(f"{field}: artifact must be a mapping")
        return
    name = artifact.get("name")
    if not isinstance(name, str) or not name:
        failures.append(f"{field}: artifact missing name")
        name = "unnamed"
    status = artifact.get("status")
    if status not in ALLOWED_STATUS:
        failures.append(f"{field}.{name}: status must be missing, draft, or complete")
    globs = validate_globs(f"{field}.{name}", artifact.get("globs"), failures)

    metadata = artifact.get("required_metadata", [])
    if metadata and not as_list(metadata):
        failures.append(f"{field}.{name}: required_metadata must be a list of strings")
    validate_metadata(f"{field}.{name}", artifact, status, release, failures)

    files = matching_files(globs)
    if status == "complete" and not files:
        failures.append(f"{field}.{name}: status complete but artifact files are missing")
    if status == "missing" and files:
        failures.append(f"{field}.{name}: status missing but artifact files exist")
    if release:
        if status != "complete":
            failures.append(f"{field}.{name}: release requires status complete, got {status}")
        if not files:
            failures.append(f"{field}.{name}: release artifact files are missing")
        check_report_markers(name, artifact, files, failures)


def resolved_manifest(manifest_paths: list[str]) -> dict:
    manifests: list[dict] = []
    for manifest in manifest_paths:
        path = repo_path(manifest)
        if not path.is_file():
            manifests.append({"path": manifest, "exists": False, "artifact_groups": []})
            continue
        data = yaml.safe_load(path.read_text())
        if not isinstance(data, dict):
            manifests.append(
                {
                    "path": manifest,
                    "exists": True,
                    "parseable": False,
                    "artifact_groups": [],
                }
            )
            continue

        groups_out: list[dict] = []
        if data.get("schema") == "eliza.e1_phone_board_artifact_manifest.v1":
            groups = data.get("current_artifacts", {})
            if isinstance(groups, dict):
                for group_name in sorted(str(name) for name in groups):
                    paths = as_list(groups[group_name])
                    artifacts_out: list[dict[str, object]] = []
                    for rel_path in paths:
                        path_obj = repo_path(rel_path)
                        files = []
                        if path_obj.is_file():
                            files.append(
                                {
                                    "path": rel_path,
                                    "sha256": file_sha256(path_obj),
                                    "size_bytes": path_obj.stat().st_size,
                                }
                            )
                        artifacts_out.append(
                            {
                                "name": rel_path,
                                "status": "draft" if files else "missing",
                                "globs": [rel_path],
                                "files": files,
                            }
                        )
                    groups_out.append(
                        {
                            "name": group_name,
                            "status": "draft",
                            "artifacts": artifacts_out,
                        }
                    )
        groups = data.get("artifact_groups", {})
        if not groups_out and isinstance(groups, dict):
            for group_name in sorted(str(name) for name in groups):
                group = groups[group_name]
                if not isinstance(group, dict):
                    continue
                artifacts_out = []
                artifacts = group.get("artifacts", [])
                if isinstance(artifacts, list):
                    for artifact in artifacts:
                        if not isinstance(artifact, dict):
                            continue
                        globs = as_list(artifact.get("globs"))
                        files = [
                            {
                                "path": relative(file_path),
                                "sha256": file_sha256(file_path),
                                "size_bytes": file_path.stat().st_size,
                            }
                            for file_path in matching_files(globs)
                        ]
                        artifacts_out.append(
                            {
                                "name": artifact.get("name"),
                                "status": artifact.get("status"),
                                "globs": sorted(globs),
                                "files": files,
                            }
                        )
                groups_out.append(
                    {
                        "name": group_name,
                        "status": group.get("status"),
                        "artifacts": sorted(
                            artifacts_out, key=lambda item: str(item.get("name") or "")
                        ),
                    }
                )
        manifests.append(
            {
                "path": manifest,
                "exists": True,
                "parseable": True,
                "manifest": data.get("manifest"),
                "status": data.get("status"),
                "artifact_groups": groups_out,
            }
        )

    return {
        "schema": "eliza.manufacturing.resolved_artifact_manifest.v1",
        "claim": "deterministic local file inventory only; not release readiness",
        "manifests": manifests,
    }


def validate_e1_phone_manifest(path: Path, release: bool) -> list[str]:
    failures: list[str] = []
    rel_manifest = path.relative_to(ROOT).as_posix()
    try:
        manifest = yaml.safe_load(path.read_text())
    except yaml.YAMLError as exc:
        return [f"{rel_manifest}: invalid YAML: {exc}"]
    if not isinstance(manifest, dict):
        return [f"{rel_manifest}: manifest must be a mapping"]
    if manifest.get("schema") != "eliza.e1_phone_board_artifact_manifest.v1":
        failures.append(f"{rel_manifest}: unexpected phone manifest schema")
    status = manifest.get("status")
    if status != "blocked_not_fabrication_ready":
        failures.append(f"{rel_manifest}: phone manifest must remain blocked, got {status}")
    if release:
        failures.append(
            f"{rel_manifest}: release requires routed/fabrication/enclosure evidence, got {status}"
        )

    target = manifest.get("design_target", {})
    expected_target = {
        "usb_c_ports": 1,
        "side_buttons": ["power", "volume_up", "volume_down"],
        "board_bbox_mm": {"width": 64.0, "height": 132.0},
        "battery_window_mm": {"width": 64.0, "height": 87.0},
    }
    if not isinstance(target, dict):
        failures.append(f"{rel_manifest}: missing design_target")
        target = {}
    for key, expected in expected_target.items():
        if target.get(key) != expected:
            failures.append(
                f"{rel_manifest}: design_target.{key} expected {expected}, got {target.get(key)}"
            )
    radios = target.get("radios", [])
    for radio in ["5g_redcap_cellular", "wifi_6e", "bluetooth_5_3"]:
        if radio not in radios:
            failures.append(f"{rel_manifest}: design target missing radio {radio}")

    groups = manifest.get("current_artifacts")
    if not isinstance(groups, dict):
        failures.append(f"{rel_manifest}: missing current_artifacts")
        groups = {}
    required_groups = {
        "planning",
        "package_bindings",
        "schematic_scaffold",
        "kicad_concept",
        "preview_artifacts",
    }
    missing_groups = sorted(required_groups - set(groups))
    if missing_groups:
        failures.append(
            f"{rel_manifest}: missing current_artifacts groups: {', '.join(missing_groups)}"
        )
    required_paths = {
        "board/kicad/e1-phone/routed-release-plan.yaml",
        "board/kicad/e1-phone/manufacturing-closure.yaml",
        "board/kicad/e1-phone/production-readiness.yaml",
        "board/kicad/e1-phone/procurement-readiness.yaml",
        "board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb",
        "board/kicad/e1-phone/preview/kicad-cli-mainboard.svg",
        "board/kicad/e1-phone/preview/kicad-cli-mainboard.png",
    }
    all_paths = {item for paths in groups.values() for item in as_list(paths)}
    for required in sorted(required_paths):
        if required not in all_paths:
            failures.append(f"{rel_manifest}: current_artifacts missing {required}")
    for rel_path in sorted(all_paths):
        path_obj = repo_path(rel_path)
        if not path_obj.is_file():
            failures.append(f"{rel_manifest}: current artifact file is missing: {rel_path}")
            continue
        if path_obj.suffix in {".yaml", ".yml"}:
            try:
                yaml.safe_load(path_obj.read_text())
            except yaml.YAMLError as exc:
                failures.append(f"{rel_manifest}: current artifact YAML invalid {rel_path}: {exc}")

    gates = manifest.get("release_gates", {})
    if not isinstance(gates, dict):
        failures.append(f"{rel_manifest}: release_gates must be a mapping")
        gates = {}
    required_gates = {
        "schematic",
        "routed_pcb",
        "enclosure",
        "power_thermal",
        "rf_si",
        "manufacturing",
    }
    missing_gates = sorted(required_gates - set(gates))
    if missing_gates:
        failures.append(f"{rel_manifest}: missing release gates: {', '.join(missing_gates)}")
    for gate_name, gate in gates.items():
        if not isinstance(gate, dict):
            failures.append(f"{rel_manifest}.release_gates.{gate_name}: gate must be a mapping")
            continue
        gate_status = gate.get("status")
        if gate_status not in ALLOWED_FAIL_CLOSED_PHONE_RELEASE_GATE_STATUSES:
            failures.append(
                f"{rel_manifest}.release_gates.{gate_name}: expected fail-closed, got {gate_status}"
            )
        evidence = gate.get("required_evidence", [])
        if not as_list(evidence):
            failures.append(f"{rel_manifest}.release_gates.{gate_name}: missing required_evidence")
        if release:
            failures.append(
                f"{rel_manifest}.release_gates.{gate_name}: release gate remains {gate_status}"
            )

    routed_plan_path = repo_path("board/kicad/e1-phone/routed-release-plan.yaml")
    if routed_plan_path.is_file():
        routed_plan = yaml.safe_load(routed_plan_path.read_text())
        if (
            routed_plan.get("status")
            != "blocked_routed_release_requires_real_route_and_supplier_outputs"
        ):
            failures.append(f"{rel_manifest}: routed release plan status is not fail-closed")
        outputs = routed_plan.get("required_release_output_manifest", {})
        if not isinstance(outputs, dict) or len(outputs) < 20:
            failures.append(
                f"{rel_manifest}: routed release plan must track at least 20 release outputs"
            )
        else:
            for output_name, output in outputs.items():
                if not isinstance(output, dict):
                    failures.append(
                        f"{rel_manifest}: routed output {output_name} must be a mapping"
                    )
                    continue
                if output.get("present") is not False or output.get("release_required") is not True:
                    failures.append(
                        f"{rel_manifest}: routed output {output_name} must be blocked and required"
                    )
                if release:
                    failures.append(
                        f"{rel_manifest}: release output remains missing: {output_name}"
                    )
    else:
        failures.append(f"{rel_manifest}: routed release plan is missing")

    forbidden = manifest.get("forbidden_claims_while_status_blocked", [])
    for claim in [
        "board_fabrication_ready",
        "enclosure_ready",
        "production_bom_ready",
        "rf_ready",
        "power_thermal_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in forbidden:
            failures.append(f"{rel_manifest}: missing forbidden claim {claim}")
    return failures


def validate_manifest(path: Path, release: bool) -> list[str]:
    failures: list[str] = []
    try:
        manifest = yaml.safe_load(path.read_text())
    except yaml.YAMLError as exc:
        return [f"{path.relative_to(ROOT)}: invalid YAML: {exc}"]
    if not isinstance(manifest, dict):
        return [f"{path.relative_to(ROOT)}: manifest must be a mapping"]
    if manifest.get("schema") == "eliza.e1_phone_board_artifact_manifest.v1":
        return validate_e1_phone_manifest(path, release)

    manifest_name = str(manifest.get("manifest") or path.relative_to(ROOT))
    release_gate = manifest.get("release_gate")
    if release_gate is not None and release_gate not in ALLOWED_RELEASE_GATES:
        failures.append(
            f"{manifest_name}: release_gate must be one of "
            + ", ".join(sorted(ALLOWED_RELEASE_GATES))
        )
    status = manifest.get("status")
    if not isinstance(status, str) or not status:
        failures.append(f"{manifest_name}: missing status")
    elif status not in ALLOWED_MANIFEST_STATUS:
        failures.append(
            f"{manifest_name}: status must be one of " + ", ".join(sorted(ALLOWED_MANIFEST_STATUS))
        )
    if release and status != "complete":
        failures.append(f"{manifest_name}: release requires manifest status complete, got {status}")
    validate_schema_ref(manifest_name, manifest.get("schema"), failures)

    referenced = as_list(manifest.get("artifact_manifests", []))
    for ref in referenced:
        ref_path = Path(ref)
        if ref_path.is_absolute() or ".." in ref_path.parts:
            failures.append(f"{manifest_name}: artifact manifest path must be relative: {ref}")
        elif not repo_path(ref).is_file():
            failures.append(f"{manifest_name}: referenced artifact manifest is missing: {ref}")

    gates = manifest.get("release_gates", {})
    if gates:
        if not isinstance(gates, dict):
            failures.append(f"{manifest_name}: release_gates must be a mapping")
        else:
            for gate_name, gate in gates.items():
                if not isinstance(gate, dict):
                    failures.append(
                        f"{manifest_name}.release_gates.{gate_name}: gate must be a mapping"
                    )
                    continue
                if not isinstance(gate.get("blocked"), bool):
                    failures.append(
                        f"{manifest_name}.release_gates.{gate_name}: blocked must be true or false"
                    )
                if release and gate.get("blocked") is True:
                    failures.append(
                        f"{manifest_name}.release_gates.{gate_name}: release gate remains blocked"
                    )
                if not isinstance(gate.get("reason"), str) or not gate["reason"]:
                    failures.append(f"{manifest_name}.release_gates.{gate_name}: missing reason")

    groups = manifest.get("artifact_groups")
    if not isinstance(groups, dict) or not groups:
        failures.append(f"{manifest_name}: missing artifact_groups")
        return failures
    required_groups = set(REQUIRED_GROUP_ARTIFACT_ALIASES.get(manifest_name, {}))
    missing_groups = sorted(required_groups - set(groups))
    if missing_groups:
        failures.append(
            f"{manifest_name}: missing required artifact_groups: " + ", ".join(missing_groups)
        )

    for group_name, group in groups.items():
        if not isinstance(group, dict):
            failures.append(f"{manifest_name}.{group_name}: group must be a mapping")
            continue
        group_status = group.get("status")
        if group_status not in ALLOWED_STATUS:
            failures.append(
                f"{manifest_name}.{group_name}: status must be missing, draft, or complete"
            )
        if release and group_status != "complete":
            failures.append(
                f"{manifest_name}.{group_name}: release requires group status complete, got {group_status}"
            )

        commands = group.get("cli_commands", {})
        if commands:
            if not isinstance(commands, dict):
                failures.append(f"{manifest_name}.{group_name}: cli_commands must be a mapping")
            elif "kicad" in group_name:
                missing_commands = sorted(REQUIRED_KICAD_COMMANDS - set(commands))
                if missing_commands:
                    failures.append(
                        f"{manifest_name}.{group_name}: missing KiCad CLI commands: "
                        + ", ".join(missing_commands)
                    )
            elif "bitstream" in group_name or "fpga" in group_name:
                missing_commands = sorted(REQUIRED_FPGA_COMMANDS - set(commands))
                if missing_commands:
                    failures.append(
                        f"{manifest_name}.{group_name}: missing FPGA CLI commands: "
                        + ", ".join(missing_commands)
                    )
            if isinstance(commands, dict):
                for command_name, command in commands.items():
                    if not isinstance(command, str) or not command:
                        failures.append(
                            f"{manifest_name}.{group_name}.{command_name}: CLI command must be a string"
                        )

        artifacts = group.get("artifacts")
        if not isinstance(artifacts, list) or not artifacts:
            failures.append(f"{manifest_name}.{group_name}: missing artifacts")
            continue
        validate_required_artifact_names(manifest_name, str(group_name), artifacts, failures)
        for artifact in artifacts:
            validate_artifact(manifest_name, str(group_name), artifact, release, failures)

    return failures


def main() -> int:
    parser = ArgumentParser(
        description="Validate package, board, SI/PI, current, thermal, and KiCad evidence manifests."
    )
    parser.add_argument(
        "--manifest",
        action="append",
        dest="manifests",
        help="manifest path to check; may be repeated",
    )
    parser.add_argument("--release", action="store_true", help="require complete release evidence")
    parser.add_argument(
        "--resolved-manifest",
        metavar="PATH",
        help="write a deterministic JSON inventory of matched artifact files and sha256 hashes",
    )
    args = parser.parse_args()

    failures: list[str] = []
    manifests = args.manifests or DEFAULT_MANIFESTS
    for manifest in manifests:
        path = repo_path(manifest)
        if not path.is_file():
            failures.append(f"missing manifest: {manifest}")
            continue
        failures.extend(validate_manifest(path, args.release))

    resolved_manifest_path: Path | None = None
    if args.resolved_manifest:
        resolved_manifest_path = repo_path(args.resolved_manifest)
    elif args.release:
        resolved_manifest_path = DEFAULT_RESOLVED_MANIFEST

    if resolved_manifest_path is not None:
        out_path = resolved_manifest_path
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            json.dumps(
                {
                    **resolved_manifest(manifests),
                    "generated_utc": datetime.now(UTC).isoformat(),
                    "claim_boundary": CLAIM_BOUNDARY,
                },
                indent=2,
                sort_keys=True,
            )
            + "\n"
        )

    mode = "release" if args.release else "preflight"
    if failures:
        status = "blocked" if args.release else "fail"
        write_report(status, mode, manifests, failures, resolved_manifest_path)
        if status == "blocked":
            print(f"STATUS: BLOCKED manufacturing artifact {mode} check")
        print(f"manufacturing artifact {mode} check failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 2 if status == "blocked" else 1

    write_report("pass", mode, manifests, [], resolved_manifest_path)
    print(f"manufacturing artifact {mode} check ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
