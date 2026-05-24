#!/usr/bin/env python3
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_branch_prediction as branch


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def write_bpu_verification_reports(root: Path) -> None:
    report_dir = root / "build/reports/bpu"
    report_dir.mkdir(parents=True, exist_ok=True)
    (report_dir / "lint.log").write_text("lint clean\n", encoding="utf-8")
    (report_dir / "lint-status.yaml").write_text(
        "\n".join(
            [
                "schema: eliza.bpu_lint_status.v1",
                "status: PASS",
                "log: build/reports/bpu/lint.log",
                "",
            ]
        ),
        encoding="utf-8",
    )
    (report_dir / "formal-status.yaml").write_text(
        "\n".join(
            [
                "schema: eliza.bpu_formal_status.v1",
                "status: PASS",
                "properties:",
                "  - name: ftq",
                "    status: PASS 0 7",
                "",
            ]
        ),
        encoding="utf-8",
    )
    module_counts = {
        "ras": 8,
        "ftq": 6,
        "ftb": 7,
        "uftb": 7,
        "loop_predictor": 6,
        "tage": 6,
        "ittage": 7,
        "sc": 4,
        "l1i_frontend": 7,
        "bpu_top": 39,
    }
    source_files = {
        "ras": "test_ras.py",
        "ftq": "test_ftq.py",
        "ftb": "test_ftb.py",
        "uftb": "test_uftb.py",
        "loop_predictor": "test_loop_predictor.py",
        "tage": "test_tage.py",
        "ittage": "test_ittage.py",
        "sc": "test_sc.py",
        "l1i_frontend": "test_bpu_l1i_frontend.py",
        "bpu_top": "test_bpu_top.py",
    }
    source_dir = root / "verify/cocotb/bpu"
    source_dir.mkdir(parents=True, exist_ok=True)
    for name, count in module_counts.items():
        tests = "\n\n".join(
            f"@cocotb.test()\nasync def {name}_fixture_{idx}(dut):\n    pass"
            for idx in range(count)
        )
        (source_dir / source_files[name]).write_text(
            "import cocotb\n\n" + tests + "\n",
            encoding="utf-8",
        )
    modules = {
        name: {
            "status": "pass",
            "tests": count,
            "expected_tests": count,
            "failures": 0,
            "errors": 0,
            "skipped": 0,
        }
        for name, count in module_counts.items()
    }
    write_json(
        report_dir / "cocotb-aggregate.json",
        {
            "schema": "eliza.bpu_cocotb_aggregate.v1",
            "status": "PASS",
            "expected_total_tests": sum(module_counts.values()),
            "total_tests": sum(module_counts.values()),
            "target_module_count": 10,
            "total_failures": 0,
            "total_errors": 0,
            "missing_modules": [],
            "modules": modules,
        },
    )


def valid_claim_reason() -> str:
    return (
        "Aggregate MPKI is above target_2028_mpki, so target-met and release "
        "accuracy claims remain blocked."
    )


