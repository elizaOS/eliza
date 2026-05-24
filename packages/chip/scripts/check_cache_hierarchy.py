#!/usr/bin/env python3
"""Cache hierarchy claim gate.

Enforces the 2028 phone-class minimums declared in
`docs/evidence/cache/cache-evidence-gate.yaml` against the actual
parameter values in `rtl/cache/cache_pkg.sv`. Fails closed if:

- The gate YAML is missing or schema-drifted.
- Any required RTL file is missing.
- The RTL parameters declare smaller-than-minimum cache sizes.
- Any blocked claim's evidence artifact already exists (which would
  contradict the BLOCKED status).
- The arch doc loses any required token.

Writes a tiny evidence JSON to `build/reports/cache_hierarchy_gate.json`
on success so downstream gates can chain.
"""

from __future__ import annotations

import json
import hashlib
import re
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
GATE = ROOT / "docs/evidence/cache/cache-evidence-gate.yaml"
ARCH_DOC = ROOT / "docs/arch/cache-hierarchy.md"
CACHE_PKG = ROOT / "rtl/cache/cache_pkg.sv"
FTQ_PKG = ROOT / "rtl/cache/ftq_to_l1i_pkg.sv"
LSU_PKG = ROOT / "rtl/cache/lsu_to_l1d_pkg.sv"

REQUIRED_RTL = [
    "rtl/cache/cache_pkg.sv",
    "rtl/cache/ftq_to_l1i_pkg.sv",
    "rtl/cache/lsu_to_l1d_pkg.sv",
    "rtl/cache/l1i/e1_l1i_cache.sv",
    "rtl/cache/l1d/e1_l1d_cache.sv",
    "rtl/cache/l2/e1_l2_cache.sv",
    "rtl/cache/l3/e1_l3_cache.sv",
    "rtl/cache/slc/e1_slc.sv",
    "rtl/cache/prefetch/e1_berti_prefetcher.sv",
    "rtl/cache/prefetch/e1_fdip_l1i_prefetcher.sv",
    "rtl/cache/prefetch/e1_stride_prefetcher.sv",
    "rtl/cache/prefetch/e1_best_offset_prefetcher.sv",
    "rtl/cache/prefetch/e1_spp_prefetcher.sv",
    "rtl/cache/prefetch/e1_ipcp_prefetcher.sv",
    "rtl/cache/prefetch/e1_pythia_stub.sv",
    "rtl/cache/replacement/e1_drrip.sv",
    "rtl/cache/replacement/e1_hawkeye.sv",
    "rtl/cache/replacement/e1_mockingjay.sv",
    "rtl/cache/replacement/e1_mockingjay_prod.sv",
    "rtl/cache/compression/e1_bdi_compress.sv",
    "rtl/cache/compression/e1_bdi_decompress.sv",
    "rtl/cache/coherence/e1_coherence_dir.sv",
    "rtl/cache/coherence/tl_c_to_chi_bridge.sv",
]
COHERENCE_REPORT = ROOT / "build/reports/cache_coherence.json"
CACHE_EVIDENCE_MAX_AGE = timedelta(days=30)

EXPECTED_EXECUTABLE_CHECKS = {
    "cache_hierarchy_claim_gate": "make cache-hierarchy-claim-gate",
    "rtl_lint": "make rtl-check",
    "cocotb_cache_coherence": "make cocotb-cache-coherence",
}

EXPECTED_COHERENCE_TESTCASES = {
    "verify/cocotb/cache/results_smp_coherence.xml": {
        "test_write_propagation",
        "test_swmr_single_writer",
        "test_no_two_modified_invariant",
        "test_message_passing_litmus",
        "test_dirty_writeback_ordering",
        "test_domain_flush_partition",
    },
    "verify/cocotb/cache/results_coherence_vectors.xml": {
        "test_clean_line_probe_invalidate_no_writeback",
        "test_dirty_line_probe_invalidate_writeback",
        "test_dirty_line_probe_downgrade_to_shared",
        "test_invalidate_miss_no_data",
    },
}

REQUIRED_DOC_TOKENS = [
    "Cache hierarchy contract",
    "L1I",
    "L1D",
    "L2",
    "L3",
    "SLC",
    "SECDED",
    "MESI",
    "TileLink TL-C",
    "Mockingjay",
    "Berti",
    "FDIP",
    "BDI",
    "QoS",
    "BLOCKED until",
    "make cache-hierarchy-claim-gate",
]

