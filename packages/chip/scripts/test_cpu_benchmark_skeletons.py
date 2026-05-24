#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CALIBRATION_DIR = ROOT / "build/tmp/benchmark-skeletons/calibration"
CLOCK_EVIDENCE = CALIBRATION_DIR / "clock-source.txt"
POWER_EVIDENCE = CALIBRATION_DIR / "power-meter.txt"
CLOCK_EVIDENCE_TEXT = "clock calibration transcript\n"
POWER_EVIDENCE_TEXT = "power calibration transcript\n"
COREMARK_BINARY_EVIDENCE_TEXT = "coremark target binary provenance\n"
DHRYSTONE_BINARY_EVIDENCE_TEXT = "dhrystone target binary provenance\n"
JETSTREAM_ENGINE_EVIDENCE_TEXT = "jetstream engine provenance\n"
CLOCK_EVIDENCE_SHA = hashlib.sha256(CLOCK_EVIDENCE_TEXT.encode("utf-8")).hexdigest()
POWER_EVIDENCE_SHA = hashlib.sha256(POWER_EVIDENCE_TEXT.encode("utf-8")).hexdigest()
COREMARK_BINARY_EVIDENCE_SHA = hashlib.sha256(
    COREMARK_BINARY_EVIDENCE_TEXT.encode("utf-8")
).hexdigest()
DHRYSTONE_BINARY_EVIDENCE_SHA = hashlib.sha256(
    DHRYSTONE_BINARY_EVIDENCE_TEXT.encode("utf-8")
).hexdigest()
JETSTREAM_ENGINE_EVIDENCE_SHA = hashlib.sha256(
    JETSTREAM_ENGINE_EVIDENCE_TEXT.encode("utf-8")
).hexdigest()
PROCESS_EFFECTS_CONTRACT = ROOT / "docs/spec-db/process-14a-effects.yaml"
PROCESS_EFFECTS_CONTRACT_SHA = hashlib.sha256(PROCESS_EFFECTS_CONTRACT.read_bytes()).hexdigest()


class PreserveFile:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.saved: bytes | None = None
        self.existed = False

    def __enter__(self) -> None:
        self.existed = self.path.exists()
        if self.existed:
            self.saved = self.path.read_bytes()

    def __exit__(self, exc_type, exc, tb) -> None:
        if self.existed and self.saved is not None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_bytes(self.saved)
        elif self.path.exists():
            self.path.unlink()


