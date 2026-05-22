#!/usr/bin/env python3
import json
import re
import sys
from argparse import ArgumentParser
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
CFG = ROOT / "board/fpga/e1_demo_fpga.yaml"
MANIFEST = ROOT / "board/fpga/artifact-manifest.yaml"
REPORT = ROOT / "build/reports/fpga_release.json"
SCHEMA = "eliza.fpga_release.v1"
CLAIM_BOUNDARY = "fpga_release_validation_only_not_board_fabrication_evidence"

REQUIRED_RELEASE_EVIDENCE = {
    "bitstream": ["board/fpga/build/**/*.bit", "board/fpga/build/**/*.svf"],
    "nextpnr timing report": [
        "board/fpga/reports/**/*timing*.rpt",
        "board/fpga/reports/**/*timing*.txt",
    ],
    "nextpnr route report": [
        "board/fpga/reports/**/*nextpnr*.log",
        "board/fpga/reports/**/*route*.rpt",
    ],
    "ecppack transcript": [
        "board/fpga/reports/**/*ecppack*.log",
        "board/fpga/reports/**/*pack*.log",
    ],
    "FPGA tool versions": [
        "board/fpga/reports/**/*tool*version*.txt",
        "board/fpga/reports/tool_versions.txt",
    ],
}
REQUIRED_CLI_COMMANDS = {"synth", "place_route", "pack"}


def write_report(status: str, findings: list[str], release: bool) -> None:
    payload = {
        "schema": SCHEMA,
        "status": status,
        "claim_boundary": CLAIM_BOUNDARY,
        "mode": "release" if release else "preflight",
        "inputs": {
            "target": CFG.relative_to(ROOT).as_posix(),
            "manifest": MANIFEST.relative_to(ROOT).as_posix(),
        },
        "summary": {
            "release_ready": status == "pass" and release,
            "blockers": len(findings) if status == "blocked" else 0,
            "failures": len(findings) if status == "fail" else 0,
        },
        "findings": [
            {
                "code": f"fpga_release_{status}_{index}",
                "severity": "blocker" if status == "blocked" else "error",
                "message": finding,
                "evidence": CFG.relative_to(ROOT).as_posix(),
                "next_step": (
                    "Assign all FPGA pins and archive bitstream, timing, route, "
                    "pack, and tool-version release evidence."
                ),
            }
            for index, finding in enumerate(findings, start=1)
        ],
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


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


def glob_any(patterns: list[str]) -> bool:
    return any(path.is_file() for pattern in patterns for path in ROOT.glob(pattern))


def validate_manifest(blockers: list[str], failures: list[str]) -> None:
    if not MANIFEST.is_file():
        failures.append("missing FPGA artifact manifest: board/fpga/artifact-manifest.yaml")
        return
    manifest = yaml.safe_load(MANIFEST.read_text())
    if not isinstance(manifest, dict):
        failures.append("board/fpga/artifact-manifest.yaml must be a YAML mapping")
        return
    if manifest.get("manifest") != "e1_demo_fpga_bitstream_evidence":
        failures.append("FPGA artifact manifest has unexpected manifest name")
    if manifest.get("release_gate") != "board_fabrication_release":
        failures.append("FPGA artifact manifest must gate board_fabrication_release")
    groups = manifest.get("artifact_groups", {})
    bitstream = groups.get("bitstream_release") if isinstance(groups, dict) else None
    if not isinstance(bitstream, dict):
        failures.append("FPGA artifact manifest missing artifact_groups.bitstream_release")
        return
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


def main() -> int:
    parser = ArgumentParser(description="Check FPGA release readiness evidence.")
    parser.add_argument(
        "--release", action="store_true", help="fail when bitstream release evidence is incomplete"
    )
    args = parser.parse_args()

    cfg = yaml.safe_load(CFG.read_text())
    failures: list[str] = []
    blockers: list[str] = []
    validate_manifest(blockers, failures)

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

    for label, patterns in REQUIRED_RELEASE_EVIDENCE.items():
        if not glob_any(patterns):
            blockers.append(f"missing FPGA release evidence: {label}")

    if failures:
        write_report("fail", failures, args.release)
        print("FPGA release manifest check failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    if blockers:
        write_report("blocked", blockers, args.release)
        print("STATUS: BLOCKED FPGA release check")
        print("FPGA release check failed:" if args.release else "FPGA release blockers:")
        for blocker in blockers:
            print(f"  - {blocker}")
        return 1 if args.release else 0

    write_report("pass", [], args.release)
    print("FPGA release check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
