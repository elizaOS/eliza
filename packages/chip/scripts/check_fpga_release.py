#!/usr/bin/env python3
import json
import re
import shutil
import sys
from argparse import ArgumentParser
from pathlib import Path
from typing import cast

import yaml

ROOT = Path(__file__).resolve().parents[1]
CFG = ROOT / "board/fpga/e1_demo_fpga.yaml"
MANIFEST = ROOT / "board/fpga/artifact-manifest.yaml"
REPORT = ROOT / "build/reports/fpga_release.json"
SCHEMA = "eliza.fpga_release.v1"
CLAIM_BOUNDARY = "fpga_release_validation_only_not_board_fabrication_evidence"
DIAGNOSTIC_REPORT_DIR = ROOT / "board/fpga/reports/diagnostics"
FPGA_BUILD_ARCHIVE_DIR = ROOT / "build/fpga/e1_demo/archive"
BOUNDED_SYNTH_DIAGNOSTIC_LOGS = [
    {
        "id": "preabc_profile",
        "label": "full-chip pre-map synthesis profile diagnostic",
        "log": ROOT / "build/fpga/e1_demo_profile/yosys_profile.log",
        "exact_command": (
            "python3 scripts/run_with_timeout.py --timeout-seconds 120 "
            "--label fpga-e1-chip-top-preabc-profile -- bash -lc "
            "'PATH=/home/shaw/milady/eliza/packages/chip/external/oss-cad-suite/bin:$PATH "
            "TOP=e1_chip_top "
            "BUILD_DIR=build/fpga/e1_demo_profile "
            "PROFILE_LOG=build/fpga/e1_demo_profile/yosys_profile.log "
            "make -C board/fpga synth-profile'"
        ),
        "diagnostic_goal": (
            "Stop before synth_ecp5 ABC/ABC9 mapping and report pre-map module/cell "
            "pressure for the same release top."
        ),
    },
    {
        "id": "noabc9",
        "label": "full-chip synth_ecp5 -noabc9 diagnostic",
        "log": ROOT / "build/fpga/e1_demo_noabc9/yosys_noabc9.log",
        "exact_command": (
            "python3 scripts/run_with_timeout.py --timeout-seconds 300 "
            "--label fpga-e1-chip-top-noabc9-diagnostic -- bash -lc "
            "'PATH=/home/shaw/milady/eliza/packages/chip/external/oss-cad-suite/bin:$PATH "
            "SYNTH_ECP5_FLAGS=-noabc9 TOP=e1_chip_top "
            "BUILD_DIR=build/fpga/e1_demo_noabc9 "
            "SYNTH_LOG=build/fpga/e1_demo_noabc9/yosys_noabc9.log "
            "make -C board/fpga synth'"
        ),
    },
]
LOCAL_TOOL_DIRS = [
    ROOT / "external/oss-cad-suite/bin",
]

REQUIRED_RELEASE_EVIDENCE = {
    "bitstream": [
        "build/fpga/e1_demo/**/*.bit",
        "build/fpga/e1_demo/**/*.svf",
        "board/fpga/build/**/*.bit",
        "board/fpga/build/**/*.svf",
    ],
    "nextpnr timing report": [
        "build/fpga/e1_demo/**/*timing*.rpt",
        "build/fpga/e1_demo/**/*timing*.txt",
        "board/fpga/reports/**/*timing*.rpt",
        "board/fpga/reports/**/*timing*.txt",
    ],
    "nextpnr route report": [
        "build/fpga/e1_demo/**/*nextpnr*.log",
        "build/fpga/e1_demo/**/*route*.rpt",
        "board/fpga/reports/**/*nextpnr*.log",
        "board/fpga/reports/**/*route*.rpt",
    ],
    "ecppack transcript": [
        "build/fpga/e1_demo/**/*ecppack*.log",
        "build/fpga/e1_demo/**/*pack*.log",
        "board/fpga/reports/**/*ecppack*.log",
        "board/fpga/reports/**/*pack*.log",
    ],
    "programming transcript": [
        "build/fpga/e1_demo/**/*program*.log",
        "build/fpga/e1_demo/**/*openFPGALoader*.log",
        "board/fpga/reports/**/*program*.log",
        "board/fpga/reports/**/*openFPGALoader*.log",
    ],
    "FPGA tool versions": [
        "board/fpga/reports/**/*tool*version*.txt",
        "board/fpga/reports/tool_versions.txt",
    ],
}
REQUIRED_CLI_COMMANDS = {"synth", "place_route", "pack"}
RELEASE_COMMANDS = {
    "tool_versions": "yosys -V && nextpnr-ecp5 --version && ecppack --version && openFPGALoader --version",
    "synth": "TOP=e1_chip_top make -C board/fpga synth",
    "place_route": "TOP=e1_chip_top make -C board/fpga pnr",
    "pack": "TOP=e1_chip_top make -C board/fpga pack",
    "report": "TOP=e1_chip_top make -C board/fpga report",
    "hash_bitstream": "shasum -a 256 build/fpga/e1_demo/e1_chip_top.bit",
    "program_sram": "openFPGALoader -b ulx3s build/fpga/e1_demo/e1_chip_top.bit",
}
ARTIFACT_UNBLOCK_COMMANDS = {
    "bitstream": "TOP=e1_chip_top make -C board/fpga pack",
    "nextpnr timing report": "TOP=e1_chip_top make -C board/fpga pnr",
    "nextpnr route report": "TOP=e1_chip_top make -C board/fpga pnr",
    "ecppack transcript": "TOP=e1_chip_top make -C board/fpga pack",
    "programming transcript": RELEASE_COMMANDS["program_sram"],
    "FPGA tool versions": RELEASE_COMMANDS["tool_versions"],
}
TOOL_COMMANDS = {
    "yosys": ["yosys", "-V"],
    "nextpnr-ecp5": ["nextpnr-ecp5", "--version"],
    "ecppack": ["ecppack", "--version"],
    "openFPGALoader": ["openFPGALoader", "--version"],
}
RELEASE_REQUIRED_TOOLS = {"yosys", "nextpnr-ecp5", "ecppack"}


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def resolve_tool(tool: str) -> tuple[str | None, str]:
    for directory in LOCAL_TOOL_DIRS:
        candidate = directory / tool
        if candidate.is_file():
            return str(candidate), "repo_local_oss_cad_suite"
    path = shutil.which(tool)
    if path:
        return path, "path"
    return None, "missing"


def release_evidence_fields(cfg: dict) -> dict[str, str]:
    evidence = cfg.get("release_evidence", {})
    return evidence if isinstance(evidence, dict) else {}


def is_unassigned(value: object) -> bool:
    return value in {None, "", "unassigned"}


def diagnostic_artifact_reason(path: Path, cfg: dict) -> str | None:
    text_path = rel(path)
    if "/reports/e1_demo_smoke/" in f"/{text_path}":
        return "smoke_top_artifact_not_full_e1_chip_top_release"
    if "/reports/full_chip_blocker/" in f"/{text_path}":
        return "blocker_narrative_not_release_output"
    if "/reports/diagnostics/" in f"/{text_path}":
        return "diagnostic_inventory_not_release_output"

    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        text = ""
    lowered = text.lower()
    diagnostic_markers = (
        "release_credit: false",
        "not release evidence",
        "diagnostic only",
        "e1_fpga_smoke_top",
        "full-chip fpga closure blocker",
    )
    if any(marker in lowered for marker in diagnostic_markers):
        return "content_marks_diagnostic_only"

    evidence = release_evidence_fields(cfg)
    assigned_paths = {
        str(value)
        for key, value in evidence.items()
        if key.endswith(("_path", "_report", "_versions")) and not is_unassigned(value)
    }
    if assigned_paths and text_path not in assigned_paths:
        return "not_named_by_release_evidence_contract"
    if not assigned_paths:
        return "release_evidence_paths_unassigned"
    return None


def artifact_status(label: str, patterns: list[str], cfg: dict) -> dict:
    matches = sorted(
        {path.resolve() for pattern in patterns for path in ROOT.glob(pattern) if path.is_file()}
    )
    match_rows = []
    release_credit_matches = []
    for path in matches:
        reason = diagnostic_artifact_reason(path, cfg)
        release_credit = reason is None
        if release_credit:
            release_credit_matches.append(path)
        match_rows.append(
            {
                "path": rel(path),
                "size_bytes": path.stat().st_size,
                "release_credit": release_credit,
                "diagnostic_only": not release_credit,
                "diagnostic_reason": reason,
            }
        )
    return {
        "label": label,
        "patterns": patterns,
        "unblock_command": ARTIFACT_UNBLOCK_COMMANDS[label],
        "matches": match_rows,
        "release_credit": bool(release_credit_matches),
        "release_credit_paths": [rel(path) for path in release_credit_matches],
        "diagnostic_only_count": sum(1 for row in match_rows if row["diagnostic_only"]),
        "missing": not release_credit_matches,
    }


def artifact_inventory(cfg: dict) -> dict[str, dict]:
    return {
        label: artifact_status(label, patterns, cfg)
        for label, patterns in REQUIRED_RELEASE_EVIDENCE.items()
    }


def tool_availability() -> dict[str, dict]:
    inventory = {}
    for tool, command in TOOL_COMMANDS.items():
        path, source = resolve_tool(tool)
        inventory[tool] = {
            "command": " ".join(command),
            "available": path is not None,
            "path": path,
            "source": source,
            "required_for_release": tool in RELEASE_REQUIRED_TOOLS,
            "install_hint": (
                "Install OSS CAD Suite under external/oss-cad-suite or provide this executable on PATH."
            ),
            "release_credit": False,
            "claim_boundary": "tool availability only; released bitstream evidence still required",
        }
    return inventory


def manifest_release_commands(manifest: dict | None) -> dict[str, dict]:
    observed: dict[str, str] = {}
    if isinstance(manifest, dict):
        groups = manifest.get("artifact_groups", {})
        bitstream = groups.get("bitstream_release") if isinstance(groups, dict) else None
        commands = bitstream.get("cli_commands") if isinstance(bitstream, dict) else None
        if isinstance(commands, dict):
            observed = {str(key): str(value) for key, value in sorted(commands.items())}
    rows = {}
    for name, command in RELEASE_COMMANDS.items():
        manifest_command = observed.get(name)
        rows[name] = {
            "command": command,
            "manifest_command": manifest_command,
            "release_top": "e1_chip_top",
            "manifest_matches_release_top": manifest_command == command
            if manifest_command
            else False,
            "release_credit": False,
            "claim_boundary": "command plan only; release credit requires successful execution and archived artifacts",
        }
    return rows


