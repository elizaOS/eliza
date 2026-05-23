#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from chip_utils import load_yaml_object, require

ROOT = Path(__file__).resolve().parents[1]
REAL_WORLD_GAPS = ROOT / "docs/manufacturing/real-world-verification-gaps.yaml"
PRODUCT_FEATURES = ROOT / "docs/manufacturing/product-feature-evidence-manifest.yaml"
PHONE_PLATFORM = ROOT / "docs/architecture-optimization/phone-platform.md"
WIFI_INTERFACE = ROOT / "package/wifi-external-interface.yaml"
WIFI_EVIDENCE = ROOT / "package/wifi/evidence-gates.yaml"
SENSORS_BOM = ROOT / "package/sensors/v0-sensors.yaml"
PMIC_BINDING = ROOT / "package/pmic/da9063.yaml"
CHARGER_BINDING = ROOT / "package/charger/max77860.yaml"
OUT = ROOT / "build/reports/radio_sensor_pmic_scope.json"


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def contains_all(text: str, tokens: tuple[str, ...]) -> bool:
    lowered = text.lower()
    return all(token.lower() in lowered for token in tokens)


def code_from_text(text: str, fallback: str) -> str:
    cleaned = "".join(char.lower() if char.isalnum() else "_" for char in text)
    parts = [part for part in cleaned.split("_") if part]
    return "_".join(parts[:10]) or fallback


def structured_findings(
    blocked_until_real_evidence: list[str], checks: list[dict[str, Any]]
) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    for item in blocked_until_real_evidence:
        findings.append(
            {
                "code": f"radio_sensor_pmic_missing_real_evidence_{code_from_text(item, 'evidence')}",
                "severity": "blocker",
                "message": item,
                "evidence": "blocked_until_real_evidence",
                "next_step": "Capture the named radio, sensor, battery, PMIC, Android HAL, or regulatory evidence before claiming phone product readiness.",
            }
        )
    for check in checks:
        if check.get("status") == "pass":
            continue
        ident = str(check.get("id", "scope_check"))
        findings.append(
            {
                "code": f"radio_sensor_pmic_scope_check_failed_{code_from_text(ident, 'scope_check')}",
                "severity": "blocker",
                "message": f"{ident} structural scope check is {check.get('status')}",
                "evidence": str(check.get("evidence", "")),
                "next_step": "Repair the radio/sensor/PMIC scope contract before using this report as runtime evidence.",
            }
        )
    return findings


def row_by_id(rows: list[Any], row_id: str) -> dict[str, Any]:
    for row in rows:
        if isinstance(row, dict) and row.get("id") == row_id:
            return row
    return {}


def load_rows(path: Path, field: str) -> list[Any]:
    data = load_yaml_object(path)
    rows = data.get(field)
    if not isinstance(rows, list):
        raise ValueError(f"{rel(path)} must list {field}")
    return rows


