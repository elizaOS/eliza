#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
MATRIX = (
    ROOT / "docs/project/product-architecture-security-radio-sensors-optimization-2026-05-17.yaml"
)
GAPS = ROOT / "docs/manufacturing/real-world-verification-gaps.yaml"

REQUIRED_DOMAINS = {
    "product_architecture",
    "security_secure_boot",
    "cellular_radio",
    "wifi_bluetooth_gnss_nfc",
    "camera_isp",
    "audio",
    "sensors_input_haptics",
    "usb_storage_update",
    "battery_pmic_thermal",
    "privacy",
    "regulatory_sar_ptcrb_fcc",
    "factory_test",
    "mobile_platform_android",
}

REQUIRED_SOURCES = {
    "android_cdd",
    "android_verified_boot",
    "android_keystore_keymint",
    "android_sensors_hal",
    "android_health_hal",
    "android_usb_hal",
    "android_wifi_hal",
    "android_bluetooth",
    "android_radio_aidl",
    "bluetooth_qualification",
    "ptcrb_certification",
    "usb_if_marks",
}
FALSE_CLAIM_FLAGS = {
    "claim_allowed",
    "phone_claim_allowed",
    "release_claim_allowed",
    "android_compatibility_claim_allowed",
    "certification_claim_allowed",
    "secure_boot_claim_allowed",
    "silicon_claim_allowed",
    "production_readiness_claim_allowed",
}


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_yaml(path: Path, errors: list[str]) -> dict:
    if not path.is_file():
        errors.append(f"missing required artifact: {rel(path)}")
        return {}
    data = yaml.safe_load(path.read_text())
    if not isinstance(data, dict):
        errors.append(f"{rel(path)} must be a YAML mapping")
        return {}
    return data


def require_repo_path(path: str, field: str, errors: list[str]) -> None:
    candidate = Path(path)
    if candidate.is_absolute() or ".." in candidate.parts:
        errors.append(f"{field} must be a relative repo path: {path}")
        return
    migrated_candidate = ROOT / "docs" / candidate
    if not (ROOT / candidate).exists() and not migrated_candidate.exists():
        errors.append(f"{field} points at missing repo artifact: {path}")


def check_sources(data: dict, errors: list[str]) -> None:
    sources = data.get("primary_sources")
    if not isinstance(sources, dict):
        errors.append("primary_sources must be a mapping")
        return
    missing = sorted(REQUIRED_SOURCES - set(sources))
    if missing:
        errors.append("primary_sources missing: " + ", ".join(missing))
    for source_id, source in sources.items():
        if not isinstance(source, dict):
            errors.append(f"primary_sources.{source_id} must be a mapping")
            continue
        url = source.get("url")
        relevance = source.get("relevance")
        if not isinstance(url, str) or not url.startswith("https://"):
            errors.append(f"primary_sources.{source_id}.url must be an https URL")
        if not isinstance(relevance, str) or len(relevance.split()) < 5:
            errors.append(f"primary_sources.{source_id}.relevance must explain source usage")


def check_domains(data: dict, gap_ids: set[str], errors: list[str]) -> None:
    domains = data.get("domains")
    if not isinstance(domains, list):
        errors.append("domains must be a list")
        return
    ids = {domain.get("id") for domain in domains if isinstance(domain, dict)}
    missing = sorted(REQUIRED_DOMAINS - ids)
    if missing:
        errors.append("domains missing: " + ", ".join(missing))

    for index, domain in enumerate(domains):
        if not isinstance(domain, dict):
            errors.append(f"domains[{index}] must be a mapping")
            continue
        domain_id = domain.get("id", f"domains[{index}]")
        if domain_id not in REQUIRED_DOMAINS:
            errors.append(f"{domain_id}: unknown domain id")

        status = str(domain.get("current_status", ""))
        if "blocked" not in status:
            errors.append(f"{domain_id}: current_status must remain explicitly blocked")

        gap_id = domain.get("release_gap_id")
        if not isinstance(gap_id, str) or gap_id not in gap_ids:
            errors.append(f"{domain_id}: release_gap_id must point at real-world gap manifest")

        for field, minimum in (
            ("current_repo_evidence", 2),
            ("scale_optimization", 3),
            ("power_size_manufacturing_tradeoff", 2),
            ("verification_gates", 3),
            ("optimization_backlog", 3),
        ):
            value = domain.get(field)
            if not isinstance(value, list) or len(value) < minimum:
                errors.append(f"{domain_id}: {field} must list at least {minimum} items")
                continue
            if field == "current_repo_evidence":
                for path in value:
                    if isinstance(path, str):
                        require_repo_path(path, f"{domain_id}.{field}", errors)
                    else:
                        errors.append(f"{domain_id}.{field} entries must be paths")

        backlog_items = domain.get("optimization_backlog", [])
        for priority in ("P0", "P1"):
            if not any(
                (isinstance(item, str) and item.startswith(f"{priority}:"))
                or (isinstance(item, dict) and priority in item)
                for item in backlog_items
            ):
                errors.append(f"{domain_id}: optimization_backlog must include {priority}: entries")


def main() -> int:
    errors: list[str] = []
    data = load_yaml(MATRIX, errors)
    gaps = load_yaml(GAPS, errors)

    if data:
        if data.get("schema") != "eliza.product_arch_security_radio_sensors_optimization.v1":
            errors.append("product architecture optimization matrix has wrong schema")
        if data.get("status") != "fail_closed_product_work_order":
            errors.append(
                "product architecture optimization matrix must remain fail_closed_product_work_order"
            )
        boundary = data.get("claim_boundary")
        if not isinstance(boundary, str) or "not evidence" not in boundary:
            errors.append("claim_boundary must state the matrix is not evidence of completion")
        for flag in sorted(FALSE_CLAIM_FLAGS):
            if data.get(flag) is not False:
                errors.append(f"{flag} must be false")
        policy = data.get("evidence_policy")
        if not isinstance(policy, dict) or "release_claims_forbidden_until" not in policy:
            errors.append("evidence_policy must list release_claims_forbidden_until")
        check_sources(data, errors)

    gap_ids: set[str] = set()
    for gap in gaps.get("gaps", []):
        if not isinstance(gap, dict):
            continue
        gap_id = gap.get("id")
        if isinstance(gap_id, str):
            gap_ids.add(gap_id)
    if data and gap_ids:
        check_domains(data, gap_ids, errors)

    if errors:
        print("Product architecture optimization check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1

    print("product architecture/security/radio/sensors optimization matrix is fail-closed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