def manifest_artifact_glob_audit(manifest: dict | None) -> dict:
    expected_release_markers = {
        "bitstream": ("build/fpga/e1_demo/",),
        "nextpnr_timing_report": (
            "build/fpga/e1_demo/",
            "board/fpga/reports/e1_demo/",
        ),
        "nextpnr_route_report": (
            "build/fpga/e1_demo/",
            "board/fpga/reports/e1_demo/",
        ),
        "ecppack_transcript": (
            "build/fpga/e1_demo/",
            "board/fpga/reports/e1_demo/",
        ),
        "fpga_tool_versions": ("board/fpga/reports/tool_versions.txt",),
    }
    diagnostic_markers = (
        "e1_demo_smoke",
        "full_chip_blocker",
        "reports/diagnostics",
    )
    artifacts = []
    groups = manifest.get("artifact_groups", {}) if isinstance(manifest, dict) else {}
    bitstream = groups.get("bitstream_release") if isinstance(groups, dict) else {}
    raw_artifacts = bitstream.get("artifacts") if isinstance(bitstream, dict) else []
    if not isinstance(raw_artifacts, list):
        raw_artifacts = []

    for raw in raw_artifacts:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name", "unknown"))
        globs = [str(item) for item in raw.get("globs", []) if item]
        expected_markers = expected_release_markers.get(name, ())
        release_globs = [
            glob
            for glob in globs
            if any(marker in glob for marker in expected_markers)
            and not any(marker in glob for marker in diagnostic_markers)
        ]
        diagnostic_only_globs = [
            glob for glob in globs if any(marker in glob for marker in diagnostic_markers)
        ]
        missing_release_glob = bool(expected_markers) and not release_globs
        artifacts.append(
            {
                "name": name,
                "status": raw.get("status"),
                "globs": globs,
                "release_globs": release_globs,
                "diagnostic_only_globs": diagnostic_only_globs,
                "missing_release_glob": missing_release_glob,
                "release_credit": False,
                "next_step": (
                    "Replace diagnostic/smoke report globs with release-run e1_chip_top "
                    "artifact paths before promoting board/fpga/artifact-manifest.yaml."
                    if diagnostic_only_globs or missing_release_glob
                    else "Keep this glob tied to the e1_chip_top release-output path."
                ),
            }
        )

    blocked_artifacts = [
        row["name"]
        for row in artifacts
        if row["diagnostic_only_globs"] or row["missing_release_glob"]
    ]
    return {
        "release_credit": False,
        "status": "blocked" if blocked_artifacts else "ready_for_release_artifact_paths",
        "claim_boundary": (
            "manifest glob audit only; release credit still requires generated bitstream, "
            "timing, route, pack, tool-version evidence, and reviewed manifest promotion"
        ),
        "blocked_artifacts": blocked_artifacts,
        "artifacts": artifacts,
        "next_action_id": "fpga-manifest-globs-001",
        "next_step": (
            "For every blocked artifact, point globs at build/fpga/e1_demo or a reviewed "
            "board/fpga/reports/e1_demo release-output path and keep smoke/blocker paths "
            "diagnostic-only outside artifact_groups.bitstream_release."
        ),
    }


def release_artifact_requirements(inventory: dict[str, dict]) -> dict[str, dict]:
    rows = {}
    for label, status in inventory.items():
        rows[label] = {
            "source_manifest": MANIFEST.relative_to(ROOT).as_posix(),
            "patterns": status["patterns"],
            "unblock_command": status["unblock_command"],
            "expected_command_output": {
                "command": status["unblock_command"],
                "accepted_exit_code": 0,
                "accepted_output": (
                    "Creates final e1_chip_top release artifact(s) for this class; "
                    "timing/route/pack logs must be reviewable and not diagnostic-only."
                ),
            },
            "accepted_artifact_paths": status["release_credit_paths"],
            "release_credit_paths": status["release_credit_paths"],
            "diagnostic_only_matches": [
                match for match in status["matches"] if match["diagnostic_only"]
            ],
            "missing": status["missing"],
            "required_for_release": True,
        }
    return rows


def release_evidence_archive_contract(
    cfg: dict,
    inventory: dict[str, dict],
) -> dict:
    evidence = release_evidence_fields(cfg)
    constraints = cfg.get("constraints", {}) if isinstance(cfg.get("constraints"), dict) else {}
    board = cfg.get("board", {}) if isinstance(cfg.get("board"), dict) else {}
    expected_fields = [
        {
            "field": "release_evidence.bitstream_path",
            "artifact": "bitstream",
            "expected_path_pattern": "build/fpga/e1_demo/e1_chip_top.bit",
            "producer_command": RELEASE_COMMANDS["pack"],
            "validation_command": "test -s build/fpga/e1_demo/e1_chip_top.bit",
            "required_value_type": "repo_relative_path",
        },
        {
            "field": "release_evidence.bitstream_sha256",
            "artifact": "bitstream",
            "expected_path_pattern": "build/fpga/e1_demo/e1_chip_top.bit",
            "producer_command": RELEASE_COMMANDS["hash_bitstream"],
            "validation_command": (
                "test \"$(shasum -a 256 build/fpga/e1_demo/e1_chip_top.bit | awk '{print $1}')\" "
                '= "${release_evidence.bitstream_sha256}"'
            ),
            "required_value_type": "sha256_hex",
        },
        {
            "field": "release_evidence.timing_report",
            "artifact": "nextpnr timing report",
            "expected_path_pattern": "build/fpga/e1_demo/**/*timing*.rpt",
            "producer_command": RELEASE_COMMANDS["place_route"],
            "validation_command": "python3 scripts/check_fpga_release.py --release",
            "required_value_type": "repo_relative_path",
        },
        {
            "field": "release_evidence.timing_summary",
            "artifact": "nextpnr timing report",
            "expected_path_pattern": "timing summary extracted from the release nextpnr report",
            "producer_command": RELEASE_COMMANDS["report"],
            "validation_command": "python3 scripts/check_fpga_release.py --release",
            "required_value_type": "reviewed_text_summary",
        },
        {
            "field": "release_evidence.archived_tool_versions",
            "artifact": "FPGA tool versions",
            "expected_path_pattern": "board/fpga/reports/tool_versions.txt",
            "producer_command": RELEASE_COMMANDS["tool_versions"],
            "validation_command": "test -s board/fpga/reports/tool_versions.txt",
            "required_value_type": "repo_relative_path",
        },
        {
            "field": "release_evidence.programming_transcript",
            "artifact": "programming transcript",
            "expected_path_pattern": "board/fpga/reports/e1_demo/program_sram.log",
            "producer_command": RELEASE_COMMANDS["program_sram"],
            "validation_command": (
                "test -s board/fpga/reports/e1_demo/program_sram.log && "
                "grep -E 'openFPGALoader|JTAG|SRAM|DONE|Verify' "
                "board/fpga/reports/e1_demo/program_sram.log"
            ),
            "required_value_type": "repo_relative_path",
        },
    ]
    rows = []
    for item in expected_fields:
        field_name = item["field"].split(".", 1)[1]
        value = evidence.get(field_name)
        artifact_status = inventory.get(item["artifact"], {})
        rows.append(
            {
                **item,
                "status": "missing" if is_unassigned(value) else "present",
                "current_value": value,
                "artifact_release_credit_paths": artifact_status.get("release_credit_paths", []),
                "artifact_missing": artifact_status.get("missing", True),
                "release_credit": False,
            }
        )

    preconditions = [
        {
            "id": "exact_board_revision_recorded",
            "status": "missing" if is_unassigned(board.get("exact_revision")) else "present",
            "current_value": board.get("exact_revision"),
        },
        {
            "id": "final_lpf_recorded",
            "status": "missing" if is_unassigned(constraints.get("final_lpf")) else "present",
            "current_value": constraints.get("final_lpf"),
        },
        {
            "id": "pin_assignment_source_recorded",
            "status": (
                "missing" if is_unassigned(constraints.get("pin_assignment_source")) else "present"
            ),
            "current_value": constraints.get("pin_assignment_source"),
        },
        {
            "id": "pin_block_flag_cleared",
            "status": (
                "blocking"
                if constraints.get("bitstream_release_blocked_until_pins_assigned") is True
                else "cleared"
            ),
            "current_value": constraints.get("bitstream_release_blocked_until_pins_assigned"),
        },
    ]
    blocked_fields = [
        row["field"] for row in rows if row["status"] == "missing" or row["artifact_missing"]
    ]
    blocked_preconditions = [
        item["id"] for item in preconditions if item["status"] in {"missing", "blocking"}
    ]
    return {
        "release_credit": False,
        "status": "blocked" if blocked_fields or blocked_preconditions else "ready_for_review",
        "claim_boundary": (
            "release-evidence archive checklist only; release credit requires the real "
            "e1_chip_top flow outputs, matching hashes, reviewed timing, final LPF, and board revision"
        ),
        "next_action_id": "fpga-release-evidence-archive-001",
        "preconditions": preconditions,
        "required_fields": rows,
        "blocked_fields": blocked_fields,
        "blocked_preconditions": blocked_preconditions,
        "bounded_validation_commands": [
            "python3 scripts/check_fpga_release.py --release",
            "python3 scripts/generate_e1_demo_fpga_blocked_cli_evidence.py",
        ],
        "next_step": (
            "After board/pin preconditions are satisfied, run the e1_chip_top synth, "
            "place/route, pack, hash, and tool-version commands; archive exactly these "
            "paths into release_evidence before promoting the manifest."
        ),
    }


