#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "docs/manufacturing/product-feature-evidence-manifest.yaml"
GAPS = ROOT / "docs/manufacturing/real-world-verification-gaps.yaml"
SECURITY_SCOPE_REPORT = ROOT / "build/reports/security_lifecycle_scope.json"
SECURITY_SCOPE_CHECK = ROOT / "scripts/check_security_lifecycle_scope.py"
REPORT = ROOT / "build/reports/product_feature_gates.json"

REQUIRED_DOMAINS = {
    "modem_radio",
    "wifi_bluetooth_gnss_nfc",
    "camera_isp",
    "audio",
    "sensors_input_haptics",
    "usb_storage_update",
    "battery_pmic_thermal",
    "secure_boot_tee_debug",
    "privacy",
    "regulatory_sar_ptcrb_fcc",
    "factory_test",
}

REQUIRED_GAP_IDS = {
    "cellular_modem_stack",
    "wifi_bluetooth_gnss_nfc_stack",
    "camera_isp_stack",
    "audio_codec_dsp_stack",
    "sensors_input_haptics_stack",
    "usb_storage_update_stack",
    "battery_pmic_thermal_stack",
    "secure_boot_key_debug_policy",
    "privacy_data_protection_policy",
    "regulatory_compliance_release",
    "factory_test_provisioning_flow",
}

REQUIRED_METADATA = {
    "hardware_revision",
    "serial_or_board_id",
    "os_build_or_firmware_revision",
    "command_transcript",
    "timestamp",
    "operator",
    "pass_fail_criteria",
    "raw_log_path",
}

REQUIRED_FORBIDDEN_RELEASE_CLAIMS = {
    "CTS passed.",
    "VTS passed.",
    "GMS ready.",
    "Android product feature implemented.",
}

