#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORK_ORDER = (
    ROOT / "docs/project/security-usb-storage-update-fail-closed-work-order-2026-05-17.yaml"
)
GAPS = ROOT / "docs/manufacturing/real-world-verification-gaps.yaml"
PRODUCT_FEATURES = ROOT / "docs/manufacturing/product-feature-evidence-manifest.yaml"
AOSP_README = ROOT / "docs/sw/aosp-device/README.md"
AOSP_FSTAB = ROOT / "sw/aosp-device/device/eliza/eliza_ai_soc/fstab.eliza"
BOARD_CONFIG = ROOT / "sw/aosp-device/device/eliza/eliza_ai_soc/BoardConfig.mk"

REQUIRED_DOMAINS = {
    "secure_boot_key_debug_policy",
    "usb_storage_update_stack",
}

REQUIRED_NEGATIVE_TERMS = {
    "secure_boot_key_debug_policy": {
        "unsigned",
        "tampered",
        "wrong-key",
        "rollback",
        "corrupt",
        "debug unlock denied",
        "missing or erased key",
    },
    "usb_storage_update_stack": {
        "bad ota payload signature",
        "rollback ota",
        "interrupted install",
        "full-storage",
        "low-battery",
        "unauthorized fastboot",
        "corrupt slot metadata",
    },
}

REQUIRED_FORBIDDEN_TERMS = {
    "secure_boot_key_debug_policy": {
        "secure boot enabled.",
        "verified boot complete.",
        "debug locked.",
        "rollback protected.",
    },
    "usb_storage_update_stack": {
        "usb-c ready.",
        "usb compliant.",
        "storage ready.",
        "avb enabled.",
        "a/b ota ready.",
        "recovery ready.",
        "fastboot secure.",
    },
}

SECURITY_DOC_TERMS = [
    "fail-closed scaffold only",
    "identity/contract ROM",
    "not production ROM code",
    "Do not claim secure boot",
    "Unsigned, tampered, wrong-key",
    "rollback image rejection",
    "Debug locked",
]

BOOT_DOC_TERMS = [
    "Secure boot product evidence is not available",
    "authenticate a signature",
    "enforce rollback indexes",
    "select A/B slots",
    "validate recovery/OTA",
    "fail closed before mutable firmware",
]

AOSP_README_TERMS = [
    "AVB/A-B/recovery/OTA local status",
    "fail-closed scaffold only",
    "does not define AVB keys",
    "Do not claim AVB",
    "bad signatures",
    "unauthorized flashing",
]
FALSE_CLAIM_FLAGS = {
    "secure_boot_claim_allowed": False,
    "usb_c_pd_claim_allowed": False,
    "storage_claim_allowed": False,
    "avb_claim_allowed": False,
    "ab_ota_claim_allowed": False,
    "recovery_claim_allowed": False,
    "fastboot_security_claim_allowed": False,
    "release_claim_allowed": False,
}


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_yaml(path: Path, failures: list[str]) -> dict:
    if not path.is_file():
        failures.append(f"missing required artifact: {rel(path)}")
        return {}
    data = yaml.safe_load(path.read_text())
    if not isinstance(data, dict):
        failures.append(f"{rel(path)} must be a YAML mapping")
        return {}
    return data


def require_repo_path(path: str, field: str, failures: list[str], *, must_exist: bool) -> None:
    candidate = Path(path)
    if candidate.is_absolute() or ".." in candidate.parts:
        failures.append(f"{field} must be a relative repo path: {path}")
        return
    if must_exist and not (ROOT / candidate).exists():
        failures.append(f"{field} points at missing repo artifact: {path}")


def require_text_terms(path: Path, terms: list[str], failures: list[str]) -> None:
    if not path.is_file():
        failures.append(f"missing required text artifact: {rel(path)}")
        return
    text = path.read_text(errors="ignore")
    missing = [term for term in terms if term not in text]
    if missing:
        failures.append(f"{rel(path)} missing fail-closed terms: " + ", ".join(missing))


