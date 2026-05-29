#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import check_memory_evidence_templates as templates
import yaml

PROCESS_CONTRACT_SHA = templates.sha256_file(
    templates.ROOT / templates.PROCESS_EFFECTS_CONTRACT_PATH
)


def valid_real_report(
    raw_artifact_path: str = "docs/evidence/memory/raw/lpddr.log",
    raw_artifact_sha: str = "b" * 64,
    trace_path: str = "docs/evidence/memory/raw/contention.json",
    trace_sha: str | None = None,
) -> dict:
    raw_artifacts = [{"path": raw_artifact_path, "sha256": raw_artifact_sha}]
    if trace_sha is not None:
        raw_artifacts.append({"path": trace_path, "sha256": trace_sha})
    return {
        "schema": "eliza.memory.lpddr_bandwidth_latency_benchmark.v1",
        "evidence_class": "real_target_measurement",
        "claim_boundary": (
            "Real target memory measurements can satisfy local measured evidence only; "
            "this report is not phone or release evidence until release gates bind the "
            "full device, Android, LPDDR PHY, thermal, and process evidence."
        ),
        "claim_allowed": False,
        "phone_claim_allowed": False,
        "release_claim_allowed": False,
        "target": {
            "target_id": "fpga-lab-target-01",
            "target_kind": "fpga_emulation",
            "is_host": False,
            "is_simulator": False,
            "capture_utc": "2026-05-18T00:00:00Z",
        },
        "process_corners": {
            "process_effects_contract": {
                "path": "docs/spec-db/process-14a-effects.yaml",
                "sha256": PROCESS_CONTRACT_SHA,
            },
            "process_corner_count": 4,
            "worst_process_corner": "14a_ss_0p63v_105c_frontside_pdn",
            "pdk_signoff_claim": "none",
        },
        "memory_config": {
            "memory_type": "LPDDR6 measured target",
            "capacity_gib": 16,
        },
        "runtime_state": {
            "os": "android-target",
            "kernel": "6.12",
            "governor": "fixed-performance",
            "thermal_state": "steady",
            "power_mode": "sustained",
        },
        "benchmark_commands": ["stream_c.exe", "lat_mem_rd 64M 128"],
        "raw_artifacts": raw_artifacts,
        "parsed_metrics": {
            "peak_bandwidth_gbps": 180.0,
            "sustained_bandwidth_gbps": 128.0,
            "p95_random_read_latency_ns": 95.0,
            "contended_cpu_latency_ns": 110.0,
            "display_underflow_count": 0,
            "dma_copy_bandwidth_gbps": 64.0,
            "worst_process_corner_sustained_bandwidth_gbps": 121.0,
            "worst_process_corner_p95_random_read_latency_ns": 119.0,
        },
        "pass_fail_against_phone_2028_target_profile": {
            "capacity_gib_min_12": "pass",
            "peak_bandwidth_gbps_min_180": "pass",
            "sustained_bandwidth_gbps_min_120": "pass",
            "p95_random_read_latency_ns_max_120": "pass",
            "contended_trace_present": "pass",
            "overall": "pass",
        },
        "contention_workload": {
            "clients": ["CPU", "DMA", "NPU", "display", "camera/ISP", "GPU/2D"],
            "duration_seconds": 60,
            "raw_trace_path": trace_path,
        },
    }


def valid_real_report_with_artifacts(tmp: Path) -> dict:
    raw = tmp / "lpddr.log"
    trace = tmp / "contention.json"
    raw.write_text("stream/lmbench raw target transcript\n", encoding="utf-8")
    trace.write_text('{"clients":["CPU","DMA","NPU","display"]}\n', encoding="utf-8")
    return valid_real_report(
        raw_artifact_path=str(raw.relative_to(templates.ROOT)),
        raw_artifact_sha=templates.sha256_file(raw),
        trace_path=str(trace.relative_to(templates.ROOT)),
        trace_sha=templates.sha256_file(trace),
    )


