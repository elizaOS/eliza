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


def write_workload_trace_manifest_fixture(root: Path) -> None:
    trace_dir = root / "external/workload-traces"
    evidence = root / "docs/evidence/cpu_ap"
    trace_dir.mkdir(parents=True, exist_ok=True)
    traces = []
    for index, name in enumerate(sorted(branch.REQUIRED_QEMU_WORKLOAD_TRACES)):
        trace_path = trace_dir / f"{name}.btrace.json"
        payload = {
            "schema": "eliza.bpu_workload_trace.v1",
            "source": {
                "workload": name,
                "src": "fixture.c",
                "mode": index,
                "qemu": "qemu-riscv64 user-mode + libexeclog",
            },
            "instruction_count": 1000 + index,
            "branch_count": 10 + index,
            "class_counts": {
                "instruction_count": 1000 + index,
                "branch_count": 10 + index,
                "cond_branch_count": 8 + index,
                "direct_jump_count": 1,
                "call_count": 1,
                "indirect_branch_count": 0,
                "return_count": 0,
            },
            "branches": [[0x1000 + index * 4, 0x2000, 1, 1, -1]],
        }
        write_json(trace_path, payload)
        traces.append(
            {
                "name": name,
                "filename": trace_path.name,
                "schema": payload["schema"],
                "bytes": trace_path.stat().st_size,
                "sha256": branch.sha256_path(trace_path),
                "instruction_count": payload["instruction_count"],
                "branch_count": payload["branch_count"],
                "class_counts": payload["class_counts"],
                "source": payload["source"],
                "coverage_buckets": ["qemu_rv64", "fixture"],
                "full_trace_available": True,
                "trace_class": "qemu_rv64_workload",
            }
        )
    write_json(
        evidence / "bpu-workload-trace-manifest.json",
        {
            "schema": "eliza.bpu_workload_trace_manifest.v1",
            "generated_at_utc": "2026-05-23T12:00:00+00:00",
            "trace_dir": "external/workload-traces",
            "evidence_class": "qemu_rv64_workload_trace_manifest",
            "claim_boundary": "qemu_rv64_workload_trace_manifest is local trace inventory only.",
            "phone_claim_allowed": False,
            "release_claim_allowed": False,
            "required_local_trace_names": sorted(branch.REQUIRED_QEMU_WORKLOAD_TRACES),
            "present_required_local_trace_names": sorted(branch.REQUIRED_QEMU_WORKLOAD_TRACES),
            "missing_required_local_trace_names": [],
            "production_external_suites": [
                {
                    "name": "spec2017_intrate",
                    "status": "missing_external_trace",
                    "required_for_claims": ["spec2017_claim", "workload_mpki_claim"],
                    "missing_dependency": "SPEC CPU2017 license and RV64 executable traces",
                },
                {
                    "name": "aosp_system_server_and_launcher",
                    "status": "missing_external_trace",
                    "required_for_claims": ["android_claim", "workload_mpki_claim"],
                    "missing_dependency": "AOSP RV64 traces",
                },
                {
                    "name": "browser_js_engine",
                    "status": "missing_external_trace",
                    "required_for_claims": ["v8_claim", "workload_mpki_claim"],
                    "missing_dependency": "browser and JS-engine traces",
                },
                {
                    "name": "production_gpu_driver_runtime",
                    "status": "missing_external_trace",
                    "required_for_claims": ["workload_mpki_claim"],
                    "missing_dependency": "real GPU driver/runtime traces",
                },
            ],
            "trace_count": len(traces),
            "total_instruction_count": sum(t["instruction_count"] for t in traces),
            "total_branch_count": sum(t["branch_count"] for t in traces),
            "traces": traces,
        },
    )


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


