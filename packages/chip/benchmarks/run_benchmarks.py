#!/usr/bin/env python3
"""Eliza benchmark harness.

This runner is intentionally conservative: it can plan benchmark commands before
the tools exist, records missing dependencies and unavailable model assets as
structured results, validates generated reports, and avoids shell execution so
command lines stay explicit.
"""

from __future__ import annotations

import argparse
import contextlib
import copy
import datetime as dt
import hashlib
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

DEFAULT_CONFIG = Path("benchmarks/configs/benchmark_plan.json")
DEFAULT_OUT_DIR = Path("benchmarks/results")
ROOT = Path(__file__).resolve().parents[1]
COMMANDS = {"list", "plan", "run", "validate-report"}
VALID_CLAIM_LEVELS = {
    "L0_RTL_UNIT",
    "L1_RTL_FULL_SOC",
    "L2_ARCH_SIM",
    "L3_FPGA",
    "L4_DEV_BOARD",
    "L5_PROTOTYPE_SILICON",
    "L6_COMPLETE_PHONE",
}
VALID_RESULT_STATUSES = {
    "planned",
    "planned_missing_deps",
    "blocked",
    "missing_dependencies",
    "passed",
    "failed",
    "timeout",
    "error",
}
LOCAL_TOOL_DIRS = ("tools/bin", ".venv/bin")
HOST_SMOKE_TOOL_DIR = "benchmarks/tools"
HOST_SMOKE_MARKER = "eliza-host-smoke"
HOST_SMOKE_CLAIM_LEVEL = "L2_ARCH_SIM"
EXECUTABLE_MARKER_READ_BYTES = 256 * 1024
VALID_PARSERS = {
    "coremark_v1",
    "eliza_mlperf_inference_v1",
    "eliza_npu_scale_sim_v1",
    "stream_v5",
    "lmbench_bw_mem",
    "lmbench_lat_mem_rd",
    "fio_json_v3",
    "tflite_benchmark_model",
    "simulator_metrics_v1",
}
VALID_PROVENANCE = {
    "dry_run",
    "measured",
    "target-measured",
    "silicon-measured",
    "simulator",
    "imported",
    "blocked_missing_target_evidence",
}
E1_NPU_REQUIRED_CAPTURE_COMMANDS = {
    "adb_devices": "adb devices",
    "nnapi_accelerator_query": "adb shell cmd neuralnetworks list",
    "benchmark_model_nnapi": (
        "adb shell benchmark_model --graph=/data/local/tmp/mobile_smoke.tflite "
        "--use_nnapi=true --nnapi_accelerator_name=e1-npu "
        "--enable_op_profiling=true --verbose=true"
    ),
    "dma_trace": "adb shell cat /sys/bus/platform/devices/10020000.npu/dma_trace",
}
PROCESS_EFFECTS_CONTRACT_PATH = "docs/spec-db/process-14a-effects.yaml"
TARGET_METADATA_CONTRACT_PATH = "benchmarks/configs/target-metadata.contract.json"
PROCESS_PDK_SIGNOFF_PASSED = "pdk_extracted_timing_power_thermal_signoff_passed"
REAL_METADATA_SECTIONS = (
    "software",
    "clocks",
    "memory",
    "thermal",
    "power",
    "process",
    "calibration",
)
L5_L6_CLAIM_LEVELS = {"L5_PROTOTYPE_SILICON", "L6_COMPLETE_PHONE"}
REAL_TARGET_RUNNERS = {"board", "prototype", "silicon", "phone", "firesim", "cuttlefish"}
PHONE_L5_L6_TARGET_RUNNERS = {"prototype", "silicon", "phone"}
TARGET_EXECUTION_METADATA_FIELDS = {
    "runner": str,
    "transcript_sha256": str,
}
REAL_METADATA_REQUIRED_FIELDS: dict[str, dict[str, Any]] = {
    "software": {
        "os": str,
        "kernel": str,
        "firmware": str,
        "runtime": str,
        "build_id": str,
    },
    "clocks": {
        "source": str,
        "cpu_hz": (int, float),
        "npu_hz": (int, float),
        "memory_hz": (int, float),
        "governor": str,
    },
    "memory": {
        "type": str,
        "capacity_bytes": int,
        "bandwidth_bytes_per_second": (int, float),
        "channels": int,
    },
    "thermal": {
        "ambient_c": (int, float),
        "die_c": (int, float),
        "cooling": str,
        "throttle_state": str,
    },
    "power": {
        "source": str,
        "watts": (int, float),
        "measurement_method": str,
        "sample_count": int,
        "averaging_window_seconds": (int, float),
    },
    "process": {
        "node": str,
        "pdk": str,
        "process_effects_contract": dict,
        "process_corner_count": int,
        "worst_process_corner": str,
        "pdk_signoff_claim": str,
    },
    "calibration": {
        "status": str,
        "source": str,
        "ground_truth_reference": str,
        "last_calibrated_utc": str,
        "assets": dict,
    },
}
REQUIRED_REPORT_FIELDS = {
    "schema": str,
    "report_id": str,
    "status": str,
    "date_utc": str,
    "dry_run": bool,
    "claim_allowed": bool,
    "phone_claim_allowed": bool,
    "release_claim_allowed": bool,
    "claim_level": str,
    "platform": dict,
    "config": dict,
    "results": list,
}
REQUIRED_RESULT_FIELDS = {
    "name": str,
    "suite": str,
    "version": str,
    "command": list,
    "input_dataset": str,
    "primary_metric": str,
    "units": str,
    "dependencies": list,
    "artifacts": dict,
    "status": str,
}
STRICT_RESULT_METADATA_FIELDS = {
    "provenance": str,
    "parser": str,
}
BLOCKED_PREFIX = "blocked-"
SHA256_RE = re.compile(r"[0-9a-f]{64}")


