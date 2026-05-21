#!/usr/bin/env python3
"""Tests for the traceability spine: graph builder, gate, and change-impact.

Covers requirement-ID validation, graph construction from real seed sources,
fail-closed behavior (dangling links, orphans, unknown gates, expired/valid
waivers, source-doc-sha drift), the per-requirement closure metric, and the
reverse change-impact walk.
"""

from __future__ import annotations

import sys
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import build_traceability_graph as btg  # noqa: E402
import check_traceability as chk  # noqa: E402
import query_change_impact as qci  # noqa: E402


def _real_sha(rel_path: str) -> str:
    import hashlib

    return hashlib.sha256((ROOT / rel_path).read_bytes()).hexdigest()


def _req(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "id": "REQ-SPEC-9001",
        "domain": "SPEC",
        "title": "test requirement",
        "owner": "cpu",
        "source_doc": "docs/spec-db/cpu-2028-target.yaml",
        "source_doc_sha": _real_sha("docs/spec-db/cpu-2028-target.yaml"),
        "status": "target_spec",
        "claim_boundary": "test_boundary",
        "links": {"rtl": ["rtl/npu/e1_npu.sv"], "tests": [], "pd_evidence": [], "mfg_artifacts": []},
        "gates": [],
        "work_order_id": None,
        "waiver": None,
    }
    base.update(overrides)
    return base


class DiGraphTests(unittest.TestCase):
    def test_reverse_reachability(self) -> None:
        g = btg.DiGraph()
        g.add_node("a", "requirement")
        g.add_node("b", "requirement")
        g.add_node("leaf", "rtl")
        g.add_edge("a", "leaf", "links_rtl")
        g.add_edge("b", "leaf", "links_rtl")
        self.assertEqual(g.reachable_predecessors("leaf"), {"a", "b"})

    def test_no_duplicate_edges(self) -> None:
        g = btg.DiGraph()
        g.add_node("a", "x")
        g.add_node("b", "y")
        g.add_edge("a", "b", "r")
        g.add_edge("a", "b", "r")
        self.assertEqual(len(g.edges()), 1)


class RequirementValidationTests(unittest.TestCase):
    def test_rejects_bad_id_format(self) -> None:
        with self.assertRaises(btg.TraceabilityError):
            btg._normalize_requirement(_req(id="REQ-SPEC-1"), "SPEC", Path("x.yaml"))

    def test_rejects_unknown_domain(self) -> None:
        with self.assertRaises(btg.TraceabilityError):
            btg._normalize_requirement(_req(id="REQ-BOGUS-0001"), None, Path("x.yaml"))

    def test_rejects_domain_file_mismatch(self) -> None:
        with self.assertRaises(btg.TraceabilityError):
            btg._normalize_requirement(_req(id="REQ-RTL-0001"), "SPEC", Path("spec.yaml"))

    def test_rejects_missing_required_field(self) -> None:
        bad = _req()
        del bad["owner"]
        with self.assertRaises(btg.TraceabilityError):
            btg._normalize_requirement(bad, "SPEC", Path("x.yaml"))

    def test_rejects_non_string_link(self) -> None:
        bad = _req(links={"rtl": [123], "tests": [], "pd_evidence": [], "mfg_artifacts": []})
        with self.assertRaises(btg.TraceabilityError):
            btg._normalize_requirement(bad, "SPEC", Path("x.yaml"))


class RegistryBuildTests(unittest.TestCase):
    """The real on-disk registry must load and build a valid graph."""

    def test_registry_builds(self) -> None:
        result = btg.build()
        self.assertGreaterEqual(len(result["requirements"]), 1)
        counts = result["serialized"]["counts"]
        self.assertEqual(counts["requirements"], len(result["requirements"]))
        self.assertGreater(counts["edges"], 0)

    def test_real_gate_passes(self) -> None:
        code, coverage, errors = chk.run(write=False)
        self.assertEqual(code, 0, msg=f"unexpected errors: {errors}")
        self.assertEqual(errors, [])
        self.assertEqual(coverage["schema"], chk.COVERAGE_SCHEMA)
        self.assertGreater(coverage["summary"]["requirements"], 0)


class GateFailClosedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.gate_names = {g["name"] for g in btg.load_gate_specs()}
        self.today = date(2026, 5, 21)

    def test_dangling_link_fails(self) -> None:
        req = _req(
            source_doc_sha=_real_sha("docs/spec-db/cpu-2028-target.yaml"),
            links={
                "rtl": ["rtl/does/not/exist.sv"],
                "tests": [],
                "pd_evidence": [],
                "mfg_artifacts": [],
            },
        )
        _, errors = chk.build_coverage([req], self.gate_names, self.today)
        self.assertTrue(any("dangling rtl link" in e for e in errors))

    def test_orphan_requirement_fails(self) -> None:
        req = _req(
            source_doc_sha=_real_sha("docs/spec-db/cpu-2028-target.yaml"),
            links={"rtl": [], "tests": [], "pd_evidence": [], "mfg_artifacts": []},
            gates=[],
        )
        _, errors = chk.build_coverage([req], self.gate_names, self.today)
        self.assertTrue(any("orphan requirement" in e for e in errors))

    def test_unknown_gate_fails(self) -> None:
        req = _req(
            source_doc_sha=_real_sha("docs/spec-db/cpu-2028-target.yaml"),
            gates=["totally-made-up-gate"],
        )
        _, errors = chk.build_coverage([req], self.gate_names, self.today)
        self.assertTrue(any("not in the aggregator GATES inventory" in e for e in errors))

    def test_source_doc_sha_drift_fails(self) -> None:
        req = _req(source_doc_sha="deadbeef" * 8)
        _, errors = chk.build_coverage([req], self.gate_names, self.today)
        self.assertTrue(any("source_doc_sha drift" in e for e in errors))

    def test_expired_waiver_fails(self) -> None:
        req = _req(
            source_doc_sha=_real_sha("docs/spec-db/cpu-2028-target.yaml"),
            links={"rtl": [], "tests": [], "pd_evidence": [], "mfg_artifacts": []},
            gates=[],
            waiver={"owner": "pd", "reason": "blocked", "expiry": "2020-01-01"},
        )
        _, errors = chk.build_coverage([req], self.gate_names, self.today)
        self.assertTrue(any("waiver expired" in e for e in errors))

    def test_valid_waiver_suppresses_orphan(self) -> None:
        req = _req(
            source_doc_sha=_real_sha("docs/spec-db/cpu-2028-target.yaml"),
            links={"rtl": [], "tests": [], "pd_evidence": [], "mfg_artifacts": []},
            gates=[],
            waiver={"owner": "pd", "reason": "blocked", "expiry": "2099-01-01"},
        )
        coverage, errors = chk.build_coverage([req], self.gate_names, self.today)
        self.assertEqual(errors, [])
        self.assertEqual(coverage["summary"]["waived"], 1)

    def test_closure_metric(self) -> None:
        req = _req(
            source_doc_sha=_real_sha("docs/spec-db/cpu-2028-target.yaml"),
            links={
                "rtl": ["rtl/npu/e1_npu.sv"],
                "tests": ["verify/cocotb/test_e1_npu.py"],
                "pd_evidence": [],
                "mfg_artifacts": [],
            },
            gates=["stub-audit"],
        )
        coverage, errors = chk.build_coverage([req], self.gate_names, self.today)
        self.assertEqual(errors, [])
        # rtl + tests + gates resolve (3 of 4 dimensions) => 75%.
        self.assertEqual(coverage["requirements"][0]["closure_pct"], 75.0)


class ChangeImpactTests(unittest.TestCase):
    def setUp(self) -> None:
        self.graph = btg.build()["graph"]

    def test_npu_rtl_impacts_npu_requirements(self) -> None:
        impact = qci.compute_impact(self.graph, "rtl/npu/e1_npu.sv")
        req_ids = {r["id"] for r in impact["invalidated_requirements"]}
        self.assertIn("REQ-SPEC-0003", req_ids)
        self.assertIn("REQ-RTL-0005", req_ids)
        self.assertIn("npu-runtime-contract-check", impact["invalidated_gates"])

    def test_unreferenced_path_has_no_impact(self) -> None:
        impact = qci.compute_impact(self.graph, "rtl/does/not/exist.sv")
        self.assertEqual(impact["artifact_nodes"], [])
        self.assertEqual(impact["impact_count"], 0)

    def test_interconnect_fans_out_to_multiple_domains(self) -> None:
        impact = qci.compute_impact(self.graph, "rtl/interconnect/e1_linux_soc_contract.sv")
        domains = {r["id"].split("-")[1] for r in impact["invalidated_requirements"]}
        self.assertIn("RTL", domains)
        self.assertIn("SPEC", domains)


if __name__ == "__main__":
    unittest.main()