REQUIRED_ANDROID_RELEASE_EVIDENCE = {
    "CTS/VTS result archive for each declared Android HAL or feature.",
    "GMS/GTS certification or explicit non-GMS SKU waiver.",
    "Target-OS feature declaration diff tied to source/prebuilt HAL evidence.",
}
SCOPED_FAIL_CLOSED_DOMAINS = {
    "modem_radio",
    "wifi_bluetooth_gnss_nfc",
    "sensors_input_haptics",
    "battery_pmic_thermal",
}
REQUIRED_SCOPED_TOKENS = {
    "modem_radio": {
        "commands": ("mmcli", "ModemManager", "dumpsys telephony", "radio"),
        "release_evidence": ("SIM", "registration", "voice", "SMS", "suspend wake", "PTCRB", "SAR"),
        "unblock_requires": ("Selected modem", "Hardware transcript", "Android Radio", "PTCRB"),
        "android_policy": ("Radio AIDL", "VINTF", "SELinux", "VTS", "CTS"),
    },
    "wifi_bluetooth_gnss_nfc": {
        "commands": ("iw dev", "bluetoothctl", "gpspipe", "nfc-list", "dumpsys wifi"),
        "release_evidence": ("Wi-Fi", "Bluetooth", "GNSS", "NFC", "coexistence", "certification"),
        "unblock_requires": (
            "Selected Wi-Fi",
            "Hardware transcript",
            "Android Wi-Fi",
            "RF coexistence",
        ),
        "android_policy": ("Wi-Fi", "Bluetooth", "GNSS", "NFC", "VINTF", "SELinux", "CTS"),
    },
    "sensors_input_haptics": {
        "commands": ("getevent", "evtest", "iio_info", "sensorservice", "vibrator"),
        "release_evidence": ("Touch", "IMU", "calibration", "wake", "haptic", "CTS/VTS"),
        "unblock_requires": (
            "Selected IMU",
            "Hardware transcript",
            "Android input",
            "Factory calibration",
        ),
        "android_policy": ("Sensors HAL", "VINTF", "SELinux", "CTS", "CTS Verifier"),
    },
    "battery_pmic_thermal": {
        "commands": (
            "power_supply",
            "thermal_zone",
            "dumpsys battery",
            "thermalservice",
            "dumpsys power",
        ),
        "release_evidence": (
            "Charge",
            "fuel gauge",
            "thermal",
            "brownout",
            "suspend leakage",
            "shipping",
        ),
        "unblock_requires": (
            "Selected battery",
            "Hardware transcript",
            "Android Health",
            "Battery safety",
        ),
        "android_policy": ("Health", "Power", "Thermal", "VINTF", "SELinux", "VTS", "CTS"),
    },
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


def require_relative_existing_file(path: str, field: str, failures: list[str]) -> None:
    candidate = Path(path)
    if candidate.is_absolute() or ".." in candidate.parts:
        failures.append(f"{field} must be a relative repo path: {path}")
        return
    if not (ROOT / candidate).is_file():
        failures.append(f"{field} points at missing file: {path}")


def require_relative_path(path: str, field: str, failures: list[str]) -> None:
    candidate = Path(path)
    if candidate.is_absolute() or ".." in candidate.parts:
        failures.append(f"{field} must be a relative repo path: {path}")


def check_manifest(data: dict, gap_ids: set[str], failures: list[str]) -> None:
    if data.get("schema") != "eliza.product_feature_evidence.v1":
        failures.append("product feature evidence manifest has wrong schema")
    if data.get("status") != "release_blocked":
        failures.append("product feature evidence manifest must remain release_blocked")
    if data.get("source_gap_manifest") != "docs/manufacturing/real-world-verification-gaps.yaml":
        failures.append("product feature evidence manifest must point at real-world gap manifest")

    boundary = data.get("claim_boundary")
    if not isinstance(boundary, str) or "not implementation evidence" not in boundary:
        failures.append("claim_boundary must state the manifest is not implementation evidence")

    policy = data.get("global_policy")
    if not isinstance(policy, dict):
        failures.append("global_policy must be a mapping")
    else:
        local_claims = policy.get("local_checks_may_only_claim")
        if not isinstance(local_claims, list) or len(local_claims) < 3:
            failures.append(
                "global_policy.local_checks_may_only_claim must list local claim boundaries"
            )
        metadata = policy.get("required_evidence_metadata")
        if not isinstance(metadata, list):
            failures.append("global_policy.required_evidence_metadata must be a list")
        else:
            missing_metadata = sorted(REQUIRED_METADATA - set(metadata))
            if missing_metadata:
                failures.append(
                    "required_evidence_metadata missing: " + ", ".join(missing_metadata)
                )
        forbidden_release_claims = policy.get("forbidden_release_claims_until_evidence")
        if not isinstance(forbidden_release_claims, list):
            failures.append("global_policy.forbidden_release_claims_until_evidence must be a list")
        else:
            missing_claims = sorted(
                REQUIRED_FORBIDDEN_RELEASE_CLAIMS - set(forbidden_release_claims)
            )
            if missing_claims:
                failures.append(
                    "forbidden_release_claims_until_evidence missing: " + ", ".join(missing_claims)
                )
        android_evidence = policy.get("required_android_release_evidence")
        if not isinstance(android_evidence, list):
            failures.append("global_policy.required_android_release_evidence must be a list")
        else:
            missing_android = sorted(REQUIRED_ANDROID_RELEASE_EVIDENCE - set(android_evidence))
            if missing_android:
                failures.append(
                    "required_android_release_evidence missing: " + ", ".join(missing_android)
                )
        scoped_domains = policy.get("scoped_fail_closed_domains")
        if not isinstance(scoped_domains, list):
            failures.append("global_policy.scoped_fail_closed_domains must be a list")
        else:
            missing_scoped = sorted(SCOPED_FAIL_CLOSED_DOMAINS - set(scoped_domains))
            if missing_scoped:
                failures.append("scoped_fail_closed_domains missing: " + ", ".join(missing_scoped))

    domains = data.get("domains")
    if not isinstance(domains, list):
        failures.append("domains must be a list")
        return

    seen_domains: set[str] = set()
    seen_gap_ids: set[str] = set()
    for index, domain in enumerate(domains):
        label = f"domains[{index}]"
        if not isinstance(domain, dict):
            failures.append(f"{label} must be a mapping")
            continue
        domain_id = domain.get("id")
        if not isinstance(domain_id, str) or not domain_id:
            failures.append(f"{label}.id must be a non-empty string")
            domain_id = label
        if domain_id in seen_domains:
            failures.append(f"{label} duplicate domain id: {domain_id}")
        seen_domains.add(domain_id)
        if domain_id not in REQUIRED_DOMAINS:
            failures.append(f"{domain_id}: unknown product feature domain")

        if "blocked" not in str(domain.get("status", "")):
            failures.append(f"{domain_id}: status must remain explicitly blocked")

        gap_id = domain.get("release_gap_id")
        if not isinstance(gap_id, str) or gap_id not in gap_ids:
            failures.append(f"{domain_id}: release_gap_id must exist in real-world gap manifest")
        else:
            seen_gap_ids.add(gap_id)
        if gap_id not in REQUIRED_GAP_IDS:
            failures.append(f"{domain_id}: release_gap_id is not a required product feature gap")

        local_check = domain.get("local_check")
        if not isinstance(local_check, str):
            failures.append(f"{domain_id}: local_check must be a file path")
        else:
            require_relative_existing_file(local_check, f"{domain_id}.local_check", failures)

        for field, minimum in (
            ("evidence_paths", 1),
            ("forbidden_claims", 2),
            ("hardware_commands", 2),
            ("release_evidence", 2),
        ):
            values = domain.get(field)
            if not isinstance(values, list) or len(values) < minimum:
                failures.append(f"{domain_id}.{field} must list at least {minimum} item(s)")
                continue
            for item in values:
                if not isinstance(item, str) or not item.strip():
                    failures.append(f"{domain_id}.{field} entries must be non-empty strings")
            if field == "evidence_paths":
                for path in values:
                    if isinstance(path, str):
                        require_relative_path(path, f"{domain_id}.evidence_paths", failures)
            if field == "forbidden_claims":
                for claim in values:
                    if isinstance(claim, str) and not claim.endswith("."):
                        failures.append(
                            f"{domain_id}.forbidden_claims entries must be complete sentences"
                        )
            if field == "release_evidence":
                joined = " ".join(str(item).lower() for item in values)
                if not any(token in joined for token in ("transcript", "evidence", "record")):
                    failures.append(
                        f"{domain_id}.release_evidence must name transcripts, evidence, or records"
                    )

        if domain_id in SCOPED_FAIL_CLOSED_DOMAINS:
            android_policy = domain.get("android_declaration_policy")
            if not isinstance(android_policy, str) or "remain" not in android_policy.lower():
                failures.append(
                    f"{domain_id}.android_declaration_policy must keep declarations fail-closed"
                )
            unblock_requires = domain.get("unblock_requires")
            if not isinstance(unblock_requires, list) or len(unblock_requires) < 4:
                failures.append(
                    f"{domain_id}.unblock_requires must list at least four unblock requirements"
                )
                unblock_requires = []
            elif not all(isinstance(item, str) and item.endswith(".") for item in unblock_requires):
                failures.append(f"{domain_id}.unblock_requires entries must be complete sentences")

            scoped_text = {
                "commands": " ".join(str(item) for item in domain.get("hardware_commands", [])),
                "release_evidence": " ".join(
                    str(item) for item in domain.get("release_evidence", [])
                ),
                "unblock_requires": " ".join(str(item) for item in unblock_requires),
                "android_policy": str(android_policy or ""),
            }
            for field, tokens in REQUIRED_SCOPED_TOKENS[domain_id].items():
                text = scoped_text[field].lower()
                missing_tokens = [token for token in tokens if token.lower() not in text]
                if missing_tokens:
                    failures.append(
                        f"{domain_id}.{field} missing scoped fail-closed terms: "
                        + ", ".join(missing_tokens)
                    )

    missing_domains = sorted(REQUIRED_DOMAINS - seen_domains)
    if missing_domains:
        failures.append(
            "product feature evidence manifest missing domains: " + ", ".join(missing_domains)
        )
    missing_gaps = sorted(REQUIRED_GAP_IDS - seen_gap_ids)
    if missing_gaps:
        failures.append(
            "product feature evidence manifest missing gap links: " + ", ".join(missing_gaps)
        )


def check_security_scope_gate(failures: list[str]) -> None:
    result = subprocess.run(
        [sys.executable, str(SECURITY_SCOPE_CHECK)],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if result.returncode != 0:
        failures.append("security lifecycle scope check failed:\n" + result.stdout)
        return
    if not SECURITY_SCOPE_REPORT.is_file():
        failures.append("security lifecycle scope report was not generated")
        return
    text = SECURITY_SCOPE_REPORT.read_text(encoding="utf-8")
    for term in (
        "security_lifecycle_scope_release_blocked",
        "placeholder_non_secret",
        "not secure boot",
    ):
        if term not in text:
            failures.append(f"security lifecycle scope report missing term: {term}")


def code_from_text(text: str) -> str:
    cleaned = "".join(char.lower() if char.isalnum() else "_" for char in text)
    return "_".join(part for part in cleaned.split("_") if part)[:96] or "product_feature_gate_failure"


def write_report(failures: list[str]) -> None:
    findings = [
        {
            "code": code_from_text(failure),
            "severity": "fail",
            "message": failure,
            "evidence": rel(MANIFEST),
            "next_step": "Fix the product feature evidence manifest or referenced fail-closed scope report before using product feature evidence as readiness support.",
        }
        for failure in failures
    ]
    report = {
        "schema": "eliza.product_feature_gates.v1",
        "status": "fail" if failures else "pass",
        "claim_boundary": "product_feature_manifest_check_only_not_runtime_or_release_evidence",
        "summary": {"findings": len(findings)},
        "findings": findings,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    failures: list[str] = []
    data = load_yaml(MANIFEST, failures)
    gaps = load_yaml(GAPS, failures)

    gap_ids: set[str] = {
        str(gap.get("id"))
        for gap in gaps.get("gaps", [])
        if isinstance(gap, dict) and isinstance(gap.get("id"), str)
    }
    if data:
        check_manifest(data, gap_ids, failures)
    check_security_scope_gate(failures)
    write_report(failures)

    if failures:
        print("Product feature evidence gate check failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("product feature evidence gates are fail-closed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
