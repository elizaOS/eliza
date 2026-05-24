#!/usr/bin/env python3
"""Generate fail-closed KiCad CLI evidence for the e1-demo board.

The generated files are diagnostic only. They document the exact command
families and local tool availability, but they do not replace ERC, DRC,
Gerber, drill, BOM, placement, fab drawing, or DFM release evidence.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import yaml
from check_kicad_artifacts import (
    MANIFEST as KICAD_MANIFEST_REL,
)
from check_kicad_artifacts import (
    REQUIRED_RELEASE_EVIDENCE,
    command_for_label,
    load_manifest_commands,
    release_evidence_inventory,
    target_status_promotion_contract,
)

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "board/kicad/e1-demo/artifact-manifest.yaml"
OUT_DIR = ROOT / "board/reports/fab/e1-demo-2026-05-17"
TRANSCRIPT = OUT_DIR / "e1-demo-kicad-command-transcript.txt"
TOOL_VERSION = OUT_DIR / "e1-demo-kicad-tool-version.txt"
DIAGNOSTICS = OUT_DIR / "e1-demo-kicad-blocked-diagnostics.json"
LOCAL_TMP_KICAD10_APPIMAGE_CLI = Path("/tmp/eliza-kicad-10/extract/AppDir/bin/kicad-cli")
SOURCE_GLOBS = {
    "project": ["*.kicad_pro"],
    "schematic": ["*.kicad_sch"],
    "pcb": ["*.kicad_pcb"],
    "symbol_or_footprint_library": ["*.kicad_sym", "**/*.kicad_sym", "**/*.pretty/*.kicad_mod"],
}


def load_commands() -> dict[str, str]:
    manifest = yaml.safe_load(MANIFEST.read_text(encoding="utf-8"))
    groups = manifest.get("artifact_groups", {})
    cli_group = groups.get("kicad_cli_outputs", {})
    commands = cli_group.get("cli_commands", {})
    if not isinstance(commands, dict):
        raise SystemExit(f"{MANIFEST}: missing kicad_cli_outputs.cli_commands")
    return {str(key): str(value) for key, value in sorted(commands.items())}


def kicad_version() -> tuple[bool, str, str | None, str | None]:
    path_tool = shutil.which("kicad-cli")
    candidates: list[tuple[str, str]] = []
    if path_tool is not None:
        candidates.append(("PATH", path_tool))
    if LOCAL_TMP_KICAD10_APPIMAGE_CLI.is_file():
        candidates.append(("local_tmp_appimage", LOCAL_TMP_KICAD10_APPIMAGE_CLI.as_posix()))
    if not candidates:
        return (
            False,
            "kicad-cli not found on PATH or local KiCad 10 AppImage extraction",
            None,
            None,
        )
    source, tool = candidates[0]
    completed = subprocess.run(
        [tool, "version"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    output = (completed.stdout or "").strip()
    return (
        completed.returncode == 0,
        output or f"kicad-cli version exited {completed.returncode}",
        tool,
        source,
    )


def source_inventory() -> dict[str, dict[str, object]]:
    board_dir = ROOT / "board/kicad/e1-demo"
    inventory: dict[str, dict[str, object]] = {}
    for label, patterns in SOURCE_GLOBS.items():
        found = sorted(
            {path for pattern in patterns for path in board_dir.glob(pattern) if path.is_file()}
        )
        inventory[label] = {
            "present": bool(found),
            "paths": [path.relative_to(ROOT).as_posix() for path in found],
            "expected_globs": [f"board/kicad/e1-demo/{pattern}" for pattern in patterns],
        }
    return inventory


def artifact_output_expectations(
    commands: dict[str, str],
) -> list[dict[str, object]]:
    inventory = release_evidence_inventory()
    expectations: list[dict[str, object]] = []
    for label, patterns in REQUIRED_RELEASE_EVIDENCE.items():
        command = command_for_label(label, commands)
        evidence = inventory[label]
        expectations.append(
            {
                "label": label,
                "source_manifest": KICAD_MANIFEST_REL,
                "generation_command": command,
                "expected_command_output": {
                    "accepted_exit_code": 0,
                    "accepted_stdout_or_file_content": (
                        "Clean/reviewable output for this artifact class; ERC/DRC "
                        "must show zero release-blocking errors where applicable."
                    ),
                },
                "expected_globs": patterns,
                "accepted_artifact_paths": evidence["release_credit_paths"],
                "diagnostic_only_paths": evidence["diagnostic_only_paths"],
                "release_credit": False,
                "claim_boundary": "expected output contract only; current paths do not grant release credit from this diagnostic generator",
            }
        )
    return expectations


def promotion_contract_lines(contract: dict[str, object]) -> list[str]:
    lines = [
        "target_status_promotion_contract:",
        f"  status: {contract['status']}",
        "  release_credit: false",
        f"  next_action_id: {contract['next_action_id']}",
        "  source_manifests: ["
        + ", ".join(str(item) for item in contract["source_manifests"])
        + "]",
        f"  current_manifest_status: {contract['current_manifest_status']}",
        f"  required_manifest_status: {contract['required_manifest_status']}",
        f"  blocked_count: {contract['blocked_count']}",
        "  blocked_criteria: ["
        + ", ".join(str(item) for item in contract["blocked_criteria"])
        + "]",
        "  criteria:",
    ]
    for criterion in contract["criteria"]:
        lines.extend(
            [
                f"    - id: {criterion['id']}",
                f"      field: {criterion['field']}",
                f"      status: {criterion['status']}",
                f"      required_value: {criterion['required_value']}",
                f"      current_value: {criterion['current_value']}",
                f"      evidence_required: {criterion['evidence_required']}",
                "      release_credit: false",
            ]
        )
        paths = criterion.get("accepted_artifact_paths")
        if paths is not None:
            lines.append(
                "      accepted_artifact_paths: [" + ", ".join(str(item) for item in paths) + "]"
            )
        output = criterion.get("expected_command_output")
        if isinstance(output, dict):
            lines.extend(
                [
                    "      expected_command_output:",
                    f"        command: {output.get('command')}",
                    f"        accepted_exit_code: {output.get('accepted_exit_code')}",
                    f"        accepted_output: {output.get('accepted_output') or output.get('accepted_stdout_or_file_content')}",
                ]
            )
    lines.append(f"  next_step: {contract['next_step']}")
    return lines


def main() -> int:
    commands = load_commands()
    manifest_commands = load_manifest_commands()
    available, version_text, tool_path, tool_source = kicad_version()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    TOOL_VERSION.write_text(
        "\n".join(
            [
                "schema: eliza.e1_demo_kicad_tool_availability.v1",
                "status: blocked_tool_unavailable"
                if not available
                else "status: tool_available_not_release_evidence",
                "release_credit: false",
                "tool: kicad-cli",
                f"availability: {'present' if available else 'missing'}",
                f"tool_path: {tool_path or 'unavailable'}",
                f"tool_source: {tool_source or 'unavailable'}",
                f"version_output: {version_text}",
                "claim_boundary: diagnostic tool availability only; not ERC/DRC/fabrication release evidence",
                "",
            ]
        ),
        encoding="utf-8",
    )

    lines = [
        "schema: eliza.e1_demo_kicad_command_transcript.v1",
        "status: blocked_not_executed"
        if not available
        else "status: commands_declared_not_release_evidence",
        "release_credit: false",
        "claim_boundary: command-family capture only; outputs still require successful KiCad CLI execution and review",
        f"tool_availability: {'present' if available else 'missing'}",
        f"tool_path: {tool_path or 'unavailable'}",
        f"tool_source: {tool_source or 'unavailable'}",
        f"tool_version_file: {TOOL_VERSION.relative_to(ROOT).as_posix()}",
        f"source_manifest: {MANIFEST.relative_to(ROOT).as_posix()}",
        "release_gate_command: python3 scripts/check_kicad_artifacts.py --release",
        "manifest_release_gate_command: python3 scripts/check_manufacturing_artifacts.py --manifest board/kicad/e1-demo/artifact-manifest.yaml --release",
        *promotion_contract_lines(target_status_promotion_contract(release_evidence_inventory())),
        "commands:",
    ]
    for name, command in commands.items():
        lines.extend(
            [
                f"  - name: {name}",
                f"    command: {command}",
                "    executed: false",
                "    accepted_exit_code: 0",
                "    result: blocked_tool_unavailable"
                if not available
                else "    result: not_run_by_diagnostic_generator",
                "    release_credit: false",
            ]
        )
    lines.append("")
    TRANSCRIPT.write_text("\n".join(lines), encoding="utf-8")
    diagnostics = {
        "schema": "eliza.e1_demo_kicad_blocked_diagnostics.v1",
        "status": "blocked_tool_unavailable" if not available else "tool_available_not_executed",
        "release_credit": False,
        "claim_boundary": "diagnostic inventory only; not ERC/DRC/Gerber/drill/BOM/placement/fab drawing release evidence",
        "tool_availability": {
            "tool": "kicad-cli",
            "available": available,
            "path": tool_path,
            "source": tool_source,
            "version_output": version_text,
        },
        "source_manifests": [
            {
                "path": MANIFEST.relative_to(ROOT).as_posix(),
                "manifest_id": "e1_demo_kicad_board_evidence",
                "release_gate": "board_fabrication_release",
                "release_credit": False,
            }
        ],
        "source_inventory": source_inventory(),
        "commands": [
            {
                "name": name,
                "command": command,
                "executed": False,
                "accepted_exit_code": 0,
                "result": "blocked_tool_unavailable"
                if not available
                else "not_run_by_diagnostic_generator",
                "source_manifest": MANIFEST.relative_to(ROOT).as_posix(),
                "release_credit": False,
            }
            for name, command in commands.items()
        ],
        "expected_command_outputs": artifact_output_expectations(manifest_commands),
        "target_status_promotion_contract": target_status_promotion_contract(
            release_evidence_inventory()
        ),
        "required_release_outputs": {
            "erc": "board/reports/fab/e1-demo-2026-05-17/e1-demo-erc-report.txt",
            "drc": "board/reports/fab/e1-demo-2026-05-17/e1-demo-drc-report.txt",
            "gerbers": "board/reports/fab/e1-demo-2026-05-17/gerbers/*.gbr",
            "drill": "board/reports/fab/e1-demo-2026-05-17/drill/*.drl",
            "bom": "board/reports/fab/e1-demo-2026-05-17/e1-demo-bom.csv",
            "position": "board/reports/fab/e1-demo-2026-05-17/e1-demo-position.csv",
            "fab_drawing": "board/reports/fab/e1-demo-2026-05-17/pdf/e1-demo-fab-drawing.pdf",
        },
    }
    DIAGNOSTICS.write_text(
        json.dumps(diagnostics, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    print("STATUS: BLOCKED e1-demo KiCad CLI diagnostic evidence generated release_credit=false")
    print(TRANSCRIPT.relative_to(ROOT).as_posix())
    print(TOOL_VERSION.relative_to(ROOT).as_posix())
    print(DIAGNOSTICS.relative_to(ROOT).as_posix())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
