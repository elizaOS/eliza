#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest import mock

import check_cache_coherence as coherence
import check_cache_hierarchy as cache
import yaml


def valid_scoped_artifact() -> dict:
    return {
        "schema": "eliza.cache.local.v1",
        "status": "scoped_local",
        "evidence_class": "local_scoped_class",
        "captured_utc": datetime.now(UTC).isoformat(),
        "claim_boundary": "Local cache evidence only; not phone, silicon, or release evidence.",
        "phone_claim_allowed": False,
        "release_claim_allowed": False,
        "false_claim_flags": cache.FALSE_CLAIM_FLAGS,
        "provenance": {
            "source_artifacts": [
                {
                    "path": "sources/local-cache-source.txt",
                    "sha256": hashlib.sha256(b"local cache source\n").hexdigest(),
                }
            ]
        },
    }


def valid_gate() -> dict:
    return {
        "schema": "eliza.cache_hierarchy_evidence_gate.v1",
        "status": "scaffold_rtl_real_claims_blocked",
        "phone_2028_minimums": {
            "l1i_kib_min": 32,
            "l1d_kib_min": 32,
            "l2_kib_min": 256,
            "l3_mib_min": 4,
            "slc_mib_min": 8,
            "line_bytes": 64,
        },
        "blocked_real_claims": [
            {
                "id": "blocked_phone_claim",
                "status": "blocked",
                "evidence_artifacts": ["docs/evidence/cache/blocked.json"],
            }
        ],
        "current_scaffold_evidence": {
            "executable_checks": [
                {
                    "name": "cache_hierarchy_claim_gate",
                    "command": "make cache-hierarchy-claim-gate",
                },
                {"name": "rtl_lint", "command": "make rtl-check"},
                {
                    "name": "cocotb_cache_coherence",
                    "command": "make cocotb-cache-coherence",
                },
            ]
        },
        "scoped_local_evidence_claims": [
            {
                "id": "local_scoped_claim",
                "status": "scoped_local",
                "evidence_class": "local_scoped_class",
                "evidence_artifacts": ["docs/evidence/cache/local.json"],
            }
        ],
        "required_artifact_schemas": {
            "docs/evidence/cache/blocked.json": "eliza.cache.blocked.v1",
            "docs/evidence/cache/local.json": "eliza.cache.local.v1",
        },
    }


