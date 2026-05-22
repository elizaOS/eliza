#!/usr/bin/env python3
"""Emit a fail-closed objective audit for E1 phone release readiness."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import yaml


REPO_ROOT = Path(__file__).resolve().parents[3]
CHIP_ROOT = REPO_ROOT / "packages/chip"
BOARD_ROOT = CHIP_ROOT / "board/kicad/e1-phone"
REPORT_REL = "board/kicad/e1-phone/e1-phone-objective-completion-audit-2026-05-22.yaml"
REPORT_PATH = CHIP_ROOT / REPORT_REL


def load_yaml(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def path_exists(rel: str) -> bool:
    return (CHIP_ROOT / rel).exists()


def required_output_presence(required_outputs: list[str]) -> dict[str, Any]:
    present = [rel for rel in required_outputs if path_exists(rel)]
    missing = [rel for rel in required_outputs if not path_exists(rel)]
    return {
        "required_count": len(required_outputs),
        "present_count": len(present),
        "missing_count": len(missing),
        "present": present,
        "missing": missing,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write-report", action="store_true")
    args = parser.parse_args()

    manifest = load_yaml(BOARD_ROOT / "artifact-manifest.yaml")
    route_inventory = load_yaml(BOARD_ROOT / "kicad-route-readiness-inventory-2026-05-22.yaml")
    supplier_intake = load_yaml(
        BOARD_ROOT / "production/sourcing/supplier-evidence-outbound-intake-manifest-2026-05-22.yaml"
    )
    production_burndown = load_yaml(
        BOARD_ROOT / "production-factory-output-burndown-2026-05-22.yaml"
    )
    mechanical_burndown = load_yaml(
        BOARD_ROOT / "enclosure-mechanical-release-burndown-2026-05-22.yaml"
    )
    bench_templates = load_yaml(
        BOARD_ROOT / "production/test/bench-first-article-template-manifest-2026-05-22.yaml"
    )

    release_gates = manifest["release_gates"]
    route_counts = route_inventory["current_kicad_inventory"]
    production_required_outputs: list[str] = []
    for item in production_burndown["execution_burndown"]:
        production_required_outputs.extend(item.get("required_outputs", []))
        production_required_outputs.extend(item.get("required_common_outputs", []))
        production_required_outputs.extend(item.get("required_functional_transcripts", []))
    production_required_outputs = sorted(dict.fromkeys(production_required_outputs))

    objective_requirements = [
        {
            "id": "fabrication_ready",
            "required_evidence": [
                "schematic ERC clean or signed waivers",
                "routed KiCad PCB with production footprints and copper",
                "DRC clean or signed waivers",
                "Gerber or IPC-2581, drill, BOM, placement, assembly, stackup, and quote outputs",
            ],
            "authoritative_sources": [
                "board/kicad/e1-phone/artifact-manifest.yaml",
                "board/kicad/e1-phone/routed-release-plan.yaml",
                "board/kicad/e1-phone/routed-pcb-implementation-execution.yaml",
                "board/kicad/e1-phone/kicad-route-readiness-inventory-2026-05-22.yaml",
                "board/kicad/e1-phone/production-factory-output-burndown-2026-05-22.yaml",
            ],
            "evidence_state": "contradicts_completion",
            "blocking_facts": [
                f"artifact manifest routed_pcb gate is {release_gates['routed_pcb']['status']}",
                f"live PCB has {route_counts['placeholder_footprint_count']} placeholder footprints",
                f"live PCB has {route_counts['segment_count']} routed segments and {route_counts['filled_zone_count']} filled zones",
                "production/factory burndown reports zero present fabrication outputs",
            ],
            "complete": False,
        },
        {
            "id": "enclosure_ready",
            "required_evidence": [
                "routed-board STEP with supplier 3D models",
                "clearance and tolerance stack using routed board geometry",
                "USB-C insertion load path, side-key load path, and physical-fit first article evidence",
                "production enclosure handoff accepted by mechanical and factory owners",
            ],
            "authoritative_sources": [
                "board/kicad/e1-phone/artifact-manifest.yaml",
                "board/kicad/e1-phone/enclosure-mechanical-release-burndown-2026-05-22.yaml",
                "../../mechanical/e1-phone/review/mechanical-intake-template-manifest-2026-05-22.yaml",
            ],
            "evidence_state": "contradicts_completion",
            "blocking_facts": [
                f"artifact manifest enclosure gate is {release_gates['enclosure']['status']}",
                mechanical_burndown["upstream_status"]["routed_board_step_export_contract"],
                mechanical_burndown["upstream_status"]["enclosure_physical_fit_first_article_execution"],
                "mechanical intake files are templates only and contain no signed routed-board fit evidence",
            ],
            "complete": False,
        },
        {
            "id": "end_to_end_phone_ready",
            "required_evidence": [
                "selected display, camera, USB-C, power, side-key, cellular, Wi-Fi/Bluetooth, audio, haptic, and split-interconnect hardware identities",
                "supplier response packs and samples accepted",
                "factory limits, first-article traveler, functional transcripts, RF logs, and traceability",
                "post-route validation across SI, PI, RF, power, thermal, enclosure, and manufacturing",
            ],
            "authoritative_sources": [
                "board/kicad/e1-phone/end-to-end-readiness.yaml",
                "board/kicad/e1-phone/supplier-sample-release-gate.yaml",
                "board/kicad/e1-phone/selected-hardware-first-article-execution.yaml",
                "board/kicad/e1-phone/production/test/bench-first-article-template-manifest-2026-05-22.yaml",
            ],
            "evidence_state": "contradicts_completion",
            "blocking_facts": [
                f"supplier intake status is {supplier_intake['status']}",
                "supplier templates are outbound/intake scaffolds, not returned supplier evidence",
                f"bench template status is {bench_templates['status']}",
                "first-article logs and traveler are templates only, not executed evidence",
            ],
            "complete": False,
        },
    ]

    report = {
        "schema": "eliza.e1_phone_objective_completion_audit.v1",
        "status": "blocked_objective_not_complete",
        "date": "2026-05-22",
        "claim_boundary": (
            "Machine-generated completion audit for the user objective. This report "
            "does not release fabrication, enclosure, factory, first-article, or "
            "end-to-end phone readiness; it records current evidence and fail-closed blockers."
        ),
        "objective": "get the e1 chip and phone to fabrication ready, enclosure ready, end to end phone ready",
        "source_artifacts": [
            "board/kicad/e1-phone/artifact-manifest.yaml",
            "board/kicad/e1-phone/kicad-route-readiness-inventory-2026-05-22.yaml",
            "board/kicad/e1-phone/production/sourcing/supplier-evidence-outbound-intake-manifest-2026-05-22.yaml",
            "board/kicad/e1-phone/production-factory-output-burndown-2026-05-22.yaml",
            "board/kicad/e1-phone/enclosure-mechanical-release-burndown-2026-05-22.yaml",
            "board/kicad/e1-phone/production/test/bench-first-article-template-manifest-2026-05-22.yaml",
        ],
        "summary": {
            "objective_requirement_count": len(objective_requirements),
            "completed_requirement_count": sum(1 for item in objective_requirements if item["complete"]),
            "blocked_requirement_count": sum(1 for item in objective_requirements if not item["complete"]),
            "fabrication_ready": False,
            "enclosure_ready": False,
            "end_to_end_phone_ready": False,
            "goal_complete": False,
        },
        "live_pcb_evidence": {
            "board_file": route_inventory["inputs"]["board_file"],
            "footprint_count": route_counts["footprint_count"],
            "placeholder_footprint_count": route_counts["placeholder_footprint_count"],
            "segment_count": route_counts["segment_count"],
            "via_count": route_counts["via_count"],
            "filled_zone_count": route_counts["filled_zone_count"],
            "release_state": route_inventory["summary"]["release_state"],
        },
        "production_output_presence": required_output_presence(production_required_outputs),
        "objective_requirements": objective_requirements,
        "release_policy": {
            "fabrication_release_allowed": False,
            "enclosure_release_allowed": False,
            "factory_release_allowed": False,
            "end_to_end_release_allowed": False,
            "fail_closed_until_all_requirements_have_authoritative_evidence": True,
        },
        "forbidden_claims": [
            "fabrication_ready",
            "enclosure_ready",
            "factory_ready",
            "first_article_passed",
            "end_to_end_phone_ready",
            "goal_complete",
        ],
    }

    if args.write_report:
        REPORT_PATH.write_text(yaml.safe_dump(report, sort_keys=False), encoding="utf-8")
        print(f"wrote {REPORT_PATH}")
    else:
        print(yaml.safe_dump(report, sort_keys=False), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