def write_valid_evidence_set(root: Path) -> None:
    evidence = root / "docs/evidence/cpu_ap"
    cbp5_traces = root / "external/cbp5-traces"
    cbp5_traces.mkdir(parents=True, exist_ok=True)
    int_trace = cbp5_traces / "sample_int_trace.gz"
    fp_trace = cbp5_traces / "sample_fp_trace.gz"
    int_trace.write_bytes(b"cbp5-int-trace\n")
    fp_trace.write_bytes(b"cbp5-fp-trace\n")
    write_json(
        evidence / "cbp5-trace-manifest.json",
        {
            "schema": "eliza.cbp5_trace_manifest.v1",
            "evidence_class": "cbp5_train_traces_only",
            "stage_dir": "external/cbp5-traces",
            "staged_traces": [
                {
                    "filename": "sample_int_trace.gz",
                    "compressed_bytes": int_trace.stat().st_size,
                    "compressed_sha256": branch.sha256_path(int_trace),
                    "uncompressed_instructions": 100,
                    "branches": 10,
                    "workload_class": "int",
                },
                {
                    "filename": "sample_fp_trace.gz",
                    "compressed_bytes": fp_trace.stat().st_size,
                    "compressed_sha256": branch.sha256_path(fp_trace),
                    "uncompressed_instructions": 100,
                    "branches": 10,
                    "workload_class": "fp",
                },
            ],
        },
    )
    write_json(
        evidence / "mpki_results_synthetic.json",
        {
            "schema": "eliza.bpu_mpki.v1",
            "generated_at_utc": "2026-05-23T12:00:00+00:00",
            "harness": "cocotb-rtl-bpu_top",
            "aggregate": {"mpki": 99.0},
            "target_2028_mpki": branch.TARGET_2028_MPKI,
            "claim_boundary": "synthetic_planning_only evidence is not phone or release evidence.",
            "phone_claim_allowed": False,
            "release_claim_allowed": False,
            "claim_policy": {
                "spec2017_claim": False,
                "android_claim": False,
                "v8_claim": False,
                "cbp5_claim": False,
                "reason": valid_claim_reason(),
            },
            "workloads": {},
        },
    )
    write_json(
        evidence / "mpki_results_cbp5_rtl.json",
        {
            "schema": "eliza.bpu_mpki.v1",
            "generated_at_utc": "2026-05-23T12:00:00+00:00",
            "harness": "cocotb-rtl-bpu_top",
            "evidence_class": "cbp5_train_traces_only",
            "aggregate": {"mpki": 99.0},
            "target_2028_mpki": branch.TARGET_2028_MPKI,
            "claim_boundary": "cbp5_train_traces_only evidence is not SPEC, Android, JS, phone, or release evidence.",
            "phone_claim_allowed": False,
            "release_claim_allowed": False,
            "claim_policy": {"cbp5_claim": False, "reason": valid_claim_reason()},
            "workloads": {},
        },
    )
    write_json(
        evidence / "mpki_results_cbp5.json",
        {
            "schema": "eliza.bpu_mpki.v1",
            "generated_at_utc": "2026-05-23T12:05:00+00:00",
            "harness": "behavioural-bpu-model",
            "evidence_class": "cbp5_train_traces_only",
            "aggregate": {"mpki": 99.0},
            "target_2028_mpki": branch.TARGET_2028_MPKI,
            "claim_boundary": "cbp5_train_traces_only evidence is not SPEC, Android, JS, phone, or release evidence.",
            "phone_claim_allowed": False,
            "release_claim_allowed": False,
            "claim_policy": {"cbp5_claim": False, "reason": valid_claim_reason()},
            "workloads": {"cbp5_trace": {"trace_class": "cbp5_train_traces_only"}},
        },
    )
    write_json(
        evidence / "mpki_results_workload_rtl.json",
        {
            "schema": "eliza.bpu_mpki.v1",
            "generated_at_utc": "2026-05-23T12:00:00+00:00",
            "harness": "cocotb-rtl-bpu_top",
            "evidence_class": "qemu_rv64_workload",
            "claim_boundary": "qemu_rv64_workload evidence is prefix RTL coverage, not phone or release evidence.",
            "phone_claim_allowed": False,
            "release_claim_allowed": False,
            "claim_policy": {
                "spec2017_claim": False,
                "android_claim": False,
                "v8_claim": False,
                "cbp5_claim": False,
                "reason": "Prefix workload evidence is not a full-trace accuracy claim.",
            },
            "workloads": {},
        },
    )