REQUIRED_BLOCKED_IDS = {
    "phone_class_ipc",
    "phone_class_latency_curve",
    "phone_class_sustained_bandwidth",
    "hawkeye_mockingjay_dpc3_replacement",
    "pythia_rl_prefetcher",
    "silicon_evidence",
}

# Scoped local evidence rows that must carry an explicit `evidence_class` tag
# and have their evidence artifact present. These are not phone/silicon/release
# measurements.
REQUIRED_SCOPED_EVIDENCE_IDS = {
    "champsim_prefetcher_sweep": "champsim_dpc3_traces_only",
    "mockingjay_vs_lru_sweep": "champsim_dpc3_traces_only",
    "mockingjay_cocotb_synthetic": "cocotb_synthetic_stream",
    "berti_ipcp_bingo_bop_dpc3": "champsim_dpc3_traces_only",
    "pythia_rl_prefetcher_dpc3": "champsim_dpc3_traces_only",
}


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def is_utc_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed.utcoffset() is not None


def parse_utc_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed.astimezone(timezone.utc)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_repo_path(value: Any) -> Path | None:
    if not isinstance(value, str) or not value:
        return None
    path = Path(value)
    if path.is_absolute() or ".." in path.parts:
        return None
    return ROOT / path


def load_json_artifact(path: Path, errors: list[str]) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        errors.append(f"{path.relative_to(ROOT)} is not valid JSON: {exc}")
        return None
    if not isinstance(data, dict):
        errors.append(f"{path.relative_to(ROOT)} must be a JSON object")
        return None
    return data


def validate_scoped_artifact_freshness(artifact: str, data: dict[str, Any], errors: list[str]) -> None:
    captured = parse_utc_timestamp(data.get("captured_utc"))
    if captured is None:
        return
    now = datetime.now(timezone.utc)
    if captured > now + timedelta(minutes=5):
        errors.append(f"{artifact}: captured_utc must not be in the future")
    if now - captured > CACHE_EVIDENCE_MAX_AGE:
        errors.append(
            f"{artifact}: captured_utc is older than {CACHE_EVIDENCE_MAX_AGE.days} days; refresh local cache evidence"
        )


def validate_source_artifact_hashes(artifact: str, data: dict[str, Any], errors: list[str]) -> None:
    provenance = data.get("provenance")
    if not isinstance(provenance, dict):
        errors.append(f"{artifact}: provenance must be an object")
        return
    source_artifacts = provenance.get("source_artifacts")
    if not isinstance(source_artifacts, list) or not source_artifacts:
        errors.append(f"{artifact}: provenance.source_artifacts must be a non-empty list")
        return
    for index, item in enumerate(source_artifacts):
        if not isinstance(item, dict):
            errors.append(f"{artifact}: provenance.source_artifacts[{index}] must be an object")
            continue
        path = resolve_repo_path(item.get("path"))
        if path is None:
            errors.append(
                f"{artifact}: provenance.source_artifacts[{index}].path must be a relative repo path"
            )
            continue
        if not path.is_file():
            errors.append(f"{artifact}: provenance source missing on disk: {item.get('path')}")
            continue
        sha = item.get("sha256")
        if not isinstance(sha, str) or re.fullmatch(r"[0-9a-f]{64}", sha) is None:
            errors.append(f"{artifact}: provenance.source_artifacts[{index}].sha256 must be lowercase SHA-256")
        elif sha256_file(path) != sha:
            errors.append(f"{artifact}: provenance source hash mismatch: {item.get('path')}")