class CacheHierarchyGateTest(unittest.TestCase):
    def run_gate(self, gate_data: dict, artifact_data: dict) -> list[str]:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence_dir = root / "docs/evidence/cache"
            evidence_dir.mkdir(parents=True)
            source = root / "sources/local-cache-source.txt"
            source.parent.mkdir(parents=True)
            source.write_text("local cache source\n", encoding="utf-8")
            gate_path = evidence_dir / "cache-evidence-gate.yaml"
            gate_path.write_text(yaml.safe_dump(gate_data), encoding="utf-8")
            (evidence_dir / "local.json").write_text(json.dumps(artifact_data), encoding="utf-8")

            errors: list[str] = []
            with (
                mock.patch.object(cache, "ROOT", root),
                mock.patch.object(cache, "GATE", gate_path),
                mock.patch.object(cache, "REQUIRED_BLOCKED_IDS", {"blocked_phone_claim"}),
                mock.patch.object(
                    cache,
                    "REQUIRED_SCOPED_EVIDENCE_IDS",
                    {"local_scoped_claim": "local_scoped_class"},
                ),
            ):
                cache.check_gate_yaml(errors)
            return errors

    def test_scoped_artifact_schema_timestamp_and_claim_boundary_pass(self) -> None:
        self.assertEqual(self.run_gate(valid_gate(), valid_scoped_artifact()), [])

    def test_scoped_artifact_without_timestamp_is_rejected(self) -> None:
        artifact = valid_scoped_artifact()
        del artifact["captured_utc"]

        errors = self.run_gate(valid_gate(), artifact)

        self.assertTrue(any("captured_utc" in error for error in errors), errors)

    def test_scoped_artifact_generic_status_is_rejected(self) -> None:
        artifact = valid_scoped_artifact()
        artifact["status"] = "ok"

        errors = self.run_gate(valid_gate(), artifact)

        self.assertTrue(
            any("status must explicitly be scoped" in error for error in errors), errors
        )

    def test_scoped_artifact_without_claim_flags_is_rejected(self) -> None:
        artifact = valid_scoped_artifact()
        artifact["phone_claim_allowed"] = True

        errors = self.run_gate(valid_gate(), artifact)

        self.assertTrue(
            any("phone_claim_allowed must be false" in error for error in errors),
            errors,
        )

    def test_scoped_artifact_without_nested_false_claim_flags_is_rejected(self) -> None:
        artifact = valid_scoped_artifact()
        del artifact["false_claim_flags"]

        errors = self.run_gate(valid_gate(), artifact)

        self.assertTrue(any("false_claim_flags" in error for error in errors), errors)

    def test_artifact_schema_mapping_gap_is_rejected(self) -> None:
        gate = valid_gate()
        del gate["required_artifact_schemas"]["docs/evidence/cache/local.json"]

        errors = self.run_gate(gate, valid_scoped_artifact())

        self.assertTrue(any("required_artifact_schemas" in error for error in errors), errors)

    def test_blocked_claim_without_artifact_list_is_rejected(self) -> None:
        gate = valid_gate()
        gate["blocked_real_claims"][0]["evidence_artifacts"] = []
        del gate["required_artifact_schemas"]["docs/evidence/cache/blocked.json"]

        errors = self.run_gate(gate, valid_scoped_artifact())

        self.assertTrue(
            any("must list at least one blocked evidence artifact" in error for error in errors),
            errors,
        )

    def test_scoped_artifact_source_hash_mismatch_is_rejected(self) -> None:
        artifact = valid_scoped_artifact()
        artifact["provenance"]["source_artifacts"][0]["sha256"] = "0" * 64

        errors = self.run_gate(valid_gate(), artifact)

        self.assertTrue(any("source hash mismatch" in error for error in errors), errors)

    def test_unknown_executable_check_id_is_rejected(self) -> None:
        gate = valid_gate()
        gate["current_scaffold_evidence"]["executable_checks"].append(
            {"name": "stale_cache_smoke", "command": "make stale-cache-smoke"}
        )

        errors = self.run_gate(gate, valid_scoped_artifact())

        self.assertTrue(any("unexpected executable check id" in error for error in errors), errors)

    def test_legacy_measured_real_claims_key_is_rejected(self) -> None:
        gate = valid_gate()
        gate["measured_real_claims"] = gate.pop("scoped_local_evidence_claims")

        errors = self.run_gate(gate, valid_scoped_artifact())

        self.assertTrue(any("legacy measured_real_claims" in error for error in errors), errors)

    def test_champsim_sweep_rejects_missing_variant_result(self) -> None:
        artifact = {
            **valid_scoped_artifact(),
            "schema": "eliza.cache.champsim_prefetch_sweep.v1",
            "trace_count": 1,
            "trace_files": ["trace.xz"],
            "variants_requested": ["no", "ip_stride"],
            "variants_missing": [],
            "results": [
                {
                    "trace": "trace.xz",
                    "label": "no",
                    "returncode": 0,
                    "parsed": True,
                    "ipc": 1.0,
                    "instructions": 1,
                    "cycles": 1,
                    "llc_mpki": 1.0,
                    "l2c_mpki": 1.0,
                    "json_path": "build/no.json",
                    "log_path": "build/no.log",
                }
            ],
            "aggregate": {
                "no": {
                    "runs": 1,
                    "parsed_runs": 1,
                    "mean_ipc": 1.0,
                    "mean_llc_mpki": 1.0,
                    "mean_l2c_mpki": 1.0,
                }
            },
        }

        errors: list[str] = []
        cache.validate_scoped_artifact_semantics(
            "docs/evidence/cache/champsim_prefetch_sweep_report.json",
            artifact,
            errors,
        )

        self.assertTrue(any("trace/variant" in error for error in errors), errors)

    def test_mockingjay_cocotb_rejects_false_threshold_pass(self) -> None:
        artifact = {
            **valid_scoped_artifact(),
            "schema": "eliza.cache.mockingjay_cocotb_synthetic.v1",
            "passed_threshold": True,
            "test_status": "PASS",
            "pass_threshold_abs_or_rel": 0.10,
            "result": {
                "mockingjay_hit_rate": 0.51,
                "lru_hit_rate": 0.50,
                "abs_gain": 0.01,
                "rel_gain": 0.02,
            },
            "stream": {"measure_ops": 100, "num_ops": 100},
        }

        errors: list[str] = []
        cache.validate_scoped_artifact_semantics(
            "docs/evidence/cache/mockingjay_cocotb_synthetic_report.json",
            artifact,
            errors,
        )

        self.assertTrue(any("passed_threshold requires" in error for error in errors), errors)

    def assert_coherence_report_rejects_junit_tag(self, tag: str) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            report = root / "build/reports/cache_coherence.json"
            report.parent.mkdir(parents=True)
            report.write_text(
                json.dumps(
                    {
                        "schema": "eliza.gate_status.v1",
                        "gate": "cache-coherence-check",
                        "status": "PASS",
                        "as_of": "2026-05-23T00:00:00Z",
                        "evidence_paths": [
                            "rtl/cache/coherence/e1_coherence_dir.sv",
                            "verify/cocotb/cache/test_smp_coherence.py",
                            "verify/cocotb/cache/test_coherence_vectors.py",
                        ],
                    }
                ),
                encoding="utf-8",
            )
            for rel_path in [
                "rtl/cache/coherence/e1_coherence_dir.sv",
                "verify/cocotb/cache/test_smp_coherence.py",
                "verify/cocotb/cache/test_coherence_vectors.py",
            ]:
                path = root / rel_path
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("// stub\n", encoding="utf-8")
            xml_dir = root / "verify/cocotb/cache"
            xml_dir.mkdir(parents=True, exist_ok=True)
            (xml_dir / "results_smp_coherence.xml").write_text(
                f"<testsuite><testcase name='bad'><{tag}>boom</{tag}></testcase></testsuite>",
                encoding="utf-8",
            )
            (xml_dir / "results_coherence_vectors.xml").write_text(
                "<testsuite><testcase name='ok'/></testsuite>",
                encoding="utf-8",
            )

            errors: list[str] = []
            with (
                mock.patch.object(cache, "ROOT", root),
                mock.patch.object(cache, "COHERENCE_REPORT", report),
            ):
                cache.check_coherence_report(errors)

            self.assertTrue(any(f"<{tag}>" in error for error in errors), errors)

    def test_coherence_report_rejects_failed_junit_xml(self) -> None:
        self.assert_coherence_report_rejects_junit_tag("failure")

    def test_coherence_report_rejects_error_junit_xml(self) -> None:
        self.assert_coherence_report_rejects_junit_tag("error")

    def test_coherence_report_rejects_skipped_junit_xml(self) -> None:
        self.assert_coherence_report_rejects_junit_tag("skipped")

    def test_cache_coherence_runner_treats_skipped_junit_as_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            results = root / "results_smp_coherence.xml"
            results.write_text(
                "<testsuite><testcase name='test_write_propagation'>"
                "<skipped>disabled</skipped></testcase></testsuite>",
                encoding="utf-8",
            )

            seen, failed = coherence.summarize_junit_results(results)

            self.assertEqual(seen, {"test_write_propagation"})
            self.assertEqual(failed, ["test_write_propagation<skipped>"])


if __name__ == "__main__":
    unittest.main()