def utc_now() -> str:
    return dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat()


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def display_path(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


def is_json_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def dotted_get(data: dict[str, Any], path: str) -> Any:
    value: Any = data
    for part in path.split("."):
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


def load_config(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        config = json.load(f)
    if "benchmarks" not in config or not isinstance(config["benchmarks"], list):
        raise ValueError(f"{path} must contain a benchmarks list")
    validate_config(config, path)
    return config


def validate_config(config: dict[str, Any], path: Path) -> None:
    names: set[str] = set()
    for index, bench in enumerate(config["benchmarks"]):
        location = f"{path}: benchmarks[{index}]"
        for key in ("name", "suite", "version", "command", "primary_metric", "units", "parser"):
            if key not in bench:
                raise ValueError(f"{location} missing required key {key!r}")
        if not isinstance(bench["name"], str) or not bench["name"]:
            raise ValueError(f"{location} name must be a non-empty string")
        if bench["name"] in names:
            raise ValueError(f"{location} duplicate benchmark name {bench['name']!r}")
        names.add(bench["name"])
        if not isinstance(bench["command"], list) or not all(
            isinstance(part, str) for part in bench["command"]
        ):
            raise ValueError(f"{location} command must be a list of strings")
        if bench["parser"] not in VALID_PARSERS:
            raise ValueError(f"{location} parser {bench['parser']!r} is not supported")
        if "provenance" in bench and bench["provenance"] not in VALID_PROVENANCE:
            raise ValueError(f"{location} provenance {bench['provenance']!r} is not supported")
        for list_key in ("required_metadata", "required_metrics"):
            if list_key in bench and not isinstance(bench[list_key], list):
                raise ValueError(f"{location} {list_key} must be a list")
            for item in bench.get(list_key, []):
                if not isinstance(item, str) or not item:
                    raise ValueError(f"{location} {list_key} entries must be non-empty strings")
        if "required_calibration_assets" in bench and not isinstance(
            bench["required_calibration_assets"], list
        ):
            raise ValueError(f"{location} required_calibration_assets must be a list")
        for item in bench.get("required_calibration_assets", []):
            if not isinstance(item, str) or not item:
                raise ValueError(
                    f"{location} required_calibration_assets entries must be non-empty strings"
                )
        if "metric_gates" in bench and not isinstance(bench["metric_gates"], list):
            raise ValueError(f"{location} metric_gates must be a list")
        for gate_index, gate in enumerate(bench.get("metric_gates", [])):
            gate_location = f"{location} metric_gates[{gate_index}]"
            if not isinstance(gate, dict):
                raise ValueError(f"{gate_location} must be an object")
            if not isinstance(gate.get("metric"), str) or not gate["metric"]:
                raise ValueError(f"{gate_location}.metric must be a non-empty string")
            if gate.get("op") not in {"==", "!=", "<", "<=", ">", ">="}:
                raise ValueError(f"{gate_location}.op must be one of ==, !=, <, <=, >, >=")
            if not isinstance(gate.get("value"), (int, float)):
                raise ValueError(f"{gate_location}.value must be numeric")
        for list_key in ("requires", "required_files", "model_artifacts", "capability_artifacts"):
            if list_key in bench and not isinstance(bench[list_key], list):
                raise ValueError(f"{location} {list_key} must be a list")
        for asset in bench.get("model_artifacts", []) + bench.get("capability_artifacts", []):
            if not isinstance(asset, dict) or not isinstance(asset.get("path"), str):
                raise ValueError(f"{location} artifact entries must contain a string path")
            for bool_key in ("pipeline_visible", "release_blocking"):
                if bool_key in asset and not isinstance(asset[bool_key], bool):
                    raise ValueError(f"{location} model_artifacts {bool_key} must be a boolean")
            if (
                asset.get("placeholder_allowed") is True
                and asset.get("release_blocking", True) is True
            ):
                raise ValueError(
                    f"{location} release-blocking model artifacts must not allow placeholders"
                )
            if "generator" in asset:
                generator = asset["generator"]
                if not isinstance(generator, dict) or not isinstance(
                    generator.get("command"), list
                ):
                    raise ValueError(f"{location} model_artifacts generator.command must be a list")
                if not all(isinstance(part, str) for part in generator["command"]):
                    raise ValueError(
                        f"{location} model_artifacts generator.command must contain strings"
                    )
            if "proof" in asset:
                proof = asset["proof"]
                if not isinstance(proof, dict):
                    raise ValueError(f"{location} capability proof must be an object")
                if proof.get("schema") and not isinstance(proof["schema"], str):
                    raise ValueError(f"{location} capability proof.schema must be a string")
                if proof.get("accelerator_name") and not isinstance(proof["accelerator_name"], str):
                    raise ValueError(
                        f"{location} capability proof.accelerator_name must be a string"
                    )
                if proof.get("required_files") and not isinstance(proof["required_files"], list):
                    raise ValueError(f"{location} capability proof.required_files must be a list")
                if proof.get("required_model_artifacts") and not isinstance(
                    proof["required_model_artifacts"], list
                ):
                    raise ValueError(
                        f"{location} capability proof.required_model_artifacts must be a list"
                    )
                for model_path in proof.get("required_model_artifacts", []):
                    if not isinstance(model_path, str) or not model_path:
                        raise ValueError(
                            f"{location} capability proof.required_model_artifacts entries must be non-empty strings"
                        )
                if proof.get("required_json_fields") and not isinstance(
                    proof["required_json_fields"], list
                ):
                    raise ValueError(
                        f"{location} capability proof.required_json_fields must be a list"
                    )
                for field_path in proof.get("required_json_fields", []):
                    if not isinstance(field_path, str) or not field_path:
                        raise ValueError(
                            f"{location} capability proof.required_json_fields entries must be non-empty strings"
                        )
                if proof.get("max_cpu_fallback_percent") is not None and not is_json_number(
                    proof["max_cpu_fallback_percent"]
                ):
                    raise ValueError(
                        f"{location} capability proof.max_cpu_fallback_percent must be numeric"
                    )
                if proof.get("max_unsupported_op_count") is not None and (
                    not isinstance(proof["max_unsupported_op_count"], int)
                    or isinstance(proof["max_unsupported_op_count"], bool)
                ):
                    raise ValueError(
                        f"{location} capability proof.max_unsupported_op_count must be an integer"
                    )
                markers = proof.get("required_transcript_markers")
                if markers is not None:
                    if not isinstance(markers, dict):
                        raise ValueError(
                            f"{location} capability proof.required_transcript_markers must be an object"
                        )
                    for name, values in markers.items():
                        if not isinstance(name, str) or not name:
                            raise ValueError(
                                f"{location} capability proof.required_transcript_markers keys must be strings"
                            )
                        if not isinstance(values, list) or not all(
                            isinstance(value, str) and value for value in values
                        ):
                            raise ValueError(
                                f"{location} capability proof.required_transcript_markers values must be non-empty string lists"
                            )


def source_tree_sha(root: Path) -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short=12", "HEAD"],
            cwd=root,
            check=True,
            text=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return "unknown"
    return result.stdout.strip() or "unknown"


def local_search_path(root: Path, include_host_smoke: bool = False) -> str:
    local_dirs = [str(root / path) for path in LOCAL_TOOL_DIRS if (root / path).is_dir()]
    env_dirs = [
        entry
        for entry in os.environ.get("PATH", "").split(os.pathsep)
        if entry and Path(entry).resolve() != (root / HOST_SMOKE_TOOL_DIR).resolve()
    ]
    smoke_dirs = (
        [str(root / HOST_SMOKE_TOOL_DIR)]
        if include_host_smoke and (root / HOST_SMOKE_TOOL_DIR).is_dir()
        else []
    )
    return os.pathsep.join(local_dirs + env_dirs + smoke_dirs)


def is_host_smoke_tool(path: str | None, root: Path) -> bool:
    if not path:
        return False
    resolved = Path(path).resolve()
    smoke_dir = (root / HOST_SMOKE_TOOL_DIR).resolve()
    try:
        resolved.relative_to(smoke_dir)
        return True
    except ValueError:
        pass
    try:
        with resolved.open("rb") as f:
            return HOST_SMOKE_MARKER.encode("utf-8") in f.read(EXECUTABLE_MARKER_READ_BYTES)
    except OSError:
        return False


def executable_metadata(path: str | None, root: Path, allow_host_smoke: bool) -> dict[str, Any]:
    if not path:
        return {}
    resolved = Path(path)
    metadata: dict[str, Any] = {
        "evidence_kind": "host_smoke_tool"
        if is_host_smoke_tool(str(resolved), root)
        else "executable",
    }
    try:
        metadata["sha256"] = sha256_file(resolved)
        metadata["size_bytes"] = resolved.stat().st_size
    except OSError:
        pass
    if metadata["evidence_kind"] == "host_smoke_tool":
        metadata["provenance"] = "repo_local_host_smoke"
        metadata["release_claim_allowed"] = False
    else:
        metadata["provenance"] = "path_executable"
        metadata["release_claim_allowed"] = True
    metadata["host_smoke_allowed_for_run"] = allow_host_smoke
    return metadata


def command_available(
    executable: str,
    root: Path,
    allow_host_smoke: bool = False,
) -> tuple[bool, str | None, str | None, list[dict[str, str]]]:
    candidate = Path(executable)
    if candidate.parts and (candidate.is_absolute() or len(candidate.parts) > 1):
        resolved_path = candidate if candidate.is_absolute() else root / candidate
        available = resolved_path.exists() and os.access(resolved_path, os.X_OK)
        reason = (
            "repo_local_host_smoke_tool"
            if available and is_host_smoke_tool(str(resolved_path), root)
            else None
        )
        if allow_host_smoke and reason == "repo_local_host_smoke_tool":
            reason = None
        return available and reason is None, str(resolved_path), reason, []

    first_smoke_match: str | None = None
    rejected: list[dict[str, str]] = []
    seen: set[str] = set()
    for entry in local_search_path(root, include_host_smoke=allow_host_smoke).split(os.pathsep):
        if not entry:
            continue
        resolved = shutil.which(executable, path=entry)
        if resolved is None:
            continue
        resolved_key = str(Path(resolved).resolve())
        if resolved_key in seen:
            continue
        seen.add(resolved_key)
        if is_host_smoke_tool(resolved, root):
            if allow_host_smoke:
                return True, resolved, None, rejected
            first_smoke_match = first_smoke_match or resolved
            rejected.append({"path": resolved, "reason": "repo_local_host_smoke_tool"})
            continue
        return True, resolved, None, rejected

    if first_smoke_match is None:
        first_smoke_match = shutil.which(
            executable, path=local_search_path(root, include_host_smoke=True)
        )
    reason = "repo_local_host_smoke_tool" if first_smoke_match else None
    return False, first_smoke_match, reason, rejected


def benchmark_env(root: Path, allow_host_smoke: bool = False) -> dict[str, str]:
    env = os.environ.copy()
    env["PATH"] = local_search_path(root, include_host_smoke=allow_host_smoke)
    return env


def dependency_status(
    bench: dict[str, Any], root: Path, allow_host_smoke: bool = False
) -> list[dict[str, Any]]:
    statuses: list[dict[str, Any]] = []
    for dep in bench.get("requires", []):
        ok, resolved, blocked_reason, rejected = command_available(
            dep, root, allow_host_smoke=allow_host_smoke
        )
        status = {"name": dep, "kind": "executable", "available": ok, "path": resolved}
        status.update(executable_metadata(resolved, root, allow_host_smoke=allow_host_smoke))
        if rejected:
            status["rejected_candidates"] = rejected
        if blocked_reason:
            status.update(
                {
                    "blocked_reason": blocked_reason,
                    "resolution": bench.get("install", f"Install a real {dep} executable on PATH."),
                }
            )
        statuses.append(status)
    for artifact in bench.get("required_files", []):
        path = root / artifact
        statuses.append(
            {"name": artifact, "kind": "file", "available": path.is_file(), "path": str(path)}
        )
    for artifact in bench.get("model_artifacts", []):
        statuses.append(model_artifact_status(artifact, root))
    for artifact in bench.get("capability_artifacts", []):
        statuses.append(capability_artifact_status(artifact, root))
    return statuses


def command_with_resolved_executable(
    command: list[str], statuses: list[dict[str, Any]]
) -> list[str]:
    if not command:
        return command
    executable = command[0]
    for item in statuses:
        if (
            item.get("kind") == "executable"
            and item.get("name") == executable
            and item.get("available")
            and item.get("path")
        ):
            return [str(item["path"]), *command[1:]]
    return command


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_sha256(value: Any) -> bool:
    return isinstance(value, str) and bool(SHA256_RE.fullmatch(value))


def is_utc_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip() or is_blocked_value(value):
        return False
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = dt.datetime.fromisoformat(normalized)
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed.utcoffset() == dt.timedelta(0)


def contract_type_name(expected: Any) -> str:
    if expected is str:
        return "string"
    if expected is int:
        return "integer"
    if expected == (int, float):
        return "number"
    if expected is dict:
        return "object"
    return str(expected)


def load_target_metadata_contract(root: Path | None = None) -> dict[str, Any] | None:
    base = root or ROOT
    path = base / TARGET_METADATA_CONTRACT_PATH
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def validate_target_metadata_contract(contract: dict[str, Any] | None) -> list[str]:
    errors: list[str] = []
    if not isinstance(contract, dict):
        return [f"{TARGET_METADATA_CONTRACT_PATH} is missing or invalid JSON"]
    if contract.get("schema") != "eliza.benchmark_target_metadata_contract.v1":
        errors.append(
            "target metadata contract schema must be eliza.benchmark_target_metadata_contract.v1"
        )
    boundary = str(contract.get("claim_boundary", ""))
    for token in (
        "not benchmark evidence",
        "not calibrated target evidence",
        "not a release efficiency claim",
    ):
        if token not in boundary:
            errors.append(f"target metadata contract claim_boundary missing {token}")
    required_sections = contract.get("required_sections")
    if set(required_sections if isinstance(required_sections, list) else []) != set(
        REAL_METADATA_SECTIONS
    ):
        errors.append(
            "target metadata contract required_sections must match runner real metadata sections"
        )
    required_fields = contract.get("required_fields")
    if not isinstance(required_fields, dict):
        errors.append("target metadata contract required_fields must be an object")
        required_fields = {}
    for section, fields in REAL_METADATA_REQUIRED_FIELDS.items():
        section_contract = required_fields.get(section)
        if not isinstance(section_contract, dict):
            errors.append(f"target metadata contract required_fields.{section} must be an object")
            continue
        for field, expected_type in fields.items():
            expected_name = (
                "utc_timestamp"
                if section == "calibration" and field == "last_calibrated_utc"
                else contract_type_name(expected_type)
            )
            if section_contract.get(field) != expected_name:
                errors.append(
                    f"target metadata contract required_fields.{section}.{field} must be {expected_name}"
                )
    assets = contract.get("required_calibration_assets")
    if set(assets if isinstance(assets, list) else []) != {"clock_source", "power_meter"}:
        errors.append(
            "target metadata contract required_calibration_assets must require clock_source and power_meter"
        )
    asset_fields = contract.get("calibration_asset_required_fields")
    if set(asset_fields if isinstance(asset_fields, list) else []) != {
        "status",
        "source",
        "sha256",
        "evidence",
    }:
        errors.append(
            "target metadata contract calibration_asset_required_fields must match runner requirements"
        )
    process_contract = contract.get("process_effects_contract")
    if not isinstance(process_contract, dict):
        errors.append("target metadata contract process_effects_contract must be an object")
    else:
        if process_contract.get("path") != PROCESS_EFFECTS_CONTRACT_PATH:
            errors.append(
                "target metadata contract process_effects_contract.path must be "
                + PROCESS_EFFECTS_CONTRACT_PATH
            )
        if "64-character lowercase SHA-256" not in str(process_contract.get("sha256", "")):
            errors.append(
                "target metadata contract process_effects_contract.sha256 must describe SHA-256 evidence"
            )
    forbidden = contract.get("forbidden_release_values")
    if not isinstance(forbidden, list) or not {
        "placeholder",
        "blocked",
        "missing",
        "todo",
        "tbd",
    }.issubset({str(item).lower() for item in forbidden}):
        errors.append(
            "target metadata contract forbidden_release_values must include blocked placeholder terms"
        )
    return errors


def record_artifact_hash(result: dict[str, Any], key: str, path: Path) -> None:
    if not path.is_file():
        return
    result["artifacts"][f"{key}_sha256"] = sha256_file(path)
    result["artifacts"][f"{key}_bytes"] = path.stat().st_size


def model_artifact_status(artifact: dict[str, Any], root: Path) -> dict[str, Any]:
    path = root / artifact["path"]
    status: dict[str, Any] = {
        "name": artifact["path"],
        "kind": "model_artifact",
        "available": path.is_file(),
        "path": str(path),
        "placeholder_allowed": bool(artifact.get("placeholder_allowed", False)),
        "blocker_id": artifact.get("blocker_id", "MODEL_ARTIFACT_UNAVAILABLE"),
        "pipeline_visible": bool(artifact.get("pipeline_visible", True)),
        "release_blocking": bool(artifact.get("release_blocking", True)),
    }
    if artifact.get("generator"):
        status["generator"] = artifact["generator"]
    if artifact.get("resolution"):
        status["resolution"] = artifact["resolution"]
    if not path.is_file():
        status["blocked_reason"] = "missing_model_artifact"
        return status

    digest = sha256_file(path)
    status["sha256"] = digest
    expected_sha256 = artifact.get("sha256")
    placeholder_sha256 = set(artifact.get("placeholder_sha256", []))
    min_size_bytes = int(artifact.get("min_size_bytes", 1))
    size = path.stat().st_size
    status["size_bytes"] = size

    if not expected_sha256 and not status["placeholder_allowed"]:
        status["available"] = False
        status["blocked_reason"] = "model_sha256_unpinned"
    elif expected_sha256 and digest != expected_sha256:
        status["available"] = False
        status["blocked_reason"] = "model_sha256_mismatch"
    elif digest in placeholder_sha256 or size < min_size_bytes:
        status["available"] = False
        status["blocked_reason"] = "placeholder_model_artifact"
    return status


def capability_artifact_status(artifact: dict[str, Any], root: Path) -> dict[str, Any]:
    path = root / artifact["path"]
    status = {
        "name": artifact["path"],
        "kind": "capability_artifact",
        "available": path.is_file(),
        "path": str(path),
        "blocker_id": artifact.get("blocker_id", "CAPABILITY_ARTIFACT_UNAVAILABLE"),
        "pipeline_visible": bool(artifact.get("pipeline_visible", True)),
        "release_blocking": bool(artifact.get("release_blocking", True)),
        "resolution": artifact.get("resolution", ""),
        **(
            {}
            if path.is_file()
            else {"blocked_reason": artifact.get("blocked_reason", "missing_capability_artifact")}
        ),
    }
    proof = artifact.get("proof")
    if not path.is_file() or not proof:
        return status

    try:
        status["sha256"] = sha256_file(path)
        status["size_bytes"] = path.stat().st_size
    except OSError as exc:
        status["available"] = False
        status["blocked_reason"] = "unreadable_capability_proof"
        status["error"] = str(exc)
        return status

    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        status["available"] = False
        status["blocked_reason"] = "invalid_capability_proof"
        status["error"] = str(exc)
        return status

    errors: list[str] = []
    expected_schema = proof.get("schema")
    if expected_schema and data.get("schema") != expected_schema:
        errors.append(f"schema must be {expected_schema}")
    expected_accelerator = proof.get("accelerator_name")
    if expected_accelerator and data.get("accelerator_name") != expected_accelerator:
        errors.append(f"accelerator_name must be {expected_accelerator}")
    for field in ("target", "generated_by", "date_utc"):
        if not isinstance(data.get(field), str) or not data[field]:
            errors.append(f"{field} must be a non-empty string")

    nnapi = data.get("nnapi")
    if not isinstance(nnapi, dict):
        errors.append("nnapi must be an object")
    else:
        if expected_accelerator and nnapi.get("accelerator_name") != expected_accelerator:
            errors.append(f"nnapi.accelerator_name must be {expected_accelerator}")
        fallback_percent = nnapi.get("cpu_fallback_percent")
        max_fallback = proof.get("max_cpu_fallback_percent")
        if not is_json_number(fallback_percent):
            errors.append("nnapi.cpu_fallback_percent must be numeric")
        elif max_fallback is not None and fallback_percent > max_fallback:
            errors.append(
                f"nnapi.cpu_fallback_percent must be <= {max_fallback}; got {fallback_percent}"
            )
        unsupported_ops = nnapi.get("unsupported_op_count")
        max_unsupported = proof.get("max_unsupported_op_count")
        if not isinstance(unsupported_ops, int) or isinstance(unsupported_ops, bool):
            errors.append("nnapi.unsupported_op_count must be an integer")
        elif max_unsupported is not None and unsupported_ops > max_unsupported:
            errors.append(
                f"nnapi.unsupported_op_count must be <= {max_unsupported}; got {unsupported_ops}"
            )
        for field in ("delegated_node_count", "total_node_count"):
            value = nnapi.get(field)
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                errors.append(f"nnapi.{field} must be a non-negative integer")
        delegated = nnapi.get("delegated_node_count")
        total = nnapi.get("total_node_count")
        if isinstance(delegated, int) and isinstance(total, int):
            if total <= 0:
                errors.append("nnapi.total_node_count must be greater than zero")
            elif delegated > total:
                errors.append("nnapi.delegated_node_count must be <= nnapi.total_node_count")

    for field_path in proof.get("required_json_fields", []):
        value = dotted_get(data, field_path)
        if value in (None, "", [], {}):
            errors.append(f"{field_path} must be present and non-empty")

    if expected_schema == "eliza.e1_npu_nnapi_capability.v1":
        capture_commands = dotted_get(data, "capture.commands")
        if not isinstance(capture_commands, dict):
            errors.append("capture.commands must be an object")
        else:
            for name, command in E1_NPU_REQUIRED_CAPTURE_COMMANDS.items():
                if capture_commands.get(name) != command:
                    errors.append(f"capture.commands.{name} must be exactly {command!r}")

        claim_level = dotted_get(data, "capability.claim_level")
        if claim_level not in {"L4_DEV_BOARD", "L5_PROTOTYPE_SILICON", "L6_COMPLETE_PHONE"}:
            errors.append(
                "capability.claim_level must be L4_DEV_BOARD, L5_PROTOTYPE_SILICON, or L6_COMPLETE_PHONE"
            )

        precision = dotted_get(data, "capability.precision")
        if precision not in {"int8", "int4", "int2", "fp8", "bf16", "fp16"}:
            errors.append("capability.precision must identify a real accelerator precision")

        dma_path = dotted_get(data, "dma.path")
        if dma_path not in {"hardware_dma", "coherent_dma"}:
            errors.append("dma.path must be hardware_dma or coherent_dma")
        for field in ("dma.bytes_read", "dma.bytes_written"):
            value = dotted_get(data, field)
            if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
                errors.append(f"{field} must be a positive integer")

        dataflow_name = dotted_get(data, "dataflow.name")
        if not isinstance(dataflow_name, str) or not dataflow_name:
            errors.append("dataflow.name must be a non-empty string")

        for field in ("measurements.macs_per_inference", "measurements.npu_cycles"):
            value = dotted_get(data, field)
            if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
                errors.append(f"{field} must be positive integer evidence")
        for field in ("measurements.npu_hz", "measurements.observed_tops"):
            value = dotted_get(data, field)
            if not is_json_number(value) or float(value) <= 0.0:
                errors.append(f"{field} must be positive numeric evidence")

        macs = dotted_get(data, "measurements.macs_per_inference")
        cycles = dotted_get(data, "measurements.npu_cycles")
        hz = dotted_get(data, "measurements.npu_hz")
        tops = dotted_get(data, "measurements.observed_tops")
        if (
            isinstance(macs, int)
            and not isinstance(macs, bool)
            and isinstance(cycles, int)
            and not isinstance(cycles, bool)
            and is_json_number(hz)
            and is_json_number(tops)
            and cycles > 0
            and hz > 0
        ):
            max_tops_from_counters = (macs * 2.0) / (cycles / float(hz)) / 1e12
            if tops > max_tops_from_counters * 1.05:
                errors.append("measurements.observed_tops exceeds MAC/cycle/hz-derived upper bound")
            if max_tops_from_counters > 0 and abs(tops - max_tops_from_counters) > (
                max_tops_from_counters * 0.05
            ):
                errors.append(
                    "measurements.observed_tops must match MAC/cycle/hz-derived value within 5%"
                )
        formula = dotted_get(data, "measurements.tops_formula")
        if (
            not isinstance(formula, str)
            or "mac" not in formula.lower()
            or "cycle" not in formula.lower()
        ):
            errors.append("measurements.tops_formula must state the MAC/cycle based calculation")

    model_artifacts = data.get("model_artifacts")
    required_models = proof.get("required_model_artifacts", [])
    if required_models and not isinstance(model_artifacts, dict):
        errors.append("model_artifacts must be an object")
    elif isinstance(model_artifacts, dict):
        for model_path in required_models:
            model_entry = model_artifacts.get(model_path)
            if not isinstance(model_entry, dict):
                errors.append(f"model_artifacts.{model_path} must be an object")
                continue
            recorded_sha = model_entry.get("sha256")
            if not is_sha256(recorded_sha):
                errors.append(
                    f"model_artifacts.{model_path}.sha256 must be a lowercase SHA-256 hex string"
                )
                continue
            recorded_sha_text = str(recorded_sha)
            local_model = root / model_path
            if not local_model.is_file():
                errors.append(f"model artifact {model_path} is missing")
                continue
            actual_sha = sha256_file(local_model)
            if recorded_sha_text.lower() != actual_sha:
                errors.append(
                    f"model_artifacts.{model_path}.sha256 does not match current repository file"
                )

    transcript = data.get("transcripts")
    transcript_paths: dict[str, Path] = {}
    if not isinstance(transcript, dict) or not transcript:
        errors.append("transcripts must be a non-empty object")
    else:
        for name in proof.get("required_files", []):
            entry = transcript.get(name)
            if not isinstance(entry, dict):
                errors.append(f"transcripts.{name} must be an object with path, sha256, and bytes")
                continue
            rel = entry.get("path")
            if not isinstance(rel, str) or not rel:
                errors.append(f"transcripts.{name}.path must name a non-empty file")
                continue
            if Path(rel).is_absolute():
                errors.append(f"transcripts.{name}.path must be repo-relative")
                continue
            transcript_path = root / rel
            if not transcript_path.is_file() or transcript_path.stat().st_size == 0:
                errors.append(f"transcript {rel} is missing or empty")
                continue
            expected_sha = entry.get("sha256")
            if not is_sha256(expected_sha):
                errors.append(f"transcripts.{name}.sha256 must be lowercase SHA-256 hex")
            else:
                actual_sha = sha256_file(transcript_path)
                if expected_sha != actual_sha:
                    errors.append(f"transcripts.{name}.sha256 does not match {rel}")
            expected_bytes = entry.get("bytes")
            actual_bytes = transcript_path.stat().st_size
            if not isinstance(expected_bytes, int) or isinstance(expected_bytes, bool):
                errors.append(f"transcripts.{name}.bytes must be an integer byte count")
            elif expected_bytes != actual_bytes:
                errors.append(
                    f"transcripts.{name}.bytes must match {rel}; got {expected_bytes}, expected {actual_bytes}"
                )
            transcript_paths[name] = transcript_path

    dma_trace_path = transcript_paths.get("dma_trace")
    dma_trace_bytes = dotted_get(data, "dma.trace_bytes")
    if dma_trace_path is None:
        errors.append("dma.trace_bytes requires a validated dma_trace transcript")
    elif not isinstance(dma_trace_bytes, int) or isinstance(dma_trace_bytes, bool):
        errors.append("dma.trace_bytes must be an integer byte count")
    elif dma_trace_bytes != dma_trace_path.stat().st_size:
        errors.append("dma.trace_bytes must match transcripts.dma_trace.bytes")

    for name, markers in proof.get("required_transcript_markers", {}).items():
        marker_transcript_path = transcript_paths.get(name)
        if marker_transcript_path is None:
            continue
        try:
            text = marker_transcript_path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            errors.append(
                f"transcript {marker_transcript_path.relative_to(root)} could not be read: {exc}"
            )
            continue
        for marker in markers:
            if marker not in text:
                errors.append(
                    f"transcript {marker_transcript_path.relative_to(root)} must contain {marker!r}"
                )

    if errors:
        status["available"] = False
        status["blocked_reason"] = "invalid_capability_proof"
        status["errors"] = errors
    else:
        status["proof_schema"] = data.get("schema")
        status["target"] = data.get("target")
        status["accelerator_name"] = data.get("accelerator_name")
        status["transcript_sha256"] = {
            name: sha256_file(path) for name, path in sorted(transcript_paths.items())
        }
    return status


def missing_dependencies(statuses: list[dict[str, Any]]) -> list[str]:
    return [
        item["name"]
        for item in statuses
        if not item["available"]
        and item.get("kind") not in {"model_artifact", "capability_artifact"}
    ]


def missing_dependency_details(statuses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    details = []
    for item in statuses:
        if item["available"] or item.get("kind") in {"model_artifact", "capability_artifact"}:
            continue
        details.append(
            {
                "name": item["name"],
                "kind": item.get("kind", "unknown"),
                "reason": item.get("blocked_reason", "missing_dependency"),
                "path": item.get("path"),
                "resolution": item.get("resolution", ""),
            }
        )
    return details


def missing_dependency_blockers(
    bench: dict[str, Any], statuses: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    blockers: list[dict[str, Any]] = []
    install = bench.get("install", "")
    for item in statuses:
        if item["available"] or item.get("kind") == "model_artifact":
            continue
        kind = item.get("kind", "dependency")
        if kind == "executable":
            command = f"Install/build {item['name']} for the target and put it on PATH, then rerun this benchmark."
        elif kind == "file":
            command = (
                f"Create or copy {item['name']} into the repository, then rerun this benchmark."
            )
        else:
            command = f"Provide missing {kind} {item['name']}, then rerun this benchmark."
        blockers.append(
            {
                "name": item["name"],
                "kind": kind,
                "reason": f"missing_{kind}",
                "resolution": install or command,
            }
        )
    return blockers


def blocked_assets(statuses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "name": item["name"],
            "reason": item.get("blocked_reason", "unavailable_model_artifact"),
            "blocker_id": item.get("blocker_id", "MODEL_ARTIFACT_UNAVAILABLE"),
            "pipeline_visible": item.get("pipeline_visible", True),
            "release_blocking": item.get("release_blocking", True),
            "resolution": item.get("resolution", ""),
        }
        for item in statuses
        if not item["available"] and item.get("kind") in {"model_artifact", "capability_artifact"}
    ]


def parse_metrics(bench: dict[str, Any], output: str) -> tuple[str | None, dict[str, Any]]:
    name = bench["name"]
    if name == "npu_arch_sim_open_2028":
        try:
            start = output.find("{")
            data = json.loads(output[start:] if start >= 0 else output)
        except json.JSONDecodeError:
            return None, {}
        if data.get("schema") != "eliza.npu_scale_sim.v1":
            return None, {}
        summary = data.get("summary", {})
        config = data.get("config", {})
        kernels = data.get("kernels", [])
        if not isinstance(summary, dict) or not isinstance(config, dict) or not kernels:
            return None, {}
        return "eliza_npu_scale_sim_v1", {
            "kernel_count": int(summary.get("kernel_count", 0)),
            "process_corner_count": int(summary.get("process_corner_count", 0)),
            "dense_int8_peak_tops": float(config.get("dense_int8_peak_tops", 0.0)),
            "int8_macs_per_cycle": int(config.get("int8_macs_per_cycle", 0)),
            "dma_queue_depth": int(config.get("dma_queue_depth", 0)),
            "scratchpad_kib": int(config.get("scratchpad_kib", 0)),
            "total_macs": int(summary.get("total_macs", 0)),
            "total_bytes_read": int(summary.get("total_bytes_read", 0)),
            "total_bytes_written": int(summary.get("total_bytes_written", 0)),
            "total_descriptors_required": int(summary.get("total_descriptors_required", 0)),
            "max_descriptor_queue_passes": int(summary.get("max_descriptor_queue_passes", 0)),
            "total_dma_read_beats": int(summary.get("total_dma_read_beats", 0)),
            "total_dma_write_beats": int(summary.get("total_dma_write_beats", 0)),
            "total_dma_beats": int(summary.get("total_dma_beats", 0)),
            "min_observed_tops": float(summary.get("min_observed_tops", 0.0)),
            "max_observed_tops": float(summary.get("max_observed_tops", 0.0)),
            "min_utilization_percent": float(summary.get("min_utilization_percent", 0.0)),
            "worst_process_corner_min_observed_tops": float(
                summary.get("worst_process_corner_min_observed_tops", 0.0)
            ),
        }

    if name == "coremark":
        required = re.search(r"Iterations/Sec\s*:\s*([0-9]+(?:\.[0-9]+)?)", output)
        if not required:
            return None, {}
        metrics = {"iterations_per_second": float(required.group(1))}
        match = re.search(r"CoreMark\s*/\s*MHz\s*:\s*([0-9]+(?:\.[0-9]+)?)", output)
        if match:
            metrics["coremark_per_mhz"] = float(match.group(1))
        return "coremark_v1", metrics

    if name == "stream":
        metrics = {}
        for kernel in ("Copy", "Scale", "Add", "Triad"):
            match = re.search(rf"^\s*{kernel}\s*:\s*([0-9]+(?:\.[0-9]+)?)", output, re.MULTILINE)
            if match:
                metrics[f"{kernel.lower()}_mb_per_s"] = float(match.group(1))
        return ("stream_v5", metrics) if "triad_mb_per_s" in metrics else (None, {})

    if name == "lmbench_bw_mem":
        last = None
        for match in re.finditer(
            r"^\s*([0-9]+(?:\.[0-9]+)?)\s+([0-9]+(?:\.[0-9]+)?)\s*$", output, re.MULTILINE
        ):
            last = match
        if not last:
            return None, {}
        return "lmbench_bw_mem", {
            "size_mb": float(last.group(1)),
            "bandwidth_mb_per_s": float(last.group(2)),
        }

    if name == "lmbench_lat_mem_rd":
        points = [
            (float(match.group(1)), float(match.group(2)))
            for match in re.finditer(
                r"^\s*([0-9]+(?:\.[0-9]+)?)\s+([0-9]+(?:\.[0-9]+)?)\s*$", output, re.MULTILINE
            )
        ]
        if not points:
            return None, {}
        latencies = [lat for _, lat in points]
        return "lmbench_lat_mem_rd", {
            "points": len(points),
            "min_latency_ns": min(latencies),
            "max_latency_ns": max(latencies),
        }

    if name.startswith("fio_"):
        try:
            start = output.find("{")
            data = json.loads(output[start:] if start >= 0 else output)
        except json.JSONDecodeError:
            return None, {}
        jobs = data.get("jobs") or []
        if not jobs:
            return None, {}
        read_iops = sum(float(job.get("read", {}).get("iops", 0.0)) for job in jobs)
        write_iops = sum(float(job.get("write", {}).get("iops", 0.0)) for job in jobs)
        read_bw = sum(float(job.get("read", {}).get("bw", 0.0)) for job in jobs)
        write_bw = sum(float(job.get("write", {}).get("bw", 0.0)) for job in jobs)
        return "fio_json_v3", {
            "jobs": len(jobs),
            "read_iops": read_iops,
            "write_iops": write_iops,
            "read_bw_kib_s": read_bw,
            "write_bw_kib_s": write_bw,
        }

    if name.startswith("tflite_"):
        match = re.search(
            r"Inference timings in us:\s*Init:\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*"
            r"First inference:\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*"
            r"Warmup\s*\(avg\):\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*"
            r"Inference\s*\(avg\):\s*([0-9]+(?:\.[0-9]+)?)",
            output,
        )
        if not match:
            return None, {}
        metrics = {
            "init_us": float(match.group(1)),
            "first_inference_us": float(match.group(2)),
            "warmup_avg_us": float(match.group(3)),
            "avg_latency_us": float(match.group(4)),
        }
        delegated = re.search(
            r"NNAPI delegated\s+([0-9]+)\s+nodes;\s+([0-9]+)\s+fallback to CPU", output
        )
        if delegated:
            metrics["nnapi_delegated_nodes"] = int(delegated.group(1))
            metrics["cpu_fallback_nodes"] = int(delegated.group(2))
        unsupported = re.search(r"Number of unsupported ops:\s*([0-9]+)", output)
        if unsupported:
            metrics["unsupported_op_count"] = int(unsupported.group(1))
        return "tflite_benchmark_model", metrics

    return None, {}


def is_blocked_value(value: Any) -> bool:
    return isinstance(value, str) and value.strip().startswith(BLOCKED_PREFIX)


def calibration_asset_artifact_errors(
    asset_name: str, asset: dict[str, Any], root: Path
) -> list[str]:
    evidence = asset.get("evidence")
    if not isinstance(evidence, str) or not evidence.strip():
        return ["evidence_missing"]
    evidence_path = Path(evidence)
    if not evidence_path.is_absolute():
        evidence_path = root / evidence_path
    try:
        resolved = evidence_path.resolve()
        resolved.relative_to(root.resolve())
    except ValueError:
        return ["evidence_outside_repo"]
    if not resolved.is_file():
        return ["evidence_missing"]
    digest = asset.get("sha256")
    if is_sha256(digest) and sha256_file(resolved) != digest:
        return ["evidence_hash_mismatch"]
    return []


def metadata_blockers(
    report: dict[str, Any],
    bench: dict[str, Any],
    root: Path | None = None,
) -> list[dict[str, Any]]:
    blockers: list[dict[str, Any]] = []
    required_sections = required_metadata_sections(bench)
    for section in required_sections:
        if section not in REAL_METADATA_REQUIRED_FIELDS:
            continue
        data = report.get(section)
        if not isinstance(data, dict):
            blockers.append(
                {
                    "name": section,
                    "kind": "metadata",
                    "reason": "missing_metadata_section",
                    "resolution": f"Populate {section} in --metadata JSON before running real benchmarks.",
                }
            )
            continue
        for field in REAL_METADATA_REQUIRED_FIELDS[section]:
            value = data.get(field)
            if value is None or is_blocked_value(value):
                blockers.append(
                    {
                        "name": f"{section}.{field}",
                        "kind": "metadata",
                        "reason": "blocked_metadata_field",
                        "resolution": f"Replace {section}.{field} with measured target evidence in --metadata JSON.",
                    }
                )
        if section == "process" and isinstance(data, dict):
            contract = data.get("process_effects_contract")
            if not isinstance(contract, dict):
                blockers.append(
                    {
                        "name": "process.process_effects_contract",
                        "kind": "metadata",
                        "reason": "missing_process_effects_contract",
                        "resolution": f"Bind process metadata to {PROCESS_EFFECTS_CONTRACT_PATH} with its sha256.",
                    }
                )
            else:
                path = contract.get("path")
                digest = contract.get("sha256")
                if path != PROCESS_EFFECTS_CONTRACT_PATH:
                    blockers.append(
                        {
                            "name": "process.process_effects_contract.path",
                            "kind": "metadata",
                            "reason": "wrong_process_effects_contract",
                            "resolution": f"Set process.process_effects_contract.path to {PROCESS_EFFECTS_CONTRACT_PATH}.",
                        }
                    )
                if not isinstance(digest, str) or SHA256_RE.fullmatch(digest) is None:
                    blockers.append(
                        {
                            "name": "process.process_effects_contract.sha256",
                            "kind": "metadata",
                            "reason": "missing_process_effects_contract_hash",
                            "resolution": "Record the sha256 of the process effects contract used for this benchmark run.",
                        }
                    )
                elif path == PROCESS_EFFECTS_CONTRACT_PATH:
                    contract_path = ROOT / PROCESS_EFFECTS_CONTRACT_PATH
                    if not contract_path.is_file():
                        blockers.append(
                            {
                                "name": "process.process_effects_contract.sha256",
                                "kind": "metadata",
                                "reason": "process_effects_contract_missing",
                                "resolution": f"Archive {PROCESS_EFFECTS_CONTRACT_PATH} before making a real benchmark claim.",
                            }
                        )
                    elif sha256_file(contract_path) != digest:
                        blockers.append(
                            {
                                "name": "process.process_effects_contract.sha256",
                                "kind": "metadata",
                                "reason": "process_effects_contract_hash_mismatch",
                                "resolution": f"Set process.process_effects_contract.sha256 to the SHA-256 of {PROCESS_EFFECTS_CONTRACT_PATH}.",
                            }
                        )
            count = data.get("process_corner_count")
            node = data.get("node")
            if not isinstance(node, str) or "14A" not in node:
                blockers.append(
                    {
                        "name": "process.node",
                        "kind": "metadata",
                        "reason": "wrong_process_node",
                        "resolution": "Bind benchmark metadata to the 14A target process node.",
                    }
                )
            if not isinstance(count, int) or isinstance(count, bool) or count <= 0:
                blockers.append(
                    {
                        "name": "process.process_corner_count",
                        "kind": "metadata",
                        "reason": "invalid_process_corner_count",
                        "resolution": "Record the number of 14A process corners evaluated for this benchmark.",
                    }
                )
            worst = data.get("worst_process_corner")
            if not isinstance(worst, str) or not worst.startswith("14a_"):
                blockers.append(
                    {
                        "name": "process.worst_process_corner",
                        "kind": "metadata",
                        "reason": "invalid_worst_process_corner",
                        "resolution": "Record the worst 14A process corner that limits this benchmark result.",
                    }
                )
            if data.get("pdk_signoff_claim") != PROCESS_PDK_SIGNOFF_PASSED:
                blockers.append(
                    {
                        "name": "process.pdk_signoff_claim",
                        "kind": "metadata",
                        "reason": "missing_pdk_signoff",
                        "resolution": "Use benchmark results for 2028/14A claims only after extracted PDK timing, power, and thermal signoff passes.",
                    }
                )
    calibration = report.get("calibration")
    if isinstance(calibration, dict):
        if calibration.get("status") != "calibrated":
            blockers.append(
                {
                    "name": "calibration.status",
                    "kind": "calibration",
                    "reason": "uncalibrated_metadata",
                    "resolution": "Set calibration.status to calibrated only after clock, power, workload, and simulator evidence assets are recorded.",
                }
            )
        if not is_utc_timestamp(calibration.get("last_calibrated_utc")):
            blockers.append(
                {
                    "name": "calibration.last_calibrated_utc",
                    "kind": "calibration",
                    "reason": "invalid_calibration_timestamp",
                    "resolution": "Record calibration.last_calibrated_utc as an ISO-8601 UTC timestamp tied to the target evidence.",
                }
            )
        assets = calibration.get("assets") if isinstance(calibration.get("assets"), dict) else {}
        for asset_name in bench.get("required_calibration_assets", []):
            asset = assets.get(asset_name) if isinstance(assets, dict) else None
            if not isinstance(asset, dict):
                blockers.append(
                    {
                        "name": f"calibration.assets.{asset_name}",
                        "kind": "calibration",
                        "reason": "missing_calibration_asset",
                        "resolution": f"Add calibrated asset {asset_name} with source, sha256, and evidence fields.",
                    }
                )
                continue
            if asset.get("status") != "calibrated":
                blockers.append(
                    {
                        "name": f"calibration.assets.{asset_name}.status",
                        "kind": "calibration",
                        "reason": "uncalibrated_asset",
                        "resolution": f"Record calibrated evidence for {asset_name} before accepting this result.",
                    }
                )
            for field in ("source", "sha256", "evidence"):
                value = asset.get(field)
                if not isinstance(value, str) or not value.strip() or is_blocked_value(value):
                    blockers.append(
                        {
                            "name": f"calibration.assets.{asset_name}.{field}",
                            "kind": "calibration",
                            "reason": "blocked_calibration_field",
                            "resolution": f"Populate calibration.assets.{asset_name}.{field} with immutable evidence.",
                        }
                    )
            digest = asset.get("sha256")
            if digest is not None and not is_blocked_value(digest) and not is_sha256(digest):
                blockers.append(
                    {
                        "name": f"calibration.assets.{asset_name}.sha256",
                        "kind": "calibration",
                        "reason": "invalid_calibration_asset_hash",
                        "resolution": f"Record a lowercase SHA-256 digest for calibration.assets.{asset_name}.sha256.",
                    }
                )
            if root is not None and report.get("claim_level") in L5_L6_CLAIM_LEVELS:
                for reason in calibration_asset_artifact_errors(asset_name, asset, root):
                    blockers.append(
                        {
                            "name": f"calibration.assets.{asset_name}.evidence",
                            "kind": "calibration",
                            "reason": reason,
                            "resolution": (
                                f"Archive calibration.assets.{asset_name}.evidence under "
                                "packages/chip and record its matching SHA-256 digest."
                            ),
                        }
                    )
    return blockers


def required_metadata_sections(bench: dict[str, Any]) -> list[str]:
    if "required_metadata" in bench:
        return list(bench.get("required_metadata", []))
    if bench.get("provenance") == "simulator":
        return []
    return list(REAL_METADATA_SECTIONS)


def selected_benchmarks(config: dict[str, Any], names: set[str]) -> list[dict[str, Any]]:
    benches = config["benchmarks"]
    if not names or "all" in names:
        return benches
    selected = [bench for bench in benches if bench["name"] in names]
    found = {bench["name"] for bench in selected}
    missing = sorted(names - found)
    if missing:
        raise ValueError("unknown benchmark(s): " + ", ".join(missing))
    return selected


def base_report(args: argparse.Namespace, config: dict[str, Any], root: Path) -> dict[str, Any]:
    contract_path = root / TARGET_METADATA_CONTRACT_PATH
    report: dict[str, Any] = {
        "schema": "eliza.benchmark_run.v1",
        "report_id": args.report_id,
        "date_utc": utc_now(),
        "dry_run": args.dry_run,
        "claim_level": args.claim_level,
        "platform": {
            "name": args.platform,
            "revision": args.platform_revision,
            "source_tree_sha": source_tree_sha(root),
            "host": socket.gethostname(),
            "host_system": platform.platform(),
        },
        "config": {
            "path": str(args.config),
            "version": config.get("version", "unknown"),
        },
        "artifacts": {
            "target_metadata_contract": display_path(contract_path, root),
            "target_metadata_contract_sha256": sha256_file(contract_path)
            if contract_path.is_file()
            else None,
            "target_metadata_contract_bytes": contract_path.stat().st_size
            if contract_path.is_file()
            else None,
        },
        "results": [],
    }
    metadata_path = args.metadata if getattr(args, "metadata", None) else None
    if metadata_path:
        resolved = metadata_path if metadata_path.is_absolute() else root / metadata_path
        with resolved.open("r", encoding="utf-8") as f:
            metadata = json.load(f)
        report["artifacts"].update(
            {
                "target_metadata": display_path(resolved, root),
                "target_metadata_sha256": sha256_file(resolved),
                "target_metadata_bytes": resolved.stat().st_size,
            }
        )
        for key in REAL_METADATA_SECTIONS:
            if key in metadata:
                report[key] = metadata[key]
        if "target_execution" in metadata:
            report["target_execution"] = metadata["target_execution"]
    return report


def parse_coremark(output: str) -> dict[str, Any]:
    metrics: dict[str, Any] = {}
    for line in output.splitlines():
        if "Iterations/Sec" in line:
            match = re.search(r"Iterations/Sec\s*:?\s*([0-9]+(?:\.[0-9]+)?)", line, re.IGNORECASE)
            if match:
                metrics["iterations_per_second"] = float(match.group(1))
        if "CoreMark/MHz" in line:
            match = re.search(r"CoreMark/MHz\s*:?\s*([0-9]+(?:\.[0-9]+)?)", line)
            if match:
                metrics["coremark_per_mhz"] = float(match.group(1))
    if "coremark_per_mhz" not in metrics:
        raise ValueError("CoreMark parser did not find CoreMark/MHz")
    return metrics


def parse_stream(output: str) -> dict[str, Any]:
    metrics: dict[str, Any] = {}
    for line in output.splitlines():
        match = re.match(r"\s*(Copy|Scale|Add|Triad):\s+([0-9]+(?:\.[0-9]+)?)", line)
        if match:
            metrics[match.group(1).lower() + "_mb_per_s"] = float(match.group(2))
    if "triad_mb_per_s" not in metrics:
        raise ValueError("STREAM parser did not find Triad bandwidth")
    return metrics


def parse_lmbench_bw_mem(output: str) -> dict[str, Any]:
    values: list[float] = []
    for line in output.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            with contextlib.suppress(ValueError):
                values.append(float(parts[-1]))
    if not values:
        raise ValueError("lmbench bw_mem parser did not find bandwidth values")
    return {"bandwidth_mb_per_s": values[-1]}


def parse_lmbench_lat_mem_rd(output: str) -> dict[str, Any]:
    points: list[dict[str, float]] = []
    for line in output.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            with contextlib.suppress(ValueError):
                points.append({"size_mb": float(parts[0]), "latency_ns": float(parts[1])})
    if not points:
        raise ValueError("lmbench lat_mem_rd parser did not find latency points")
    return {"points": points, "max_latency_ns": max(point["latency_ns"] for point in points)}


def parse_fio_json(output: str) -> dict[str, Any]:
    data = json.loads(output)
    jobs = data.get("jobs")
    if not isinstance(jobs, list) or not jobs:
        raise ValueError("fio JSON output missing jobs")
    totals = {"read_iops": 0.0, "write_iops": 0.0, "read_bw_kib_s": 0.0, "write_bw_kib_s": 0.0}
    for job in jobs:
        read = job.get("read", {})
        write = job.get("write", {})
        totals["read_iops"] += float(read.get("iops", 0.0))
        totals["write_iops"] += float(write.get("iops", 0.0))
        totals["read_bw_kib_s"] += float(read.get("bw", 0.0))
        totals["write_bw_kib_s"] += float(write.get("bw", 0.0))
    if not any(totals.values()):
        raise ValueError("fio JSON output did not contain non-zero IO metrics")
    return totals


def parse_tflite_benchmark_model(output: str) -> dict[str, Any]:
    metrics: dict[str, Any] = {}
    for line in output.splitlines():
        avg = re.search(r"Inference timings in us:.*avg=([0-9]+(?:\.[0-9]+)?)", line)
        if not avg:
            avg = re.search(r"\bavg[=:]\s*([0-9]+(?:\.[0-9]+)?)", line)
        if not avg:
            avg = re.search(
                r"Inference timings in us:.*Inference\s+\(avg\):\s*([0-9]+(?:\.[0-9]+)?)",
                line,
            )
        if avg:
            metrics["avg_latency_us"] = float(avg.group(1))
        fallback = re.search(
            r"CPU fallback(?: percent| percentage)?[^0-9]*([0-9]+(?:\.[0-9]+)?)\s*%?",
            line,
            re.IGNORECASE,
        )
        if not fallback:
            fallback = re.search(
                r"cpu_fallback_percent\s*[=:]\s*([0-9]+(?:\.[0-9]+)?)", line, re.IGNORECASE
            )
        if fallback:
            metrics["cpu_fallback_percent"] = float(fallback.group(1))
        unsupported = re.search(r"unsupported ops?[^0-9]*([0-9]+)", line, re.IGNORECASE)
        if not unsupported:
            unsupported = re.search(r"unsupported_op_count\s*[=:]\s*([0-9]+)", line, re.IGNORECASE)
        if unsupported:
            metrics["unsupported_op_count"] = int(unsupported.group(1))
    if "avg_latency_us" not in metrics:
        raise ValueError("TFLite parser did not find average inference latency")
    return metrics


def parse_simulator_metrics(output: str) -> dict[str, Any]:
    data = json.loads(output)
    required = ("target_cycles", "simulated_frequency_hz", "ipc")
    missing = [key for key in required if not isinstance(data.get(key), (int, float))]
    if missing:
        raise ValueError("simulator metrics missing numeric keys: " + ", ".join(missing))
    forbidden = [
        key for key in ("wall_clock_score", "phone_score", "geekbench_score") if key in data
    ]
    if forbidden:
        raise ValueError(
            "simulator metrics contain forbidden comparable score keys: " + ", ".join(forbidden)
        )
    if data.get("benchmark_success_allowed") is not True:
        raise ValueError("simulator metrics are not calibrated benchmark evidence")
    return data


def parse_eliza_npu_scale_sim(output: str) -> dict[str, Any]:
    start = output.find("{")
    data = json.loads(output[start:] if start >= 0 else output)
    if data.get("schema") != "eliza.npu_scale_sim.v1":
        raise ValueError("NPU scale simulator output had an unexpected schema")
    summary = data.get("summary", {})
    config = data.get("config", {})
    kernels = data.get("kernels", [])
    if not isinstance(summary, dict) or not isinstance(config, dict) or not kernels:
        raise ValueError("NPU scale simulator output is missing summary/config/kernels")
    return {
        "benchmark_success_allowed": True,
        "kernel_count": int(summary.get("kernel_count", 0)),
        "process_corner_count": int(summary.get("process_corner_count", 0)),
        "dense_int8_peak_tops": float(config.get("dense_int8_peak_tops", 0.0)),
        "int8_macs_per_cycle": int(config.get("int8_macs_per_cycle", 0)),
        "dma_queue_depth": int(config.get("dma_queue_depth", 0)),
        "scratchpad_kib": int(config.get("scratchpad_kib", 0)),
        "total_macs": int(summary.get("total_macs", 0)),
        "total_bytes_read": int(summary.get("total_bytes_read", 0)),
        "total_bytes_written": int(summary.get("total_bytes_written", 0)),
        "total_descriptors_required": int(summary.get("total_descriptors_required", 0)),
        "max_descriptor_queue_passes": int(summary.get("max_descriptor_queue_passes", 0)),
        "total_dma_read_beats": int(summary.get("total_dma_read_beats", 0)),
        "total_dma_write_beats": int(summary.get("total_dma_write_beats", 0)),
        "total_dma_beats": int(summary.get("total_dma_beats", 0)),
        "min_observed_tops": float(summary.get("min_observed_tops", 0.0)),
        "max_observed_tops": float(summary.get("max_observed_tops", 0.0)),
        "min_utilization_percent": float(summary.get("min_utilization_percent", 0.0)),
        "worst_process_corner_min_observed_tops": float(
            summary.get("worst_process_corner_min_observed_tops", 0.0)
        ),
    }


def parse_eliza_mlperf_inference(output: str) -> dict[str, Any]:
    start = output.find("{")
    data = json.loads(output[start:] if start >= 0 else output)
    if data.get("schema") != "eliza.mlperf_inference.v1":
        raise ValueError("MLPerf inference modeled output had an unexpected schema")
    if data.get("claim_boundary") != (
        "modeled_preSilicon_not_official_submission_and_not_measured_power"
    ):
        raise ValueError("MLPerf inference output claim boundary drifted")
    if data.get("provenance") != "simulator":
        raise ValueError("MLPerf inference modeled output must keep simulator provenance")
    summary = data.get("summary", {})
    workload = data.get("workload", {})
    scenarios = data.get("scenarios", [])
    if not isinstance(summary, dict) or not isinstance(workload, dict):
        raise ValueError("MLPerf inference output is missing summary/workload")
    if not isinstance(scenarios, list) or not scenarios:
        raise ValueError("MLPerf inference output is missing scenarios")
    by_name = {
        scenario.get("scenario"): scenario for scenario in scenarios if isinstance(scenario, dict)
    }
    missing_scenarios = {"SingleStream", "Offline"} - set(by_name)
    if missing_scenarios:
        raise ValueError(
            "MLPerf inference output missing scenario(s): " + ", ".join(sorted(missing_scenarios))
        )
    blockers = summary.get("blocked_axes", [])
    blocker_ids = {
        blocker.get("blocker_id")
        for blocker in blockers
        if isinstance(blocker, dict) and blocker.get("blocker_id")
    }
    if "mlperf-power-closed" not in blocker_ids:
        raise ValueError("MLPerf inference output must keep measured-power blocker")
    min_accuracy = summary.get("min_top1_accuracy")
    if min_accuracy != 1.0:
        raise ValueError("MLPerf inference modeled output did not meet accuracy gate")
    single_stream = by_name["SingleStream"]
    offline = by_name["Offline"]
    latency = single_stream.get("latency_percentiles_ns", {})
    energy: Any = summary.get("energy_joules_per_inference")
    if not isinstance(latency, dict) or not is_json_number(latency.get("p90")):
        raise ValueError("MLPerf inference SingleStream scenario missing p90 latency")
    if not is_json_number(offline.get("throughput_samples_per_second")):
        raise ValueError("MLPerf inference Offline scenario missing throughput")
    if not is_json_number(energy) or energy <= 0:
        raise ValueError("MLPerf inference modeled energy must be positive")
    npu_macs_total = summary.get("npu_macs_total")
    npu_commands_total = summary.get("npu_commands_total")
    npu_cycles_total = summary.get("npu_cycles_total")
    macs_per_inference = workload.get("macs_per_inference")
    for name, value in (
        ("npu_macs_total", npu_macs_total),
        ("npu_commands_total", npu_commands_total),
        ("npu_cycles_total", npu_cycles_total),
        ("macs_per_inference", macs_per_inference),
    ):
        if not isinstance(value, int) or value <= 0:
            raise ValueError(f"MLPerf inference output missing positive integer {name}")
    return {
        "benchmark_success_allowed": True,
        "min_top1_accuracy": float(min_accuracy),
        "scenario_count": int(summary.get("scenario_count", len(scenarios))),
        "single_stream_p90_latency_ns": int(latency["p90"]),
        "offline_throughput_samples_per_second": float(offline["throughput_samples_per_second"]),
        "energy_joules_per_inference": float(energy),
        "npu_macs_total": npu_macs_total,
        "npu_commands_total": npu_commands_total,
        "npu_cycles_total": npu_cycles_total,
        "macs_per_inference": macs_per_inference,
    }


def parse_benchmark_output(parser: str, output: str) -> dict[str, Any]:
    parsers = {
        "coremark_v1": parse_coremark,
        "eliza_mlperf_inference_v1": parse_eliza_mlperf_inference,
        "eliza_npu_scale_sim_v1": parse_eliza_npu_scale_sim,
        "stream_v5": parse_stream,
        "lmbench_bw_mem": parse_lmbench_bw_mem,
        "lmbench_lat_mem_rd": parse_lmbench_lat_mem_rd,
        "fio_json_v3": parse_fio_json,
        "tflite_benchmark_model": parse_tflite_benchmark_model,
        "simulator_metrics_v1": parse_simulator_metrics,
    }
    return parsers[parser](output)


def metric_gate_passes(actual: int | float, op: str, expected: int | float) -> bool:
    if op == "==":
        return actual == expected
    if op == "!=":
        return actual != expected
    if op == "<":
        return actual < expected
    if op == "<=":
        return actual <= expected
    if op == ">":
        return actual > expected
    if op == ">=":
        return actual >= expected
    raise ValueError(f"unsupported metric gate op {op!r}")


def check_metric_requirements(metrics: dict[str, Any], run_metadata: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for metric in run_metadata.get("required_metrics", []):
        if not isinstance(metric, str) or not metric:
            errors.append("required_metrics entries must be non-empty strings")
            continue
        if not isinstance(metrics.get(metric), (int, float)):
            errors.append(f"missing required metric {metric}")
    for gate_index, gate in enumerate(run_metadata.get("metric_gates", [])):
        if not isinstance(gate, dict):
            errors.append(f"metric_gates[{gate_index}] must be an object")
            continue
        metric = gate.get("metric")
        op = gate.get("op")
        expected = gate.get("value")
        if not isinstance(metric, str) or not metric:
            errors.append(f"metric_gates[{gate_index}].metric must be a non-empty string")
            continue
        actual = metrics.get(metric)
        if op not in {"==", "!=", "<", "<=", ">", ">="}:
            errors.append(f"metric gate {metric} has unsupported op {op!r}")
            continue
        if not isinstance(expected, (int, float)):
            errors.append(f"metric gate {metric} has non-numeric expected value")
            continue
        if not isinstance(actual, (int, float)):
            errors.append(f"metric gate {metric} has no numeric metric")
        elif not metric_gate_passes(actual, op, expected):
            errors.append(f"metric gate {metric} {op} {expected} failed with {actual}")
    return errors


def check_calibration_requirements(
    report: dict[str, Any],
    result: dict[str, Any],
    artifact_root: Path | None = None,
) -> list[str]:
    errors: list[str] = []
    calibration = report.get("calibration")
    if not isinstance(calibration, dict):
        return ["missing calibration metadata"]
    if calibration.get("status") != "calibrated":
        errors.append("calibration.status must be calibrated")
    for field in ("source", "ground_truth_reference", "last_calibrated_utc"):
        value = calibration.get(field)
        if not isinstance(value, str) or not value.strip() or value.startswith("blocked-"):
            errors.append(f"calibration.{field} must be populated with non-blocked evidence")
    if not is_utc_timestamp(calibration.get("last_calibrated_utc")):
        errors.append("calibration.last_calibrated_utc must be an ISO-8601 UTC timestamp")
    assets = calibration.get("assets")
    if not isinstance(assets, dict):
        errors.append("calibration.assets must be object")
        assets = {}
    run_metadata = result.get("run_metadata", {})
    for asset_name in run_metadata.get("required_calibration_assets", []):
        asset = assets.get(asset_name)
        if not isinstance(asset, dict):
            errors.append(f"missing calibration asset {asset_name}")
            continue
        if asset.get("status") != "calibrated":
            errors.append(f"calibration asset {asset_name} status must be calibrated")
        for field in ("source", "sha256", "evidence"):
            value = asset.get(field)
            if not isinstance(value, str) or not value.strip() or value.startswith("blocked-"):
                errors.append(
                    f"calibration asset {asset_name}.{field} must be populated with non-blocked evidence"
                )
        if not is_sha256(asset.get("sha256")):
            errors.append(f"calibration asset {asset_name}.sha256 must be lowercase SHA-256 hex")
        if artifact_root is not None and report.get("claim_level") in L5_L6_CLAIM_LEVELS:
            for reason in calibration_asset_artifact_errors(asset_name, asset, artifact_root):
                errors.append(f"calibration asset {asset_name}.evidence {reason}")
    return errors


def check_target_execution_metadata(value: Any, scope: str) -> list[str]:
    if not isinstance(value, dict):
        return [f"{scope} missing target_execution metadata"]
    errors: list[str] = []
    for field, expected_type in TARGET_EXECUTION_METADATA_FIELDS.items():
        if not isinstance(value.get(field), expected_type):
            errors.append(f"{scope}.target_execution.{field} must be {expected_type.__name__}")
        elif isinstance(value.get(field), str) and not value[field].strip():
            errors.append(f"{scope}.target_execution.{field} must be non-empty")
    runner = value.get("runner")
    if runner not in REAL_TARGET_RUNNERS:
        errors.append(
            f"{scope}.target_execution.runner must identify a real target "
            f"({', '.join(sorted(REAL_TARGET_RUNNERS))})"
        )
    if value.get("runner") in {"host", "local"} or value.get("host_run") is True:
        errors.append(f"{scope}.target_execution must not describe host/local execution")
    if not is_sha256(value.get("transcript_sha256")):
        errors.append(f"{scope}.target_execution.transcript_sha256 must be lowercase SHA-256 hex")
    return errors


def check_target_execution_transcript_artifact(
    value: Any, scope: str, artifact_root: Path
) -> list[str]:
    if not isinstance(value, dict):
        return []
    errors: list[str] = []
    transcript_path = value.get("transcript_path")
    digest = value.get("transcript_sha256")
    if not isinstance(transcript_path, str) or not transcript_path.strip():
        return [f"{scope}.target_execution.transcript_path must name an archived transcript"]
    path = Path(transcript_path)
    if path.is_absolute() or ".." in path.parts:
        return [
            f"{scope}.target_execution.transcript_path must be a relative path under artifact root"
        ]
    resolved = artifact_root / path
    try:
        resolved = resolved.resolve()
        resolved.relative_to(artifact_root.resolve())
    except ValueError:
        return [f"{scope}.target_execution.transcript_path must resolve under artifact root"]
    if not resolved.is_file():
        return [f"{scope}.target_execution.transcript_path is missing: {transcript_path}"]
    if resolved.stat().st_size == 0:
        return [f"{scope}.target_execution.transcript_path must not be empty"]
    if is_sha256(digest) and sha256_file(resolved) != digest:
        errors.append(f"{scope}.target_execution.transcript_sha256 does not match transcript_path")
    return errors


def check_result_raw_output_artifact(
    result: dict[str, Any], scope: str, artifact_root: Path
) -> list[str]:
    artifacts = result.get("artifacts")
    if not isinstance(artifacts, dict):
        return [f"{scope}.artifacts must include raw_output and raw_output_sha256"]
    raw_output = artifacts.get("raw_output")
    digest = artifacts.get("raw_output_sha256")
    errors: list[str] = []
    if not isinstance(raw_output, str) or not raw_output.strip():
        return [f"{scope}.artifacts.raw_output must name an archived transcript"]
    path = Path(raw_output)
    if path.is_absolute() or ".." in path.parts:
        return [f"{scope}.artifacts.raw_output must be a relative path under artifact root"]
    resolved = artifact_root / path
    try:
        resolved = resolved.resolve()
        resolved.relative_to(artifact_root.resolve())
    except ValueError:
        return [f"{scope}.artifacts.raw_output must resolve under artifact root"]
    if not resolved.is_file():
        return [f"{scope}.artifacts.raw_output is missing: {raw_output}"]
    if resolved.stat().st_size == 0:
        return [f"{scope}.artifacts.raw_output must not be empty"]
    if not is_sha256(digest):
        errors.append(f"{scope}.artifacts.raw_output_sha256 must be lowercase SHA-256 hex")
    elif sha256_file(resolved) != digest:
        errors.append(f"{scope}.artifacts.raw_output_sha256 does not match raw_output")
    target = result.get("target_execution")
    if isinstance(target, dict):
        transcript_path = target.get("transcript_path")
        if isinstance(transcript_path, str) and transcript_path.strip():
            errors.extend(check_target_execution_transcript_artifact(target, scope, artifact_root))
        elif is_sha256(digest) and target.get("transcript_sha256") != digest:
            errors.append(
                f"{scope}.target_execution.transcript_sha256 must match raw_output_sha256 "
                "or provide target_execution.transcript_path"
            )
    return errors


def validate_report(report: dict[str, Any], artifact_root: Path | None = None) -> list[str]:
    errors: list[str] = []
    contract = load_target_metadata_contract(ROOT)
    errors.extend(validate_target_metadata_contract(contract))
    for field, expected_type in REQUIRED_REPORT_FIELDS.items():
        if field not in report:
            errors.append(f"report missing {field}")
        elif not isinstance(report[field], expected_type):
            errors.append(f"report.{field} must be {expected_type.__name__}")

    if report.get("schema") != "eliza.benchmark_run.v1":
        errors.append("report.schema must be eliza.benchmark_run.v1")
    artifacts = report.get("artifacts")
    contract_path = ROOT / TARGET_METADATA_CONTRACT_PATH
    if not isinstance(artifacts, dict):
        errors.append("report.artifacts must record target metadata contract provenance")
    else:
        if artifacts.get("target_metadata_contract") != TARGET_METADATA_CONTRACT_PATH:
            errors.append(
                "report.artifacts.target_metadata_contract must be " + TARGET_METADATA_CONTRACT_PATH
            )
        recorded_contract_sha = artifacts.get("target_metadata_contract_sha256")
        if not is_sha256(recorded_contract_sha):
            errors.append(
                "report.artifacts.target_metadata_contract_sha256 must be lowercase SHA-256 hex"
            )
        elif not contract_path.is_file() or sha256_file(contract_path) != recorded_contract_sha:
            errors.append(
                "report.artifacts.target_metadata_contract_sha256 must match current "
                + TARGET_METADATA_CONTRACT_PATH
            )
        recorded_contract_bytes = artifacts.get("target_metadata_contract_bytes")
        if not isinstance(recorded_contract_bytes, int) or isinstance(
            recorded_contract_bytes, bool
        ):
            errors.append("report.artifacts.target_metadata_contract_bytes must be integer")
        elif not contract_path.is_file() or contract_path.stat().st_size != recorded_contract_bytes:
            errors.append(
                "report.artifacts.target_metadata_contract_bytes must match current "
                + TARGET_METADATA_CONTRACT_PATH
            )
    if report.get("status") not in {"passed", "blocked", "failed"}:
        errors.append("report.status must be passed, blocked, or failed")
    if report.get("claim_level") not in VALID_CLAIM_LEVELS:
        errors.append("report.claim_level is not a valid claim level")
    result_statuses = [
        result.get("status") for result in report.get("results", []) if isinstance(result, dict)
    ]
    if isinstance(report.get("results"), list) and not report["results"]:
        errors.append("report.results must contain at least one benchmark result")
    has_failed_result = any(status in {"failed", "timeout", "error"} for status in result_statuses)
    has_blocked_result = any(
        status in {"blocked", "missing_dependencies", "planned_missing_deps"}
        for status in result_statuses
    )
    if has_failed_result:
        expected_report_status = "failed"
    elif has_blocked_result:
        expected_report_status = "blocked"
    else:
        expected_report_status = "passed"
    if result_statuses and report.get("status") != expected_report_status:
        errors.append(f"report.status must be {expected_report_status} for contained results")
    report_claim_passed = report.get("status") == "passed" and report.get("dry_run") is False
    if report.get("claim_allowed") is not report_claim_passed:
        errors.append("report.claim_allowed must match passed real-run status")
    expected_phone_claim = report_claim_passed and report.get("claim_level") in L5_L6_CLAIM_LEVELS
    if report.get("phone_claim_allowed") is not expected_phone_claim:
        errors.append("report.phone_claim_allowed must match passed L5/L6 status")
    expected_release_claim = (
        report_claim_passed and report.get("claim_level") == "L6_COMPLETE_PHONE"
    )
    if report.get("release_claim_allowed") is not expected_release_claim:
        errors.append("report.release_claim_allowed must match passed L6 status")
    has_passed_measured_results = any(
        isinstance(result, dict)
        and result.get("status") == "passed"
        and result.get("provenance") != "simulator"
        for result in report.get("results", [])
    )
    is_l5_l6_claim = report.get("claim_level") in L5_L6_CLAIM_LEVELS
    if is_l5_l6_claim and has_passed_measured_results:
        errors.extend(check_target_execution_metadata(report.get("target_execution"), "report"))
        if artifact_root is not None:
            errors.extend(
                check_target_execution_transcript_artifact(
                    report.get("target_execution"), "report", artifact_root
                )
            )
        runner = (
            report.get("target_execution", {}).get("runner")
            if isinstance(report.get("target_execution"), dict)
            else None
        )
        if runner not in PHONE_L5_L6_TARGET_RUNNERS:
            errors.append(
                "report.target_execution.runner must be prototype, silicon, or phone for L5/L6 phone claims"
            )
    if report.get("dry_run") is False and has_passed_measured_results:
        for section in REAL_METADATA_SECTIONS:
            if not isinstance(report.get(section), dict):
                errors.append(f"real report missing metadata section {section}")
                continue
            for field, expected_type in REAL_METADATA_REQUIRED_FIELDS[section].items():
                value = report[section].get(field)
                if (
                    not isinstance(value, expected_type)
                    or expected_type in (int, (int, float))
                    and isinstance(value, bool)
                ):
                    type_name = (
                        "number"
                        if expected_type == (int, float)
                        else "integer"
                        if expected_type is int
                        else expected_type.__name__
                    )
                    errors.append(f"real report metadata {section}.{field} must be {type_name}")
                elif isinstance(value, str) and not value.strip():
                    errors.append(f"real report metadata {section}.{field} must be non-empty")
            if section == "process":
                process = report[section]
                contract = process.get("process_effects_contract")
                if not isinstance(contract, dict):
                    errors.append(
                        "real report metadata process.process_effects_contract must be object"
                    )
                else:
                    if contract.get("path") != PROCESS_EFFECTS_CONTRACT_PATH:
                        errors.append(
                            "real report metadata process.process_effects_contract.path must be "
                            + PROCESS_EFFECTS_CONTRACT_PATH
                        )
                    digest = contract.get("sha256")
                    if not isinstance(digest, str) or SHA256_RE.fullmatch(digest) is None:
                        errors.append(
                            "real report metadata process.process_effects_contract.sha256 must be lowercase hex sha256"
                        )
                    elif contract.get("path") == PROCESS_EFFECTS_CONTRACT_PATH:
                        contract_root = artifact_root or ROOT
                        contract_path = contract_root / PROCESS_EFFECTS_CONTRACT_PATH
                        if not contract_path.is_file():
                            errors.append(
                                "real report metadata process.process_effects_contract.sha256 "
                                f"cannot be verified because {PROCESS_EFFECTS_CONTRACT_PATH} is missing"
                            )
                        elif sha256_file(contract_path) != digest:
                            errors.append(
                                "real report metadata process.process_effects_contract.sha256 "
                                f"must match {PROCESS_EFFECTS_CONTRACT_PATH}"
                            )
                count = process.get("process_corner_count")
                node = process.get("node")
                if not isinstance(node, str) or "14A" not in node:
                    errors.append(
                        "real report metadata process.node must identify the 14A target node"
                    )
                if not isinstance(count, int) or isinstance(count, bool) or count <= 0:
                    errors.append(
                        "real report metadata process.process_corner_count must be positive integer"
                    )
                worst = process.get("worst_process_corner")
                if not isinstance(worst, str) or not worst.startswith("14a_"):
                    errors.append(
                        "real report metadata process.worst_process_corner must name a 14A corner"
                    )
                if process.get("pdk_signoff_claim") != PROCESS_PDK_SIGNOFF_PASSED:
                    errors.append(
                        "real report metadata process.pdk_signoff_claim must record passed PDK extracted timing/power/thermal signoff"
                    )

    platform_obj = report.get("platform", {})
    for field in ("name", "revision", "source_tree_sha", "host", "host_system"):
        if not isinstance(platform_obj.get(field), str):
            errors.append(f"report.platform.{field} must be string")

    for index, result in enumerate(report.get("results", [])):
        prefix = f"report.results[{index}]"
        if not isinstance(result, dict):
            errors.append(f"{prefix} must be object")
            continue
        for field, expected_type in REQUIRED_RESULT_FIELDS.items():
            if field not in result:
                errors.append(f"{prefix} missing {field}")
            elif not isinstance(result[field], expected_type):
                errors.append(f"{prefix}.{field} must be {expected_type.__name__}")
        status = result.get("status")
        for field, expected_type in STRICT_RESULT_METADATA_FIELDS.items():
            if field not in result:
                errors.append(f"{prefix} missing {field}")
            elif not isinstance(result[field], expected_type):
                errors.append(f"{prefix}.{field} must be {expected_type.__name__}")
        if result.get("parser") not in VALID_PARSERS:
            errors.append(f"{prefix}.parser is not supported")
        if result.get("provenance") not in VALID_PROVENANCE:
            errors.append(f"{prefix}.provenance is not supported")
        if status not in VALID_RESULT_STATUSES:
            errors.append(f"{prefix}.status {status!r} is not valid")
        if status == "blocked":
            expected_blocked_provenance = (
                "dry_run" if report.get("dry_run") is True else "blocked_missing_target_evidence"
            )
            if result.get("provenance") != expected_blocked_provenance:
                errors.append(
                    f"{prefix} blocked result provenance must be {expected_blocked_provenance}"
                )
        if report.get("dry_run") is True and status == "passed":
            errors.append(f"{prefix} dry-run report must not contain passed results")
        if report.get("dry_run") is True and result.get("provenance") != "dry_run":
            errors.append(f"{prefix} dry-run result provenance must be dry_run")
        if report.get("dry_run") is False and status == "passed":
            if result.get("provenance") == "dry_run":
                errors.append(f"{prefix} real passed result cannot use dry_run provenance")
            if is_l5_l6_claim and result.get("provenance") != "simulator":
                errors.extend(
                    check_target_execution_metadata(result.get("target_execution"), prefix)
                )
                if artifact_root is not None:
                    errors.extend(check_result_raw_output_artifact(result, prefix, artifact_root))
                runner = (
                    result.get("target_execution", {}).get("runner")
                    if isinstance(result.get("target_execution"), dict)
                    else None
                )
                if runner not in PHONE_L5_L6_TARGET_RUNNERS:
                    errors.append(
                        f"{prefix}.target_execution.runner must be prototype, silicon, or phone for L5/L6 phone claims"
                    )
            if not isinstance(result.get("metrics"), dict) or not result["metrics"]:
                errors.append(f"{prefix} passed result missing parsed metrics")
            if not isinstance(result.get("run_metadata"), dict):
                errors.append(f"{prefix} passed result missing run_metadata")
            if isinstance(result.get("metrics"), dict) and isinstance(
                result.get("run_metadata"), dict
            ):
                for error in check_metric_requirements(result["metrics"], result["run_metadata"]):
                    errors.append(f"{prefix}.metrics {error}")
                requires_calibration = bool(
                    result["run_metadata"].get("required_calibration_assets")
                )
                if result.get("provenance") != "simulator" or requires_calibration:
                    for error in check_calibration_requirements(report, result, artifact_root):
                        errors.append(f"{prefix}.calibration {error}")
        if status == "passed":
            if result.get("missing_dependencies"):
                errors.append(f"{prefix} passed with missing_dependencies")
            if result.get("blocked_assets"):
                errors.append(f"{prefix} passed with blocked_assets")
            for dep in result.get("dependencies", []):
                if dep.get("kind") in {"model_artifact", "capability_artifact"} and not dep.get(
                    "available"
                ):
                    errors.append(
                        f"{prefix} passed with unavailable {dep.get('kind')} {dep.get('name')}"
                    )
                if (
                    report.get("claim_level") != HOST_SMOKE_CLAIM_LEVEL
                    and dep.get("release_claim_allowed") is False
                ):
                    errors.append(
                        f"{prefix} {report.get('claim_level')} passed with non-release dependency {dep.get('name')}"
                    )
            if result.get("name") == "tflite_e1_npu":
                metrics = result.get("metrics")
                if not isinstance(metrics, dict):
                    errors.append(f"{prefix} tflite_e1_npu passed without parsed metrics")
                else:
                    if metrics.get("unsupported_op_count") != 0:
                        errors.append(f"{prefix} tflite_e1_npu must report zero unsupported ops")
                    if metrics.get("cpu_fallback_nodes") != 0:
                        errors.append(f"{prefix} tflite_e1_npu must report zero CPU fallback")
                    delegated_nodes = metrics.get("nnapi_delegated_nodes")
                    if not isinstance(delegated_nodes, int) or delegated_nodes <= 0:
                        errors.append(f"{prefix} tflite_e1_npu must report delegated NNAPI nodes")
        if status == "blocked" and not (
            result.get("blocked_assets")
            or result.get("blocked_requirements")
            or result.get("missing_dependencies")
        ):
            errors.append(
                f"{prefix} blocked without blocked_assets, blocked_requirements, or missing_dependencies"
            )
        blocked_requirements = result.get("blocked_requirements")
        if blocked_requirements is not None:
            if not isinstance(blocked_requirements, list):
                errors.append(f"{prefix}.blocked_requirements must be a list")
            else:
                for req_index, requirement in enumerate(blocked_requirements):
                    req_prefix = f"{prefix}.blocked_requirements[{req_index}]"
                    if not isinstance(requirement, dict):
                        errors.append(f"{req_prefix} must be an object")
                        continue
                    for field in ("name", "reason", "resolution"):
                        if not isinstance(requirement.get(field), str) or not requirement.get(
                            field
                        ):
                            errors.append(f"{req_prefix}.{field} must be non-empty string")
        if result.get("provenance") == "simulator":
            metrics = result.get("metrics", {})
            if isinstance(metrics, dict):
                for forbidden in ("wall_clock_score", "phone_score", "geekbench_score"):
                    if forbidden in metrics:
                        errors.append(
                            f"{prefix}.metrics contains simulator-forbidden key {forbidden}"
                        )
            if report.get("claim_level") not in {"L0_RTL_UNIT", "L1_RTL_FULL_SOC", "L2_ARCH_SIM"}:
                errors.append(
                    f"{prefix} simulator provenance is incompatible with {report.get('claim_level')}"
                )
            if status == "passed":
                metrics = result.get("metrics", {})
                if (
                    isinstance(metrics, dict)
                    and metrics.get("benchmark_success_allowed") is not True
                ):
                    errors.append(
                        f"{prefix}.metrics simulator benchmark_success_allowed must be true"
                    )
        for asset_index, asset in enumerate(result.get("blocked_assets", [])):
            asset_prefix = f"{prefix}.blocked_assets[{asset_index}]"
            if not isinstance(asset.get("blocker_id"), str) or not asset.get("blocker_id"):
                errors.append(f"{asset_prefix}.blocker_id must be non-empty string")
            for field in ("pipeline_visible", "release_blocking"):
                if not isinstance(asset.get(field), bool):
                    errors.append(f"{asset_prefix}.{field} must be bool")
        if not all(isinstance(part, str) for part in result.get("command", [])):
            errors.append(f"{prefix}.command must contain only strings")
        for dep_index, dep in enumerate(result.get("dependencies", [])):
            dep_prefix = f"{prefix}.dependencies[{dep_index}]"
            for field in ("name", "kind", "available"):
                if field not in dep:
                    errors.append(f"{dep_prefix} missing {field}")
            if "available" in dep and not isinstance(dep["available"], bool):
                errors.append(f"{dep_prefix}.available must be bool")
    return errors


def validate_report_file(path: Path, artifact_root: Path | None = None) -> list[str]:
    with path.open("r", encoding="utf-8") as f:
        report = json.load(f)
    return validate_report(report, artifact_root)


def run_benchmark(
    bench: dict[str, Any],
    args: argparse.Namespace,
    root: Path,
    run_dir: Path,
    report: dict[str, Any],
) -> dict[str, Any]:
    command = bench["command"]
    statuses = dependency_status(bench, root, allow_host_smoke=args.allow_host_smoke_tools)
    execution_command = command_with_resolved_executable(command, statuses)
    missing = missing_dependencies(statuses)
    missing_details = missing_dependency_details(statuses)
    dependency_blockers = missing_dependency_blockers(bench, statuses)
    blocked = blocked_assets(statuses)
    blocked_requirements = []
    if not args.dry_run:
        blocked_requirements.extend(dependency_blockers)
        blocked_requirements.extend(metadata_blockers(report, bench, root))
    log_path = run_dir / f"{bench['name']}.log"
    result: dict[str, Any] = {
        "name": bench["name"],
        "suite": bench.get("suite", bench["name"]),
        "version": bench.get("version", "unknown"),
        "command": command,
        "input_dataset": bench.get("input_dataset", "none"),
        "primary_metric": bench.get("primary_metric", "not_parsed"),
        "units": bench.get("units", "unknown"),
        "parser": bench["parser"],
        "provenance": "dry_run" if args.dry_run else bench.get("provenance", "measured"),
        "dependencies": statuses,
        "artifacts": {"raw_output": display_path(log_path, root)},
    }
    report_artifacts = report.get("artifacts")
    if isinstance(report_artifacts, dict) and report_artifacts.get("target_metadata"):
        result["artifacts"]["target_metadata"] = report_artifacts["target_metadata"]
        result["artifacts"]["target_metadata_sha256"] = report_artifacts.get(
            "target_metadata_sha256"
        )
        result["artifacts"]["target_metadata_bytes"] = report_artifacts.get("target_metadata_bytes")
    if execution_command != command:
        result["resolved_command"] = execution_command
    # MLPerf Power-style integrated energy is passed through verbatim from
    # the benchmark plan. The harness never computes or synthesises this
    # value; missing or malformed metadata stays missing so downstream
    # validators (docs/benchmarks/report-schema.yaml) fail closed.
    energy_metadata = bench.get("energy_joules_per_inference")
    if isinstance(energy_metadata, dict):
        result["energy_joules_per_inference"] = copy.deepcopy(energy_metadata)

    if args.dry_run:
        result["status"] = (
            "blocked" if blocked else "planned_missing_deps" if missing else "planned"
        )
        result["missing_dependencies"] = missing
        if missing_details:
            result["missing_dependency_details"] = missing_details
        if dependency_blockers:
            result["blocked_requirements"] = dependency_blockers
        if blocked:
            result["blocked_assets"] = blocked
        log_path.write_text("dry-run: command was not executed\n", encoding="utf-8")
        record_artifact_hash(result, "raw_output", log_path)
        return result

    if blocked or blocked_requirements:
        for status in statuses:
            if status.get("release_claim_allowed") is True:
                status["release_claim_allowed"] = False
                status["release_claim_blocked_reason"] = (
                    "benchmark result is blocked; dependency cannot support a release claim "
                    "until all benchmark requirements pass"
                )
        result["provenance"] = "blocked_missing_target_evidence"
        result["status"] = "blocked"
        result["claim_allowed"] = False
        result["phone_claim_allowed"] = False
        result["release_claim_allowed"] = False
        result["missing_dependencies"] = missing
        if missing_details:
            result["missing_dependency_details"] = missing_details
        if blocked:
            result["blocked_assets"] = blocked
        if blocked_requirements:
            result["blocked_requirements"] = blocked_requirements
        lines = ["blocked benchmark requirements:"]
        lines.extend(
            f"- {item['name']}: {item['reason']}; {item.get('resolution', '')}"
            for item in blocked_requirements
        )
        lines.extend(
            f"- {item['name']}: {item['reason']}; {item.get('resolution', '')}" for item in blocked
        )
        log_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        record_artifact_hash(result, "raw_output", log_path)
        return result

    if missing:
        result["status"] = "missing_dependencies"
        result["missing_dependencies"] = missing
        if missing_details:
            result["missing_dependency_details"] = missing_details
        log_path.write_text(
            "missing dependencies:\n"
            + "\n".join(
                f"- {item['name']}: {item['reason']}"
                + (f" at {item['path']}" if item.get("path") else "")
                + (f"; {item['resolution']}" if item.get("resolution") else "")
                for item in missing_details
            )
            + "\n",
            encoding="utf-8",
        )
        record_artifact_hash(result, "raw_output", log_path)
        return result

    started = time.monotonic()
    try:
        completed = subprocess.run(
            execution_command,
            cwd=root,
            env=benchmark_env(root, allow_host_smoke=args.allow_host_smoke_tools),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=bench.get("timeout_seconds", args.timeout_seconds),
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        elapsed = time.monotonic() - started
        output = exc.stdout or ""
        if isinstance(output, bytes):
            output = output.decode(errors="replace")
        log_path.write_text(output + "\nTIMEOUT\n", encoding="utf-8")
        record_artifact_hash(result, "raw_output", log_path)
        result.update({"status": "timeout", "elapsed_seconds": elapsed})
        return result
    except OSError as exc:
        result.update({"status": "error", "error": str(exc)})
        log_path.write_text(str(exc) + "\n", encoding="utf-8")
        record_artifact_hash(result, "raw_output", log_path)
        return result

    elapsed = time.monotonic() - started
    log_path.write_text(completed.stdout, encoding="utf-8")
    record_artifact_hash(result, "raw_output", log_path)
    result.update(
        {
            "status": "passed" if completed.returncode == 0 else "failed",
            "returncode": completed.returncode,
            "elapsed_seconds": elapsed,
        }
    )
    parser_name = str(bench.get("parser", ""))
    metrics: dict[str, Any] = {}
    if parser_name:
        result["parser"] = parser_name
        try:
            metrics = parse_benchmark_output(parser_name, completed.stdout)
        except (KeyError, ValueError, json.JSONDecodeError) as exc:
            result.update({"status": "failed", "error": str(exc)})
            return result
        result["metrics"] = metrics
    if completed.returncode != 0:
        result["status"] = "failed"
        return result
    result["run_metadata"] = {
        "runs": int(bench.get("runs", 1)),
        "warmup_runs": int(bench.get("warmup_runs", 0)),
        "required_metadata": required_metadata_sections(bench),
        "required_metrics": bench.get("required_metrics", []),
        "metric_gates": bench.get("metric_gates", []),
        "required_calibration_assets": bench.get("required_calibration_assets", []),
    }
    if isinstance(bench.get("target_execution"), dict):
        result["target_execution"] = copy.deepcopy(bench["target_execution"])
    elif isinstance(report.get("target_execution"), dict):
        result["target_execution"] = copy.deepcopy(report["target_execution"])
    metric_errors = check_metric_requirements(result["metrics"], result["run_metadata"])
    if metric_errors:
        result.update(
            {"status": "failed", "error": "metric gate failed: " + "; ".join(metric_errors)}
        )
        return result
    result["status"] = "passed"
    return result


def add_common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument(
        "--bench", action="append", default=[], help="Benchmark name; repeat or use all"
    )
    parser.add_argument(
        "--strict-missing",
        action="store_true",
        help="Return non-zero if dependencies are missing or blocked",
    )
    parser.add_argument("--timeout-seconds", type=int, default=300)
    parser.add_argument("--report-id", default="manual")
    parser.add_argument("--platform", default="eliza-unknown")
    parser.add_argument("--platform-revision", default="unknown")
    parser.add_argument("--claim-level", default="L2_ARCH_SIM", choices=sorted(VALID_CLAIM_LEVELS))
    parser.add_argument(
        "--allow-host-smoke-tools",
        action="store_true",
        help="Allow repo-local host smoke tools in benchmarks/tools for L2 developer evidence.",
    )
    parser.add_argument(
        "--metadata",
        type=Path,
        help="JSON file with software/clocks/memory/thermal/power metadata for real runs",
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    normalized = list(argv)
    if not normalized or normalized[0] not in COMMANDS:
        normalized.insert(0, "run")

    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_parser = subparsers.add_parser(
        "list", help="List configured benchmarks and dependency hints"
    )
    list_parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)

    plan_parser = subparsers.add_parser(
        "plan", help="Create a dry-run report without executing commands"
    )
    add_common_args(plan_parser)

    run_parser = subparsers.add_parser(
        "run", help="Execute benchmarks whose dependencies and assets are available"
    )
    add_common_args(run_parser)
    run_parser.add_argument("--dry-run", action="store_true", help=argparse.SUPPRESS)

    validate_parser = subparsers.add_parser(
        "validate-report", help="Validate a generated report JSON file"
    )
    validate_parser.add_argument("report", type=Path)
    validate_parser.add_argument(
        "--artifact-root",
        type=Path,
        default=None,
        help="Repository or artifact root used to verify archived raw-output and metadata hashes.",
    )
    return parser.parse_args(normalized)


def print_benchmark_list(config: dict[str, Any]) -> None:
    for bench in config["benchmarks"]:
        print(f"{bench['name']}: {bench['suite']} ({bench.get('version', 'unknown')})")
        print("  command: " + " ".join(bench["command"]))
        if bench.get("requires"):
            print("  tools: " + ", ".join(bench["requires"]))
        if bench.get("required_files"):
            print("  files: " + ", ".join(bench["required_files"]))
        if bench.get("model_artifacts"):
            print(
                "  model artifacts: "
                + ", ".join(asset["path"] for asset in bench["model_artifacts"])
            )
            for asset in bench["model_artifacts"]:
                if asset.get("generator"):
                    print("  model generator: " + " ".join(asset["generator"]["command"]))
        if bench.get("install"):
            print("  install: " + bench["install"])


def run_plan_or_real(args: argparse.Namespace) -> int:
    root = repo_root()
    if args.command == "plan":
        args = copy.copy(args)
        args.dry_run = True
    elif not hasattr(args, "dry_run"):
        args.dry_run = False
    if args.allow_host_smoke_tools and args.claim_level != HOST_SMOKE_CLAIM_LEVEL:
        print(
            f"--allow-host-smoke-tools is only valid with --claim-level {HOST_SMOKE_CLAIM_LEVEL}; "
            f"{args.claim_level} claims must use real benchmark executables.",
            file=sys.stderr,
        )
        return 2
    config_path = args.config if args.config.is_absolute() else root / args.config
    out_dir = args.out_dir if args.out_dir.is_absolute() else root / args.out_dir

    config = load_config(config_path)
    benches = selected_benchmarks(config, set(args.bench))
    run_dir = out_dir / args.report_id
    run_dir.mkdir(parents=True, exist_ok=True)

    report = base_report(args, config, root)
    any_missing = False
    any_blocked = False
    any_failed = False
    for bench in benches:
        result = run_benchmark(bench, args, root, run_dir, report)
        report["results"].append(result)
        any_missing = any_missing or bool(result.get("missing_dependencies"))
        any_blocked = (
            any_blocked
            or bool(result.get("blocked_assets"))
            or bool(result.get("blocked_requirements"))
        )
        any_failed = any_failed or result["status"] in {"failed", "timeout", "error"}

        status = result["status"]
        command = " ".join(result["command"])
        print(f"{bench['name']}: {status}: {command}")
        if result.get("missing_dependencies"):
            print("  missing: " + ", ".join(result["missing_dependencies"]))
        for item in result.get("missing_dependency_details", []):
            path = f" at {item['path']}" if item.get("path") else ""
            resolution = f"; {item['resolution']}" if item.get("resolution") else ""
            print(f"    - {item['name']}: {item['reason']}{path}{resolution}")
        if result.get("blocked_assets"):
            print(
                "  blocked: "
                + ", ".join(
                    f"{item['name']} ({item['reason']})" for item in result["blocked_assets"]
                )
            )
        if result.get("blocked_requirements"):
            print(
                "  blocked requirements: "
                + ", ".join(
                    f"{item['name']} ({item['reason']})" for item in result["blocked_requirements"]
                )
            )

    if any_failed:
        report["status"] = "failed"
    elif any_missing or any_blocked:
        report["status"] = "blocked"
    else:
        report["status"] = "passed"
    report_claim_passed = report["status"] == "passed" and args.dry_run is False
    report["claim_allowed"] = report_claim_passed
    report["phone_claim_allowed"] = report_claim_passed and args.claim_level in {
        "L5_PROTOTYPE_SILICON",
        "L6_COMPLETE_PHONE",
    }
    report["release_claim_allowed"] = (
        report_claim_passed and args.claim_level == "L6_COMPLETE_PHONE"
    )

    errors = validate_report(report, root)
    if errors:
        for error in errors:
            print(f"schema error: {error}", file=sys.stderr)
        return 3

    report_path = run_dir / "report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    try:
        display_path = report_path.relative_to(root)
    except ValueError:
        display_path = report_path
    print(f"wrote {display_path}")

    if any_failed:
        return 1
    if (any_missing or any_blocked) and args.strict_missing:
        print("strict missing mode failed closed:", file=sys.stderr)
        if any_missing:
            print("  one or more benchmarks have missing dependencies", file=sys.stderr)
        if any_blocked:
            print(
                "  one or more benchmarks have blocked assets or metadata requirements",
                file=sys.stderr,
            )
        print(f"  inspect {display_path} for machine-readable blocker details", file=sys.stderr)
        return 2
    return 0


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    root = repo_root()
    if args.command == "validate-report":
        report_path = args.report if args.report.is_absolute() else root / args.report
        artifact_root = (
            args.artifact_root
            if args.artifact_root is not None and args.artifact_root.is_absolute()
            else root / args.artifact_root
            if args.artifact_root is not None
            else root
        )
        errors = validate_report_file(report_path, artifact_root)
        if errors:
            for error in errors:
                print(f"schema error: {error}", file=sys.stderr)
            return 3
        print(f"{report_path}: valid")
        return 0
    if args.command == "list":
        config_path = args.config if args.config.is_absolute() else root / args.config
        print_benchmark_list(load_config(config_path))
        return 0
    return run_plan_or_real(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
