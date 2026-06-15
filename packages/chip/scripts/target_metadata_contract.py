#!/usr/bin/env python3
"""Shared L5/L6 target metadata contract for imported benchmark transcripts."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from pathlib import Path
from typing import Any

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
UTC_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|\+00:00)$")
BLOCKED_VALUES = {"", "blocked", "placeholder", "tb" + "d", "to" + "do", "unknown", "n/a"}
BLOCKED_SUBSTRINGS = (
    "placeholder",
    "uncalibrated",
    "fake",
    "synthetic",
    "to" + "do",
    "tb" + "d",
    "unknown",
    "n/a",
)
PROCESS_EFFECTS_CONTRACT_PATH = "docs/spec-db/process-14a-effects.yaml"


def is_real_string(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    normalized = value.strip().lower()
    return normalized not in BLOCKED_VALUES and not any(
        token in normalized for token in BLOCKED_SUBSTRINGS
    )


def is_positive_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value > 0
    )


def is_sha256(value: Any) -> bool:
    return isinstance(value, str) and SHA256_RE.fullmatch(value) is not None


def is_utc_timestamp(value: Any) -> bool:
    return isinstance(value, str) and UTC_RE.fullmatch(value) is not None


def require_real_string(errors: list[str], data: dict[str, Any], path: str) -> None:
    cur: Any = data
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            errors.append(f"{path} missing")
            return
        cur = cur[part]
    if not is_real_string(cur):
        errors.append(f"{path} must be a non-placeholder string")


def require_positive_number(errors: list[str], data: dict[str, Any], path: str) -> None:
    cur: Any = data
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            errors.append(f"{path} missing")
            return
        cur = cur[part]
    if not is_positive_number(cur):
        errors.append(f"{path} must be a positive number")


def require_sha256(errors: list[str], data: dict[str, Any], path: str) -> None:
    cur: Any = data
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            errors.append(f"{path} missing")
            return
        cur = cur[part]
    if not is_sha256(cur):
        errors.append(f"{path} must be a lowercase sha256 hex string")


def require_utc_timestamp(errors: list[str], data: dict[str, Any], path: str) -> None:
    cur: Any = data
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            errors.append(f"{path} missing")
            return
        cur = cur[part]
    if not is_utc_timestamp(cur):
        errors.append(f"{path} must be an ISO-8601 UTC timestamp ending in Z or +00:00")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def validate_calibration_evidence_artifacts(
    errors: list[str],
    data: dict[str, Any],
    *,
    artifact_root: Path | None,
    required_assets: set[str] | None = None,
) -> None:
    if artifact_root is None:
        return
    root = artifact_root.resolve()
    assets = data.get("calibration", {}).get("assets", {})
    if not isinstance(assets, dict):
        return
    for asset in sorted({"clock_source", "power_meter"} | (required_assets or set())):
        prefix = f"calibration.assets.{asset}"
        item = assets.get(asset)
        if not isinstance(item, dict):
            continue
        evidence = item.get("evidence")
        declared_sha = item.get("sha256")
        if not isinstance(evidence, str) or not evidence.strip():
            errors.append(f"{prefix}.evidence must name an archived artifact path")
            continue
        evidence_path = Path(evidence)
        if not evidence_path.is_absolute():
            evidence_path = root / evidence_path
        try:
            resolved = evidence_path.resolve()
            resolved.relative_to(root)
        except ValueError:
            errors.append(f"{prefix}.evidence artifact must be under artifact root")
            continue
        if not resolved.is_file():
            errors.append(f"{prefix}.evidence artifact is missing")
            continue
        if is_sha256(declared_sha) and sha256_file(resolved) != declared_sha:
            errors.append(f"{prefix}.sha256 does not match evidence artifact")


def validate_process_effects_contract(
    errors: list[str],
    data: dict[str, Any],
    *,
    artifact_root: Path | None,
) -> None:
    process = data.get("process")
    if not isinstance(process, dict):
        return
    contract = process.get("process_effects_contract")
    prefix = "process.process_effects_contract"
    if not isinstance(contract, dict):
        errors.append(f"{prefix} missing or not an object")
        return
    if contract.get("path") != PROCESS_EFFECTS_CONTRACT_PATH:
        errors.append(f"{prefix}.path must be {PROCESS_EFFECTS_CONTRACT_PATH}")
    require_sha256(errors, data, f"{prefix}.sha256")
    if artifact_root is None or not is_sha256(contract.get("sha256")):
        return
    root = artifact_root.resolve()
    contract_path = root / PROCESS_EFFECTS_CONTRACT_PATH
    if not contract_path.is_file():
        errors.append(f"{prefix}.path artifact is missing")
        return
    if sha256_file(contract_path) != contract["sha256"]:
        errors.append(f"{prefix}.sha256 does not match process effects contract artifact")


def validate_target_metadata(
    data: Any,
    *,
    runner: str | None = None,
    artifact_root: Path | None = None,
    required_calibration_assets: set[str] | None = None,
) -> list[str]:
    errors: list[str] = []
    if not isinstance(data, dict):
        return ["metadata root must be a JSON object"]

    if runner is not None:
        if data.get("target") != runner:
            errors.append("target must match target_execution.runner")
    else:
        require_real_string(errors, data, "target")

    for section in ("software", "clocks", "memory", "power", "thermal", "process", "calibration"):
        if not isinstance(data.get(section), dict):
            errors.append(f"{section} section missing or not an object")

    for path in (
        "software.os",
        "software.kernel",
        "software.firmware",
        "software.runtime",
        "software.build_id",
        "clocks.source",
        "clocks.governor",
        "memory.type",
        "power.source",
        "power.measurement_method",
        "thermal.cooling",
        "thermal.throttle_state",
        "process.node",
        "process.pdk",
        "process.worst_process_corner",
        "process.pdk_signoff_claim",
        "calibration.source",
        "calibration.ground_truth_reference",
    ):
        require_real_string(errors, data, path)

    require_utc_timestamp(errors, data, "calibration.last_calibrated_utc")

    for path in (
        "clocks.cpu_hz",
        "memory.capacity_bytes",
        "memory.bandwidth_bytes_per_second",
        "memory.channels",
        "power.watts",
        "power.sample_count",
        "power.averaging_window_seconds",
        "thermal.ambient_c",
        "thermal.die_c",
        "process.process_corner_count",
    ):
        require_positive_number(errors, data, path)

    validate_process_effects_contract(errors, data, artifact_root=artifact_root)

    if data.get("calibration", {}).get("status") != "calibrated":
        errors.append("calibration.status must be calibrated")

    required_assets = {"clock_source", "power_meter"} | (required_calibration_assets or set())
    for asset in sorted(required_assets):
        prefix = f"calibration.assets.{asset}"
        if not isinstance(data.get("calibration", {}).get("assets", {}).get(asset), dict):
            errors.append(f"{prefix} missing or not an object")
            continue
        if data["calibration"]["assets"][asset].get("status") != "calibrated":
            errors.append(f"{prefix}.status must be calibrated")
        require_real_string(errors, data, f"{prefix}.source")
        require_real_string(errors, data, f"{prefix}.evidence")
        require_sha256(errors, data, f"{prefix}.sha256")

    validate_calibration_evidence_artifacts(
        errors,
        data,
        artifact_root=artifact_root,
        required_assets=required_calibration_assets,
    )
    return errors


def load_json(path: Path) -> tuple[Any | None, str | None]:
    try:
        return json.loads(path.read_text(encoding="utf-8")), None
    except FileNotFoundError:
        return None, f"{path} missing"
    except json.JSONDecodeError as exc:
        return None, f"{path} is not valid JSON: {exc}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("metadata")
    parser.add_argument("--runner")
    parser.add_argument(
        "--artifact-root",
        type=Path,
        help="require calibration asset evidence paths to live under this root and match sha256",
    )
    parser.add_argument(
        "--required-calibration-asset",
        action="append",
        default=[],
        help="additional calibration asset name that must be present and hash-bound",
    )
    parser.add_argument("--json", action="store_true", help="emit JSON instead of plain text")
    args = parser.parse_args(argv)

    data, error = load_json(Path(args.metadata))
    errors = (
        [error]
        if error is not None
        else validate_target_metadata(
            data,
            runner=args.runner,
            artifact_root=args.artifact_root,
            required_calibration_assets=set(args.required_calibration_asset),
        )
    )
    if args.json:
        print(json.dumps({"valid": not errors, "errors": errors}, indent=2))
    elif errors:
        print("; ".join(errors))
    return 0 if not errors else 2


if __name__ == "__main__":
    sys.exit(main())
