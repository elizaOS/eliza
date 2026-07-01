#!/usr/bin/env python3
"""Validate e1-NPU sustained power/thermal evidence manifests."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
SCHEMA = "eliza.sustained_power_thermal_evidence.v1"
ALLOWED_STATUS = {"blocked", "draft_local_evidence", "complete_measured_evidence"}
MEASURED_SUBSTRATES = {"prototype_silicon", "complete_phone"}
SHA256_RE = re.compile(r"[0-9a-f]{64}")
REQUIRED_TOP_LEVEL = {
    "schema",
    "status",
    "claim_boundary",
    "target",
    "workload",
    "measurement_environment",
    "instrumentation",
    "artifacts",
    "computed_metrics",
    "release_blockers",
}
REQUIRED_ARTIFACTS = {
    "power_trace",
    "thermal_trace",
    "frequency_trace",
    "workload_transcript",
    "calibration_record",
}
REQUIRED_CAPTURE_STATUSES = {
    "power_meter_calibrated",
    "thermal_sensor_calibrated",
    "frequency_source_recorded",
    "workload_transcript_recorded",
    "throttle_state_recorded",
    "same_window_alignment_checked",
}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument(
        "--allow-blocked",
        action="store_true",
        help="Return success for valid blocked/draft manifests.",
    )
    return parser.parse_args(argv)


def resolve(path: Path) -> Path:
    return path if path.is_absolute() else ROOT / path


def display_path(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_manifest(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError("manifest must be a JSON object")
    return data


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def as_number(value: Any) -> float | None:
    if not is_number(value):
        return None
    return float(value)


def as_mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def validate_repo_path(value: Any, field: str, failures: list[str]) -> Path | None:
    if not isinstance(value, str) or not value:
        failures.append(f"{field}: missing path")
        return None
    path = Path(value)
    if path.is_absolute() or ".." in path.parts:
        failures.append(f"{field}: path must be repo-relative")
        return None
    return ROOT / path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_csv_rows(
    path: Path, required_columns: set[str], failures: list[str]
) -> list[dict[str, str]]:
    try:
        with path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            columns = set(reader.fieldnames or [])
            missing = sorted(required_columns - columns)
            if missing:
                failures.append(f"{display_path(path)} missing CSV columns: {', '.join(missing)}")
                return []
            rows = list(reader)
    except csv.Error as exc:
        failures.append(f"{display_path(path)} is not parseable CSV: {exc}")
        return []
    if not rows:
        failures.append(f"{display_path(path)} must contain at least one data row")
    return rows


def parse_float(value: Any, field: str, failures: list[str]) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        failures.append(f"{field} must be numeric")
        return None
    if parsed != parsed or parsed in (float("inf"), float("-inf")):
        failures.append(f"{field} must be finite")
        return None
    return parsed


def values_from_rows(
    rows: list[dict[str, str]], path: Path, column: str, failures: list[str]
) -> list[float]:
    values: list[float] = []
    for index, row in enumerate(rows, start=2):
        value = parse_float(row.get(column), f"{display_path(path)}:{index}:{column}", failures)
        if value is not None:
            values.append(value)
    return values


def relative_error(actual: float, expected: float) -> float:
    denominator = max(abs(expected), 1e-12)
    return abs(actual - expected) / denominator


def validate_measured_artifact_contents(manifest: dict[str, Any], failures: list[str]) -> None:
    artifacts = as_mapping(manifest.get("artifacts"))
    metrics = as_mapping(manifest.get("computed_metrics"))
    duration = as_number(as_mapping(manifest.get("workload")).get("duration_seconds")) or 0.0

    paths: dict[str, Path] = {}
    for name in REQUIRED_ARTIFACTS:
        path = validate_repo_path(
            as_mapping(artifacts.get(name)).get("path"), f"artifacts.{name}", failures
        )
        if path is not None:
            paths[name] = path
    if set(paths) != REQUIRED_ARTIFACTS:
        return
    missing_files = [name for name, path in paths.items() if not path.is_file()]
    if missing_files:
        return

    power_rows = load_csv_rows(paths["power_trace"], {"timestamp_s", "watts"}, failures)
    thermal_rows = load_csv_rows(paths["thermal_trace"], {"timestamp_s", "die_c"}, failures)
    frequency_rows = load_csv_rows(
        paths["frequency_trace"], {"timestamp_s", "frequency_hz"}, failures
    )

    for label, rows, path in (
        ("power_trace", power_rows, paths["power_trace"]),
        ("thermal_trace", thermal_rows, paths["thermal_trace"]),
        ("frequency_trace", frequency_rows, paths["frequency_trace"]),
    ):
        timestamps = values_from_rows(rows, path, "timestamp_s", failures)
        if timestamps and min(timestamps) < 0:
            failures.append(f"{label}: timestamp_s must be non-negative")
        if timestamps and duration and (max(timestamps) - min(timestamps)) < duration:
            failures.append(f"{label}: timestamp span must cover workload.duration_seconds")

    watts = values_from_rows(power_rows, paths["power_trace"], "watts", failures)
    if watts and any(value <= 0 for value in watts):
        failures.append("power_trace.watts must be positive for measured evidence")
    if watts:
        observed_average_watts = sum(watts) / len(watts)
        claimed_average_watts = as_number(metrics.get("average_watts"))
        if (
            claimed_average_watts is not None
            and relative_error(observed_average_watts, claimed_average_watts) > 0.05
        ):
            failures.append(
                "computed_metrics.average_watts must match power_trace average within 5%"
            )

    die_c = values_from_rows(thermal_rows, paths["thermal_trace"], "die_c", failures)
    if die_c:
        observed_max_die_c = max(die_c)
        claimed_max_die_c = as_number(metrics.get("max_die_c"))
        if claimed_max_die_c is not None and abs(observed_max_die_c - claimed_max_die_c) > 0.5:
            failures.append("computed_metrics.max_die_c must match thermal_trace max within 0.5C")

    frequency_hz = values_from_rows(
        frequency_rows, paths["frequency_trace"], "frequency_hz", failures
    )
    if frequency_hz and any(value <= 0 for value in frequency_hz):
        failures.append("frequency_trace.frequency_hz must be positive for measured evidence")

    sustained_tops = as_number(metrics.get("sustained_int8_tops"))
    average_watts = as_number(metrics.get("average_watts"))
    tops_per_w = as_number(metrics.get("sustained_tops_per_w"))
    if sustained_tops is not None and average_watts is not None and tops_per_w is not None:
        expected = sustained_tops / average_watts
        if relative_error(tops_per_w, expected) > 0.02:
            failures.append(
                "computed_metrics.sustained_tops_per_w must equal sustained_int8_tops / average_watts within 2%"
            )

    transcript = paths["workload_transcript"].read_text(encoding="utf-8", errors="replace")
    for marker in (
        "eliza-evidence: status=PASS",
        "NNAPI_ACCELERATOR=e1-npu",
        "CPU_FALLBACK_PERCENT=0",
        "UNSUPPORTED_OP_COUNT=0",
    ):
        if marker not in transcript:
            failures.append(f"workload_transcript missing marker: {marker}")

    try:
        calibration = json.loads(paths["calibration_record"].read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        failures.append(f"{display_path(paths['calibration_record'])} is invalid JSON: {exc}")
        return
    if not isinstance(calibration, dict):
        failures.append("calibration_record must contain a JSON object")
        return
    if calibration.get("status") != "complete":
        failures.append("calibration_record.status must be complete")
    for key in ("power", "thermal", "frequency"):
        if not as_list(calibration.get(key)):
            failures.append(f"calibration_record.{key} must list calibrated instruments")


def validate_artifact(
    manifest: dict[str, Any],
    name: str,
    failures: list[str],
    *,
    require_existing: bool,
) -> None:
    artifact = as_mapping(as_mapping(manifest.get("artifacts")).get(name))
    field = f"artifacts.{name}"
    path = validate_repo_path(artifact.get("path"), field, failures)
    sha = artifact.get("sha256")
    if not isinstance(sha, str) or not SHA256_RE.fullmatch(sha):
        failures.append(f"{field}: sha256 must be a 64-character lowercase hex digest")
    if not isinstance(artifact.get("sample_count"), int) or artifact.get("sample_count", 0) < 0:
        failures.append(f"{field}: sample_count must be a non-negative integer")
    if require_existing and path is not None:
        if not path.is_file():
            failures.append(f"{field}: referenced file is missing: {display_path(path)}")
        elif isinstance(sha, str) and SHA256_RE.fullmatch(sha):
            actual = sha256_file(path)
            if actual != sha:
                failures.append(f"{field}: sha256 mismatch for {display_path(path)}")


def validate_manifest(manifest: dict[str, Any], *, require_measured: bool) -> list[str]:
    failures: list[str] = []
    missing = sorted(REQUIRED_TOP_LEVEL - set(manifest))
    if missing:
        failures.append(f"missing top-level keys: {', '.join(missing)}")

    if manifest.get("schema") != SCHEMA:
        failures.append(f"schema must be {SCHEMA}")
    status = manifest.get("status")
    if status not in ALLOWED_STATUS:
        failures.append(f"status must be one of {', '.join(sorted(ALLOWED_STATUS))}")

    target = as_mapping(manifest.get("target"))
    substrate = target.get("substrate")
    if require_measured and substrate not in MEASURED_SUBSTRATES:
        failures.append(
            "target.substrate must be prototype_silicon or complete_phone for measured evidence"
        )

    workload = as_mapping(manifest.get("workload"))
    duration = as_number(workload.get("duration_seconds"))
    if duration is None or duration < 1800:
        failures.append("workload.duration_seconds must be at least 1800 for sustained evidence")
    if not as_list(workload.get("commands")):
        failures.append("workload.commands must list the exact sustained workload commands")

    environment = as_mapping(manifest.get("measurement_environment"))
    ambient = as_number(environment.get("ambient_c"))
    if ambient is None or ambient < 0 or ambient > 60:
        failures.append("measurement_environment.ambient_c must be a realistic numeric value")
    for key in ("cooling", "enclosure", "operator"):
        if not isinstance(environment.get(key), str) or not environment.get(key):
            failures.append(f"measurement_environment.{key} is required")

    instrumentation = as_mapping(manifest.get("instrumentation"))
    capture_statuses = as_mapping(instrumentation.get("capture_statuses"))
    missing_capture = sorted(REQUIRED_CAPTURE_STATUSES - set(capture_statuses))
    if missing_capture:
        failures.append(f"instrumentation.capture_statuses missing: {', '.join(missing_capture)}")
    if require_measured:
        for key in sorted(REQUIRED_CAPTURE_STATUSES):
            if capture_statuses.get(key) != "complete":
                failures.append(f"instrumentation.capture_statuses.{key} must be complete")
    for key in ("power", "thermal", "frequency"):
        entries = as_list(instrumentation.get(key))
        if not entries:
            failures.append(f"instrumentation.{key} must contain at least one entry")

    artifacts = as_mapping(manifest.get("artifacts"))
    missing_artifacts = sorted(REQUIRED_ARTIFACTS - set(artifacts))
    if missing_artifacts:
        failures.append(f"artifacts missing: {', '.join(missing_artifacts)}")
    for name in sorted(REQUIRED_ARTIFACTS & set(artifacts)):
        validate_artifact(manifest, name, failures, require_existing=require_measured)
    if require_measured:
        validate_measured_artifact_contents(manifest, failures)

    metrics = as_mapping(manifest.get("computed_metrics"))
    for key in ("average_watts", "max_die_c", "sustained_int8_tops", "sustained_tops_per_w"):
        value = as_number(metrics.get(key))
        if require_measured and (value is None or value <= 0):
            failures.append(f"computed_metrics.{key} must be positive measured data")
    if require_measured and metrics.get("throttle_state") not in {
        "none",
        "observed",
        "thermal_shutdown",
    }:
        failures.append(
            "computed_metrics.throttle_state must be one of none, observed, thermal_shutdown"
        )

    blockers = as_list(manifest.get("release_blockers"))
    if status != "complete_measured_evidence" and not blockers:
        failures.append("blocked/draft manifests require release_blockers")
    if status == "complete_measured_evidence" and blockers:
        failures.append("complete measured evidence must not carry release_blockers")

    return failures


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    path = resolve(args.manifest)
    manifest = load_manifest(path)
    require_measured = manifest.get("status") == "complete_measured_evidence"
    failures = validate_manifest(manifest, require_measured=require_measured)
    if failures:
        for failure in failures:
            print(f"FAIL: {display_path(path)}: {failure}", file=sys.stderr)
        return 1
    if require_measured:
        print(f"PASS: {display_path(path)} contains complete measured sustained evidence")
        return 0
    status = manifest.get("status")
    message = f"BLOCKED: {display_path(path)} is valid {status} evidence, not release evidence"
    if args.allow_blocked:
        print(message)
        return 0
    print(message, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
