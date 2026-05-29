#!/usr/bin/env python3
"""Tests for scripts/check_chip_os_bringup_workflow_contract.py."""

from __future__ import annotations

import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import check_chip_os_bringup_workflow_contract as gate  # noqa: E402


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def assert_no_boot_or_release_claims(report: dict) -> None:
    for flag in gate.FALSE_CLAIM_FLAGS:
        assert report[flag] is False, f"{flag} must remain false"


def aggregate_text(gate_names: set[str]) -> str:
    specs = "\n".join(
        f'    GateSpec(name="{name}", script="x.py", subsystem="bsp", tier="spec"),'
        for name in sorted(gate_names)
    )
    return (
        "from dataclasses import dataclass\n"
        "@dataclass\n"
        "class GateSpec:\n"
        "    name: str\n"
        "    script: str\n"
        "    subsystem: str\n"
        "    tier: str\n"
        f"GATES = [\n{specs}\n]\n"
        "release_blocker = False\n"
        "effective_release_blocker = release_blocker\n"
    )


class ChipOsBringupWorkflowContractTests(unittest.TestCase):
    def _patch_tree(self, tmp: Path, *, strict: bool = False):
        if strict:
            makefile = write(
                tmp / "Makefile",
                "chip-os-bring-up-status:\n"
                "\t@$(PYTHON) scripts/check_chip_os_bringup_objective.py --strict --report build/reports/chip-os-bring-up-status.json\n",
            )
            aggregate = write(
                tmp / "scripts/aggregate_tapeout_readiness.py",
                aggregate_text(gate.OBJECTIVE_CRITICAL_GATES).replace(
                    "effective_release_blocker = release_blocker\n", ""
                ),
            )
        else:
            makefile = write(
                tmp / "Makefile",
                "# Unified chip + OS RV64 bring-up dashboard.\n"
                "# It is view-only and preserves the same claim boundary.\n"
                "chip-os-bring-up-status:\n"
                "\t@$(PYTHON) scripts/aggregate_tapeout_readiness.py\n",
            )
            aggregate = write(
                tmp / "scripts/aggregate_tapeout_readiness.py",
                aggregate_text(
                    gate.OBJECTIVE_CRITICAL_GATES - {"android-release-readiness-contract-check"}
                ),
            )
        patches = [
            mock.patch.object(gate, "ROOT", tmp),
            mock.patch.object(gate, "MAKEFILE", makefile),
            mock.patch.object(gate, "AGGREGATE", aggregate),
        ]
        return patches

    def test_view_only_normal_target_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "blocked")
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("chip_os_bringup_target_declared_view_only", codes)
        self.assertIn("chip_os_bringup_target_not_strict", codes)
        self.assertIn("chip_os_bringup_missing_dedicated_report", codes)
        self.assertIn("normal_aggregate_semantics_not_objective_specific", codes)
        self.assertIn("aggregate_missing_objective_critical_gates", codes)
        assert_no_boot_or_release_claims(report)

    def test_strict_dedicated_target_passes_static_checks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir), strict=True)
            with PatchStack(patches):
                report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["findings"], [])
        self.assertEqual(report["claim_boundary"], gate.CLAIM_BOUNDARY)
        assert_no_boot_or_release_claims(report)


class PatchStack:
    def __init__(self, patches):
        self._patches = patches
        self._entered = []

    def __enter__(self):
        for patch in self._patches:
            self._entered.append(patch)
            patch.__enter__()
        return self

    def __exit__(self, exc_type, exc, tb):
        while self._entered:
            self._entered.pop().__exit__(exc_type, exc, tb)


if __name__ == "__main__":
    unittest.main()
