#!/usr/bin/env python3
import re
import sys
from pathlib import Path

import yaml

VECTOR_PIN_RE = re.compile(r"^(DBG_ADDR|DBG_WDATA|DBG_RDATA|GPIO)(\d+)$")
REQUIRED_PACKAGE_ARTIFACTS = {
    "pinout",
    "package_plan",
    "pad_ring_plan",
    "board_fab_notes",
    "board_cross_probe",
}
REQUIRED_RELEASE_GATES = {
    "padframe_release",
    "package_release",
    "board_fabrication_release",
}
NON_RELEASE_EVIDENCE_CLASSES = {"non_release_placeholder", "non_release_demo_planning"}
PROHIBITED_RELEASE_USE = "prohibited"
REQUIRED_CROSS_PROBE_SCOPE = {
    "package_pinout": "package/e1-demo-pinout.yaml",
    "padframe_contract": "pd/padframe/e1_demo_padframe.yaml",
    "rtl_top": "rtl/top/e1_chip_top.sv",
    "board_fab_notes": "docs/board/kicad/e1-demo/fab-notes.md",
}


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
        # Verilog preprocessor directives never appear in pin_order.cfg.
        # Track ifdef stacks so power-pin macros guarded by USE_POWER_PINS
        # are skipped — they belong to the PDN, not the functional pinout.
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


def logical_pin_name(name: str) -> str:
    vector = VECTOR_PIN_RE.match(name)
    return vector.group(1) if vector else name


def pin_order_patterns(path: Path) -> list[re.Pattern[str]]:
    patterns: list[re.Pattern[str]] = []
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        patterns.append(re.compile("^" + line.replace(".", r"\.").replace(r"\.*", ".*") + "$"))
    return patterns


