#!/usr/bin/env python3
"""Tests for factory probe map release-output policy mirrors."""

from __future__ import annotations

import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
TRACEABILITY_FLOW = (
    "board/kicad/e1-phone/production/test/fixture-quote/"
    "traceability-and-programming-flow.pdf"
)


def load_yaml(rel_path: str) -> dict:
    with (ROOT / rel_path).open(encoding="utf-8") as handle:
        return yaml.safe_load(handle)


class FactoryProbeMapPolicyTests(unittest.TestCase):
    def test_secure_provisioning_traceability_flow_is_release_required(self) -> None:
        probe = load_yaml("board/kicad/e1-phone/factory-probe-map.yaml")
        acceptance = load_yaml("board/kicad/e1-phone/factory-production-acceptance-checklist.yaml")
        execution = load_yaml("board/kicad/e1-phone/production-factory-release-execution.yaml")

        expected_outputs = probe["fixture_policy"]["outputs_required_before_release"]
        self.assertIn(TRACEABILITY_FLOW, expected_outputs)
        self.assertEqual(
            acceptance["factory_production_summary"]["fixture_outputs_required"],
            expected_outputs,
        )
        self.assertEqual(
            execution["factory_fixture_execution"]["fixture_outputs_required"],
            expected_outputs,
        )


if __name__ == "__main__":
    unittest.main()
