#!/usr/bin/env python3
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
GAP_MANIFEST = ROOT / "docs/manufacturing/real-world-verification-gaps.yaml"
RELEASE_MANIFEST = ROOT / "docs/manufacturing/release-manifest.yaml"
PD_MANIFEST = ROOT / "pd/signoff/manifest.yaml"
WORK_ORDER = ROOT / "docs/manufacturing/physical-closure-work-order.yaml"

REQUIRED_GATES = {
    "pd_release",
    "tapeout_release",
    "board_fabrication_release",
}
REQUIRED_CATEGORIES = {
    "physical_design",
    "package",
    "padframe",
    "signal_integrity",
    "power_integrity",
    "pdn_current_budget",
    "thermal",
    "board_fabrication",
    "manufacturing_test",
    "modem_cellular",
    "wireless_gnss_nfc",
    "camera_isp",
    "audio",
    "sensors_input_haptics",
    "usb_storage_update",
    "battery_pmic_thermal",
    "secure_boot_key_debug",
    "privacy_data",
    "regulatory_compliance",
    "factory_test",
}
REQUIRED_GAP_IDS = {
    "routed_pd_signoff",
    "selected_pdk_corner_record",
    "foundry_io_padframe_release",
    "package_vendor_drawing",
    "bond_diagram_release",
    "package_electrical_model",
    "board_stackup_and_return_paths",
    "board_signal_integrity_report",
    "power_integrity_report",
    "post_route_power_budget",
    "ir_drop_em_report",
    "board_current_limit_plan",
    "package_board_thermal_review",
    "board_footprint_release",
    "kicad_project_release",
    "footprint_source_checksum",
    "assembly_dfm_review",
    "first_article_smoke_limits",
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
PRODUCT_FEATURE_GAP_IDS = {
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
INCOMPLETE_STATUSES = {
    "missing_external_tool_run",
    "missing_vendor_artifact",
    "missing_board_artifact",
    "draft_local_plan",
}
FALSE_MANUFACTURING_CLAIM_FLAGS = {
    "claim_allowed",
    "phone_claim_allowed",
    "release_claim_allowed",
    "tapeout_claim_allowed",
    "board_fabrication_claim_allowed",
    "silicon_claim_allowed",
    "production_readiness_claim_allowed",
}
FALSE_PD_CLAIM_FLAGS = {
    "claim_allowed",
    "phone_claim_allowed",
    "release_claim_allowed",
    "tapeout_claim_allowed",
    "pd_signoff_claim_allowed",
    "silicon_claim_allowed",
    "production_readiness_claim_allowed",
}


def validate_false_claim_flags(
    name: str, manifest: dict, claim_flags: set[str], failures: list[str]
) -> None:
    expected = {flag: False for flag in sorted(claim_flags)}
    if manifest.get("false_claim_flags") != expected:
        failures.append(f"{name} false_claim_flags must match denied claim fields")


def load_yaml(path: Path) -> dict:
    data = yaml.safe_load(path.read_text())
    if not isinstance(data, dict):
        raise SystemExit(f"{path.relative_to(ROOT)} must be a YAML mapping")
    return data


def relative_existing_file(path: str, field: str, failures: list[str]) -> None:
    candidate = Path(path)
    if candidate.is_absolute() or ".." in candidate.parts:
        failures.append(f"{field} must be a relative repo path: {path}")
        return
    if not (ROOT / candidate).is_file():
        failures.append(f"{field} points at missing file: {path}")


def validate_gate_map(name: str, gates: object, failures: list[str]) -> None:
    if not isinstance(gates, dict):
        failures.append(f"{name} must list release gates")
        return
    missing = sorted(REQUIRED_GATES - set(gates))
    if missing:
        failures.append(f"{name} missing release gates: " + ", ".join(missing))
    for gate_name, gate in gates.items():
        if gate_name not in REQUIRED_GATES:
            failures.append(f"{name}.{gate_name}: unknown release gate")
        if not isinstance(gate, dict):
            failures.append(f"{name}.{gate_name}: gate must be a mapping")
            continue
        if gate.get("blocked") is not True:
            failures.append(
                f"{name}.{gate_name}: gate must stay blocked until external evidence is archived"
            )
        if not isinstance(gate.get("reason"), str) or not gate["reason"]:
            failures.append(f"{name}.{gate_name}: missing reason")
        unblock_requires = gate.get("unblock_requires")
        if not isinstance(unblock_requires, list) or not all(
            isinstance(item, str) and item for item in unblock_requires
        ):
            failures.append(f"{name}.{gate_name}: missing unblock_requires")
        manifest = gate.get("evidence_manifest")
        if not isinstance(manifest, str) or not manifest:
            failures.append(f"{name}.{gate_name}: missing evidence_manifest")
        else:
            relative_existing_file(manifest, f"{name}.{gate_name}.evidence_manifest", failures)


def validate_gap_manifest(manifest: dict, failures: list[str]) -> None:
    if manifest.get("status") != "release_blocked":
        failures.append("gap manifest status must be release_blocked")
    for flag in sorted(FALSE_MANUFACTURING_CLAIM_FLAGS):
        if manifest.get(flag) is not False:
            failures.append(f"gap manifest {flag} must be false")
    validate_false_claim_flags("gap manifest", manifest, FALSE_MANUFACTURING_CLAIM_FLAGS, failures)
    categories = manifest.get("required_gap_categories")
    if not isinstance(categories, list):
        failures.append("gap manifest must list required_gap_categories")
    else:
        missing_categories = sorted(REQUIRED_CATEGORIES - set(categories))
        if missing_categories:
            failures.append("required_gap_categories missing: " + ", ".join(missing_categories))

    validate_gate_map("real_world.release_gates", manifest.get("release_gates"), failures)

    gaps = manifest.get("gaps")
    if not isinstance(gaps, list) or not gaps:
        failures.append("gap manifest must list gaps")
        return

    seen_ids: set[str] = set()
    seen_categories: set[str] = set()
    for index, gap in enumerate(gaps):
        label = f"gaps[{index}]"
        if not isinstance(gap, dict):
            failures.append(f"{label}: gap must be a mapping")
            continue
        gap_id = gap.get("id")
        if not isinstance(gap_id, str) or not gap_id:
            failures.append(f"{label}: missing id")
            gap_id = label
        if gap_id in seen_ids:
            failures.append(f"{label}: duplicate gap id {gap_id}")
        seen_ids.add(gap_id)

        category = gap.get("category")
        if category not in REQUIRED_CATEGORIES:
            failures.append(
                f"{gap_id}: category must be one of " + ", ".join(sorted(REQUIRED_CATEGORIES))
            )
        else:
            seen_categories.add(category)

        if gap.get("release_gate") not in REQUIRED_GATES:
            failures.append(f"{gap_id}: invalid release_gate")
        if gap.get("status") not in INCOMPLETE_STATUSES:
            failures.append(f"{gap_id}: status must be an explicit incomplete status")

        for field in ("evidence_manifest", "local_check"):
            value = gap.get(field)
            if not isinstance(value, str) or not value:
                failures.append(f"{gap_id}: missing {field}")
            else:
                relative_existing_file(value, f"{gap_id}.{field}", failures)

        evidence = gap.get("required_evidence")
        if not isinstance(evidence, list) or len(evidence) < 2:
            failures.append(f"{gap_id}: required_evidence must list at least two release artifacts")
        elif not all(isinstance(item, str) and item.endswith(".") for item in evidence):
            failures.append(f"{gap_id}: each required_evidence item must be a complete sentence")

        if gap_id in PRODUCT_FEATURE_GAP_IDS:
            commands = gap.get("future_cli_evidence_commands")
            if not isinstance(commands, list) or len(commands) < 2:
                failures.append(
                    f"{gap_id}: product feature gaps must list future_cli_evidence_commands"
                )
            elif not all(isinstance(item, str) and item.strip() for item in commands):
                failures.append(f"{gap_id}: future_cli_evidence_commands must be non-empty strings")
            claim_boundary = gap.get("claim_boundary")
            if not isinstance(claim_boundary, str) or "not available" not in claim_boundary:
                failures.append(
                    f"{gap_id}: claim_boundary must state the product evidence is not available"
                )

    missing_ids = sorted(REQUIRED_GAP_IDS - seen_ids)
    if missing_ids:
        failures.append("gap manifest missing required gap ids: " + ", ".join(missing_ids))
    missing_seen_categories = sorted(REQUIRED_CATEGORIES - seen_categories)
    if missing_seen_categories:
        failures.append(
            "gap manifest has no gap entries for: " + ", ".join(missing_seen_categories)
        )


def validate_work_order_link(gaps: dict, failures: list[str]) -> None:
    if not WORK_ORDER.is_file():
        failures.append(
            "missing physical closure work order: docs/manufacturing/physical-closure-work-order.yaml"
        )
        return
    work_order = load_yaml(WORK_ORDER)
    if (
        work_order.get("source_gap_manifest")
        != "docs/manufacturing/real-world-verification-gaps.yaml"
    ):
        failures.append("physical closure work order must link to real-world gap manifest")
    gap_ids: set[str] = set()
    for gap in gaps.get("gaps", []):
        if isinstance(gap, dict):
            gap_id = gap.get("id")
            if isinstance(gap_id, str):
                gap_ids.add(gap_id)
    items = work_order.get("items")
    if not isinstance(items, list):
        failures.append("physical closure work order must list items")
        return
    item_ids: set[str] = set()
    for item in items:
        if isinstance(item, dict):
            item_id = item.get("id")
            if isinstance(item_id, str):
                item_ids.add(item_id)
    missing = sorted(gap_ids - item_ids)
    extra = sorted(item_ids - gap_ids)
    if missing:
        failures.append("physical closure work order missing gap ids: " + ", ".join(missing))
    if extra:
        failures.append("physical closure work order contains unknown ids: " + ", ".join(extra))


def validate_manifest_consistency(gaps: dict, release: dict, pd: dict, failures: list[str]) -> None:
    for flag in sorted(FALSE_MANUFACTURING_CLAIM_FLAGS):
        if release.get(flag) is not False:
            failures.append(f"manufacturing release manifest {flag} must be false")
    for flag in sorted(FALSE_PD_CLAIM_FLAGS):
        if pd.get(flag) is not False:
            failures.append(f"pd signoff manifest {flag} must be false")
    validate_false_claim_flags(
        "manufacturing release manifest", release, FALSE_MANUFACTURING_CLAIM_FLAGS, failures
    )
    validate_false_claim_flags("pd signoff manifest", pd, FALSE_PD_CLAIM_FLAGS, failures)

    validate_gate_map("manufacturing.blocked_gates", release.get("blocked_gates"), failures)
    validate_gate_map("pd.blocked_gates", pd.get("blocked_gates"), failures)

    pd_readiness = {"si_pi", "pdn_current_budget", "padframe_package"}
    release_readiness = release.get("readiness")
    if not isinstance(release_readiness, dict):
        failures.append("manufacturing release manifest must list readiness sections")
    else:
        missing = sorted(pd_readiness - set(release_readiness))
        if missing:
            failures.append("manufacturing readiness missing: " + ", ".join(missing))
        for section in sorted(pd_readiness & set(release_readiness)):
            spec = release_readiness[section]
            if not isinstance(spec, dict):
                failures.append(f"manufacturing readiness {section} must be a mapping")
                continue
            if spec.get("status") != "blocked":
                failures.append(f"manufacturing readiness {section} must remain blocked")
            manifest_path = spec.get("evidence_manifest")
            if not isinstance(manifest_path, str) or manifest_path != "pd/signoff/manifest.yaml":
                failures.append(
                    f"manufacturing readiness {section} must point at pd/signoff/manifest.yaml"
                )

    for section in pd_readiness:
        spec = pd.get(section)
        if not isinstance(spec, dict):
            failures.append(f"pd signoff manifest missing {section}")
            continue
        if spec.get("status") != "blocked" or spec.get("release_blocking") is not True:
            failures.append(f"pd signoff {section} must be blocked and release_blocking")
        artifacts = spec.get("required_artifacts")
        if not isinstance(artifacts, list) or not artifacts:
            failures.append(f"pd signoff {section} must list required_artifacts")

    gap_gate_pairs = {
        (gap.get("id"), gap.get("release_gate"))
        for gap in gaps.get("gaps", [])
        if isinstance(gap, dict)
    }
    for required in (
        ("routed_pd_signoff", "pd_release"),
        ("package_electrical_model", "tapeout_release"),
        ("board_signal_integrity_report", "board_fabrication_release"),
        ("power_integrity_report", "board_fabrication_release"),
        ("ir_drop_em_report", "tapeout_release"),
        ("assembly_dfm_review", "board_fabrication_release"),
        ("cellular_modem_stack", "board_fabrication_release"),
        ("wifi_bluetooth_gnss_nfc_stack", "board_fabrication_release"),
        ("camera_isp_stack", "board_fabrication_release"),
        ("audio_codec_dsp_stack", "board_fabrication_release"),
        ("sensors_input_haptics_stack", "board_fabrication_release"),
        ("usb_storage_update_stack", "board_fabrication_release"),
        ("battery_pmic_thermal_stack", "board_fabrication_release"),
        ("secure_boot_key_debug_policy", "board_fabrication_release"),
        ("privacy_data_protection_policy", "board_fabrication_release"),
        ("regulatory_compliance_release", "board_fabrication_release"),
        ("factory_test_provisioning_flow", "board_fabrication_release"),
    ):
        if required not in gap_gate_pairs:
            failures.append(f"gap {required[0]} must block {required[1]}")


def main() -> int:
    failures: list[str] = []
    gap_manifest = load_yaml(GAP_MANIFEST)
    release_manifest = load_yaml(RELEASE_MANIFEST)
    pd_manifest = load_yaml(PD_MANIFEST)

    validate_gap_manifest(gap_manifest, failures)
    validate_work_order_link(gap_manifest, failures)
    validate_manifest_consistency(gap_manifest, release_manifest, pd_manifest, failures)

    if failures:
        print("Real-world release gate check failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("real-world release gates ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