def build_report() -> dict[str, Any]:
    gaps = load_rows(REAL_WORLD_GAPS, "gaps")
    domains = load_rows(PRODUCT_FEATURES, "domains")
    phone_platform = PHONE_PLATFORM.read_text(encoding="utf-8")
    wifi_interface = load_yaml_object(WIFI_INTERFACE)
    wifi_evidence = load_yaml_object(WIFI_EVIDENCE)
    sensors_bom = load_yaml_object(SENSORS_BOM)
    pmic = load_yaml_object(PMIC_BINDING)
    charger = load_yaml_object(CHARGER_BINDING)

    wifi_gap = row_by_id(gaps, "wifi_bluetooth_gnss_nfc_stack")
    sensors_gap = row_by_id(gaps, "sensors_input_haptics_stack")
    pmic_gap = row_by_id(gaps, "battery_pmic_thermal_stack")
    wifi_domain = row_by_id(domains, "wifi_bluetooth_gnss_nfc")
    sensors_domain = row_by_id(domains, "sensors_input_haptics")
    pmic_domain = row_by_id(domains, "battery_pmic_thermal")
    modem_domain = row_by_id(domains, "modem_radio")

    wifi_evidence_text = json.dumps(wifi_evidence, sort_keys=True, default=str)
    sensors_text = json.dumps(sensors_bom, sort_keys=True, default=str)
    pmic_text = json.dumps(pmic, sort_keys=True, default=str)
    charger_text = json.dumps(charger, sort_keys=True, default=str)
    checks = [
        {
            "id": "wifi_gap_fail_closed",
            "status": "pass"
            if "not implemented" in str(wifi_gap.get("claim_boundary", ""))
            and contains_all(
                " ".join(str(item) for item in wifi_gap.get("required_evidence", [])),
                ("Wi-Fi", "Bluetooth", "GNSS", "NFC", "firmware", "certification"),
            )
            else "fail",
            "evidence": "docs/manufacturing/real-world-verification-gaps.yaml#wifi_bluetooth_gnss_nfc_stack",
        },
        {
            "id": "wifi_package_scaffold_blocks_product_claim",
            "status": "pass"
            if contains_all(
                json.dumps(wifi_interface, sort_keys=True, default=str),
                (
                    "radios_disabled",
                    "android_wifi_framework",
                    "not_enabled",
                    "firmware",
                    "missing evidence",
                ),
            )
            else "fail",
            "evidence": rel(WIFI_INTERFACE),
        },
        {
            "id": "wifi_evidence_gate_blocks_release",
            "status": "pass"
            if contains_all(
                wifi_evidence_text,
                (
                    "interface_only_no_wifi_implementation_claim",
                    "wifi_sdio_host",
                    "Bluetooth",
                    "CTS/VTS",
                ),
            )
            else "fail",
            "evidence": rel(WIFI_EVIDENCE),
        },
        {
            "id": "sensors_gap_fail_closed",
            "status": "pass"
            if "not implemented" in str(sensors_gap.get("claim_boundary", ""))
            and contains_all(
                " ".join(str(item) for item in sensors_gap.get("required_evidence", [])),
                ("sensors", "haptic", "Android sensor HAL", "calibration"),
            )
            else "fail",
            "evidence": "docs/manufacturing/real-world-verification-gaps.yaml#sensors_input_haptics_stack",
        },
        {
            "id": "sensors_package_scaffold_blocks_product_claim",
            "status": "pass"
            if contains_all(
                sensors_text,
                (
                    "Planning sensor BOM",
                    "No I2C/I3C controller",
                    "per-sensor probe transcripts",
                    "vintf_entry_planned",
                ),
            )
            else "fail",
            "evidence": rel(SENSORS_BOM),
        },
        {
            "id": "pmic_gap_fail_closed",
            "status": "pass"
            if "not implemented" in str(pmic_gap.get("claim_boundary", ""))
            and contains_all(
                " ".join(str(item) for item in pmic_gap.get("required_evidence", [])),
                ("PMIC", "fuel gauge", "thermal", "charger", "current-limit"),
            )
            else "fail",
            "evidence": "docs/manufacturing/real-world-verification-gaps.yaml#battery_pmic_thermal_stack",
        },
        {
            "id": "pmic_charger_scaffold_blocks_product_claim",
            "status": "pass"
            if contains_all(
                pmic_text,
                ("Planning binding only", "No PMIC is mounted", "power-on transcript"),
            )
            and contains_all(
                charger_text,
                ("Planning binding only", "No charger IC is mounted", "battery wired"),
            )
            else "fail",
            "evidence": f"{rel(PMIC_BINDING)}, {rel(CHARGER_BINDING)}",
        },
        {
            "id": "android_feature_domains_fail_closed",
            "status": "pass"
            if all(
                "blocked" in str(domain.get("status", ""))
                and "remain fail-closed" in str(domain.get("android_declaration_policy", ""))
                for domain in (wifi_domain, sensors_domain, pmic_domain, modem_domain)
            )
            else "fail",
            "evidence": rel(PRODUCT_FEATURES),
        },
        {
            "id": "phone_platform_hal_policy_present",
            "status": "pass"
            if contains_all(
                phone_platform,
                ("PMIC", "radios", "sensors", "Android service declaration", "runtime transcripts"),
            )
            else "fail",
            "evidence": rel(PHONE_PLATFORM),
        },
    ]
    blocked_until_real_evidence = [
        "selected Wi-Fi/BT/GNSS/NFC module records, firmware provenance, antenna path, and regulatory boundary",
        "wireless enumeration, firmware load, association, pairing, GNSS lock, NFC, suspend wake, and reset recovery transcripts",
        "selected sensors, touch, haptics, regulators, IRQ/wake lines, calibration storage, and Android Sensors/Input/Vibrator HAL evidence",
        "selected battery cell, PMIC, charger, fuel gauge, thermistors, rail sequencing, brownout, ship mode, and safety records",
        "Android Health, Power, Thermal, Wi-Fi, Bluetooth, GNSS, NFC, Sensors, Input, and VINTF/SELinux/CTS/VTS evidence",
        "RF coexistence, SAR/RF exposure, Bluetooth qualification, Wi-Fi/NFC compliance, battery shipping, charger, and thermal chamber evidence",
    ]
    findings = structured_findings(blocked_until_real_evidence, checks)
    return {
        "schema": "eliza.radio_sensor_pmic_scope.v1",
        "status": "radio_sensor_pmic_scope_release_blocked",
        "claim_boundary": (
            "Radio, sensor, battery, PMIC, charger, and thermal scope audit only; "
            "not Wi-Fi, not Bluetooth, not GNSS, not NFC, not cellular, not sensors, "
            "not haptics, not battery safety, not charger safety, not PMIC, not "
            "Android Health/Power/Thermal/Sensors/Wi-Fi/Bluetooth HAL evidence, "
            "not regulatory evidence, and not phone product readiness."
        ),
        "current_scaffolds": {
            "wifi": rel(WIFI_INTERFACE),
            "wifi_evidence_gate": rel(WIFI_EVIDENCE),
            "sensors": rel(SENSORS_BOM),
            "pmic": rel(PMIC_BINDING),
            "charger": rel(CHARGER_BINDING),
        },
        "blocked_until_real_evidence": blocked_until_real_evidence,
        "findings": findings,
        "checks": checks,
        "summary": {
            "check_count": len(checks),
            "passing_check_count": len([check for check in checks if check["status"] == "pass"]),
            "release_claim_allowed": False,
        },
    }


def validate_report(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    require(data.get("schema") == "eliza.radio_sensor_pmic_scope.v1", "schema mismatch", errors)
    require(
        data.get("status") == "radio_sensor_pmic_scope_release_blocked",
        "status must remain radio_sensor_pmic_scope_release_blocked",
        errors,
    )
    boundary = str(data.get("claim_boundary", ""))
    for token in (
        "not Wi-Fi",
        "not Bluetooth",
        "not GNSS",
        "not sensors",
        "not battery safety",
        "not PMIC",
        "not Android Health",
        "not regulatory evidence",
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
        errors.append("radio/sensor/PMIC scope must enumerate blocked real-evidence items")
    findings = data.get("findings")
    if not isinstance(findings, list) or not findings:
        errors.append("findings must list structured radio/sensor/PMIC blockers")
    scaffolds = data.get("current_scaffolds")
    if not isinstance(scaffolds, dict):
        errors.append("current_scaffolds must be a mapping")
    else:
        for key in ("wifi", "wifi_evidence_gate", "sensors", "pmic", "charger"):
            require(isinstance(scaffolds.get(key), str), f"current_scaffolds missing {key}", errors)
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
    print(f"Radio/sensor/PMIC scope check passed: {rel(OUT)} remains release-blocked.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
