#!/usr/bin/env python3
"""Generate fail-closed FPGA CLI diagnostics for the e1-demo target.

The generated files are diagnostic only. They document command families and
local tool availability, but they do not replace bitstream, timing, route,
pack, final LPF, board revision, or release approval evidence.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import yaml

from check_fpga_release import (
    CFG,
    ROOT as CHECK_ROOT,
    assigned_lpf_ports,
    bounded_synthesis_diagnostics,
    expand_required,
    latest_non_release_build_probe,
    lpf_assignment_diagnostics,
    manifest_artifact_glob_audit,
    pin_board_revision_handoff_contract,
    release_artifact_requirements,
    release_evidence_archive_contract,
    target_status_promotion_contract,
    artifact_inventory,
    vector_widths_from_pinout,
)


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "board/fpga/artifact-manifest.yaml"
OUT_DIR = ROOT / "board/fpga/reports/diagnostics"
TRANSCRIPT = OUT_DIR / "e1-demo-fpga-command-transcript.txt"
TOOL_AVAILABILITY = OUT_DIR / "e1-demo-fpga-tool-availability.txt"
TOOLS = ("yosys", "nextpnr-ecp5", "ecppack", "openFPGALoader")
RELEASE_REQUIRED_TOOLS = {"yosys", "nextpnr-ecp5", "ecppack"}
LOCAL_TOOL_DIRS = (ROOT / "external/oss-cad-suite/bin",)
RELEASE_COMMANDS = {
    "tool_versions": "yosys -V && nextpnr-ecp5 --version && ecppack --version && openFPGALoader --version",
    "synth": "TOP=e1_chip_top make -C board/fpga synth",
    "place_route": "TOP=e1_chip_top make -C board/fpga pnr",
    "pack": "TOP=e1_chip_top make -C board/fpga pack",
    "report": "TOP=e1_chip_top make -C board/fpga report",
    "hash_bitstream": "shasum -a 256 build/fpga/e1_demo/e1_chip_top.bit",
}


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def load_commands() -> dict[str, str]:
    manifest = yaml.safe_load(MANIFEST.read_text(encoding="utf-8"))
    groups = manifest.get("artifact_groups", {})
    bitstream = groups.get("bitstream_release", {})
    commands = bitstream.get("cli_commands", {})
    if not isinstance(commands, dict):
        raise SystemExit(f"{MANIFEST}: missing bitstream_release.cli_commands")
    return {str(key): str(value) for key, value in sorted(commands.items())}


def resolve_tool(tool: str) -> tuple[str | None, str]:
    for directory in LOCAL_TOOL_DIRS:
        candidate = directory / tool
        if candidate.is_file():
            return str(candidate), "repo_local_oss_cad_suite"
    path = shutil.which(tool)
    if path:
        return path, "path"
    return None, "missing"


def tool_version(tool: str) -> tuple[bool, str, str, str]:
    path, source = resolve_tool(tool)
    if path is None:
        return False, "", source, f"{tool} not found in external/oss-cad-suite/bin or PATH"
    args = [path, "-V"] if tool == "yosys" else [path, "--version"]
    completed = subprocess.run(
        args,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    output = (completed.stdout or "").strip().splitlines()
    version_text = output[0] if output else f"{tool} version exited {completed.returncode}"
    return completed.returncode == 0, path, source, version_text


def latest_build_probe_lines() -> list[str]:
    probe = latest_non_release_build_probe()
    latest = probe.get("latest")
    if latest is None:
        return [
            "latest_non_release_build_probe:",
            "  status: not_run",
            "  release_credit: false",
        ]

    return [
        "latest_non_release_build_probe:",
        f"  status: {probe['status']}",
        "  release_credit: false",
        f"  source: {latest.get('source')}",
        f"  archive_dir: {latest.get('archive_dir') or 'not_archived'}",
        f"  provenance: {latest.get('provenance') or 'not_archived'}",
        f"  yosys_log: {latest.get('yosys_log') or 'missing'}",
        f"  exit_status: {latest.get('exit_status')}",
        f"  failure_class: {latest.get('failure_class')}",
        f"  failure_stage: {latest.get('failure_stage')}",
        f"  timed_out_or_interrupted: {str(latest.get('timed_out_or_interrupted')).lower()}",
        f"  abc9_completed: {str(latest.get('abc9_completed')).lower()}",
        f"  autoname_reached: {str(latest.get('autoname_reached')).lower()}",
        f"  last_yosys_pass: {latest.get('last_yosys_pass') or 'unknown'}",
        f"  latest_error: {(latest.get('errors') or ['none'])[-1]}",
    ]


def bounded_synthesis_diagnostic_lines() -> list[str]:
    lines = ["bounded_synthesis_diagnostics:"]
    for diagnostic in bounded_synthesis_diagnostics():
        markers = diagnostic.get("runtime_markers", {})
        profile = diagnostic.get("profile_summary", {})
        largest = profile.get("largest_modules_by_cells") or []
        memory_pressure = profile.get("memory_rom_synthesis_pressure", {})
        pressure_modules = memory_pressure.get("modules") or []
        next_actions = memory_pressure.get("next_actions") or []
        top_pressure = pressure_modules[0] if pressure_modules else {}
        lines.extend(
            [
                f"  - id: {diagnostic['id']}",
                f"    status: {diagnostic['status']}",
                "    release_credit: false",
                f"    log: {diagnostic['log']}",
                f"    diagnostic_goal: {diagnostic.get('diagnostic_goal') or 'not_specified'}",
                f"    failure_class: {diagnostic.get('failure_class', 'not_run')}",
                f"    failure_stage: {diagnostic.get('failure_stage', 'not_run')}",
                f"    last_yosys_pass: {diagnostic.get('last_yosys_pass') or 'unknown'}",
                f"    max_hashed_cells: {markers.get('max_hashed_cells') or 'unknown'}",
                f"    profile_completed_stat: {str(profile.get('completed_stat', False)).lower()}",
                f"    profile_largest_module: {largest[0]['module'] if largest else 'unknown'}",
                f"    memory_rom_pressure_top_module: {top_pressure.get('module', 'unknown')}",
                f"    memory_rom_pressure_top_cells: {top_pressure.get('cells_including_submodules', 'unknown')}",
                f"    memory_replaced_with_registers_count: {memory_pressure.get('memory_replaced_with_registers_count', 'unknown')}",
                f"    meminit_v2_cells: {memory_pressure.get('meminit_v2_cells', 'unknown')}",
                "    memory_rom_next_actions:",
            ]
        )
        if next_actions:
            for action in next_actions:
                lines.extend(
                    [
                        f"      - action_id: {action.get('action_id', 'unknown')}",
                        f"        module: {action.get('module', 'unknown')}",
                        f"        priority: {action.get('priority', 'unknown')}",
                        f"        task_type: {action.get('task_type', 'unknown')}",
                        f"        release_credit: {str(action.get('release_credit', False)).lower()}",
                        f"        remediation_target: {action.get('remediation_target', 'unknown')}",
                        f"        acceptance_check: {action.get('acceptance_check', 'unknown')}",
                    ]
                )
        else:
            lines.append("      []")
        lines.append(f"    exact_command: {diagnostic['exact_command']}")
    return lines


def pin_board_revision_handoff_lines() -> list[str]:
    cfg = yaml.safe_load(CFG.read_text(encoding="utf-8"))
    constraint = CHECK_ROOT / cfg["constraints"]["skeleton_lpf"]
    widths = vector_widths_from_pinout(CHECK_ROOT / "package/e1-demo-pinout.yaml")
    required_ports = expand_required(cfg, widths)
    located, iobuf, has_frequency = assigned_lpf_ports(constraint)
    diagnostics = lpf_assignment_diagnostics(
        constraint, required_ports, located, iobuf, has_frequency, cfg
    )
    contract = pin_board_revision_handoff_contract(cfg, diagnostics)
    lines = [
        "pin_board_revision_handoff_contract:",
        "  release_credit: false",
        f"  next_action_id: {contract['next_action_id']}",
        f"  current_target: {contract['current_target']}",
        f"  current_board_class: {contract['current_board_class']}",
        "  required_fields:",
    ]
    for field in contract["required_fields"]:
        lines.extend(
            [
                f"    - field: {field['field']}",
                f"      status: {field['status']}",
                f"      current_value: {field['current_value']}",
                f"      required_evidence: {field['required_evidence']}",
            ]
        )
    summary = contract["pin_diagnostic_summary"]
    lines.extend(
        [
            "  pin_diagnostic_summary:",
            f"    constraint_file: {summary['constraint_file']}",
            f"    required_port_count: {summary['required_port_count']}",
            f"    located_required_port_count: {summary['located_required_port_count']}",
            f"    iobuf_required_port_count: {summary['iobuf_required_port_count']}",
            f"    lpf_complete_for_required_ports: {str(summary['lpf_complete_for_required_ports']).lower()}",
            f"    lpf_conflict_free: {str(summary['lpf_conflict_free']).lower()}",
            f"    release_safe_pin_assignment: {str(summary['release_safe_pin_assignment']).lower()}",
            "  bounded_validation_commands:",
        ]
    )
    for command in contract["bounded_validation_commands"]:
        lines.append(f"    - {command}")
    lines.append(f"  next_step: {contract['next_step']}")
    return lines


def target_status_promotion_contract_lines() -> list[str]:
    cfg = yaml.safe_load(CFG.read_text(encoding="utf-8"))
    manifest = yaml.safe_load(MANIFEST.read_text(encoding="utf-8"))
    constraint = CHECK_ROOT / cfg["constraints"]["skeleton_lpf"]
    widths = vector_widths_from_pinout(CHECK_ROOT / "package/e1-demo-pinout.yaml")
    required_ports = expand_required(cfg, widths)
    located, iobuf, has_frequency = assigned_lpf_ports(constraint)
    diagnostics = lpf_assignment_diagnostics(
        constraint, required_ports, located, iobuf, has_frequency, cfg
    )
    contract = target_status_promotion_contract(
        cfg, manifest, artifact_inventory(cfg), diagnostics, latest_non_release_build_probe()
    )
    lines = [
        "target_status_promotion_contract:",
        f"  status: {contract['status']}",
        "  release_credit: false",
        f"  next_action_id: {contract['next_action_id']}",
        f"  current_target_status: {contract['current_target_status']}",
        f"  required_target_status: {contract['required_target_status']}",
        "  source_manifests: ["
        + ", ".join(contract["source_manifests"])
        + "]",
        f"  blocked_count: {contract['blocked_count']}",
        "  blocked_criteria: ["
        + ", ".join(contract["blocked_criteria"])
        + "]",
        "  criteria:",
    ]
    for criterion in contract["criteria"]:
        lines.extend(
            [
                f"    - id: {criterion['id']}",
                f"      field: {criterion['field']}",
                f"      status: {criterion['status']}",
                f"      current_value: {criterion['current_value']}",
                f"      required_value: {criterion['required_value']}",
                f"      evidence_required: {criterion['evidence_required']}",
                f"      source_manifest: {criterion['source_manifest']}",
                "      accepted_artifact_paths: ["
                + ", ".join(str(path) for path in criterion["accepted_artifact_paths"])
                + "]",
                "      expected_command_output:",
                f"        command: {criterion['expected_command_output']['command']}",
                f"        accepted_exit_code: {criterion['expected_command_output']['accepted_exit_code']}",
                f"        accepted_output: {criterion['expected_command_output']['accepted_output']}",
                "      release_credit: false",
            ]
        )
    lines.append(f"  next_step: {contract['next_step']}")
    return lines


def release_artifact_requirement_lines() -> list[str]:
    cfg = yaml.safe_load(CFG.read_text(encoding="utf-8"))
    requirements = release_artifact_requirements(artifact_inventory(cfg))
    lines = [
        "release_artifact_requirements:",
        "  release_credit: false",
        "  source_manifest: board/fpga/artifact-manifest.yaml",
        "  artifacts:",
    ]
    for label, requirement in requirements.items():
        output = requirement["expected_command_output"]
        lines.extend(
            [
                f"    - label: {label}",
                f"      source_manifest: {requirement['source_manifest']}",
                f"      unblock_command: {requirement['unblock_command']}",
                "      expected_command_output:",
                f"        command: {output['command']}",
                f"        accepted_exit_code: {output['accepted_exit_code']}",
                f"        accepted_output: {output['accepted_output']}",
                "      accepted_artifact_paths: ["
                + ", ".join(requirement["accepted_artifact_paths"])
                + "]",
                "      expected_globs: ["
                + ", ".join(requirement["patterns"])
                + "]",
                f"      missing: {str(requirement['missing']).lower()}",
                "      release_credit: false",
            ]
        )
    return lines


def manifest_artifact_glob_audit_lines() -> list[str]:
    manifest = yaml.safe_load(MANIFEST.read_text(encoding="utf-8"))
    audit = manifest_artifact_glob_audit(manifest)
    lines = [
        "manifest_artifact_glob_audit:",
        f"  status: {audit['status']}",
        "  release_credit: false",
        f"  next_action_id: {audit['next_action_id']}",
        "  blocked_artifacts: ["
        + ", ".join(audit["blocked_artifacts"])
        + "]",
        "  artifacts:",
    ]
    for artifact in audit["artifacts"]:
        lines.extend(
            [
                f"    - name: {artifact['name']}",
                f"      missing_release_glob: {str(artifact['missing_release_glob']).lower()}",
                "      diagnostic_only_globs: ["
                + ", ".join(artifact["diagnostic_only_globs"])
                + "]",
                "      release_globs: [" + ", ".join(artifact["release_globs"]) + "]",
            ]
        )
    lines.append(f"  next_step: {audit['next_step']}")
    return lines


def release_evidence_archive_contract_lines() -> list[str]:
    cfg = yaml.safe_load(CFG.read_text(encoding="utf-8"))
    contract = release_evidence_archive_contract(cfg, artifact_inventory(cfg))
    lines = [
        "release_evidence_archive_contract:",
        f"  status: {contract['status']}",
        "  release_credit: false",
        f"  next_action_id: {contract['next_action_id']}",
        "  blocked_preconditions: ["
        + ", ".join(contract["blocked_preconditions"])
        + "]",
        "  blocked_fields: ["
        + ", ".join(contract["blocked_fields"])
        + "]",
        "  required_fields:",
    ]
    for field in contract["required_fields"]:
        lines.extend(
            [
                f"    - field: {field['field']}",
                f"      status: {field['status']}",
                f"      artifact: {field['artifact']}",
                f"      expected_path_pattern: {field['expected_path_pattern']}",
                f"      producer_command: {field['producer_command']}",
                f"      validation_command: {field['validation_command']}",
                f"      artifact_missing: {str(field['artifact_missing']).lower()}",
                "      release_credit: false",
            ]
        )
    lines.append(f"  next_step: {contract['next_step']}")
    return lines


def main() -> int:
    commands = load_commands()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    tool_rows = []
    missing_tools = []
    for tool in TOOLS:
        available, path, source, version = tool_version(tool)
        if not available and tool in RELEASE_REQUIRED_TOOLS:
            missing_tools.append(tool)
        tool_rows.append((tool, available, path, source, version, tool in RELEASE_REQUIRED_TOOLS))

    TOOL_AVAILABILITY.write_text(
        "\n".join(
            [
                "schema: eliza.e1_demo_fpga_tool_availability.v1",
                "status: blocked_tool_unavailable" if missing_tools else "status: tools_available_not_release_evidence",
                "release_credit: false",
                "claim_boundary: tool availability only; not release evidence; not bitstream, timing, route, pack, final LPF, or board fabrication release evidence",
                "tools:",
                *[
                    "\n".join(
                        [
                            f"  - name: {tool}",
                            f"    availability: {'present' if available else 'missing'}",
                            f"    path: {path or 'unavailable'}",
                            f"    source: {source}",
                            f"    required_for_release: {'true' if required else 'false'}",
                            f"    version_output: {version}",
                            "    release_credit: false",
                        ]
                    )
                    for tool, available, path, source, version, required in tool_rows
                ],
                "missing_required_tools: [" + ", ".join(missing_tools) + "]",
                "optional_programming_tools_missing: ["
                + ", ".join(
                    tool
                    for tool, available, _path, _source, _version, required in tool_rows
                    if not available and not required
                )
                + "]",
                "next_unblock_action: Use packages/chip/external/oss-cad-suite/bin or source scripts/env_oss_cad_suite.sh, then run the e1_chip_top release commands.",
                "",
            ]
        ),
        encoding="utf-8",
    )

    lines = [
        "schema: eliza.e1_demo_fpga_command_transcript.v1",
        "status: blocked_not_executed",
        "release_credit: false",
        "claim_boundary: command-family capture only; not release evidence; outputs still require successful FPGA tool execution and review",
        f"tool_availability_file: {TOOL_AVAILABILITY.relative_to(ROOT).as_posix()}",
        "required_release_top: e1_chip_top",
        "release_artifacts_required: bitstream, nextpnr timing report, nextpnr route report, ecppack transcript, FPGA tool versions",
        "source_manifests: [board/fpga/e1_demo_fpga.yaml, board/fpga/artifact-manifest.yaml]",
        "exact_toolchain_command: source scripts/env_oss_cad_suite.sh",
        "exact_non_release_probe_command: python3 scripts/run_with_timeout.py --timeout-seconds 900 --label fpga-e1-chip-top-nonrelease-build -- bash -lc './scripts/fpga/build_e1_demo.sh'",
        "exact_release_gate_command: python3 scripts/check_fpga_release.py --release",
        *latest_build_probe_lines(),
        *bounded_synthesis_diagnostic_lines(),
        *pin_board_revision_handoff_lines(),
        *target_status_promotion_contract_lines(),
        *release_artifact_requirement_lines(),
        *manifest_artifact_glob_audit_lines(),
        *release_evidence_archive_contract_lines(),
        "release_commands:",
    ]
    for name, command in RELEASE_COMMANDS.items():
        lines.extend(
            [
                f"  - name: {name}",
                f"    command: {command}",
                "    executed: false",
                "    release_credit: false",
            ]
        )
    lines.append("manifest_commands:")
    for name, command in commands.items():
        lines.extend(
            [
                f"  - name: {name}",
                f"    command: {command}",
                "    executed: false",
                "    result: diagnostic_manifest_command_only_not_release_evidence",
            ]
        )
    lines.append("")
    TRANSCRIPT.write_text("\n".join(lines), encoding="utf-8")

    print("STATUS: BLOCKED e1-demo FPGA CLI diagnostic evidence generated release_credit=false")
    print(TRANSCRIPT.relative_to(ROOT).as_posix())
    print(TOOL_AVAILABILITY.relative_to(ROOT).as_posix())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
