#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from chip_utils import load_yaml_object, require

ROOT = Path(__file__).resolve().parents[1]
SECURITY_SPEC = ROOT / "docs/spec-db/security-2028-target.yaml"
PRODUCT_FEATURES = ROOT / "docs/manufacturing/product-feature-evidence-manifest.yaml"
BOOT_ROM_SPEC = ROOT / "docs/arch/boot-rom-spec.md"
LIFECYCLE_RTL = ROOT / "rtl/security/e1_lifecycle.sv"
LIFECYCLE_TEST = ROOT / "verify/cocotb/test_e1_lifecycle.py"
OUT = ROOT / "build/reports/security_lifecycle_scope.json"


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def contains_all(text: str, tokens: tuple[str, ...]) -> bool:
    lowered = text.lower()
    return all(token.lower() in lowered for token in tokens)


def domain_by_id(domains: list[Any], domain_id: str) -> dict[str, Any]:
    for domain in domains:
        if isinstance(domain, dict) and domain.get("id") == domain_id:
            return domain
    return {}


def forbidden_claims(spec: dict[str, Any]) -> set[str]:
    rows = spec.get("forbidden_claims_until_evidence")
    if not isinstance(rows, list):
        return set()
    return {str(row.get("claim", "")) for row in rows if isinstance(row, dict)}


def build_report() -> dict[str, Any]:
    security = load_yaml_object(SECURITY_SPEC)
    product_features = load_yaml_object(PRODUCT_FEATURES)
    boot_rom_spec = BOOT_ROM_SPEC.read_text(encoding="utf-8")
    lifecycle_rtl = LIFECYCLE_RTL.read_text(encoding="utf-8")
    lifecycle_test = LIFECYCLE_TEST.read_text(encoding="utf-8")

    domains = product_features.get("domains")
    if not isinstance(domains, list):
        raise ValueError("product feature manifest must list domains")
    security_domain = domain_by_id(domains, "secure_boot_tee_debug")
    claims = forbidden_claims(security)
    required_claims = {
        "secure_boot",
        "verified_boot",
        "rollback_protected",
        "debug_locked",
        "keymint_backed",
        "strongbox",
        "pq_safe",
    }

    checks = [
        {
            "id": "security_target_forbids_release_claims",
            "status": "pass" if required_claims.issubset(claims) else "fail",
            "evidence": rel(SECURITY_SPEC),
        },
        {
            "id": "synthetic_otp_non_production_scope_present",
            "status": "pass"
            if "production_lockable_part" in str(security.get("synthetic_otp_prototype", {}))
            else "fail",
            "evidence": rel(SECURITY_SPEC),
        },
        {
            "id": "lifecycle_rtl_placeholder_key_visible",
            "status": "pass"
            if contains_all(
                lifecycle_rtl,
                ("DEVICE_KEY_PLACEHOLDER", "Placeholder device key", "not rtl"),
            )
            or contains_all(
                lifecycle_rtl,
                ("DEVICE_KEY_PLACEHOLDER", "Placeholder device key", "real device"),
            )
            else "fail",
            "evidence": rel(LIFECYCLE_RTL),
        },
        {
            "id": "top_level_lifecycle_window_absent",
            "status": "pass"
            if contains_all(
                lifecycle_test,
                ("absent_lifecycle_security_window_fails_unmapped", "0xDEAD_BEEF"),
            )
            else "fail",
            "evidence": rel(LIFECYCLE_TEST),
        },
        {
            "id": "boot_rom_spec_negative_cases_present",
            "status": "pass"
            if contains_all(
                boot_rom_spec,
                ("unsigned", "tampered", "wrong-key", "rollback-too-low", "debug-unlock-denied"),
            )
            else "fail",
            "evidence": rel(BOOT_ROM_SPEC),
        },
        {
            "id": "product_security_domain_release_blocked",
            "status": "pass"
            if "blocked" in str(security_domain.get("status", ""))
            and contains_all(
                " ".join(str(item) for item in security_domain.get("release_evidence", [])),
                ("signed boot", "rollback", "debug", "key", "device identity"),
            )
            else "fail",
            "evidence": "docs/manufacturing/product-feature-evidence-manifest.yaml#secure_boot_tee_debug",
        },
    ]
    return {
        "schema": "eliza.security_lifecycle_scope.v1",
        "status": "security_lifecycle_scope_release_blocked",
        "claim_boundary": (
            "Security lifecycle scope audit only; not secure boot, not verified boot, "
            "not rollback protection, not debug lock, not production OTP, not KeyMint, "
            "not TEE, not StrongBox, not attestation, and not silicon security evidence."
        ),
        "current_scaffold": {
            "lifecycle_rtl": rel(LIFECYCLE_RTL),
            "top_level_access": "absent_unmapped_in_current_cocotb_contract",
            "device_key": "placeholder_non_secret",
            "synthetic_otp": "non_production_only",
        },
        "blocked_until_real_evidence": [
            "OpenTitan-class rom_ctrl/lc_ctrl/otp_ctrl/otbn integration and DV",
            "signed boot acceptance and unsigned image rejection transcript",
            "AVB/libavb verified boot and dm-verity transcript",
            "rollback index write/read and rollback rejection transcript",
            "debug authorization denial in PROD and RMA key-erasure transcript",
            "threat model, key ceremony, signer/HSM, fuse/OTP, and provisioning evidence",
        ],
        "checks": checks,
        "summary": {
            "check_count": len(checks),
            "passing_check_count": len([check for check in checks if check["status"] == "pass"]),
            "release_claim_allowed": False,
        },
    }


def validate_report(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    require(
        data.get("schema") == "eliza.security_lifecycle_scope.v1",
        "schema mismatch",
        errors,
    )
    require(
        data.get("status") == "security_lifecycle_scope_release_blocked",
        "status must remain security_lifecycle_scope_release_blocked",
        errors,
    )
    boundary = str(data.get("claim_boundary", ""))
    for token in (
        "not secure boot",
        "not verified boot",
        "not rollback protection",
        "not debug lock",
        "not production OTP",
        "not KeyMint",
        "not silicon security evidence",
    ):
        require(token in boundary, f"claim boundary missing {token}", errors)
    summary = data.get("summary")
    if not isinstance(summary, dict):
        errors.append("summary must be a mapping")
        return errors
    require(
        summary.get("release_claim_allowed") is False,
        "release_claim_allowed must stay false",
        errors,
    )
    checks = data.get("checks")
    if not isinstance(checks, list) or not checks:
        errors.append("checks must be a non-empty list")
        return errors
    for check in checks:
        if not isinstance(check, dict):
            errors.append("checks entries must be mappings")
            continue
        if check.get("status") != "pass":
            errors.append(f"{check.get('id')}: must pass structural scope check")
    blocked = data.get("blocked_until_real_evidence")
    if not isinstance(blocked, list) or len(blocked) < 6:
        errors.append("security scope must enumerate blocked real-evidence items")
    scaffold = data.get("current_scaffold")
    if not isinstance(scaffold, dict):
        errors.append("current_scaffold must be a mapping")
    else:
        require(
            scaffold.get("device_key") == "placeholder_non_secret",
            "current scaffold must expose placeholder key status",
            errors,
        )
        require(
            scaffold.get("top_level_access") == "absent_unmapped_in_current_cocotb_contract",
            "current scaffold must preserve absent top-level lifecycle access",
            errors,
        )
    return errors


def main() -> int:
    report = build_report()
    errors = validate_report(report)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print(f"Security lifecycle scope check passed: {rel(OUT)} remains release-blocked.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
