#!/usr/bin/env python3
import json
import os
import re
import shutil
import subprocess
import sys
from argparse import ArgumentParser
from pathlib import Path
from typing import cast

import yaml

ROOT = Path(__file__).resolve().parents[1]
BOARD_DIR = ROOT / "board/kicad/e1-demo"
BOARD_DOC_DIR = ROOT / "docs/board/kicad/e1-demo"
COMMAND_DOC = ROOT / "docs/board/kicad/e1-demo-commands.md"
REPORT_DIR = ROOT / "board/reports/fab"
MANIFEST = "board/kicad/e1-demo/artifact-manifest.yaml"
PRINTABLE_SOURCE_LABELS = {"project", "schematic", "pcb"}
REPORT = ROOT / "build/reports/kicad_artifacts.json"
REPORT_SCHEMA = "eliza.kicad_artifacts.v1"
LOCAL_TMP_KICAD_CLI = Path("/tmp/eliza-kicad-cli-check/root/usr/bin/kicad-cli")
LOCAL_TMP_KICAD_LIB = Path("/tmp/eliza-kicad-cli-check/root/usr/lib/x86_64-linux-gnu")
LOCAL_TMP_KICAD10_APPIMAGE_CLI = Path("/tmp/eliza-kicad-10/extract/AppDir/bin/kicad-cli")

REQUIRED_PROJECT_GLOBS = {
    "project": ["*.kicad_pro"],
    "schematic": ["*.kicad_sch"],
    "pcb": ["*.kicad_pcb"],
    "symbol/footprint library": ["*.kicad_sym", "**/*.kicad_sym", "**/*.pretty/*.kicad_mod"],
}

REQUIRED_RELEASE_EVIDENCE = {
    "erc transcript": ["**/*erc*.txt", "**/*erc*.log", "**/*erc*.rpt"],
    "drc transcript": ["**/*drc*.txt", "**/*drc*.log", "**/*drc*.rpt"],
    "gerber output": [
        "**/*.gbr",
        "**/*.gbrjob",
        "**/*.gtl",
        "**/*.gbl",
        "**/*.gto",
        "**/*.gbo",
        "**/*.gts",
        "**/*.gbs",
        "**/*.gm1",
    ],
    "drill output": ["**/*.drl", "**/*.xln"],
    "bom output": ["**/*bom*.csv", "**/*bom*.tsv", "**/*bom*.xml"],
    "position output": ["**/*pos*.csv", "**/*position*.csv", "**/*.pos"],
    "fab drawing": ["**/*fab*drawing*.pdf", "**/*fabrication*drawing*.pdf"],
    "command transcript": ["**/*command*transcript*.txt", "**/*kicad*transcript*.txt"],
    "KiCad tool versions": ["**/*tool*version*.txt", "**/*kicad*version*.txt"],
}

EVIDENCE_COMMANDS = {
    "erc transcript": "erc",
    "drc transcript": "drc",
    "gerber output": "gerbers",
    "drill output": "drill",
    "bom output": "bom",
    "position output": "position",
    "fab drawing": "fab_drawing",
}

KICAD7_PARTIAL_COMMANDS = {
    "gerber output": (
        "kicad-cli pcb export gerbers --output board/reports/fab/e1-demo-2026-05-17/gerbers "
        "--layers F.Cu,B.Cu,F.SilkS,B.SilkS,F.Mask,B.Mask,Edge.Cuts "
        "board/kicad/e1-demo/e1-demo.kicad_pcb"
    ),
    "drill output": (
        "kicad-cli pcb export drill board/kicad/e1-demo/e1-demo.kicad_pcb "
        "--output board/reports/fab/e1-demo-2026-05-17/drill/"
    ),
    "bom output": (
        "kicad-cli sch export python-bom --output "
        "board/reports/fab/e1-demo-2026-05-17/e1-demo-bom.xml "
        "board/kicad/e1-demo/e1-demo.kicad_sch"
    ),
    "position output": (
        "kicad-cli pcb export pos --output board/reports/fab/e1-demo-2026-05-17/e1-demo-position.csv "
        "--format csv --units mm board/kicad/e1-demo/e1-demo.kicad_pcb"
    ),
    "fab drawing": (
        "kicad-cli pcb export pdf --output board/reports/fab/e1-demo-2026-05-17/pdf/e1-demo-fab-drawing.pdf "
        "--layers F.Cu,B.Cu,Edge.Cuts --include-border-title --black-and-white "
        "board/kicad/e1-demo/e1-demo.kicad_pcb"
    ),
}