def validate_scoped_artifact(
    *,
    claim_id: str,
    artifact: str,
    expected_schema: str,
    expected_class: str,
    errors: list[str],
) -> None:
    path = ROOT / artifact
    if path.suffix != ".json":
        errors.append(
            f"claim {claim_id} scoped artifact must be JSON for schema validation: {artifact}"
        )
        return
    data = load_json_artifact(path, errors)
    if data is None:
        return
    require(
        data.get("schema") == expected_schema,
        f"{artifact}: schema must be {expected_schema}",
        errors,
    )
    require(
        data.get("evidence_class") == expected_class,
        f"{artifact}: evidence_class must be {expected_class}",
        errors,
    )
    status = data.get("status")
    require(
        isinstance(status, str) and (status.startswith("scoped_") or status.endswith("_scoped")),
        f"{artifact}: status must explicitly be scoped local evidence",
        errors,
    )
    require(
        is_utc_timestamp(data.get("captured_utc")),
        f"{artifact}: captured_utc must be an ISO-8601 timestamp with timezone",
        errors,
    )
    validate_scoped_artifact_freshness(artifact, data, errors)
    validate_source_artifact_hashes(artifact, data, errors)
    require(
        isinstance(data.get("claim_boundary"), str)
        and "phone" in data["claim_boundary"].lower()
        and "release" in data["claim_boundary"].lower()
        and "not" in data["claim_boundary"].lower(),
        f"{artifact}: claim_boundary must explicitly block phone/release promotion",
        errors,
    )
    require(
        data.get("phone_claim_allowed") is False,
        f"{artifact}: phone_claim_allowed must be false",
        errors,
    )
    require(
        data.get("release_claim_allowed") is False,
        f"{artifact}: release_claim_allowed must be false",
        errors,
    )
    validate_scoped_artifact_semantics(artifact=artifact, data=data, errors=errors)


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def validate_champsim_sweep_artifact(artifact: str, data: dict[str, Any], errors: list[str]) -> None:
    trace_files = data.get("trace_files")
    trace_count = data.get("trace_count")
    variants = data.get("variants_requested")
    missing = data.get("variants_missing")
    results = data.get("results")
    aggregate = data.get("aggregate")
    require(isinstance(trace_count, int) and trace_count > 0, f"{artifact}: trace_count must be positive", errors)
    require(isinstance(trace_files, list) and len(trace_files) == trace_count, f"{artifact}: trace_files must match trace_count", errors)
    require(isinstance(variants, list) and bool(variants), f"{artifact}: variants_requested must be non-empty", errors)
    require(missing == [], f"{artifact}: variants_missing must be empty", errors)
    require(isinstance(results, list) and bool(results), f"{artifact}: results must be non-empty", errors)
    if not (isinstance(trace_count, int) and isinstance(variants, list) and isinstance(results, list)):
        return
    expected_runs = trace_count * len(variants)
    require(len(results) == expected_runs, f"{artifact}: results must cover every trace/variant pair", errors)
    seen: set[tuple[str, str]] = set()
    for index, row in enumerate(results):
        if not isinstance(row, dict):
            errors.append(f"{artifact}: results[{index}] must be an object")
            continue
        trace = row.get("trace")
        label = row.get("label")
        if isinstance(trace, str) and isinstance(label, str):
            seen.add((trace, label))
        require(row.get("returncode") == 0, f"{artifact}: results[{index}] returncode must be 0", errors)
        require(row.get("parsed") is True, f"{artifact}: results[{index}] parsed must be true", errors)
        for metric in ("ipc", "instructions", "cycles", "llc_mpki", "l2c_mpki"):
            require(is_number(row.get(metric)) and row[metric] > 0, f"{artifact}: results[{index}].{metric} must be positive", errors)
        for path_key in ("json_path", "log_path"):
            path_value = row.get(path_key)
            require(
                isinstance(path_value, str) and path_value and not Path(path_value).is_absolute() and ".." not in Path(path_value).parts,
                f"{artifact}: results[{index}].{path_key} must be a relative artifact path",
                errors,
            )
    if isinstance(trace_files, list) and isinstance(variants, list):
        expected_pairs = {
            (trace, variant)
            for trace in trace_files
            for variant in variants
            if isinstance(trace, str) and isinstance(variant, str)
        }
        missing_pairs = sorted(expected_pairs - seen)
        require(not missing_pairs, f"{artifact}: missing trace/variant result pairs: {missing_pairs[:3]}", errors)
    require(isinstance(aggregate, dict), f"{artifact}: aggregate must be an object", errors)
    if isinstance(aggregate, dict) and isinstance(variants, list):
        for variant in variants:
            if not isinstance(variant, str):
                continue
            row = aggregate.get(variant)
            require(isinstance(row, dict), f"{artifact}: aggregate.{variant} must be an object", errors)
            if isinstance(row, dict):
                require(row.get("runs") == trace_count, f"{artifact}: aggregate.{variant}.runs must equal trace_count", errors)
                require(row.get("parsed_runs") == trace_count, f"{artifact}: aggregate.{variant}.parsed_runs must equal trace_count", errors)
                for metric in ("mean_ipc", "mean_llc_mpki", "mean_l2c_mpki"):
                    require(is_number(row.get(metric)) and row[metric] > 0, f"{artifact}: aggregate.{variant}.{metric} must be positive", errors)


