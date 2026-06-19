#!/usr/bin/env python3
import re
import sys
from pathlib import Path

VECTOR_PIN_RE = re.compile(r"^(DBG_ADDR|DBG_WDATA|DBG_RDATA|GPIO)(\d+)$")
_POWER_PIN_GUARDS = {"USE_POWER_PINS"}


def parse_pinout(path: Path) -> set[str]:
    pins: set[str] = set()
    for line in path.read_text().splitlines():
        match = re.search(r"name:\s*([A-Za-z0-9_]+)", line)
        if not match:
            continue
        name = match.group(1)
        if name.startswith(("VDD", "VSS", "NC")):
            continue
        vector = VECTOR_PIN_RE.match(name)
        if vector:
            pins.add(vector.group(1))
        else:
            pins.add(name)
    return pins


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
        if line.startswith("`"):
            tokens = line.split()
            directive = tokens[0]
            if directive in {"`ifdef", "`ifndef"}:
                macro = tokens[1] if len(tokens) > 1 else ""
                skipping.append(macro)
            elif directive == "`endif" and skipping:
                skipping.pop()
            continue
        if any(guard in _POWER_PIN_GUARDS for guard in skipping):
            continue
        name = line.split()[-1]
        name = name.split("[", 1)[0]
        ports.add(name)
    return ports


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    pinout = parse_pinout(root / "package/e1-demo-pinout.yaml")
    ports = parse_ports(root / "rtl/top/e1_chip_top.sv")

    missing_ports = sorted(pinout - ports)
    extra_ports = sorted(ports - pinout)

    if missing_ports or extra_ports:
        if missing_ports:
            print("Pinout names missing from e1_chip_top:")
            for name in missing_ports:
                print(f"  - {name}")
        if extra_ports:
            print("e1_chip_top ports missing from pinout:")
            for name in extra_ports:
                print(f"  - {name}")
        return 1

    print("pinout matches e1_chip_top ports")
    return 0


if __name__ == "__main__":
    sys.exit(main())
