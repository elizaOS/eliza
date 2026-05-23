#!/usr/bin/env python3
"""Build the fail-closed unblock register for E1 phone readiness."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import yaml


REPO_ROOT = Path(__file__).resolve().parents[3]
CHIP_ROOT = REPO_ROOT / "packages/chip"
BOARD_ROOT = CHIP_ROOT / "board/kicad/e1-phone"
REPORT_REL = "board/kicad/e1-phone/e1-phone-readiness-unblock-register-2026-05-22.yaml"
REPORT_PATH = CHIP_ROOT / REPORT_REL
REPORT_DATE = "2026-05-22"


def load_yaml(path: Path) -> Any:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def exists(rel: str) -> bool:
    return (CHIP_ROOT / rel).exists()


def make_blocker(
    blocker_id: str,
    domain: str,
    owner: str,
    status: str,
    source_artifacts: list[str],
    required_evidence: list[str],
    acceptance_artifacts: list[str],
    next_unblock_action: str,
) -> dict[str, Any]:
    present = [path for path in acceptance_artifacts if exists(path)]
    missing = [path for path in acceptance_artifacts if not exists(path)]
    return {
        "id": blocker_id,
        "domain": domain,
        "owner": owner,
        "status": status,
        "source_artifacts": source_artifacts,
        "required_evidence": required_evidence,
        "acceptance_artifacts": acceptance_artifacts,
        "present_acceptance_artifacts": present,
        "missing_acceptance_artifacts": missing,
        "acceptance_complete": False,
        "next_unblock_action": next_unblock_action,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write-report", action="store_true")
    args = parser.parse_args()

    objective = load_yaml(BOARD_ROOT / "e1-phone-objective-completion-audit-2026-05-22.yaml")
    route_inventory = load_yaml(BOARD_ROOT / "kicad-route-readiness-inventory-2026-05-22.yaml")
    supplier_intake = load_yaml(
        BOARD_ROOT / "production/sourcing/supplier-evidence-outbound-intake-manifest-2026-05-22.yaml"
    )
    production_presence = load_yaml(
        BOARD_ROOT / "production/readiness/production-factory-required-output-presence-inventory-2026-05-22.yaml"
    )
    mechanical = load_yaml(
        CHIP_ROOT / "mechanical/e1-phone/review/mechanical-cad-evidence-inventory-2026-05-22.yaml"
    )
    bench = load_yaml(
        BOARD_ROOT / "production/test/bench-first-article-template-manifest-2026-05-22.yaml"
    )

    supplier_acceptance: list[str] = []
    for record in supplier_intake["template_records"]:
        archives = record.get("expected_return_archives") or [record["expected_return_archive"]]
        for archive in archives:
            archive_dir = str(Path(archive).parent)
            supplier_acceptance.extend(
                f"{archive_dir}/{filename}" for filename in record["required_return_files"]
            )
    supplier_acceptance = sorted(dict.fromkeys(supplier_acceptance))
    route_acceptance = sorted({row["path"] for row in route_inventory["missing_production_outputs"]})
    production_acceptance = sorted(
        {row["path"] for row in production_presence["required_output_presence"]}
    )
    mechanical_acceptance = [
        "board/kicad/e1-phone/production/step/routed-board-with-components.step",
        "board/kicad/e1-phone/production/reports/routed-board-clearance-release.yaml",
        "mechanical/e1-phone/review/supplier-evidence-acceptance.json",
        "mechanical/e1-phone/review/physical-process-validation-acceptance.json",
    ]
    bench_acceptance = sorted(
        {
            record["path"].replace(".template", "")
            for record in bench["template_inventory"]
            if record["path"].endswith((".template.json", ".template.yaml"))
        }
    )

    blockers = [
        make_blocker(
            "supplier_return_packs",
            "supplier",
            "sourcing_ops",
            supplier_intake["status"],
            supplier_intake["source_artifacts"],
            [
                "supplier-returned RFQ response pack for every selected hardware lane",
                "2D drawing, STEP or B-rep, sample lot, lifecycle, stock, and reviewer identity",
                "mapping from supplier evidence into KiCad symbol, footprint, courtyard, and 3D model review",
            ],
            supplier_acceptance,
            "Send/track RFQs and populate returned supplier response packs; do not promote public listings or templates.",
        ),
        make_blocker(
            "routed_board_release",
            "routing",
            "layout_fabrication",
            route_inventory["status"],
            list(route_inventory["inputs"].values()),
            [
                "supplier footprints replace all placeholders",
                "routed KiCad PCB with tracks, vias, filled zones, net classes, and DRC/ERC reports",
                "SI/PI/RF reports and routed-board STEP export using production component models",
            ],
            route_acceptance,
            "Complete supplier footprint capture, route EVT1 board, run ERC/DRC/SI/PI/RF, and export release outputs.",
        ),
        make_blocker(
            "production_factory_outputs",
            "production",
            "manufacturing_ops",
            production_presence["status"],
            [production_presence["inputs"]["production_factory_output_burndown"]],
            [
                "fabrication, assembly, quote, fixture, first-article, and production-release files exist",
                "files are validated for correctness, signatures, freshness, and supplier/factory acceptance",
                "factory limits, probe coordinates, RF calibration, traceability, and commercial quotes are closed",
            ],
            production_acceptance,
            "Generate production/factory outputs from routed board package and selected factory quote workflow.",
        ),
        make_blocker(
            "enclosure_release_evidence",
            "mechanical",
            "mechanical_engineering",
            "blocked_enclosure_evidence_missing",
            [
                "mechanical/e1-phone/review/mechanical-cad-evidence-inventory-2026-05-22.yaml"
            ],
            [
                "routed-board STEP imported into enclosure CAD",
                "routed clearance results and boolean interference checks using supplier B-rep/STEP models",
                "physical fit, lifecycle, GD&T/FAI, process validation, and signed production enclosure handoff",
            ],
            mechanical_acceptance,
            "Replace concept envelope evidence with routed-board and supplier geometry evidence, then rerun clearance and physical validation gates.",
        ),
        make_blocker(
            "first_article_bench_evidence",
            "first_article",
            "manufacturing_validation",
            bench["status"],
            bench["source_artifacts"],
            [
                "executed first-article transcript and traveler",
                "USB-C PD, USB2/ADB, charger CC/CV, side-key force/travel/wake, display, camera, RF, and audio logs",
                "factory limits and probe coordinates derived from measured first articles",
            ],
            bench_acceptance,
            "Run first article on routed hardware and replace templates with executed signed logs and traveler.",
        ),
    ]

    report = {
        "schema": "eliza.e1_phone_readiness_unblock_register.v1",
        "status": "blocked_unblock_register_all_domains_waiting_on_release_evidence",
        "date": REPORT_DATE,
        "claim_boundary": (
            "Action register for reaching fabrication, enclosure, factory, first-article, "
            "and end-to-end phone readiness. It does not itself prove any release state."
        ),
        "source_artifacts": [
            "board/kicad/e1-phone/e1-phone-objective-completion-audit-2026-05-22.yaml",
            "board/kicad/e1-phone/kicad-route-readiness-inventory-2026-05-22.yaml",
            "board/kicad/e1-phone/production/sourcing/supplier-evidence-outbound-intake-manifest-2026-05-22.yaml",
            "board/kicad/e1-phone/production/readiness/production-factory-required-output-presence-inventory-2026-05-22.yaml",
            "mechanical/e1-phone/review/mechanical-cad-evidence-inventory-2026-05-22.yaml",
            "board/kicad/e1-phone/production/test/bench-first-article-template-manifest-2026-05-22.yaml",
        ],
        "summary": {
            "objective_status": objective["status"],
            "blocker_count": len(blockers),
            "complete_blocker_count": sum(1 for item in blockers if item["acceptance_complete"]),
            "open_blocker_count": sum(1 for item in blockers if not item["acceptance_complete"]),
            "acceptance_artifact_count": sum(len(item["acceptance_artifacts"]) for item in blockers),
            "missing_acceptance_artifact_count": sum(
                len(item["missing_acceptance_artifacts"]) for item in blockers
            ),
            "fabrication_ready": False,
            "enclosure_ready": False,
            "end_to_end_phone_ready": False,
        },
        "blockers": blockers,
        "release_policy": {
            "register_is_execution_plan_only": True,
            "release_allowed": False,
            "fabrication_release_allowed": False,
            "enclosure_release_allowed": False,
            "end_to_end_release_allowed": False,
            "all_blockers_must_have_validated_acceptance_artifacts_before_release": True,
        },
        "forbidden_claims": [
            "fabrication_ready",
            "enclosure_ready",
            "factory_ready",
            "first_article_passed",
            "end_to_end_phone_ready",
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