LOCAL_TMP_UNBLOCK_COMMANDS = [
    "mkdir -p /tmp/eliza-kicad-cli-check && cd /tmp/eliza-kicad-cli-check",
    (
        "apt-get download kicad libwxbase3.2-1t64 libwxgtk3.2-1t64 libwxgtk-gl3.2-1t64 "
        "libngspice0 libglew2.2 libglu1-mesa libocct-data-exchange-7.6t64 "
        "libocct-foundation-7.6t64 libocct-modeling-algorithms-7.6t64 "
        "libocct-modeling-data-7.6t64 libocct-ocaf-7.6t64 libocct-visualization-7.6t64 "
        "libodbc2 libfreeimage3 libjxr0t64 xsltproc"
    ),
    'mkdir -p root && for deb in *.deb; do dpkg-deb -x "$deb" root; done',
    (
        "PATH=/tmp/eliza-kicad-cli-check/root/usr/bin:$PATH "
        "LD_LIBRARY_PATH=/tmp/eliza-kicad-cli-check/root/usr/lib/x86_64-linux-gnu "
        "kicad-cli version"
    ),
]

REQUIRED_FAB_NOTE_MARKERS = {
    "release_status": "Release status: `blocked`",
    "fabrication_release": "Fabrication release: `prohibited`",
    "release_credit": "Release credit: `none`",
    "foundry_approval": "Foundry approval: `missing`",
    "package_vendor_approval": "Package-vendor land-pattern approval: `missing`",
    "assembly_dfm_approval": "Assembly-house DFM approval: `missing`",
    "enclosure_fit_approval": "Enclosure mechanical fit approval",
}


def matches(base: Path, patterns: list[str]) -> list[Path]:
    found: list[Path] = []
    if base.is_dir():
        for pattern in patterns:
            found.extend(path for path in base.glob(pattern) if path.is_file())
    return sorted(set(found))


def run_manifest_check(release: bool) -> subprocess.CompletedProcess[str]:
    manifest_args = [
        sys.executable,
        "scripts/check_manufacturing_artifacts.py",
        "--manifest",
        MANIFEST,
    ]
    if release:
        manifest_args.append("--release")
    return subprocess.run(manifest_args, cwd=ROOT, capture_output=True, text=True)


def append_process_output(
    prefix: str, proc: subprocess.CompletedProcess[str], lines: list[str]
) -> None:
    if proc.stdout:
        lines.extend(f"{prefix}: {line}" for line in proc.stdout.rstrip().splitlines())
    if proc.stderr:
        lines.extend(f"{prefix} stderr: {line}" for line in proc.stderr.rstrip().splitlines())


def check_command_doc_staleness(failures: list[str], blockers: list[str]) -> None:
    if not COMMAND_DOC.is_file():
        failures.append("missing docs/board/kicad/e1-demo-commands.md")
        return
    text = COMMAND_DOC.read_text(errors="ignore")
    has_project = bool(matches(BOARD_DIR, REQUIRED_PROJECT_GLOBS["project"]))
    has_schematic = bool(matches(BOARD_DIR, REQUIRED_PROJECT_GLOBS["schematic"]))
    has_pcb = bool(matches(BOARD_DIR, REQUIRED_PROJECT_GLOBS["pcb"]))
    if has_project and has_schematic and has_pcb:
        stale_phrases = [
            "No KiCad project is currently checked in",
            "once a real `board/kicad/e1-demo/*.kicad_pro`",
        ]
        for phrase in stale_phrases:
            if phrase in text:
                failures.append(
                    "docs/board/kicad/e1-demo-commands.md is stale relative to checked-in "
                    f"KiCad sources: {phrase}"
                )
    for required in (
        "kicad-cli sch erc",
        "kicad-cli pcb drc",
        "kicad-cli pcb export gerbers",
        "kicad-cli pcb export drill",
        "kicad-cli sch export bom",
        "kicad-cli pcb export pos",
    ):
        if required not in text:
            blockers.append(f"KiCad command capture doc missing command family: {required}")


def diagnostic_only(path: Path) -> bool:
    try:
        text = path.read_text(encoding="utf-8", errors="ignore").lower()
    except OSError:
        return False
    return (
        any(
            marker in text
            for marker in (
                "release_credit: false",
                "blocked_tool_unavailable",
                "blocked_not_executed",
                "not release evidence",
                "not fabrication release evidence",
                "python erc pass for e1-demo board",
            )
        )
        or re.search(r"exit_code:\s*[1-9][0-9]*", text) is not None
    )