def run_script(script: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    merged = os.environ.copy()
    merged.update(env)
    return subprocess.run(
        [str(ROOT / script)],
        cwd=ROOT,
        env=merged,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def load_result(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def ensure_calibration_evidence() -> None:
    CALIBRATION_DIR.mkdir(parents=True, exist_ok=True)
    CLOCK_EVIDENCE.write_text(CLOCK_EVIDENCE_TEXT, encoding="utf-8")
    POWER_EVIDENCE.write_text(POWER_EVIDENCE_TEXT, encoding="utf-8")
    (CALIBRATION_DIR / "coremark-binary.txt").write_text(
        COREMARK_BINARY_EVIDENCE_TEXT, encoding="utf-8"
    )
    (CALIBRATION_DIR / "dhrystone-binary.txt").write_text(
        DHRYSTONE_BINARY_EVIDENCE_TEXT, encoding="utf-8"
    )
    (CALIBRATION_DIR / "jetstream-engine.txt").write_text(
        JETSTREAM_ENGINE_EVIDENCE_TEXT, encoding="utf-8"
    )


def target_metadata_json(target: str = "prototype") -> str:
    ensure_calibration_evidence()
    payload = {
        "target": target,
        "software": {
            "os": "linux",
            "kernel": "6.9-e1",
            "firmware": "e1-fw-test",
            "runtime": "target-shell",
            "build_id": "test-build",
        },
        "clocks": {
            "source": "calibrated_counter",
            "cpu_hz": 1_000_000_000,
            "governor": "performance",
        },
        "memory": {
            "type": "lpddr5x",
            "capacity_bytes": 8_589_934_592,
            "bandwidth_bytes_per_second": 120_000_000_000,
            "channels": 4,
        },
        "power": {
            "source": "bench_meter",
            "watts": 2.5,
            "measurement_method": "shunt",
            "sample_count": 32,
            "averaging_window_seconds": 10.0,
        },
        "thermal": {
            "ambient_c": 25.0,
            "die_c": 41.0,
            "cooling": "passive",
            "throttle_state": "none",
        },
        "process": {
            "node": "prototype",
            "pdk": "prototype",
            "process_effects_contract": {
                "path": "docs/spec-db/process-14a-effects.yaml",
                "sha256": PROCESS_EFFECTS_CONTRACT_SHA,
            },
            "process_corner_count": 1,
            "worst_process_corner": "prototype_tt",
            "pdk_signoff_claim": "prototype-measured-not-release-signoff",
        },
        "calibration": {
            "status": "calibrated",
            "source": "lab",
            "ground_truth_reference": "calibrated instruments",
            "last_calibrated_utc": "2026-05-22T00:00:00Z",
            "assets": {
                "clock_source": {
                    "status": "calibrated",
                    "source": "counter-correlation",
                    "sha256": CLOCK_EVIDENCE_SHA,
                    "evidence": str(CLOCK_EVIDENCE.relative_to(ROOT)),
                },
                "power_meter": {
                    "status": "calibrated",
                    "source": "bench meter",
                    "sha256": POWER_EVIDENCE_SHA,
                    "evidence": str(POWER_EVIDENCE.relative_to(ROOT)),
                },
                "coremark_binary": {
                    "status": "calibrated",
                    "source": "target build",
                    "sha256": COREMARK_BINARY_EVIDENCE_SHA,
                    "evidence": str((CALIBRATION_DIR / "coremark-binary.txt").relative_to(ROOT)),
                },
                "dhrystone_binary": {
                    "status": "calibrated",
                    "source": "target build",
                    "sha256": DHRYSTONE_BINARY_EVIDENCE_SHA,
                    "evidence": str((CALIBRATION_DIR / "dhrystone-binary.txt").relative_to(ROOT)),
                },
                "jetstream_engine": {
                    "status": "calibrated",
                    "source": "target build",
                    "sha256": JETSTREAM_ENGINE_EVIDENCE_SHA,
                    "evidence": str((CALIBRATION_DIR / "jetstream-engine.txt").relative_to(ROOT)),
                },
            },
        },
    }
    return json.dumps(payload) + "\n"


def spec_run_manifest_json(raw: Path) -> str:
    config = raw.parent / "e1.cfg"
    config.write_text("fake SPEC config fixture\n", encoding="utf-8")
    payload = {
        "schema": "eliza.spec_cpu2017_run_manifest.v1",
        "spec_version": "SPEC CPU2017 v1.1.9",
        "runcpu_command": "runcpu --config=e1.cfg --reportable --tune=base",
        "config": str(config),
        "config_sha256": hashlib.sha256(config.read_bytes()).hexdigest(),
        "reportable": True,
        "result_bundle": str(raw),
        "result_bundle_sha256": hashlib.sha256(raw.read_bytes()).hexdigest(),
    }
    return json.dumps(payload) + "\n"


def archived_tmp_root() -> str:
    root = ROOT / "build/tmp/benchmark-skeletons"
    root.mkdir(parents=True, exist_ok=True)
    return str(root)


def test_jetstream_rejects_empty_engine_directory() -> None:
    result_path = ROOT / "benchmarks/results/cpu/jetstream/result.json"
    engine_dir = ROOT / "external/v8-riscv64"
    if engine_dir.exists():
        raise AssertionError(f"test expects no pre-existing {engine_dir}")
    with PreserveFile(result_path):
        engine_dir.mkdir(parents=True)
        try:
            proc = run_script("scripts/run_jetstream.sh", {"E1_JETSTREAM_ENGINE_BIN": ""})
            result = load_result(result_path)
        finally:
            shutil.rmtree(engine_dir)
    if proc.returncode != 0:
        raise AssertionError(proc.stdout)
    reason = result.get("reason", "")
    if "no executable JS engine RISC-V build available" not in reason:
        raise AssertionError(result)
    print("PASS JetStream rejects empty engine directory")


def test_jetstream_accepts_explicit_engine_before_dut_gate() -> None:
    result_path = ROOT / "benchmarks/results/cpu/jetstream/result.json"
    with tempfile.TemporaryDirectory(dir=archived_tmp_root()) as tmp, PreserveFile(result_path):
        engine = Path(tmp) / "d8"
        engine.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        engine.chmod(0o755)
        proc = run_script(
            "scripts/run_jetstream.sh",
            {"E1_JETSTREAM_ENGINE_BIN": str(engine), "E1_JETSTREAM_DUT": ""},
        )
        result = load_result(result_path)
    if proc.returncode != 0:
        raise AssertionError(proc.stdout)
    if "E1_JETSTREAM_DUT not set" not in result.get("reason", ""):
        raise AssertionError(result)
    print("PASS JetStream explicit engine reaches DUT gate")


def test_jetstream_blocked_reason_quotes_engine_path() -> None:
    result_path = ROOT / "benchmarks/results/cpu/jetstream/result.json"
    with tempfile.TemporaryDirectory(dir=archived_tmp_root()) as tmp, PreserveFile(result_path):
        engine = Path(tmp) / 'missing "d8"'
        proc = run_script(
            "scripts/run_jetstream.sh",
            {"E1_JETSTREAM_ENGINE_BIN": str(engine)},
        )
        result = load_result(result_path)
    if proc.returncode != 0:
        raise AssertionError(proc.stdout)
    if result.get("status") != "blocked" or str(engine) not in result.get("reason", ""):
        raise AssertionError(result)
    print("PASS JetStream blocked reason quotes engine path")


def test_jetstream_ingests_target_transcript_without_local_engine() -> None:
    result_path = ROOT / "benchmarks/results/cpu/jetstream/result.json"
    with tempfile.TemporaryDirectory(dir=archived_tmp_root()) as tmp, PreserveFile(result_path):
        tmp_path = Path(tmp)
        raw = tmp_path / "jetstream-target.log"
        raw.write_text(
            "BrowserBench JetStream 2.2\nJetStream 2 Score: 271.5\n",
            encoding="utf-8",
        )
        metadata = tmp_path / "target-metadata.json"
        metadata.write_text(target_metadata_json(), encoding="utf-8")
        proc = run_script(
            "scripts/run_jetstream.sh",
            {
                "E1_JETSTREAM_RAW_OUTPUT": str(raw),
                "E1_JETSTREAM_TARGET_METADATA": str(metadata),
                "E1_JETSTREAM_TARGET_RUNNER": "prototype",
            },
        )
        result = load_result(result_path)
    if proc.returncode != 0:
        raise AssertionError(proc.stdout)
    if result.get("status") != "passed" or result.get("provenance") != "target-measured":
        raise AssertionError(result)
    if result.get("target_execution", {}).get("runner") != "prototype":
        raise AssertionError(result)
    if result.get("metrics", {}).get("jetstream2_score") != 271.5:
        raise AssertionError(result)
    print("PASS JetStream ingests target transcript")


def test_l5_l6_target_command_capture_ingests_transcript() -> None:
    cases = [
        (
            "scripts/run_coremark_l5_l6.sh",
            ROOT / "benchmarks/results/cpu/coremark/l5_l6_result.json",
            "E1_COREMARK_TARGET_CMD",
            "E1_COREMARK_TARGET_METADATA",
            "E1_COREMARK_TARGET_RUNNER",
            "printf '%s\\n' 'CoreMark Size    : 666' "
            "'Correct operation validated. See README.md for run and reporting rules.' "
            "'Iterations/Sec   : 12345.67' 'CoreMark/MHz     : 8.90'",
            "coremark_per_mhz",
            8.9,
        ),
        (
            "scripts/run_dhrystone_l5_l6.sh",
            ROOT / "benchmarks/results/cpu/dhrystone/l5_l6_result.json",
            "E1_DHRYSTONE_TARGET_CMD",
            "E1_DHRYSTONE_TARGET_METADATA",
            "E1_DHRYSTONE_TARGET_RUNNER",
            "printf '%s\\n' 'Dhrystone Benchmark, Version 2.1 (Language: C)' "
            "'Dhrystones per Second: 987654.0' 'DMIPS/MHz: 3.21'",
            "dmips_per_mhz",
            3.21,
        ),
        (
            "scripts/run_jetstream.sh",
            ROOT / "benchmarks/results/cpu/jetstream/result.json",
            "E1_JETSTREAM_TARGET_CMD",
            "E1_JETSTREAM_TARGET_METADATA",
            "E1_JETSTREAM_TARGET_RUNNER",
            "printf '%s\\n' 'BrowserBench JetStream 2.2' 'JetStream 2 Score: 271.5'",
            "jetstream2_score",
            271.5,
        ),
    ]
    captured_paths: list[Path] = []
    try:
        for (
            script,
            result_path,
            command_env,
            metadata_env,
            runner_env,
            command,
            metric_name,
            metric_value,
        ) in cases:
            with (
                tempfile.TemporaryDirectory(dir=archived_tmp_root()) as tmp,
                PreserveFile(result_path),
            ):
                tmp_path = Path(tmp)
                metadata = tmp_path / "target-metadata.json"
                metadata.write_text(target_metadata_json(), encoding="utf-8")
                proc = run_script(
                    script,
                    {
                        command_env: command,
                        metadata_env: str(metadata),
                        runner_env: "prototype",
                    },
                )
                result = load_result(result_path)
                raw_output = Path(result.get("artifacts", {}).get("raw_output", ""))
                if raw_output.is_file():
                    captured_paths.append(raw_output)
            if proc.returncode != 0:
                raise AssertionError(proc.stdout)
            if result.get("status") != "passed" or result.get("provenance") != "target-measured":
                raise AssertionError((script, result))
            if result.get("metrics", {}).get(metric_name) != metric_value:
                raise AssertionError((script, result))
            if not raw_output.is_file() or ROOT not in raw_output.resolve().parents:
                raise AssertionError((script, result))
    finally:
        for path in captured_paths:
            path.unlink(missing_ok=True)
    print("PASS L5/L6 target commands capture and ingest transcripts")


def test_jetstream_quotes_artifact_paths() -> None:
    result_path = ROOT / "benchmarks/results/cpu/jetstream/result.json"
    with tempfile.TemporaryDirectory(dir=archived_tmp_root()) as tmp, PreserveFile(result_path):
        tmp_path = Path(tmp)
        raw = tmp_path / 'jetstream "target".log'
        raw.write_text(
            "BrowserBench JetStream 2.2\nJetStream 2 Score: 271.5\n",
            encoding="utf-8",
        )
        metadata = tmp_path / 'target "metadata".json'
        metadata.write_text(target_metadata_json(), encoding="utf-8")
        proc = run_script(
            "scripts/run_jetstream.sh",
            {
                "E1_JETSTREAM_RAW_OUTPUT": str(raw),
                "E1_JETSTREAM_TARGET_METADATA": str(metadata),
                "E1_JETSTREAM_TARGET_RUNNER": "prototype",
            },
        )
        result = load_result(result_path)
    if proc.returncode != 0:
        raise AssertionError(proc.stdout)
    artifacts = result.get("artifacts", {})
    if artifacts.get("raw_output") != str(raw) or artifacts.get("target_metadata") != str(metadata):
        raise AssertionError(result)
    print("PASS JetStream quotes artifact paths")


def test_spec_fake_install_reaches_target_runner_or_llvm_gate() -> None:
    result_path = ROOT / "benchmarks/results/cpu/spec/result.json"
    with tempfile.TemporaryDirectory(dir=archived_tmp_root()) as tmp, PreserveFile(result_path):
        spec = Path(tmp) / "spec"
        (spec / "bin").mkdir(parents=True)
        runcpu = spec / "bin/runcpu"
        runcpu.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        runcpu.chmod(0o755)
        (spec / "version.txt").write_text("SPEC CPU2017 v1.1.9\n", encoding="utf-8")
        license_file = spec / "license.txt"
        license_text = "fake local license fixture for fail-closed harness tests\n"
        license_file.write_text(license_text, encoding="utf-8")
        license_sha = hashlib.sha256(license_text.encode("utf-8")).hexdigest()
        proc = run_script(
            "scripts/run_spec.sh",
            {
                "SPEC_DIR": str(spec),
                "SPEC_LICENSE_FILE": str(license_file),
                "SPEC_LICENSE_SHA256": license_sha,
                "E1_SPEC_DUT": "firesim",
            },
        )
        result = load_result(result_path)
    if proc.returncode != 0:
        raise AssertionError(proc.stdout)
    reason = result.get("reason", "")
    if (
        "no target runner is implemented yet" not in reason
        and "pinned LLVM RISC-V clang absent" not in reason
    ):
        raise AssertionError(result)
    if "compiler agent's pinned LLVM" in reason:
        raise AssertionError(result)
    print("PASS SPEC skeleton reports current concrete blocker")


def test_spec_blocked_reason_quotes_spec_dir_path() -> None:
    result_path = ROOT / "benchmarks/results/cpu/spec/result.json"
    with tempfile.TemporaryDirectory(dir=archived_tmp_root()) as tmp, PreserveFile(result_path):
        spec_dir = Path(tmp) / 'licensed "spec"'
        spec_dir.mkdir()
        proc = run_script(
            "scripts/run_spec.sh",
            {"SPEC_DIR": str(spec_dir)},
        )
        result = load_result(result_path)
    if proc.returncode != 0:
        raise AssertionError(proc.stdout)
    if result.get("status") != "blocked" or str(spec_dir) not in result.get("reason", ""):
        raise AssertionError(result)
    print("PASS SPEC blocked reason quotes SPEC_DIR path")


def test_spec_ingests_target_transcript_without_local_spec_dir() -> None:
    result_path = ROOT / "benchmarks/results/cpu/spec/result.json"
    with tempfile.TemporaryDirectory(dir=archived_tmp_root()) as tmp, PreserveFile(result_path):
        tmp_path = Path(tmp)
        raw = tmp_path / "spec-target-report.txt"
        raw.write_text(
            "SPEC CPU2017 Result Summary\n"
            "runcpu --config=e1.cfg --reportable --tune=base\n"
            "Reportable: yes\n"
            "SPECint2017_rate_base: 9.10\n"
            "SPECint2017_speed_base: 7.20\n"
            "SPECfp2017_rate_base: 7.00\n"
            "SPECfp2017_speed_base: 6.80\n",
            encoding="utf-8",
        )
        metadata = tmp_path / "target-metadata.json"
        metadata.write_text(target_metadata_json(), encoding="utf-8")
        run_manifest = tmp_path / "spec-run-manifest.json"
        run_manifest.write_text(spec_run_manifest_json(raw), encoding="utf-8")
        license_sha = hashlib.sha256(b"licensed-spec-run-entitlement-fixture").hexdigest()
        proc = run_script(
            "scripts/run_spec.sh",
            {
                "E1_SPEC_RAW_OUTPUT": str(raw),
                "E1_SPEC_TARGET_METADATA": str(metadata),
                "E1_SPEC_TARGET_RUNNER": "prototype",
                "E1_SPEC_RUN_MANIFEST": str(run_manifest),
                "SPEC_LICENSE_SHA256": license_sha,
            },
        )
        result = load_result(result_path)
    if proc.returncode != 0:
        raise AssertionError(proc.stdout)
    if result.get("status") != "passed" or result.get("provenance") != "target-measured":
        raise AssertionError(result)
    if result.get("target_execution", {}).get("runner") != "prototype":
        raise AssertionError(result)
    artifacts = result.get("artifacts", {})
    if artifacts.get("spec_license_sha256") != license_sha:
        raise AssertionError(result)
    metrics = result.get("metrics", {})
    expected = {
        "specint2017_rate_base": 9.1,
        "specint2017_speed_base": 7.2,
        "specfp2017_rate_base": 7.0,
        "specfp2017_speed_base": 6.8,
    }
    for key, value in expected.items():
        if metrics.get(key) != value:
            raise AssertionError(result)
    print("PASS SPEC ingests target transcript")


def test_spec_target_command_capture_ingests_transcript() -> None:
    result_path = ROOT / "benchmarks/results/cpu/spec/result.json"
    transcript = (
        "SPEC CPU2017 runcpu reportable base run\n"
        "SPECint2017_rate_base: 9.10\n"
        "SPECint2017_speed_base: 7.20\n"
        "SPECfp2017_rate_base: 7.00\n"
        "SPECfp2017_speed_base: 6.80\n"
    )
    with tempfile.TemporaryDirectory(dir=archived_tmp_root()) as tmp, PreserveFile(result_path):
        tmp_path = Path(tmp)
        raw = tmp_path / "spec-target-capture.log"
        raw.write_text(transcript, encoding="utf-8")
        metadata = tmp_path / "target-metadata.json"
        metadata.write_text(target_metadata_json(), encoding="utf-8")
        run_manifest = tmp_path / "spec-run-manifest.json"
        run_manifest.write_text(spec_run_manifest_json(raw), encoding="utf-8")
        raw.unlink()
        command = (
            "printf '%s\\n' 'SPEC CPU2017 runcpu reportable base run' "
            "'SPECint2017_rate_base: 9.10' "
            "'SPECint2017_speed_base: 7.20' "
            "'SPECfp2017_rate_base: 7.00' "
            "'SPECfp2017_speed_base: 6.80'"
        )
        proc = run_script(
            "scripts/run_spec.sh",
            {
                "E1_SPEC_TARGET_CMD": command,
                "E1_SPEC_TARGET_CAPTURE_OUTPUT": str(raw),
                "E1_SPEC_TARGET_METADATA": str(metadata),
                "E1_SPEC_TARGET_RUNNER": "prototype",
                "E1_SPEC_RUN_MANIFEST": str(run_manifest),
                "SPEC_LICENSE_SHA256": hashlib.sha256(
                    b"licensed-spec-run-entitlement-fixture"
                ).hexdigest(),
            },
        )
        result = load_result(result_path)
    if proc.returncode != 0:
        raise AssertionError(proc.stdout)
    if result.get("status") != "passed" or result.get("provenance") != "target-measured":
        raise AssertionError(result)
    if result.get("metrics", {}).get("specint2017_rate_base") != 9.10:
        raise AssertionError(result)
    print("PASS SPEC target command captures and ingests transcript")


def test_coremark_l5_l6_ingests_target_transcript() -> None:
    result_path = ROOT / "benchmarks/results/cpu/coremark/l5_l6_result.json"
    with tempfile.TemporaryDirectory(dir=archived_tmp_root()) as tmp, PreserveFile(result_path):
        tmp_path = Path(tmp)
        raw = tmp_path / "coremark-target.log"
        raw.write_text(
            "CoreMark Size    : 666\n"
            "Correct operation validated. See README.md for run and reporting rules.\n"
            "Iterations/Sec   : 12345.67\n"
            "CoreMark/MHz     : 8.90\n",
            encoding="utf-8",
        )
        metadata = tmp_path / "target-metadata.json"
        metadata.write_text(target_metadata_json(), encoding="utf-8")
        proc = run_script(
            "scripts/run_coremark_l5_l6.sh",
            {
                "E1_COREMARK_RAW_OUTPUT": str(raw),
                "E1_COREMARK_TARGET_METADATA": str(metadata),
                "E1_COREMARK_TARGET_RUNNER": "prototype",
            },
        )
        result = load_result(result_path)
    if proc.returncode != 0:
        raise AssertionError(proc.stdout)
    if result.get("status") != "passed" or result.get("provenance") != "target-measured":
        raise AssertionError(result)
    if result.get("target_execution", {}).get("runner") != "prototype":
        raise AssertionError(result)
    metrics = result.get("metrics", {})
    if metrics.get("iterations_per_second") != 12345.67 or metrics.get("coremark_per_mhz") != 8.9:
        raise AssertionError(result)
    print("PASS CoreMark L5/L6 ingests target transcript")


def test_coremark_l5_l6_rejects_placeholder_metadata() -> None:
    result_path = ROOT / "benchmarks/results/cpu/coremark/l5_l6_result.json"
    with tempfile.TemporaryDirectory(dir=archived_tmp_root()) as tmp, PreserveFile(result_path):
        tmp_path = Path(tmp)
        raw = tmp_path / "coremark-target.log"
        raw.write_text(
            "CoreMark Size    : 666\n"
            "Correct operation validated. See README.md for run and reporting rules.\n"
            "Iterations/Sec   : 12345.67\n"
            "CoreMark/MHz     : 8.90\n",
            encoding="utf-8",
        )
        metadata = tmp_path / "target-metadata.json"
        metadata.write_text(
            '{"target":"prototype","clock_source":"calibrated"}\n', encoding="utf-8"
        )
        proc = run_script(
            "scripts/run_coremark_l5_l6.sh",
            {
                "E1_COREMARK_RAW_OUTPUT": str(raw),
                "E1_COREMARK_TARGET_METADATA": str(metadata),
                "E1_COREMARK_TARGET_RUNNER": "prototype",
            },
        )
        result = load_result(result_path)
    if proc.returncode != 0:
        raise AssertionError(proc.stdout)
    if result.get("status") != "blocked":
        raise AssertionError(result)
    if "metadata contract" not in result.get("reason", ""):
        raise AssertionError(result)
    print("PASS CoreMark L5/L6 rejects placeholder metadata")


def test_coremark_l5_l6_invalid_metadata_writes_valid_json_blocker() -> None:
    result_path = ROOT / "benchmarks/results/cpu/coremark/l5_l6_result.json"
    with tempfile.TemporaryDirectory(dir=archived_tmp_root()) as tmp, PreserveFile(result_path):
        tmp_path = Path(tmp)
        raw = tmp_path / "coremark-target.log"
        raw.write_text(
            "CoreMark Size    : 666\n"
            "Correct operation validated. See README.md for run and reporting rules.\n"
            "Iterations/Sec   : 12345.67\n"
            "CoreMark/MHz     : 8.90\n",
            encoding="utf-8",
        )
        metadata = tmp_path / "target-metadata.json"
        metadata.write_text('{"target": "prototype", bad json}\n', encoding="utf-8")
        proc = run_script(
            "scripts/run_coremark_l5_l6.sh",
            {
                "E1_COREMARK_RAW_OUTPUT": str(raw),
                "E1_COREMARK_TARGET_METADATA": str(metadata),
                "E1_COREMARK_TARGET_RUNNER": "prototype",
            },
        )
        result = load_result(result_path)
    if proc.returncode != 0:
        raise AssertionError(proc.stdout)
    if result.get("status") != "blocked":
        raise AssertionError(result)
    requirements = result.get("blocked_requirements", [])
    reason = requirements[0].get("reason", "") if requirements else ""
    if "valid JSON" not in reason:
        raise AssertionError(result)
    print("PASS CoreMark L5/L6 invalid metadata writes valid JSON blocker")


def test_coremark_l5_l6_rejects_missing_calibration_evidence() -> None:
    result_path = ROOT / "benchmarks/results/cpu/coremark/l5_l6_result.json"
    with tempfile.TemporaryDirectory(dir=archived_tmp_root()) as tmp, PreserveFile(result_path):
        tmp_path = Path(tmp)
        raw = tmp_path / "coremark-target.log"
        raw.write_text(
            "CoreMark Size    : 666\n"
            "Correct operation validated. See README.md for run and reporting rules.\n"
            "Iterations/Sec   : 12345.67\n"
            "CoreMark/MHz     : 8.90\n",
            encoding="utf-8",
        )
        metadata = tmp_path / "target-metadata.json"
        metadata.write_text(target_metadata_json(), encoding="utf-8")
        CLOCK_EVIDENCE.unlink()
        proc = run_script(
            "scripts/run_coremark_l5_l6.sh",
            {
                "E1_COREMARK_RAW_OUTPUT": str(raw),
                "E1_COREMARK_TARGET_METADATA": str(metadata),
                "E1_COREMARK_TARGET_RUNNER": "prototype",
            },
        )
        result = load_result(result_path)
    if proc.returncode != 0:
        raise AssertionError(proc.stdout)
    if result.get("status") != "blocked":
        raise AssertionError(result)
    details = result.get("reason", "") + " " + json.dumps(result.get("blocked_requirements", []))
    if "clock_source.evidence artifact is missing" not in details:
        raise AssertionError(result)
    print("PASS CoreMark L5/L6 rejects missing calibration evidence")


def test_coremark_l5_l6_rejects_tampered_calibration_evidence() -> None:
    result_path = ROOT / "benchmarks/results/cpu/coremark/l5_l6_result.json"
    with tempfile.TemporaryDirectory(dir=archived_tmp_root()) as tmp, PreserveFile(result_path):
        tmp_path = Path(tmp)
        raw = tmp_path / "coremark-target.log"
        raw.write_text(
            "CoreMark Size    : 666\n"
            "Correct operation validated. See README.md for run and reporting rules.\n"
            "Iterations/Sec   : 12345.67\n"
            "CoreMark/MHz     : 8.90\n",
            encoding="utf-8",
        )
        metadata = tmp_path / "target-metadata.json"
        metadata.write_text(target_metadata_json(), encoding="utf-8")
        POWER_EVIDENCE.write_text("tampered power calibration transcript\n", encoding="utf-8")
        proc = run_script(
            "scripts/run_coremark_l5_l6.sh",
            {
                "E1_COREMARK_RAW_OUTPUT": str(raw),
                "E1_COREMARK_TARGET_METADATA": str(metadata),
                "E1_COREMARK_TARGET_RUNNER": "prototype",
            },
        )
        result = load_result(result_path)
    if proc.returncode != 0:
        raise AssertionError(proc.stdout)
    if result.get("status") != "blocked":
        raise AssertionError(result)
    details = result.get("reason", "") + " " + json.dumps(result.get("blocked_requirements", []))
    if "power_meter.sha256 does not match evidence artifact" not in details:
        raise AssertionError(result)
    print("PASS CoreMark L5/L6 rejects tampered calibration evidence")


def test_coremark_l5_l6_quotes_artifact_paths() -> None:
    result_path = ROOT / "benchmarks/results/cpu/coremark/l5_l6_result.json"
    with tempfile.TemporaryDirectory(dir=archived_tmp_root()) as tmp, PreserveFile(result_path):
        tmp_path = Path(tmp)
        raw = tmp_path / 'coremark "target".log'
        raw.write_text(
            "CoreMark Size    : 666\n"
            "Correct operation validated. See README.md for run and reporting rules.\n"
            "Iterations/Sec   : 12345.67\n"
            "CoreMark/MHz     : 8.90\n",
            encoding="utf-8",
        )
        metadata = tmp_path / 'target "metadata".json'
        metadata.write_text(target_metadata_json(), encoding="utf-8")
        proc = run_script(
            "scripts/run_coremark_l5_l6.sh",
            {
                "E1_COREMARK_RAW_OUTPUT": str(raw),
                "E1_COREMARK_TARGET_METADATA": str(metadata),
                "E1_COREMARK_TARGET_RUNNER": "prototype",
            },
        )
        result = load_result(result_path)
    if proc.returncode != 0:
        raise AssertionError(proc.stdout)
    artifacts = result.get("artifacts", {})
    if artifacts.get("raw_output") != str(raw) or artifacts.get("target_metadata") != str(metadata):
        raise AssertionError(result)
    print("PASS CoreMark L5/L6 quotes artifact paths")


def test_metadata_contract_rejects_local_timestamp_and_uppercase_hash() -> None:
    with tempfile.TemporaryDirectory(dir=archived_tmp_root()) as tmp:
        metadata = Path(tmp) / "target-metadata.json"
        payload = json.loads(target_metadata_json())
        payload["calibration"]["last_calibrated_utc"] = "2026-05-22 00:00:00"
        payload["calibration"]["assets"]["clock_source"]["sha256"] = "A" * 64
        metadata.write_text(json.dumps(payload) + "\n", encoding="utf-8")
        proc = subprocess.run(
            [
                "python3",
                str(ROOT / "scripts/target_metadata_contract.py"),
                str(metadata),
                "--runner",
                "prototype",
            ],
            cwd=ROOT,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
    if proc.returncode != 2:
        raise AssertionError(proc.stdout)
    if "last_calibrated_utc" not in proc.stdout or "lowercase sha256" not in proc.stdout:
        raise AssertionError(proc.stdout)
    print("PASS target metadata contract rejects local timestamp and uppercase hash")


def test_metadata_contract_rejects_process_contract_drift() -> None:
    with tempfile.TemporaryDirectory(dir=archived_tmp_root()) as tmp:
        metadata = Path(tmp) / "target-metadata.json"
        payload = json.loads(target_metadata_json())
        payload["process"]["process_effects_contract"]["sha256"] = "1" * 64
        metadata.write_text(json.dumps(payload) + "\n", encoding="utf-8")
        proc = subprocess.run(
            [
                "python3",
                str(ROOT / "scripts/target_metadata_contract.py"),
                str(metadata),
                "--runner",
                "prototype",
                "--artifact-root",
                str(ROOT),
            ],
            cwd=ROOT,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
    if proc.returncode != 2:
        raise AssertionError(proc.stdout)
    if "process_effects_contract.sha256" not in proc.stdout:
        raise AssertionError(proc.stdout)
    print("PASS target metadata contract rejects process contract drift")


def test_dhrystone_l5_l6_ingests_target_transcript() -> None:
    result_path = ROOT / "benchmarks/results/cpu/dhrystone/l5_l6_result.json"
    with tempfile.TemporaryDirectory(dir=archived_tmp_root()) as tmp, PreserveFile(result_path):
        tmp_path = Path(tmp)
        raw = tmp_path / "dhrystone-target.log"
        raw.write_text(
            "Dhrystone Benchmark, Version 2.1 (Language: C)\n"
            "Dhrystones per Second: 987654.0\n"
            "DMIPS/MHz: 3.21\n",
            encoding="utf-8",
        )
        metadata = tmp_path / "target-metadata.json"
        metadata.write_text(target_metadata_json(), encoding="utf-8")
        proc = run_script(
            "scripts/run_dhrystone_l5_l6.sh",
            {
                "E1_DHRYSTONE_RAW_OUTPUT": str(raw),
                "E1_DHRYSTONE_TARGET_METADATA": str(metadata),
                "E1_DHRYSTONE_TARGET_RUNNER": "prototype",
            },
        )
        result = load_result(result_path)
    if proc.returncode != 0:
        raise AssertionError(proc.stdout)
    if result.get("status") != "passed" or result.get("provenance") != "target-measured":
        raise AssertionError(result)
    if result.get("target_execution", {}).get("runner") != "prototype":
        raise AssertionError(result)
    metrics = result.get("metrics", {})
    if metrics.get("dhrystones_per_second") != 987654.0 or metrics.get("dmips_per_mhz") != 3.21:
        raise AssertionError(result)
    print("PASS Dhrystone L5/L6 ingests target transcript")


def test_dhrystone_l5_l6_quotes_artifact_paths() -> None:
    result_path = ROOT / "benchmarks/results/cpu/dhrystone/l5_l6_result.json"
    with tempfile.TemporaryDirectory(dir=archived_tmp_root()) as tmp, PreserveFile(result_path):
        tmp_path = Path(tmp)
        raw = tmp_path / 'dhrystone "target".log'
        raw.write_text(
            "Dhrystone Benchmark, Version 2.1 (Language: C)\n"
            "Dhrystones per Second: 987654.0\n"
            "DMIPS/MHz: 3.21\n",
            encoding="utf-8",
        )
        metadata = tmp_path / 'target "metadata".json'
        metadata.write_text(target_metadata_json(), encoding="utf-8")
        proc = run_script(
            "scripts/run_dhrystone_l5_l6.sh",
            {
                "E1_DHRYSTONE_RAW_OUTPUT": str(raw),
                "E1_DHRYSTONE_TARGET_METADATA": str(metadata),
                "E1_DHRYSTONE_TARGET_RUNNER": "prototype",
            },
        )
        result = load_result(result_path)
    if proc.returncode != 0:
        raise AssertionError(proc.stdout)
    artifacts = result.get("artifacts", {})
    if artifacts.get("raw_output") != str(raw) or artifacts.get("target_metadata") != str(metadata):
        raise AssertionError(result)
    print("PASS Dhrystone L5/L6 quotes artifact paths")


def test_score_only_transcripts_do_not_promote_l5_l6() -> None:
    cases = [
        (
            "scripts/run_coremark_l5_l6.sh",
            ROOT / "benchmarks/results/cpu/coremark/l5_l6_result.json",
            "coremark-score-only.log",
            "Iterations/Sec   : 12345.67\nCoreMark/MHz     : 8.90\n",
            {
                "E1_COREMARK_RAW_OUTPUT": None,
                "E1_COREMARK_TARGET_METADATA": None,
                "E1_COREMARK_TARGET_RUNNER": "prototype",
            },
            "CoreMark",
        ),
        (
            "scripts/run_dhrystone_l5_l6.sh",
            ROOT / "benchmarks/results/cpu/dhrystone/l5_l6_result.json",
            "dhrystone-score-only.log",
            "Dhrystones per Second: 987654.0\nDMIPS/MHz: 3.21\n",
            {
                "E1_DHRYSTONE_RAW_OUTPUT": None,
                "E1_DHRYSTONE_TARGET_METADATA": None,
                "E1_DHRYSTONE_TARGET_RUNNER": "prototype",
            },
            "Dhrystone",
        ),
        (
            "scripts/run_jetstream.sh",
            ROOT / "benchmarks/results/cpu/jetstream/result.json",
            "jetstream-score-only.log",
            "JetStream 2 Score: 271.5\n",
            {
                "E1_JETSTREAM_RAW_OUTPUT": None,
                "E1_JETSTREAM_TARGET_METADATA": None,
                "E1_JETSTREAM_TARGET_RUNNER": "prototype",
            },
            "JetStream",
        ),
        (
            "scripts/run_spec.sh",
            ROOT / "benchmarks/results/cpu/spec/result.json",
            "spec-score-only.log",
            "SPECint2017_rate_base: 9.10\nSPECint2017_speed_base: 7.20\nSPECfp2017_rate_base: 7.00\nSPECfp2017_speed_base: 6.80\n",
            {
                "E1_SPEC_RAW_OUTPUT": None,
                "E1_SPEC_TARGET_METADATA": None,
                "E1_SPEC_TARGET_RUNNER": "prototype",
                "SPEC_LICENSE_SHA256": hashlib.sha256(
                    b"licensed-spec-run-entitlement-fixture"
                ).hexdigest(),
            },
            "SPEC",
        ),
    ]
    for script, result_path, raw_name, raw_text, env, label in cases:
        with tempfile.TemporaryDirectory(dir=archived_tmp_root()) as tmp, PreserveFile(result_path):
            tmp_path = Path(tmp)
            raw = tmp_path / raw_name
            raw.write_text(raw_text, encoding="utf-8")
            metadata = tmp_path / "target-metadata.json"
            metadata.write_text(target_metadata_json(), encoding="utf-8")
            if script == "scripts/run_spec.sh":
                run_manifest = tmp_path / "spec-run-manifest.json"
                run_manifest.write_text(spec_run_manifest_json(raw), encoding="utf-8")
            resolved_env = {
                key: (
                    str(raw)
                    if key.endswith("_RAW_OUTPUT")
                    else str(metadata)
                    if key.endswith("_TARGET_METADATA")
                    else value
                )
                for key, value in env.items()
            }
            if script == "scripts/run_spec.sh":
                resolved_env["E1_SPEC_RUN_MANIFEST"] = str(run_manifest)
            proc = run_script(script, resolved_env)
            result = load_result(result_path)
        if proc.returncode != 0:
            raise AssertionError(proc.stdout)
        if result.get("status") != "blocked":
            raise AssertionError((label, result))
        if "marker" not in result.get("reason", "").lower():
            raise AssertionError((label, result))
    print("PASS score-only transcripts cannot promote L5/L6 results")


def test_out_of_tree_transcript_does_not_promote_l5_l6() -> None:
    result_path = ROOT / "benchmarks/results/cpu/coremark/l5_l6_result.json"
    with (
        tempfile.TemporaryDirectory() as out_tmp,
        tempfile.TemporaryDirectory(dir=archived_tmp_root()) as in_tmp,
        PreserveFile(result_path),
    ):
        raw = Path(out_tmp) / "coremark-target.log"
        raw.write_text(
            "CoreMark Size    : 666\n"
            "Correct operation validated. See README.md for run and reporting rules.\n"
            "Iterations/Sec   : 12345.67\n"
            "CoreMark/MHz     : 8.90\n",
            encoding="utf-8",
        )
        metadata = Path(in_tmp) / "target-metadata.json"
        metadata.write_text(target_metadata_json(), encoding="utf-8")
        proc = run_script(
            "scripts/run_coremark_l5_l6.sh",
            {
                "E1_COREMARK_RAW_OUTPUT": str(raw),
                "E1_COREMARK_TARGET_METADATA": str(metadata),
                "E1_COREMARK_TARGET_RUNNER": "prototype",
            },
        )
        result = load_result(result_path)
    if proc.returncode != 0:
        raise AssertionError(proc.stdout)
    if result.get("status") != "blocked":
        raise AssertionError(result)
    if "archived artifact under packages/chip" not in result.get("reason", ""):
        raise AssertionError(result)
    print("PASS out-of-tree transcript cannot promote L5/L6 result")


def main() -> None:
    test_jetstream_rejects_empty_engine_directory()
    test_jetstream_accepts_explicit_engine_before_dut_gate()
    test_jetstream_blocked_reason_quotes_engine_path()
    test_jetstream_ingests_target_transcript_without_local_engine()
    test_l5_l6_target_command_capture_ingests_transcript()
    test_jetstream_quotes_artifact_paths()
    test_spec_fake_install_reaches_target_runner_or_llvm_gate()
    test_spec_blocked_reason_quotes_spec_dir_path()
    test_spec_ingests_target_transcript_without_local_spec_dir()
    test_spec_target_command_capture_ingests_transcript()
    test_coremark_l5_l6_ingests_target_transcript()
    test_coremark_l5_l6_rejects_placeholder_metadata()
    test_coremark_l5_l6_invalid_metadata_writes_valid_json_blocker()
    test_coremark_l5_l6_rejects_missing_calibration_evidence()
    test_coremark_l5_l6_rejects_tampered_calibration_evidence()
    test_coremark_l5_l6_quotes_artifact_paths()
    test_metadata_contract_rejects_local_timestamp_and_uppercase_hash()
    test_metadata_contract_rejects_process_contract_drift()
    test_dhrystone_l5_l6_ingests_target_transcript()
    test_dhrystone_l5_l6_quotes_artifact_paths()
    test_score_only_transcripts_do_not_promote_l5_l6()
    test_out_of_tree_transcript_does_not_promote_l5_l6()


if __name__ == "__main__":
    main()
