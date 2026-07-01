#!/usr/bin/env python3
"""Check the local E1 waveform-debug policy for future AI/EDA debug tools.

The policy governs how an automated debug agent may read simulation
waveforms (VCD/FST) when triaging RTL. It is intentionally read-only:
no waveform-derived root-cause or fix may be claimed past the documented
``claim_boundary``. The gate fails closed when the manifest is missing,
the schema/claim-boundary drift, or any required allowlist or promotion
gate is absent.
"""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
from typing import Any

from chip_utils import load_yaml_object

ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / "docs/spec-db/e1-waveform-debug-policy.yaml"
PROVENANCE = ROOT / "docs/evidence/verification/waveform-provenance.yaml"
EXPECTED_SCHEMA = "eliza.waveform_debug_policy.v1"
EXPECTED_PROVENANCE_SCHEMA = "eliza.waveform_provenance.v1"
EXPECTED_CLAIM_BOUNDARY = "waveform_debug_policy_only_no_ai_root_cause_or_fix_claim"
ALLOWED_FORMATS = ("vcd", "fst")

REQUIRED_FALSE_TOOL_FLAGS = (
    "generated_root_cause_allowed",
    "generated_fix_allowed",
    "generated_waiver_allowed",
    "automatic_signal_force_allowed",
    "export_waveform_to_hosted_model_allowed",
)
REQUIRED_FALSE_CLAIM_FLAGS = (
    "claim_allowed",
    "release_claim_allowed",
    "tapeout_claim_allowed",
    "ai_root_cause_claim_allowed",
    "ai_fix_claim_allowed",
    "coverage_closure_claim_allowed",
    "production_readiness_claim_allowed",
)
REQUIRED_WAVEFORM_ROOTS = (
    "build/reports/waveforms/",
    "build/ai_eda/waveform_debug/",
)
REQUIRED_BLOCKED_TASKS = frozenset(
    {
        "claim_root_cause",
        "claim_fix",
        "generate_rtl_patch",
        "generate_waiver",
        "force_signal",
        "modify_testbench",
        "export_waveform_to_hosted_model",
        "claim_coverage_closure",
        "claim_release_or_tapeout_readiness",
    }
)
REQUIRED_EVIDENCE_FIELDS = frozenset(
    {
        "waveform_path",
        "waveform_format",
        "waveform_sha256",
        "source_test",
        "rtl_source_hashes",
        "tool_revision",
        "command_log",
        "reviewer_disposition",
        "human_debug_reviewer",
    }
)
REQUIRED_PROMOTION_GATES = frozenset(
    {
        "python3 scripts/check_waveform_debug_policy.py",
        "make waveform-debug-policy-check",
        "make cocotb-contract",
        "make no-hardware-action-check",
    }
)


def fail(errors: list[str], message: str) -> None:
    errors.append(f"FAIL: {message}")