def validate_mockingjay_cocotb_artifact(artifact: str, data: dict[str, Any], errors: list[str]) -> None:
    result = data.get("result")
    threshold = data.get("pass_threshold_abs_or_rel")
    require(data.get("passed_threshold") is True, f"{artifact}: passed_threshold must be true", errors)
    require(data.get("test_status") == "PASS", f"{artifact}: test_status must be PASS", errors)
    require(isinstance(result, dict), f"{artifact}: result must be an object", errors)
    if isinstance(result, dict):
        rel_gain = result.get("rel_gain")
        abs_gain = result.get("abs_gain")
        mj = result.get("mockingjay_hit_rate")
        lru = result.get("lru_hit_rate")
        require(is_number(threshold) and threshold > 0, f"{artifact}: pass_threshold_abs_or_rel must be positive", errors)
        require(is_number(rel_gain) and is_number(abs_gain), f"{artifact}: result gains must be numeric", errors)
        if is_number(threshold) and is_number(rel_gain) and is_number(abs_gain):
            require(
                rel_gain >= threshold or abs_gain >= threshold,
                f"{artifact}: passed_threshold requires abs_gain or rel_gain to meet threshold",
                errors,
            )
        require(is_number(mj) and is_number(lru) and mj > lru, f"{artifact}: Mockingjay hit rate must exceed LRU", errors)
    stream = data.get("stream")
    require(isinstance(stream, dict), f"{artifact}: stream must be an object", errors)
    if isinstance(stream, dict):
        require(stream.get("measure_ops", 0) > 0 and stream.get("num_ops", 0) >= stream.get("measure_ops", 0), f"{artifact}: stream measurement window must be positive", errors)


def validate_external_prefetchers_artifact(artifact: str, data: dict[str, Any], errors: list[str]) -> None:
    required = {"berti", "ipcp", "bingo", "bop", "pythia"}
    modules = data.get("ported_modules")
    require(isinstance(modules, list), f"{artifact}: ported_modules must be a list", errors)
    names = {module.get("name") for module in modules if isinstance(module, dict)} if isinstance(modules, list) else set()
    missing = sorted(required - names)
    require(not missing, f"{artifact}: missing ported modules: " + ", ".join(missing), errors)
    if isinstance(modules, list):
        for module in modules:
            if not isinstance(module, dict):
                continue
            name = module.get("name", "<unknown>")
            require(isinstance(module.get("path"), str) and (ROOT / module["path"]).is_dir(), f"{artifact}: ported module {name} path must exist", errors)
            require(isinstance(module.get("loc_total"), int) and module["loc_total"] > 0, f"{artifact}: ported module {name} loc_total must be positive", errors)
    results_artifact = data.get("results_artifact")
    require(results_artifact == "docs/evidence/cache/champsim_prefetch_sweep_report.json", f"{artifact}: results_artifact must link to prefetch sweep report", errors)
    if isinstance(results_artifact, str):
        require((ROOT / results_artifact).is_file(), f"{artifact}: linked results_artifact missing", errors)


def validate_pythia_artifact(artifact: str, data: dict[str, Any], errors: list[str]) -> None:
    require(data.get("results_artifact") == "docs/evidence/cache/champsim_prefetch_sweep_report.json", f"{artifact}: results_artifact must link to prefetch sweep report", errors)
    for key in ("port_location", "binary", "build_config"):
        value = data.get(key)
        require(isinstance(value, str) and bool(value), f"{artifact}: {key} must be populated", errors)
        if isinstance(value, str):
            require((ROOT / value).exists(), f"{artifact}: {key} path does not exist: {value}", errors)
    scope = data.get("algorithmic_scope")
    require(isinstance(scope, dict), f"{artifact}: algorithmic_scope must be an object", errors)
    if isinstance(scope, dict):
        require(scope.get("num_states") == 16384, f"{artifact}: Pythia num_states must remain 16384", errors)
        require(scope.get("action_space_size") == 16, f"{artifact}: Pythia action_space_size must remain 16", errors)


