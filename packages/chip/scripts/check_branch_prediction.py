#!/usr/bin/env python3
"""Fail-closed evidence gate for the Branch Prediction Unit.

Parses ``rtl/cpu/bpu/bpu_pkg.sv`` for the selected parameter values, checks
them against the 2028 minimum thresholds documented in
``docs/arch/branch-prediction.md``, and writes
``docs/evidence/cpu_ap/branch-prediction-params.json`` summarising the BPU
selection plus tool-versions.

Refuses to mark ``status=clean`` if any parameter regresses below the
threshold, or if the supporting RTL/manifest files are missing.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
PKG_PATH = ROOT / "rtl/cpu/bpu/bpu_pkg.sv"
TOP_PATH = ROOT / "rtl/cpu/bpu/bpu_top.sv"
CONTRACT_DOC = ROOT / "docs/arch/branch-prediction.md"
MANIFEST_PATH = ROOT / "docs/generators/xiangshan/eliza-kunminghu-manifest.json"
EVIDENCE_PATH = ROOT / "docs/evidence/cpu_ap/branch-prediction-params.json"
TARGET_2028_MPKI = 4.0
CBP5_TRACE_MANIFEST_REL = "docs/evidence/cpu_ap/cbp5-trace-manifest.json"
WORKLOAD_TRACE_MANIFEST_REL = "docs/evidence/cpu_ap/bpu-workload-trace-manifest.json"
FULL_PROXY_SHARD_SWEEP_REL = "docs/evidence/cpu_ap/bpu_sweep_full_proxy_shard.json"
FULL_IO_MEDIA_SHARD_SWEEP_REL = "docs/evidence/cpu_ap/bpu_sweep_full_io_media_shard.json"
FULL_SYSTEM_GPU_SHARD_SWEEP_REL = "docs/evidence/cpu_ap/bpu_sweep_full_system_gpu_shard.json"
FALSE_CLAIM_STALE_PHRASES = (
    "claim is supported",
    "claim remains supported",
    "claim remains unblocked",
    "claims are supported",
    "only the cbp-5 claim is supported",
)
REQUIRED_QEMU_WORKLOAD_TRACES = {
    "agent_decode",
    "agent_loop",
    "audio_frames",
    "browser_layout_proxy",
    "build_compiler_proxy",
    "compression_proxy",
    "crypto_packet_proxy",
    "database_btree_proxy",
    "file_tlv",
    "gc_runtime_proxy",
    "gpu_irq_fence_scheduler_proxy",
    "gpu_control_proxy",
    "gpu_memory_residency_proxy",
    "http_parser",
    "kernel_syscall_proxy",
    "mobile_ui_frame_scheduler_proxy",
    "nn_delegate_fallback_proxy",
    "text_log",
    "video_blocks",
    "wasm_jit_osr_proxy",
}
REQUIRED_PRODUCTION_EXTERNAL_SUITES = {
    "spec2017_intrate": {
        "required_for_claims": {"spec2017_claim", "workload_mpki_claim"},
        "missing_dependency_contains": "SPEC CPU2017",
    },
    "aosp_system_server_and_launcher": {
        "required_for_claims": {"android_claim", "workload_mpki_claim"},
        "missing_dependency_contains": "AOSP",
    },
    "browser_js_engine": {
        "required_for_claims": {"v8_claim", "workload_mpki_claim"},
        "missing_dependency_contains": "browser",
    },
    "production_gpu_driver_runtime": {
        "required_for_claims": {"workload_mpki_claim"},
        "missing_dependency_contains": "GPU",
    },
}
REQUIRED_FULL_PROXY_SHARD_TRACES = {
    "gpu_memory_residency_proxy",
    "gpu_irq_fence_scheduler_proxy",
    "nn_delegate_fallback_proxy",
    "mobile_ui_frame_scheduler_proxy",
    "wasm_jit_osr_proxy",
}
REQUIRED_FULL_IO_MEDIA_SHARD_TRACES = {
    "http_parser",
    "text_log",
    "file_tlv",
    "video_blocks",
    "audio_frames",
}
REQUIRED_FULL_SYSTEM_GPU_SHARD_TRACES = {
    "gpu_control_proxy",
    "gc_runtime_proxy",
    "kernel_syscall_proxy",
    "database_btree_proxy",
}

# The minimum thresholds the BPU geometry must satisfy to support a 2028
# phone-class application processor claim. Values come from the SOTA report
# `docs/architecture-optimization/sota-2028/branch-predictors.md`.
THRESHOLDS: dict[str, int] = {
    "FETCH_BLOCK_BYTES": 32,
    "MAX_BR_PER_BLOCK": 2,
    "FTQ_ENTRIES": 32,
    "UFTB_ENTRIES": 256,
    "UFTB_STEER_CONF_MIN": 2,
    "FTB_ENTRIES": 2048,
    "FTB_WAYS": 4,
    "L2_FTB_ENTRIES": 4096,
    "L2_FTB_WAYS": 8,
    "TAGE_TABLES": 4,
    "TAGE_ENTRIES_TABLE": 4096,
    "BIM_ENTRIES": 8192,
    "SC_TABLES": 4,
    "SC_ENTRIES_TABLE": 512,
    "LOOP_ENTRIES": 32,
    "LOOP_PATH_SIG_W": 8,
    "ITTAGE_TABLES": 5,
    "RAS_ARCH_ENTRIES": 16,
    "RAS_SPEC_ENTRIES": 32,
    "SC_LOCAL_HISTORY_BITS": 8,
    "SC_LOCAL_HISTORY_ENTRIES": 1024,
    "ITTAGE_TARGET_HISTORY_BITS": 64,
    "ITTAGE_TARGET_HISTORY_TOKEN_BITS": 5,
    "ITTAGE_TARGET_HISTORY_SHIFT": 8,
}
TAGE_HIST_LEN_MAX_THRESHOLD = 100
ITTAGE_HIST_LEN_MAX_THRESHOLD = 80

# Names whose values are parsed from `bpu_pkg.sv` localparams. `THRESHOLDS`
# entries are fail-closed minimums; the extra names are performance-relevant
# tuning knobs that must be visible in evidence even when they are not floor
# checks.
EVIDENCE_SCALARS = {
    "BIM_CTR_W",
    "BPU_CONTEXT_HASH_W",
    "BPU_WORKLOAD_CLASS_W",
    "FTB_TARGET_CONF_W",
    "H2P_ENABLE",
    "H2P_ENTRIES",
    "H2P_HIST_LEN",
    "H2P_LOWCONF_ONLY",
    "H2P_META_CTR_W",
    "H2P_META_ENABLE",
    "H2P_META_ENTRIES",
    "H2P_META_THRESHOLD",
    "H2P_PATH_HIST_LEN",
    "H2P_SCORE_W",
    "H2P_TARGET_HIST_LEN",
    "H2P_THRESHOLD",
    "H2P_WEIGHT_W",
    "L2_FTB_TAG_W",
    "LOCAL_DIR_ENABLE",
    "LOCAL_DIR_ENTRIES",
    "LOCAL_DIR_HIST_W",
    "LOCAL_DIR_META_CTR_W",
    "LOCAL_DIR_META_ENABLE",
    "LOCAL_DIR_META_ENTRIES",
    "LOCAL_DIR_META_THRESHOLD",
    "LOCAL_DIR_PHT_ENTRIES",
    "ITTAGE_CTR_W",
    "ITTAGE_PATH_HISTORY_BITS",
    "ITTAGE_PATH_HISTORY_SHIFT",
    "ITTAGE_PATH_HISTORY_TOKEN_BITS",
    "ITTAGE_REPLACE_MIN_PROVIDER",
    "ITTAGE_REPLACE_WEAK_CTR",
    "ITTAGE_TAG_W",
    "ITTAGE_TARGET_HISTORY_BITS",
    "ITTAGE_TARGET_HISTORY_SHIFT",
    "ITTAGE_TARGET_HISTORY_TOKEN_BITS",
    "ITTAGE_USEFUL_RESET_PERIOD",
    "ITTAGE_USEFUL_W",
    "LOOP_CONF_W",
    "LOOP_CTR_W",
    "LOOP_IMLI_ENABLE",
    "LOOP_IMLI_HIST_W",
    "LOOP_IMLI_TOKEN_W",
    "LOOP_PATH_SIG_W",
    "SC_ADAPTIVE",
    "SC_BIAS_CTR_W",
    "SC_BIAS_ENABLE",
    "SC_BIAS_ENTRIES",
    "SC_CTR_W",
    "SC_TC_LIMIT",
    "SC_LOCAL_HISTORY_BITS",
    "SC_LOCAL_HISTORY_ENTRIES",
    "SC_THRESH_INIT",
    "SC_THRESH_MAX",
    "SC_THRESH_MIN",
    "TAGE_CTR_W",
    "TAGE_ALT_ON_NA_CTR_W",
    "TAGE_ALT_ON_NA_ENTRIES",
    "TAGE_ALT_ON_NA_THRESHOLD",
    "TAGE_USE_ALT_ON_NA",
    "TAGE_TAG_W",
    "TAGE_USEFUL_RESET_PERIOD",
    "TAGE_USEFUL_W",
    "UFTB_STEER_CONF_MIN",
    "UFTB_WAYS",
}
SCALAR_NAMES = sorted(set(THRESHOLDS) | EVIDENCE_SCALARS)


def parse_int_literal(token: str) -> int:
    token = token.strip().rstrip(";")
    if "'" in token:
        # SystemVerilog sized literal: 32'd64 / 16'hABCD
        _width, _, magnitude = token.partition("'")
        base = magnitude[0].lower()
        digits = magnitude[1:]
        radix = {"d": 10, "h": 16, "b": 2, "o": 8}[base]
        return int(digits, radix)
    return int(token, 0)


def parse_package(text: str) -> dict[str, int | list[int]]:
    values: dict[str, int | list[int]] = {}
    scalar_re = re.compile(
        r"localparam\s+int\s+unsigned\s+(?P<name>[A-Z_][A-Z0-9_]*)\s*=\s*(?P<value>[^;]+);"
    )
    raw_scalars: dict[str, int] = {}
    for match in scalar_re.finditer(text):
        name = match.group("name")
        raw = match.group("value").strip()
        try:
            parsed = parse_int_literal(raw)
        except (ValueError, KeyError):
            # Derived parameters (e.g. `$clog2(...)`) are skipped — the gate
            # only checks the primary geometry knobs declared as integer
            # literals.
            continue
        raw_scalars[name] = parsed
        if name in SCALAR_NAMES:
            values[name] = parsed

    # Reconstitute per-component arrays by collecting indexed localparams
    # named NAME_0, NAME_1, .... yosys does not accept array-form localparams
    # in package context, so the package declares one entry at a time.
    for array_name, count in (
        ("TAGE_HIST_LEN", raw_scalars.get("TAGE_TABLES", 5)),
        ("SC_HIST_LEN", raw_scalars.get("SC_TABLES", 4)),
        ("ITTAGE_ENTRIES", raw_scalars.get("ITTAGE_TABLES", 5)),
        ("ITTAGE_HIST_LEN", raw_scalars.get("ITTAGE_TABLES", 5)),
    ):
        elements: list[int] = []
        for idx in range(count):
            key = f"{array_name}_{idx}"
            if key in raw_scalars:
                elements.append(raw_scalars[key])
        if len(elements) == count:
            values[array_name] = elements
    return values


def sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def detect_tool_versions() -> dict[str, str]:
    tools = {}
    search_path = os.pathsep.join(
        [
            str(ROOT / "external/oss-cad-suite/bin"),
            str(ROOT / "external/deb-tools/bin"),
            os.environ.get("PATH", ""),
        ]
    )
    env = {**os.environ, "PATH": search_path}
    for binary, args in (
        ("verilator", ["verilator", "--version"]),
        ("iverilog", ["iverilog", "-V"]),
        ("yosys", ["yosys", "-V"]),
        ("sby", ["sby", "--version"]),
    ):
        resolved = shutil.which(binary, path=search_path)
        if resolved is None:
            tools[binary] = "unavailable"
            continue
        try:
            proc = subprocess.run(
                [resolved, *args[1:]],
                check=False,
                capture_output=True,
                text=True,
                env=env,
            )
            output = (proc.stdout or proc.stderr).strip().splitlines()
            tools[binary] = output[0] if output else "unavailable"
        except FileNotFoundError:
            tools[binary] = "unavailable"
    try:
        import cocotb

        tools["cocotb"] = f"cocotb {cocotb.__version__}"
    except ImportError:
        tools["cocotb"] = "unavailable"
    return tools


def git_revision() -> str:
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        return proc.stdout.strip() or "unknown"
    except FileNotFoundError:
        return "unknown"


def bpu_verification_reports() -> dict[str, Path]:
    return {
        "lint": ROOT / "build/reports/bpu/lint-status.yaml",
        "formal": ROOT / "build/reports/bpu/formal-status.yaml",
        "cocotb": ROOT / "build/reports/bpu/cocotb-aggregate.json",
    }


BPU_COCOTB_TEST_SOURCES = (
    "test_ras.py",
    "test_ftq.py",
    "test_ftb.py",
    "test_uftb.py",
    "test_loop_predictor.py",
    "test_tage.py",
    "test_ittage.py",
    "test_sc.py",
    "test_bpu_l1i_frontend.py",
    "test_bpu_top.py",
)


def cocotb_test_count(path: Path) -> int:
    module = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    total = 0
    for node in module.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for decorator in node.decorator_list:
            text = ast.unparse(decorator)
            if text == "cocotb.test" or text.startswith("cocotb.test("):
                total += 1
                break
    return total


def expected_bpu_cocotb_total() -> int:
    return sum(
        cocotb_test_count(ROOT / "verify/cocotb/bpu" / source)
        for source in BPU_COCOTB_TEST_SOURCES
    )


def cbp5_trace_manifest_path() -> Path:
    return ROOT / CBP5_TRACE_MANIFEST_REL


def read_json_object(path: Path, failures: list[str]) -> dict[str, object] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        failures.append(f"{path.relative_to(ROOT)} is not valid JSON: {exc}")
        return None
    if not isinstance(data, dict):
        failures.append(f"{path.relative_to(ROOT)} must contain a JSON object")
        return None
    return data


def parse_artifact_timestamp(
    data: dict[str, object],
    artifact: str,
    failures: list[str],
) -> datetime | None:
    raw = data.get("generated_at_utc")
    if not isinstance(raw, str):
        failures.append(f"{artifact} must record generated_at_utc")
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        failures.append(f"{artifact} generated_at_utc is not ISO-8601: {raw!r}")
        return None
    if parsed.tzinfo is None:
        failures.append(f"{artifact} generated_at_utc must include a timezone")
        return None
    return parsed.astimezone(UTC)


def claim_policy(data: dict[str, object], artifact: str, failures: list[str]) -> dict[str, object]:
    policy = data.get("claim_policy")
    if not isinstance(policy, dict):
        failures.append(f"{artifact} must contain claim_policy")
        return {}
    return policy


def validate_bpu_claim_boundary(
    data: dict[str, object],
    artifact: str,
    expected_evidence_class: str,
    failures: list[str],
) -> None:
    boundary = data.get("claim_boundary")
    if not isinstance(boundary, str) or not boundary.strip():
        failures.append(f"{artifact} must include a non-empty top-level claim_boundary")
    elif expected_evidence_class not in boundary:
        failures.append(f"{artifact} claim_boundary must name {expected_evidence_class}")
    for key in ("phone_claim_allowed", "release_claim_allowed"):
        if data.get(key) is not False:
            failures.append(f"{artifact} {key} must be exactly false")


def validate_cbp5_trace_manifest(failures: list[str]) -> None:
    path = cbp5_trace_manifest_path()
    if not path.is_file():
        failures.append(f"missing CBP-5 trace provenance manifest: {path.relative_to(ROOT)}")
        return
    data = read_json_object(path, failures)
    if data is None:
        return
    artifact = str(path.relative_to(ROOT))
    if data.get("schema") != "eliza.cbp5_trace_manifest.v1":
        failures.append(f"{artifact} schema must be eliza.cbp5_trace_manifest.v1")
    if data.get("evidence_class") != "cbp5_train_traces_only":
        failures.append(f"{artifact} evidence_class must be cbp5_train_traces_only")
    stage_dir_value = data.get("stage_dir")
    if stage_dir_value != "external/cbp5-traces":
        failures.append(f"{artifact} stage_dir must be external/cbp5-traces")
        stage_dir = ROOT / "external/cbp5-traces"
    else:
        stage_dir = ROOT / stage_dir_value
    staged = data.get("staged_traces")
    if not isinstance(staged, list) or not staged:
        failures.append(f"{artifact} staged_traces must be a non-empty list")
        return
    seen: set[str] = set()
    for index, trace in enumerate(staged):
        prefix = f"{artifact}.staged_traces[{index}]"
        if not isinstance(trace, dict):
            failures.append(f"{prefix} must be an object")
            continue
        filename = trace.get("filename")
        if not isinstance(filename, str) or not filename.endswith(".gz") or "/" in filename:
            failures.append(f"{prefix}.filename must be a staged .gz basename")
            continue
        if filename in seen:
            failures.append(f"{prefix}.filename duplicates {filename}")
        seen.add(filename)
        trace_path = stage_dir / filename
        if not trace_path.is_file():
            failures.append(f"{prefix} missing staged trace: {trace_path.relative_to(ROOT)}")
            continue
        if trace.get("compressed_bytes") != trace_path.stat().st_size:
            failures.append(f"{prefix}.compressed_bytes does not match staged trace")
        expected_sha = trace.get("compressed_sha256")
        if not isinstance(expected_sha, str) or len(expected_sha) != 64:
            failures.append(f"{prefix}.compressed_sha256 must be a SHA-256 hex digest")
        elif sha256_path(trace_path) != expected_sha:
            failures.append(f"{prefix}.compressed_sha256 does not match staged trace")
        for field in ("uncompressed_instructions", "branches"):
            if not isinstance(trace.get(field), int) or trace[field] <= 0:
                failures.append(f"{prefix}.{field} must be a positive integer")
        if trace.get("workload_class") not in {"int", "fp", "media", "infra", "compress", "web"}:
            failures.append(f"{prefix}.workload_class is invalid")


def validate_workload_trace_manifest(
    failures: list[str],
    expected_workloads: dict[str, object] | None = None,
) -> None:
    path = ROOT / WORKLOAD_TRACE_MANIFEST_REL
    if not path.is_file():
        failures.append(f"missing workload trace provenance manifest: {path.relative_to(ROOT)}")
        return
    data = read_json_object(path, failures)
    if data is None:
        return
    artifact = str(path.relative_to(ROOT))
    if data.get("schema") != "eliza.bpu_workload_trace_manifest.v1":
        failures.append(f"{artifact} schema must be eliza.bpu_workload_trace_manifest.v1")
    parse_artifact_timestamp(data, artifact, failures)
    if data.get("trace_dir") != "external/workload-traces":
        failures.append(f"{artifact} trace_dir must be external/workload-traces")
        trace_dir = ROOT / "external/workload-traces"
    else:
        trace_dir = ROOT / str(data["trace_dir"])
    if data.get("evidence_class") != "qemu_rv64_workload_trace_manifest":
        failures.append(f"{artifact} evidence_class must be qemu_rv64_workload_trace_manifest")
    if data.get("phone_claim_allowed") is not False:
        failures.append(f"{artifact} phone_claim_allowed must be exactly false")
    if data.get("release_claim_allowed") is not False:
        failures.append(f"{artifact} release_claim_allowed must be exactly false")
    missing = data.get("missing_required_local_trace_names")
    if missing != []:
        failures.append(f"{artifact} missing_required_local_trace_names must be empty")
    required = set(data.get("required_local_trace_names", []))
    if required != REQUIRED_QEMU_WORKLOAD_TRACES:
        failures.append(f"{artifact} required_local_trace_names does not match gate list")

    suites = data.get("production_external_suites")
    if not isinstance(suites, list) or not suites:
        failures.append(f"{artifact} production_external_suites must be a non-empty list")
    else:
        seen_suites: set[str] = set()
        for index, suite in enumerate(suites):
            prefix = f"{artifact}.production_external_suites[{index}]"
            if not isinstance(suite, dict):
                failures.append(f"{prefix} must be an object")
                continue
            name = suite.get("name")
            if not isinstance(name, str) or not name:
                failures.append(f"{prefix}.name must be a non-empty string")
                continue
            if name in seen_suites:
                failures.append(f"{prefix}.name duplicates external suite {name}")
            seen_suites.add(name)
            expected = REQUIRED_PRODUCTION_EXTERNAL_SUITES.get(name)
            if expected is None:
                failures.append(f"{prefix}.name is not in the required external suite list")
                continue
            if suite.get("status") != "missing_external_trace":
                failures.append(f"{prefix}.status must be missing_external_trace")
            claims = suite.get("required_for_claims")
            if not isinstance(claims, list) or not claims:
                failures.append(f"{prefix}.required_for_claims must be a non-empty list")
            elif set(claims) != expected["required_for_claims"]:
                failures.append(f"{prefix}.required_for_claims does not match required claims")
            missing_dependency = suite.get("missing_dependency")
            if not isinstance(missing_dependency, str) or not missing_dependency.strip():
                failures.append(f"{prefix}.missing_dependency must be a non-empty string")
            elif str(expected["missing_dependency_contains"]) not in missing_dependency:
                failures.append(
                    f"{prefix}.missing_dependency must describe {expected['missing_dependency_contains']}"
                )
        missing_suites = sorted(set(REQUIRED_PRODUCTION_EXTERNAL_SUITES) - seen_suites)
        extra_suites = sorted(seen_suites - set(REQUIRED_PRODUCTION_EXTERNAL_SUITES))
        if missing_suites:
            failures.append(
                f"{artifact} production_external_suites missing required suites: {missing_suites}"
            )
        if extra_suites:
            failures.append(
                f"{artifact} production_external_suites has unexpected suites: {extra_suites}"
            )

    traces = data.get("traces")
    if not isinstance(traces, list) or not traces:
        failures.append(f"{artifact} traces must be a non-empty list")
        return
    seen: set[str] = set()
    for index, trace in enumerate(traces):
        prefix = f"{artifact}.traces[{index}]"
        if not isinstance(trace, dict):
            failures.append(f"{prefix} must be an object")
            continue
        name = trace.get("name")
        filename = trace.get("filename")
        if not isinstance(name, str) or not name:
            failures.append(f"{prefix}.name must be a non-empty string")
            continue
        if name in seen:
            failures.append(f"{prefix}.name duplicates {name}")
        seen.add(name)
        if not isinstance(filename, str) or filename != f"{name}.btrace.json":
            failures.append(f"{prefix}.filename must be {name}.btrace.json")
            continue
        trace_path = trace_dir / filename
        if not trace_path.is_file():
            failures.append(f"{prefix} missing trace file: {trace_path.relative_to(ROOT)}")
            continue
        if trace.get("bytes") != trace_path.stat().st_size:
            failures.append(f"{prefix}.bytes does not match staged trace")
        expected_sha = trace.get("sha256")
        if not isinstance(expected_sha, str) or len(expected_sha) != 64:
            failures.append(f"{prefix}.sha256 must be a SHA-256 hex digest")
        elif sha256_path(trace_path) != expected_sha:
            failures.append(f"{prefix}.sha256 does not match staged trace")
        for field in ("instruction_count", "branch_count"):
            if not isinstance(trace.get(field), int) or trace[field] <= 0:
                failures.append(f"{prefix}.{field} must be a positive integer")
        if trace.get("trace_class") != "qemu_rv64_workload":
            failures.append(f"{prefix}.trace_class must be qemu_rv64_workload")
        buckets = trace.get("coverage_buckets")
        if not isinstance(buckets, list) or not buckets:
            failures.append(f"{prefix}.coverage_buckets must be a non-empty list")
    missing_trace_names = sorted(REQUIRED_QEMU_WORKLOAD_TRACES - seen)
    if missing_trace_names:
        failures.append(f"{artifact} missing required traces: " + ", ".join(missing_trace_names))
    if expected_workloads is not None:
        expected_workload_names = set(expected_workloads)
        missing_from_manifest = sorted(expected_workload_names - seen)
        extra_in_manifest = sorted(seen - expected_workload_names)
        if missing_from_manifest:
            failures.append(
                f"{artifact} missing workloads from mpki_results_workload_rtl.json: "
                + ", ".join(missing_from_manifest)
            )
        if extra_in_manifest:
            failures.append(
                f"{artifact} has traces absent from mpki_results_workload_rtl.json: "
                + ", ".join(extra_in_manifest)
            )
        for trace in traces:
            if not isinstance(trace, dict):
                continue
            name = trace.get("name")
            if not isinstance(name, str) or name not in expected_workloads:
                continue
            workload = expected_workloads[name]
            if not isinstance(workload, dict):
                failures.append(f"mpki_results_workload_rtl.json workload {name} must be an object")
                continue
            manifest_inst = trace.get("instruction_count")
            replay_inst = workload.get("source_instruction_count")
            if replay_inst != manifest_inst:
                failures.append(
                    f"mpki_results_workload_rtl.json workload {name} "
                    f"source_instruction_count {replay_inst!r} does not match "
                    f"{artifact} instruction_count {manifest_inst!r}"
                )
            manifest_branches = trace.get("branch_count")
            replay_branches = workload.get("source_branch_count")
            if replay_branches != manifest_branches:
                failures.append(
                    f"mpki_results_workload_rtl.json workload {name} "
                    f"source_branch_count {replay_branches!r} does not match "
                    f"{artifact} branch_count {manifest_branches!r}"
                )


def numeric_aggregate_mpki(
    data: dict[str, object],
    artifact: str,
    failures: list[str],
) -> float | None:
    aggregate = data.get("aggregate")
    if not isinstance(aggregate, dict):
        failures.append(f"{artifact} must contain aggregate")
        return None
    mpki = aggregate.get("mpki")
    if not isinstance(mpki, (int, float)):
        failures.append(f"{artifact} aggregate.mpki must be numeric")
        return None
    return float(mpki)


def numeric_target_2028_mpki(
    data: dict[str, object],
    artifact: str,
    failures: list[str],
) -> float | None:
    target = data.get("target_2028_mpki")
    if not isinstance(target, (int, float)):
        failures.append(f"{artifact} target_2028_mpki must be numeric")
        return None
    if float(target) != TARGET_2028_MPKI:
        failures.append(f"{artifact} target_2028_mpki must equal {TARGET_2028_MPKI}")
        return None
    return float(target)


def reject_stale_false_claim_reason(
    policy: dict[str, object],
    keys: tuple[str, ...],
    artifact: str,
    failures: list[str],
) -> None:
    reason = policy.get("reason")
    if not isinstance(reason, str):
        failures.append(f"{artifact} claim_policy.reason must explain blocked claims")
        return
    lowered = reason.lower()
    false_keys = [key for key in keys if policy.get(key) is False]
    if false_keys and any(phrase in lowered for phrase in FALSE_CLAIM_STALE_PHRASES):
        failures.append(
            f"{artifact} claim_policy.reason contains stale supported-claim wording "
            f"while {', '.join(false_keys)} are false"
        )


def evaluate_target_claim_semantics(
    data: dict[str, object],
    artifact: str,
    policy: dict[str, object],
    claim_key: str,
    failures: list[str],
) -> tuple[float | None, float | None, bool | None]:
    mpki = numeric_aggregate_mpki(data, artifact, failures)
    target = numeric_target_2028_mpki(data, artifact, failures)
    target_met = None
    if mpki is not None and target is not None:
        target_met = mpki <= target
        claim_value = policy.get(claim_key)
        if claim_value is True and not target_met:
            failures.append(
                f"{artifact} {claim_key} is true but aggregate MPKI {mpki} exceeds target {target}"
            )
        if claim_value is False and target_met:
            failures.append(
                f"{artifact} {claim_key} is false but aggregate MPKI {mpki} meets target {target}; "
                "refresh target-met semantics or assert the claim explicitly"
            )
    return mpki, target, target_met


REQUIRED_ITTAGE_SWEEP_COUNTERS = {
    "ittage_hit",
    "ittage_target_used",
    "ittage_weak_yield_to_ftb",
    "ittage_updates",
    "ittage_allocations",
    "ittage_weak_target_replacements",
    "ittage_victim_replacements",
    "ittage_provider_evictions",
    "ittage_useful_aging",
}

REQUIRED_TIMING_SWEEP_COUNTERS = {
    "sc_deferred_by_timing_model",
    "h2p_deferred_by_timing_model",
    "local_dir_deferred_by_timing_model",
    "ittage_deferred_by_timing_model",
    "l2_ftb_deferred_by_timing_model",
    "l2_ftb_late_redirect",
}


def validate_sweep_evidence(
    data: dict[str, object],
    artifact: str,
    failures: list[str],
) -> None:
    if data.get("schema") != "eliza.bpu_sweep.v1":
        failures.append(f"{artifact} schema must be eliza.bpu_sweep.v1")
    parse_artifact_timestamp(data, artifact, failures)
    if data.get("harness") != "behavioural-bpu-model":
        failures.append(f"{artifact} harness must be behavioural-bpu-model")
    declared = set(data.get("ittage_evidence_counters", []))
    missing_declared = REQUIRED_ITTAGE_SWEEP_COUNTERS - declared
    if missing_declared:
        failures.append(
            f"{artifact} missing ITTAGE evidence counter declarations: "
            + ", ".join(sorted(missing_declared))
        )
    timing_declared = set(data.get("timing_evidence_counters", []))
    missing_timing_declared = REQUIRED_TIMING_SWEEP_COUNTERS - timing_declared
    if missing_timing_declared:
        failures.append(
            f"{artifact} missing timing evidence counter declarations: "
            + ", ".join(sorted(missing_timing_declared))
        )
    results = data.get("results")
    if not isinstance(results, dict) or "baseline" not in results:
        failures.append(f"{artifact} must include baseline sweep results")
        return
    for config_name, config in results.items():
        if not isinstance(config, dict):
            failures.append(f"{artifact} config {config_name} must be an object")
            continue
        totals = config.get("ittage_counter_totals")
        if not isinstance(totals, dict):
            failures.append(f"{artifact} config {config_name} missing ittage_counter_totals")
            continue
        missing_totals = REQUIRED_ITTAGE_SWEEP_COUNTERS - set(totals)
        if missing_totals:
            failures.append(
                f"{artifact} config {config_name} missing ITTAGE counter totals: "
                + ", ".join(sorted(missing_totals))
            )
        timing_totals = config.get("timing_counter_totals")
        if not isinstance(timing_totals, dict):
            failures.append(f"{artifact} config {config_name} missing timing_counter_totals")
        else:
            missing_timing_totals = REQUIRED_TIMING_SWEEP_COUNTERS - set(timing_totals)
            if missing_timing_totals:
                failures.append(
                    f"{artifact} config {config_name} missing timing counter totals: "
                    + ", ".join(sorted(missing_timing_totals))
                )
        per_trace = config.get("per_trace")
        if not isinstance(per_trace, dict):
            failures.append(f"{artifact} config {config_name} missing per_trace results")
            continue
        for trace_name, row in per_trace.items():
            if not isinstance(row, dict):
                failures.append(f"{artifact} {config_name}/{trace_name} must be an object")
                continue
            counters = row.get("ittage_counters")
            if not isinstance(counters, dict):
                failures.append(f"{artifact} {config_name}/{trace_name} missing ittage_counters")
                continue
            missing = REQUIRED_ITTAGE_SWEEP_COUNTERS - set(counters)
            if missing:
                failures.append(
                    f"{artifact} {config_name}/{trace_name} missing ITTAGE counters: "
                    + ", ".join(sorted(missing))
                )
            timing_counters = row.get("timing_counters")
            if not isinstance(timing_counters, dict):
                failures.append(f"{artifact} {config_name}/{trace_name} missing timing_counters")
                continue
            missing_timing = REQUIRED_TIMING_SWEEP_COUNTERS - set(timing_counters)
            if missing_timing:
                failures.append(
                    f"{artifact} {config_name}/{trace_name} missing timing counters: "
                    + ", ".join(sorted(missing_timing))
                )


def validate_full_trace_shard_sweep(
    failures: list[str],
    relpath: str,
    required_traces: set[str],
    *,
    require_baseline_not_worse_than_h2p_off: bool = True,
    required_extra_configs: set[str] | None = None,
    required_best_not_worse_than: tuple[str, ...] = (),
) -> None:
    path = ROOT / relpath
    artifact = relpath
    if not path.is_file():
        failures.append(f"missing full-trace shard sweep: {artifact}")
        return
    data = read_json_object(path, failures)
    if data is None:
        return
    validate_sweep_evidence(data, artifact, failures)
    if data.get("max_branches_per_trace") != 0:
        failures.append(f"{artifact} max_branches_per_trace must be 0 for full-trace shard")
    if data.get("window_mode") != "prefix":
        failures.append(f"{artifact} window_mode must be prefix for full-trace shard")
    trace_filter = data.get("trace_filter")
    if set(trace_filter or []) != required_traces:
        failures.append(f"{artifact} trace_filter must match required full shard")
    trace_set = data.get("trace_set")
    if not isinstance(trace_set, list) or not trace_set:
        failures.append(f"{artifact} trace_set must be a non-empty list")
    else:
        names = {row.get("name") for row in trace_set if isinstance(row, dict)}
        if names != required_traces:
            failures.append(f"{artifact} trace_set names must match required full shard")
        for row in trace_set:
            if not isinstance(row, dict):
                failures.append(f"{artifact} trace_set rows must be objects")
                continue
            if not isinstance(row.get("branches"), int) or row["branches"] <= 0:
                failures.append(f"{artifact} trace_set row {row.get('name')} branches must be positive")
            if not isinstance(row.get("instructions"), int) or row["instructions"] <= 0:
                failures.append(
                    f"{artifact} trace_set row {row.get('name')} instructions must be positive"
                )
    results = data.get("results")
    if isinstance(results, dict):
        required_configs = {"baseline", "h2p_off"}
        if required_extra_configs is not None:
            required_configs |= required_extra_configs
        if not required_configs.issubset(results):
            failures.append(f"{artifact} must include configs: {sorted(required_configs)}")
        baseline = results.get("baseline")
        h2p_off = results.get("h2p_off")
        if isinstance(baseline, dict) and isinstance(h2p_off, dict):
            base_mpki = baseline.get("weighted_mpki")
            off_mpki = h2p_off.get("weighted_mpki")
            if isinstance(base_mpki, (int, float)) and isinstance(off_mpki, (int, float)):
                if (
                    require_baseline_not_worse_than_h2p_off
                    and float(base_mpki) > float(off_mpki)
                ):
                    failures.append(f"{artifact} baseline must not regress versus h2p_off")
        for config in required_best_not_worse_than:
            best_name = data.get("best_config")
            best = results.get(best_name) if isinstance(best_name, str) else None
            other = results.get(config)
            if not isinstance(best, dict) or not isinstance(other, dict):
                failures.append(f"{artifact} best_config must be comparable against {config}")
                continue
            best_mpki = best.get("weighted_mpki")
            other_mpki = other.get("weighted_mpki")
            if isinstance(best_mpki, (int, float)) and isinstance(other_mpki, (int, float)):
                if float(best_mpki) > float(other_mpki):
                    failures.append(f"{artifact} best_config must not regress versus {config}")


def validate_workload_class_bucket_promotion(
    data: dict[str, object],
    artifact: str,
    positive_claims: list[str],
    failures: list[str],
) -> None:
    """Require explicit per-class no-regression evidence before promotion.

    A workload aggregate can hide a predictor knob that improves the average by
    overfitting one class while regressing GPU/control or general CPU phases.
    Positive workload claims therefore need a dedicated class-bucket promotion
    block, independent of the top-level MPKI aggregate.
    """
    if not positive_claims:
        return
    gate = data.get("class_bucket_promotion")
    if not isinstance(gate, dict):
        failures.append(
            f"{artifact} positive workload claims require class_bucket_promotion "
            "with per-class no-regression evidence"
        )
        return
    if gate.get("status") != "PASS":
        failures.append(f"{artifact} class_bucket_promotion.status must be PASS")
    buckets = gate.get("buckets")
    if not isinstance(buckets, list) or not buckets:
        failures.append(f"{artifact} class_bucket_promotion.buckets must be a non-empty list")
        return
    seen: set[str] = set()
    for index, bucket in enumerate(buckets):
        prefix = f"{artifact}.class_bucket_promotion.buckets[{index}]"
        if not isinstance(bucket, dict):
            failures.append(f"{prefix} must be an object")
            continue
        name = bucket.get("name")
        if not isinstance(name, str) or not name:
            failures.append(f"{prefix}.name must be non-empty")
        else:
            seen.add(name)
        for field in ("baseline_mpki", "candidate_mpki", "delta_mpki"):
            if not isinstance(bucket.get(field), (int, float)):
                failures.append(f"{prefix}.{field} must be numeric")
        delta = bucket.get("delta_mpki")
        if isinstance(delta, (int, float)) and float(delta) > 0.0:
            failures.append(f"{prefix}.delta_mpki regresses by {float(delta):.6f}")
    required = {"general", "gpu_control"}
    missing = sorted(required - seen)
    if missing:
        failures.append(
            f"{artifact} class_bucket_promotion missing required buckets: "
            + ", ".join(missing)
        )


def validate_workload_replay_coverage(
    data: dict[str, object],
    artifact: str,
    failures: list[str],
) -> None:
    workloads = data.get("workloads")
    if not isinstance(workloads, dict) or not workloads:
        failures.append(f"{artifact} workloads must be a non-empty object")
        return

    source_branch_total = 0
    replayed_branch_total = 0
    source_inst_total = 0
    replayed_inst_total = 0
    all_full = True
    for name, workload in workloads.items():
        prefix = f"{artifact}.workloads[{name}]"
        if not isinstance(workload, dict):
            failures.append(f"{prefix} must be an object")
            continue
        source_branches = workload.get("source_branch_count")
        replayed_branches = workload.get("branch_count")
        source_inst = workload.get("source_instruction_count")
        replayed_inst = workload.get("instruction_count")
        replay_fraction = workload.get("replay_fraction")
        instruction_replay_fraction = workload.get("instruction_replay_fraction")
        full_trace_replay = workload.get("full_trace_replay")
        if not isinstance(source_branches, int) or source_branches <= 0:
            failures.append(f"{prefix}.source_branch_count must be a positive integer")
            continue
        if not isinstance(replayed_branches, int) or replayed_branches <= 0:
            failures.append(f"{prefix}.branch_count must be a positive integer")
            continue
        if replayed_branches > source_branches:
            failures.append(f"{prefix}.branch_count cannot exceed source_branch_count")
        expected_fraction = round(replayed_branches / source_branches, 6)
        if replay_fraction != expected_fraction:
            failures.append(
                f"{prefix}.replay_fraction {replay_fraction!r} does not match "
                f"branch_count/source_branch_count {expected_fraction!r}"
            )
        if not isinstance(source_inst, int) or source_inst <= 0:
            failures.append(f"{prefix}.source_instruction_count must be a positive integer")
            continue
        if not isinstance(replayed_inst, int) or replayed_inst <= 0:
            failures.append(f"{prefix}.instruction_count must be a positive integer")
            continue
        expected_inst_fraction = round(replayed_inst / source_inst, 6)
        if instruction_replay_fraction != expected_inst_fraction:
            failures.append(
                f"{prefix}.instruction_replay_fraction {instruction_replay_fraction!r} "
                f"does not match instruction_count/source_instruction_count "
                f"{expected_inst_fraction!r}"
            )
        expected_full = replayed_branches == source_branches
        if full_trace_replay is not expected_full:
            failures.append(f"{prefix}.full_trace_replay must be {expected_full}")
        all_full = all_full and expected_full
        source_branch_total += source_branches
        replayed_branch_total += replayed_branches
        source_inst_total += source_inst
        replayed_inst_total += replayed_inst

    expected_top = {
        "source_branch_count": source_branch_total,
        "replayed_branch_count": replayed_branch_total,
        "source_instruction_count": source_inst_total,
        "replayed_instruction_count": replayed_inst_total,
        "replay_fraction": round(replayed_branch_total / source_branch_total, 6)
        if source_branch_total
        else 0.0,
        "instruction_replay_fraction": round(replayed_inst_total / source_inst_total, 6)
        if source_inst_total
        else 0.0,
        "full_trace_replay": all_full,
    }
    for key, expected in expected_top.items():
        if data.get(key) != expected:
            failures.append(f"{artifact} {key} must be {expected!r}")
    if data.get("branch_replay_cap") is None and data.get("full_trace_replay") is not True:
        failures.append(f"{artifact} branch_replay_cap null requires full_trace_replay true")


def artifact_metric_ref(path: Path, data: dict[str, object] | None) -> dict[str, object]:
    ref: dict[str, object] = {"path": str(path.relative_to(ROOT)), "present": path.is_file()}
    if path.is_file():
        ref["sha256"] = sha256_path(path)
    if data is None:
        return ref
    generated = data.get("generated_at_utc")
    if isinstance(generated, str):
        ref["generated_at_utc"] = generated
    aggregate = data.get("aggregate")
    if isinstance(aggregate, dict) and isinstance(aggregate.get("mpki"), (int, float)):
        ref["aggregate_mpki"] = aggregate["mpki"]
    target = data.get("target_2028_mpki")
    if isinstance(target, (int, float)):
        ref["target_2028_mpki"] = target
        aggregate_mpki = ref.get("aggregate_mpki")
        if isinstance(aggregate_mpki, (int, float)):
            ref["target_met"] = float(aggregate_mpki) <= float(target)
    for key in (
        "branch_replay_cap",
        "branch_replay_window_mode",
        "source_branch_count",
        "replayed_branch_count",
        "replay_fraction",
        "source_instruction_count",
        "replayed_instruction_count",
        "instruction_replay_fraction",
        "full_trace_replay",
    ):
        if key in data:
            ref[key] = data[key]
    policy = data.get("claim_policy")
    if isinstance(policy, dict):
        for key in (
            "spec2017_claim",
            "android_claim",
            "v8_claim",
            "cbp5_claim",
            "agent_mpki_claim",
            "decode_mpki_claim",
            "workload_mpki_claim",
        ):
            if isinstance(policy.get(key), bool):
                ref[key] = policy[key]
    ref["accuracy_claim"] = False
    return ref


def load_json_object_if_present(path: Path) -> dict[str, object] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def full_trace_shard_sweep_ref(relpath: str, command: str) -> dict[str, object]:
    path = ROOT / relpath
    ref: dict[str, object] = {
        "path": str(path.relative_to(ROOT)),
        "schema": "eliza.bpu_sweep.v1",
        "harness": "behavioural-bpu-model",
        "command": command,
        "present": path.is_file(),
    }
    if not path.is_file():
        return ref
    shard_data = load_json_object_if_present(path)
    ref["sha256"] = sha256_path(path)
    if shard_data is not None:
        ref["max_branches_per_trace"] = shard_data.get("max_branches_per_trace")
        ref["trace_filter"] = shard_data.get("trace_filter")
        ref["best_config"] = shard_data.get("best_config")
        ref["best_weighted_mpki"] = shard_data.get("best_weighted_mpki")
        ref["baseline_weighted_mpki"] = shard_data.get("baseline_weighted_mpki")
    return ref


def evaluate(values: dict[str, int | list[int]]) -> tuple[str, list[str]]:
    failures: list[str] = []
    for name, threshold in THRESHOLDS.items():
        if name not in values:
            failures.append(f"missing parameter {name} in {PKG_PATH.name}")
            continue
        actual = values[name]
        if isinstance(actual, int) and actual < threshold:
            failures.append(f"{name}={actual} below 2028 minimum threshold {threshold}")
    tage_hist = values.get("TAGE_HIST_LEN")
    if not isinstance(tage_hist, list) or len(tage_hist) < 4:
        failures.append("TAGE_HIST_LEN must declare >=4 per-table histories")
    elif max(tage_hist) < TAGE_HIST_LEN_MAX_THRESHOLD:
        failures.append(
            f"max TAGE history {max(tage_hist)} below minimum reach {TAGE_HIST_LEN_MAX_THRESHOLD}"
        )
    ittage_hist = values.get("ITTAGE_HIST_LEN")
    if not isinstance(ittage_hist, list) or len(ittage_hist) < 5:
        failures.append("ITTAGE_HIST_LEN must declare >=5 per-table histories")
    elif max(ittage_hist) < ITTAGE_HIST_LEN_MAX_THRESHOLD:
        failures.append(
            f"max ITTAGE history {max(ittage_hist)} below minimum reach "
            f"{ITTAGE_HIST_LEN_MAX_THRESHOLD}"
        )
    ittage_entries = values.get("ITTAGE_ENTRIES")
    if not isinstance(ittage_entries, list) or sum(ittage_entries) < 1024:
        failures.append(
            "ITTAGE_ENTRIES total must be >= 1024 entries to satisfy indirect-target storage floor"
        )
    status = "clean" if not failures else "blocked"
    return status, failures


def evaluate_evidence_artifacts() -> list[str]:
    failures: list[str] = []
    required_artifacts = (
        ROOT / "docs/evidence/cpu_ap/mpki_results_synthetic.json",
        ROOT / "docs/evidence/cpu_ap/mpki_results_cbp5.json",
        ROOT / "docs/evidence/cpu_ap/mpki_results_cbp5_rtl.json",
        ROOT / "docs/evidence/cpu_ap/mpki_results_workload_rtl.json",
        ROOT / "docs/evidence/cpu_ap/bpu_sweep_results.json",
        ROOT / WORKLOAD_TRACE_MANIFEST_REL,
        ROOT / FULL_PROXY_SHARD_SWEEP_REL,
        ROOT / FULL_IO_MEDIA_SHARD_SWEEP_REL,
        ROOT / FULL_SYSTEM_GPU_SHARD_SWEEP_REL,
    )
    for path in required_artifacts:
        if not path.is_file():
            failures.append(f"missing required BPU evidence artifact: {path.relative_to(ROOT)}")
    synthetic_claim_keys = ("spec2017_claim", "android_claim", "v8_claim", "cbp5_claim")
    workload_claim_keys = (
        "spec2017_claim",
        "android_claim",
        "v8_claim",
        "cbp5_claim",
        "agent_mpki_claim",
        "decode_mpki_claim",
        "workload_mpki_claim",
    )
    synthetic_mpki_path = ROOT / "docs/evidence/cpu_ap/mpki_results_synthetic.json"
    if synthetic_mpki_path.is_file():
        data = read_json_object(synthetic_mpki_path, failures)
        if data is not None:
            artifact = "mpki_results_synthetic.json"
            if data.get("schema") != "eliza.bpu_mpki.v1":
                failures.append(f"{artifact} schema must be eliza.bpu_mpki.v1")
            parse_artifact_timestamp(data, artifact, failures)
            validate_bpu_claim_boundary(data, artifact, "synthetic_planning_only", failures)
            policy = claim_policy(data, artifact, failures)
            reject_stale_false_claim_reason(policy, synthetic_claim_keys, artifact, failures)
            positive = [key for key in synthetic_claim_keys if policy.get(key) is True]
            if positive:
                failures.append(
                    "mpki_results_synthetic.json cannot assert release MPKI claims from "
                    "synthetic_planning_only evidence: "
                    + ", ".join(positive)
                )
    sweep_path = ROOT / "docs/evidence/cpu_ap/bpu_sweep_results.json"
    if sweep_path.is_file():
        data = read_json_object(sweep_path, failures)
        if data is not None:
            validate_sweep_evidence(data, "bpu_sweep_results.json", failures)
    validate_full_trace_shard_sweep(
        failures,
        FULL_PROXY_SHARD_SWEEP_REL,
        REQUIRED_FULL_PROXY_SHARD_TRACES,
    )
    validate_full_trace_shard_sweep(
        failures,
        FULL_IO_MEDIA_SHARD_SWEEP_REL,
        REQUIRED_FULL_IO_MEDIA_SHARD_TRACES,
        require_baseline_not_worse_than_h2p_off=False,
        required_extra_configs={"h2p_lowconf_only"},
        required_best_not_worse_than=("baseline", "h2p_off"),
    )
    validate_full_trace_shard_sweep(
        failures,
        FULL_SYSTEM_GPU_SHARD_SWEEP_REL,
        REQUIRED_FULL_SYSTEM_GPU_SHARD_TRACES,
        require_baseline_not_worse_than_h2p_off=False,
        required_extra_configs={"h2p_lowconf_only"},
        required_best_not_worse_than=("baseline", "h2p_off"),
    )
    cbp5_model_path = ROOT / "docs/evidence/cpu_ap/mpki_results_cbp5.json"
    cbp5_model_generated: datetime | None = None
    if cbp5_model_path.is_file():
        data = read_json_object(cbp5_model_path, failures)
    else:
        data = None
    if data is not None:
        artifact = "mpki_results_cbp5.json"
        if data.get("schema") != "eliza.bpu_mpki.v1":
            failures.append(f"{artifact} schema must be eliza.bpu_mpki.v1")
        cbp5_model_generated = parse_artifact_timestamp(data, artifact, failures)
        if data.get("harness") != "behavioural-bpu-model":
            failures.append(f"{artifact} harness must be behavioural-bpu-model")
        if data.get("evidence_class") != "cbp5_train_traces_only":
            failures.append("mpki_results_cbp5.json must be scoped to CBP-5 evidence")
        validate_bpu_claim_boundary(data, artifact, "cbp5_train_traces_only", failures)
        policy = claim_policy(data, artifact, failures)
        reject_stale_false_claim_reason(policy, ("cbp5_claim",), artifact, failures)
        evaluate_target_claim_semantics(data, artifact, policy, "cbp5_claim", failures)
        for name, workload in data.get("workloads", {}).items():
            if not isinstance(workload, dict):
                failures.append(f"mpki_results_cbp5.json workload {name} must be an object")
            elif workload.get("trace_class") != "cbp5_train_traces_only":
                failures.append(
                    f"mpki_results_cbp5.json workload {name} has non-CBP5 trace_class"
                )

    cbp5_rtl_path = ROOT / "docs/evidence/cpu_ap/mpki_results_cbp5_rtl.json"
    cbp5_rtl_generated: datetime | None = None
    if cbp5_rtl_path.is_file():
        data = read_json_object(cbp5_rtl_path, failures)
    else:
        data = None
    if data is not None:
        artifact = "mpki_results_cbp5_rtl.json"
        if data.get("schema") != "eliza.bpu_mpki.v1":
            failures.append(f"{artifact} schema must be eliza.bpu_mpki.v1")
        cbp5_rtl_generated = parse_artifact_timestamp(data, artifact, failures)
        if data.get("harness") != "cocotb-rtl-bpu_top":
            failures.append(f"{artifact} harness must be cocotb-rtl-bpu_top")
        if data.get("evidence_class") != "cbp5_train_traces_only":
            failures.append("mpki_results_cbp5_rtl.json must be scoped to CBP-5 evidence")
        validate_bpu_claim_boundary(data, artifact, "cbp5_train_traces_only", failures)
        policy = claim_policy(data, artifact, failures)
        reject_stale_false_claim_reason(policy, ("cbp5_claim",), artifact, failures)
        evaluate_target_claim_semantics(data, artifact, policy, "cbp5_claim", failures)

    if cbp5_model_generated is not None and cbp5_rtl_generated is not None:
        if cbp5_model_generated < cbp5_rtl_generated:
            failures.append(
                "mpki_results_cbp5.json is older than mpki_results_cbp5_rtl.json; "
                "refresh behavioural CBP-5 model evidence after the latest RTL CBP-5 run"
            )
    validate_cbp5_trace_manifest(failures)

    workload_mpki_path = ROOT / "docs/evidence/cpu_ap/mpki_results_workload_rtl.json"
    workload_trace_dir = ROOT / "external/workload-traces"
    workloads_for_manifest: dict[str, object] | None = None
    if workload_mpki_path.is_file():
        data = read_json_object(workload_mpki_path, failures)
    else:
        data = None
    if data is not None:
        artifact = "mpki_results_workload_rtl.json"
        if data.get("schema") != "eliza.bpu_mpki.v1":
            failures.append(f"{artifact} schema must be eliza.bpu_mpki.v1")
        parse_artifact_timestamp(data, artifact, failures)
        if data.get("harness") != "cocotb-rtl-bpu_top":
            failures.append(f"{artifact} harness must be cocotb-rtl-bpu_top")
        if data.get("evidence_class") != "qemu_rv64_workload":
            failures.append(f"{artifact} evidence_class must be qemu_rv64_workload")
        validate_bpu_claim_boundary(data, artifact, "qemu_rv64_workload", failures)
        validate_workload_replay_coverage(data, artifact, failures)
        workloads = data.get("workloads", {})
        if isinstance(workloads, dict):
            workloads_for_manifest = workloads
        if workload_trace_dir.is_dir():
            expected = {
                path.name[: -len(".btrace.json")]
                for path in workload_trace_dir.glob("*.btrace.json")
            }
            missing = sorted(expected - set(workloads))
            if missing:
                failures.append(
                    "mpki_results_workload_rtl.json missing workload traces: "
                    + ", ".join(missing)
                )
        for name, workload in workloads.items():
            if workload.get("trace_class") != "qemu_rv64_workload":
                failures.append(
                    f"mpki_results_workload_rtl.json workload {name} has non-QEMU trace_class"
                )
        policy = claim_policy(data, artifact, failures)
        reject_stale_false_claim_reason(policy, workload_claim_keys, artifact, failures)
        positive = [key for key in workload_claim_keys if policy.get(key) is True]
        validate_workload_class_bucket_promotion(data, artifact, positive, failures)
        if positive:
            failures.append(
                "mpki_results_workload_rtl.json cannot assert workload/SPEC/AOSP/JS MPKI "
                "claims until full external trace evidence and class-bucket promotion "
                "gates are present: "
                + ", ".join(positive)
            )
        full_trace_claims = [
            key
            for key in ("agent_mpki_claim", "decode_mpki_claim", "workload_mpki_claim")
            if policy.get(key) is True
        ]
        if data.get("branch_replay_cap") is not None and full_trace_claims:
            failures.append(
                "mpki_results_workload_rtl.json cannot assert full-trace workload MPKI claims "
                "while branch_replay_cap is non-null"
            )
    validate_workload_trace_manifest(failures, workloads_for_manifest)
    failures.extend(evaluate_verification_reports())
    return failures


def evaluate_verification_reports() -> list[str]:
    failures: list[str] = []
    reports = bpu_verification_reports()
    lint_path = reports["lint"]
    formal_path = reports["formal"]
    cocotb_path = reports["cocotb"]

    if not lint_path.is_file():
        failures.append(f"missing BPU lint report: {lint_path.relative_to(ROOT)}")
    else:
        data = yaml.safe_load(lint_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            failures.append("BPU lint report must be a YAML mapping")
        else:
            if data.get("schema") != "eliza.bpu_lint_status.v1":
                failures.append("BPU lint report schema drifted")
            if data.get("status") != "PASS":
                failures.append("BPU lint report status must be PASS")
            log = data.get("log")
            if not isinstance(log, str) or not (ROOT / log).is_file():
                failures.append("BPU lint report must reference an archived lint log")

    if not formal_path.is_file():
        failures.append(f"missing BPU formal report: {formal_path.relative_to(ROOT)}")
    else:
        data = yaml.safe_load(formal_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            failures.append("BPU formal report must be a YAML mapping")
        else:
            if data.get("schema") != "eliza.bpu_formal_status.v1":
                failures.append("BPU formal report schema drifted")
            if data.get("status") != "PASS":
                failures.append("BPU formal report status must be PASS")
            properties = data.get("properties")
            if not isinstance(properties, list) or not properties:
                failures.append("BPU formal report must list proved properties")
            elif any(
                not isinstance(item, dict) or not str(item.get("status", "")).startswith("PASS")
                for item in properties
            ):
                failures.append("BPU formal report contains a non-PASS property")

    if not cocotb_path.is_file():
        failures.append(f"missing BPU cocotb aggregate report: {cocotb_path.relative_to(ROOT)}")
    else:
        data = json.loads(cocotb_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            failures.append("BPU cocotb aggregate must be a JSON object")
        else:
            expected_total = expected_bpu_cocotb_total()
            if data.get("schema") != "eliza.bpu_cocotb_aggregate.v1":
                failures.append("BPU cocotb aggregate schema drifted")
            if data.get("status") != "PASS":
                failures.append("BPU cocotb aggregate status must be PASS")
            if data.get("expected_total_tests") != expected_total or data.get("total_tests") != expected_total:
                failures.append(
                    f"BPU cocotb aggregate must record {expected_total}/{expected_total} target-module tests"
                )
            if data.get("target_module_count") != 10:
                failures.append("BPU cocotb aggregate must record 10 target modules")
            if data.get("total_failures") != 0 or data.get("total_errors") != 0:
                failures.append("BPU cocotb aggregate must have zero failures/errors")
            if data.get("missing_modules") not in ([], None):
                failures.append("BPU cocotb aggregate must not list missing modules")
            modules = data.get("modules")
            if not isinstance(modules, dict) or len(modules) != 10:
                failures.append("BPU cocotb aggregate must include all 10 module summaries")
            else:
                module_test_sum = 0
                module_expected_sum = 0
                non_passing = False
                for module in modules.values():
                    if not isinstance(module, dict):
                        non_passing = True
                        continue
                    tests = module.get("tests")
                    expected_tests = module.get("expected_tests", tests)
                    if isinstance(tests, int) and not isinstance(tests, bool):
                        module_test_sum += tests
                    else:
                        non_passing = True
                    if isinstance(expected_tests, int) and not isinstance(expected_tests, bool):
                        module_expected_sum += expected_tests
                    else:
                        non_passing = True
                    if (
                        module.get("status") != "pass"
                        or module.get("failures") != 0
                        or module.get("errors") != 0
                        or module.get("skipped") != 0
                        or tests != expected_tests
                    ):
                        non_passing = True
                if non_passing:
                    failures.append("BPU cocotb aggregate contains a non-passing module summary")
                if module_test_sum != data.get("total_tests"):
                    failures.append("BPU cocotb aggregate total_tests must equal module test sum")
                if module_expected_sum != data.get("expected_total_tests"):
                    failures.append("BPU cocotb aggregate expected_total_tests must equal module expected-test sum")
    return failures


def verification_report_refs() -> dict[str, dict[str, object]]:
    refs: dict[str, dict[str, object]] = {}
    for name, path in bpu_verification_reports().items():
        ref: dict[str, object] = {"path": str(path.relative_to(ROOT)), "present": path.is_file()}
        if path.is_file():
            ref["sha256"] = sha256_path(path)
        refs[name] = ref
    return refs


def workload_replay_warnings(workload_mpki_path: Path) -> list[dict[str, object]]:
    if not workload_mpki_path.is_file():
        return []
    data = json.loads(workload_mpki_path.read_text(encoding="utf-8"))
    workloads = data.get("workloads", {})
    warnings: list[dict[str, object]] = []
    if not isinstance(workloads, dict):
        return warnings
    for name, workload in sorted(workloads.items()):
        if not isinstance(workload, dict):
            continue
        total_branches = workload.get("source_branch_count")
        replayed_branches = workload.get("branch_count")
        replay_fraction = workload.get("replay_fraction")
        if not isinstance(total_branches, int) or total_branches <= 0:
            continue
        if not isinstance(replayed_branches, int):
            continue
        fraction = float(replay_fraction) if isinstance(replay_fraction, (int, float)) else (
            replayed_branches / total_branches
        )
        if fraction < 0.10:
            warnings.append(
                {
                    "workload": name,
                    "trace_branch_count": total_branches,
                    "replayed_branch_count": replayed_branches,
                    "replay_fraction": round(fraction, 6),
                    "reason": "RTL workload evidence is prefix-only below 10% of the trace",
                }
            )
    return warnings


def build_evidence(
    values: dict[str, int | list[int]],
    status: str,
    failures: list[str],
    tools: dict[str, str],
) -> dict:
    serialisable: dict[str, int | list[int]] = {
        name: values[name]
        for name in values
        if name in THRESHOLDS
        or name
        in {
            "TAGE_HIST_LEN",
            "SC_HIST_LEN",
            "ITTAGE_ENTRIES",
            "ITTAGE_HIST_LEN",
        }
        or name in EVIDENCE_SCALARS
    }
    synthetic_mpki_path = ROOT / "docs/evidence/cpu_ap/mpki_results_synthetic.json"
    synthetic_mpki_ref: dict[str, str | bool] = {
        "path": str(synthetic_mpki_path.relative_to(ROOT)),
        "schema": "eliza.bpu_mpki.v1",
        "harness": "cocotb-rtl-bpu_top",
        "command": "make mpki-eval-rtl",
        "comparison_table": "docs/evidence/cpu_ap/mpki_synthetic_vs_cbp5_reference.md",
        "trace_class": "synthetic_planning_only",
        "spec2017_claim": False,
        "android_claim": False,
        "cbp5_claim": False,
    }
    if synthetic_mpki_path.is_file():
        synthetic_mpki_ref["sha256"] = sha256_path(synthetic_mpki_path)
        synthetic_mpki_ref["present"] = True
        synthetic_mpki_ref.update(
            artifact_metric_ref(synthetic_mpki_path, load_json_object_if_present(synthetic_mpki_path))
        )
    else:
        synthetic_mpki_ref["present"] = False

    workload_mpki_path = ROOT / "docs/evidence/cpu_ap/mpki_results_workload_rtl.json"
    workload_trace_manifest_path = ROOT / WORKLOAD_TRACE_MANIFEST_REL
    workload_trace_manifest_ref: dict[str, object] = {
        "path": str(workload_trace_manifest_path.relative_to(ROOT)),
        "schema": "eliza.bpu_workload_trace_manifest.v1",
        "harness": "qemu-rv64-execlog-trace-index",
        "command": "make bpu-workload-trace-manifest-check",
        "present": workload_trace_manifest_path.is_file(),
    }
    if workload_trace_manifest_path.is_file():
        manifest_data = load_json_object_if_present(workload_trace_manifest_path)
        workload_trace_manifest_ref["sha256"] = sha256_path(workload_trace_manifest_path)
        workload_trace_manifest_ref["trace_count"] = manifest_data.get("trace_count")
        workload_trace_manifest_ref["total_instruction_count"] = manifest_data.get(
            "total_instruction_count"
        )
        workload_trace_manifest_ref["total_branch_count"] = manifest_data.get("total_branch_count")
        workload_trace_manifest_ref["production_external_suites"] = manifest_data.get(
            "production_external_suites"
        )
    workload_mpki_ref: dict[str, str | bool] = {
        "path": str(workload_mpki_path.relative_to(ROOT)),
        "schema": "eliza.bpu_mpki.v1",
        "harness": "cocotb-rtl-bpu_top",
        "command": (
            "ELIZA_BPU_MPKI_WORKLOAD_MAX_BRANCHES=5000 TESTCASE="
            "bpu_mpki_workload_traces scripts/run_cocotb_bpu.sh"
        ),
        "trace_class": "qemu_rv64_workload",
        "spec2017_claim": False,
        "android_claim": False,
        "cbp5_claim": False,
    }
    if workload_mpki_path.is_file():
        workload_mpki_ref["sha256"] = sha256_path(workload_mpki_path)
        workload_mpki_ref["present"] = True
        workload_mpki_ref.update(
            artifact_metric_ref(workload_mpki_path, load_json_object_if_present(workload_mpki_path))
        )
        warnings = workload_replay_warnings(workload_mpki_path)
        if warnings:
            workload_mpki_ref["warnings"] = warnings
    else:
        workload_mpki_ref["present"] = False

    sweep_path = ROOT / "docs/evidence/cpu_ap/bpu_sweep_results.json"
    sweep_ref: dict[str, object] = {
        "path": str(sweep_path.relative_to(ROOT)),
        "schema": "eliza.bpu_sweep.v1",
        "harness": "behavioural-bpu-model",
        "command": "make bpu-sweep",
        "present": sweep_path.is_file(),
    }
    if sweep_path.is_file():
        sweep_data = load_json_object_if_present(sweep_path)
        sweep_ref["sha256"] = sha256_path(sweep_path)
        sweep_ref["best_config"] = sweep_data.get("best_config")
        sweep_ref["best_weighted_mpki"] = sweep_data.get("best_weighted_mpki")
        sweep_ref["baseline_weighted_mpki"] = sweep_data.get("baseline_weighted_mpki")
        sweep_ref["max_branches_per_trace"] = sweep_data.get("max_branches_per_trace")
        sweep_ref["window_mode"] = sweep_data.get("window_mode")
        sweep_ref["ittage_evidence_counters"] = sweep_data.get("ittage_evidence_counters")

    full_proxy_shard_ref = full_trace_shard_sweep_ref(
        FULL_PROXY_SHARD_SWEEP_REL,
        "make bpu-sweep-full-proxy-shard",
    )
    full_io_media_shard_ref = full_trace_shard_sweep_ref(
        FULL_IO_MEDIA_SHARD_SWEEP_REL,
        "make bpu-sweep-full-io-media-shard",
    )
    full_system_gpu_shard_ref = full_trace_shard_sweep_ref(
        FULL_SYSTEM_GPU_SHARD_SWEEP_REL,
        "make bpu-sweep-full-system-gpu-shard",
    )

    cbp5_model_path = ROOT / "docs/evidence/cpu_ap/mpki_results_cbp5.json"
    cbp5_rtl_path = ROOT / "docs/evidence/cpu_ap/mpki_results_cbp5_rtl.json"
    cbp5_mpki_ref: dict[str, object] = {
        "comparison_table": "docs/evidence/cpu_ap/mpki_cbp5_vs_tagesc_l_64kb.md",
        "evidence_class": "cbp5_train_traces_only",
        "spec2017_claim": False,
        "android_claim": False,
        "v8_claim": False,
        "cbp5_claim": False,
        "model": {
            "path": str(cbp5_model_path.relative_to(ROOT)),
            "schema": "eliza.bpu_mpki.v1",
            "harness": "behavioural-bpu-model",
            "command": "python3 benchmarks/cpu/branch/run_mpki.py --backend model --traces external/cbp5-traces/",
            "present": cbp5_model_path.is_file(),
        },
        "rtl": {
            "path": str(cbp5_rtl_path.relative_to(ROOT)),
            "schema": "eliza.bpu_mpki.v1",
            "harness": "cocotb-rtl-bpu_top",
            "command": "make mpki-eval-rtl",
            "present": cbp5_rtl_path.is_file(),
        },
    }
    if cbp5_model_path.is_file():
        cbp5_mpki_ref["model"]["sha256"] = sha256_path(cbp5_model_path)  # type: ignore[index]
        cbp5_mpki_ref["model"].update(  # type: ignore[union-attr]
            artifact_metric_ref(cbp5_model_path, load_json_object_if_present(cbp5_model_path))
        )
    if cbp5_rtl_path.is_file():
        cbp5_mpki_ref["rtl"]["sha256"] = sha256_path(cbp5_rtl_path)  # type: ignore[index]
        cbp5_mpki_ref["rtl"].update(  # type: ignore[union-attr]
            artifact_metric_ref(cbp5_rtl_path, load_json_object_if_present(cbp5_rtl_path))
        )

    return {
        "schema": "eliza.bpu_params.v1",
        "status": status,
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "source_revision": git_revision(),
        "tool_versions": tools,
        "thresholds": THRESHOLDS,
        "parameters": serialisable,
        "blockers": failures,
        "sources": {
            "package": {
                "path": str(PKG_PATH.relative_to(ROOT)),
                "sha256": sha256_path(PKG_PATH),
            },
            "top": {
                "path": str(TOP_PATH.relative_to(ROOT)),
                "sha256": sha256_path(TOP_PATH),
            },
            "contract": {
                "path": str(CONTRACT_DOC.relative_to(ROOT)),
                "sha256": sha256_path(CONTRACT_DOC),
            },
            "manifest": {
                "path": str(MANIFEST_PATH.relative_to(ROOT)),
                "sha256": sha256_path(MANIFEST_PATH),
            },
            "cbp5_trace_manifest": {
                "path": str(cbp5_trace_manifest_path().relative_to(ROOT)),
                "present": cbp5_trace_manifest_path().is_file(),
                **(
                    {"sha256": sha256_path(cbp5_trace_manifest_path())}
                    if cbp5_trace_manifest_path().is_file()
                    else {}
                ),
            },
        },
        "synthetic_mpki_results_ref": synthetic_mpki_ref,
        "workload_mpki_results_ref": workload_mpki_ref,
        "workload_trace_manifest_ref": workload_trace_manifest_ref,
        "sweep_results_ref": sweep_ref,
        "full_proxy_shard_sweep_ref": full_proxy_shard_ref,
        "full_io_media_shard_sweep_ref": full_io_media_shard_ref,
        "full_system_gpu_shard_sweep_ref": full_system_gpu_shard_ref,
        "cbp5_mpki_results_ref": cbp5_mpki_ref,
        "verification_reports": verification_report_refs(),
        "claim_policy": {
            "spec2017_mpki_claim": False,
            "android_mpki_claim": False,
            "two_taken_per_cycle_claim": False,
            "fdip_claim": False,
            "cbp5_mpki_claim": False,
            "reason": (
                "Open RTL geometry verified against 2028 thresholds. CBP-5"
                " train-trace RTL evidence is on file but aggregate RTL MPKI"
                " is above target_2028_mpki, so CBP-5 target-met, SPEC,"
                " AOSP, and JS-engine MPKI claims remain blocked."
            ),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--require-clean",
        action="store_true",
        help="exit non-zero if status is not clean (CI gate mode)",
    )
    parser.add_argument(
        "--print-only",
        action="store_true",
        help="print the evidence JSON to stdout without writing it",
    )
    args = parser.parse_args()

    for path in (PKG_PATH, TOP_PATH, CONTRACT_DOC, MANIFEST_PATH):
        if not path.is_file():
            print(f"BLOCKED: missing required input {path}", file=sys.stderr)
            return 2

    values = parse_package(PKG_PATH.read_text(encoding="utf-8"))
    status, failures = evaluate(values)
    failures.extend(evaluate_evidence_artifacts())
    status = "clean" if not failures else "blocked"
    tools = detect_tool_versions()
    evidence = build_evidence(values, status, failures, tools)

    if args.print_only:
        json.dump(evidence, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
    else:
        EVIDENCE_PATH.parent.mkdir(parents=True, exist_ok=True)
        EVIDENCE_PATH.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
        print(
            f"eliza-evidence: status={'PASS' if status == 'clean' else 'BLOCKED'} "
            f"path={EVIDENCE_PATH.relative_to(ROOT)}"
        )

    if status != "clean":
        for fail in failures:
            print(f"BLOCKED: {fail}", file=sys.stderr)
        if args.require_clean:
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