def require_mapping(value: Any, label: str, errors: list[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(errors, f"{label} must be a mapping")
        return {}
    return value


def require_list(value: Any, label: str, errors: list[str]) -> list[Any]:
    if not isinstance(value, list):
        fail(errors, f"{label} must be a list")
        return []
    return value


def check_tool_policy(policy: dict[str, Any], errors: list[str]) -> None:
    tool_policy = require_mapping(policy.get("tool_policy"), "tool_policy", errors)
    for key in REQUIRED_FALSE_TOOL_FLAGS:
        if tool_policy.get(key) is not False:
            fail(errors, f"tool_policy.{key} must be false")
    if tool_policy.get("local_read_only_query_allowed_after_review") is not True:
        fail(errors, "tool_policy.local_read_only_query_allowed_after_review must be true")


def check_allowlists(policy: dict[str, Any], errors: list[str]) -> None:
    roots = require_list(policy.get("allowed_waveform_roots"), "allowed_waveform_roots", errors)
    for required in REQUIRED_WAVEFORM_ROOTS:
        if required not in roots:
            fail(errors, f"allowed_waveform_roots must include {required}")

    formats = require_list(policy.get("allowed_formats"), "allowed_formats", errors)
    if "vcd" not in formats:
        fail(errors, "allowed_formats must include vcd")

    allowlists = require_list(policy.get("signal_allowlists"), "signal_allowlists", errors)
    seen_ids: set[str] = set()
    for entry in allowlists:
        entry_map = require_mapping(entry, "signal_allowlists[]", errors)
        entry_id = entry_map.get("id")
        if not isinstance(entry_id, str) or not entry_id:
            fail(errors, "signal_allowlists[] requires non-empty id")
            continue
        seen_ids.add(entry_id)
        signals = require_list(
            entry_map.get("signals"), f"signal_allowlists[{entry_id}].signals", errors
        )
        if len(signals) < 3:
            fail(errors, f"signal_allowlists[{entry_id}].signals must contain at least 3 entries")
        window = entry_map.get("max_time_window_cycles")
        if not isinstance(window, int) or isinstance(window, bool):
            fail(errors, f"signal_allowlists[{entry_id}].max_time_window_cycles must be an integer")
    for required in ("e1_soc_top", "e1_dbg_mmio_bridge"):
        if required not in seen_ids:
            fail(errors, f"missing signal allowlist {required}")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check_provenance(roots: list[Any], require_captures: bool, errors: list[str]) -> None:
    if not PROVENANCE.is_file():
        fail(errors, f"missing {PROVENANCE.relative_to(ROOT)}")
        return
    manifest = require_mapping(load_yaml_object(PROVENANCE), "waveform-provenance", errors)
    if manifest.get("schema") != EXPECTED_PROVENANCE_SCHEMA:
        fail(errors, "waveform-provenance unexpected schema")
    if manifest.get("claim_boundary") != "waveform_provenance_only_no_ai_root_cause_or_fix_claim":
        fail(errors, "waveform-provenance unsafe claim boundary")

    waveforms = require_list(manifest.get("waveforms"), "waveform-provenance.waveforms", errors)
    if require_captures and not waveforms:
        fail(
            errors,
            "waveform-provenance has no captured waveforms; capture one under an allowed root "
            "before promoting (status would remain blocked)",
        )

    allowed = tuple(str(root) for root in roots)
    for index, entry in enumerate(waveforms):
        label = f"waveform-provenance.waveforms[{index}]"
        entry_map = require_mapping(entry, label, errors)
        path_text = entry_map.get("waveform_path")
        if not isinstance(path_text, str) or not path_text:
            fail(errors, f"{label}.waveform_path must be a non-empty string")
        elif allowed and not any(path_text.startswith(root) for root in allowed):
            fail(errors, f"{label}.waveform_path {path_text} is outside allowed_waveform_roots")
        if entry_map.get("waveform_format") not in ALLOWED_FORMATS:
            fail(errors, f"{label}.waveform_format must be one of {ALLOWED_FORMATS}")
        if not isinstance(entry_map.get("waveform_sha256"), str):
            fail(errors, f"{label}.waveform_sha256 must be a string")
        if not isinstance(entry_map.get("source_test"), str):
            fail(errors, f"{label}.source_test must be a string")
        rtl_sources = require_list(entry_map.get("rtl_sources"), f"{label}.rtl_sources", errors)
        if not rtl_sources:
            fail(errors, f"{label}.rtl_sources must name at least one RTL source")
        for source in rtl_sources:
            source_map = require_mapping(source, f"{label}.rtl_sources[]", errors)
            src_path = source_map.get("path")
            recorded = source_map.get("sha256")
            if not isinstance(src_path, str):
                fail(errors, f"{label}.rtl_sources[].path must be a string")
                continue
            rtl_file = ROOT / src_path
            if not rtl_file.is_file():
                fail(errors, f"{label}.rtl_sources references missing file: {src_path}")
                continue
            live = sha256_file(rtl_file)
            if recorded != live:
                fail(
                    errors,
                    f"{label}.rtl_sources[{src_path}] sha256 drift: recorded {recorded} "
                    f"!= live {live}",
                )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--provenance",
        action="store_true",
        help="Require at least one captured waveform in the provenance ledger (promotion gate)",
    )
    args = parser.parse_args(argv)

    errors: list[str] = []
    if not POLICY.is_file():
        fail(errors, f"missing {POLICY.relative_to(ROOT)}")
        print("\n".join(errors))
        return 1

    policy = require_mapping(load_yaml_object(POLICY), "policy", errors)
    if policy.get("schema") != EXPECTED_SCHEMA:
        fail(errors, "unexpected schema")
    if policy.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        fail(errors, "unsafe claim boundary")
    if policy.get("status") != "DRAFT_CAPTURE_ONLY":
        fail(errors, "status must be DRAFT_CAPTURE_ONLY")
    for key in REQUIRED_FALSE_CLAIM_FLAGS:
        if policy.get(key) is not False:
            fail(errors, f"{key} must be false")

    check_tool_policy(policy, errors)
    check_allowlists(policy, errors)

    blocked = set(require_list(policy.get("blocked_tasks"), "blocked_tasks", errors))
    missing_blocked = sorted(REQUIRED_BLOCKED_TASKS - blocked)
    if missing_blocked:
        fail(errors, f"blocked_tasks missing: {', '.join(missing_blocked)}")

    evidence = set(
        require_list(policy.get("evidence_requirements"), "evidence_requirements", errors)
    )
    missing_evidence = sorted(REQUIRED_EVIDENCE_FIELDS - evidence)
    if missing_evidence:
        fail(errors, f"evidence_requirements missing: {', '.join(missing_evidence)}")

    gates = set(require_list(policy.get("promotion_gates"), "promotion_gates", errors))
    missing_gates = sorted(REQUIRED_PROMOTION_GATES - gates)
    if missing_gates:
        fail(errors, f"promotion_gates missing: {', '.join(missing_gates)}")

    check_provenance(
        require_list(policy.get("allowed_waveform_roots"), "allowed_waveform_roots", errors),
        args.provenance,
        errors,
    )

    if errors:
        print("\n".join(errors))
        return 1
    print("STATUS: PASS waveform_debug_policy docs/spec-db/e1-waveform-debug-policy.yaml")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
