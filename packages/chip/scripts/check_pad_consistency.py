#!/usr/bin/env python3
"""Cross-probe RTL top-level ports, bonding CSV, and optional KiCad netlist.

Reads:
  rtl/top/e1_chip_top.sv          - RTL top-level port list
  package/bonding/e1_demo_bonding.csv - die_pad <-> package_pin <-> board_net
  package/e1-demo-pinout.yaml     - canonical pin/voltage/pad-type map
  board/kicad/e1-demo/*.net       - optional KiCad netlist export

Emits:
  build/reports/pad_consistency.json - structured report
  Non-zero exit on any hard error.

This checker is deliberately self-contained: it does NOT import yaml, kicad,
or any other third-party module. The pinout file uses a single restricted
inline-mapping form that we parse directly so the script can run in a stock
Python 3 environment with no extra installs.
"""

from __future__ import annotations

import csv
import json
import re
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent

RTL_TOP = REPO_ROOT / "rtl" / "top" / "e1_chip_top.sv"
BONDING_CSV = REPO_ROOT / "package" / "bonding" / "e1_demo_bonding.csv"
PINOUT_YAML = REPO_ROOT / "package" / "e1-demo-pinout.yaml"
KICAD_NET_DIR = REPO_ROOT / "board" / "kicad" / "e1-demo"
REPORT_PATH = REPO_ROOT / "build" / "reports" / "pad_consistency.json"


def parse_rtl_ports(path: Path) -> dict[str, str]:
    """Return {port_name: direction} from a simple SystemVerilog module header."""
    text = path.read_text()
    match = re.search(r"module\s+\w+\s*\((.*?)\);", text, re.DOTALL)
    if not match:
        raise RuntimeError(f"could not find module header in {path}")
    body = match.group(1)
    # Strip comments.
    body = re.sub(r"//[^\n]*", "", body)
    body = re.sub(r"/\*.*?\*/", "", body, flags=re.DOTALL)
    ports: dict[str, str] = {}
    reserved = {"input", "output", "inout", "logic", "wire", "reg"}
    for entry in _split_top_level(body):
        entry = entry.strip()
        if not entry:
            continue
        # Drop bracketed width specifiers entirely.
        entry = re.sub(r"\[[^\]]*\]", " ", entry)
        toks = entry.split()
        direction = None
        for t in toks:
            if t in {"input", "output", "inout"}:
                direction = t
                break
        if direction is None:
            continue
        name = None
        for t in reversed(toks):
            if re.match(r"^[A-Za-z_]\w*$", t) and t not in reserved:
                name = t
                break
        if name:
            ports[name] = direction
    return ports


def _split_top_level(s: str) -> list[str]:
    """Split on commas that are not inside (), [], or {}."""
    out: list[str] = []
    depth = 0
    buf: list[str] = []
    for ch in s:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        if ch == "," and depth == 0:
            out.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    if buf:
        out.append("".join(buf))
    return out


def expand_rtl_buses(ports: dict[str, str], pinout_names: set[str]) -> set[str]:
    """Expand bus ports (DBG_ADDR -> DBG_ADDR0..3) using pinout-side evidence."""
    expanded: set[str] = set()
    for name in ports:
        if name in pinout_names:
            expanded.add(name)
            continue
        matches = sorted(n for n in pinout_names if re.fullmatch(rf"{re.escape(name)}\d+", n))
        if matches:
            expanded.update(matches)
        else:
            expanded.add(name)
    return expanded


def parse_pinout_yaml(path: Path) -> list[dict[str, str]]:
    """Parse the restricted inline-mapping pinout file.

    Each pin row is a single line like:
        - {pin: 1, name: VDDIO0, direction: power, ...}
    Outside of `pins:` we ignore everything.
    """
    rows: list[dict[str, str]] = []
    in_pins = False
    line_re = re.compile(r"-\s*\{(.*)\}\s*$")
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if line.startswith("pins:"):
            in_pins = True
            continue
        if not in_pins or not line:
            continue
        m = line_re.match(line)
        if not m:
            continue
        body = m.group(1)
        entry: dict[str, str] = {}
        for piece in body.split(","):
            if ":" not in piece:
                continue
            k, v = piece.split(":", 1)
            entry[k.strip()] = v.strip()
        if entry:
            rows.append(entry)
    return rows


def parse_bonding_csv(path: Path) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    with path.open() as fh:
        lines = [ln for ln in fh if not ln.lstrip().startswith("#")]
    reader = csv.DictReader(lines)
    for row in reader:
        rows.append({k: (v or "").strip() for k, v in row.items()})
    return rows


def find_kicad_netlist(directory: Path) -> Path | None:
    if not directory.is_dir():
        return None
    for ext in ("*.net", "*.kicad_net", "*.netlist"):
        for cand in sorted(directory.glob(ext)):
            return cand
    return None


def parse_kicad_netlist(path: Path) -> set[str]:
    """Return the set of net names found in a KiCad eeschema netlist export.

    Tolerant of both the s-expression and the legacy textual format. Only the
    set of net names is needed for the cross-probe; full topology is not.
    """
    text = path.read_text()
    nets: set[str] = set()
    for m in re.finditer(r"\(net\s+\(code\s+\d+\)\s+\(name\s+\"?([^\")]+)\"?\)", text):
        nets.add(m.group(1).strip())
    for m in re.finditer(r"^\s*NET\s+([^\s]+)\s*$", text, re.MULTILINE):
        nets.add(m.group(1).strip())
    return nets