def pin_board_revision_handoff_contract(cfg: dict, pin_diagnostics: dict) -> dict:
    board = cfg.get("board", {}) if isinstance(cfg.get("board"), dict) else {}
    constraints = cfg.get("constraints", {}) if isinstance(cfg.get("constraints"), dict) else {}
    release_evidence = release_evidence_fields(cfg)
    current_values = {
        "board.exact_revision": board.get("exact_revision"),
        "board.exact_revision_evidence": board.get("exact_revision_evidence"),
        "constraints.final_lpf": constraints.get("final_lpf"),
        "constraints.pin_assignment_source": constraints.get("pin_assignment_source"),
        "constraints.bitstream_release_blocked_until_pins_assigned": constraints.get(
            "bitstream_release_blocked_until_pins_assigned"
        ),
        "release_evidence.timing_report": release_evidence.get("timing_report"),
        "release_evidence.bitstream_path": release_evidence.get("bitstream_path"),
        "release_evidence.bitstream_sha256": release_evidence.get("bitstream_sha256"),
        "release_evidence.archived_tool_versions": release_evidence.get("archived_tool_versions"),
        "release_evidence.programming_transcript": release_evidence.get("programming_transcript"),
    }
    required_fields = [
        {
            "field": "board.exact_revision",
            "status": "missing"
            if is_unassigned(current_values["board.exact_revision"])
            else "present",
            "current_value": current_values["board.exact_revision"],
            "required_evidence": "Exact ULX3S board revision or approved E1 FPGA carrier revision used for the final pin map.",
        },
        {
            "field": "board.exact_revision_evidence",
            "status": "missing"
            if is_unassigned(current_values["board.exact_revision_evidence"])
            else "present",
            "current_value": current_values["board.exact_revision_evidence"],
            "required_evidence": "Board photo, purchase/order record, schematic revision, or vendor document proving the exact revision.",
        },
        {
            "field": "constraints.pin_assignment_source",
            "status": "missing"
            if is_unassigned(current_values["constraints.pin_assignment_source"])
            else "present",
            "current_value": current_values["constraints.pin_assignment_source"],
            "required_evidence": "Reviewed source document for every LOCATE/IOBUF assignment in the final LPF.",
        },
        {
            "field": "constraints.final_lpf",
            "status": "missing"
            if is_unassigned(current_values["constraints.final_lpf"])
            else "present",
            "current_value": current_values["constraints.final_lpf"],
            "required_evidence": "Final LPF path reviewed against the exact board revision and pin source.",
        },
        {
            "field": "constraints.bitstream_release_blocked_until_pins_assigned",
            "status": (
                "blocking"
                if current_values["constraints.bitstream_release_blocked_until_pins_assigned"]
                is True
                else "cleared"
            ),
            "current_value": current_values[
                "constraints.bitstream_release_blocked_until_pins_assigned"
            ],
            "required_evidence": "Set false only after exact revision, pin source, final LPF, and review evidence are recorded.",
        },
    ]
    release_fields = [
        {
            "field": field,
            "status": "missing" if is_unassigned(value) else "present",
            "current_value": value,
            "required_after_pin_handoff": True,
        }
        for field, value in current_values.items()
        if field.startswith("release_evidence.")
    ]
    return {
        "release_credit": False,
        "claim_boundary": (
            "pin and board-revision handoff checklist only; not a final LPF, board "
            "approval, bitstream, route, timing, pack, or fabrication-release artifact"
        ),
        "current_target": cfg.get("target"),
        "current_board_class": board.get("class"),
        "required_fields": required_fields,
        "post_handoff_release_evidence_fields": release_fields,
        "pin_diagnostic_summary": {
            "constraint_file": pin_diagnostics["constraint_file"],
            "required_port_count": pin_diagnostics["required_port_count"],
            "located_required_port_count": pin_diagnostics["located_required_port_count"],
            "iobuf_required_port_count": pin_diagnostics["iobuf_required_port_count"],
            "lpf_complete_for_required_ports": pin_diagnostics["lpf_complete_for_required_ports"],
            "lpf_conflict_free": pin_diagnostics["lpf_conflict_free"],
            "release_safe_pin_assignment": pin_diagnostics["release_safe_pin_assignment"],
            "release_safe_pin_assignment_blockers": pin_diagnostics[
                "release_safe_pin_assignment_blockers"
            ],
        },
        "review_packet": [
            "exact board revision evidence",
            "pin assignment source document",
            "final LPF path with LOCATE/IOBUF/frequency constraints",
            "review note mapping LPF ports to board-revision source pins",
            "release_evidence paths for timing, bitstream, bitstream SHA-256, and tool versions after the flow passes",
        ],
        "bounded_validation_commands": [
            "python3 scripts/check_fpga_release.py --release",
            "python3 scripts/generate_e1_demo_fpga_blocked_cli_evidence.py",
        ],
        "next_action_id": "fpga-pin-board-001",
        "next_step": (
            "Fill the required board/pin fields in board/fpga/e1_demo_fpga.yaml, "
            "point constraints.final_lpf at the reviewed final LPF, then rerun the "
            "release gate before attempting route or pack."
        ),
    }


def target_status_promotion_contract(
    cfg: dict,
    manifest: dict | None,
    inventory: dict[str, dict],
    pin_diagnostics: dict,
    build_probe: dict,
) -> dict:
    """Describe the exact evidence required before status may become release_ready."""
    board = cfg.get("board", {}) if isinstance(cfg.get("board"), dict) else {}
    constraints = cfg.get("constraints", {}) if isinstance(cfg.get("constraints"), dict) else {}
    release_evidence = release_evidence_fields(cfg)
    artifact_groups = manifest.get("artifact_groups", {}) if isinstance(manifest, dict) else {}
    bitstream_group = (
        artifact_groups.get("bitstream_release", {}) if isinstance(artifact_groups, dict) else {}
    )

    criteria = [
        {
            "id": "target-status-001",
            "field": "board/fpga/e1_demo_fpga.yaml:status",
            "required_value": "release_ready",
            "current_value": cfg.get("status", "missing"),
            "status": "blocked" if cfg.get("status") != "release_ready" else "satisfied",
            "evidence_required": (
                "Set only after all criteria in this promotion contract are satisfied."
            ),
        },
        {
            "id": "target-status-002",
            "field": "board.exact_revision",
            "required_value": "assigned_exact_board_revision",
            "current_value": board.get("exact_revision", "missing"),
            "status": ("blocked" if is_unassigned(board.get("exact_revision")) else "satisfied"),
            "evidence_required": "Exact ULX3S board revision plus source used for pin mapping.",
        },
        {
            "id": "target-status-003",
            "field": "board.exact_revision_evidence",
            "required_value": "reviewed_revision_source",
            "current_value": board.get("exact_revision_evidence", "missing"),
            "status": (
                "blocked" if is_unassigned(board.get("exact_revision_evidence")) else "satisfied"
            ),
            "evidence_required": "Board photo, BOM, purchase record, or vendor revision document.",
        },
        {
            "id": "target-status-004",
            "field": "constraints.final_lpf",
            "required_value": "reviewed_final_lpf_path",
            "current_value": constraints.get("final_lpf", "missing"),
            "status": ("blocked" if is_unassigned(constraints.get("final_lpf")) else "satisfied"),
            "evidence_required": "Final LPF with reviewed LOCATE, IOBUF, and clock frequency constraints.",
        },
        {
            "id": "target-status-005",
            "field": "constraints.pin_assignment_source",
            "required_value": "reviewed_pin_source",
            "current_value": constraints.get("pin_assignment_source", "missing"),
            "status": (
                "blocked"
                if is_unassigned(constraints.get("pin_assignment_source"))
                else "satisfied"
            ),
            "evidence_required": "Named pin-map source matching the exact board revision.",
        },
        {
            "id": "target-status-006",
            "field": "constraints.bitstream_release_blocked_until_pins_assigned",
            "required_value": False,
            "current_value": constraints.get(
                "bitstream_release_blocked_until_pins_assigned", "missing"
            ),
            "status": (
                "blocked"
                if constraints.get("bitstream_release_blocked_until_pins_assigned") is True
                else "satisfied"
            ),
            "evidence_required": "Pin-review completion and final LPF signoff.",
        },
        {
            "id": "target-status-007",
            "field": "pin_constraint_diagnostics.release_safe_pin_assignment",
            "required_value": True,
            "current_value": pin_diagnostics.get("release_safe_pin_assignment"),
            "status": (
                "satisfied"
                if pin_diagnostics.get("release_safe_pin_assignment") is True
                else "blocked"
            ),
            "evidence_required": "No missing, conflicting, or duplicate required pin constraints.",
        },
        {
            "id": "target-status-008",
            "field": "board/fpga/artifact-manifest.yaml:status",
            "required_value": "complete",
            "current_value": manifest.get("status", "missing")
            if isinstance(manifest, dict)
            else "missing",
            "status": (
                "satisfied"
                if isinstance(manifest, dict) and manifest.get("status") == "complete"
                else "blocked"
            ),
            "evidence_required": "Manifest promoted only after reviewed release artifacts exist.",
        },
        {
            "id": "target-status-009",
            "field": "artifact_groups.bitstream_release.status",
            "required_value": "complete",
            "current_value": bitstream_group.get("status", "missing")
            if isinstance(bitstream_group, dict)
            else "missing",
            "status": (
                "satisfied"
                if isinstance(bitstream_group, dict) and bitstream_group.get("status") == "complete"
                else "blocked"
            ),
            "evidence_required": "Bitstream artifact group reviewed as complete.",
        },
        {
            "id": "target-status-010",
            "field": "latest_non_release_build_probe.status",
            "required_value": "not_blocking_release_flow",
            "current_value": build_probe.get("status", "missing"),
            "status": (
                "blocked"
                if build_probe.get("status") in {"timed_out_non_release", "failed"}
                else "satisfied"
            ),
            "evidence_required": "Full e1_chip_top synthesis no longer times out before route/pack.",
        },
    ]

    for field in [
        "bitstream_path",
        "bitstream_sha256",
        "timing_report",
        "timing_summary",
        "archived_tool_versions",
        "programming_transcript",
    ]:
        value = release_evidence.get(field)
        criteria.append(
            {
                "id": f"target-status-release-evidence-{field.replace('_', '-')}",
                "field": f"release_evidence.{field}",
                "required_value": "assigned_release_artifact",
                "current_value": value if not is_unassigned(value) else "unassigned",
                "status": "blocked" if is_unassigned(value) else "satisfied",
                "evidence_required": (
                    "Path or value from the final e1_chip_top release run, not smoke or diagnostic output."
                ),
                "source_manifest": CFG.relative_to(ROOT).as_posix(),
                "accepted_artifact_paths": [] if is_unassigned(value) else [value],
                "expected_command_output": {
                    "command": "python3 scripts/check_fpga_release.py --release",
                    "accepted_exit_code": 0,
                    "accepted_output": "Release gate accepts the assigned release_evidence field and matching artifact content.",
                },
                "release_credit": False,
            }
        )

    for label in REQUIRED_RELEASE_EVIDENCE:
        artifact = inventory.get(label, {})
        criteria.append(
            {
                "id": f"target-status-artifact-{label.replace(' ', '-')}",
                "field": f"artifact_inventory.{label}",
                "required_value": "release_credit_true",
                "current_value": artifact.get("status", "missing"),
                "status": "satisfied" if artifact.get("release_credit") else "blocked",
                "evidence_required": (
                    "At least one non-diagnostic artifact from the final e1_chip_top release flow."
                ),
                "source_manifest": MANIFEST.relative_to(ROOT).as_posix(),
                "expected_command_output": {
                    "command": artifact.get("unblock_command"),
                    "accepted_exit_code": 0,
                    "accepted_output": "Final e1_chip_top output archived at an accepted release path.",
                },
                "accepted_artifact_paths": artifact.get("release_credit_paths", []),
                "expected_globs": artifact.get("patterns", []),
                "release_credit": False,
            }
        )

    for item in criteria:
        item.setdefault("source_manifest", CFG.relative_to(ROOT).as_posix())
        item.setdefault("accepted_artifact_paths", [])
        item.setdefault(
            "expected_command_output",
            {
                "command": "python3 scripts/check_fpga_release.py --release",
                "accepted_exit_code": 0,
                "accepted_output": "Release gate passes without blocked criteria.",
            },
        )
        item["release_credit"] = False

    blocked = [item for item in criteria if item["status"] != "satisfied"]
    return {
        "status": "blocked" if blocked else "satisfied",
        "release_credit": False,
        "claim_boundary": (
            "target status promotion checklist only; does not create bitstream, timing, "
            "route, pack, board, or fabrication evidence"
        ),
        "next_action_id": "fpga-target-promotion-001",
        "current_target_status": cfg.get("status", "missing"),
        "required_target_status": "release_ready",
        "source_manifests": [
            CFG.relative_to(ROOT).as_posix(),
            MANIFEST.relative_to(ROOT).as_posix(),
        ],
        "blocked_count": len(blocked),
        "blocked_criteria": [item["id"] for item in blocked],
        "criteria": criteria,
        "next_step": (
            "Keep board/fpga/e1_demo_fpga.yaml status at scaffold until every blocked "
            "criterion is satisfied by real e1_chip_top release artifacts and reviewed board/pin evidence."
        ),
        "bounded_validation_commands": [
            "python3 scripts/check_fpga_target.py",
            "python3 scripts/check_fpga_release.py --release",
            "python3 scripts/product_check.py --release",
        ],
    }


