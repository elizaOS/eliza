#!/usr/bin/env python3
"""Check the E1 clock/reset-domain intent manifest against local RTL."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "docs/spec-db/e1-clock-reset-domain-intent.yaml"
EXPECTED_SCHEMA = "eliza.clock_reset_domain_intent.v1"
EXPECTED_CLAIM_BOUNDARY = "intent_manifest_only_not_cdc_rdc_signoff"
REQUIRED_GATES = {
    "python3 scripts/check_cdc_rdc_intent.py",
    "python3 scripts/ai_eda/capture_cdc_rdc_targets.py --run-id validation",
    "make cdc-rdc-intent-check",
    "make rtl-check",
    "make formal",
    "make cocotb-contract",
    "make no-hardware-action-check",
}
REQUIRED_RTL_TOKENS = {
    "rtl/top/e1_chip_top.sv": [
        "CLK_IN",
        "RST_N",
        "rst_n_sync",
        "u_reset_sync",
        "e1_reset_sync",
        "DBG_VALID",
        "jtag_tdo_oe",
        "assign JTAG_TDO = jtag_tdo_oe ? jtag_tdo : 1'b0",
    ],
    "rtl/clock/e1_reset_sync.sv": [
        "module e1_reset_sync",
        "rst_n_async",
        "rst_n_sync",
        "always_ff @(posedge clk or negedge rst_n_async)",
    ],
}
FALSE_CLAIM_FLAGS = {
    "generated_constraints_allowed": False,
    "generated_waivers_allowed": False,
    "generated_rtl_allowed": False,
    "cdc_signoff_claim_allowed": False,
    "rdc_signoff_claim_allowed": False,
}


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


def check_path(path_text: str, errors: list[str]) -> None:
    path = ROOT / path_text
    if not path.is_file():
        fail(errors, f"referenced path is missing: {path_text}")


def check_rtl_tokens(errors: list[str]) -> None:
    for path_text, tokens in REQUIRED_RTL_TOKENS.items():
        path = ROOT / path_text
        if not path.is_file():
            fail(errors, f"RTL file is missing: {path_text}")
            continue
        text = path.read_text()
        for token in tokens:
            if token not in text:
                fail(errors, f"{path_text} missing required token: {token}")


def check_policy(manifest: dict[str, Any], errors: list[str]) -> None:
    policy = require_mapping(manifest.get("ai_use_policy"), "ai_use_policy", errors)
    for key in (
        "generated_constraints_allowed",
        "generated_waivers_allowed",
        "generated_rtl_allowed",
        "cdc_signoff_claim_allowed",
        "rdc_signoff_claim_allowed",
    ):
        if policy.get(key) is not False:
            fail(errors, f"ai_use_policy.{key} must be false")
    if policy.get("false_claim_flags") != FALSE_CLAIM_FLAGS:
        fail(errors, "ai_use_policy.false_claim_flags must match denied CDC/RDC claims")


def check_domains(manifest: dict[str, Any], errors: list[str]) -> None:
    domains = require_list(manifest.get("clock_domains"), "clock_domains", errors)
    domain_ids = {domain.get("id") for domain in domains if isinstance(domain, dict)}
    default_domain = manifest.get("default_clock_domain")
    if default_domain not in domain_ids:
        fail(errors, "default_clock_domain must reference a listed clock domain")
    if "e1_clk" not in domain_ids:
        fail(errors, "clock_domains must include e1_clk")

    for domain in domains:
        domain_map = require_mapping(domain, "clock_domains[]", errors)
        if domain_map.get("source") == "CLK_IN" and domain_map.get("reset") != "rst_n_sync":
            fail(errors, "CLK_IN domain must use rst_n_sync reset")
        for path_text in require_list(
            domain_map.get("source_files"), "clock_domains[].source_files", errors
        ):
            if isinstance(path_text, str):
                check_path(path_text, errors)
            else:
                fail(errors, "clock_domains[].source_files entries must be strings")


def check_resets(manifest: dict[str, Any], errors: list[str]) -> None:
    resets = require_list(manifest.get("resets"), "resets", errors)
    reset_ids = {reset.get("id") for reset in resets if isinstance(reset, dict)}
    for required in ("RST_N", "rst_n_sync"):
        if required not in reset_ids:
            fail(errors, f"resets must include {required}")
    for reset in resets:
        reset_map = require_mapping(reset, "resets[]", errors)
        if reset_map.get("id") == "RST_N":
            if reset_map.get("kind") != "external_async_reset":
                fail(errors, "RST_N must be captured as external_async_reset")
            if reset_map.get("accepted_at_top") is not True:
                fail(errors, "RST_N must be accepted_at_top")
            if reset_map.get("instance") != "u_reset_sync":
                fail(errors, "RST_N must be synchronized by u_reset_sync")
        if reset_map.get("polarity") != "active_low":
            fail(errors, f"{reset_map.get('id')} must be active_low")


def check_interface_assumptions(manifest: dict[str, Any], errors: list[str]) -> None:
    assumptions = require_list(
        manifest.get("external_interface_assumptions"),
        "external_interface_assumptions",
        errors,
    )
    by_id = {item.get("id"): item for item in assumptions if isinstance(item, dict)}
    debug = by_id.get("debug_mmio_pins")
    if not isinstance(debug, dict):
        fail(errors, "external_interface_assumptions must include debug_mmio_pins")
    elif debug.get("assumption") != "synchronous_to_CLK_IN":
        fail(errors, "debug_mmio_pins must be synchronous_to_CLK_IN")
    for item in assumptions:
        item_map = require_mapping(item, "external_interface_assumptions[]", errors)
        if item_map.get("cdc_signoff_claim") is not False:
            fail(errors, f"{item_map.get('id')} must not claim CDC signoff")


def main() -> int:
    errors: list[str] = []
    if not MANIFEST.is_file():
        fail(errors, f"manifest missing: {MANIFEST.relative_to(ROOT)}")
    else:
        manifest = require_mapping(
            yaml.safe_load(MANIFEST.read_text()),
            "manifest",
            errors,
        )
        if manifest.get("schema") != EXPECTED_SCHEMA:
            fail(errors, "unexpected schema")
        if manifest.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
            fail(errors, "unsafe claim boundary")
        if manifest.get("status") != "DRAFT_CAPTURE_ONLY":
            fail(errors, "status must be DRAFT_CAPTURE_ONLY")
        top = manifest.get("top")
        if not isinstance(top, str):
            fail(errors, "top must be a path string")
        else:
            check_path(top, errors)
        check_domains(manifest, errors)
        check_resets(manifest, errors)
        check_interface_assumptions(manifest, errors)
        check_policy(manifest, errors)
        gates = set(require_list(manifest.get("evidence_gates"), "evidence_gates", errors))
        missing_gates = sorted(REQUIRED_GATES - gates)
        if missing_gates:
            fail(errors, f"missing evidence gates: {', '.join(missing_gates)}")

    check_rtl_tokens(errors)
    if errors:
        print("\n".join(errors))
        return 1
    print("STATUS: PASS cdc_rdc_intent docs/spec-db/e1-clock-reset-domain-intent.yaml")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
