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
FALSE_CLAIM_STALE_PHRASES = (
    "claim is supported",
    "claim remains supported",
    "claim remains unblocked",
    "claims are supported",
    "only the cbp-5 claim is supported",
)

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
    "LOOP_PATH_SIG_W",
    "SC_ADAPTIVE",
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
        workloads = data.get("workloads", {})
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
    workload_trace_dir = ROOT / "external/workload-traces"
    if not workload_trace_dir.is_dir():
        return []
    data = json.loads(workload_mpki_path.read_text(encoding="utf-8"))
    workloads = data.get("workloads", {})
    warnings: list[dict[str, object]] = []
    for trace_path in sorted(workload_trace_dir.glob("*.btrace.json")):
        name = trace_path.name[: -len(".btrace.json")]
        workload = workloads.get(name)
        if not isinstance(workload, dict):
            continue
        trace_data = json.loads(trace_path.read_text(encoding="utf-8"))
        total_branches = trace_data.get("branch_count")
        replayed_branches = workload.get("branch_count")
        if not isinstance(total_branches, int) or total_branches <= 0:
            continue
        if not isinstance(replayed_branches, int):
            continue
        fraction = replayed_branches / total_branches
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