def blocker_group_for(finding: str) -> str:
    if "non-release e1_chip_top build probe timed out/interrupted" in finding:
        return "synthesis_runtime"
    if "non-release e1_chip_top build probe failed" in finding:
        return "rtl_synthesis"
    if "manifest CLI command" in finding:
        return "manifest_commands"
    if "artifact manifest" in finding:
        return "manifest_contract"
    if "target status" in finding or "board exact_revision" in finding:
        return "target_contract"
    if "pins are assigned" in finding or "LPF" in finding:
        return "pin_constraints"
    if "tool unavailable" in finding:
        return "toolchain"
    if "missing FPGA release evidence" in finding:
        return "release_artifacts"
    return "fpga_release"


def blocker_groups(findings: list[str]) -> dict[str, dict]:
    groups: dict[str, dict] = {}
    for finding in findings:
        group_id = blocker_group_for(finding)
        group = groups.setdefault(
            group_id,
            {
                "status": "blocked",
                "dependency_type": "repo_artifact_generation",
                "messages": [],
                "next_step": "",
            },
        )
        group["messages"].append(finding)
    next_steps = {
        "manifest_contract": "Promote board/fpga/artifact-manifest.yaml only after final release artifacts exist and are reviewed.",
        "manifest_commands": "Update manifest release commands to target e1_chip_top and keep smoke-top commands diagnostic-only.",
        "target_contract": "Record the exact FPGA board revision and move the target out of scaffold only after release evidence exists.",
        "pin_constraints": "Replace the skeleton LPF with final LOCATE/IOBUF/frequency constraints for every required E1 signal.",
        "rtl_synthesis": "Make the e1_chip_top FPGA RTL cone synthesizable under Yosys before expecting route, pack, or bitstream evidence.",
        "synthesis_runtime": "Reduce the full-chip FPGA synthesis cone or split out the NPU/display multiplier-heavy logic, then rerun bounded Yosys diagnostics before route or pack.",
        "toolchain": "Install OSS CAD Suite or put yosys, nextpnr-ecp5, and ecppack on PATH before running release generation.",
        "release_artifacts": "Run the real FPGA flow and archive bitstream, timing, route, pack, and tool-version evidence from that release run.",
        "fpga_release": "Close the FPGA release blocker without relaxing fail-closed evidence gates.",
    }
    for group_id, group in groups.items():
        group["next_step"] = next_steps[group_id]
    return groups


def release_blocker_categories(
    cfg: dict,
    manifest: dict | None,
    inventory: dict[str, dict],
    pin_diagnostics: dict,
    build_probe: dict,
) -> dict[str, dict]:
    """Machine-readable release blocker taxonomy for the FPGA lane."""
    board = cfg.get("board", {}) if isinstance(cfg.get("board"), dict) else {}
    constraints = cfg.get("constraints", {}) if isinstance(cfg.get("constraints"), dict) else {}
    evidence = release_evidence_fields(cfg)
    manifest_status = manifest.get("status", "missing") if isinstance(manifest, dict) else "missing"
    missing_locate = pin_diagnostics.get("missing_locate", [])
    missing_iobuf = pin_diagnostics.get("missing_iobuf", [])

    def artifact_category(label: str, *field_names: str) -> dict:
        status = inventory.get(label, {})
        missing_fields = [
            f"release_evidence.{name}" for name in field_names if is_unassigned(evidence.get(name))
        ]
        diagnostic_matches = [
            match for match in status.get("matches", []) if match.get("diagnostic_only")
        ]
        release_paths = status.get("release_credit_paths", [])
        return {
            "status": "blocked" if status.get("missing") or missing_fields else "satisfied",
            "count": int(bool(status.get("missing"))) + len(missing_fields),
            "artifact": label,
            "missing_artifact": bool(status.get("missing")),
            "missing_fields": missing_fields,
            "release_credit_paths": release_paths,
            "present_but_nonrelease_count": len(diagnostic_matches),
            "present_but_nonrelease_paths": [
                match.get("path") for match in diagnostic_matches[:12]
            ],
            "unblock_command": status.get("unblock_command"),
            "release_credit": False,
        }

    present_nonrelease = {
        label: [
            match.get("path") for match in status.get("matches", []) if match.get("diagnostic_only")
        ]
        for label, status in inventory.items()
    }
    present_nonrelease = {label: paths for label, paths in present_nonrelease.items() if paths}

    categories = {
        "scaffold_target": {
            "status": "blocked" if cfg.get("status") != "release_ready" else "satisfied",
            "count": 0 if cfg.get("status") == "release_ready" else 1,
            "current_value": cfg.get("status", "missing"),
            "required_value": "release_ready",
            "source": CFG.relative_to(ROOT).as_posix(),
            "release_credit": False,
        },
        "unassigned_exact_revision": {
            "status": ("blocked" if is_unassigned(board.get("exact_revision")) else "satisfied"),
            "count": 1 if is_unassigned(board.get("exact_revision")) else 0,
            "current_value": board.get("exact_revision"),
            "required_value": "assigned_exact_board_revision",
            "source": CFG.relative_to(ROOT).as_posix(),
            "release_credit": False,
        },
        "missing_locate_comp_assignments": {
            "status": "blocked" if missing_locate else "satisfied",
            "count": len(missing_locate),
            "ports": missing_locate,
            "constraint_file": pin_diagnostics.get("constraint_file"),
            "release_credit": False,
        },
        "missing_iobuf_declarations": {
            "status": "blocked" if missing_iobuf else "satisfied",
            "count": len(missing_iobuf),
            "ports": missing_iobuf,
            "constraint_file": pin_diagnostics.get("constraint_file"),
            "release_credit": False,
        },
        "pin_release_flag_blocked": {
            "status": (
                "blocked"
                if constraints.get("bitstream_release_blocked_until_pins_assigned") is True
                else "satisfied"
            ),
            "count": (
                1 if constraints.get("bitstream_release_blocked_until_pins_assigned") is True else 0
            ),
            "current_value": constraints.get("bitstream_release_blocked_until_pins_assigned"),
            "release_credit": False,
        },
        "manifest_not_promoted": {
            "status": "blocked" if manifest_status != "complete" else "satisfied",
            "count": 0 if manifest_status == "complete" else 1,
            "current_value": manifest_status,
            "required_value": "complete",
            "source": MANIFEST.relative_to(ROOT).as_posix(),
            "release_credit": False,
        },
        "missing_bitstream_evidence": artifact_category(
            "bitstream", "bitstream_path", "bitstream_sha256"
        ),
        "missing_timing_evidence": artifact_category(
            "nextpnr timing report", "timing_report", "timing_summary"
        ),
        "missing_route_evidence": artifact_category("nextpnr route report"),
        "missing_pack_evidence": artifact_category("ecppack transcript"),
        "missing_programming_evidence": artifact_category(
            "programming transcript", "programming_transcript"
        ),
        "missing_tool_version_evidence": artifact_category(
            "FPGA tool versions", "archived_tool_versions"
        ),
        "present_but_nonrelease_artifacts": {
            "status": "blocked" if present_nonrelease else "satisfied",
            "count": sum(len(paths) for paths in present_nonrelease.values()),
            "by_artifact": present_nonrelease,
            "release_credit": False,
        },
        "nonrelease_build_probe_blocked": {
            "status": (
                "blocked"
                if build_probe.get("status") in {"failed_non_release", "timed_out_non_release"}
                else "satisfied"
            ),
            "count": (
                1
                if build_probe.get("status") in {"failed_non_release", "timed_out_non_release"}
                else 0
            ),
            "current_value": build_probe.get("status"),
            "latest": build_probe.get("latest"),
            "release_credit": False,
        },
    }
    return categories