def write_full_trace_shard_result(
    root: Path,
    relpath: str,
    required_traces: set[str],
    *,
    baseline_mpki: float,
    h2p_off_mpki: float,
    h2p_lowconf_mpki: float | None = None,
) -> None:
    counters = {key: 0 for key in branch.REQUIRED_ITTAGE_SWEEP_COUNTERS}
    timing = {key: 0 for key in branch.REQUIRED_TIMING_SWEEP_COUNTERS}
    best_config = "baseline"
    best_mpki = baseline_mpki
    if h2p_lowconf_mpki is not None and h2p_lowconf_mpki < best_mpki:
        best_config = "h2p_lowconf_only"
        best_mpki = h2p_lowconf_mpki
    if h2p_off_mpki < best_mpki:
        best_config = "h2p_off"
        best_mpki = h2p_off_mpki
    results = {
        "baseline": {
            "weighted_mpki": baseline_mpki,
            "ittage_counter_totals": counters,
            "timing_counter_totals": timing,
            "per_trace": {
                name: {
                    "mpki": baseline_mpki,
                    "ittage_counters": counters,
                    "timing_counters": timing,
                }
                for name in sorted(required_traces)
            },
        },
        "h2p_off": {
            "weighted_mpki": h2p_off_mpki,
            "ittage_counter_totals": counters,
            "timing_counter_totals": timing,
            "per_trace": {
                name: {
                    "mpki": h2p_off_mpki,
                    "ittage_counters": counters,
                    "timing_counters": timing,
                }
                for name in sorted(required_traces)
            },
        },
    }
    if h2p_lowconf_mpki is not None:
        results["h2p_lowconf_only"] = {
            "weighted_mpki": h2p_lowconf_mpki,
            "ittage_counter_totals": counters,
            "timing_counter_totals": timing,
            "per_trace": {
                name: {
                    "mpki": h2p_lowconf_mpki,
                    "ittage_counters": counters,
                    "timing_counters": timing,
                }
                for name in sorted(required_traces)
            },
        }
    write_json(
        root / relpath,
        {
            "schema": "eliza.bpu_sweep.v1",
            "generated_at_utc": "2026-05-23T12:00:00+00:00",
            "harness": "behavioural-bpu-model",
            "ittage_evidence_counters": sorted(branch.REQUIRED_ITTAGE_SWEEP_COUNTERS),
            "timing_evidence_counters": sorted(branch.REQUIRED_TIMING_SWEEP_COUNTERS),
            "baseline_weighted_mpki": baseline_mpki,
            "best_config": best_config,
            "best_weighted_mpki": best_mpki,
            "max_branches_per_trace": 0,
            "window_mode": "prefix",
            "trace_filter": sorted(required_traces),
            "trace_set": [
                {
                    "name": name,
                    "branches": 100 + index,
                    "instructions": 500 + index,
                    "weight": 1.0,
                }
                for index, name in enumerate(sorted(required_traces))
            ],
            "results": results,
        },
    )


def write_valid_sweep_result(root: Path) -> None:
    counters = {key: 0 for key in branch.REQUIRED_ITTAGE_SWEEP_COUNTERS}
    timing = {key: 0 for key in branch.REQUIRED_TIMING_SWEEP_COUNTERS}
    write_json(
        root / "docs/evidence/cpu_ap/bpu_sweep_results.json",
        {
            "schema": "eliza.bpu_sweep.v1",
            "generated_at_utc": "2026-05-23T12:00:00+00:00",
            "harness": "behavioural-bpu-model",
            "ittage_evidence_counters": sorted(branch.REQUIRED_ITTAGE_SWEEP_COUNTERS),
            "timing_evidence_counters": sorted(branch.REQUIRED_TIMING_SWEEP_COUNTERS),
            "baseline_weighted_mpki": 99.0,
            "best_config": "baseline",
            "best_weighted_mpki": 99.0,
            "max_branches_per_trace": 1000,
            "window_mode": "stratified",
            "results": {
                "baseline": {
                    "weighted_mpki": 99.0,
                    "delta_vs_baseline": 0.0,
                    "ittage_counter_totals": counters,
                    "timing_counter_totals": timing,
                    "per_trace": {
                        "fixture": {
                            "mpki": 99.0,
                            "ittage_counters": counters,
                            "timing_counters": timing,
                        }
                    },
                }
            },
        },
    )
    write_full_trace_shard_result(
        root,
        branch.FULL_PROXY_SHARD_SWEEP_REL,
        branch.REQUIRED_FULL_PROXY_SHARD_TRACES,
        baseline_mpki=10.0,
        h2p_off_mpki=11.0,
    )
    write_full_trace_shard_result(
        root,
        branch.FULL_IO_MEDIA_SHARD_SWEEP_REL,
        branch.REQUIRED_FULL_IO_MEDIA_SHARD_TRACES,
        baseline_mpki=20.0,
        h2p_off_mpki=19.0,
        h2p_lowconf_mpki=18.0,
    )
    write_full_trace_shard_result(
        root,
        branch.FULL_SYSTEM_GPU_SHARD_SWEEP_REL,
        branch.REQUIRED_FULL_SYSTEM_GPU_SHARD_TRACES,
        baseline_mpki=30.0,
        h2p_off_mpki=29.0,
        h2p_lowconf_mpki=28.0,
    )
    write_full_trace_shard_result(
        root,
        branch.FULL_BROWSER_BUILD_CRYPTO_SHARD_SWEEP_REL,
        branch.REQUIRED_FULL_BROWSER_BUILD_CRYPTO_SHARD_TRACES,
        baseline_mpki=40.0,
        h2p_off_mpki=39.0,
        h2p_lowconf_mpki=38.0,
    )
    write_full_trace_shard_result(
        root,
        branch.FULL_COMPRESSION_SHARD_SWEEP_REL,
        branch.REQUIRED_FULL_COMPRESSION_SHARD_TRACES,
        baseline_mpki=50.0,
        h2p_off_mpki=49.0,
        h2p_lowconf_mpki=48.0,
    )