def load_manifest() -> dict[str, object]:
    try:
        loaded = yaml.safe_load((ROOT / MANIFEST).read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def load_manifest_commands() -> dict[str, str]:
    manifest = load_manifest()
    groups = manifest.get("artifact_groups", {})
    if not isinstance(groups, dict):
        return {}
    cli_group = groups.get("kicad_cli_outputs", {})
    if not isinstance(cli_group, dict):
        return {}
    commands = cli_group.get("cli_commands", {})
    if not isinstance(commands, dict):
        return {}
    return {str(key): str(value) for key, value in sorted(commands.items())}


def command_for_label(label: str, commands: dict[str, str]) -> str | None:
    command_name = EVIDENCE_COMMANDS.get(label)
    if command_name:
        return commands.get(command_name)
    if label == "command transcript":
        return "capture all kicad-cli invocations and exit codes into board/reports/fab/<rev>/kicad-command-transcript.txt"
    if label == "KiCad tool versions":
        return "kicad-cli version > board/reports/fab/<rev>/kicad-tool-versions.txt"
    return None


def tool_environment(path: Path | None) -> dict[str, str]:
    env = os.environ.copy()
    if path is not None and path == LOCAL_TMP_KICAD_CLI and LOCAL_TMP_KICAD_LIB.is_dir():
        current = env.get("LD_LIBRARY_PATH")
        env["LD_LIBRARY_PATH"] = f"{LOCAL_TMP_KICAD_LIB}{':' + current if current else ''}"
    return env


def run_tool_probe(path: Path, args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [path.as_posix(), *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
        env=tool_environment(path),
    )


def probe_kicad_cli(path: Path, source: str) -> dict[str, object]:
    version = run_tool_probe(path, ["version"])
    sch = run_tool_probe(path, ["sch", "--help"])
    pcb = run_tool_probe(path, ["pcb", "--help"])
    sch_help = sch.stdout or ""
    pcb_help = pcb.stdout or ""
    supports_native_erc = "erc" in sch_help.split()
    supports_native_drc = "drc" in pcb_help.split()
    return {
        "source": source,
        "path": path.as_posix(),
        "exists": path.is_file(),
        "version_returncode": version.returncode,
        "version_output": (version.stdout or "").strip() or None,
        "supports_native_sch_erc": supports_native_erc,
        "supports_native_pcb_drc": supports_native_drc,
        "supports_partial_exports": all(
            token in sch_help or token in pcb_help
            for token in ("export", "gerbers", "drill", "pos", "pdf")
        ),
        "release_artifact_generation_feasible": version.returncode == 0
        and supports_native_erc
        and supports_native_drc,
        "partial_artifact_generation_feasible": version.returncode == 0,
        "missing_capabilities": [
            capability
            for capability, supported in (
                ("native sch erc", supports_native_erc),
                ("native pcb drc", supports_native_drc),
            )
            if not supported
        ],
    }


def kicad_tool_availability() -> dict[str, object]:
    env_path_text = os.environ.get("KICAD_CLI")
    env_path = Path(env_path_text) if env_path_text else None
    path_text = shutil.which("kicad-cli")
    path = Path(path_text) if path_text else None
    available = path is not None
    probes: list[dict[str, object]] = []
    if env_path is not None:
        probes.append(probe_kicad_cli(env_path, "KICAD_CLI"))
    if path is not None:
        probes.append(probe_kicad_cli(path, "PATH"))
    if LOCAL_TMP_KICAD_CLI.is_file() and (path is None or path != LOCAL_TMP_KICAD_CLI):
        probes.append(probe_kicad_cli(LOCAL_TMP_KICAD_CLI, "local_tmp_deb_extraction"))
    if LOCAL_TMP_KICAD10_APPIMAGE_CLI.is_file() and all(
        Path(str(probe["path"])) != LOCAL_TMP_KICAD10_APPIMAGE_CLI for probe in probes
    ):
        probes.append(probe_kicad_cli(LOCAL_TMP_KICAD10_APPIMAGE_CLI, "local_tmp_appimage"))
    release_probe = next(
        (probe for probe in probes if bool(probe["release_artifact_generation_feasible"])),
        None,
    )
    primary_probe = release_probe or (probes[0] if probes else None)
    version_output = primary_probe["version_output"] if primary_probe else None
    version_returncode = primary_probe["version_returncode"] if primary_probe else None
    release_feasible = release_probe is not None
    partial_feasible = any(bool(probe["partial_artifact_generation_feasible"]) for probe in probes)
    return {
        "tool": "kicad-cli",
        "available": available,
        "path": path_text,
        "release_capable_path": release_probe["path"] if release_probe else None,
        "release_capable_source": release_probe["source"] if release_probe else None,
        "version_command": "kicad-cli version",
        "version_returncode": version_returncode,
        "version_output": version_output,
        "release_artifact_generation_feasible": release_feasible,
        "partial_artifact_generation_feasible": partial_feasible,
        "probes": probes,
        "blocked_reason": None
        if release_feasible
        else "kicad-cli with native sch erc and pcb drc is not available on PATH",
        "non_destructive_local_unblock_commands": LOCAL_TMP_UNBLOCK_COMMANDS,
    }


def source_inventory() -> dict[str, dict[str, object]]:
    inventory: dict[str, dict[str, object]] = {}
    for label, patterns in REQUIRED_PROJECT_GLOBS.items():
        found = matches(BOARD_DIR, patterns)
        inventory[label] = {
            "required_for_release": True,
            "paths": [path.relative_to(ROOT).as_posix() for path in found],
            "present": bool(found),
        }
    return inventory


def fab_notes_inventory() -> dict[str, object]:
    path = BOARD_DOC_DIR / "fab-notes.md"
    rel_path = path.relative_to(ROOT).as_posix()
    if not path.is_file():
        return {
            "path": rel_path,
            "present": False,
            "status": "missing",
            "release_credit": False,
            "missing_markers": sorted(REQUIRED_FAB_NOTE_MARKERS),
        }
    text = path.read_text(encoding="utf-8", errors="ignore")
    missing = [key for key, marker in REQUIRED_FAB_NOTE_MARKERS.items() if marker not in text]
    return {
        "path": rel_path,
        "present": True,
        "status": "fail_closed_non_release" if not missing else "malformed",
        "release_credit": False,
        "fabrication_release_allowed": False,
        "required_for_release": True,
        "missing_markers": missing,
        "recorded_missing_approvals": [
            "foundry",
            "package_vendor_land_pattern",
            "assembly_house_dfm",
            "board_house_stackup_and_fabrication",
            "si_pi_pdn",
            "enclosure_fit",
            "first_article",
        ],
        "release_blocker": (
            "Fab note records fail-closed non-release status: foundry approval, "
            "package-vendor land-pattern approval, DFM, release-credit fabrication "
            "outputs, enclosure-fit evidence, and first-article evidence are missing."
        ),
    }


def release_evidence_inventory() -> dict[str, dict[str, object]]:
    commands = load_manifest_commands()
    inventory: dict[str, dict[str, object]] = {}
    for label, patterns in REQUIRED_RELEASE_EVIDENCE.items():
        found = sorted(set(matches(REPORT_DIR, patterns) + matches(BOARD_DIR, patterns)))
        diagnostic_paths = [path for path in found if diagnostic_only(path)]
        release_credit_paths = [path for path in found if path not in diagnostic_paths]
        inventory[label] = {
            "paths": [path.relative_to(ROOT).as_posix() for path in found],
            "diagnostic_only_paths": [
                path.relative_to(ROOT).as_posix() for path in diagnostic_paths
            ],
            "release_credit_paths": [
                path.relative_to(ROOT).as_posix() for path in release_credit_paths
            ],
            "release_credit_satisfied": bool(release_credit_paths),
            "missing_release_credit": not release_credit_paths,
            "generation_command": command_for_label(label, commands),
            "local_kicad7_partial_generation_command": KICAD7_PARTIAL_COMMANDS.get(label),
        }
    has_command_transcript = bool(
        inventory.get("command transcript", {}).get("release_credit_paths")
    )
    has_tool_versions = bool(inventory.get("KiCad tool versions", {}).get("release_credit_paths"))
    has_erc = bool(inventory.get("erc transcript", {}).get("release_credit_paths"))
    has_drc = bool(inventory.get("drc transcript", {}).get("release_credit_paths"))
    support_blockers = []
    if not has_command_transcript:
        support_blockers.append("missing release-credit command transcript")
    if not has_tool_versions:
        support_blockers.append("missing release-credit KiCad tool versions")
    if not has_erc:
        support_blockers.append("missing release-credit ERC transcript")
    if not has_drc:
        support_blockers.append("missing release-credit DRC transcript")
    if support_blockers:
        supporting_labels = {
            "command transcript",
            "KiCad tool versions",
            "erc transcript",
            "drc transcript",
        }
        for label, record in inventory.items():
            if label in supporting_labels:
                continue
            if record["release_credit_paths"]:
                record["release_credit_blockers"] = support_blockers
                record["release_credit_satisfied"] = False
                record["missing_release_credit"] = True
    return inventory


def target_status_promotion_contract(
    inventory: dict[str, dict[str, object]],
    manifest: dict[str, object] | None = None,
) -> dict[str, object]:
    """Describe exact evidence needed before the e1-demo KiCad manifest can be promoted."""
    manifest = manifest if isinstance(manifest, dict) else load_manifest()
    artifact_groups = manifest.get("artifact_groups", {}) if isinstance(manifest, dict) else {}
    kicad_sources = (
        artifact_groups.get("kicad_sources", {}) if isinstance(artifact_groups, dict) else {}
    )
    kicad_outputs = (
        artifact_groups.get("kicad_cli_outputs", {}) if isinstance(artifact_groups, dict) else {}
    )
    board_reviews = (
        artifact_groups.get("board_reviews", {}) if isinstance(artifact_groups, dict) else {}
    )
    tool = kicad_tool_availability()
    sources = source_inventory()

    criteria: list[dict[str, object]] = [
        {
            "id": "kicad-promotion-001",
            "field": "board/kicad/e1-demo/artifact-manifest.yaml:status",
            "required_value": "complete",
            "current_value": manifest.get("status", "missing")
            if isinstance(manifest, dict)
            else "missing",
            "status": (
                "satisfied"
                if isinstance(manifest, dict) and manifest.get("status") == "complete"
                else "blocked"
            ),
            "evidence_required": "Promote only after source, CLI output, DFM/SI review, and manufacturing release evidence is reviewed.",
            "source_manifest": MANIFEST,
            "release_credit": False,
        },
        {
            "id": "kicad-promotion-002",
            "field": "artifact_groups.kicad_sources.status",
            "required_value": "complete",
            "current_value": kicad_sources.get("status", "missing")
            if isinstance(kicad_sources, dict)
            else "missing",
            "status": (
                "satisfied"
                if isinstance(kicad_sources, dict) and kicad_sources.get("status") == "complete"
                else "blocked"
            ),
            "evidence_required": "Checked-in project, schematic, PCB, and reviewed vendor-derived footprint source metadata.",
            "source_manifest": MANIFEST,
            "release_credit": False,
        },
        {
            "id": "kicad-promotion-003",
            "field": "artifact_groups.kicad_cli_outputs.status",
            "required_value": "complete",
            "current_value": kicad_outputs.get("status", "missing")
            if isinstance(kicad_outputs, dict)
            else "missing",
            "status": (
                "satisfied"
                if isinstance(kicad_outputs, dict) and kicad_outputs.get("status") == "complete"
                else "blocked"
            ),
            "evidence_required": "Clean ERC, DRC, Gerbers, drill, BOM, position, fab drawing, command transcript, and tool-version evidence.",
            "source_manifest": MANIFEST,
            "release_credit": False,
        },
        {
            "id": "kicad-promotion-004",
            "field": "artifact_groups.board_reviews.status",
            "required_value": "complete",
            "current_value": board_reviews.get("status", "missing")
            if isinstance(board_reviews, dict)
            else "missing",
            "status": (
                "satisfied"
                if isinstance(board_reviews, dict) and board_reviews.get("status") == "complete"
                else "blocked"
            ),
            "evidence_required": "Assembly DFM, stackup/return-path, and package/board cross-probe review records.",
            "source_manifest": MANIFEST,
            "release_credit": False,
        },
        {
            "id": "kicad-promotion-005",
            "field": "tool_availability.release_artifact_generation_feasible",
            "required_value": True,
            "current_value": tool["release_artifact_generation_feasible"],
            "status": ("satisfied" if tool["release_artifact_generation_feasible"] else "blocked"),
            "evidence_required": "KiCad CLI build with native sch erc and pcb drc support.",
            "expected_command_output": {
                "command": "kicad-cli version",
                "accepted_exit_code": 0,
                "accepted_output": "KiCad version string from the release-capable CLI.",
            },
            "source_manifest": MANIFEST,
            "release_credit": False,
        },
    ]

    for label, source in sources.items():
        criteria.append(
            {
                "id": f"kicad-promotion-source-{label.replace('/', '-').replace(' ', '-')}",
                "field": f"source_inventory.{label}",
                "required_value": "present",
                "current_value": "present" if source["present"] else "missing",
                "status": "satisfied" if source["present"] else "blocked",
                "evidence_required": f"Accepted paths matching {source['paths'] or REQUIRED_PROJECT_GLOBS[label]}.",
                "source_manifest": MANIFEST,
                "accepted_artifact_paths": source["paths"],
                "expected_globs": REQUIRED_PROJECT_GLOBS[label],
                "release_credit": False,
            }
        )

    for label, evidence in inventory.items():
        criteria.append(
            {
                "id": f"kicad-promotion-evidence-{label.replace(' ', '-')}",
                "field": f"release_evidence_inventory.{label}",
                "required_value": "release_credit_satisfied",
                "current_value": evidence["release_credit_paths"]
                if evidence["release_credit_satisfied"]
                else "missing",
                "status": ("satisfied" if evidence["release_credit_satisfied"] else "blocked"),
                "evidence_required": "Real release artifact, not a diagnostic-only placeholder.",
                "source_manifest": MANIFEST,
                "expected_command_output": {
                    "command": evidence["generation_command"],
                    "accepted_exit_code": 0,
                    "accepted_output": f"Creates reviewed {label} evidence with clean/fabrication-usable content where applicable.",
                },
                "accepted_artifact_paths": evidence["release_credit_paths"],
                "expected_globs": REQUIRED_RELEASE_EVIDENCE[label],
                "diagnostic_only_paths": evidence["diagnostic_only_paths"],
                "release_credit": False,
            }
        )

    blocked = [item for item in criteria if item["status"] != "satisfied"]
    return {
        "status": "blocked" if blocked else "satisfied",
        "release_credit": False,
        "claim_boundary": "promotion checklist only; it does not create fabrication release evidence",
        "source_manifests": [MANIFEST],
        "current_manifest_status": manifest.get("status", "missing")
        if isinstance(manifest, dict)
        else "missing",
        "required_manifest_status": "complete",
        "blocked_count": len(blocked),
        "blocked_criteria": [item["id"] for item in blocked],
        "criteria": criteria,
        "bounded_validation_commands": [
            "python3 scripts/check_kicad_artifacts.py --release",
            "python3 scripts/check_manufacturing_artifacts.py --manifest board/kicad/e1-demo/artifact-manifest.yaml --release",
            "python3 scripts/generate_e1_demo_kicad_blocked_cli_evidence.py",
        ],
        "next_action_id": "kicad-target-promotion-001",
        "next_step": (
            "Keep board/kicad/e1-demo/artifact-manifest.yaml at scaffold until every "
            "criterion has release-credit paths from reviewed KiCad and manufacturing outputs."
        ),
    }


def blocker_groups(
    blockers: list[str], inventory: dict[str, dict[str, object]]
) -> dict[str, object]:
    sources = source_inventory()
    fab_notes = fab_notes_inventory()
    missing_sources = [
        {
            "source": label,
            "expected_globs": REQUIRED_PROJECT_GLOBS[label],
            "reason": "missing_source_artifact",
        }
        for label, entry in sources.items()
        if not entry["present"]
    ]
    missing_release_evidence = [
        {
            "evidence": label,
            "expected_globs": REQUIRED_RELEASE_EVIDENCE[label],
            "diagnostic_only_paths": entry["diagnostic_only_paths"],
            "generation_command": entry["generation_command"],
            "reason": "diagnostic_only_present"
            if entry["diagnostic_only_paths"]
            else "missing_artifact",
        }
        for label, entry in inventory.items()
        if entry["missing_release_credit"]
    ]
    tool = kicad_tool_availability()
    return {
        "toolchain": []
        if tool["release_artifact_generation_feasible"]
        else [
            {
                "tool": "kicad-cli",
                "reason": "missing_release_capable_tool",
                "required_for": "headless ERC/DRC/Gerber/drill/BOM/position/fab drawing generation",
                "unblock_action": "install or expose a KiCad CLI build that supports `kicad-cli sch erc` and `kicad-cli pcb drc`, then rerun packages/chip/scripts/check_kicad_artifacts.py --release from packages/chip",
                "non_destructive_local_probe_commands": LOCAL_TMP_UNBLOCK_COMMANDS,
                "tool_probes": tool["probes"],
            }
        ],
        "source_artifacts": missing_sources,
        "release_evidence": missing_release_evidence,
        "manifest_release": [
            {
                "reason": "manifest_release_check_blocked",
                "detail": blocker,
            }
            for blocker in blockers
            if blocker.startswith("manifest:") or blocker.endswith("release evidence is incomplete")
        ],
        "fab_notes": []
        if fab_notes["status"] == "fail_closed_non_release"
        else [
            {
                "reason": "fab_notes_missing_fail_closed_non_release_markers",
                "path": fab_notes["path"],
                "missing_markers": fab_notes["missing_markers"],
            }
        ],
    }


def kicad_blocker_class(blocker: str) -> str:
    if "diagnostic-only files present:" in blocker:
        return "present_non_release_diagnostic_artifact"
    if blocker.startswith("missing KiCad/fab release evidence:"):
        return "missing_generated_release_artifact"
    if blocker.startswith("missing release-credit KiCad/fab release evidence:"):
        return "missing_generated_release_artifact"
    if blocker.startswith("manifest:") or blocker.endswith("release evidence is incomplete"):
        return "manufacturing_manifest_release_blocker"
    if blocker.startswith("Fab note records fail-closed non-release status:"):
        return "external_approval_blocker"
    if blocker.startswith("missing printable KiCad source") or blocker.startswith("missing KiCad"):
        return "missing_source_artifact"
    return "other_release_blocker"


def kicad_blocker_class_counts(blockers: list[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for blocker in blockers:
        blocker_class = kicad_blocker_class(blocker)
        counts[blocker_class] = counts.get(blocker_class, 0) + 1
    return dict(sorted(counts.items(), key=lambda item: (-item[1], item[0])))


def kicad_blocker_next_step(blocker_class: str) -> str:
    steps = {
        "present_non_release_diagnostic_artifact": (
            "Replace diagnostic-only local files with release-credit KiCad outputs captured "
            "from the approved command and review flow."
        ),
        "missing_generated_release_artifact": (
            "Generate the missing KiCad release artifact with the manifest command and attach "
            "release metadata."
        ),
        "manufacturing_manifest_release_blocker": (
            "Resolve the delegated manufacturing artifact manifest blocker; this KiCad gate "
            "must remain blocked while that manifest is non-release."
        ),
        "external_approval_blocker": (
            "Attach foundry, package-vendor, DFM, enclosure-fit, SI/PI, and first-article "
            "approval evidence before using these files for fabrication release."
        ),
        "missing_source_artifact": (
            "Restore the required KiCad source artifact before attempting release generation."
        ),
        "other_release_blocker": (
            "Resolve the blocker shown in the message while preserving fail-closed release behavior."
        ),
    }
    return steps.get(blocker_class, steps["other_release_blocker"])


def write_report(status: str, failures: list[str], blockers: list[str], release: bool) -> None:
    inventory = release_evidence_inventory()
    findings: list[dict[str, object]] = []
    for failure in failures:
        findings.append(
            {
                "code": "kicad_artifact_check_failure",
                "message": failure,
                "next_step": "fix KiCad source and manifest validation failures",
                "severity": "error",
            }
        )
    for blocker in blockers:
        blocker_class = kicad_blocker_class(blocker)
        findings.append(
            {
                "code": "kicad_artifact_release_blocked",
                "message": blocker,
                "blocker_class": blocker_class,
                "next_step": kicad_blocker_next_step(blocker_class),
                "severity": "blocker",
                "release_credit": False,
            }
        )
    report = {
        "schema": REPORT_SCHEMA,
        "status": status,
        "summary": {
            "release_mode": release,
            "failure_count": len(failures),
            "blocker_count": len(blockers),
            "blocker_classes": kicad_blocker_class_counts(blockers),
            "release_ready": status == "pass",
            "release_credit": False,
        },
        "tool_availability": kicad_tool_availability(),
        "source_inventory": source_inventory(),
        "fab_notes_inventory": fab_notes_inventory(),
        "release_commands": load_manifest_commands(),
        "release_evidence_inventory": inventory,
        "target_status_promotion_contract": target_status_promotion_contract(inventory),
        "repo_artifact_next_actions": {
            "release_credit": False,
            "source_manifest": MANIFEST,
            "manufacturing_manifest_command": (
                "python3 scripts/check_manufacturing_artifacts.py "
                "--manifest board/kicad/e1-demo/artifact-manifest.yaml --release"
            ),
            "kicad_release_command": "python3 scripts/check_kicad_artifacts.py --release",
            "blocked_manifest_lines": [
                blocker for blocker in blockers if blocker.startswith("manifest:")
            ],
            "external_approval_blockers": [
                blocker
                for blocker in blockers
                if kicad_blocker_class(blocker) == "external_approval_blocker"
            ],
            "next_step": (
                "Close the manufacturing manifest, package/vendor land-pattern, DFM, "
                "fab-output, enclosure-fit, and first-article evidence before claiming "
                "KiCad fabrication release."
            ),
        },
        "blocker_groups": blocker_groups(blockers, inventory),
        "findings": findings,
        "claim_boundary": "kicad_artifact_inventory_only_not_fabrication_release_evidence",
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    parser = ArgumentParser(description="Check KiCad board fabrication artifacts.")
    parser.add_argument(
        "--release", action="store_true", help="require release-ready KiCad and fab evidence"
    )
    parser.add_argument(
        "--manifest-only", action="store_true", help="check KiCad artifact manifest shape only"
    )
    args = parser.parse_args()

    failures: list[str] = []
    blockers: list[str] = []

    manifest_check = run_manifest_check(release=False)
    if manifest_check.returncode != 0:
        failures.append(f"{MANIFEST} validation failed")
        append_process_output("manifest", manifest_check, failures)

    if args.manifest_only:
        if failures:
            write_report("fail", failures, blockers, args.release)
            print("KiCad artifact manifest check failed:")
            for failure in failures:
                print(f"  - {failure}")
            return 1
        write_report("pass", failures, blockers, args.release)
        print("KiCad artifact manifest check passed.")
        return 0

    check_command_doc_staleness(failures, blockers)

    release_manifest_check = run_manifest_check(release=True) if args.release else None
    if release_manifest_check is not None and release_manifest_check.returncode != 0:
        blockers.append(f"{MANIFEST} release evidence is incomplete")
        append_process_output("manifest", release_manifest_check, blockers)

    if not BOARD_DIR.is_dir():
        failures.append("missing board/kicad/e1-demo directory")
    else:
        fab_notes = fab_notes_inventory()
        if not fab_notes["present"]:
            failures.append("missing docs/board/kicad/e1-demo/fab-notes.md")
        elif fab_notes["missing_markers"]:
            missing = ", ".join(cast("list[str]", fab_notes["missing_markers"]))
            failures.append(
                "docs/board/kicad/e1-demo/fab-notes.md is missing required "
                f"fail-closed fabrication markers: {missing}"
            )
        else:
            blockers.append(str(fab_notes["release_blocker"]))
        printable_sources_present = False
        printable_sources_missing: list[str] = []
        for label, patterns in REQUIRED_PROJECT_GLOBS.items():
            found = matches(BOARD_DIR, patterns)
            if label in PRINTABLE_SOURCE_LABELS:
                printable_sources_present = printable_sources_present or bool(found)
                if not found:
                    printable_sources_missing.append(label)
            elif args.release and not found:
                blockers.append(f"missing KiCad {label} artifact under board/kicad/e1-demo")
        if printable_sources_missing:
            missing = ", ".join(printable_sources_missing)
            blockers.append(f"missing printable KiCad source artifact(s): {missing}")
        elif printable_sources_present:
            print("KiCad printable source set present; checking release evidence.")

    inventory = release_evidence_inventory()
    for label, entry in inventory.items():
        if entry["release_credit_satisfied"]:
            continue
        diagnostic_paths = entry["diagnostic_only_paths"]
        if diagnostic_paths:
            shown = ", ".join(cast("list[str]", diagnostic_paths))
            blockers.append(
                f"missing release-credit KiCad/fab release evidence: {label} "
                f"(diagnostic-only files present: {shown})"
            )
        else:
            blockers.append(f"missing KiCad/fab release evidence: {label}")

    if failures:
        write_report("fail", failures, blockers, args.release)
        print("KiCad artifact check failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    if blockers:
        write_report("blocked", failures, blockers, args.release)
        print("STATUS: BLOCKED KiCad release evidence is incomplete; release_credit=false")
        print("KiCad release blockers:")
        for blocker in blockers:
            print(f"  - {blocker}")
        if args.release:
            return 2
        print("KiCad scaffold present; release evidence is still blocked.")
        return 0

    write_report("pass", failures, blockers, args.release)
    print("KiCad artifact check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