def main() -> int:
    report: dict[str, Any] = {
        "ok": True,
        "errors": [],
        "warnings": [],
        "inputs": {
            "rtl_top": str(RTL_TOP.relative_to(REPO_ROOT)),
            "bonding_csv": str(BONDING_CSV.relative_to(REPO_ROOT)),
            "pinout_yaml": str(PINOUT_YAML.relative_to(REPO_ROOT)),
            "kicad_netlist": None,
        },
        "counts": {},
    }

    def err(msg: str) -> None:
        report["ok"] = False
        report["errors"].append(msg)

    def warn(msg: str) -> None:
        report["warnings"].append(msg)

    if not RTL_TOP.is_file():
        err(f"missing RTL top: {RTL_TOP}")
        _write_report(report)
        return 1
    if not BONDING_CSV.is_file():
        err(f"missing bonding CSV: {BONDING_CSV}")
        _write_report(report)
        return 1
    if not PINOUT_YAML.is_file():
        err(f"missing pinout YAML: {PINOUT_YAML}")
        _write_report(report)
        return 1

    rtl_ports = parse_rtl_ports(RTL_TOP)
    pinout_rows = parse_pinout_yaml(PINOUT_YAML)
    bonding_rows = parse_bonding_csv(BONDING_CSV)

    pinout_names = {r["name"] for r in pinout_rows if "name" in r}
    bonding_pads = {r["die_pad"] for r in bonding_rows if r.get("die_pad")}
    bonding_pins = {
        int(r["package_pin"]) for r in bonding_rows if r.get("package_pin", "").isdigit()
    }
    bonding_nets = {r["board_net"] for r in bonding_rows if r.get("board_net")}
    pinout_pins = {int(r["pin"]) for r in pinout_rows if r.get("pin", "").isdigit()}
    pinout_nets = {r.get("board_net", "") for r in pinout_rows if r.get("board_net")}

    report["counts"] = {
        "rtl_ports": len(rtl_ports),
        "pinout_pins": len(pinout_rows),
        "bonding_rows": len(bonding_rows),
    }

    expanded_rtl = expand_rtl_buses(rtl_ports, pinout_names)
    signal_pinout = {
        r["name"] for r in pinout_rows if r.get("direction") not in {"power", "ground", "nc"}
    }
    missing_in_pinout = sorted(expanded_rtl - pinout_names - {"NC"})
    if missing_in_pinout:
        err(f"RTL ports missing from pinout: {missing_in_pinout}")
    missing_in_rtl = sorted(signal_pinout - expanded_rtl)
    if missing_in_rtl:
        err(f"Pinout signal pads missing from RTL: {missing_in_rtl}")

    csv_only_pads = sorted(bonding_pads - pinout_names)
    pin_only_pads = sorted(pinout_names - bonding_pads)
    if csv_only_pads:
        err(f"Bonding CSV has die_pads absent from pinout YAML: {csv_only_pads}")
    if pin_only_pads:
        err(f"Pinout YAML has names absent from bonding CSV: {pin_only_pads}")

    if bonding_pins != pinout_pins:
        err(
            f"package_pin set mismatch between bonding CSV ({sorted(bonding_pins)[:5]}...) "
            f"and pinout YAML ({sorted(pinout_pins)[:5]}...)"
        )
    expected_pins = set(range(1, 65))
    if bonding_pins != expected_pins:
        err(f"bonding CSV pins are not contiguous 1..64; got {len(bonding_pins)} pins")

    for row in bonding_rows:
        pad = row.get("die_pad")
        bnet = row.get("board_net")
        pin_row = next((p for p in pinout_rows if p.get("name") == pad), None)
        if pin_row is None:
            continue
        if pin_row.get("board_net") != bnet:
            err(f"board_net mismatch for {pad}: pinout={pin_row.get('board_net')} bonding={bnet}")

    type_map = {"PWR": "power", "GND": "ground", "RSV": "nc"}
    for row in bonding_rows:
        t = row.get("type")
        pad = row.get("die_pad")
        pin_row = next((p for p in pinout_rows if p.get("name") == pad), None)
        if pin_row is None or t is None:
            continue
        expected = type_map.get(t)
        if expected and pin_row.get("direction") != expected:
            err(f"type {t} for {pad} does not match pinout direction {pin_row.get('direction')}")
        if t == "IO" and pin_row.get("direction") in {"power", "ground", "nc"}:
            err(f"type IO for {pad} but pinout direction is {pin_row.get('direction')}")

    kicad_net = find_kicad_netlist(KICAD_NET_DIR)
    if kicad_net is not None:
        report["inputs"]["kicad_netlist"] = str(kicad_net.relative_to(REPO_ROOT))
        nets = parse_kicad_netlist(kicad_net)
        ignore = {"NC", ""}
        chip_nets = {n for n in (bonding_nets | pinout_nets) if n not in ignore}
        missing_on_board = sorted(chip_nets - nets)
        if missing_on_board:
            warn(f"board_nets not found in KiCad netlist: {missing_on_board}")
    else:
        warn(
            f"no KiCad netlist found under {KICAD_NET_DIR.relative_to(REPO_ROOT)}; "
            "skipping board cross-probe"
        )

    _write_report(report)
    return 0 if report["ok"] else 1


def _write_report(report: dict[str, Any]) -> None:
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    if report["errors"]:
        for line in report["errors"]:
            print(f"ERROR: {line}", file=sys.stderr)
    for line in report["warnings"]:
        print(f"warn: {line}", file=sys.stderr)
    print(f"wrote {REPORT_PATH.relative_to(REPO_ROOT)} ok={report['ok']}")


if __name__ == "__main__":
    raise SystemExit(main())