def write_valid_evidence_set(root: Path) -> None:
    evidence = root / "docs/evidence/cpu_ap"
    write_workload_trace_manifest_fixture(root)
    write_valid_sweep_result(root)
    workload_names = sorted(branch.REQUIRED_QEMU_WORKLOAD_TRACES)
    source_branch_total = sum(10 + index for index, _ in enumerate(workload_names))
    source_instruction_total = sum(1000 + index for index, _ in enumerate(workload_names))
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
            "branch_replay_cap": None,
            "source_branch_count": source_branch_total,
            "replayed_branch_count": source_branch_total,
            "source_instruction_count": source_instruction_total,
            "replayed_instruction_count": source_instruction_total,
            "replay_fraction": 1.0,
            "instruction_replay_fraction": 1.0,
            "full_trace_replay": True,
            "claim_policy": {
                "spec2017_claim": False,
                "android_claim": False,
                "v8_claim": False,
                "cbp5_claim": False,
                "agent_mpki_claim": False,
                "decode_mpki_claim": False,
                "workload_mpki_claim": False,
                "reason": "Prefix workload evidence is not a full-trace accuracy claim.",
            },
            "workloads": {
                name: {
                    "trace_class": "qemu_rv64_workload",
                    "branch_count": 10 + index,
                    "instruction_count": 1000 + index,
                    "source_instruction_count": 1000 + index,
                    "source_branch_count": 10 + index,
                    "replay_fraction": 1.0,
                    "instruction_replay_fraction": 1.0,
                    "full_trace_replay": True,
                }
                for index, name in enumerate(workload_names)
            },
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

    def test_workload_trace_manifest_hash_mismatch_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "docs/evidence/cpu_ap"
            write_valid_evidence_set(root)
            write_bpu_verification_reports(root)
            manifest = json.loads(
                (evidence / "bpu-workload-trace-manifest.json").read_text(encoding="utf-8")
            )
            manifest["traces"][0]["sha256"] = "0" * 64
            write_json(evidence / "bpu-workload-trace-manifest.json", manifest)

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertTrue(any(".sha256 does not match staged trace" in err for err in errors), errors)

    def test_workload_trace_manifest_must_match_rtl_replay_names(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "docs/evidence/cpu_ap"
            write_valid_evidence_set(root)
            write_bpu_verification_reports(root)
            workload = json.loads(
                (evidence / "mpki_results_workload_rtl.json").read_text(encoding="utf-8")
            )
            workload["workloads"].pop("agent_loop")
            write_json(evidence / "mpki_results_workload_rtl.json", workload)

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertTrue(
                any("has traces absent from mpki_results_workload_rtl.json" in err for err in errors),
                errors,
            )

    def test_workload_trace_manifest_must_match_rtl_replay_source_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "docs/evidence/cpu_ap"
            write_valid_evidence_set(root)
            write_bpu_verification_reports(root)
            workload = json.loads(
                (evidence / "mpki_results_workload_rtl.json").read_text(encoding="utf-8")
            )
            workload["workloads"]["agent_loop"]["source_branch_count"] += 1
            workload["workloads"]["agent_loop"]["source_instruction_count"] += 1
            write_json(evidence / "mpki_results_workload_rtl.json", workload)

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertTrue(any("source_branch_count" in err for err in errors), errors)
            self.assertTrue(any("source_instruction_count" in err for err in errors), errors)

    def test_workload_rtl_replay_fraction_must_match_source_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "docs/evidence/cpu_ap"
            write_valid_evidence_set(root)
            write_bpu_verification_reports(root)
            workload_path = evidence / "mpki_results_workload_rtl.json"
            workload = json.loads(workload_path.read_text(encoding="utf-8"))
            workload["workloads"]["agent_loop"]["replay_fraction"] = 0.5
            workload["replay_fraction"] = 0.5
            workload["full_trace_replay"] = False
            write_json(workload_path, workload)

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertTrue(any("replay_fraction" in err for err in errors), errors)
            self.assertTrue(any("branch_replay_cap null requires" in err for err in errors), errors)

    def test_full_proxy_shard_must_be_uncapped_and_exact_trace_set(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "docs/evidence/cpu_ap"
            write_valid_evidence_set(root)
            write_bpu_verification_reports(root)
            shard_path = evidence / "bpu_sweep_full_proxy_shard.json"
            shard = json.loads(shard_path.read_text(encoding="utf-8"))
            shard["max_branches_per_trace"] = 1000
            shard["trace_filter"] = ["gpu_memory_residency_proxy"]
            write_json(shard_path, shard)

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertTrue(any("max_branches_per_trace must be 0" in err for err in errors), errors)
            self.assertTrue(any("trace_filter must match" in err for err in errors), errors)

    def test_full_io_media_shard_must_be_present_and_exact_trace_set(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "docs/evidence/cpu_ap"
            write_valid_evidence_set(root)
            write_bpu_verification_reports(root)
            shard_path = evidence / "bpu_sweep_full_io_media_shard.json"
            shard = json.loads(shard_path.read_text(encoding="utf-8"))
            shard["trace_set"] = [
                row
                for row in shard["trace_set"]
                if row["name"] != "audio_frames"
            ]
            write_json(shard_path, shard)

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertTrue(
                any("trace_set names must match required full shard" in err for err in errors),
                errors,
            )

    def test_full_system_gpu_shard_requires_best_against_comparators(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "docs/evidence/cpu_ap"
            write_valid_evidence_set(root)
            write_bpu_verification_reports(root)
            shard_path = evidence / "bpu_sweep_full_system_gpu_shard.json"
            shard = json.loads(shard_path.read_text(encoding="utf-8"))
            shard["best_config"] = "h2p_lowconf_only"
            shard["results"]["h2p_lowconf_only"]["weighted_mpki"] = 31.0
            write_json(shard_path, shard)

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertTrue(
                any("best_config must not regress versus baseline" in err for err in errors),
                errors,
            )

    def test_full_browser_build_crypto_shard_requires_lowconf_probe(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "docs/evidence/cpu_ap"
            write_valid_evidence_set(root)
            write_bpu_verification_reports(root)
            shard_path = evidence / "bpu_sweep_full_browser_build_crypto_shard.json"
            shard = json.loads(shard_path.read_text(encoding="utf-8"))
            del shard["results"]["h2p_lowconf_only"]
            write_json(shard_path, shard)

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertTrue(
                any("h2p_lowconf_only" in err for err in errors),
                errors,
            )

    def test_full_compression_shard_requires_uncapped_replay(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "docs/evidence/cpu_ap"
            write_valid_evidence_set(root)
            write_bpu_verification_reports(root)
            shard_path = evidence / "bpu_sweep_full_compression_shard.json"
            shard = json.loads(shard_path.read_text(encoding="utf-8"))
            shard["max_branches_per_trace"] = 800000
            write_json(shard_path, shard)

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertTrue(
                any("max_branches_per_trace must be 0" in err for err in errors),
                errors,
            )

    def test_workload_trace_manifest_requires_exact_external_suite_set(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "docs/evidence/cpu_ap"
            write_valid_evidence_set(root)
            write_bpu_verification_reports(root)
            manifest_path = evidence / "bpu-workload-trace-manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["production_external_suites"] = [
                suite
                for suite in manifest["production_external_suites"]
                if suite["name"] != "production_gpu_driver_runtime"
            ]
            manifest["production_external_suites"].append(
                {
                    "name": "unexpected_lab_trace_pack",
                    "status": "missing_external_trace",
                    "required_for_claims": ["workload_mpki_claim"],
                    "missing_dependency": "not part of the production gate",
                }
            )
            write_json(manifest_path, manifest)

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertTrue(any("missing required suites" in err for err in errors), errors)
            self.assertTrue(any("unexpected suites" in err for err in errors), errors)

    def test_workload_trace_manifest_external_suite_status_drift_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "docs/evidence/cpu_ap"
            write_valid_evidence_set(root)
            write_bpu_verification_reports(root)
            manifest_path = evidence / "bpu-workload-trace-manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["production_external_suites"][0]["status"] = "available"
            write_json(manifest_path, manifest)

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertTrue(any(".status must be missing_external_trace" in err for err in errors), errors)

    def test_workload_trace_manifest_external_suite_claim_drift_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            evidence = root / "docs/evidence/cpu_ap"
            write_valid_evidence_set(root)
            write_bpu_verification_reports(root)
            manifest_path = evidence / "bpu-workload-trace-manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["production_external_suites"][0]["required_for_claims"] = ["workload_mpki_claim"]
            write_json(manifest_path, manifest)

            with mock.patch.object(branch, "ROOT", root):
                errors = branch.evaluate_evidence_artifacts()

            self.assertTrue(any("required_for_claims does not match" in err for err in errors), errors)

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
