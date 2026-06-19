#!/usr/bin/env python3
import re
import sys
from pathlib import Path

import yaml

VECTOR_PIN_RE = re.compile(r"^(DBG_ADDR|DBG_WDATA|DBG_RDATA|GPIO)(\d+)$")
REQUIRED_FALSE_CLAIM_FLAGS = {
    "claim_allowed",
    "release_claim_allowed",
    "fpga_bitstream_release_claim_allowed",
    "hardware_boot_claim_allowed",
    "e1_chip_rtl_claim_allowed",
}


def parse_ports(path: Path) -> set[str]:
    text = path.read_text()
    module = re.search(r"module\s+e1_chip_top\s*\((.*?)\);", text, re.S)
    if not module:
        raise SystemExit("e1_chip_top module header not found")
    ports: set[str] = set()
    for raw in module.group(1).splitlines():
        raw = raw.split("//", 1)[0].strip().rstrip(",")
        if not raw:
            continue
        name = raw.split()[-1].split("[", 1)[0]
        ports.add(name)
    return ports


def parse_pin_names(path: Path) -> set[str]:
    data = yaml.safe_load(path.read_text())
    names: set[str] = set()
    for pin in data["pins"]:
        name = pin["name"]
        if name.startswith(("VDD", "VSS", "NC")):
            continue
        vector = VECTOR_PIN_RE.match(name)
        names.add(vector.group(1) if vector else name)
    return names


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    cfg_path = root / "board/fpga/e1_demo_fpga.yaml"
    cfg = yaml.safe_load(cfg_path.read_text())
    ports = parse_ports(root / "rtl/top/e1_chip_top.sv")
    pin_names = parse_pin_names(root / "package/e1-demo-pinout.yaml")

    if cfg.get("rtl_top") != "e1_chip_top":
        print("FPGA target must name rtl_top e1_chip_top")
        return 1
    missing_false_flags = [
        key for key in sorted(REQUIRED_FALSE_CLAIM_FLAGS) if cfg.get(key) is not False
    ]
    if missing_false_flags:
        print("FPGA scaffold must keep claim flags false:")
        for name in missing_false_flags:
            print(f"  - {name}")
        return 1

    required = {
        cfg["clock"]["port"],
        cfg["reset"]["port"],
        cfg["external_outputs"]["gpio_port"],
        *cfg["debug_bridge"]["required_ports"],
        *cfg["external_outputs"]["irq_ports"],
        *cfg.get("reserved_inputs", []),
        *cfg.get("reserved_outputs", []),
    }
    missing_ports = sorted(required - ports)
    missing_pins = sorted(required - pin_names)
    if missing_ports or missing_pins:
        if missing_ports:
            print("FPGA contract names ports missing from RTL:")
            for name in missing_ports:
                print(f"  - {name}")
        if missing_pins:
            print("FPGA contract names signals missing from package pinout:")
            for name in missing_pins:
                print(f"  - {name}")
        return 1

    constraint = root / cfg["constraints"]["skeleton_lpf"]
    if not constraint.is_file():
        print(f"missing FPGA constraint skeleton: {constraint}")
        return 1
    text = constraint.read_text()
    missing_in_constraint = sorted(name for name in required if name not in text)
    if missing_in_constraint:
        print("FPGA constraint skeleton does not mention required signals:")
        for name in missing_in_constraint:
            print(f"  - {name}")
        return 1

    if not cfg["constraints"].get("bitstream_release_blocked_until_pins_assigned", False):
        print("FPGA scaffold must block bitstream release until pins are assigned")
        return 1

    print("FPGA target contract ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