def validate_scoped_artifact_semantics(artifact: str, data: dict[str, Any], errors: list[str]) -> None:
    schema = data.get("schema")
    if schema in {
        "eliza.cache.champsim_prefetch_sweep.v1",
        "eliza.cache.mockingjay_vs_lru.v1",
    }:
        validate_champsim_sweep_artifact(artifact, data, errors)
    elif schema == "eliza.cache.mockingjay_cocotb_synthetic.v1":
        validate_mockingjay_cocotb_artifact(artifact, data, errors)
    elif schema == "eliza.cache.champsim_external_prefetchers.v1":
        validate_external_prefetchers_artifact(artifact, data, errors)
    elif schema == "eliza.cache.pythia_dpc3.v1":
        validate_pythia_artifact(artifact, data, errors)


def parse_pkg_localparam(text: str, name: str) -> int | None:
    """Extract `localparam int unsigned NAME = <expr>;` and evaluate."""
    pattern = re.compile(rf"localparam\s+int\s+unsigned\s+{name}\s*=\s*([^;]+);")
    m = pattern.search(text)
    if not m:
        return None
    expr = m.group(1).strip()
    # Drop SystemVerilog-only suffixes and comments
    expr = re.sub(r"//.*", "", expr).strip()
    # Allow basic arithmetic
    try:
        # Safe-ish eval over arithmetic-only expression
        if not re.fullmatch(r"[\d\s\+\-\*/()]+", expr):
            return None
        return int(eval(expr))  # noqa: S307 - constrained char set
    except Exception:
        return None


def check_rtl_present(errors: list[str]) -> None:
    for rel in REQUIRED_RTL:
        path = ROOT / rel
        require(path.is_file(), f"missing RTL file: {rel}", errors)


def check_pkg_minimums(gate: dict, errors: list[str]) -> dict[str, int]:
    actual: dict[str, int] = {}
    if not CACHE_PKG.is_file():
        errors.append("missing rtl/cache/cache_pkg.sv")
        return actual
    text = CACHE_PKG.read_text()

    expected = {
        "L1I_SIZE_BYTES": gate["phone_2028_minimums"]["l1i_kib_min"] * 1024,
        "L1D_SIZE_BYTES": gate["phone_2028_minimums"]["l1d_kib_min"] * 1024,
        "L2_SIZE_BYTES": gate["phone_2028_minimums"]["l2_kib_min"] * 1024,
        "L3_SIZE_BYTES": gate["phone_2028_minimums"]["l3_mib_min"] * 1024 * 1024,
        "SLC_SIZE_BYTES": gate["phone_2028_minimums"]["slc_mib_min"] * 1024 * 1024,
    }
    for name, minimum in expected.items():
        value = parse_pkg_localparam(text, name)
        if value is None:
            errors.append(f"cache_pkg.sv missing or unparseable {name}")
            continue
        actual[name] = value
        if value < minimum:
            errors.append(
                f"cache_pkg.sv {name}={value} is below 2028 minimum {minimum}"
            )

    # Line bytes must match the gate
    line_bytes = parse_pkg_localparam(text, "LINE_BYTES_DEFAULT")
    expected_line = gate["phone_2028_minimums"]["line_bytes"]
    if line_bytes != expected_line:
        errors.append(
            f"cache_pkg.sv LINE_BYTES_DEFAULT={line_bytes} != gate line_bytes={expected_line}"
        )
    if line_bytes is not None:
        actual["LINE_BYTES_DEFAULT"] = line_bytes

    # SECDED helpers must exist on L1D
    for token in (
        "function automatic logic [7:0] secded_encode",
        "function automatic logic secded_is_single",
        "function automatic logic secded_is_double",
    ):
        if token not in text:
            errors.append(f"cache_pkg.sv missing SECDED helper: {token}")

    # MESI enum must exist
    for token in ("MESI_I", "MESI_S", "MESI_E", "MESI_M"):
        if token not in text:
            errors.append(f"cache_pkg.sv missing MESI state: {token}")
    return actual


