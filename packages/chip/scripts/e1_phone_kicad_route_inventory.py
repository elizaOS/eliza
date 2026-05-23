#!/usr/bin/env python3
"""Inventory E1 phone KiCad concept-board route readiness.

This script is intentionally fail-closed: it reports what exists in the
current KiCad concept board and what routed-release evidence is still absent.
It does not infer fabrication, enclosure, or routed readiness.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from typing import Any

import yaml

REPO_REL_E1_DIR = Path("packages/chip/board/kicad/e1-phone")
DEFAULT_BOARD = REPO_REL_E1_DIR / "pcb/e1-phone-mainboard-concept.kicad_pcb"
DEFAULT_BURNDOWN = REPO_REL_E1_DIR / "routed-layout-si-drc-burndown-2026-05-22.yaml"
DEFAULT_REPORT = REPO_REL_E1_DIR / "kicad-route-readiness-inventory-2026-05-22.yaml"

PLACEHOLDER_MARKERS = (
    "placeholder",
    "non-release",
    "not_fabrication",
    "replace with supplier land pattern",
)


def repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def extract_blocks(text: str, head: str) -> list[str]:
    """Extract top-level S-expression blocks beginning with two-space head."""
    marker = f"  ({head}"
    blocks: list[str] = []
    start = 0
    while True:
        idx = text.find(marker, start)
        if idx == -1:
            return blocks
        depth = 0
        end = idx
        in_string = False
        escaped = False
        while end < len(text):
            ch = text[end]
            if in_string:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_string = False
            else:
                if ch == '"':
                    in_string = True
                elif ch == "(":
                    depth += 1
                elif ch == ")":
                    depth -= 1
                    if depth == 0:
                        end += 1
                        break
            end += 1
        blocks.append(text[idx:end])
        start = end


def quoted_after(pattern: str, text: str) -> str | None:
    match = re.search(pattern, text)
    return match.group(1) if match else None


def board_inventory(board_text: str) -> dict[str, Any]:
    nets = {
        name
        for _, name in re.findall(r'^\s*\(net\s+(\d+)\s+"([^"]*)"\)', board_text, re.MULTILINE)
        if name
    }
    net_classes = re.findall(r'^\s*\(net_class\s+"([^"]+)"', board_text, re.MULTILINE)
    layers = re.findall(r'^\s*\(\d+\s+"([^"]+)"\s+([^)]+)\)', board_text, re.MULTILINE)
    footprints = extract_blocks(board_text, "footprint ")
    segments = re.findall(r"^\s*\(segment\b", board_text, re.MULTILINE)
    vias = re.findall(r"^\s*\(via\b", board_text, re.MULTILINE)
    zones = extract_blocks(board_text, "zone ")

    placeholder_refs: list[dict[str, str | None]] = []
    footprints_with_3d_models = 0
    footprint_refs: list[str] = []
    test_points = 0
    rf_feeds = 0
    for block in footprints:
        library_id = quoted_after(r'^\s*\(footprint\s+"([^"]+)"', block)
        reference = quoted_after(r'\(fp_text\s+reference\s+"([^"]+)"', block)
        value = quoted_after(r'\(fp_text\s+value\s+"([^"]+)"', block)
        lower_block = block.lower()
        if any(marker in lower_block for marker in PLACEHOLDER_MARKERS):
            placeholder_refs.append(
                {"reference": reference, "value": value, "library_id": library_id}
            )
        if "(model " in block:
            footprints_with_3d_models += 1
        if reference:
            footprint_refs.append(reference)
        if reference and ("TP" in reference or reference.startswith("RFTP")):
            test_points += 1
        if value and "rf" in value.lower():
            rf_feeds += 1

    zone_names = [quoted_after(r'\(name\s+"([^"]+)"\)', zone) for zone in zones]
    return {
        "board_net_count": len(nets),
        "net_names": sorted(nets),
        "net_class_count": len(net_classes),
        "net_classes": sorted(net_classes),
        "layer_count": len(layers),
        "copper_layer_count": sum(1 for _, kind in layers if kind.strip() in {"signal", "power"}),
        "footprint_count": len(footprints),
        "placeholder_footprint_count": len(placeholder_refs),
        "placeholder_footprints": placeholder_refs,
        "footprints_with_3d_models": footprints_with_3d_models,
        "segment_count": len(segments),
        "via_count": len(vias),
        "zone_count": len(zones),
        "filled_zone_count": sum(1 for zone in zones if "(filled_polygon" in zone),
        "keepout_zone_count": sum(1 for zone in zones if "(keepout " in zone),
        "zone_names": [name for name in zone_names if name],
        "test_point_footprint_count": test_points,
        "rf_named_footprint_count": rf_feeds,
    }


def flatten_exact_nets(exact_nets: dict[str, Any]) -> list[str]:
    nets: list[str] = []
    for value in exact_nets.values():
        if isinstance(value, list):
            nets.extend(str(item) for item in value)
        elif isinstance(value, dict):
            nets.extend(flatten_exact_nets(value))
    return nets


def domain_inventory(burndown: dict[str, Any], board_nets: set[str]) -> list[dict[str, Any]]:
    domains = []
    for domain in burndown.get("route_domains", []):
        exact_nets = sorted(set(flatten_exact_nets(domain.get("exact_nets", {}))))
        present = [net for net in exact_nets if net in board_nets]
        missing = [net for net in exact_nets if net not in board_nets]
        domains.append(
            {
                "id": domain["id"],
                "owner": domain.get("owner"),
                "route_classes": domain.get("route_classes", []),
                "exact_net_count": len(exact_nets),
                "exact_nets_present_count": len(present),
                "exact_nets_missing_count": len(missing),
                "missing_exact_nets": missing,
                "source_status": domain.get("status"),
                "route_execution_ready": False,
            }
        )
    return domains


def required_output_inventory(
    root: Path, burndown: dict[str, Any], e1_dir: Path
) -> list[dict[str, Any]]:
    outputs: dict[str, str] = {}
    for item in burndown.get("required_kicad_routed_board_outputs", []):
        outputs[item["path"]] = item.get("required_status", "required")
    for domain in burndown.get("route_domains", []):
        for output in domain.get("required_route_outputs", []):
            outputs[output] = f"required_by_{domain['id']}"

    rows = []
    for rel_path, reason in sorted(outputs.items()):
        resolved = resolve_repo_path(root, e1_dir, rel_path)
        rows.append(
            {
                "path": rel_path,
                "required_status": reason,
                "present": resolved.exists(),
            }
        )
    return rows


def resolve_repo_path(root: Path, e1_dir: Path, rel_path: str) -> Path:
    path = Path(rel_path)
    if path.is_absolute():
        return path
    if rel_path.startswith("packages/"):
        return root / path
    if rel_path.startswith("board/kicad/e1-phone/"):
        return root / "packages/chip" / path
    return e1_dir / path


def build_report(
    root: Path, board_path: Path, burndown_path: Path, report_path: Path
) -> dict[str, Any]:
    board_text = read_text(board_path)
    burndown = yaml.safe_load(read_text(burndown_path))
    board = board_inventory(board_text)
    board_nets = set(board["net_names"])
    domains = domain_inventory(burndown, board_nets)
    outputs = required_output_inventory(root, burndown, board_path.parents[1])

    unresolved_domain_count = sum(1 for domain in domains if domain["exact_nets_missing_count"])
    missing_output_count = sum(1 for output in outputs if not output["present"])
    routing_evidence_absent = (
        board["segment_count"] == 0
        or board["filled_zone_count"] == 0
        or missing_output_count > 0
        or board["placeholder_footprint_count"] > 0
    )

    return {
        "schema": "eliza.e1_phone_kicad_route_readiness_inventory.v1",
        "status": "blocked_current_kicad_concept_board_not_routed_or_fabrication_ready",
        "date": "2026-05-22",
        "claim_boundary": (
            "Inventory of current KiCad concept-board readiness for route planning only. "
            "This report is not DRC, ERC, SI/PI, RF, production-output, routed-STEP, "
            "enclosure, fabrication, or end-to-end phone readiness evidence."
        ),
        "inputs": {
            "board_file": str(board_path.relative_to(root)),
            "routed_layout_burndown": str(burndown_path.relative_to(root)),
            "report_path": str(report_path.relative_to(root)),
        },
        "fail_closed_policy": {
            "route_execution_ready": False,
            "fabrication_ready": False,
            "enclosure_ready": False,
            "end_to_end_phone_ready": False,
            "release_unlock_requires_real_routed_board_clean_drc_erc_supplier_footprints_and_production_outputs": True,
        },
        "current_kicad_inventory": {
            key: value
            for key, value in board.items()
            if key not in {"net_names", "placeholder_footprints"}
        },
        "placeholder_footprints": board["placeholder_footprints"],
        "route_domain_net_inventory": domains,
        "critical_net_summary": {
            "unique_burndown_exact_net_count": len(
                sorted(
                    set(
                        net
                        for domain in burndown.get("route_domains", [])
                        for net in flatten_exact_nets(domain.get("exact_nets", {}))
                    )
                )
            ),
            "unique_burndown_exact_nets_missing_from_board_count": len(
                sorted(set(net for domain in domains for net in domain["missing_exact_nets"]))
            ),
            "domains_with_missing_exact_nets": unresolved_domain_count,
        },
        "missing_production_outputs": [output for output in outputs if not output["present"]],
        "summary": {
            "segments_present": board["segment_count"] > 0,
            "filled_zones_present": board["filled_zone_count"] > 0,
            "placeholder_footprints_present": board["placeholder_footprint_count"] > 0,
            "missing_required_output_count": missing_output_count,
            "routing_evidence_absent_or_incomplete": routing_evidence_absent,
            "release_state": "blocked_fail_closed",
        },
        "forbidden_claims": [
            "routed_pcb_ready",
            "drc_clean",
            "erc_clean",
            "si_pi_closed",
            "manufacturing_outputs_ready",
            "routed_step_ready",
            "enclosure_ready",
            "fabrication_ready",
            "end_to_end_phone_ready",
        ],
    }


def parse_args() -> argparse.Namespace:
    root = repo_root()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--board", type=Path, default=root / DEFAULT_BOARD)
    parser.add_argument("--burndown", type=Path, default=root / DEFAULT_BURNDOWN)
    parser.add_argument("--report", type=Path, default=root / DEFAULT_REPORT)
    parser.add_argument(
        "--write-report",
        action="store_true",
        help="Write the YAML report to --report instead of printing to stdout.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = repo_root()
    report = build_report(root, args.board, args.burndown, args.report)
    text = yaml.safe_dump(report, sort_keys=False, width=100)
    if args.write_report:
        args.report.write_text(text, encoding="utf-8")
    else:
        print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
