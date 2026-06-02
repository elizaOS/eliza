#!/usr/bin/env python3
"""Validate NPU-focused formal evidence in the formal manifest."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FORMAL_MANIFEST = ROOT / "build/reports/formal_manifest.json"
HARNESS = ROOT / "verify/formal/e1_npu_formal.sv"
RTL = ROOT / "rtl/npu/e1_npu.sv"
REPORT = ROOT / "build/reports/npu_formal_coverage.json"

TARGET = "e1_npu"
EXPECTED = {
    "status": "pass",
    "evidence_class": "sby_bmc",
    "spec": "verify/formal/e1_npu.sby",
    "engine": "smtbmc bitwuzla",
    "task": {"mode": "bmc", "depth": "12"},
    "covered_files": {
        "rtl/npu/e1_npu.sv",
        "verify/formal/e1_npu_formal.sv",
        "verify/properties/axi_lite_protocol.sv",
        "verify/properties/npu_axil_bind.sv",
        "verify/properties/reset_properties.sv",
        "verify/properties/cdc_properties.sv",
    },
}

REQUIRED_HARNESS_TOKENS = (
    "a_gemm_dims_nonzero",
    "a_gemm_c_in_bounds",
    "a_gemm_busy_cfg_ok",
    "a_vec_src_window",
    "a_vec_dst_window",
    "a_desc_timeout_prelimit",
    "a_desc_empty_implies_no_pending",
    "a_desc_status_reserved_zero",
    "a_desc_bytes_read_monotonic",
    "a_desc_bytes_written_monotonic",
    "a_perf_scratch_monotonic",
)

REQUIRED_RTL_TOKENS = (
    "formal_gemm_busy",
    "formal_vec_busy",
    "formal_desc_timeout_count",
    "formal_desc_state",
    "gemm_cfg_ok",
    "gemm_runtime_addr_ok",
)


def write_report(status: str, errors: list[str], manifest: dict | None) -> None:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(
        json.dumps(
            {
                "schema": "eliza.npu_formal_coverage.v1",
                "status": status,
                "as_of": datetime.now(UTC).isoformat(),
                "generated_utc": datetime.now(UTC).isoformat(),
                "subsystem": "npu",
                "evidence_paths": [
                    "build/reports/formal_manifest.json",
                    "verify/formal/e1_npu.sby",
                    "verify/formal/e1_npu_formal.sv",
                    "rtl/npu/e1_npu.sv",
                    "verify/properties/npu_axil_bind.sv",
                    "verify/properties/axi_lite_protocol.sv",
                ],
                "phone_claim_allowed": False,
                "release_claim_allowed": False,
                "production_accelerator_claim_allowed": False,
                "nnapi_claim_allowed": False,
                "performance_claim_allowed": False,
                "full_npu_correctness_claim_allowed": False,
                "claim_boundary": (
                    "Checks that the formal manifest records the NPU SBY target as "
                    "passing with expected covered files, bitwuzla engine metadata, "
                    "depth-12 BMC task metadata, status/log hashes, and strict non-release "
                    "manifest flags. Also checks that the harness and RTL still expose the "
                    "formal-only GEMM/vector/descriptor observability and bounded safety "
                    "assertions. This is bounded local NPU formal evidence only; it is not "
                    "production accelerator, full correctness, NNAPI, model throughput, "
                    "power, driver, SoC-fabric, or release evidence."
                ),
                "expected": {
                    **EXPECTED,
                    "covered_files": sorted(EXPECTED["covered_files"]),
                },
                "required_harness_tokens": list(REQUIRED_HARNESS_TOKENS),
                "required_rtl_tokens": list(REQUIRED_RTL_TOKENS),
                "formal_manifest_mode": None if manifest is None else manifest.get("mode"),
                "errors": errors,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )


def validate_manifest(manifest: dict) -> list[str]:
    errors: list[str] = []
    if manifest.get("fallback_equivalent_to_sby") is not False:
        errors.append("formal manifest must keep fallback_equivalent_to_sby=false")
    if manifest.get("deep_top_required_for_release") is not True:
        errors.append("formal manifest must keep deep_top_required_for_release=true")
    if manifest.get("strict_release_claim_allowed") is not False:
        errors.append("NPU formal coverage check requires non-release routine formal manifest")

    raw_entries = manifest.get("entries")
    entries: dict[str, object] = raw_entries if isinstance(raw_entries, dict) else {}
    entry = entries.get(TARGET)
    if not isinstance(entry, dict):
        return errors + [f"formal manifest missing {TARGET}"]

    if entry.get("status") != EXPECTED["status"]:
        errors.append(f"{TARGET} status must be {EXPECTED['status']}")
    if entry.get("evidence_class") != EXPECTED["evidence_class"]:
        errors.append(f"{TARGET} evidence_class must be {EXPECTED['evidence_class']}")

    raw_paths = entry.get("paths")
    paths: dict[str, object] = raw_paths if isinstance(raw_paths, dict) else {}
    for key in ("status", "status_sha256", "log", "log_sha256"):
        if key not in paths:
            errors.append(f"{TARGET} paths missing {key}")

    raw_sby = entry.get("sby")
    sby: dict[str, object] = raw_sby if isinstance(raw_sby, dict) else {}
    if sby.get("spec") != EXPECTED["spec"]:
        errors.append(f"{TARGET} spec must be {EXPECTED['spec']}")
    raw_engines = sby.get("engines")
    engines_list: list[object] = (
        list(raw_engines) if isinstance(raw_engines, (list, tuple, set)) else []
    )
    if EXPECTED["engine"] not in engines_list:
        errors.append(f"{TARGET} must record {EXPECTED['engine']} engine")
    raw_covered = sby.get("covered_files")
    covered: set[str] = set(raw_covered) if isinstance(raw_covered, (list, tuple, set)) else set()
    expected_files: set[str] = EXPECTED["covered_files"]  # type: ignore[assignment]
    missing_files = sorted(expected_files - covered)
    if missing_files:
        errors.append(f"{TARGET} missing covered_files: {', '.join(missing_files)}")

    raw_tasks = sby.get("tasks")
    tasks_dict: dict[str, object] = raw_tasks if isinstance(raw_tasks, dict) else {}
    task_meta = tasks_dict.get("default")
    if not isinstance(task_meta, dict):
        errors.append(f"{TARGET} missing default task")
    else:
        expected_task: dict[str, str] = EXPECTED["task"]  # type: ignore[assignment]
        for key, value in expected_task.items():
            if str(task_meta.get(key)) != value:
                errors.append(f"{TARGET} default task {key} must be {value}")
    return errors


def missing_tokens(path: Path, tokens: tuple[str, ...]) -> list[str]:
    if not path.is_file():
        return [f"missing file {path.relative_to(ROOT)}"]
    text = path.read_text(encoding="utf-8", errors="ignore")
    return [token for token in tokens if token not in text]


def main() -> int:
    if not FORMAL_MANIFEST.is_file():
        write_report("BLOCKED", [f"missing {FORMAL_MANIFEST.relative_to(ROOT)}"], None)
        print("BLOCKED: formal manifest missing")
        return 1

    manifest = json.loads(FORMAL_MANIFEST.read_text(encoding="utf-8"))
    errors = validate_manifest(manifest)
    harness_missing = missing_tokens(HARNESS, REQUIRED_HARNESS_TOKENS)
    if harness_missing:
        errors.append("NPU formal harness missing token(s): " + ", ".join(harness_missing))
    rtl_missing = missing_tokens(RTL, REQUIRED_RTL_TOKENS)
    if rtl_missing:
        errors.append("NPU RTL missing formal token(s): " + ", ".join(rtl_missing))

    if errors:
        write_report("BLOCKED", errors, manifest)
        print("BLOCKED: NPU formal coverage check failed")
        for error in errors:
            print(f"  - {error}")
        return 1

    write_report("PASS", [], manifest)
    print("PASS: NPU formal coverage manifest check")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