def check_work_order(data: dict, gap_ids: set[str], failures: list[str]) -> None:
    if data.get("schema") != "eliza.security_usb_storage_update_fail_closed_work_order.v1":
        failures.append("security/USB/update work order has wrong schema")
    if data.get("status") != "fail_closed_work_order":
        failures.append("security/USB/update work order must remain fail_closed_work_order")
    for flag, expected in FALSE_CLAIM_FLAGS.items():
        if data.get(flag) is not expected:
            failures.append(f"{flag} must be false")
    boundary = data.get("claim_boundary")
    if (
        not isinstance(boundary, str)
        or "not implementation evidence" not in boundary
        or "not available" not in boundary
    ):
        failures.append(
            "claim_boundary must state this is not implementation evidence and not available"
        )

    source_files = data.get("source_files")
    if not isinstance(source_files, list):
        failures.append("source_files must be a list")
    else:
        for source in source_files:
            if not isinstance(source, str):
                failures.append("source_files entries must be repo paths")
            else:
                require_repo_path(source, "source_files", failures, must_exist=True)

    domains = data.get("domains")
    if not isinstance(domains, list):
        failures.append("domains must be a list")
        return

    seen: set[str] = set()
    for index, domain in enumerate(domains):
        if not isinstance(domain, dict):
            failures.append(f"domains[{index}] must be a mapping")
            continue
        domain_id = domain.get("id")
        if not isinstance(domain_id, str):
            failures.append(f"domains[{index}].id must be a string")
            continue
        seen.add(domain_id)
        if domain_id not in REQUIRED_DOMAINS:
            failures.append(f"{domain_id}: unknown domain id")
            continue
        if "blocked" not in str(domain.get("status", "")):
            failures.append(f"{domain_id}: status must remain blocked")
        if domain.get("release_gap_id") not in gap_ids:
            failures.append(f"{domain_id}: release_gap_id must exist in real-world gap manifest")
        if domain.get("local_check") != "scripts/check_security_usb_update_work_order.py":
            failures.append(f"{domain_id}: local_check must point at this checker")

        for field, minimum in (
            ("evidence_paths", 1),
            ("required_work_orders", 4),
            ("required_negative_evidence", 7),
            ("required_positive_evidence", 4),
            ("forbidden_claims", 4),
        ):
            values = domain.get(field)
            if not isinstance(values, list) or len(values) < minimum:
                failures.append(f"{domain_id}.{field} must list at least {minimum} items")
                continue
            for item in values:
                if not isinstance(item, str) or not item.strip():
                    failures.append(f"{domain_id}.{field} entries must be non-empty strings")
            if field == "evidence_paths":
                for path in values:
                    if isinstance(path, str):
                        require_repo_path(path, f"{domain_id}.{field}", failures, must_exist=False)

        negative_text = " ".join(
            str(item).lower() for item in domain.get("required_negative_evidence", [])
        )
        missing_negative = sorted(
            term for term in REQUIRED_NEGATIVE_TERMS[domain_id] if term not in negative_text
        )
        if missing_negative:
            failures.append(
                f"{domain_id}: required_negative_evidence missing terms: "
                + ", ".join(missing_negative)
            )

        forbidden = {str(item).lower() for item in domain.get("forbidden_claims", [])}
        missing_forbidden = sorted(REQUIRED_FORBIDDEN_TERMS[domain_id] - forbidden)
        if missing_forbidden:
            failures.append(
                f"{domain_id}: forbidden_claims missing: " + ", ".join(missing_forbidden)
            )

    missing_domains = sorted(REQUIRED_DOMAINS - seen)
    if missing_domains:
        failures.append("work order missing domains: " + ", ".join(missing_domains))


def check_cross_links(failures: list[str]) -> None:
    feature_data = load_yaml(PRODUCT_FEATURES, failures)
    if feature_data:
        by_gap = {
            domain.get("release_gap_id"): domain
            for domain in feature_data.get("domains", [])
            if isinstance(domain, dict)
        }
        secure = by_gap.get("secure_boot_key_debug_policy", {})
        usb = by_gap.get("usb_storage_update_stack", {})
        if "unsigned image rejection" not in " ".join(secure.get("release_evidence", [])).lower():
            failures.append(
                "product feature manifest must name unsigned secure-boot rejection evidence"
            )
        usb_evidence = " ".join(usb.get("release_evidence", []))
        for term in ["AVB", "OTA success/failure", "rollback", "recovery"]:
            if term not in usb_evidence:
                failures.append(f"product feature manifest USB evidence must name {term}")

    fstab_text = AOSP_FSTAB.read_text(errors="ignore") if AOSP_FSTAB.is_file() else ""
    if "slotselect,avb" not in fstab_text:
        failures.append("AOSP fstab must keep visible slotselect,avb scaffold marker for /vendor")
    if "not AVB, A/B, recovery, OTA, rollback" not in fstab_text:
        failures.append("AOSP fstab must state AVB/A-B/recovery/OTA flags are not evidence")

    board_text = BOARD_CONFIG.read_text(errors="ignore") if BOARD_CONFIG.is_file() else ""
    forbidden_board_claims = [
        "BOARD_AVB_ENABLE := true",
        "AB_OTA_UPDATER := true",
        "TARGET_RECOVERY",
        "BOARD_USES_RECOVERY_AS_BOOT := true",
    ]
    for term in forbidden_board_claims:
        if term in board_text:
            failures.append(f"BoardConfig.mk must not claim {term} without external evidence")


def main() -> int:
    failures: list[str] = []
    work_order = load_yaml(WORK_ORDER, failures)
    gaps = load_yaml(GAPS, failures)
    gap_ids: set[str] = {
        str(gap.get("id"))
        for gap in gaps.get("gaps", [])
        if isinstance(gap, dict) and isinstance(gap.get("id"), str)
    }

    if work_order:
        check_work_order(work_order, gap_ids, failures)
    require_text_terms(ROOT / "docs/arch/security.md", SECURITY_DOC_TERMS, failures)
    require_text_terms(ROOT / "docs/arch/boot.md", BOOT_DOC_TERMS, failures)
    require_text_terms(AOSP_README, AOSP_README_TERMS, failures)
    check_cross_links(failures)

    if failures:
        print("Security/USB/storage/update fail-closed work order check failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("security/USB/storage/update work order is fail-closed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
