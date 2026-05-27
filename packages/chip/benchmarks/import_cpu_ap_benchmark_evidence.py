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
DEFAULT_EVIDENCE = ROOT / "build/evidence/cpu_ap/eliza_e1_ap_benchmarks.log"
DEFAULT_OUT = ROOT / "benchmarks/results/generated-ap-smoke/report.json"
SCHEMA = "eliza.benchmark_run.v1"


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
        "claim_boundary": (
            "generated_ap_verilator_transcript_only_not_silicon_or_phone_benchmark"
        ),
        **extra,
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

    report = {
        "schema": SCHEMA,
        "report_id": "generated-ap-smoke",
        "status": "passed",
        "date_utc": dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat(),
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
