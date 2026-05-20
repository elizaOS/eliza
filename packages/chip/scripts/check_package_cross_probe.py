#!/usr/bin/env python3
import re
import sys
from argparse import ArgumentParser
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
VECTOR_PIN_RE = re.compile(r"^(DBG_ADDR|DBG_WDATA|DBG_RDATA|GPIO)([0-9]+)$")


def logical_name(name: str) -> str:
    match = VECTOR_PIN_RE.match(name)
    return match.group(1) if match else name


_POWER_PIN_GUARDS = {"USE_POWER_PINS"}


def parse_ports(path: Path) -> set[str]:
    text = path.read_text()
    module = re.search(r"module\s+e1_chip_top\s*\((.*?)\);", text, re.S)
    if not module:
        raise SystemExit("e1_chip_top module header not found")
    ports: set[str] = set()
    skipping: list[str] = []
    for raw in module.group(1).splitlines():
        line = raw.split("//", 1)[0].strip().rstrip(",")
        if not line:
            continue
        # Skip Verilog preprocessor directives and macros guarded by
        # USE_POWER_PINS — VPWR/VGND belong to the PDN, not the functional
        # board-side pinout.
        if line.startswith("`"):
            tokens = line.split()
            directive = tokens[0]
            if directive in {"`ifdef", "`ifndef"}:
                macro = tokens[1] if len(tokens) > 1 else ""
                skipping.append(macro)
            elif directive == "`endif":
                if skipping:
                    skipping.pop()
            continue
        if any(guard in _POWER_PIN_GUARDS for guard in skipping):
            continue
        ports.add(line.split()[-1].split("[", 1)[0])
    return ports


def board_nets_from_kicad(board_dir: Path) -> set[str]:
    nets: set[str] = set()
    for path in sorted(board_dir.glob("*.kicad_sch")) + sorted(board_dir.glob("*.kicad_pcb")):
        text = path.read_text(errors="ignore")
        nets.update(re.findall(r'\(net\s+\d+\s+"([^"]+)"\)', text))
        nets.update(re.findall(r'\(label\s+"([^"]+)"\)', text))
        nets.update(re.findall(r'\(global_label\s+"([^"]+)"', text))
    return nets


def main() -> int:
    parser = ArgumentParser(description="Cross-probe package, padframe, RTL, and board nets.")
    parser.add_argument(
        "--release", action="store_true", help="require board/KiCad cross-probe evidence"
    )
    args = parser.parse_args()

    pinout = yaml.safe_load((ROOT / "package/e1-demo-pinout.yaml").read_text())
    padframe = yaml.safe_load((ROOT / "pd/padframe/e1_demo_padframe.yaml").read_text())
    ports = parse_ports(ROOT / padframe["rtl_top"])

    failures: list[str] = []
    blockers: list[str] = []
    pin_entries = pinout.get("pins", [])
    logical_pins = {
        logical_name(pin["name"])
        for pin in pin_entries
        if not str(pin["name"]).startswith(("VDD", "VSS", "NC"))
    }
    board_nets = {
        str(pin.get("board_net", ""))
        for pin in pin_entries
        if pin.get("board_net") not in {None, "", "NC"}
    }

    missing_rtl = sorted((logical_pins - ports) - {"NC"})
    extra_rtl = sorted(ports - logical_pins)
    if missing_rtl:
        failures.append("package pinout logical names missing from RTL: " + ", ".join(missing_rtl))
    if extra_rtl:
        failures.append("RTL ports missing from package pinout: " + ", ".join(extra_rtl))

    required = set(padframe.get("required_pins", []))
    missing_required = sorted(required - logical_pins - {"VDDIO", "VSSIO", "VDDCORE", "VSSCORE"})
    if missing_required:
        failures.append(
            "padframe required pins missing from package pinout: " + ", ".join(missing_required)
        )

    artifact_paths = padframe.get("package_artifacts", {})
    for name, artifact in artifact_paths.items():
        path = ROOT / artifact
        if not path.is_file():
            failures.append(f"padframe package_artifacts.{name} points at missing file: {artifact}")

    board_dir = ROOT / "board/kicad/e1-demo"
    kicad_files = list(board_dir.glob("*.kicad_sch")) + list(board_dir.glob("*.kicad_pcb"))
    if not kicad_files:
        blockers.append("no KiCad schematic/PCB is available for board-net cross-probe")
    else:
        kicad_nets = board_nets_from_kicad(board_dir)
        missing_board_nets = sorted(board_nets - kicad_nets)
        if missing_board_nets:
            blockers.append(
                "KiCad files are missing package board nets: " + ", ".join(missing_board_nets)
            )

    if "placeholder" in str(pinout.get("package", "")).lower():
        blockers.append("package pinout still uses a placeholder package name")
    for path in (
        ROOT / "docs/package/e1-demo-package.md",
        ROOT / "docs/package/e1-demo-pad-ring.md",
    ):
        text = path.read_text(errors="ignore").lower()
        if "placeholder" in text or "not a foundry-approved" in text:
            blockers.append(
                f"{path.relative_to(ROOT)} is still a placeholder/draft package artifact"
            )

    if failures:
        print("Package cross-probe check failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    if blockers:
        print("Package cross-probe release blockers:")
        for blocker in blockers:
            print(f"  - {blocker}")
        if args.release:
            return 1
        print("Package/RTL scaffold cross-probe passed; board/package release evidence is blocked.")
        return 0

    print("Package cross-probe check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
