#!/usr/bin/env python3
"""Audit development footprint pads against captured public pinout evidence."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, cast

import yaml

ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "board/kicad/e1-phone/e1-phone-dev.pretty"
MANIFEST = ROOT / "board/kicad/e1-phone/development-footprint-library-manifest-2026-05-22.yaml"
PINOUT_DIR = ROOT / "board/kicad/e1-phone/supplier-pinouts"
BOARD = ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-real-footprint-development.kicad_pcb"
OUT = ROOT / "board/kicad/e1-phone/development-pad-pin-coverage-audit-2026-05-22.yaml"

PINOUT_BINDINGS: dict[str, dict[str, str]] = {
    "GCT_USB4105_GF_A_DEV": {
        "pinout": "gct-usb4105-pinout.yaml",
        "coverage": "exact_public_pin_table",
    },
    "PANASONIC_EVQ_P7_DEV": {
        "pinout": "panasonic-evq-p7-pinout.yaml",
        "coverage": "exact_public_pin_table",
    },
    "DISPLAY_40P_0P30_DEV": {
        "pinout": "chenghao-ch550fh01a-pinout.yaml",
        "coverage": "signal_set_only_pending_signed_fpc_order",
    },
    "CAMERA_24P_0P50_DEV": {
        "pinout": "ov13855-pinout.yaml",
        "coverage": "signal_set_only_pending_signed_fpc_order",
    },
    "CAMERA_30P_0P50_DEV": {
        "pinout": "gc5035-pinout.yaml",
        "coverage": "signal_set_only_pending_signed_fpc_order",
    },
    "BATTERY_4P_1P00_DEV": {
        "pinout": "battery-pack-4pin-pinout.yaml",
        "coverage": "exact_public_pack_signal_contract_pending_supplier_pin_order",
    },
    "HIROSE_DF40_80P_0P4_DEV": {
        "pinout": "hirose-bm28-pinout.yaml",
        "coverage": "mechanical_numbering_public_signal_assignment_local",
    },
    "TI_TPS65987_RSH_56QFN_DEV": {
        "pinout": "tps65987-pinout.yaml",
        "coverage": "exact_public_pin_table",
    },
    "ADI_MAX77860_WLP81_DEV": {
        "pinout": "max77860-pinout.yaml",
        "coverage": "exact_public_pin_table",
    },
    "AUDIO_CODEC_QFN48_DEV": {
        "pinout": "audio-codec-qfn48-pinout.yaml",
        "coverage": "exact_public_audio_signal_contract_pending_selected_codec_pinout",
    },
    "BACKLIGHT_BIAS_POWER_DEV": {
        "pinout": "backlight-bias-qfn24-pinout.yaml",
        "coverage": "exact_public_backlight_bias_signal_contract_pending_selected_driver_pinout",
    },
    "FUEL_GAUGE_WLCSP_DEV": {
        "pinout": "fuel-gauge-wlcsp12-pinout.yaml",
        "coverage": "exact_public_fuel_gauge_signal_contract_pending_selected_gauge_pinout",
    },
    "HAPTIC_DRIVER_WLCSP_DEV": {
        "pinout": "haptic-driver-wlcsp9-pinout.yaml",
        "coverage": "exact_public_haptic_signal_contract_pending_selected_driver_pinout",
    },
    "SODIMM_260P_0P5_COMPUTE_SOM_DEV": {
        "pinout": "compute-som-pinout.yaml",
        "coverage": "public_som_pinout_pad_count_aligned",
    },
    "QUECTEL_RG255C_GEOMETRY_DEV": {
        "pinout": "quectel-rg255c-pinout.yaml",
        "coverage": "exact_public_pin_table_pending_final_regional_sku_pack",
    },
    "MURATA_TYPE_2EA_GEOMETRY_DEV": {
        "pinout": "murata-type-2ea-pinout.yaml",
        "coverage": "exact_public_terminal_table_and_public_dxf_land_pattern",
    },
    "ESIM_LGA_DEV": {
        "pinout": "esim-mff2-pinout.yaml",
        "coverage": "exact_public_mff2_esim_pin_table",
    },
    "NFC_CONTROLLER_QFN_DEV": {
        "pinout": "nfc-controller-qfn32-pinout.yaml",
        "coverage": "exact_public_nfc_signal_contract_pending_selected_controller_pinout",
    },
    "NFC_LOOP_MATCH_DEV": {
        "pinout": "nfc-loop-match-5pad-pinout.yaml",
        "coverage": "exact_public_nfc_loop_match_contract_pending_antenna_tuning",
    },
    "SENSOR_HUB_QFN_DEV": {
        "pinout": "sensor-hub-qfn24-pinout.yaml",
        "coverage": "exact_public_sensor_hub_signal_contract_pending_selected_sensor_pinout",
    },
    "USIM_ESD_LEVELSHIFT_DEV": {
        "pinout": "usim-esd-levelshift-pinout.yaml",
        "coverage": "exact_public_usim_signal_contract_pending_selected_levelshift_pinout",
    },
}

SUPPORT_PATTERN_BASIS: dict[str, dict[str, object]] = {
    "C0402_DEV": {
        "coverage": "explicit_local_standard_0402_capacitor_land_pattern",
        "pinout_status": "not_pinout_bearing_standard_land_pattern",
        "land_pattern_basis": "local IPC-7351-style 0402 two-terminal development land pattern",
        "terminal_contract": ["1", "2"],
    },
    "ESD_ARRAY_6CH_DEV": {
        "coverage": "explicit_local_six_channel_esd_array_terminal_contract",
        "pinout_status": "local_terminal_contract_pending_selected_esd_array",
        "land_pattern_basis": "local six-channel ESD/TVS array terminal contract pending selected device",
        "terminal_contract": ["1", "2", "3", "4", "5", "6"],
    },
    "FIDUCIAL_1MM_DEV": {
        "coverage": "explicit_local_global_fiducial_land_pattern",
        "pinout_status": "not_pinout_bearing_fiducial_land_pattern",
        "land_pattern_basis": "local 1.0 mm copper fiducial with solder-mask clearance",
        "terminal_contract": ["1"],
    },
    "L0402_DEV": {
        "coverage": "explicit_local_standard_0402_inductor_land_pattern",
        "pinout_status": "not_pinout_bearing_standard_land_pattern",
        "land_pattern_basis": "local IPC-7351-style 0402 two-terminal development land pattern",
        "terminal_contract": ["1", "2"],
    },
    "MOUNTING_HOLE_1P2_DEV": {
        "coverage": "explicit_local_1p2mm_npth_mechanical_land_pattern",
        "pinout_status": "not_pinout_bearing_mechanical_npth",
        "land_pattern_basis": "local 1.2 mm NPTH mechanical mounting-hole contract",
        "terminal_contract": [],
        "npth_mechanical_feature_contract": [
            {
                "feature": "unnamed_center_npth",
                "hole_type": "np_thru_hole",
                "drill_mm": 1.2,
                "courtyard_mm": 3.2,
                "plating": "non_plated",
                "electrical_terminal": False,
            }
        ],
    },
    "PI_MATCH_0402_DEV": {
        "coverage": "explicit_local_three_element_rf_pi_match_terminal_contract",
        "pinout_status": "local_terminal_contract_pending_rf_match_tuning",
        "land_pattern_basis": "local five-terminal 0402 RF pi-match development contract",
        "terminal_contract": ["1", "2", "3", "4", "5"],
    },
    "R0402_DEV": {
        "coverage": "explicit_local_standard_0402_resistor_land_pattern",
        "pinout_status": "not_pinout_bearing_standard_land_pattern",
        "land_pattern_basis": "local IPC-7351-style 0402 two-terminal development land pattern",
        "terminal_contract": ["1", "2"],
    },
    "RC_ARRAY_4CH_DEV": {
        "coverage": "explicit_local_four_channel_rc_array_terminal_contract",
        "pinout_status": "local_terminal_contract_pending_selected_rc_array",
        "land_pattern_basis": "local eight-terminal RC array development contract pending selected array",
        "terminal_contract": ["1", "2", "3", "4", "5", "6", "7", "8"],
    },
    "SHUNT_1206_DEV": {
        "coverage": "explicit_local_standard_1206_shunt_land_pattern",
        "pinout_status": "not_pinout_bearing_standard_land_pattern",
        "land_pattern_basis": "local 1206 two-terminal current-shunt development land pattern",
        "terminal_contract": ["1", "2"],
    },
    "TESTPOINT_1MM_DEV": {
        "coverage": "explicit_local_1mm_testpoint_land_pattern",
        "pinout_status": "not_pinout_bearing_testpoint_land_pattern",
        "land_pattern_basis": "local one-terminal 1.0 mm solderable testpoint contract",
        "terminal_contract": ["1"],
    },
    "TVS_DIODE_2P_DEV": {
        "coverage": "explicit_local_two_terminal_tvs_diode_land_pattern",
        "pinout_status": "local_terminal_contract_pending_selected_tvs_diode",
        "land_pattern_basis": "local two-terminal TVS diode development land pattern",
        "terminal_contract": ["1", "2"],
    },
}


def load_yaml(path: Path) -> Any:
    with path.open() as handle:
        return yaml.safe_load(handle)


def footprint_pads(path: Path) -> list[str]:
    text = path.read_text()
    return re.findall(r'\(pad\s+"([^"]*)"', text)


def footprint_npth_features(path: Path) -> list[dict[str, Any]]:
    text = path.read_text()
    features: list[dict[str, Any]] = []
    for match in re.finditer(r'\(pad\s+"([^"]*)"\s+np_thru_hole\s+([a-z_]+)(.*?)\)\n', text, re.S):
        body = match.group(3)
        drill_match = re.search(r"\(drill\s+([0-9.]+)\)", body)
        size_match = re.search(r"\(size\s+([0-9.]+)\s+([0-9.]+)\)", body)
        at_match = re.search(r"\(at\s+([-0-9.]+)\s+([-0-9.]+)", body)
        feature = {
            "name": match.group(1),
            "hole_type": "np_thru_hole",
            "shape": match.group(2),
            "drill_mm": float(drill_match.group(1)) if drill_match else None,
            "size_mm": [
                float(size_match.group(1)),
                float(size_match.group(2)),
            ]
            if size_match
            else [],
            "at_mm": [
                float(at_match.group(1)),
                float(at_match.group(2)),
            ]
            if at_match
            else [],
            "plating": "non_plated",
            "electrical_terminal": False,
        }
        features.append(feature)
    return features


def pinout_expected_pins(pinout: dict[str, Any], footprint_name: str) -> list[str]:
    numbering = pinout.get("pin_numbering", {})
    if numbering.get("scheme") == "dual_row_A_B":
        a_start, a_end = numbering["row_A_range"]
        b_start, b_end = numbering["row_B_range"]
        a_count = int(str(a_end).removeprefix("A"))
        b_count = int(str(b_end).removeprefix("B"))
        return [f"A{index}" for index in range(1, a_count + 1)] + [
            f"B{index}" for index in range(1, b_count + 1)
        ]
    if footprint_name == "SODIMM_260P_0P5_COMPUTE_SOM_DEV":
        # The public SoM pinout uses numeric gold-finger positions while the
        # development footprint names the two physical rows A/B. Treat this as
        # a count/connector-family alignment until the production symbol maps
        # every SoM signal to the A/B footprint row convention.
        return []
    pins = pinout.get("pins", [])
    if pins and all(str(item.get("pin", "")) != "ALL" for item in pins):
        return [str(item["pin"]) for item in pins if str(item.get("pin", "")) != "ALL"]
    mechanical = pinout.get("mechanical", {})
    if "fpc_pin_count" in mechanical:
        return [str(index) for index in range(1, int(mechanical["fpc_pin_count"]) + 1)]
    if "pin_count" in mechanical:
        return [str(index) for index in range(1, int(mechanical["pin_count"]) + 1)]
    if "bump_count" in mechanical and "rows" in mechanical and "cols" in mechanical:
        return [f"{row}{col}" for row in mechanical["rows"] for col in mechanical["cols"]]
    if "positions" in mechanical and "contacts_per_row" in mechanical:
        count = int(mechanical["contacts_per_row"])
        return [f"A{index}" for index in range(1, count + 1)] + [
            f"B{index}" for index in range(1, count + 1)
        ]
    return []


def signal_group_count(pinout: dict[str, Any]) -> int:
    total = 0
    for value in pinout.values():
        if isinstance(value, dict):
            for nested in value.values():
                if isinstance(nested, list):
                    total += len(nested)
                elif isinstance(nested, dict):
                    total += sum(len(item) for item in nested.values() if isinstance(item, list))
    return total


def main() -> None:
    manifest = load_yaml(MANIFEST)
    records = {record["name"]: record for record in manifest["records"]}
    board_text = BOARD.read_text()
    audit_records = []
    exact_public = 0
    blocked = 0

    for name, record in sorted(records.items()):
        path = LIB / f"{name}.kicad_mod"
        pads = footprint_pads(path)
        npth_features = footprint_npth_features(path)
        numbered_pads = [pad for pad in pads if pad]
        electrical_pads = [
            pad
            for pad in numbered_pads
            if not pad.startswith("SH") and pad not in {"EP", "PAD", "GND_PAD", ""}
        ]
        mechanical_pads = [pad for pad in numbered_pads if pad not in electrical_pads]
        non_signal_pad_contract = list(mechanical_pads)
        non_signal_pad_contract_source = (
            "derived_from_non_electrical_footprint_pads" if non_signal_pad_contract else ""
        )
        binding = PINOUT_BINDINGS.get(name)
        support_basis = SUPPORT_PATTERN_BASIS.get(name, {})
        pinout_file = binding["pinout"] if binding else ""
        coverage = (
            binding["coverage"]
            if binding
            else str(support_basis.get("coverage") or "generic_support_pattern_no_supplier_pinout")
        )
        expected = []
        pinout_status = str(support_basis.get("pinout_status") or "not_applicable")
        pinout_signal_group_count = 0
        if pinout_file:
            pinout = load_yaml(PINOUT_DIR / pinout_file)
            expected = pinout_expected_pins(pinout, name)
            pinout_status = pinout.get(
                "procurement_status", pinout.get("evidence_class", "captured")
            )
            pinout_signal_group_count = signal_group_count(pinout)
            if coverage == "public_som_pinout_pad_count_aligned" and not expected:
                expected = list(electrical_pads)
        elif support_basis:
            expected = [
                str(item) for item in cast("list[Any]", support_basis.get("terminal_contract", []))
            ]
        missing = sorted(set(expected) - set(electrical_pads), key=str)
        extra = sorted(set(electrical_pads) - set(expected), key=str) if expected else []
        exact_match = bool(expected) and not missing and not extra
        if support_basis and not expected:
            exact_match = len(electrical_pads) == int(record.get("pin_count", 0))
        if coverage == "public_som_pinout_pad_count_aligned":
            exact_match = len(electrical_pads) == int(record.get("pin_count", 0))
        if coverage.startswith("exact") or coverage.startswith("public_som"):
            exact_public += int(exact_match)
        if "pending" in coverage or record["status"] == "geometry_only_pending_supplier_pad_map":
            blocked += 1
        if binding:
            local_terminal_contract = list(expected)
            local_terminal_contract_source = "captured_public_pinout_expected_pins"
        else:
            local_terminal_contract = [
                str(item) for item in cast("list[Any]", support_basis.get("terminal_contract", []))
            ]
            local_terminal_contract_source = record.get("local_terminal_contract_source", "")
        npth_feature_contract = [
            dict(item)
            for item in cast("list[Any]", support_basis.get("npth_mechanical_feature_contract", []))
            if isinstance(item, dict)
        ]
        npth_feature_contract_matches_footprint = len(npth_feature_contract) == len(
            npth_features
        ) and all(
            any(
                feature.get("hole_type") == contract.get("hole_type")
                and feature.get("drill_mm") == contract.get("drill_mm")
                and feature.get("plating") == contract.get("plating")
                and feature.get("electrical_terminal") is contract.get("electrical_terminal")
                for feature in npth_features
            )
            for contract in npth_feature_contract
        )
        audit_records.append(
            {
                "footprint": name,
                "footprint_file": str(path.relative_to(ROOT)),
                "board_instance_count": board_text.count(f'(footprint "e1-phone-dev:{name}"'),
                "manifest_pin_count": record.get("pin_count", 0),
                "pad_count": len(numbered_pads),
                "electrical_pad_count": len(electrical_pads),
                "mechanical_pad_count": len(mechanical_pads),
                "mechanical_pads": mechanical_pads,
                "npth_mechanical_feature_count": len(npth_features),
                "npth_mechanical_features": npth_features,
                "npth_mechanical_feature_contract": npth_feature_contract,
                "npth_mechanical_feature_contract_source": (
                    "generated_development_footprint_support_pattern_basis"
                    if npth_feature_contract
                    else ""
                ),
                "npth_mechanical_feature_contract_matches_footprint": (
                    npth_feature_contract_matches_footprint
                ),
                "non_signal_pad_contract": non_signal_pad_contract,
                "non_signal_pad_contract_source": non_signal_pad_contract_source,
                "non_signal_pad_contract_matches_pad_visuals": all(
                    pad_name in numbered_pads for pad_name in non_signal_pad_contract
                ),
                "electrical_pad_count_matches_manifest": len(electrical_pads)
                == record.get("pin_count", 0),
                "pinout_file": f"board/kicad/e1-phone/supplier-pinouts/{pinout_file}"
                if pinout_file
                else "",
                "pinout_status": pinout_status,
                "coverage": coverage,
                "expected_pin_count": len(expected),
                "pinout_pad_count_alignment": len(electrical_pads) == record.get("pin_count", 0)
                if coverage == "public_som_pinout_pad_count_aligned"
                else None,
                "expected_pins_match_footprint_pads": exact_match if expected else None,
                "missing_expected_pads": missing,
                "extra_footprint_pads": extra,
                "pinout_signal_group_count": pinout_signal_group_count,
                "land_pattern_basis": support_basis.get("land_pattern_basis")
                or record.get("land_pattern_basis")
                or "",
                "local_terminal_contract": local_terminal_contract,
                "local_terminal_contract_source": local_terminal_contract_source,
                "support_pattern_has_explicit_provenance": bool(support_basis),
                "step_binding_status": record["step_binding_status"],
                "release_allowed": False,
            }
        )

    output = {
        "schema": "eliza.e1_phone_development_pad_pin_coverage_audit.v1",
        "date": "2026-05-22",
        "status": "development_pad_pin_coverage_audited_not_release",
        "claim_boundary": (
            "Audits non-release development footprint pad IDs/counts against captured public "
            "pinout evidence and the bound real-footprint development board. This does not "
            "promote supplier pinouts, land patterns, or STEP models to production release."
        ),
        "source_artifacts": [
            "board/kicad/e1-phone/development-footprint-library-manifest-2026-05-22.yaml",
            "board/kicad/e1-phone/supplier-pinouts/pinout-evidence-manifest.yaml",
            "board/kicad/e1-phone/pcb/e1-phone-mainboard-real-footprint-development.kicad_pcb",
        ],
        "footprint_count": len(audit_records),
        "board_bound_footprint_type_count": sum(
            1 for item in audit_records if item["board_instance_count"] > 0
        ),
        "exact_public_pinout_match_count": exact_public,
        "pending_supplier_pad_map_or_order_count": blocked,
        "pinout_bound_footprint_count": sum(1 for item in audit_records if item["pinout_file"]),
        "all_pinout_bound_footprints_have_terminal_contract": all(
            bool(item["local_terminal_contract"]) for item in audit_records if item["pinout_file"]
        ),
        "explicit_support_pattern_count": sum(
            1 for item in audit_records if item["support_pattern_has_explicit_provenance"]
        ),
        "all_support_patterns_have_explicit_provenance": all(
            item["support_pattern_has_explicit_provenance"]
            for item in audit_records
            if not item["pinout_file"]
        ),
        "all_electrical_pad_counts_match_manifest": all(
            item["electrical_pad_count_matches_manifest"] for item in audit_records
        ),
        "non_signal_pad_contract_count": sum(
            len(item["non_signal_pad_contract"]) for item in audit_records
        ),
        "footprints_with_non_signal_pad_contract_count": sum(
            1 for item in audit_records if item["non_signal_pad_contract"]
        ),
        "all_non_signal_pads_have_contract": all(
            item["mechanical_pad_count"] == len(item["non_signal_pad_contract"])
            and item["non_signal_pad_contract_matches_pad_visuals"] is True
            for item in audit_records
        ),
        "npth_mechanical_feature_contract_count": sum(
            len(item["npth_mechanical_feature_contract"]) for item in audit_records
        ),
        "footprints_with_npth_mechanical_feature_contract_count": sum(
            1 for item in audit_records if item["npth_mechanical_feature_contract"]
        ),
        "all_npth_mechanical_features_have_contract": all(
            item["npth_mechanical_feature_count"] == len(item["npth_mechanical_feature_contract"])
            and item["npth_mechanical_feature_contract_matches_footprint"] is True
            for item in audit_records
            if item["npth_mechanical_feature_count"] > 0
        ),
        "all_expected_public_pins_present": all(
            item["expected_pins_match_footprint_pads"] is not False for item in audit_records
        ),
        "public_som_pad_count_aligned": all(
            item["pinout_pad_count_alignment"] is not False for item in audit_records
        ),
        "records": audit_records,
        "release_blockers_preserved": [
            "display/camera exact FPC ordering still requires signed module drawings",
            "Murata Type 2EA public table/DXF and Quectel public pin table still require supplier/CM signoff",
            "development footprints require DFM review and supplier land-pattern signoff before release",
        ],
    }
    OUT.write_text(yaml.safe_dump(output, sort_keys=False), encoding="utf-8")
    print(
        "development pad/pin coverage audit ok: "
        f"{len(audit_records)} footprints, {exact_public} exact public matches, {blocked} blocked"
    )


if __name__ == "__main__":
    main()