class BranchPredictionEvidenceGateTest(unittest.TestCase):
    def test_valid_artifacts_pass_evidence_artifact_gate(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_valid_evidence_set(root)
            write_bpu_verification_reports(root)

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertEqual(errors, [])

    def test_mpki_artifacts_require_top_level_claim_boundary_flags(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "docs/evidence/cpu_ap"
            write_valid_evidence_set(root)
            write_bpu_verification_reports(root)
            payload = json.loads((evidence / "mpki_results_cbp5_rtl.json").read_text(encoding="utf-8"))
            payload.pop("claim_boundary")
            payload["release_claim_allowed"] = True
            write_json(evidence / "mpki_results_cbp5_rtl.json", payload)

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertTrue(any("claim_boundary" in err for err in errors), errors)
            self.assertTrue(any("release_claim_allowed" in err for err in errors), errors)

    def test_cbp5_trace_manifest_hash_mismatch_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "docs/evidence/cpu_ap"
            write_valid_evidence_set(root)
            write_bpu_verification_reports(root)
            manifest = json.loads((evidence / "cbp5-trace-manifest.json").read_text(encoding="utf-8"))
            manifest["staged_traces"][0]["compressed_sha256"] = "0" * 64
            write_json(evidence / "cbp5-trace-manifest.json", manifest)

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertTrue(any("compressed_sha256 does not match" in err for err in errors), errors)

    def test_synthetic_positive_release_claim_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "docs/evidence/cpu_ap"
            write_valid_evidence_set(root)
            write_json(
                evidence / "mpki_results_synthetic.json",
                {
                    "claim_policy": {
                        "spec2017_claim": True,
                        "android_claim": False,
                        "v8_claim": False,
                        "cbp5_claim": False,
                    }
                },
            )
            write_json(
                evidence / "mpki_results_cbp5.json",
                {
                    "evidence_class": "cbp5_train_traces_only",
                    "claim_policy": {"cbp5_claim": False},
                    "workloads": {},
                },
            )
            write_json(
                evidence / "mpki_results_cbp5_rtl.json",
                {
                    "evidence_class": "cbp5_train_traces_only",
                    "claim_policy": {"cbp5_claim": False},
                },
            )
            write_json(
                evidence / "mpki_results_workload_rtl.json",
                {"claim_policy": {}, "workloads": {}},
            )
            write_bpu_verification_reports(root)

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertTrue(any("mpki_results_synthetic.json" in err for err in errors), errors)
            self.assertTrue(any("spec2017_claim" in err for err in errors), errors)

    def test_workload_positive_claim_blocks_without_external_trace_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "docs/evidence/cpu_ap"
            write_valid_evidence_set(root)
            write_json(
                evidence / "mpki_results_synthetic.json",
                {"claim_policy": {"spec2017_claim": False, "android_claim": False}},
            )
            write_json(
                evidence / "mpki_results_cbp5.json",
                {
                    "evidence_class": "cbp5_train_traces_only",
                    "claim_policy": {"cbp5_claim": False},
                    "workloads": {},
                },
            )
            write_json(
                evidence / "mpki_results_cbp5_rtl.json",
                {
                    "evidence_class": "cbp5_train_traces_only",
                    "claim_policy": {"cbp5_claim": False},
                },
            )
            write_json(
                evidence / "mpki_results_workload_rtl.json",
                {
                    "claim_policy": {"workload_mpki_claim": True},
                    "workloads": {
                        "agent_loop": {"trace_class": "qemu_rv64_workload"},
                    },
                },
            )
            write_bpu_verification_reports(root)

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertTrue(any("mpki_results_workload_rtl.json" in err for err in errors), errors)
            self.assertTrue(any("workload_mpki_claim" in err for err in errors), errors)

    def test_workload_positive_claim_requires_class_bucket_promotion(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "docs/evidence/cpu_ap"
            write_valid_evidence_set(root)
            workload = json.loads(
                (evidence / "mpki_results_workload_rtl.json").read_text(encoding="utf-8")
            )
            workload["branch_replay_cap"] = None
            workload["claim_policy"]["workload_mpki_claim"] = True
            workload["workloads"] = {
                "agent_loop": {"trace_class": "qemu_rv64_workload"},
                "gpu_control_proxy": {"trace_class": "qemu_rv64_workload"},
            }
            write_json(evidence / "mpki_results_workload_rtl.json", workload)
            write_bpu_verification_reports(root)

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertTrue(any("class_bucket_promotion" in err for err in errors), errors)

    def test_workload_class_bucket_regression_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "docs/evidence/cpu_ap"
            write_valid_evidence_set(root)
            workload = json.loads(
                (evidence / "mpki_results_workload_rtl.json").read_text(encoding="utf-8")
            )
            workload["branch_replay_cap"] = None
            workload["claim_policy"]["workload_mpki_claim"] = True
            workload["class_bucket_promotion"] = {
                "status": "PASS",
                "buckets": [
                    {
                        "name": "general",
                        "baseline_mpki": 3.0,
                        "candidate_mpki": 2.5,
                        "delta_mpki": -0.5,
                    },
                    {
                        "name": "gpu_control",
                        "baseline_mpki": 3.0,
                        "candidate_mpki": 3.1,
                        "delta_mpki": 0.1,
                    },
                ],
            }
            write_json(evidence / "mpki_results_workload_rtl.json", workload)
            write_bpu_verification_reports(root)

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertTrue(any("delta_mpki regresses" in err for err in errors), errors)

    def test_cbp5_model_target_drift_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "docs/evidence/cpu_ap"
            write_valid_evidence_set(root)
            write_json(evidence / "mpki_results_synthetic.json", {"claim_policy": {}})
            write_json(
                evidence / "mpki_results_cbp5.json",
                {
                    "evidence_class": "cbp5_train_traces_only",
                    "target_2028_mpki": 999.0,
                    "aggregate": {"mpki": 1.0},
                    "claim_policy": {"cbp5_claim": True},
                    "workloads": {"cbp5_trace": {"trace_class": "cbp5_train_traces_only"}},
                },
            )
            write_json(
                evidence / "mpki_results_cbp5_rtl.json",
                {
                    "evidence_class": "cbp5_train_traces_only",
                    "target_2028_mpki": branch.TARGET_2028_MPKI,
                    "aggregate": {"mpki": 99.0},
                    "claim_policy": {"cbp5_claim": False},
                },
            )
            write_json(
                evidence / "mpki_results_workload_rtl.json",
                {"claim_policy": {}, "workloads": {}},
            )
            write_bpu_verification_reports(root)

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertTrue(
                any("mpki_results_cbp5.json target_2028_mpki" in err for err in errors),
                errors,
            )

    def test_cbp5_rtl_target_drift_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "docs/evidence/cpu_ap"
            write_valid_evidence_set(root)
            write_json(evidence / "mpki_results_synthetic.json", {"claim_policy": {}})
            write_json(
                evidence / "mpki_results_cbp5.json",
                {
                    "evidence_class": "cbp5_train_traces_only",
                    "target_2028_mpki": branch.TARGET_2028_MPKI,
                    "aggregate": {"mpki": 99.0},
                    "claim_policy": {"cbp5_claim": False},
                    "workloads": {"cbp5_trace": {"trace_class": "cbp5_train_traces_only"}},
                },
            )
            write_json(
                evidence / "mpki_results_cbp5_rtl.json",
                {
                    "evidence_class": "cbp5_train_traces_only",
                    "target_2028_mpki": 999.0,
                    "aggregate": {"mpki": 1.0},
                    "claim_policy": {"cbp5_claim": True},
                },
            )
            write_json(
                evidence / "mpki_results_workload_rtl.json",
                {"claim_policy": {}, "workloads": {}},
            )
            write_bpu_verification_reports(root)

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertTrue(
                any("mpki_results_cbp5_rtl.json target_2028_mpki" in err for err in errors),
                errors,
            )

    def test_cbp5_model_older_than_rtl_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "docs/evidence/cpu_ap"
            write_valid_evidence_set(root)
            model = json.loads((evidence / "mpki_results_cbp5.json").read_text(encoding="utf-8"))
            model["generated_at_utc"] = "2026-05-23T11:59:00+00:00"
            write_json(evidence / "mpki_results_cbp5.json", model)
            write_bpu_verification_reports(root)

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertTrue(any("older than mpki_results_cbp5_rtl.json" in err for err in errors), errors)

    def test_false_cbp5_claim_with_target_met_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "docs/evidence/cpu_ap"
            write_valid_evidence_set(root)
            model = json.loads((evidence / "mpki_results_cbp5.json").read_text(encoding="utf-8"))
            model["aggregate"]["mpki"] = 1.0
            write_json(evidence / "mpki_results_cbp5.json", model)
            write_bpu_verification_reports(root)

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertTrue(any("cbp5_claim is false but aggregate MPKI" in err for err in errors), errors)

    def test_false_claim_stale_supported_reason_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "docs/evidence/cpu_ap"
            write_valid_evidence_set(root)
            rtl = json.loads((evidence / "mpki_results_cbp5_rtl.json").read_text(encoding="utf-8"))
            rtl["claim_policy"]["reason"] = "Only the CBP-5 claim is supported by this evidence."
            write_json(evidence / "mpki_results_cbp5_rtl.json", rtl)
            write_bpu_verification_reports(root)

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertTrue(any("stale supported-claim wording" in err for err in errors), errors)

    def test_missing_bpu_verification_report_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "docs/evidence/cpu_ap"
            write_valid_evidence_set(root)
            write_json(evidence / "mpki_results_synthetic.json", {"claim_policy": {}})
            write_json(
                evidence / "mpki_results_cbp5.json",
                {
                    "evidence_class": "cbp5_train_traces_only",
                    "claim_policy": {"cbp5_claim": False},
                    "workloads": {},
                },
            )
            write_json(
                evidence / "mpki_results_cbp5_rtl.json",
                {
                    "evidence_class": "cbp5_train_traces_only",
                    "claim_policy": {"cbp5_claim": False},
                },
            )
            write_json(
                evidence / "mpki_results_workload_rtl.json",
                {"claim_policy": {}, "workloads": {}},
            )

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertTrue(any("missing BPU lint report" in err for err in errors), errors)

    def test_failing_bpu_cocotb_aggregate_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "docs/evidence/cpu_ap"
            write_valid_evidence_set(root)
            write_json(evidence / "mpki_results_synthetic.json", {"claim_policy": {}})
            write_json(
                evidence / "mpki_results_cbp5.json",
                {
                    "evidence_class": "cbp5_train_traces_only",
                    "claim_policy": {"cbp5_claim": False},
                    "workloads": {},
                },
            )
            write_json(
                evidence / "mpki_results_cbp5_rtl.json",
                {
                    "evidence_class": "cbp5_train_traces_only",
                    "claim_policy": {"cbp5_claim": False},
                },
            )
            write_json(
                evidence / "mpki_results_workload_rtl.json",
                {"claim_policy": {}, "workloads": {}},
            )
            write_bpu_verification_reports(root)
            aggregate_path = root / "build/reports/bpu/cocotb-aggregate.json"
            aggregate = json.loads(aggregate_path.read_text(encoding="utf-8"))
            aggregate["modules"]["ras"]["failures"] = 1
            write_json(aggregate_path, aggregate)

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertTrue(
                any("non-passing module summary" in err for err in errors),
                errors,
            )


if __name__ == "__main__":
    unittest.main()
