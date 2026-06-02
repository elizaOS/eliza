#!/usr/bin/env python3
"""Validate AXI-Lite formal coverage recorded in the formal manifest."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FORMAL_MANIFEST = ROOT / "build/reports/formal_manifest.json"
REPORT = ROOT / "build/reports/axil_formal_coverage.json"

REQUIRED_TARGETS = {
    "e1_dbg_mmio_bridge": {
        "status": "pass",
        "evidence_class": "sby_bmc",
        "spec": "verify/formal/e1_dbg_mmio_bridge.sby",
        "covered_files": {
            "rtl/debug/e1_dbg_mmio_bridge.sv",
            "verify/formal/e1_dbg_mmio_bridge_formal.sv",
        },
        "tasks": {"default": {"mode": "bmc", "depth": "16"}},
    },
    "e1_dma_axil": {
        "status": "pass",
        "evidence_class": "sby_bmc",
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
    "e1_axi_lite_dram": {
        "status": "pass",
        "evidence_class": "sby_bmc",
        "spec": "verify/formal/e1_axi_lite_dram.sby",
        "covered_files": {
            "verify/properties/axi_lite_protocol.sv",
            "rtl/memory/e1_axi_lite_dram.sv",
            "verify/formal/e1_axi_lite_dram_bind.sv",
        },
        "tasks": {
            "bmc": {"mode": "bmc", "depth": "24"},
            "prove": {"mode": "prove", "depth": "16"},
        },
    },
    "e1_axi_lite_interconnect": {
        "status": "pass",
        "evidence_class": "sby_bmc",
        "spec": "verify/formal/e1_axi_lite_interconnect.sby",
        "covered_files": {
            "verify/properties/axi_lite_protocol.sv",
            "rtl/interconnect/e1_axi_lite_interconnect.sv",
            "verify/formal/e1_axi_lite_interconnect_bind.sv",
        },
        "tasks": {
            "bmc": {"mode": "bmc", "depth": "24"},
            "prove": {"mode": "prove", "depth": "12"},
        },
    },
    "e1_interrupt_controller": {
        "status": "pass",
        "evidence_class": "sby_bmc",
        "spec": "verify/formal/e1_interrupt_controller.sby",
        "covered_files": {
            "verify/properties/axi_lite_protocol.sv",
            "rtl/interrupts/e1_interrupt_controller.sv",
            "verify/formal/e1_interrupt_controller_bind.sv",
        },
        "tasks": {
            "bmc": {"mode": "bmc", "depth": "24"},
            "prove": {"mode": "prove", "depth": "16"},
        },
    },
}


def jsonable_required_targets() -> dict:
    result = {}
    for name, expected in REQUIRED_TARGETS.items():
        item = dict(expected)
        item["covered_files"] = sorted(expected["covered_files"])
        result[name] = item
    return result


def write_report(status: str, errors: list[str], manifest: dict | None) -> None:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(
        json.dumps(
            {
                "schema": "eliza.axil_formal_coverage.v1",
                "status": status,
                "as_of": datetime.now(UTC).isoformat(),
                "generated_utc": datetime.now(UTC).isoformat(),
                "subsystem": "interconnect",
                "evidence_paths": [
                    "build/reports/formal_manifest.json",
                    "verify/properties/axi_lite_protocol.sv",
                    "verify/formal/e1_dbg_mmio_bridge.sby",
                    "verify/formal/e1_dma_axil.sby",
                    "verify/formal/e1_axi_lite_dram.sby",
                    "verify/formal/e1_axi_lite_interconnect.sby",
                    "verify/formal/e1_interrupt_controller.sby",
                ],
                "phone_claim_allowed": False,
                "release_claim_allowed": False,
                "full_soc_routing_claim_allowed": False,
                "unbounded_protocol_claim_allowed": False,
                "coherency_claim_allowed": False,
                "claim_boundary": (
                    "Checks that the formal manifest records passing AXI-Lite "
                    "formal targets for the debug bridge, DMA master, DRAM target, "
                    "interconnect ingress ports, and interrupt-controller target, "
                    "with expected SBY specs, covered files, task depths, status/log "
                    "hashes, and strict non-release manifest flags. This is bounded "
                    "local AXI-Lite protocol evidence only; it is not full SoC routing, "
                    "unbounded liveness, coherency, QoS, production fabric, or release "
                    "evidence."
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

    _paths_raw = entry.get("paths")
    paths: dict[str, object] = _paths_raw if isinstance(_paths_raw, dict) else {}
    for key in ("status", "status_sha256", "log", "log_sha256"):
        if key not in paths:
            errors.append(f"{name} paths missing {key}")

    _sby_raw = entry.get("sby")
    sby: dict[str, object] = _sby_raw if isinstance(_sby_raw, dict) else {}
    if sby.get("spec") != expected["spec"]:
        errors.append(f"{name} spec must be {expected['spec']}")
    _covered_raw = sby.get("covered_files")
    covered = set(_covered_raw) if isinstance(_covered_raw, (list, set)) else set()
    missing_files = sorted(expected["covered_files"] - covered)
    if missing_files:
        errors.append(f"{name} missing covered_files: {', '.join(missing_files)}")
    if not sby.get("engines"):
        errors.append(f"{name} must record at least one formal engine")

    _tasks_raw = sby.get("tasks")
    tasks: dict[str, object] = _tasks_raw if isinstance(_tasks_raw, dict) else {}
    for task, task_expected in expected["tasks"].items():
        task_meta = tasks.get(task)
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
        errors.append("AXI-Lite formal coverage check requires non-release routine formal manifest")

    entries = manifest.get("entries") if isinstance(manifest.get("entries"), dict) else {}
    for name, expected in REQUIRED_TARGETS.items():
        entry = entries.get(name)
        if not isinstance(entry, dict):
            errors.append(f"formal manifest missing {name}")
            continue
        errors.extend(validate_target(name, entry, expected))

    if errors:
        write_report("BLOCKED", errors, manifest)
        print("BLOCKED: AXI-Lite formal coverage check failed")
        for error in errors:
            print(f"  - {error}")
        return 1

    write_report("PASS", [], manifest)
    print("PASS: AXI-Lite formal coverage manifest check")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