def repo_artifact_generation_plan(
    categories: dict[str, dict],
    tools: dict[str, dict],
) -> dict:
    blocked_categories = {
        name: row for name, row in sorted(categories.items()) if row["status"] == "blocked"
    }
    missing_required_tools = [
        name for name, row in tools.items() if row["required_for_release"] and not row["available"]
    ]

    def blockers_for(name: str) -> list[str]:
        if name in {
            "unassigned_exact_revision",
            "pin_release_flag_blocked",
            "missing_locate_comp_assignments",
            "missing_iobuf_declarations",
        }:
            return ["final_pins_or_board_revision"]
        if name in {"scaffold_target", "manifest_not_promoted"}:
            return ["release_manifest_or_target_promotion"]
        if name == "nonrelease_build_probe_blocked":
            return ["synthesis_runtime_or_rtl_closure"]
        if name.startswith("missing_") and name.endswith("_evidence"):
            return [
                "final_pins_or_board_revision",
                "synthesis_runtime_or_rtl_closure",
                "release_bitstream_route_pack_programming_evidence",
            ]
        if name == "present_but_nonrelease_artifacts":
            return ["diagnostic_artifacts_not_release_outputs"]
        return ["fpga_release_evidence"]

    rows = []
    for name, row in blocked_categories.items():
        rows.append(
            {
                "category": name,
                "count": row["count"],
                "repo_generatable_now": False,
                "can_close_release_from_current_repo": False,
                "blocked_by": blockers_for(name),
                "unblock_command": row.get("unblock_command"),
                "release_credit": False,
            }
        )

    return {
        "release_credit": False,
        "claim_boundary": (
            "FPGA release artifacts are not generatable for release credit from current "
            "repo state. Local diagnostics and tool checks can be regenerated, but final "
            "pins/board revision, release synthesis completion, route/timing/pack outputs, "
            "bitstream hash, programming transcript, and manifest promotion remain blocked."
        ),
        "repo_generatable_now_count": 0,
        "can_close_from_current_repo_count": 0,
        "blocked_generation_count": sum(row["count"] for row in blocked_categories.values()),
        "blocked_category_count": len(blocked_categories),
        "missing_required_tool_count": len(missing_required_tools),
        "missing_required_tools": missing_required_tools,
        "blocked_by_final_pins_or_board_revision_count": sum(
            row["count"]
            for name, row in blocked_categories.items()
            if "final_pins_or_board_revision" in blockers_for(name)
        ),
        "blocked_by_synthesis_runtime_or_rtl_count": sum(
            row["count"]
            for name, row in blocked_categories.items()
            if "synthesis_runtime_or_rtl_closure" in blockers_for(name)
        ),
        "blocked_by_release_artifact_evidence_count": sum(
            row["count"]
            for name, row in blocked_categories.items()
            if "release_bitstream_route_pack_programming_evidence" in blockers_for(name)
        ),
        "rows": rows,
    }