def check_packages(errors: list[str]) -> None:
    if not FTQ_PKG.is_file():
        errors.append("missing rtl/cache/ftq_to_l1i_pkg.sv")
    else:
        ftq = FTQ_PKG.read_text()
        for token in (
            "package e1_ftq_to_l1i_pkg",
            "ftq_prefetch_req_t",
            "paddr_line",
            "confidence",
            "branch_target",
        ):
            if token not in ftq:
                errors.append(f"ftq_to_l1i_pkg.sv missing token: {token}")

    if not LSU_PKG.is_file():
        errors.append("missing rtl/cache/lsu_to_l1d_pkg.sv")
    else:
        lsu = LSU_PKG.read_text()
        for token in (
            "package e1_lsu_to_l1d_pkg",
            "lsu_l1d_req_t",
            "lsu_l1d_resp_t",
            "is_load",
            "ecc_uncorrectable",
        ):
            if token not in lsu:
                errors.append(f"lsu_to_l1d_pkg.sv missing token: {token}")


def check_doc(errors: list[str]) -> None:
    if not ARCH_DOC.is_file():
        errors.append("missing docs/arch/cache-hierarchy.md")
        return
    text = ARCH_DOC.read_text()
    for token in REQUIRED_DOC_TOKENS:
        if token not in text:
            errors.append(f"docs/arch/cache-hierarchy.md missing token: {token}")


def check_coherence_report(errors: list[str]) -> None:
    if not COHERENCE_REPORT.is_file():
        errors.append("missing cache coherence report: build/reports/cache_coherence.json")
        return
    data = load_json_artifact(COHERENCE_REPORT, errors)
    if data is None:
        return
    require(
        data.get("schema") == "eliza.gate_status.v1",
        "cache_coherence.json schema must be eliza.gate_status.v1",
        errors,
    )
    require(data.get("gate") == "cache-coherence-check", "cache coherence gate drifted", errors)
    require(data.get("status") == "PASS", "cache coherence report must be PASS", errors)
    require(is_utc_timestamp(data.get("as_of")), "cache coherence report as_of must be timestamped", errors)
    evidence_paths = data.get("evidence_paths")
    require(isinstance(evidence_paths, list), "cache coherence report must list evidence_paths", errors)
    if isinstance(evidence_paths, list):
        for rel_path in (
            "rtl/cache/coherence/e1_coherence_dir.sv",
            "verify/cocotb/cache/test_smp_coherence.py",
            "verify/cocotb/cache/test_coherence_vectors.py",
        ):
            require(rel_path in evidence_paths, f"cache coherence report missing evidence path {rel_path}", errors)
        for rel_path in evidence_paths:
            if isinstance(rel_path, str):
                require((ROOT / rel_path).exists(), f"cache coherence evidence path missing on disk: {rel_path}", errors)
    for rel_path in (
        "verify/cocotb/cache/results_smp_coherence.xml",
        "verify/cocotb/cache/results_coherence_vectors.xml",
    ):
        xml_path = ROOT / rel_path
        require(xml_path.is_file(), f"cache coherence cocotb result missing: {rel_path}", errors)
        if xml_path.is_file():
            check_cocotb_junit_xml(xml_path, rel_path, errors)


def check_cocotb_junit_xml(path: Path, rel_path: str, errors: list[str]) -> None:
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as exc:
        errors.append(f"cache coherence cocotb result is not valid XML: {rel_path}: {exc}")
        return
    testcases = root.findall(".//testcase")
    if not testcases:
        errors.append(f"cache coherence cocotb result has no testcase entries: {rel_path}")
        return
    seen = {testcase.get("name") or "<unnamed>" for testcase in testcases}
    expected = EXPECTED_COHERENCE_TESTCASES.get(rel_path)
    if expected is not None:
        missing = sorted(expected - seen)
        extra = sorted(seen - expected)
        if missing:
            errors.append(
                f"cache coherence cocotb {rel_path} missing expected testcases: {', '.join(missing)}"
            )
        if extra:
            errors.append(
                f"cache coherence cocotb {rel_path} has unexpected testcases: {', '.join(extra)}"
            )
    for testcase in testcases:
        name = testcase.get("name") or "<unnamed>"
        for tag in ("failure", "error", "skipped"):
            if testcase.find(tag) is not None:
                errors.append(f"cache coherence cocotb {rel_path} testcase {name} has <{tag}>")


