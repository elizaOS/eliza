#!/usr/bin/env python3
"""Validate DMA-focused formal evidence in the formal manifest."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FORMAL_MANIFEST = ROOT / "build/reports/formal_manifest.json"
REPORT = ROOT / "build/reports/dma_formal_coverage.json"

REQUIRED_TARGETS = {
    "e1_dma": {
        "evidence_class": "sby_bmc",
        "status": "pass",
        "spec": "verify/formal/e1_dma.sby",
        "covered_files": {
            "rtl/dma/e1_dma.sv",
            "verify/formal/e1_dma_formal.sv",
        },
    },
    "e1_dma_axil": {
        "evidence_class": "sby_bmc",
        "status": "pass",
        "spec": "verify/formal/e1_dma_axil.sby",
        "covered_files": {
            "verify/properties/axi_lite_protocol.sv",
            "rtl/dma/e1_dma.sv",
            "verify/properties/dma_axil_bind.sv",
        },
        "tasks": {
            "bmc": {"mode": "bmc", "depth": "32"},
            "prove": {"mode": "prove", "depth": "16"},
        },
    },
}


def jsonable_required_targets() -> dict:
    converted = {}
    for name, expected in REQUIRED_TARGETS.items():
        item = dict(expected)
        item["covered_files"] = sorted(expected["covered_files"])
        converted[name] = item
    return converted


def write_report(status: str, errors: list[str], manifest: dict | None) -> None:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(
        json.dumps(
            {
                "schema": "eliza.dma_formal_coverage.v1",
                "status": status,
                "as_of": datetime.now(UTC).isoformat(),
                "generated_utc": datetime.now(UTC).isoformat(),
                "subsystem": "dma",
                "evidence_paths": [
                    "build/reports/formal_manifest.json",
                    "verify/formal/e1_dma.sby",
                    "verify/formal/e1_dma_formal.sv",
                    "verify/formal/e1_dma_axil.sby",
                    "verify/properties/dma_axil_bind.sv",
                    "verify/properties/axi_lite_protocol.sv",
                ],
                "phone_claim_allowed": False,
                "release_claim_allowed": False,
                "full_dma_correctness_claim_allowed": False,
                "coherent_dma_claim_allowed": False,
                "linux_dmaengine_driver_claim_allowed": False,
                "claim_boundary": (
                    "Checks that the formal manifest contains passing DMA status/accounting "
                    "and AXI-Lite master protocol targets with expected SBY specs, covered "
                    "files, solver/task metadata, and strict non-release manifest flags. "
                    "This is bounded local formal evidence only; it is not full DMA "
                    "correctness, coherent DMA, Linux dmaengine driver, SoC-fabric, IOMMU, "
                    "or release evidence."
                ),
                "required_targets": jsonable_required_targets(),
                "formal_manifest_mode": None if manifest is None else manifest.get("mode"),
                "errors": errors,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )


def validate_target(name: str, entry: dict, expected: dict) -> list[str]:
    errors: list[str] = []
    if entry.get("status") != expected["status"]:
        errors.append(f"{name} status must be {expected['status']}")
    if entry.get("evidence_class") != expected["evidence_class"]:
        errors.append(f"{name} evidence_class must be {expected['evidence_class']}")

    paths = entry.get("paths") if isinstance(entry.get("paths"), dict) else {}
    for key in ("status", "status_sha256", "log", "log_sha256"):
        if key not in paths:
            errors.append(f"{name} paths missing {key}")

    sby = entry.get("sby") if isinstance(entry.get("sby"), dict) else {}
    if sby.get("spec") != expected["spec"]:
        errors.append(f"{name} spec must be {expected['spec']}")
    covered = set(sby.get("covered_files") or [])
    missing_files = sorted(expected["covered_files"] - covered)
    if missing_files:
        errors.append(f"{name} missing covered_files: {', '.join(missing_files)}")
    if "smtbmc bitwuzla" not in set(sby.get("engines") or []):
        errors.append(f"{name} must record smtbmc bitwuzla engine")

    for task, task_expected in expected.get("tasks", {}).items():
        task_meta = (sby.get("tasks") or {}).get(task)
        if not isinstance(task_meta, dict):
            errors.append(f"{name} missing task {task}")
            continue
        for key, value in task_expected.items():
            if str(task_meta.get(key)) != value:
                errors.append(f"{name} task {task} {key} must be {value}")
    return errors


def main() -> int:
    if not FORMAL_MANIFEST.is_file():
        write_report("BLOCKED", [f"missing {FORMAL_MANIFEST.relative_to(ROOT)}"], None)
        print("BLOCKED: formal manifest missing")
        return 1

    manifest = json.loads(FORMAL_MANIFEST.read_text(encoding="utf-8"))
    errors: list[str] = []
    if manifest.get("fallback_equivalent_to_sby") is not False:
        errors.append("formal manifest must keep fallback_equivalent_to_sby=false")
    if manifest.get("deep_top_required_for_release") is not True:
        errors.append("formal manifest must keep deep_top_required_for_release=true")
    if manifest.get("strict_release_claim_allowed") is not False:
        errors.append("DMA formal coverage check requires non-release routine formal manifest")

    entries = manifest.get("entries") if isinstance(manifest.get("entries"), dict) else {}
    for name, expected in REQUIRED_TARGETS.items():
        entry = entries.get(name)
        if not isinstance(entry, dict):
            errors.append(f"formal manifest missing {name}")
            continue
        errors.extend(validate_target(name, entry, expected))

    if errors:
        write_report("BLOCKED", errors, manifest)
        print("BLOCKED: DMA formal coverage check failed")
        for error in errors:
            print(f"  - {error}")
        return 1

    write_report("PASS", [], manifest)
    print("PASS: DMA formal coverage manifest check")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
