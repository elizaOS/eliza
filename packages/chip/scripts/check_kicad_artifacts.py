#!/usr/bin/env python3
import subprocess
import sys
from argparse import ArgumentParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BOARD_DIR = ROOT / "board/kicad/e1-demo"
BOARD_DOC_DIR = ROOT / "docs/board/kicad/e1-demo"
COMMAND_DOC = ROOT / "docs/board/kicad/e1-demo-commands.md"
REPORT_DIR = ROOT / "board/reports/fab"
MANIFEST = "board/kicad/e1-demo/artifact-manifest.yaml"
PRINTABLE_SOURCE_LABELS = {"project", "schematic", "pcb"}

REQUIRED_PROJECT_GLOBS = {
    "project": ["*.kicad_pro"],
    "schematic": ["*.kicad_sch"],
    "pcb": ["*.kicad_pcb"],
    "symbol/footprint library": ["*.kicad_sym", "**/*.kicad_sym", "**/*.pretty/*.kicad_mod"],
}

REQUIRED_RELEASE_EVIDENCE = {
    "erc transcript": ["**/*erc*.txt", "**/*erc*.log", "**/*erc*.rpt"],
    "drc transcript": ["**/*drc*.txt", "**/*drc*.log", "**/*drc*.rpt"],
    "gerber output": ["**/*.gbr", "**/*.gbrjob"],
    "drill output": ["**/*.drl", "**/*.xln"],
    "bom output": ["**/*bom*.csv", "**/*bom*.tsv", "**/*bom*.xml"],
    "position output": ["**/*pos*.csv", "**/*position*.csv", "**/*.pos"],
    "fab drawing": ["**/*fab*drawing*.pdf", "**/*fabrication*drawing*.pdf"],
    "command transcript": ["**/*command*transcript*.txt", "**/*kicad*transcript*.txt"],
    "KiCad tool versions": ["**/*tool*version*.txt", "**/*kicad*version*.txt"],
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
            print("KiCad artifact manifest check failed:")
            for failure in failures:
                print(f"  - {failure}")
            return 1
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
        notes = BOARD_DOC_DIR / "fab-notes.md"
        if not notes.is_file():
            failures.append("missing docs/board/kicad/e1-demo/fab-notes.md")
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

    for label, patterns in REQUIRED_RELEASE_EVIDENCE.items():
        if not matches(REPORT_DIR, patterns) and not matches(BOARD_DIR, patterns):
            blockers.append(f"missing KiCad/fab release evidence: {label}")

    if failures:
        print("KiCad artifact check failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    if blockers:
        print("KiCad release blockers:")
        for blocker in blockers:
            print(f"  - {blocker}")
        if args.release:
            return 1
        print("KiCad scaffold present; release evidence is still blocked.")
        return 0

    print("KiCad artifact check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