class MemoryEvidenceTemplateTest(unittest.TestCase):
    def test_template_checker_passes_without_real_reports(self) -> None:
        result = subprocess.run(
            [sys.executable, "scripts/check_memory_evidence_templates.py"],
            cwd=templates.ROOT,
            text=True,
            capture_output=True,
        )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("template_only", templates.TEMPLATE.read_text())
        self.assertIn("placeholder rejection is armed", result.stdout)

    def test_strict_real_reports_requires_default_l5_l6_reports(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                "scripts/check_memory_evidence_templates.py",
                "--strict-real-reports",
            ],
            cwd=templates.ROOT,
            text=True,
            capture_output=True,
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("strict real memory report missing", result.stdout)

    def test_placeholder_real_report_is_rejected(self) -> None:
        report = json.loads(templates.TEMPLATE.read_text())["report"]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "placeholder-report.json"
            path.write_text(json.dumps(report), encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    "scripts/check_memory_evidence_templates.py",
                    "--report",
                    str(path),
                ],
                cwd=templates.ROOT,
                text=True,
                capture_output=True,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("contains placeholders", result.stdout)

    def test_valid_real_report_requires_hash_bound_raw_artifacts(self) -> None:
        tmp_parent = templates.ROOT / "build/tmp/memory-evidence-template-test"
        tmp_parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=tmp_parent) as tmp:
            root = Path(tmp)
            report = valid_real_report_with_artifacts(root)
            path = root / "valid-memory-report.json"
            path.write_text(json.dumps(report), encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    "scripts/check_memory_evidence_templates.py",
                    "--report",
                    str(path),
                ],
                cwd=templates.ROOT,
                text=True,
                capture_output=True,
            )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_real_report_rejects_mismatched_raw_artifact_hash(self) -> None:
        tmp_parent = templates.ROOT / "build/tmp/memory-evidence-template-test"
        tmp_parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=tmp_parent) as tmp:
            root = Path(tmp)
            report = valid_real_report_with_artifacts(root)
            report["raw_artifacts"][0]["sha256"] = "b" * 64
            path = root / "bad-raw-hash-report.json"
            path.write_text(json.dumps(report), encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    "scripts/check_memory_evidence_templates.py",
                    "--report",
                    str(path),
                ],
                cwd=templates.ROOT,
                text=True,
                capture_output=True,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("raw artifact sha256 does not match", result.stdout)

    def test_real_report_schema_must_match_gate_contract(self) -> None:
        tmp_parent = templates.ROOT / "build/tmp/memory-evidence-template-test"
        tmp_parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=tmp_parent) as tmp:
            root = Path(tmp)
            report = valid_real_report_with_artifacts(root)
            report["schema"] = "eliza.memory.wrong.v1"
            report_path = (
                templates.ROOT
                / "docs/evidence/memory/lpddr_bandwidth_latency_benchmark_report.json"
            )
            original = report_path.read_text(encoding="utf-8") if report_path.exists() else None
            try:
                report_path.write_text(json.dumps(report), encoding="utf-8")
                result = subprocess.run(
                    [
                        sys.executable,
                        "scripts/check_memory_evidence_templates.py",
                    ],
                    cwd=templates.ROOT,
                    text=True,
                    capture_output=True,
                )
            finally:
                if original is None:
                    report_path.unlink(missing_ok=True)
                else:
                    report_path.write_text(original, encoding="utf-8")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "schema must be eliza.memory.lpddr_bandwidth_latency_benchmark.v1", result.stdout
        )

    def test_real_report_requires_declared_minimum_fields(self) -> None:
        report = valid_real_report()
        del report["runtime_state"]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "missing-runtime-state.json"
            path.write_text(json.dumps(report), encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    "scripts/check_memory_evidence_templates.py",
                    "--report",
                    str(path),
                ],
                cwd=templates.ROOT,
                text=True,
                capture_output=True,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing minimum report field runtime_state", result.stdout)

    def test_real_report_rejects_claim_promotion_flags(self) -> None:
        report = valid_real_report()
        report["release_claim_allowed"] = True
        report.pop("phone_claim_allowed")
        report["claim_boundary"] = "Real target memory report."
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "promoted-memory-report.json"
            path.write_text(json.dumps(report), encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    "scripts/check_memory_evidence_templates.py",
                    "--report",
                    str(path),
                ],
                cwd=templates.ROOT,
                text=True,
                capture_output=True,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("claim_boundary must explicitly block phone/release promotion", result.stdout)
        self.assertIn("release_claim_allowed must be exactly false", result.stdout)
        self.assertIn("phone_claim_allowed must be exactly false", result.stdout)

    def test_contended_trace_requires_all_target_clients(self) -> None:
        report = valid_real_report()
        report["contention_workload"]["clients"] = ["CPU", "DMA", "NPU", "display"]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "missing-contention-clients.json"
            path.write_text(json.dumps(report), encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    "scripts/check_memory_evidence_templates.py",
                    "--report",
                    str(path),
                ],
                cwd=templates.ROOT,
                text=True,
                capture_output=True,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("contention_workload.clients missing required clients", result.stdout)

    def test_contention_trace_must_be_listed_as_raw_artifact(self) -> None:
        tmp_parent = templates.ROOT / "build/tmp/memory-evidence-template-test"
        tmp_parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=tmp_parent) as tmp:
            root = Path(tmp)
            report = valid_real_report_with_artifacts(root)
            report["raw_artifacts"] = report["raw_artifacts"][:1]
            path = root / "missing-trace-artifact-report.json"
            path.write_text(json.dumps(report), encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    "scripts/check_memory_evidence_templates.py",
                    "--report",
                    str(path),
                ],
                cwd=templates.ROOT,
                text=True,
                capture_output=True,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("raw_trace_path must be listed in raw_artifacts", result.stdout)

    def test_real_report_without_process_contract_hash_is_rejected(self) -> None:
        report = valid_real_report()
        report["process_corners"]["process_effects_contract"]["sha256"] = "__REQUIRED_SHA256__"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "missing-process-hash.json"
            path.write_text(json.dumps(report), encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    "scripts/check_memory_evidence_templates.py",
                    "--report",
                    str(path),
                ],
                cwd=templates.ROOT,
                text=True,
                capture_output=True,
            )

        self.assertNotEqual(result.returncode, 0)

    def test_real_report_process_contract_hash_mismatch_is_rejected(self) -> None:
        report = valid_real_report()
        report["process_corners"]["process_effects_contract"]["sha256"] = "a" * 64
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "mismatched-process-hash.json"
            path.write_text(json.dumps(report), encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    "scripts/check_memory_evidence_templates.py",
                    "--report",
                    str(path),
                ],
                cwd=templates.ROOT,
                text=True,
                capture_output=True,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("process_effects_contract sha256 must match", result.stdout)

    def test_real_report_without_process_corner_metrics_is_rejected(self) -> None:
        report = valid_real_report()
        del report["parsed_metrics"]["worst_process_corner_sustained_bandwidth_gbps"]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "missing-process-metric.json"
            path.write_text(json.dumps(report), encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    "scripts/check_memory_evidence_templates.py",
                    "--report",
                    str(path),
                ],
                cwd=templates.ROOT,
                text=True,
                capture_output=True,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing metrics", result.stdout)

    def test_real_report_without_peak_pass_fail_is_rejected(self) -> None:
        report = valid_real_report()
        del report["pass_fail_against_phone_2028_target_profile"]["peak_bandwidth_gbps_min_180"]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "missing-peak-pass-fail.json"
            path.write_text(json.dumps(report), encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    "scripts/check_memory_evidence_templates.py",
                    "--report",
                    str(path),
                ],
                cwd=templates.ROOT,
                text=True,
                capture_output=True,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("peak_bandwidth_gbps_min_180", result.stdout)

    def test_overall_pass_requires_every_memory_target_key_to_pass(self) -> None:
        report = valid_real_report()
        report["pass_fail_against_phone_2028_target_profile"]["contended_trace_present"] = "fail"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "drifted-overall-pass.json"
            path.write_text(json.dumps(report), encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    "scripts/check_memory_evidence_templates.py",
                    "--report",
                    str(path),
                ],
                cwd=templates.ROOT,
                text=True,
                capture_output=True,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("overall pass requires", result.stdout)

    def test_pass_fail_verdict_must_match_bandwidth_metrics(self) -> None:
        report = valid_real_report()
        report["parsed_metrics"]["peak_bandwidth_gbps"] = 179.9
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "false-peak-pass.json"
            path.write_text(json.dumps(report), encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    "scripts/check_memory_evidence_templates.py",
                    "--report",
                    str(path),
                ],
                cwd=templates.ROOT,
                text=True,
                capture_output=True,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("peak_bandwidth_gbps >= 180", result.stdout)

    def test_contended_trace_pass_requires_trace_metadata(self) -> None:
        report = valid_real_report()
        del report["contention_workload"]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "missing-contention-trace.json"
            path.write_text(json.dumps(report), encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    "scripts/check_memory_evidence_templates.py",
                    "--report",
                    str(path),
                ],
                cwd=templates.ROOT,
                text=True,
                capture_output=True,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("contention_workload", result.stdout)

    def test_dramsim_aggregate_without_timestamp_is_rejected(self) -> None:
        aggregate = yaml.safe_load(templates.DRAM_SIM_EVIDENCE.read_text())
        del aggregate["captured_utc"]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "dram_sim_evidence.yaml"
            path.write_text(yaml.safe_dump(aggregate), encoding="utf-8")

            errors: list[str] = []
            templates.validate_dramsim_aggregate(errors, path)

        self.assertTrue(any("captured_utc" in error for error in errors), errors)

    def test_dramsim_aggregate_missing_workload_is_rejected(self) -> None:
        aggregate = yaml.safe_load(templates.DRAM_SIM_EVIDENCE.read_text())
        del aggregate["skus"][0]["sustained_bandwidth_gbps"]["stream_triad"]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "dram_sim_evidence.yaml"
            path.write_text(yaml.safe_dump(aggregate), encoding="utf-8")

            errors: list[str] = []
            templates.validate_dramsim_aggregate(errors, path)

        self.assertTrue(any("missing sustained workloads" in error for error in errors), errors)

    def test_dramsim_aggregate_missing_listed_report_is_rejected(self) -> None:
        aggregate = yaml.safe_load(templates.DRAM_SIM_EVIDENCE.read_text())
        aggregate["skus"][0]["report_paths"][0] = (
            "build/reports/memory/dramsim3_lpddr5x_10667_missing.json"
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "dram_sim_evidence.yaml"
            path.write_text(yaml.safe_dump(aggregate), encoding="utf-8")

            errors: list[str] = []
            templates.validate_dramsim_aggregate(errors, path)

        self.assertTrue(
            any("listed DRAMSim report is missing" in error for error in errors), errors
        )

    def test_dramsim_aggregate_missing_report_hash_binding_is_rejected(self) -> None:
        aggregate = yaml.safe_load(templates.DRAM_SIM_EVIDENCE.read_text())
        path = aggregate["skus"][0]["report_paths"][0]
        del aggregate["report_artifacts"][path]
        with tempfile.TemporaryDirectory() as tmp:
            aggregate_path = Path(tmp) / "dram_sim_evidence.yaml"
            aggregate_path.write_text(yaml.safe_dump(aggregate), encoding="utf-8")

            errors: list[str] = []
            templates.validate_dramsim_aggregate(errors, aggregate_path)

        self.assertTrue(
            any("report_artifacts missing listed reports" in error for error in errors),
            errors,
        )

    def test_dramsim_aggregate_stale_report_hash_is_rejected(self) -> None:
        aggregate = yaml.safe_load(templates.DRAM_SIM_EVIDENCE.read_text())
        path = aggregate["skus"][0]["report_paths"][0]
        aggregate["report_artifacts"][path] = "0" * 64
        with tempfile.TemporaryDirectory() as tmp:
            aggregate_path = Path(tmp) / "dram_sim_evidence.yaml"
            aggregate_path.write_text(yaml.safe_dump(aggregate), encoding="utf-8")

            errors: list[str] = []
            templates.validate_dramsim_aggregate(errors, aggregate_path)

        self.assertTrue(
            any("report_artifacts sha256 is stale" in error for error in errors),
            errors,
        )

    def test_dramsim_report_raw_artifact_hash_mismatch_is_rejected(self) -> None:
        tmp_parent = templates.ROOT / "build/tmp/memory-evidence-template-test"
        tmp_parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=tmp_parent) as tmp:
            root = Path(tmp)
            raw_log = root / "dramsim3.log"
            raw_stats = root / "dramsim3.json"
            raw_log.write_text("raw log\n", encoding="utf-8")
            raw_stats.write_text('{"stats": true}\n', encoding="utf-8")
            report = {
                "schema": "eliza.memory.dram_sim_sweep.v1",
                "status": "simulator_only",
                "evidence_class": "dramsim3_behavioral_simulation",
                "backend": "dramsim3",
                "captured_utc": "2026-05-23T00:00:00Z",
                "standard": "LPDDR5X-10667",
                "peak_bandwidth_gbps": 85.336,
                "workload": "microbench",
                "simulated_total_bandwidth_gbps": 22.41,
                "simulated_p95_latency_ns": 134.43,
                "claim_boundary": "DRAMSim3 behavioural simulation only; not physical LPDDR, silicon, phone, or release evidence.",
                "phone_claim_allowed": False,
                "release_claim_allowed": False,
                "linux_memory_claim_allowed": False,
                "memory_bandwidth_claim_allowed": False,
                "lpddr_phy_claim_allowed": False,
                "silicon_capacity_claim_allowed": False,
                "uma_claim_allowed": False,
                "raw_log_path": str(raw_log.relative_to(templates.ROOT)),
                "raw_stats_path": str(raw_stats.relative_to(templates.ROOT)),
                "raw_artifacts": [
                    {"path": str(raw_log.relative_to(templates.ROOT)), "sha256": "0" * 64},
                    {
                        "path": str(raw_stats.relative_to(templates.ROOT)),
                        "sha256": templates.sha256_file(raw_stats),
                    },
                ],
            }
            report_path = root / "dramsim3_lpddr5x_10667_microbench.json"
            report_path.write_text(json.dumps(report), encoding="utf-8")

            errors: list[str] = []
            templates.validate_dramsim_report(
                str(report_path.relative_to(templates.ROOT)),
                "lpddr5x_10667",
                "microbench",
                22.41,
                134.43,
                errors,
            )

        self.assertTrue(any("sha256 does not match" in error for error in errors), errors)

    def test_dramsim_aggregate_over_peak_bandwidth_is_rejected(self) -> None:
        aggregate = yaml.safe_load(templates.DRAM_SIM_EVIDENCE.read_text())
        aggregate["skus"][0]["sustained_bandwidth_gbps"]["microbench"] = 999.0
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "dram_sim_evidence.yaml"
            path.write_text(yaml.safe_dump(aggregate), encoding="utf-8")

            errors: list[str] = []
            templates.validate_dramsim_aggregate(errors, path)

        self.assertTrue(any("exceeds JEDEC peak" in error for error in errors), errors)


if __name__ == "__main__":
    unittest.main()
