#!/usr/bin/env python3
"""Tests for scripts/check_chip_os_closure_plan.py."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import check_chip_os_closure_plan as plan


def write_json(path: Path, data: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data) + "\n", encoding="utf-8")


class ChipOsClosurePlanTests(unittest.TestCase):
    def test_build_plan_orders_first_blocked_phase(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            matrix = root / "matrix.json"
            inventory = root / "inventory.json"
            write_json(
                matrix,
                {
                    "status": "blocked",
                    "summary": {"blocked": 1},
                    "requirements": [
                        {
                            "id": "aggregate_blocker_traceability",
                            "proof_state": "proven",
                            "source_report": "build/reports/inventory.json",
                            "current_status": "blocked",
                        },
                        {
                            "id": "os_rv64_qemu_tooling",
                            "proof_state": "blocked",
                            "source_report": "build/reports/qemu_virt_smoke.json",
                            "current_status": "blocked",
                        },
                    ],
                },
            )
            write_json(
                inventory,
                {
                    "summary": {"detailed_blocker_entries": 1},
                    "detailed_blockers": [
                        {
                            "source_report": "build/reports/qemu_virt_smoke.json",
                            "code": "os_rv64_qemu_system_riscv64_missing",
                            "message": "qemu-system-riscv64 missing",
                            "next_step": "install qemu",
                        }
                    ],
                },
            )
            report = plan.build_plan(matrix, inventory)
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["summary"]["first_blocked_phase"], "p0_workflow_evidence_plumbing")
        first = report["phases"][0]
        self.assertEqual(first["open_requirement_count"], 1)
        self.assertEqual(first["open_source_reports"], ["build/reports/qemu_virt_smoke.json"])
        self.assertEqual(first["open_requirements"][0]["id"], "os_rv64_qemu_tooling")
        self.assertEqual(
            first["top_blocker_codes"][0]["code"],
            "os_rv64_qemu_system_riscv64_missing",
        )

    def test_phase_blocker_rollup_uses_open_requirements_first(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            matrix = root / "matrix.json"
            inventory = root / "inventory.json"
            source_report = root / "build/reports/qemu_virt_smoke.json"
            write_json(
                source_report,
                {
                    "findings": [
                        {
                            "code": "qemu_source_finding",
                            "message": "source report message",
                            "next_step": "source report next step",
                            "capture_command": "run qemu capture",
                            "suggested_export": "export QEMU=1",
                        }
                    ]
                },
            )
            write_json(
                matrix,
                {
                    "status": "blocked",
                    "summary": {"blocked": 1, "proven": 1},
                    "requirements": [
                        {
                            "id": "aggregate_blocker_traceability",
                            "proof_state": "proven",
                            "source_report": "build/reports/inventory.json",
                            "current_status": "blocked",
                            "source_finding_codes": ["should_not_lead"],
                        },
                        {
                            "id": "os_rv64_qemu_tooling",
                            "proof_state": "blocked",
                            "source_report": "build/reports/qemu_virt_smoke.json",
                            "current_status": "blocked",
                            "closure_evidence": "qemu smoke must pass",
                            "source_finding_codes": ["qemu_source_finding"],
                        },
                    ],
                },
            )
            write_json(
                inventory,
                {
                    "summary": {"detailed_blocker_entries": 2},
                    "detailed_blockers": [
                        {
                            "source_report": "build/reports/inventory.json",
                            "code": "proven_inventory_detail",
                            "message": "inventory status is blocked but requirement is proven",
                            "next_step": "do not lead with this",
                        },
                        {
                            "source_report": "build/reports/qemu_virt_smoke.json",
                            "code": "qemu_missing",
                            "message": "qemu missing",
                            "next_step": "install qemu",
                        },
                    ],
                },
            )
            report = plan.build_plan(matrix, inventory)
        first = report["phases"][0]
        codes = [row["code"] for row in first["top_blocker_codes"]]
        self.assertEqual(codes[0], "qemu_missing")
        self.assertIn("qemu_source_finding", codes)
        self.assertNotIn("proven_inventory_detail", codes)
        self.assertNotIn("should_not_lead", codes)
        source_row = next(
            row for row in first["top_blocker_codes"] if row["code"] == "qemu_source_finding"
        )
        self.assertEqual(source_row["message"], "source report message")
        self.assertEqual(source_row["next_step"], "source report next step")
        self.assertEqual(source_row["capture_command"], "run qemu capture")
        self.assertEqual(source_row["suggested_export"], "export QEMU=1")

    def test_all_proven_closes_phases(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            matrix = root / "matrix.json"
            inventory = root / "inventory.json"
            requirements = []
            for phase in plan.PHASES:
                for ident in phase.requirement_ids:
                    requirements.append(
                        {
                            "id": ident,
                            "proof_state": "proven",
                            "source_report": "build/reports/ok.json",
                            "current_status": "pass",
                        }
                    )
            write_json(
                matrix,
                {
                    "status": "pass",
                    "summary": {"proven": len(requirements)},
                    "requirements": requirements,
                },
            )
            write_json(inventory, {"summary": {}, "detailed_blockers": []})
            report = plan.build_plan(matrix, inventory)
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["summary"]["blocked_phases"], 0)


if __name__ == "__main__":
    unittest.main()