def check_gate_yaml(errors: list[str]) -> dict:
    if not GATE.is_file():
        errors.append("missing docs/evidence/cache/cache-evidence-gate.yaml")
        return {}
    data = yaml.safe_load(GATE.read_text())
    if not isinstance(data, dict):
        errors.append("cache-evidence-gate.yaml must be a YAML mapping")
        return {}
    require(
        data.get("schema") == "eliza.cache_hierarchy_evidence_gate.v1",
        "cache evidence gate schema drifted",
        errors,
    )
    require(
        data.get("status") == "scaffold_rtl_real_claims_blocked",
        "cache evidence gate must stay scaffold_rtl_real_claims_blocked",
        errors,
    )
    if "measured_real_claims" in data:
        errors.append(
            "cache gate must not use legacy measured_real_claims; use scoped_local_evidence_claims for local cache-only evidence"
        )
    scaffold = data.get("current_scaffold_evidence") or {}
    executable_checks = scaffold.get("executable_checks") if isinstance(scaffold, dict) else None
    if not isinstance(executable_checks, list):
        errors.append("cache gate current_scaffold_evidence.executable_checks must be a list")
    else:
        seen_checks: dict[str, str] = {}
        for index, check in enumerate(executable_checks):
            if not isinstance(check, dict):
                errors.append(f"cache gate executable_checks[{index}] must be an object")
                continue
            name = check.get("name")
            command = check.get("command")
            if not isinstance(name, str) or not name:
                errors.append(f"cache gate executable_checks[{index}].name must be a non-empty check id")
                continue
            if name not in EXPECTED_EXECUTABLE_CHECKS:
                errors.append(f"cache gate has unexpected executable check id: {name}")
            elif command != EXPECTED_EXECUTABLE_CHECKS[name]:
                errors.append(
                    f"cache gate executable check {name} command must be {EXPECTED_EXECUTABLE_CHECKS[name]}"
                )
            if name in seen_checks:
                errors.append(f"cache gate executable check id repeated: {name}")
            if isinstance(command, str):
                seen_checks[name] = command
        missing_checks = sorted(set(EXPECTED_EXECUTABLE_CHECKS) - set(seen_checks))
        require(
            not missing_checks,
            "cache gate missing executable check ids: " + ", ".join(missing_checks),
            errors,
        )

    mins = data.get("phone_2028_minimums") or {}
    for key, minimum in (
        ("l1i_kib_min", 32),
        ("l1d_kib_min", 32),
        ("l2_kib_min", 256),
        ("l3_mib_min", 4),
        ("slc_mib_min", 8),
        ("line_bytes", 64),
    ):
        value = mins.get(key)
        require(
            isinstance(value, int) and value >= minimum,
            f"phone_2028_minimums.{key} must be at least {minimum}",
            errors,
        )

    blocked = data.get("blocked_real_claims") or []
    blocked_ids = {item.get("id") for item in blocked if isinstance(item, dict)}
    missing = sorted(REQUIRED_BLOCKED_IDS - blocked_ids)
    require(
        not missing,
        "cache gate missing blocked claim ids: " + ", ".join(missing),
        errors,
    )
    schema_map = data.get("required_artifact_schemas") or {}
    require(
        isinstance(schema_map, dict),
        "cache gate required_artifact_schemas must be a mapping",
        errors,
    )
    if not isinstance(schema_map, dict):
        schema_map = {}

    declared_artifacts: set[str] = set()
    for item in blocked:
        if not isinstance(item, dict):
            continue
        require(
            item.get("status") == "blocked",
            f"claim {item.get('id')} must remain blocked",
            errors,
        )
        artifacts = item.get("evidence_artifacts") or []
        require(
            bool(artifacts),
            f"claim {item.get('id')} must list at least one blocked evidence artifact",
            errors,
        )
        for artifact in artifacts:
            if not isinstance(artifact, str):
                errors.append(f"claim {item.get('id')} non-string evidence artifact")
                continue
            declared_artifacts.add(artifact)
            require(
                artifact in schema_map,
                f"claim {item.get('id')} artifact lacks required_artifact_schemas entry: {artifact}",
                errors,
            )
            if (ROOT / artifact).exists():
                errors.append(
                    f"claim {item.get('id')} is blocked but artifact exists: {artifact}"
                )

    scoped = data.get("scoped_local_evidence_claims") or []
    scoped_ids = {item.get("id") for item in scoped if isinstance(item, dict)}
    missing_scoped = sorted(set(REQUIRED_SCOPED_EVIDENCE_IDS) - scoped_ids)
    require(
        not missing_scoped,
        "cache gate missing scoped local evidence claim ids: "
        + ", ".join(missing_scoped),
        errors,
    )
    for item in scoped:
        if not isinstance(item, dict):
            continue
        cid = item.get("id")
        if cid not in REQUIRED_SCOPED_EVIDENCE_IDS:
            continue
        expected_class = REQUIRED_SCOPED_EVIDENCE_IDS[cid]
        require(
            item.get("evidence_class") == expected_class,
            f"claim {cid} must declare evidence_class={expected_class}",
            errors,
        )
        require(
            isinstance(item.get("status"), str)
            and str(item.get("status")).startswith("scoped_"),
            f"claim {cid} must carry a scoped_* status",
            errors,
        )
        artifacts = item.get("evidence_artifacts") or []
        require(
            bool(artifacts),
            f"claim {cid} must list at least one evidence artifact",
            errors,
        )
        for artifact in artifacts:
            if not isinstance(artifact, str):
                errors.append(f"claim {cid} non-string evidence artifact")
                continue
            declared_artifacts.add(artifact)
            expected_schema = schema_map.get(artifact)
            require(
                isinstance(expected_schema, str) and expected_schema,
                f"claim {cid} artifact lacks required_artifact_schemas entry: {artifact}",
                errors,
            )
            require(
                (ROOT / artifact).is_file(),
                f"claim {cid} evidence artifact missing on disk: {artifact}",
                errors,
            )
            if isinstance(expected_schema, str) and (ROOT / artifact).is_file():
                validate_scoped_artifact(
                    claim_id=cid,
                    artifact=artifact,
                    expected_schema=expected_schema,
                    expected_class=expected_class,
                    errors=errors,
                )

    extra_schema_artifacts = sorted(set(schema_map) - declared_artifacts)
    require(
        not extra_schema_artifacts,
        "cache gate required_artifact_schemas has undeclared artifacts: "
        + ", ".join(extra_schema_artifacts),
        errors,
    )

    return data