def write_report(
    status: str,
    findings: list[str],
    release: bool,
    cfg: dict,
    inventory: dict[str, dict],
    manifest: dict | None,
    pin_diagnostics: dict,
    build_probe: dict,
) -> None:
    groups = blocker_groups(findings) if findings else {}
    categories = release_blocker_categories(cfg, manifest, inventory, pin_diagnostics, build_probe)
    tools = tool_availability()
    generation_plan = repo_artifact_generation_plan(categories, tools)
    missing_release_tools = [
        tool
        for tool, data in tools.items()
        if data["required_for_release"] and not data["available"]
    ]
    payload = {
        "schema": SCHEMA,
        "status": status,
        "blocked_state": (
            "known_fail_closed_release_evidence_blocked" if status == "blocked" else None
        ),
        "release_credit": status == "pass" and release,
        "claim_boundary": CLAIM_BOUNDARY,
        "mode": "release" if release else "preflight",
        "inputs": {
            "target": CFG.relative_to(ROOT).as_posix(),
            "manifest": MANIFEST.relative_to(ROOT).as_posix(),
        },
        "summary": {
            "release_ready": status == "pass" and release,
            "release_credit": status == "pass" and release,
            "blockers": len(findings) if status == "blocked" else 0,
            "failures": len(findings) if status == "fail" else 0,
            "blocker_groups": len(groups),
            "blocker_category_count": sum(
                1 for row in categories.values() if row["status"] == "blocked"
            ),
            "blocker_category_counts": {
                name: row["count"]
                for name, row in sorted(categories.items())
                if row["status"] == "blocked"
            },
            "missing_locate_comp_assignment_count": categories["missing_locate_comp_assignments"][
                "count"
            ],
            "missing_programming_evidence_count": categories["missing_programming_evidence"][
                "count"
            ],
            "present_but_nonrelease_artifact_count": categories["present_but_nonrelease_artifacts"][
                "count"
            ],
            "repo_generatable_now_count": generation_plan["repo_generatable_now_count"],
            "blocked_repo_generation_count": generation_plan["blocked_generation_count"],
            "diagnostic_only_artifacts": sum(
                item["diagnostic_only_count"] for item in inventory.values()
            ),
        },
        "blocker_groups": groups,
        "release_blocker_categories": categories,
        "repo_artifact_generation_plan": generation_plan,
        "artifact_inventory": inventory,
        "pin_constraint_diagnostics": pin_diagnostics,
        "pin_board_revision_handoff_contract": pin_board_revision_handoff_contract(
            cfg, pin_diagnostics
        ),
        "target_status_promotion_contract": target_status_promotion_contract(
            cfg, manifest, inventory, pin_diagnostics, build_probe
        ),
        "latest_non_release_build_probe": build_probe,
        "bounded_synthesis_diagnostics": bounded_synthesis_diagnostics(),
        "release_commands": manifest_release_commands(manifest),
        "manifest_artifact_glob_audit": manifest_artifact_glob_audit(manifest),
        "release_artifact_requirements": release_artifact_requirements(inventory),
        "release_evidence_archive_contract": release_evidence_archive_contract(cfg, inventory),
        "tool_availability": tools,
        "toolchain_summary": {
            "status": "blocked_missing_required_tools"
            if missing_release_tools
            else "tools_available",
            "missing_required_tools": missing_release_tools,
            "claim_boundary": "tool presence does not prove release readiness; generated artifacts must still pass the release gate",
        },
        "diagnostic_evidence": {
            "release_credit": False,
            "claim_boundary": "diagnostic transcripts and tool availability never substitute for bitstream release evidence",
            "command": "python3 scripts/generate_e1_demo_fpga_blocked_cli_evidence.py",
            "outputs": [
                rel(DIAGNOSTIC_REPORT_DIR / "e1-demo-fpga-command-transcript.txt"),
                rel(DIAGNOSTIC_REPORT_DIR / "e1-demo-fpga-tool-availability.txt"),
            ],
        },
        "findings": [
            {
                "code": f"fpga_release_{status}_{index}",
                "severity": "blocker" if status == "blocked" else "error",
                "message": finding,
                "group": blocker_group_for(finding),
                "dependency_type": "repo_artifact_generation",
                "evidence": CFG.relative_to(ROOT).as_posix(),
                "next_step": finding_next_step(finding),
            }
            for index, finding in enumerate(findings, start=1)
        ],
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def finding_next_step(finding: str) -> str:
    if "non-release e1_chip_top build probe timed out/interrupted" in finding:
        return (
            "RTL elaboration is past the previous missing-module/range blockers. "
            "Next run the release-equivalent bounded probe with "
            "`python3 scripts/run_with_timeout.py --timeout-seconds 1800 --label fpga-e1-chip-top-nonrelease-build -- bash -lc './scripts/fpga/build_e1_demo.sh'`, "
            "and use the no-ABC9 diagnostic only to localize runtime pressure."
        )
    if "non-release e1_chip_top build probe failed" in finding:
        return (
            "Fix the cited Yosys synthesis error, rerun scripts/fpga/build_e1_demo.sh, "
            "then inspect archived non-release logs before attempting release evidence."
        )
    if finding.startswith("missing FPGA release evidence: "):
        label = finding.rsplit(": ", 1)[1]
        command = ARTIFACT_UNBLOCK_COMMANDS.get(label)
        if command:
            return f"Generate release-credit {label} with: {command}"
    if finding.startswith("FPGA tool unavailable: "):
        tool = finding.rsplit(": ", 1)[1]
        return f"Install OSS CAD Suite or place {tool} on PATH, then rerun the e1_chip_top release commands."
    if "manifest CLI command" in finding:
        return "Change board/fpga/artifact-manifest.yaml commands from smoke-top diagnostics to TOP=e1_chip_top release commands."
    return (
        "Assign final FPGA board revision and pins, then archive bitstream, timing, "
        "route, pack, and tool-version release evidence."
    )


def vector_widths_from_pinout(path: Path) -> dict[str, int]:
    data = yaml.safe_load(path.read_text())
    widths: dict[str, int] = {}
    for pin in data.get("pins", []):
        name = str(pin.get("name", ""))
        match = re.match(r"^(DBG_ADDR|DBG_WDATA|DBG_RDATA|GPIO)([0-9]+)$", name)
        if match:
            base, index = match.group(1), int(match.group(2))
            widths[base] = max(widths.get(base, 0), index + 1)
    return widths


def expand_required(cfg: dict, widths: dict[str, int]) -> set[str]:
    scalar_required = {
        cfg["clock"]["port"],
        cfg["reset"]["port"],
        *cfg["debug_bridge"]["required_ports"],
        *cfg["external_outputs"]["irq_ports"],
        *cfg.get("reserved_inputs", []),
        *cfg.get("reserved_outputs", []),
    }
    scalar_required.add(cfg["external_outputs"]["gpio_port"])

    expanded: set[str] = set()
    for name in scalar_required:
        if name in widths:
            expanded.update(f"{name}[{index}]" for index in range(widths[name]))
        else:
            expanded.add(name)
    return expanded


def yosys_log_analysis(path: Path, exit_status: str) -> dict:
    text = path.read_text(encoding="utf-8", errors="ignore") if path.is_file() else ""
    lines = text.splitlines()
    errors = [line.strip() for line in lines if "ERROR:" in line]
    pass_markers = [
        match.group(1).strip()
        for line in lines
        if (match := re.search(r"^\d+(?:\.\d+)*\.\s+Executing\s+(.+?)\s+pass", line))
    ]
    last_pass = pass_markers[-1] if pass_markers else None
    abc9_seen = "Executing ABC9" in text or "Executing ABC9 pass" in text
    classic_abc_seen = "Executing ABC pass" in text
    autoname_seen = "Executing AUTONAME pass" in text
    completed = (
        "End of script." in text
        or "Executing JSON backend" in text
        or "Successfully finished JSON backend" in text
    )

    if exit_status == "0" or completed:
        return {
            "failure_class": "none",
            "failure_stage": "completed_yosys_synthesis",
            "timed_out_or_interrupted": False,
            "abc9_completed": abc9_seen,
            "classic_abc_reached": classic_abc_seen,
            "autoname_reached": autoname_seen,
            "last_yosys_pass": last_pass,
            "errors": errors[-5:],
        }
    if errors:
        return {
            "failure_class": "rtl_elaboration_failure",
            "failure_stage": "rtl_frontend_or_hierarchy",
            "timed_out_or_interrupted": False,
            "abc9_completed": abc9_seen,
            "classic_abc_reached": classic_abc_seen,
            "autoname_reached": autoname_seen,
            "last_yosys_pass": last_pass,
            "errors": errors[-5:],
        }
    if abc9_seen and autoname_seen:
        failure_stage = "post_abc9_autoname"
        failure_class = "timeout_or_interrupted_post_abc9_oversize"
    elif classic_abc_seen:
        failure_stage = "classic_abc_mapping"
        failure_class = "timeout_or_interrupted_classic_abc_mapping"
    elif abc9_seen:
        failure_stage = "abc9_or_later"
        failure_class = "timeout_or_interrupted_tool_runtime"
    else:
        failure_stage = "yosys_runtime_before_abc9"
        failure_class = "timeout_or_interrupted_tool_runtime"
    return {
        "failure_class": failure_class,
        "failure_stage": failure_stage,
        "timed_out_or_interrupted": True,
        "abc9_completed": abc9_seen,
        "classic_abc_reached": classic_abc_seen,
        "autoname_reached": autoname_seen,
        "last_yosys_pass": last_pass,
        "errors": errors[-5:],
    }


def yosys_runtime_markers(path: Path) -> dict:
    text = path.read_text(encoding="utf-8", errors="ignore") if path.is_file() else ""
    cell_counts = [
        int(match.group(1)) for match in re.finditer(r"Computing hashes of (\d+) cells", text)
    ]
    module_hotspots = {}
    for module in ("u_npu", "u_display", "u_behavioral_dram", "u_weight_buffer"):
        count = text.count(f"\\{module}") + text.count(f".{module}.")
        if count:
            module_hotspots[module] = count
    multiplier_lines = [
        line.strip()
        for line in text.splitlines()
        if "$mul" in line and ("Analyzing resource sharing" in line or "add " in line)
    ]
    return {
        "max_hashed_cells": max(cell_counts) if cell_counts else None,
        "last_hashed_cells": cell_counts[-1] if cell_counts else None,
        "module_reference_hotspots": module_hotspots,
        "multiplier_hotspot_examples": multiplier_lines[-8:],
        "observed_runtime_pressure": bool(cell_counts or multiplier_lines),
    }


def yosys_profile_summary(path: Path) -> dict:
    text = path.read_text(encoding="utf-8", errors="ignore") if path.is_file() else ""
    modules = []
    hierarchy_counts: dict[str, int] = {}
    current: dict | None = None
    cell_types: dict[str, int] = {}
    in_cell_types = False
    in_design_hierarchy = False
    for raw_line in text.splitlines():
        line = raw_line.rstrip()
        if line.startswith("=== design hierarchy ==="):
            if current is not None:
                modules.append(current)
            current = None
            in_cell_types = False
            in_design_hierarchy = True
            continue
        module_match = re.match(r"===\s+\\?([^=\s]+)\s+===", line)
        if module_match:
            if current is not None:
                modules.append(current)
            current = {
                "module": module_match.group(1),
                "num_wires": None,
                "num_wire_bits": None,
                "num_cells": None,
                "cell_types": {},
            }
            in_cell_types = False
            in_design_hierarchy = False
            continue
        if in_design_hierarchy:
            hierarchy_match = re.match(r"\s+(\d+)\s+([A-Za-z0-9_$\\][A-Za-z0-9_.$\\-]*)$", line)
            if hierarchy_match:
                module_name = hierarchy_match.group(2).lstrip("\\")
                if module_name not in {"wires", "ports", "memories", "processes", "submodules"}:
                    hierarchy_counts[module_name] = int(hierarchy_match.group(1))
                continue
            if line.strip() == "":
                continue
            if re.match(r"\s+\+[-]+", line) or "Count including submodules" in line:
                continue
            if re.match(
                r"\s+\d+\s+(wires|wire bits|public wires|public wire bits|ports|port bits|memories|memory bits|cells|processes|submodules)$",
                line,
            ):
                continue
            if line.startswith("Warnings:") or line.startswith("End of script."):
                in_design_hierarchy = False
        if current is None:
            continue
        metric_match = re.match(r"\s+Number of (wires|wire bits|cells):\s+(\d+)", line)
        if metric_match:
            key = {
                "wires": "num_wires",
                "wire bits": "num_wire_bits",
                "cells": "num_cells",
            }[metric_match.group(1)]
            current[key] = int(metric_match.group(2))
            in_cell_types = key == "num_cells"
            continue
        compact_metric_match = re.match(r"\s+(\d+)\s+(wires|wire bits|cells)$", line)
        if compact_metric_match:
            key = {
                "wires": "num_wires",
                "wire bits": "num_wire_bits",
                "cells": "num_cells",
            }[compact_metric_match.group(2)]
            current[key] = int(compact_metric_match.group(1))
            in_cell_types = key == "num_cells"
            continue
        if in_cell_types:
            cell_match = re.match(r"\s+(\$?[A-Za-z0-9_.$\\-]+)\s+(\d+)$", line)
            if cell_match:
                current["cell_types"][cell_match.group(1)] = int(cell_match.group(2))
                cell_types[cell_match.group(1)] = cell_types.get(cell_match.group(1), 0) + int(
                    cell_match.group(2)
                )
                continue
            if re.match(r"\s+\d+\s+submodules$", line):
                in_cell_types = False
                continue
            compact_cell_match = re.match(r"\s+(\d+)\s+(\$?[A-Za-z0-9_.$\\-]+)$", line)
            if compact_cell_match:
                count = int(compact_cell_match.group(1))
                cell_type = compact_cell_match.group(2)
                current["cell_types"][cell_type] = count
                cell_types[cell_type] = cell_types.get(cell_type, 0) + count
                continue
            if line.strip() == "":
                in_cell_types = False
    if current is not None:
        modules.append(current)

    modules_by_cells = sorted(
        modules,
        key=lambda row: row["num_cells"] if row["num_cells"] is not None else -1,
        reverse=True,
    )
    multiplier_like = {
        name: count
        for name, count in sorted(cell_types.items())
        if "mul" in name.lower() or name in {"MUL", "$macc"}
    }
    memory_rom_pressure = yosys_memory_rom_pressure(text, hierarchy_counts, cell_types)
    return {
        "module_count": len(modules),
        "largest_modules_by_cells": modules_by_cells[:8],
        "hierarchy_cells_including_submodules": [
            {"module": name, "cells": count}
            for name, count in sorted(
                hierarchy_counts.items(), key=lambda item: item[1], reverse=True
            )[:12]
        ],
        "top_cell_types": [
            {"cell_type": name, "count": count}
            for name, count in sorted(cell_types.items(), key=lambda item: item[1], reverse=True)[
                :12
            ]
        ],
        "multiplier_like_cell_types": multiplier_like,
        "memory_rom_synthesis_pressure": memory_rom_pressure,
        "completed_stat": bool(modules),
        "release_credit": False,
        "claim_boundary": "pre-map stat profile only; not synth_ecp5, route, pack, timing, or bitstream evidence",
    }


def yosys_memory_rom_pressure(
    text: str,
    hierarchy_counts: dict[str, int],
    cell_types: dict[str, int],
) -> dict:
    replacing_memory = []
    for line in text.splitlines():
        match = re.search(r"Replacing memory \\([^ ]+) with list of registers\. See (.+)", line)
        if match:
            source = match.group(2)
            source_match = re.search(r"rtl/([^:]+):", source)
            replacing_memory.append(
                {
                    "memory": match.group(1),
                    "source": f"rtl/{source_match.group(1)}" if source_match else source,
                }
            )

    pressure_modules = []
    module_guidance = {
        "e1_behavioral_dram": (
            "Replace the behavioral DRAM array with an FPGA-specific BRAM/external-memory stub "
            "before route/pack attempts."
        ),
        "e1_bootrom": (
            "Keep the boot ROM preload small or map it to FPGA ROM/BRAM initialization instead "
            "of expanded mux/init logic."
        ),
        "e1_weight_buffer_sram": (
            "Map the NPU weight buffer to FPGA RAM primitives or reduce the profile size for the "
            "bounded FPGA build."
        ),
        "e1_npu": (
            "Gate or profile the multiplier-heavy NPU cone before expecting full-chip FPGA closure."
        ),
        "e1_display": (
            "Keep display arithmetic/profile logic bounded for FPGA diagnostics until timing can run."
        ),
    }
    module_actions = {
        "e1_behavioral_dram": {
            "action_id": "fpga-memory-001",
            "priority": 1,
            "task_type": "external_sram_or_bram_model",
            "remediation_target": "Replace behavioral DRAM register expansion with an FPGA-specific external SRAM shim or BRAM-inferred model.",
            "owner_hint": "fpga_rtl",
            "acceptance_check": (
                "preabc profile shows no Yosys 'Replacing memory' rows for e1_behavioral_dram "
                "and the module drops below 10000 hierarchy cells"
            ),
        },
        "e1_bootrom": {
            "action_id": "fpga-memory-002",
            "priority": 2,
            "task_type": "rom_bram_initialization",
            "remediation_target": "Map boot ROM contents to FPGA ROM/BRAM initialization or shrink the diagnostic preload.",
            "owner_hint": "fpga_rtl",
            "acceptance_check": (
                "preabc profile keeps boot ROM as inferred memory/ROM and e1_bootrom drops below "
                "4000 hierarchy cells"
            ),
        },
        "e1_weight_buffer_sram": {
            "action_id": "fpga-memory-003",
            "priority": 3,
            "task_type": "weight_buffer_bram_inference",
            "remediation_target": "Map the NPU weight buffer to FPGA RAM primitives or gate it behind a smaller diagnostic profile.",
            "owner_hint": "fpga_rtl",
            "acceptance_check": (
                "preabc profile shows weight-buffer storage inferred as memory and "
                "e1_weight_buffer_sram drops below 4000 hierarchy cells"
            ),
        },
        "e1_npu": {
            "action_id": "fpga-compute-004",
            "priority": 4,
            "task_type": "smaller_diagnostic_top_or_compute_gate",
            "remediation_target": "Gate multiplier-heavy NPU logic or introduce a smaller diagnostic top before full release-top closure attempts.",
            "owner_hint": "fpga_rtl",
            "acceptance_check": (
                "bounded preabc profile keeps multiplier-like cell count stable and a non-release "
                "probe reaches post-synthesis without timeout"
            ),
        },
        "e1_display": {
            "action_id": "fpga-compute-005",
            "priority": 5,
            "task_type": "display_logic_profile_gate",
            "remediation_target": "Keep display arithmetic and framebuffer-facing logic out of the first bounded FPGA closure profile.",
            "owner_hint": "fpga_rtl",
            "acceptance_check": (
                "bounded preabc profile reports display logic as a small cone and no new "
                "memory replacement rows appear for display storage"
            ),
        },
    }
    for module, guidance in module_guidance.items():
        cells = hierarchy_counts.get(module)
        if cells is None:
            continue
        action = module_actions[module]
        pressure_modules.append(
            {
                "module": module,
                "cells_including_submodules": cells,
                "pressure_class": (
                    "memory_or_rom_expansion"
                    if any(token in module for token in ("dram", "bootrom", "sram"))
                    else "compute_logic_expansion"
                ),
                "next_step": guidance,
                "next_action_id": action["action_id"],
            }
        )

    memory_bit_counts = [
        int(match.group(1)) for match in re.finditer(r"\n\s+(\d+)\s+memory bits\n", text)
    ]
    total_memory_bits = max(memory_bit_counts) if memory_bit_counts else None

    sorted_pressure_modules = sorted(
        pressure_modules,
        key=lambda row: cast("int", row["cells_including_submodules"]),
        reverse=True,
    )
    next_actions = []
    for row in sorted_pressure_modules:
        action = module_actions[cast("str", row["module"])]
        next_actions.append(
            {
                **action,
                "module": row["module"],
                "pressure_class": row["pressure_class"],
                "cells_including_submodules": row["cells_including_submodules"],
                "release_credit": False,
                "validation_command": ("python3 scripts/check_fpga_release.py --release"),
                "bounded_diagnostic_command": BOUNDED_SYNTH_DIAGNOSTIC_LOGS[0]["exact_command"],
                "claim_boundary": (
                    "remediation task only; release credit still requires successful release "
                    "synth, place/route, pack, timing, bitstream hash, and reviewed artifact manifest"
                ),
            }
        )

    return {
        "release_credit": False,
        "claim_boundary": "diagnostic pressure localization only; not a memory implementation waiver or release artifact",
        "total_memory_bits": total_memory_bits,
        "memory_replaced_with_registers_count": len(replacing_memory),
        "memory_replaced_with_registers_examples": replacing_memory[:12],
        "meminit_v2_cells": cell_types.get("$meminit_v2", 0),
        "modules": sorted_pressure_modules,
        "next_actions": next_actions,
    }


def bounded_synthesis_diagnostics() -> list[dict]:
    rows = []
    for spec in BOUNDED_SYNTH_DIAGNOSTIC_LOGS:
        path = cast("Path", spec["log"])
        if not path.is_file():
            rows.append(
                {
                    "id": spec["id"],
                    "label": spec["label"],
                    "status": "not_run",
                    "log": rel(path),
                    "exact_command": spec["exact_command"],
                    "release_credit": False,
                    "diagnostic_goal": spec.get("diagnostic_goal"),
                }
            )
            continue
        analysis = yosys_log_analysis(path, "unknown")
        profile_summary = (
            {"profile_summary": yosys_profile_summary(path)}
            if spec["id"] == "preabc_profile"
            else {}
        )
        rows.append(
            {
                "id": spec["id"],
                "label": spec["label"],
                "status": (
                    "completed_non_release"
                    if analysis["failure_class"] == "none"
                    else "incomplete_or_timed_out_non_release"
                ),
                "log": rel(path),
                "exact_command": spec["exact_command"],
                "release_credit": False,
                "claim_boundary": "bounded diagnostic only; not timing, route, pack, bitstream, or release evidence",
                "diagnostic_goal": spec.get("diagnostic_goal"),
                **analysis,
                "runtime_markers": yosys_runtime_markers(path),
                **profile_summary,
            }
        )
    return rows


def assigned_lpf_ports(path: Path) -> tuple[set[str], set[str], bool]:
    located: set[str] = set()
    iobuf: set[str] = set()
    has_frequency = False
    locate_re = re.compile(r'^\s*LOCATE\s+COMP\s+"([^"]+)"\s+SITE\s+"[^"]+"', re.I)
    iobuf_re = re.compile(r'^\s*IOBUF\s+PORT\s+"([^"]+)"\s+IO_TYPE\s*=', re.I)
    freq_re = re.compile(r'^\s*FREQUENCY\s+PORT\s+"CLK_IN"', re.I)
    for line in path.read_text().splitlines():
        if line.lstrip().startswith("#"):
            continue
        locate = locate_re.search(line)
        if locate:
            located.add(locate.group(1))
        buf = iobuf_re.search(line)
        if buf:
            iobuf.add(buf.group(1))
        if freq_re.search(line):
            has_frequency = True
    return located, iobuf, has_frequency


def latest_non_release_build_probe() -> dict:
    rows = []
    newest_archived_mtime = 0.0
    if FPGA_BUILD_ARCHIVE_DIR.is_dir():
        for directory in sorted(FPGA_BUILD_ARCHIVE_DIR.iterdir()):
            if not directory.is_dir():
                continue
            provenance = directory / "provenance.txt"
            yosys_log = directory / "yosys.log"
            if not provenance.is_file():
                continue
            provenance_text = provenance.read_text(encoding="utf-8", errors="ignore")
            exit_match = re.search(r"^exit_status:\s*(\S+)", provenance_text, re.M)
            exit_status = exit_match.group(1) if exit_match else "unknown"
            analysis = (
                yosys_log_analysis(yosys_log, exit_status)
                if yosys_log.is_file()
                else {
                    "failure_class": "missing_yosys_log",
                    "failure_stage": "unknown",
                    "timed_out_or_interrupted": False,
                    "abc9_completed": False,
                    "classic_abc_reached": False,
                    "autoname_reached": False,
                    "last_yosys_pass": None,
                    "errors": [],
                }
            )
            observed_mtime = max(
                provenance.stat().st_mtime, yosys_log.stat().st_mtime if yosys_log.is_file() else 0
            )
            newest_archived_mtime = max(newest_archived_mtime, observed_mtime)
            rows.append(
                {
                    "source": "archive",
                    "archive_dir": rel(directory),
                    "provenance": rel(provenance),
                    "yosys_log": rel(yosys_log) if yosys_log.is_file() else None,
                    "exit_status": exit_status,
                    "errors": analysis["errors"],
                    "failure_class": analysis["failure_class"],
                    "failure_stage": analysis["failure_stage"],
                    "timed_out_or_interrupted": analysis["timed_out_or_interrupted"],
                    "abc9_completed": analysis["abc9_completed"],
                    "classic_abc_reached": analysis["classic_abc_reached"],
                    "autoname_reached": analysis["autoname_reached"],
                    "last_yosys_pass": analysis["last_yosys_pass"],
                    "release_credit": False,
                    "_observed_mtime": observed_mtime,
                }
            )
    live_yosys_log = ROOT / "build/fpga/e1_demo/yosys.log"
    if live_yosys_log.is_file() and live_yosys_log.stat().st_mtime > newest_archived_mtime:
        analysis = yosys_log_analysis(live_yosys_log, "unknown")
        rows.append(
            {
                "source": "live_build_dir",
                "archive_dir": None,
                "provenance": None,
                "yosys_log": rel(live_yosys_log),
                "exit_status": "unknown",
                "errors": analysis["errors"],
                "failure_class": analysis["failure_class"],
                "failure_stage": analysis["failure_stage"],
                "timed_out_or_interrupted": analysis["timed_out_or_interrupted"],
                "abc9_completed": analysis["abc9_completed"],
                "classic_abc_reached": analysis["classic_abc_reached"],
                "autoname_reached": analysis["autoname_reached"],
                "last_yosys_pass": analysis["last_yosys_pass"],
                "release_credit": False,
                "_observed_mtime": live_yosys_log.stat().st_mtime,
            }
        )
    rows.sort(key=lambda row: row["_observed_mtime"])
    for row in rows:
        row.pop("_observed_mtime", None)
    latest = rows[-1] if rows else None
    if latest is None:
        return {
            "status": "not_run",
            "release_credit": False,
            "claim_boundary": "no non-release FPGA build probe archive found",
            "latest": None,
        }
    passed = latest["exit_status"] == "0" or latest["failure_class"] == "none"
    if latest["timed_out_or_interrupted"]:
        status = "timed_out_non_release"
    else:
        status = "passed_non_release" if passed else "failed_non_release"
    return {
        "status": status,
        "release_credit": False,
        "claim_boundary": (
            "non-release FPGA build probe only; release still requires exact board revision, "
            "final LPF, passing route/timing/pack, bitstream hash, and review"
        ),
        "latest": latest,
        "history": rows[-5:],
    }


def lpf_assignment_diagnostics(
    path: Path,
    required_ports: set[str],
    located: set[str],
    iobuf: set[str],
    has_frequency: bool,
    cfg: dict,
) -> dict:
    locate_re = re.compile(r'^\s*LOCATE\s+COMP\s+"([^"]+)"\s+SITE\s+"([^"]+)"', re.I)
    iobuf_re = re.compile(r'^\s*IOBUF\s+PORT\s+"([^"]+)"\s+(.*)', re.I)
    locates: dict[str, list[dict]] = {}
    iobufs: dict[str, list[dict]] = {}
    sites: dict[str, list[dict]] = {}

    for number, line in enumerate(path.read_text().splitlines(), start=1):
        if line.lstrip().startswith("#"):
            continue
        locate = locate_re.search(line)
        if locate:
            port, site = locate.groups()
            row = {"line": number, "port": port, "site": site}
            locates.setdefault(port, []).append(row)
            sites.setdefault(site, []).append(row)
        buf = iobuf_re.search(line)
        if buf:
            port, options = buf.groups()
            iobufs.setdefault(port, []).append(
                {"line": number, "port": port, "options": options.strip().rstrip(";")}
            )

    duplicate_locate_ports = {port: rows for port, rows in sorted(locates.items()) if len(rows) > 1}
    conflicting_locate_ports = {
        port: rows
        for port, rows in duplicate_locate_ports.items()
        if len({row["site"] for row in rows}) > 1
    }
    duplicate_iobuf_ports = {port: rows for port, rows in sorted(iobufs.items()) if len(rows) > 1}
    conflicting_iobuf_ports = {
        port: rows
        for port, rows in duplicate_iobuf_ports.items()
        if len({row["options"] for row in rows}) > 1
    }
    duplicate_sites = {
        site: rows for site, rows in sorted(sites.items()) if len({row["port"] for row in rows}) > 1
    }
    final_lpf = cfg.get("constraints", {}).get("final_lpf")
    exact_revision = cfg.get("board", {}).get("exact_revision")
    pin_source = cfg.get("constraints", {}).get("pin_assignment_source")
    lpf_complete_for_required_ports = required_ports <= located and required_ports <= iobuf
    conflict_free = not (conflicting_locate_ports or conflicting_iobuf_ports or duplicate_sites)
    return {
        "constraint_file": rel(path),
        "release_credit": False,
        "claim_boundary": (
            "LPF syntax and coverage diagnostics only; release requires exact board "
            "revision, final pin source, reviewed final LPF, and archived passing build evidence"
        ),
        "required_ports": sorted(required_ports),
        "required_port_count": len(required_ports),
        "located_required_port_count": len(required_ports & located),
        "iobuf_required_port_count": len(required_ports & iobuf),
        "missing_locate": sorted(required_ports - located),
        "missing_iobuf": sorted(required_ports - iobuf),
        "has_clk_frequency_constraint": has_frequency,
        "duplicate_locate_ports": duplicate_locate_ports,
        "conflicting_locate_ports": conflicting_locate_ports,
        "duplicate_iobuf_ports": duplicate_iobuf_ports,
        "conflicting_iobuf_ports": conflicting_iobuf_ports,
        "duplicate_sites": duplicate_sites,
        "lpf_complete_for_required_ports": lpf_complete_for_required_ports,
        "lpf_conflict_free": conflict_free,
        "non_release_build_probe_allowed": lpf_complete_for_required_ports and conflict_free,
        "release_safe_pin_assignment": False,
        "release_safe_pin_assignment_blockers": [
            blocker
            for blocker, blocked in (
                ("exact FPGA board revision is unassigned", is_unassigned(exact_revision)),
                ("final LPF path is unassigned", is_unassigned(final_lpf)),
                ("pin assignment source is unassigned", is_unassigned(pin_source)),
                (
                    "target still marks bitstream release blocked until pins are assigned",
                    cfg.get("constraints", {}).get("bitstream_release_blocked_until_pins_assigned")
                    is True,
                ),
            )
            if blocked
        ],
    }


def validate_manifest(blockers: list[str], failures: list[str]) -> dict | None:
    if not MANIFEST.is_file():
        failures.append("missing FPGA artifact manifest: board/fpga/artifact-manifest.yaml")
        return None
    manifest = yaml.safe_load(MANIFEST.read_text())
    if not isinstance(manifest, dict):
        failures.append("board/fpga/artifact-manifest.yaml must be a YAML mapping")
        return None
    if manifest.get("manifest") != "e1_demo_fpga_bitstream_evidence":
        failures.append("FPGA artifact manifest has unexpected manifest name")
    if manifest.get("release_gate") != "board_fabrication_release":
        failures.append("FPGA artifact manifest must gate board_fabrication_release")
    groups = manifest.get("artifact_groups", {})
    bitstream = groups.get("bitstream_release") if isinstance(groups, dict) else None
    if not isinstance(bitstream, dict):
        failures.append("FPGA artifact manifest missing artifact_groups.bitstream_release")
        return manifest
    commands = bitstream.get("cli_commands")
    if not isinstance(commands, dict):
        failures.append("FPGA artifact manifest bitstream_release.cli_commands must be a mapping")
    else:
        missing = sorted(REQUIRED_CLI_COMMANDS - set(commands))
        if missing:
            failures.append("FPGA artifact manifest missing CLI commands: " + ", ".join(missing))
    artifacts = bitstream.get("artifacts")
    names = (
        {artifact.get("name") for artifact in artifacts if isinstance(artifact, dict)}
        if isinstance(artifacts, list)
        else set()
    )
    for required in {
        "bitstream",
        "nextpnr_timing_report",
        "nextpnr_route_report",
        "ecppack_transcript",
        "fpga_tool_versions",
    }:
        if required not in names:
            failures.append(f"FPGA artifact manifest missing bitstream artifact: {required}")
    if manifest.get("status") != "complete":
        blockers.append(f"FPGA artifact manifest status is {manifest.get('status')}, not complete")
    for name, expected in RELEASE_COMMANDS.items():
        observed = commands.get(name) if isinstance(commands, dict) else None
        if observed and observed != expected and "TOP=e1_fpga_smoke_top" in str(observed):
            blockers.append(
                f"FPGA artifact manifest CLI command {name} targets smoke top, not e1_chip_top"
            )
    return manifest


def main() -> int:
    parser = ArgumentParser(description="Check FPGA release readiness evidence.")
    parser.add_argument(
        "--release", action="store_true", help="fail when bitstream release evidence is incomplete"
    )
    args = parser.parse_args()

    cfg = yaml.safe_load(CFG.read_text())
    failures: list[str] = []
    blockers: list[str] = []
    manifest = validate_manifest(blockers, failures)
    inventory = artifact_inventory(cfg)
    tools = tool_availability()
    build_probe = latest_non_release_build_probe()

    if cfg.get("status") != "release_ready":
        blockers.append(f"FPGA target status is {cfg.get('status')}, not release_ready")
    if cfg.get("board", {}).get("exact_revision") in {None, "", "unassigned"}:
        blockers.append("FPGA board exact_revision is unassigned")
    if cfg.get("constraints", {}).get("bitstream_release_blocked_until_pins_assigned") is True:
        blockers.append("FPGA bitstream release is explicitly blocked until pins are assigned")

    constraint = ROOT / cfg["constraints"]["skeleton_lpf"]
    widths = vector_widths_from_pinout(ROOT / "package/e1-demo-pinout.yaml")
    required_ports = expand_required(cfg, widths)
    located, iobuf, has_frequency = assigned_lpf_ports(constraint)
    pin_diagnostics = lpf_assignment_diagnostics(
        constraint, required_ports, located, iobuf, has_frequency, cfg
    )
    missing_locate = sorted(required_ports - located)
    missing_iobuf = sorted(required_ports - iobuf)
    if missing_locate:
        blockers.append(
            "FPGA LPF lacks concrete LOCATE COMP assignments for: " + ", ".join(missing_locate)
        )
    if missing_iobuf:
        blockers.append(
            "FPGA LPF lacks concrete IOBUF declarations for: " + ", ".join(missing_iobuf)
        )
    if not has_frequency:
        blockers.append('FPGA LPF lacks concrete FREQUENCY PORT "CLK_IN" constraint')
    if pin_diagnostics["conflicting_locate_ports"]:
        blockers.append(
            "FPGA LPF has conflicting duplicate LOCATE COMP assignments for: "
            + ", ".join(sorted(pin_diagnostics["conflicting_locate_ports"]))
        )
    if pin_diagnostics["conflicting_iobuf_ports"]:
        blockers.append(
            "FPGA LPF has conflicting duplicate IOBUF declarations for: "
            + ", ".join(sorted(pin_diagnostics["conflicting_iobuf_ports"]))
        )
    if pin_diagnostics["duplicate_sites"]:
        blockers.append(
            "FPGA LPF assigns the same package site to multiple ports: "
            + ", ".join(sorted(pin_diagnostics["duplicate_sites"]))
        )
    if build_probe["status"] in {"failed_non_release", "timed_out_non_release"}:
        latest_probe = build_probe.get("latest") or {}
        errors = latest_probe.get("errors") or []
        if build_probe["status"] == "timed_out_non_release":
            detail = (
                f"stage={latest_probe.get('failure_stage')} "
                f"last_yosys_pass={latest_probe.get('last_yosys_pass')} "
                f"abc9_completed={latest_probe.get('abc9_completed')}"
            )
            blockers.append(
                "FPGA non-release e1_chip_top build probe timed out/interrupted before bitstream: "
                + detail
            )
        else:
            detail = errors[-1] if errors else f"exit_status={latest_probe.get('exit_status')}"
            blockers.append(
                f"FPGA non-release e1_chip_top build probe failed before bitstream: {detail}"
            )

    for label, status in inventory.items():
        if status["missing"]:
            blockers.append(f"missing FPGA release evidence: {label}")
    for tool, data in tools.items():
        if data["required_for_release"] and not data["available"]:
            blockers.append(f"FPGA tool unavailable: {tool}")

    if failures:
        write_report(
            "fail", failures, args.release, cfg, inventory, manifest, pin_diagnostics, build_probe
        )
        print("FPGA release manifest check failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    if blockers:
        write_report(
            "blocked",
            blockers,
            args.release,
            cfg,
            inventory,
            manifest,
            pin_diagnostics,
            build_probe,
        )
        print("STATUS: BLOCKED FPGA release check")
        print("FPGA release check failed:" if args.release else "FPGA release blockers:")
        for blocker in blockers:
            print(f"  - {blocker}")
        return 2 if args.release else 0

    write_report("pass", [], args.release, cfg, inventory, manifest, pin_diagnostics, build_probe)
    print("FPGA release check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
