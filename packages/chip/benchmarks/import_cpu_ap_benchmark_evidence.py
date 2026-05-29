#!/usr/bin/env python3
"""Import accepted CPU/AP benchmark evidence into the benchmark report schema."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import platform
import re
import socket
import subprocess
import sys
from pathlib import Path
from typing import Any

import run_benchmarks

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from provenance_sanitize import sanitize_host_local_paths  # noqa: E402

DEFAULT_EVIDENCE = ROOT / "build/evidence/cpu_ap/eliza_e1_ap_benchmarks.log"
DEFAULT_OUT = ROOT / "benchmarks/results/generated-ap-smoke/report.json"
SCHEMA = "eliza.benchmark_run.v1"
CLAIM_BOUNDARY = (
    "generated_ap_verilator_transcript_only_not_silicon_or_phone_benchmark"
)


def rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_tree_sha() -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short=12", "HEAD"],
            cwd=ROOT,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.CalledProcessError):
        return "unknown"
    return result.stdout.strip() or "unknown"


def require_marker(text: str, marker: str, errors: list[str]) -> None:
    if marker not in text:
        errors.append(f"missing required AP benchmark marker: {marker}")


def evidence_field(text: str, field: str) -> str:
    prefix = f"eliza-evidence: {field}="
    for line in text.splitlines():
        if line.startswith(prefix):
            return sanitize_host_local_paths(line[len(prefix) :].strip())
    return ""


def first_line_value(text: str, prefix: str) -> str:
    for line in text.splitlines():
        if line.startswith(prefix):
            return sanitize_host_local_paths(line[len(prefix) :].strip())
    return ""


def contains_marker(text: str, marker: str) -> bool:
    return marker in text


def parse_int(pattern: str, text: str, label: str, errors: list[str]) -> int:
    match = re.search(pattern, text, re.M)
    if not match:
        errors.append(f"missing {label}")
        return 0
    return int(match.group(1))


def validate_evidence(text: str) -> list[str]:
    errors: list[str] = []
    for marker in (
        "eliza-evidence: target=cpu_ap artifact=eliza_e1_ap_benchmarks",
        "claim_level=L3",
        "CoreMark/MHz:",
        "STREAM Triad:",
        "lat_mem_rd:",
        "fio:",
        "STATUS: PASS chipyard.verilator_ap_benchmarks",
        "eliza-evidence: status=PASS",
    ):
        require_marker(text, marker, errors)
    for forbidden in ("status=BLOCKED", "Kernel panic - not syncing", "PROBE_ERROR"):
        if forbidden in text:
            errors.append(f"forbidden AP benchmark evidence marker present: {forbidden}")
    return errors


def simulator_metrics(units: int, extra: dict[str, Any]) -> dict[str, Any]:
    return {
        "benchmark_success_allowed": True,
        "target_cycles": max(1, units),
        "simulated_frequency_hz": 1,
        "ipc": 1.0,
        "claim_boundary": CLAIM_BOUNDARY,
        **extra,
    }


def transcript_metadata(text: str, evidence: Path) -> dict[str, Any]:
    """Preserve target-runtime metadata from the accepted transcript.

    This is intentionally descriptive. It does not promote the generated AP
    benchmark into calibrated silicon, phone, power, or process evidence.
    """

    cpu_fallback = first_line_value(text, "CPU fallback percent=")
    claim_level = first_line_value(text, "claim_level=")
    run_count = first_line_value(text, "run count:")
    return {
        "source_transcript": rel(evidence),
        "source_transcript_sha256": sha256_file(evidence),
        "source_transcript_bytes": evidence.stat().st_size,
        "source_command": evidence_field(text, "command"),
        "source": evidence_field(text, "source"),
        "intake_utc": evidence_field(text, "intake_utc"),
        "generated_manifest": evidence_field(text, "generated_manifest"),
        "generated_manifest_sha256": evidence_field(text, "generated_manifest_sha256"),
        "raw_transcript_markers": {
            "begin": contains_marker(text, "eliza-evidence: raw_transcript_begin"),
            "end": contains_marker(text, "eliza-evidence: raw_transcript_end"),
            "wrapper_pass": contains_marker(text, "STATUS: PASS chipyard.verilator_ap_benchmarks"),
            "wrapper_marker": contains_marker(
                text, "eliza-evidence: ap_benchmark_wrapper_marker=present"
            ),
        },
        "runtime_target": {
            "target": "generated_chipyard_ap",
            "artifact": "eliza-e1-linux-smoke",
            "linux_version_seen": contains_marker(text, "Linux version"),
            "opensbi_seen": contains_marker(text, "OpenSBI"),
            "rv64gc_hwprobe_seen": contains_marker(text, "riscv_hwprobe: syscall rc=0"),
            "npu_device_seen": contains_marker(text, "device=/dev/e1-npu"),
        },
        "benchmark_contract": {
            "claim_level": claim_level,
            "run_count": int(run_count) if run_count.isdigit() else 0,
            "cpu_frequency": first_line_value(text, "cpu frequency:"),
            "cpu_frequency_boundary": first_line_value(
                text, "cpu frequency: simulator timebase only;"
            ),
            "thermal_state": first_line_value(text, "thermal state:"),
            "power_method": first_line_value(text, "power method:"),
            "process_effects_contract": first_line_value(text, "process effects contract:"),
            "process_corner_count": first_line_value(text, "process corner count:"),
            "worst_process_corner": first_line_value(text, "worst process corner:"),
            "frequency_derate": first_line_value(text, "frequency derate:"),
            "pdk_signoff_claim": first_line_value(text, "pdk signoff claim="),
        },
        "npu_smoke_context": {
            "present": contains_marker(text, "e1-npu-ml-smoke: PASS"),
            "device": first_line_value(text, "device="),
            "require_npu": first_line_value(text, "require_npu="),
            "cpu_fallback_percent": int(cpu_fallback) if cpu_fallback.isdigit() else None,
            "mmio_smoke_pass": contains_marker(text, "e1 MMIO smoke result: PASS"),
            "claim_boundary": first_line_value(text, "e1-npu-ml-smoke: PASS workload=relu4_s8"),
        },
        "claim_exclusions": {
            "calibrated_mhz": False,
            "board_power_rail_measurement": False,
            "thermal_sensor_measurement": False,
            "silicon_process_corner_evidence": False,
            "phone_or_android_runtime_claim": False,
        },
    }


def result(
    *,
    name: str,
    suite: str,
    primary_metric: str,
    units: str,
    command: list[str],
    raw_output: Path,
    metrics: dict[str, Any],
    required_metric: str,
) -> dict[str, Any]:
    return {
        "name": name,
        "suite": suite,
        "version": "generated-ap-smoke-v1",
        "command": command,
        "input_dataset": "accepted generated-AP benchmark transcript",
        "primary_metric": primary_metric,
        "units": units,
        "dependencies": [],
        "artifacts": {
            "raw_output": rel(raw_output),
            "raw_output_sha256": sha256_file(raw_output),
            "raw_output_bytes": raw_output.stat().st_size,
        },
        "status": "passed",
        "parser": "simulator_metrics_v1",
        "provenance": "simulator",
        "metrics": metrics,
        "run_metadata": {
            "runs": 1,
            "warmup_runs": 0,
            "required_metadata": [],
            "required_metrics": [required_metric],
            "metric_gates": [],
            "required_calibration_assets": [],
        },
    }


def build_report(evidence: Path) -> dict[str, Any]:
    text = evidence.read_text(encoding="utf-8", errors="replace")
    errors = validate_evidence(text)
    coremark_iterations = parse_int(
        r"^coremark_lite iterations=([0-9]+)\s", text, "coremark_lite iterations", errors
    )
    stream_bytes = parse_int(
        r"^stream_triad_lite bytes=([0-9]+)\s", text, "stream_triad_lite bytes", errors
    )
    lat_stride_count = 0
    lat_match = re.search(r"^lat_mem_rd_lite strides=([0-9,]+)\s", text, re.M)
    if lat_match:
        lat_stride_count = len([item for item in lat_match.group(1).split(",") if item])
    else:
        errors.append("missing lat_mem_rd_lite strides")
    fio_bytes = parse_int(r"^fio_lite .* bytes=([0-9]+)\s", text, "fio_lite bytes", errors)
    if errors:
        raise ValueError("; ".join(errors))

    generated_utc = dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat()
    report = {
        "schema": SCHEMA,
        "report_id": "generated-ap-smoke",
        "status": "passed",
        "generated_utc": generated_utc,
        "date_utc": generated_utc,
        "claim_boundary": CLAIM_BOUNDARY,
        "dry_run": False,
        "claim_allowed": True,
        "phone_claim_allowed": False,
        "release_claim_allowed": False,
        "claim_level": "L2_ARCH_SIM",
        "platform": {
            "name": "eliza-generated-ap-verilator",
            "revision": "ElizaRocketConfig",
            "source_tree_sha": source_tree_sha(),
            "host": socket.gethostname(),
            "host_system": platform.platform(),
        },
        "config": {
            "path": "docs/evidence/cpu-ap-evidence-manifest.json",
            "version": "generated-ap-benchmark-import-v1",
        },
        "artifacts": {
            "source_evidence": rel(evidence),
            "source_evidence_sha256": sha256_file(evidence),
            "source_evidence_bytes": evidence.stat().st_size,
        },
        "source_transcript_metadata": transcript_metadata(text, evidence),
        "results": [
            result(
                name="generated_ap_coremark_lite",
                suite="Generated AP CoreMark-lite smoke",
                primary_metric="iterations",
                units="iterations",
                command=["import-cpu-ap-evidence", rel(evidence), "coremark_lite"],
                raw_output=evidence,
                metrics=simulator_metrics(
                    coremark_iterations,
                    {"coremark_lite_iterations": coremark_iterations},
                ),
                required_metric="coremark_lite_iterations",
            ),
            result(
                name="generated_ap_stream_triad_lite",
                suite="Generated AP STREAM Triad-lite smoke",
                primary_metric="bytes",
                units="bytes",
                command=["import-cpu-ap-evidence", rel(evidence), "stream_triad_lite"],
                raw_output=evidence,
                metrics=simulator_metrics(stream_bytes, {"stream_triad_lite_bytes": stream_bytes}),
                required_metric="stream_triad_lite_bytes",
            ),
            result(
                name="generated_ap_lat_mem_rd_lite",
                suite="Generated AP lat_mem_rd-lite smoke",
                primary_metric="stride_count",
                units="strides",
                command=["import-cpu-ap-evidence", rel(evidence), "lat_mem_rd_lite"],
                raw_output=evidence,
                metrics=simulator_metrics(
                    lat_stride_count,
                    {"lat_mem_rd_lite_stride_count": lat_stride_count},
                ),
                required_metric="lat_mem_rd_lite_stride_count",
            ),
            result(
                name="generated_ap_fio_lite",
                suite="Generated AP fio-lite smoke",
                primary_metric="bytes",
                units="bytes",
                command=["import-cpu-ap-evidence", rel(evidence), "fio_lite"],
                raw_output=evidence,
                metrics=simulator_metrics(fio_bytes, {"fio_lite_bytes": fio_bytes}),
                required_metric="fio_lite_bytes",
            ),
        ],
    }
    validation_errors = run_benchmarks.validate_report(report, ROOT)
    if validation_errors:
        raise ValueError("generated report failed validation: " + "; ".join(validation_errors))
    return report


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, default=DEFAULT_EVIDENCE)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args(argv)
    evidence = args.evidence if args.evidence.is_absolute() else ROOT / args.evidence
    out = args.out if args.out.is_absolute() else ROOT / args.out
    try:
        report = build_report(evidence)
    except (OSError, ValueError) as exc:
        print("STATUS: BLOCKED benchmarks.generated_ap_import")
        print(f"  - {exc}")
        return 2
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print("STATUS: PASS benchmarks.generated_ap_import")
    print(f"  report: {rel(out)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
