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
        self.assertEqual(
            first["top_blocker_codes"][0]["code"],
            "os_rv64_qemu_system_riscv64_missing",
        )

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
            write_json(matrix, {"status": "pass", "summary": {"proven": len(requirements)}, "requirements": requirements})
            write_json(inventory, {"summary": {}, "detailed_blockers": []})
            report = plan.build_plan(matrix, inventory)
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["summary"]["blocked_phases"], 0)


if __name__ == "__main__":
    unittest.main()