def validate_cross_probe(root: Path, path: Path, expected_pins: int) -> list[str]:
    failures: list[str] = []
    data = yaml.safe_load(path.read_text())
    if not isinstance(data, dict):
        return [f"{path.relative_to(root)}: cross-probe manifest must be a mapping"]
    if data.get("status") not in NON_RELEASE_EVIDENCE_CLASSES:
        failures.append(
            f"{path.relative_to(root)}: status must be one of "
            + ", ".join(sorted(NON_RELEASE_EVIDENCE_CLASSES))
        )
    if data.get("release_use") != PROHIBITED_RELEASE_USE:
        failures.append(f"{path.relative_to(root)}: release_use must be prohibited")

    scope = data.get("scope")
    if not isinstance(scope, dict):
        failures.append(f"{path.relative_to(root)}: missing scope")
    else:
        for name, expected in REQUIRED_CROSS_PROBE_SCOPE.items():
            if scope.get(name) != expected:
                failures.append(f"{path.relative_to(root)}: scope.{name} must be {expected}")

    coverage = data.get("coverage")
    if not isinstance(coverage, dict):
        failures.append(f"{path.relative_to(root)}: missing coverage")
    else:
        if coverage.get("package_pins") != expected_pins:
            failures.append(
                f"{path.relative_to(root)}: coverage.package_pins must be {expected_pins}"
            )
        for field in ("board_net_field_required", "rtl_port_match_required"):
            if coverage.get(field) is not True:
                failures.append(f"{path.relative_to(root)}: coverage.{field} must be true")
        for field in ("kicad_symbol_pins_verified", "kicad_footprint_pads_verified"):
            if coverage.get(field) is not False:
                failures.append(
                    f"{path.relative_to(root)}: coverage.{field} must stay false until real KiCad artifacts exist"
                )

    blockers = data.get("release_blockers")
    if not isinstance(blockers, list) or len(blockers) < 3:
        failures.append(
            f"{path.relative_to(root)}: release_blockers must list missing vendor/KiCad evidence"
        )
    return failures


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    contract = yaml.safe_load((root / "pd/padframe/e1_demo_padframe.yaml").read_text())
    pinout = yaml.safe_load((root / contract["package_pinout"]).read_text())
    pins = pinout.get("pins", [])
    allowed = contract["allowed"]
    failures: list[str] = []

    if contract.get("evidence_class") not in NON_RELEASE_EVIDENCE_CLASSES:
        failures.append(
            "padframe contract must declare evidence_class: "
            + " or ".join(sorted(NON_RELEASE_EVIDENCE_CLASSES))
        )
    if contract.get("release_use") != PROHIBITED_RELEASE_USE:
        failures.append("padframe contract must declare release_use: prohibited")
    if pinout.get("evidence_class") not in NON_RELEASE_EVIDENCE_CLASSES:
        failures.append(
            "package pinout must declare evidence_class: "
            + " or ".join(sorted(NON_RELEASE_EVIDENCE_CLASSES))
        )
    if pinout.get("release_use") != PROHIBITED_RELEASE_USE:
        failures.append("package pinout must declare release_use: prohibited")
    pinout_blockers = pinout.get("release_blockers")
    if not isinstance(pinout_blockers, list) or not pinout_blockers:
        failures.append("package pinout must list release_blockers")

    if len(pins) != contract["package_pins"]:
        failures.append(f"expected {contract['package_pins']} pins, found {len(pins)}")
    pin_numbers = sorted(pin["pin"] for pin in pins)
    if pin_numbers != list(range(1, contract["package_pins"] + 1)):
        failures.append("pin numbers must be contiguous from 1 through package_pins")

    seen_names: set[str] = set()
    logical_names: set[str] = set()
    power_counts = {"VDDIO": 0, "VSSIO": 0, "VDDCORE": 0, "VSSCORE": 0}

    for pin in pins:
        name = pin["name"]
        if name in seen_names:
            failures.append(f"duplicate pin name {name}")
        seen_names.add(name)
        logical_names.add(logical_pin_name(name))

        if pin["direction"] not in allowed["directions"]:
            failures.append(f"{name}: invalid direction {pin['direction']}")
        if pin["pad_type"] not in allowed["pad_types"]:
            failures.append(f"{name}: invalid pad_type {pin['pad_type']}")
        if pin["voltage_domain"] not in allowed["voltage_domains"]:
            failures.append(f"{name}: invalid voltage_domain {pin['voltage_domain']}")
        if pin["pull"] not in allowed["pulls"]:
            failures.append(f"{name}: invalid pull {pin['pull']}")

        if pin["direction"] == "power" and pin["pad_type"] != "power":
            failures.append(f"{name}: power direction requires power pad_type")
        if pin["direction"] == "ground" and pin["pad_type"] != "ground":
            failures.append(f"{name}: ground direction requires ground pad_type")
        if pin["direction"] == "nc" and (
            pin["pad_type"] != "no_connect" or pin["board_net"] != "NC"
        ):
            failures.append(f"{name}: nc pins must use no_connect pad_type and NC board_net")

        for prefix in power_counts:
            if name.startswith(prefix):
                power_counts[prefix] += 1

    domains = contract["voltage_domains"]
    if power_counts["VDDIO"] < domains["io"]["min_power_pads"]:
        failures.append("insufficient VDDIO pads")
    if power_counts["VSSIO"] < domains["io"]["min_ground_pads"]:
        failures.append("insufficient VSSIO pads")
    if power_counts["VDDCORE"] < domains["core"]["min_power_pads"]:
        failures.append("insufficient VDDCORE pads")
    if power_counts["VSSCORE"] < domains["core"]["min_ground_pads"]:
        failures.append("insufficient VSSCORE pads")

    required_missing = sorted(set(contract["required_pins"]) - logical_names)
    if required_missing:
        failures.append("missing required padframe pins: " + ", ".join(required_missing))

    ports = parse_ports(root / contract["rtl_top"])
    missing_from_rtl = sorted(
        (set(contract["required_pins"]) - {"VDDIO", "VSSIO", "VDDCORE", "VSSCORE"}) - ports
    )
    if missing_from_rtl:
        failures.append("padframe required pins missing from RTL: " + ", ".join(missing_from_rtl))

    patterns = pin_order_patterns(root / contract["pin_order"])
    missing_from_pin_order = sorted(
        port for port in ports if not any(pattern.match(port) for pattern in patterns)
    )
    if missing_from_pin_order:
        failures.append(
            "RTL ports missing from pd/pin_order.cfg: " + ", ".join(missing_from_pin_order)
        )

    package_artifacts = contract.get("package_artifacts")
    if not isinstance(package_artifacts, dict):
        failures.append("padframe contract must list package_artifacts")
    else:
        missing_artifacts = sorted(REQUIRED_PACKAGE_ARTIFACTS - set(package_artifacts))
        if missing_artifacts:
            failures.append("package_artifacts missing: " + ", ".join(missing_artifacts))
        for name, artifact in package_artifacts.items():
            if not isinstance(artifact, str):
                failures.append(f"package_artifacts.{name}: path must be a string")
                continue
            artifact_path = Path(artifact)
            if artifact_path.is_absolute() or ".." in artifact_path.parts:
                failures.append(
                    f"package_artifacts.{name}: path must be relative to repo: {artifact}"
                )
                continue
            if not (root / artifact_path).is_file():
                failures.append(f"package_artifacts.{name}: missing artifact {artifact}")

        cross_probe = package_artifacts.get("board_cross_probe")
        if isinstance(cross_probe, str) and (root / cross_probe).is_file():
            failures.extend(
                validate_cross_probe(root, root / cross_probe, contract["package_pins"])
            )

    release_gates = contract.get("release_gates")
    if not isinstance(release_gates, dict):
        failures.append("padframe contract must list release_gates")
    else:
        missing_gates = sorted(REQUIRED_RELEASE_GATES - set(release_gates))
        if missing_gates:
            failures.append("release_gates missing: " + ", ".join(missing_gates))
        for name, gate in release_gates.items():
            if not isinstance(gate, dict):
                failures.append(f"release_gates.{name}: gate must be a mapping")
                continue
            if gate.get("blocked") is not True:
                failures.append(
                    f"release_gates.{name}: must remain explicitly blocked until released"
                )
            if not isinstance(gate.get("reason"), str) or not gate["reason"]:
                failures.append(f"release_gates.{name}: missing reason")

    blockers = contract.get("fabrication_blockers")
    if not isinstance(blockers, list) or not blockers:
        failures.append("padframe contract must list fabrication_blockers")

    if failures:
        print("Padframe contract check failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("padframe contract ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