def main() -> int:
    errors: list[str] = []
    gate = check_gate_yaml(errors)
    check_rtl_present(errors)
    actual = check_pkg_minimums(gate, errors) if gate else {}
    check_packages(errors)
    check_doc(errors)
    check_coherence_report(errors)

    if errors:
        print("Cache hierarchy claim gate failed:")
        for error in errors:
            print(f"  - {error}")
        return 1

    out_dir = ROOT / "build/reports"
    out_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "schema": "eliza.cache_hierarchy_gate.v1",
        "status": "pass",
        "claim_boundary": (
            "Local cache RTL/scaffold gate only; not phone-class IPC, bandwidth, "
            "silicon, Linux, Android, DRAM, LPDDR, or release evidence."
        ),
        "phone_claim_allowed": False,
        "release_claim_allowed": False,
        "rtl_module_count": len(REQUIRED_RTL),
        "coherence_report": "build/reports/cache_coherence.json",
        "phone_2028_minimums": gate["phone_2028_minimums"],
        "cache_pkg_actuals": actual,
        "blocked_claim_count": len(REQUIRED_BLOCKED_IDS),
        "scoped_local_evidence_claim_count": len(REQUIRED_SCOPED_EVIDENCE_IDS),
    }
    (out_dir / "cache_hierarchy_gate.json").write_text(
        json.dumps(report, indent=2) + "\n"
    )
    print("Cache hierarchy claim gate passed.")
    print(f"  rtl_modules: {len(REQUIRED_RTL)}")
    print(
        f"  l1i={actual.get('L1I_SIZE_BYTES')} B "
        f"l1d={actual.get('L1D_SIZE_BYTES')} B "
        f"l2={actual.get('L2_SIZE_BYTES')} B "
        f"l3={actual.get('L3_SIZE_BYTES')} B "
        f"slc={actual.get('SLC_SIZE_BYTES')} B"
    )
    print(f"  blocked_real_claims: {len(REQUIRED_BLOCKED_IDS)}")
    print(f"  scoped_local_evidence_claims: {len(REQUIRED_SCOPED_EVIDENCE_IDS)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
