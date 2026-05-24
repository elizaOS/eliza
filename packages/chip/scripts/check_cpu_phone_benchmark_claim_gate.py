#!/usr/bin/env python3
"""Fail-closed gate for phone-class CPU benchmark claims.

This gate intentionally does not run SPEC, JetStream, CoreMark, Dhrystone,
or lmbench. It verifies that the artifacts which would justify a phone-class
CPU claim are present, schema-valid, non-blocked, and tied to a real L5/L6
benchmark report with raw-output hashes.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import sys
from pathlib import Path
from typing import Any

from target_metadata_contract import validate_target_metadata

ROOT = Path(__file__).resolve().parents[1]
RUNNER_PATH = ROOT / "benchmarks/run_benchmarks.py"
DEFAULT_REPORT = ROOT / "benchmarks/results/cpu-phone/report.json"
OUT = ROOT / "build/reports/cpu_phone_benchmark_claim_gate.json"
L5_L6_OUT = ROOT / "build/reports/cpu_phone_l5_l6_benchmark_report.json"

SIDE_RESULT_SPECS = {
    "spec_cpu2017": ROOT / "benchmarks/results/cpu/spec/result.json",
    "coremark": ROOT / "benchmarks/results/cpu/coremark/l5_l6_result.json",
    "dhrystone": ROOT / "benchmarks/results/cpu/dhrystone/l5_l6_result.json",
    "jetstream2": ROOT / "benchmarks/results/cpu/jetstream/result.json",
}
SIDE_RESULT_MANIFESTS = {
    "spec_cpu2017": ROOT / "benchmarks/cpu/spec/manifest.json",
    "coremark": ROOT / "benchmarks/cpu/coremark/manifest.json",
    "dhrystone": ROOT / "benchmarks/cpu/dhrystone/manifest.json",
    "jetstream2": ROOT / "benchmarks/cpu/jetstream/manifest.json",
}
SIDE_RESULT_NEXT_COMMANDS = {
    "spec_cpu2017": (
        "E1_SPEC_RAW_OUTPUT=<target-runcpu-report> "
        "E1_SPEC_TARGET_METADATA=<metadata.json> "
        "E1_SPEC_TARGET_RUNNER=<prototype|silicon|phone> "
        "E1_SPEC_RUN_MANIFEST=<run-manifest.json> "
        "SPEC_LICENSE_SHA256=<sha256> "
        "make spec-skeleton"
    ),
    "coremark": (
        "E1_COREMARK_RAW_OUTPUT=<target-transcript> "
        "E1_COREMARK_TARGET_METADATA=<metadata.json> "
        "E1_COREMARK_TARGET_RUNNER=<prototype|silicon|phone> "
        "make coremark-l5-l6"
    ),
    "dhrystone": (
        "E1_DHRYSTONE_RAW_OUTPUT=<target-transcript> "
        "E1_DHRYSTONE_TARGET_METADATA=<metadata.json> "
        "E1_DHRYSTONE_TARGET_RUNNER=<prototype|silicon|phone> "
        "make dhrystone-l5-l6"
    ),
    "jetstream2": (
        "E1_JETSTREAM_RAW_OUTPUT=<target-transcript> "
        "E1_JETSTREAM_TARGET_METADATA=<metadata.json> "
        "E1_JETSTREAM_TARGET_RUNNER=<prototype|silicon|phone> "
        "make jetstream"
    ),
}
EXPECTED_SIDE_BENCHMARK_FIELD = {
    "spec_cpu2017": "spec-cpu-2017",
    "coremark": "coremark",
    "dhrystone": "dhrystone",
    "jetstream2": "jetstream2",
}
REQUIRED_REPORT_BENCHES = {"lmbench_bw_mem", "lmbench_lat_mem_rd"}
REQUIRED_BENCHMARKS = tuple(SIDE_RESULT_SPECS) + tuple(sorted(REQUIRED_REPORT_BENCHES))
REQUIRED_CLAIM_LEVELS = {"L5_PROTOTYPE_SILICON", "L6_COMPLETE_PHONE"}
REQUIRED_SIDE_SCHEMA = "eliza.cpu_benchmark_result.v1"
REQUIRED_SIDE_PROVENANCE = {"measured", "target-measured", "silicon-measured"}
REQUIRED_BLOCKED_SIDE_PROVENANCE = "blocked_placeholder"
REQUIRED_TARGET_RUNNERS = {"prototype", "silicon", "phone"}
REQUIRED_SIDE_METRICS = {
    "spec_cpu2017": {
        "specint2017_rate_base",
        "specint2017_speed_base",
        "specfp2017_rate_base",
        "specfp2017_speed_base",
    },
    "coremark": {"iterations_per_second", "coremark_per_mhz"},
    "dhrystone": {"dhrystones_per_second", "dmips_per_mhz"},
    "jetstream2": {"jetstream2_score"},
}
REQUIRED_SIDE_CALIBRATION_ASSETS = {
    "coremark": {"coremark_binary"},
    "dhrystone": {"dhrystone_binary"},
    "jetstream2": {"jetstream_engine"},
}
REQUIRED_BLOCKED_SIDE_REQUIREMENTS = {
    "spec_cpu2017": {
        "licensed_spec_cpu2017_install",
        "license_hash",
        "target.runner.spec_cpu2017",
        "target.metadata",
        "artifacts.raw_output_sha256",
        "metrics",
    },
    "coremark": {
        "target.runner.coremark",
        "target.raw_output",
        "target.metadata",
        "target.dut",
        "artifacts.raw_output_sha256",
        "calibration.clock_source",
        "calibration.power_thermal",
        "metrics",
    },
    "dhrystone": {
        "target.runner.dhrystone",
        "target.raw_output",
        "target.metadata",
        "target.dut",
        "artifacts.raw_output_sha256",
        "calibration.clock_source",
        "calibration.power_thermal",
        "metrics",
    },
    "jetstream2": {
        "riscv64_js_engine",
        "jetstream2_sources",
        "target.runner.jetstream2",
        "target.metadata",
        "artifacts.raw_output_sha256",
        "metrics",
    },
}
REQUIRED_REPORT_METRICS = {
    "lmbench_bw_mem": {"bandwidth_mb_per_s"},
    "lmbench_lat_mem_rd": {"max_latency_ns"},
}
REQUIRED_REPORT_CALIBRATION_ASSETS = {
    "lmbench_bw_mem": {"clock_source", "power_meter", "lmbench_binary", "memory_model"},
    "lmbench_lat_mem_rd": {"clock_source", "power_meter", "lmbench_binary", "memory_model"},
}
CPU_PHONE_REPORT_COMMAND = (
    "python3 benchmarks/run_benchmarks.py run --report-id cpu-phone "
    "--bench lmbench_bw_mem --bench lmbench_lat_mem_rd "
    "--platform e1-phone-prototype --platform-revision <prototype-or-phone-revision> "
    "--claim-level L5_PROTOTYPE_SILICON "
    "--metadata benchmarks/metadata/<real-target-metadata>.json --strict-missing"
)
CPU_PHONE_REPORT_REQUIREMENTS = (
    "Requires target-built bw_mem and lat_mem_rd on PATH, a real target metadata JSON "
    "with software/clocks/memory/thermal/power/process/calibration sections, and "
    "calibrated clock_source, power_meter, lmbench_binary, and memory_model assets."
)


def summarize_blocked_requirements(result: dict[str, Any], limit: int = 8) -> str | None:
    requirements = result.get("blocked_requirements")
    if not isinstance(requirements, list):
        return None
    names: list[str] = []
    for item in requirements:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        reason = item.get("reason")
        if not isinstance(name, str) or not name:
            continue
        names.append(f"{name} ({reason})" if isinstance(reason, str) and reason else name)
    if not names:
        return None
    shown = names[:limit]
    remaining = len(names) - len(shown)
    suffix = f"; +{remaining} more" if remaining > 0 else ""
    return "; ".join(shown) + suffix


def blocked_requirement_names(result: dict[str, Any]) -> list[str]:
    requirements = result.get("blocked_requirements")
    if not isinstance(requirements, list):
        return []
    names: list[str] = []
    for item in requirements:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if isinstance(name, str) and name:
            names.append(name)
    return names


def load_json(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return None, "missing"
    except json.JSONDecodeError as exc:
        return None, f"invalid_json:{exc}"
    if not isinstance(data, dict):
        return None, "not_object"
    return data, None


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_benchmark_runner():
    spec = importlib.util.spec_from_file_location("run_benchmarks", RUNNER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to import {RUNNER_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def has_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(ch in "0123456789abcdef" for ch in value)
    )


def is_placeholder_sha256(value: Any) -> bool:
    return isinstance(value, str) and has_sha256(value) and len(set(value.lower())) == 1


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def raw_output_sha256(data: dict[str, Any]) -> str | None:
    artifacts = data.get("artifacts")
    if isinstance(artifacts, dict) and has_sha256(artifacts.get("raw_output_sha256")):
        return str(artifacts["raw_output_sha256"])
    return None


def raw_output_path(data: dict[str, Any]) -> Path | None:
    artifacts = data.get("artifacts")
    if not isinstance(artifacts, dict):
        return None
    return resolve_artifact_path(artifacts.get("raw_output"))


def transcript_marker_errors(name: str, data: dict[str, Any], *, scope: str) -> list[str]:
    path = raw_output_path(data)
    if path is None or not path.is_file():
        return []
    text = path.read_text(encoding="utf-8", errors="replace").lower()
    marker_sets = {
        "spec_cpu2017": ("spec cpu2017", "runcpu", "reportable", "base"),
        "coremark": ("coremark size", "correct operation validated"),
        "dhrystone": ("dhrystone benchmark", "dhrystones per second"),
        "jetstream2": ("browserbench jetstream 2.2", "jetstream 2 score"),
    }
    markers = marker_sets.get(name)
    if markers is None:
        return []
    missing = [marker for marker in markers if marker not in text]
    if missing:
        return [f"{scope} raw transcript missing required markers: {', '.join(missing)}"]
    return []


def raw_output_validation_errors(data: dict[str, Any], *, scope: str) -> list[str]:
    artifacts = data.get("artifacts")
    if not isinstance(artifacts, dict):
        return [f"{scope} must include artifacts.raw_output"]

    raw_path = resolve_artifact_path(artifacts.get("raw_output"))
    declared_sha = artifacts.get("raw_output_sha256")
    errors: list[str] = []
    if raw_path is None:
        errors.append(f"{scope} must include artifacts.raw_output")
    if not has_sha256(declared_sha) or is_placeholder_sha256(declared_sha):
        errors.append(f"{scope} must include non-placeholder artifacts.raw_output_sha256")
    if raw_path is None:
        return errors
    try:
        raw_path.resolve().relative_to(ROOT.resolve())
    except ValueError:
        errors.append(f"{scope} raw output artifact must be archived under the chip tree")
        return errors
    if not raw_path.is_file():
        errors.append(f"{scope} raw output artifact is missing: {raw_path}")
        return errors
    if raw_path.stat().st_size == 0:
        errors.append(f"{scope} raw output artifact must not be empty")
        return errors
    actual_sha = sha256_file(raw_path)
    if has_sha256(declared_sha) and str(declared_sha).lower() != actual_sha.lower():
        errors.append(f"{scope} artifacts.raw_output_sha256 does not match raw_output")

    target = data.get("target_execution")
    transcript_sha = target.get("transcript_sha256") if isinstance(target, dict) else None
    if has_sha256(transcript_sha) and str(transcript_sha).lower() != actual_sha.lower():
        errors.append(f"{scope} target_execution.transcript_sha256 does not match raw_output")
    return errors


def resolve_artifact_path(value: Any) -> Path | None:
    if not isinstance(value, str) or not value:
        return None
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def calibration_asset_evidence_errors(
    assets: dict[str, Any],
    asset_names: set[str],
    *,
    scope: str,
) -> list[str]:
    errors: list[str] = []
    for asset_name in sorted(asset_names):
        asset = assets.get(asset_name)
        asset_scope = f"{scope} calibration.assets.{asset_name}"
        if not isinstance(asset, dict):
            errors.append(f"{asset_scope} missing or not an object")
            continue
        evidence_path = resolve_artifact_path(asset.get("evidence"))
        declared_sha = asset.get("sha256")
        if evidence_path is None:
            errors.append(f"{asset_scope}.evidence must name an archived artifact path")
            continue
        try:
            evidence_path.resolve().relative_to(ROOT.resolve())
        except ValueError:
            errors.append(f"{asset_scope}.evidence artifact must be archived under the chip tree")
            continue
        if not evidence_path.is_file():
            errors.append(f"{asset_scope}.evidence artifact is missing: {evidence_path}")
            continue
        actual_sha = sha256_file(evidence_path)
        if not has_sha256(declared_sha):
            errors.append(f"{asset_scope}.sha256 must be a SHA-256 hex digest")
        elif str(declared_sha).lower() != actual_sha.lower():
            errors.append(f"{asset_scope}.sha256 does not match evidence artifact")
    return errors


def target_metadata_validation_errors(
    data: dict[str, Any],
    *,
    scope: str,
    required_calibration_assets: set[str] | None = None,
) -> list[str]:
    artifacts = data.get("artifacts")
    if not isinstance(artifacts, dict):
        return [f"{scope} must include artifacts.target_metadata"]

    metadata_path = resolve_artifact_path(artifacts.get("target_metadata"))
    if metadata_path is None:
        return [f"{scope} must include artifacts.target_metadata"]

    declared_sha = artifacts.get("target_metadata_sha256")
    errors: list[str] = []
    if not has_sha256(declared_sha):
        errors.append(f"{scope} must include artifacts.target_metadata_sha256")
    try:
        metadata_path.resolve().relative_to(ROOT.resolve())
    except ValueError:
        errors.append(f"{scope} target metadata artifact must be archived under the chip tree")
        return errors
    if not metadata_path.is_file():
        errors.append(f"{scope} target metadata artifact is missing: {metadata_path}")
        return errors

    actual_sha = sha256_file(metadata_path)
    if has_sha256(declared_sha) and str(declared_sha).lower() != actual_sha.lower():
        errors.append(f"{scope} artifacts.target_metadata_sha256 does not match target_metadata")

    metadata, error = load_json(metadata_path)
    if error is not None or metadata is None:
        errors.append(f"{scope} target metadata must be valid JSON: {error}")
        return errors

    target = data.get("target_execution")
    runner = target.get("runner") if isinstance(target, dict) else None
    contract_errors = validate_target_metadata(
        metadata,
        runner=runner if isinstance(runner, str) else None,
        artifact_root=ROOT,
    )
    if contract_errors:
        errors.append(
            f"{scope} target metadata contract failed: " + "; ".join(contract_errors)
        )
    calibration = metadata.get("calibration")
    assets = calibration.get("assets") if isinstance(calibration, dict) else None
    if isinstance(assets, dict):
        required_assets = {"clock_source", "power_meter"}
        if required_calibration_assets:
            required_assets |= required_calibration_assets
        errors.extend(calibration_asset_evidence_errors(assets, required_assets, scope=scope))
    return errors


def artifact_hash_validation_errors(
    artifacts: dict[str, Any],
    *,
    path_key: str,
    sha_key: str,
    scope: str,
) -> tuple[list[str], Path | None]:
    artifact_path = resolve_artifact_path(artifacts.get(path_key))
    declared_sha = artifacts.get(sha_key)
    errors: list[str] = []
    if artifact_path is None:
        errors.append(f"{scope} must include artifacts.{path_key}")
    if not has_sha256(declared_sha) or is_placeholder_sha256(declared_sha):
        errors.append(f"{scope} must include non-placeholder artifacts.{sha_key}")
    if artifact_path is None:
        return errors, None
    try:
        artifact_path.resolve().relative_to(ROOT.resolve())
    except ValueError:
        errors.append(f"{scope} {path_key} artifact must be archived under the chip tree")
        return errors, artifact_path
    if not artifact_path.is_file():
        errors.append(f"{scope} {path_key} artifact is missing: {artifact_path}")
        return errors, artifact_path
    if artifact_path.stat().st_size == 0:
        errors.append(f"{scope} {path_key} artifact must not be empty")
        return errors, artifact_path
    actual_sha = sha256_file(artifact_path)
    if has_sha256(declared_sha) and str(declared_sha).lower() != actual_sha.lower():
        errors.append(f"{scope} artifacts.{sha_key} does not match {path_key}")
    return errors, artifact_path


def spec_run_manifest_validation_errors(data: dict[str, Any], *, scope: str) -> list[str]:
    artifacts = data.get("artifacts")
    if not isinstance(artifacts, dict):
        return [f"{scope} must include artifacts.spec_run_manifest"]
    errors, manifest_path = artifact_hash_validation_errors(
        artifacts,
        path_key="spec_run_manifest",
        sha_key="spec_run_manifest_sha256",
        scope=scope,
    )
    if errors or manifest_path is None or not manifest_path.is_file():
        return errors
    manifest, error = load_json(manifest_path)
    if error is not None or manifest is None:
        return errors + [f"{scope} SPEC run manifest must be valid JSON: {error}"]
    required_strings = ("spec_version", "runcpu_command", "config", "result_bundle")
    for field in required_strings:
        value = manifest.get(field)
        if not isinstance(value, str) or not value.strip():
            errors.append(f"{scope} SPEC run manifest missing non-empty {field}")
    if "cpu2017" not in str(manifest.get("spec_version", "")).lower():
        errors.append(f"{scope} SPEC run manifest spec_version must identify SPEC CPU2017")
    if "runcpu" not in str(manifest.get("runcpu_command", "")).lower():
        errors.append(f"{scope} SPEC run manifest runcpu_command must include runcpu")
    if manifest.get("reportable") is not True:
        errors.append(f"{scope} SPEC run manifest must record reportable=true")
    config_sha = manifest.get("config_sha256")
    if not has_sha256(config_sha) or is_placeholder_sha256(config_sha):
        errors.append(f"{scope} SPEC run manifest must include non-placeholder config_sha256")
    config_path = resolve_artifact_path(manifest.get("config"))
    if config_path is not None:
        try:
            config_resolved = config_path.resolve()
            config_resolved.relative_to(ROOT.resolve())
        except ValueError:
            errors.append(f"{scope} SPEC run manifest config must be archived under the chip tree")
        else:
            if not config_resolved.is_file():
                errors.append(f"{scope} SPEC run manifest config is missing: {config_path}")
            elif has_sha256(config_sha) and sha256_file(config_resolved).lower() != str(config_sha).lower():
                errors.append(f"{scope} SPEC run manifest config file does not match config_sha256")
    if not has_sha256(manifest.get("result_bundle_sha256")) or is_placeholder_sha256(
        manifest.get("result_bundle_sha256")
    ):
        errors.append(f"{scope} SPEC run manifest must include non-placeholder result_bundle_sha256")
    raw_sha = raw_output_sha256(data)
    bundle_sha = manifest.get("result_bundle_sha256")
    if has_sha256(raw_sha) and has_sha256(bundle_sha) and str(bundle_sha).lower() != str(raw_sha).lower():
        errors.append(f"{scope} SPEC run manifest result_bundle_sha256 must match artifacts.raw_output_sha256")
    bundle_path = resolve_artifact_path(manifest.get("result_bundle"))
    if bundle_path is not None:
        try:
            bundle_resolved = bundle_path.resolve()
            bundle_resolved.relative_to(ROOT.resolve())
        except ValueError:
            errors.append(f"{scope} SPEC run manifest result_bundle must be archived under the chip tree")
        else:
            if not bundle_resolved.is_file():
                errors.append(f"{scope} SPEC run manifest result_bundle is missing: {bundle_path}")
            elif has_sha256(raw_sha) and sha256_file(bundle_resolved).lower() != str(raw_sha).lower():
                errors.append(f"{scope} SPEC run manifest result_bundle file does not match raw_output_sha256")
    return errors


def manifest_unblock_metadata(name: str) -> dict[str, Any]:
    manifest_path = SIDE_RESULT_MANIFESTS.get(name)
    metadata: dict[str, Any] = {
        "next_command": SIDE_RESULT_NEXT_COMMANDS.get(name),
    }
    if manifest_path is None:
        return metadata

    manifest, error = load_json(manifest_path)
    metadata["manifest"] = rel(manifest_path)
    if error is not None or manifest is None:
        metadata["manifest_error"] = error
        return metadata

    metadata["manifest_status"] = manifest.get("status")
    metadata["claim_boundary"] = manifest.get("claim_boundary")
    metadata["run_command"] = manifest.get("phone_run_command") or manifest.get("run_command")
    requirements = (
        manifest.get("fail_closed_for_phone_claim_until")
        or manifest.get("fail_closed_until")
        or manifest.get("required_evidence")
    )
    if isinstance(requirements, list):
        metadata["required_evidence"] = requirements
    return metadata


def target_execution_errors(data: dict[str, Any], *, scope: str) -> list[str]:
    target = data.get("target_execution")
    if not isinstance(target, dict):
        return [f"{scope} must include target_execution metadata"]

    errors: list[str] = []
    runner = target.get("runner")
    if runner not in REQUIRED_TARGET_RUNNERS:
        errors.append(
            f"{scope} target_execution.runner must identify a real target "
            f"({', '.join(sorted(REQUIRED_TARGET_RUNNERS))})"
        )
    if target.get("runner") in {"host", "local"} or target.get("host_run") is True:
        errors.append(f"{scope} must not be marked as host/local execution")
    if not has_sha256(target.get("transcript_sha256")):
        errors.append(f"{scope} must include target_execution.transcript_sha256")
    return errors


def top_level_transcript_artifact_errors(data: dict[str, Any], *, scope: str) -> list[str]:
    target = data.get("target_execution")
    if not isinstance(target, dict):
        return []
    path_value = target.get("transcript_path")
    digest = target.get("transcript_sha256")
    errors: list[str] = []
    if not isinstance(path_value, str) or not path_value.strip():
        return [f"{scope} must include target_execution.transcript_path"]
    path = Path(path_value)
    if path.is_absolute() or ".." in path.parts:
        return [f"{scope} target_execution.transcript_path must be a relative chip-tree path"]
    resolved = ROOT / path
    if not resolved.is_file():
        return [f"{scope} target_execution.transcript_path is missing: {path_value}"]
    if has_sha256(digest) and sha256_file(resolved).lower() != str(digest).lower():
        errors.append(f"{scope} target_execution.transcript_sha256 does not match transcript_path")
    return errors


def required_metric_errors(name: str, metrics: Any) -> list[str]:
    if not isinstance(metrics, dict) or not metrics:
        return ["passed side result must include non-empty metrics"]
    errors: list[str] = []
    required_metrics = REQUIRED_SIDE_METRICS.get(name, set())
    missing_metrics = sorted(metric for metric in required_metrics if metric not in metrics)
    if missing_metrics:
        errors.append(
            "passed side result missing required metrics: "
            + ", ".join(missing_metrics)
        )
    for metric in sorted(required_metrics):
        if metric not in metrics:
            continue
        value = metrics[metric]
        if (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(value)
            or value <= 0
        ):
            errors.append(f"passed side result metric {metric} must be a positive number")
    return errors


def required_report_metric_errors(name: str, metrics: Any) -> list[str]:
    if not isinstance(metrics, dict) or not metrics:
        return ["passed result must include non-empty metrics"]
    errors: list[str] = []
    required_metrics = REQUIRED_REPORT_METRICS.get(name, set())
    missing_metrics = sorted(metric for metric in required_metrics if metric not in metrics)
    if missing_metrics:
        errors.append("passed result missing required metrics: " + ", ".join(missing_metrics))
    for metric in sorted(required_metrics):
        if metric not in metrics:
            continue
        value = metrics[metric]
        if (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(value)
            or value <= 0
        ):
            errors.append(f"passed result metric {metric} must be a positive number")
    return errors


def required_report_calibration_asset_errors(
    name: str,
    result: dict[str, Any],
    report: dict[str, Any],
) -> list[str]:
    run_metadata = result.get("run_metadata")
    if not isinstance(run_metadata, dict):
        return ["passed result must include run_metadata"]
    declared = run_metadata.get("required_calibration_assets")
    if not isinstance(declared, list):
        return ["passed result run_metadata.required_calibration_assets must be a list"]
    declared_assets = {item for item in declared if isinstance(item, str)}
    required_assets = REQUIRED_REPORT_CALIBRATION_ASSETS.get(name, set())
    missing = sorted(required_assets - declared_assets)
    if missing:
        return ["passed result missing required calibration assets: " + ", ".join(missing)]
    calibration = report.get("calibration")
    assets = calibration.get("assets") if isinstance(calibration, dict) else None
    if not isinstance(assets, dict):
        return ["benchmark report must include calibration.assets"]
    return calibration_asset_evidence_errors(
        assets,
        required_assets,
        scope=f"{name} report",
    )


def validate_passed_side_result(name: str, data: dict[str, Any]) -> list[str]:
    reasons: list[str] = []
    expected_benchmark = EXPECTED_SIDE_BENCHMARK_FIELD[name]
    if data.get("benchmark") != expected_benchmark:
        reasons.append(f"benchmark must be {expected_benchmark!r}")

    claim_level = data.get("claim_level")
    if claim_level not in REQUIRED_CLAIM_LEVELS:
        reasons.append("claim_level must be L5_PROTOTYPE_SILICON or L6_COMPLETE_PHONE")

    provenance = data.get("provenance")
    if provenance not in REQUIRED_SIDE_PROVENANCE:
        reasons.append(
            "provenance must be one of "
            + ", ".join(sorted(REQUIRED_SIDE_PROVENANCE))
        )

    reasons.extend(required_metric_errors(name, data.get("metrics")))

    if raw_output_sha256(data) is None:
        reasons.append("passed side result must include artifacts.raw_output_sha256")

    reasons.extend(target_execution_errors(data, scope=f"{name} side result"))
    reasons.extend(raw_output_validation_errors(data, scope=f"{name} side result"))
    reasons.extend(transcript_marker_errors(name, data, scope=f"{name} side result"))
    reasons.extend(
        target_metadata_validation_errors(
            data,
            scope=f"{name} side result",
            required_calibration_assets=REQUIRED_SIDE_CALIBRATION_ASSETS.get(name),
        )
    )

    artifacts = data.get("artifacts")
    if name == "spec_cpu2017" and (
        not isinstance(artifacts, dict)
        or not has_sha256(artifacts.get("spec_license_sha256"))
        or is_placeholder_sha256(artifacts.get("spec_license_sha256"))
    ):
        reasons.append("SPEC side result must include non-placeholder artifacts.spec_license_sha256")
    if name == "spec_cpu2017":
        reasons.extend(spec_run_manifest_validation_errors(data, scope="spec_cpu2017 side result"))
    return reasons


def validate_blocked_side_result(name: str, data: dict[str, Any]) -> list[str]:
    reasons: list[str] = []
    expected_benchmark = EXPECTED_SIDE_BENCHMARK_FIELD[name]
    if data.get("benchmark") != expected_benchmark:
        reasons.append(f"benchmark must be {expected_benchmark!r}")
    if data.get("provenance") != REQUIRED_BLOCKED_SIDE_PROVENANCE:
        reasons.append(
            f"blocked side result provenance must be {REQUIRED_BLOCKED_SIDE_PROVENANCE!r}"
        )
    for claim_field in ("claim_allowed", "phone_claim_allowed", "release_claim_allowed"):
        if data.get(claim_field) is not False:
            reasons.append(f"blocked side result {claim_field} must be false")
    reason = data.get("reason")
    requirements = data.get("blocked_requirements")
    if not isinstance(reason, str) and not isinstance(requirements, list):
        reasons.append("blocked side result must include reason or blocked_requirements")
    if not isinstance(reason, str) or not reason.strip():
        reasons.append("blocked side result must include non-empty reason")
    if not isinstance(requirements, list) or not requirements:
        reasons.append("blocked side result must include non-empty blocked_requirements")
    else:
        names: set[str] = set()
        for index, requirement in enumerate(requirements):
            if not isinstance(requirement, dict):
                reasons.append(f"blocked_requirements[{index}] must be an object")
                continue
            req_name = requirement.get("name")
            req_reason = requirement.get("reason")
            req_resolution = requirement.get("resolution")
            if not isinstance(req_name, str) or not req_name:
                reasons.append(f"blocked_requirements[{index}].name must be non-empty")
                continue
            names.add(req_name)
            if not isinstance(req_reason, str) or not req_reason:
                reasons.append(f"blocked_requirements[{index}].reason must be non-empty")
            if not isinstance(req_resolution, str) or not req_resolution:
                reasons.append(f"blocked_requirements[{index}].resolution must be non-empty")
        expected = REQUIRED_BLOCKED_SIDE_REQUIREMENTS.get(name, set())
        missing = sorted(expected - names)
        if missing:
            reasons.append(
                "blocked side result missing blocked_requirements: " + ", ".join(missing)
            )
    return reasons


def side_result_findings() -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for name, path in SIDE_RESULT_SPECS.items():
        data, error = load_json(path)
        base = {"name": name, "path": rel(path)}
        if error is not None:
            findings.append({**base, "status": "missing_or_invalid", "reason": error})
            continue
        assert data is not None
        if data.get("schema") != REQUIRED_SIDE_SCHEMA:
            findings.append(
                {
                    **base,
                    "status": "invalid",
                    "reason": f"schema must be {REQUIRED_SIDE_SCHEMA}",
                }
            )
            continue
        status = data.get("status")
        if status != "passed":
            if status != "blocked":
                findings.append(
                    {
                        **base,
                        "status": "invalid",
                        "reason": "side result status must be 'passed' or 'blocked'",
                        "record_status": status,
                    }
                )
                continue
            validation_errors = validate_blocked_side_result(name, data)
            findings.append(
                {
                    **base,
                    "status": "invalid" if validation_errors else "blocked",
                    "reason": (
                        "; ".join(validation_errors)
                        if validation_errors
                        else str(data.get("reason") or data.get("missing_dependency") or status)
                    ),
                    "record_status": status,
                }
            )
            continue
        validation_errors = validate_passed_side_result(name, data)
        if validation_errors:
            findings.append(
                {
                    **base,
                    "status": "blocked",
                    "reason": "; ".join(validation_errors),
                    "record_status": status,
                    "claim_level": data.get("claim_level"),
                }
            )
            continue
        findings.append(
            {
                **base,
                "status": "pass",
                "record_status": status,
                "claim_level": data.get("claim_level"),
            }
        )
    return findings


def report_findings(report_path: Path) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    data, error = load_json(report_path)
    if error is not None:
        return [
            {
                "name": "benchmark_report",
                "path": rel(report_path),
                "status": "missing_or_invalid",
                "reason": error,
                "next_command": CPU_PHONE_REPORT_COMMAND,
                "requirements": CPU_PHONE_REPORT_REQUIREMENTS,
            }
        ]
    assert data is not None

    runner = load_benchmark_runner()
    validation_errors = runner.validate_report(data, ROOT)
    if validation_errors:
        findings.append(
            {
                "name": "benchmark_report_schema",
                "path": rel(report_path),
                "status": "invalid",
                "reason": "; ".join(validation_errors),
            }
        )

    if data.get("status") != "passed":
        findings.append(
            {
                "name": "benchmark_report_status",
                "path": rel(report_path),
                "status": "blocked",
                "reason": "top-level benchmark report status must be 'passed'",
                "record_status": data.get("status"),
                "next_command": CPU_PHONE_REPORT_COMMAND,
                "requirements": CPU_PHONE_REPORT_REQUIREMENTS,
            }
        )

    claim_level = data.get("claim_level")
    if claim_level not in REQUIRED_CLAIM_LEVELS:
        findings.append(
            {
                "name": "benchmark_report_claim_level",
                "path": rel(report_path),
                "status": "blocked",
                "reason": "claim_level must be L5_PROTOTYPE_SILICON or L6_COMPLETE_PHONE",
                "claim_level": claim_level,
            }
        )

    if data.get("dry_run") is not False:
        findings.append(
            {
                "name": "benchmark_report_dry_run",
                "path": rel(report_path),
                "status": "blocked",
                "reason": "phone-class claim report must be a real run, not dry-run",
            }
        )

    target_errors = target_execution_errors(data, scope="benchmark report")
    target_errors.extend(top_level_transcript_artifact_errors(data, scope="benchmark report"))
    if target_errors:
        findings.append(
            {
                "name": "benchmark_report_target_execution",
                "path": rel(report_path),
                "status": "blocked",
                "reason": "; ".join(target_errors),
                "next_command": CPU_PHONE_REPORT_COMMAND,
                "requirements": CPU_PHONE_REPORT_REQUIREMENTS,
            }
        )

    results = {
        item.get("name"): item for item in data.get("results", []) if isinstance(item, dict)
    }
    results = {item.get("name"): item for item in data.get("results", []) if isinstance(item, dict)}
    for bench in sorted(REQUIRED_REPORT_BENCHES):
        result = results.get(bench)
        if result is None:
            findings.append(
                {
                    "name": bench,
                    "path": rel(report_path),
                    "status": "missing",
                    "reason": "required lmbench result absent from report",
                }
            )
            continue
        if result.get("status") != "passed":
            blocked_summary = summarize_blocked_requirements(result)
            findings.append(
                {
                    "name": bench,
                    "path": rel(report_path),
                    "status": "blocked",
                    "reason": f"result status is {result.get('status')!r}",
                    **(
                        {"blocked_requirements_summary": blocked_summary} if blocked_summary else {}
                    ),
                }
            )
            continue
        required_assets = REQUIRED_REPORT_CALIBRATION_ASSETS.get(bench, set())
        raw_errors = raw_output_validation_errors(result, scope=f"{bench} result")
        metadata_errors = target_metadata_validation_errors(
            result,
            scope=f"{bench} result",
            required_calibration_assets=required_assets,
        )
        if raw_errors or metadata_errors:
            findings.append(
                {
                    "name": bench,
                    "path": rel(report_path),
                    "status": "invalid",
                    "reason": "; ".join(raw_errors + metadata_errors),
                }
            )
            continue
        if result.get("provenance") not in REQUIRED_SIDE_PROVENANCE:
            findings.append(
                {
                    "name": bench,
                    "path": rel(report_path),
                    "status": "invalid",
                    "reason": (
                        "passed result must include measured provenance "
                        f"({', '.join(sorted(REQUIRED_SIDE_PROVENANCE))})"
                    ),
                }
            )
            continue
        metric_errors = required_report_metric_errors(bench, result.get("metrics"))
        if metric_errors:
            findings.append(
                {
                    "name": bench,
                    "path": rel(report_path),
                    "status": "invalid",
                    "reason": "; ".join(metric_errors),
                }
            )
            continue
        calibration_errors = required_report_calibration_asset_errors(bench, result, data)
        if calibration_errors:
            findings.append(
                {
                    "name": bench,
                    "path": rel(report_path),
                    "status": "invalid",
                    "reason": "; ".join(calibration_errors),
                }
            )
            continue
        result_target_errors = target_execution_errors(result, scope=f"{bench} result")
        if result_target_errors:
            findings.append(
                {
                    "name": bench,
                    "path": rel(report_path),
                    "status": "invalid",
                    "reason": "; ".join(result_target_errors),
                }
            )
            continue
        findings.append({"name": bench, "path": rel(report_path), "status": "pass"})
    return findings


def side_result_entry(name: str, path: Path, finding: dict[str, Any]) -> dict[str, Any]:
    data, error = load_json(path)
    entry: dict[str, Any] = {
        "name": name,
        "source": "side_result",
        "path": rel(path),
        "gate_status": finding.get("status"),
        "claim_satisfied": finding.get("status") == "pass",
        "unblock": manifest_unblock_metadata(name),
    }
    if error is not None or data is None:
        entry["record_status"] = "missing_or_invalid"
        entry["reason"] = error
        entry["claim_allowed"] = False
        entry["phone_claim_allowed"] = False
        entry["release_claim_allowed"] = False
        return entry

    entry.update(
        {
            "record_status": data.get("status"),
            "claim_level": data.get("claim_level"),
            "provenance": data.get("provenance"),
            "claim_allowed": data.get("claim_allowed"),
            "phone_claim_allowed": data.get("phone_claim_allowed"),
            "release_claim_allowed": data.get("release_claim_allowed"),
            "metrics": data.get("metrics"),
            "raw_output_sha256": raw_output_sha256(data),
        }
    )
    artifacts = data.get("artifacts")
    if isinstance(artifacts, dict):
        entry["target_metadata_sha256"] = artifacts.get("target_metadata_sha256")
        if name == "spec_cpu2017":
            entry["spec_license_sha256"] = artifacts.get("spec_license_sha256")
            entry["spec_run_manifest_sha256"] = artifacts.get("spec_run_manifest_sha256")
    target_execution = data.get("target_execution")
    if isinstance(target_execution, dict):
        entry["target_runner"] = target_execution.get("runner")
    if data.get("blocked_requirements"):
        entry["blocked_requirements_count"] = len(data["blocked_requirements"])
        entry["blocked_requirement_names"] = blocked_requirement_names(data)
        blocked_summary = summarize_blocked_requirements(data)
        if blocked_summary:
            entry["blocked_requirements_summary"] = blocked_summary
    if finding.get("status") != "pass":
        entry["reason"] = finding.get("reason")
    return entry


def report_result_entry(
    name: str,
    result: dict[str, Any] | None,
    finding: dict[str, Any],
    report_path: Path,
    report_claim_level: Any,
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "name": name,
        "source": "benchmark_report",
        "path": rel(report_path),
        "gate_status": finding.get("status"),
        "claim_satisfied": finding.get("status") == "pass",
        "unblock": {
            "next_command": CPU_PHONE_REPORT_COMMAND,
            "required_evidence": CPU_PHONE_REPORT_REQUIREMENTS,
        },
    }
    if result is None:
        entry["record_status"] = "missing"
        entry["reason"] = finding.get("reason")
        entry["claim_allowed"] = False
        entry["phone_claim_allowed"] = False
        entry["release_claim_allowed"] = False
        return entry

    artifacts = result.get("artifacts")
    entry.update(
        {
            "record_status": result.get("status"),
            "claim_level": result.get("claim_level") or report_claim_level,
            "provenance": result.get("provenance"),
            "claim_allowed": result.get("claim_allowed"),
            "phone_claim_allowed": result.get("phone_claim_allowed"),
            "release_claim_allowed": result.get("release_claim_allowed"),
            "metrics": result.get("metrics"),
            "raw_output_sha256": (
                artifacts.get("raw_output_sha256") if isinstance(artifacts, dict) else None
            ),
        }
    )
    if isinstance(artifacts, dict):
        entry["target_metadata_sha256"] = artifacts.get("target_metadata_sha256")
    target_execution = result.get("target_execution")
    if isinstance(target_execution, dict):
        entry["target_runner"] = target_execution.get("runner")
    if result.get("blocked_requirements"):
        entry["blocked_requirements_count"] = len(result["blocked_requirements"])
        entry["blocked_requirement_names"] = blocked_requirement_names(result)
    if finding.get("status") != "pass":
        entry["reason"] = finding.get("reason")
        if finding.get("blocked_requirements_summary"):
            entry["blocked_requirements_summary"] = finding[
                "blocked_requirements_summary"
            ]
    return entry


def report_gate_entry(finding: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": finding.get("name"),
        "source": "benchmark_report_gate",
        "path": finding.get("path"),
        "gate_status": finding.get("status"),
        "claim_satisfied": finding.get("status") == "pass",
        "reason": finding.get("reason"),
        "record_status": finding.get("record_status"),
        "claim_level": finding.get("claim_level"),
        "claim_allowed": False,
        "phone_claim_allowed": False,
        "release_claim_allowed": False,
        "unblock": {
            "next_command": finding.get("next_command") or CPU_PHONE_REPORT_COMMAND,
            "required_evidence": finding.get("requirements") or CPU_PHONE_REPORT_REQUIREMENTS,
        },
    }


def build_l5_l6_report(
    report_path: Path,
    gate_report: dict[str, Any],
) -> dict[str, Any]:
    data, _ = load_json(report_path)
    report_results = {}
    report_claim_level = None
    if data is not None:
        report_claim_level = data.get("claim_level")
        report_results = {
            item.get("name"): item for item in data.get("results", []) if isinstance(item, dict)
        }

    findings = {
        item.get("name"): item
        for item in gate_report.get("findings", [])
        if isinstance(item, dict)
    }
    entries: list[dict[str, Any]] = []
    for name, path in SIDE_RESULT_SPECS.items():
        entries.append(side_result_entry(name, path, findings.get(name, {})))
    for name in sorted(REQUIRED_REPORT_BENCHES):
        entries.append(
            report_result_entry(
                name,
                report_results.get(name),
                findings.get(name, {}),
                report_path,
                report_claim_level,
            )
        )
    entry_names = {item["name"] for item in entries}
    for finding in gate_report.get("findings", []):
        if not isinstance(finding, dict):
            continue
        name = finding.get("name")
        if name in entry_names or finding.get("status") == "pass":
            continue
        entries.append(report_gate_entry(finding))

    blocked = [item for item in entries if not item["claim_satisfied"]]
    claim_allowed = not blocked
    return {
        "schema": "eliza.cpu_phone_l5_l6_benchmark_report.v1",
        "status": "pass" if claim_allowed else "blocked",
        "claim_allowed": claim_allowed,
        "phone_claim_allowed": claim_allowed,
        "release_claim_allowed": claim_allowed,
        "claim_levels_accepted": sorted(REQUIRED_CLAIM_LEVELS),
        "claim_boundary": gate_report["claim_boundary"],
        "required_benchmarks": list(REQUIRED_BENCHMARKS),
        "source_report": rel(report_path),
        "entries": entries,
        "blocked_count": len(blocked),
    }


def validate_l5_l6_report(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != "eliza.cpu_phone_l5_l6_benchmark_report.v1":
        errors.append("l5/l6 report schema drifted")

    entries = report.get("entries")
    if not isinstance(entries, list):
        errors.append("l5/l6 report entries must be a list")
        entries = []

    blocked_count = 0
    seen_names: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            errors.append("l5/l6 report entry must be an object")
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name:
            errors.append("l5/l6 report entry missing name")
        elif name in seen_names:
            errors.append(f"l5/l6 report duplicate entry: {name}")
        else:
            seen_names.add(name)
        if not isinstance(entry.get("claim_satisfied"), bool):
            errors.append(f"{name}: claim_satisfied must be boolean")
            claim_satisfied = False
        else:
            claim_satisfied = bool(entry["claim_satisfied"])
        if not claim_satisfied:
            blocked_count += 1
        if entry.get("gate_status") not in {"pass", "blocked", "missing", "missing_or_invalid", "invalid"}:
            errors.append(f"{name}: gate_status is invalid")
        elif claim_satisfied and entry.get("gate_status") != "pass":
            errors.append(f"{name}: satisfied entry must have gate_status pass")
        elif not claim_satisfied and entry.get("gate_status") == "pass":
            errors.append(f"{name}: pass gate_status entry must be claim_satisfied")
        if not isinstance(entry.get("source"), str) or not entry["source"]:
            errors.append(f"{name}: source missing")
        if claim_satisfied:
            if entry.get("record_status") != "passed":
                errors.append(f"{name}: satisfied entry must have record_status passed")
            if entry.get("claim_level") not in REQUIRED_CLAIM_LEVELS:
                errors.append(f"{name}: satisfied entry must have L5/L6 claim_level")
            if entry.get("provenance") not in REQUIRED_SIDE_PROVENANCE:
                errors.append(f"{name}: satisfied entry must have measured provenance")
            if not has_sha256(entry.get("raw_output_sha256")) or is_placeholder_sha256(
                entry.get("raw_output_sha256")
            ):
                errors.append(f"{name}: satisfied entry must include non-placeholder raw_output_sha256")
            if not has_sha256(entry.get("target_metadata_sha256")) or is_placeholder_sha256(
                entry.get("target_metadata_sha256")
            ):
                errors.append(f"{name}: satisfied entry must include non-placeholder target_metadata_sha256")
            if entry.get("target_runner") not in REQUIRED_TARGET_RUNNERS:
                errors.append(f"{name}: satisfied entry must include prototype/silicon/phone target_runner")
            if name == "spec_cpu2017":
                if not has_sha256(entry.get("spec_license_sha256")) or is_placeholder_sha256(
                    entry.get("spec_license_sha256")
                ):
                    errors.append(f"{name}: satisfied SPEC entry must include non-placeholder spec_license_sha256")
                if not has_sha256(entry.get("spec_run_manifest_sha256")) or is_placeholder_sha256(
                    entry.get("spec_run_manifest_sha256")
                ):
                    errors.append(f"{name}: satisfied SPEC entry must include non-placeholder spec_run_manifest_sha256")
            metrics = entry.get("metrics")
            metric_errors: list[str]
            if name in REQUIRED_SIDE_METRICS:
                metric_errors = required_metric_errors(name, metrics)
            else:
                metric_errors = required_report_metric_errors(name, metrics)
            errors.extend(f"{name}: {error}" for error in metric_errors)
        else:
            for claim_field in ("claim_allowed", "phone_claim_allowed", "release_claim_allowed"):
                if entry.get(claim_field) is not False:
                    errors.append(f"{name}: blocked entry {claim_field} must be false")
            if not isinstance(entry.get("reason"), str) or not entry.get("reason"):
                errors.append(f"{name}: blocked entry must include reason")
            unblock = entry.get("unblock")
            if not isinstance(unblock, dict):
                errors.append(f"{name}: blocked entry must include unblock metadata")
            elif not unblock.get("next_command") and not unblock.get("required_evidence"):
                errors.append(f"{name}: blocked entry unblock metadata must name a command or evidence")
            if entry.get("source") == "side_result":
                expected = REQUIRED_BLOCKED_SIDE_REQUIREMENTS.get(str(name), set())
                raw_names = entry.get("blocked_requirement_names")
                if not isinstance(raw_names, list):
                    errors.append(
                        f"{name}: blocked side-result entry must include blocked_requirement_names"
                    )
                    raw_names = []
                else:
                    for index, blocker_name in enumerate(raw_names):
                        if not isinstance(blocker_name, str) or not blocker_name:
                            errors.append(
                                f"{name}: blocked_requirement_names[{index}] must be non-empty"
                            )
                count = entry.get("blocked_requirements_count")
                if isinstance(count, int) and count > 0 and not raw_names:
                    errors.append(
                        f"{name}: blocked side-result entry has blocked_requirements_count "
                        "but no blocked_requirement_names"
                    )
                if expected:
                    names = set(raw_names)
                    missing_names = sorted(expected - names)
                    if missing_names:
                        errors.append(
                            f"{name}: blocked side-result entry missing blocker IDs: "
                            + ", ".join(missing_names)
                        )
                    if not isinstance(count, int) or count < len(expected):
                        errors.append(
                            f"{name}: blocked side-result entry must include at least "
                            f"{len(expected)} blocked requirements"
                        )
                    if not isinstance(entry.get("blocked_requirements_summary"), str) or not entry.get(
                        "blocked_requirements_summary"
                    ):
                        errors.append(
                            f"{name}: blocked side-result entry must include blocked_requirements_summary"
                        )

    expected = set(REQUIRED_BENCHMARKS)
    missing = sorted(expected - seen_names)
    if missing:
        errors.append("l5/l6 report missing required benchmarks: " + ", ".join(missing))
    if report.get("blocked_count") != blocked_count:
        errors.append("l5/l6 report blocked_count does not match entries")
    expected_status = "pass" if blocked_count == 0 else "blocked"
    if report.get("status") != expected_status:
        errors.append("l5/l6 report status does not match blocked_count")
    if report.get("claim_allowed") is not (blocked_count == 0):
        errors.append("l5/l6 report claim_allowed does not match blocked_count")
    if report.get("phone_claim_allowed") is not (blocked_count == 0):
        errors.append("l5/l6 report phone_claim_allowed does not match blocked_count")
    if report.get("release_claim_allowed") is not (blocked_count == 0):
        errors.append("l5/l6 report release_claim_allowed does not match blocked_count")
    if set(report.get("claim_levels_accepted") or []) != REQUIRED_CLAIM_LEVELS:
        errors.append("l5/l6 report claim_levels_accepted drifted")
    if set(report.get("required_benchmarks") or []) != set(REQUIRED_BENCHMARKS):
        errors.append("l5/l6 report required_benchmarks drifted")
    return errors


def build_report(report_path: Path) -> dict[str, Any]:
    side_findings = side_result_findings()
    bench_findings = report_findings(report_path)
    findings = side_findings + bench_findings
    blocked = [item for item in findings if item.get("status") != "pass"]
    status = "pass" if not blocked else "blocked"
    claim_allowed = status == "pass"
    return {
        "schema": "eliza.cpu_phone_benchmark_claim_gate.v1",
        "status": status,
        "claim_allowed": claim_allowed,
        "phone_claim_allowed": claim_allowed,
        "release_claim_allowed": claim_allowed,
        "claim_boundary": (
            "Phone-class CPU benchmark claims require non-blocked SPEC CPU 2017, "
            "CoreMark, Dhrystone, JetStream 2, lmbench bandwidth, lmbench latency, "
            "real target metadata, and raw-output hashes at L5 prototype silicon "
            "or L6 complete phone claim level."
        ),
        "required_side_results": {name: rel(path) for name, path in SIDE_RESULT_SPECS.items()},
        "required_report": rel(report_path),
        "required_report_benchmarks": sorted(REQUIRED_REPORT_BENCHES),
        "l5_l6_report": rel(L5_L6_OUT),
        "findings": findings,
        "blocked_count": len(blocked),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Return 2 while required phone-class benchmark evidence is blocked.",
    )
    parser.add_argument(
        "--no-write",
        "--read-only",
        dest="no_write",
        action="store_true",
        help="Validate and print status without writing gate report artifacts.",
    )
    args = parser.parse_args()

    report_path = args.report if args.report.is_absolute() else ROOT / args.report
    report = build_report(report_path)
    l5_l6_report = build_l5_l6_report(report_path, report)
    schema_errors = validate_l5_l6_report(l5_l6_report)
    if schema_errors:
        report["findings"].append(
            {
                "name": "l5_l6_report_schema",
                "path": rel(L5_L6_OUT),
                "status": "invalid",
                "reason": "; ".join(schema_errors),
            }
        )
        report["status"] = "blocked"
        report["claim_allowed"] = False
        report["phone_claim_allowed"] = False
        report["release_claim_allowed"] = False
        report["blocked_count"] = len([item for item in report["findings"] if item.get("status") != "pass"])
        l5_l6_report = build_l5_l6_report(report_path, report)
    if not args.no_write:
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        L5_L6_OUT.parent.mkdir(parents=True, exist_ok=True)
        L5_L6_OUT.write_text(
            json.dumps(l5_l6_report, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    if report["status"] == "pass":
        print("STATUS: PASS cpu.phone_benchmark_claim_gate - phone-class CPU evidence present")
        return 0

    print(
        "STATUS: BLOCKED cpu.phone_benchmark_claim_gate - "
        "phone-class CPU benchmark claim is not backed by required evidence"
    )
    for finding in report["findings"]:
        if finding.get("status") != "pass":
            print(f"  - {finding['name']}: {finding['status']} ({finding.get('reason')})")
    write_verb = "would write" if args.no_write else "wrote"
    print(f"  {write_verb} {rel(OUT)}")
    print(f"  {write_verb} {rel(L5_L6_OUT)}")
    return 2 if args.strict else 0


if __name__ == "__main__":
    raise SystemExit(main())
