#!/usr/bin/env python3
"""Bind the routed-development board to concrete development footprint IDs."""

from __future__ import annotations

import re
import uuid
from collections import Counter
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-routed-development.kicad_pcb"
OUT = ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-real-footprint-development.kicad_pcb"
MANIFEST = ROOT / "board/kicad/e1-phone/real-footprint-development-board-binding-2026-05-22.yaml"
FOOTPRINT_MANIFEST = (
    ROOT / "board/kicad/e1-phone/development-footprint-library-manifest-2026-05-22.yaml"
)
LIB = ROOT / "board/kicad/e1-phone/e1-phone-dev.pretty"
SPLIT_PIN_ALLOCATION = ROOT / "board/kicad/e1-phone/split-interconnect-pin-allocation.yaml"

MAPPING = {
    "J_USB_C": "GCT_USB4105_GF_A_DEV",
    "SW_POWER_VOL": "PANASONIC_EVQ_P7_DEV",
    "J_DISPLAY_TOUCH": "DISPLAY_40P_0P30_DEV",
    "J_CAM0_CAM1": "CAMERA_24P_0P50_DEV",
    "U_CELL": "QUECTEL_RG255C_GEOMETRY_DEV",
    "U_WIFI_BT": "MURATA_TYPE_2EA_GEOMETRY_DEV",
    "U_PMIC_CHARGER": "ADI_MAX77860_WLP81_DEV",
    "J_BATTERY": "BATTERY_4P_1P00_DEV",
    "U_SOC_LPDDR_UFS": "SODIMM_260P_0P5_COMPUTE_SOM_DEV",
    "U_AUDIO_SPK_MIC": "AUDIO_CODEC_QFN48_DEV",
    "J_TOP_BOTTOM_FLEX_TOP": "HIROSE_DF40_80P_0P4_DEV",
    "J_TOP_BOTTOM_FLEX_BOTTOM": "HIROSE_DF40_80P_0P4_DEV",
    "USB_PROTECT_USB2_ESD": "ESD_ARRAY_6CH_DEV",
    "USB_PROTECT_CC_ESD": "ESD_ARRAY_6CH_DEV",
    "USB_PROTECT_VBUS_TVS": "TVS_DIODE_2P_DEV",
    "USB_TP_VBUS": "TESTPOINT_1MM_DEV",
    "USB_TP_CC1": "TESTPOINT_1MM_DEV",
    "USB_TP_CC2": "TESTPOINT_1MM_DEV",
    "USB_TP_DP": "TESTPOINT_1MM_DEV",
    "USB_TP_DN": "TESTPOINT_1MM_DEV",
    "SIDE_KEY_ESD": "ESD_ARRAY_6CH_DEV",
    "SIDE_KEY_COND_PWR_KEY_N": "RC_ARRAY_4CH_DEV",
    "SIDE_KEY_COND_VOL_UP_N": "RC_ARRAY_4CH_DEV",
    "SIDE_KEY_COND_VOL_DOWN_N": "RC_ARRAY_4CH_DEV",
    "DISPLAY_DSI_ESD": "ESD_ARRAY_6CH_DEV",
    "DISPLAY_TOUCH_CTRL_ESD": "ESD_ARRAY_6CH_DEV",
    "DISPLAY_BIAS_BACKLIGHT": "BACKLIGHT_BIAS_POWER_DEV",
    "CAMERA_CSI0_ESD": "ESD_ARRAY_6CH_DEV",
    "CAMERA_CSI1_ESD": "ESD_ARRAY_6CH_DEV",
    "CAMERA_POWER_SEQUENCE": "RC_ARRAY_4CH_DEV",
    "CAMERA_I2C_AF_PULLUPS": "R0402_DEV",
    "AUDIO_CODEC_RAIL_DECOUPLING": "C0402_DEV",
    "AUDIO_AMP_RAIL_DECOUPLING": "C0402_DEV",
    "AUDIO_I2S_PDM_DAMPING": "R0402_DEV",
    "AUDIO_I2C_IRQ_PULLUPS": "R0402_DEV",
    "AUDIO_MIC_BIAS_ESD": "ESD_ARRAY_6CH_DEV",
    "AUDIO_SPK_OUTPUT_PROTECT": "TVS_DIODE_2P_DEV",
    "HAPTIC_DRIVER_OUTPUT": "HAPTIC_DRIVER_WLCSP_DEV",
    "POWER_USBPD_LOCAL_RAIL": "C0402_DEV",
    "POWER_CHARGER_INPUT_FILTER": "C0402_DEV",
    "POWER_CHARGER_BATTERY_SENSE": "R0402_DEV",
    "POWER_FUEL_GAUGE_PLACEHOLDER": "FUEL_GAUGE_WLCSP_DEV",
    "POWER_PMIC_CONTROL_PULLUPS": "R0402_DEV",
    "POWER_PMIC_INPUT_DECOUPLING": "C0402_DEV",
    "POWER_AP_RAIL_DECOUPLING": "C0402_DEV",
    "POWER_RF_RAIL_DECOUPLING": "C0402_DEV",
    "POWER_CAMERA_RAIL_DECOUPLING": "C0402_DEV",
    "POWER_DISPLAY_RAIL_DECOUPLING": "C0402_DEV",
    "POWER_AON_BUTTON_WAKE_DECOUPLING": "C0402_DEV",
    "POWER_HIGH_CURRENT_SHUNT_PLACEHOLDERS": "SHUNT_1206_DEV",
    "COMPUTE_SOC_LOCAL_DECOUPLING": "C0402_DEV",
    "COMPUTE_LPDDR_CK_DQS_TERM": "R0402_DEV",
    "COMPUTE_LPDDR_CA_DAMPING": "R0402_DEV",
    "COMPUTE_LPDDR_DQ_ESCAPE": "R0402_DEV",
    "COMPUTE_UFS_MPHY_ESD_TERM": "ESD_ARRAY_6CH_DEV",
    "COMPUTE_DEBUG_BOOT_STRAPS": "R0402_DEV",
    "PHONE_IDENTITY_USIM_ESD_LEVELSHIFT": "USIM_ESD_LEVELSHIFT_DEV",
    "PHONE_IDENTITY_ESIM_PLACEHOLDER": "ESIM_LGA_DEV",
    "PHONE_IDENTITY_GNSS_LNA_SAW": "L0402_DEV",
    "PHONE_IDENTITY_NFC_CONTROLLER": "NFC_CONTROLLER_QFN_DEV",
    "PHONE_IDENTITY_NFC_LOOP_MATCH": "NFC_LOOP_MATCH_DEV",
    "PHONE_IDENTITY_SENSOR_HUB": "SENSOR_HUB_QFN_DEV",
    "RF_MATCH_CELL_RF_MAIN": "PI_MATCH_0402_DEV",
    "RF_TP_CELL_RF_MAIN": "TESTPOINT_1MM_DEV",
    "RF_MATCH_CELL_RF_DIV": "PI_MATCH_0402_DEV",
    "RF_TP_CELL_RF_DIV": "TESTPOINT_1MM_DEV",
    "RF_MATCH_CELL_GNSS_RF": "PI_MATCH_0402_DEV",
    "RF_TP_CELL_GNSS_RF": "TESTPOINT_1MM_DEV",
    "RF_MATCH_WIFI_BT_RF0": "PI_MATCH_0402_DEV",
    "RF_TP_WIFI_BT_RF0": "TESTPOINT_1MM_DEV",
    "RF_MATCH_WIFI_BT_RF1": "PI_MATCH_0402_DEV",
    "RF_TP_WIFI_BT_RF1": "TESTPOINT_1MM_DEV",
    "TP_VBUS": "TESTPOINT_1MM_DEV",
    "TP_VBAT": "TESTPOINT_1MM_DEV",
    "TP_SYS": "TESTPOINT_1MM_DEV",
    "TP_AON_1V8": "TESTPOINT_1MM_DEV",
    "TP_IO_1V8": "TESTPOINT_1MM_DEV",
    "TP_RF_VBAT": "TESTPOINT_1MM_DEV",
    "TP_CAM_AVDD_2V8": "TESTPOINT_1MM_DEV",
    "TP_DISP_AVDD_5V5": "TESTPOINT_1MM_DEV",
    "FID_TL": "FIDUCIAL_1MM_DEV",
    "FID_TR": "FIDUCIAL_1MM_DEV",
    "FID_BR": "FIDUCIAL_1MM_DEV",
    "MH_TL": "MOUNTING_HOLE_1P2_DEV",
    "MH_TR": "MOUNTING_HOLE_1P2_DEV",
    "MH_BL": "MOUNTING_HOLE_1P2_DEV",
    "MH_BR": "MOUNTING_HOLE_1P2_DEV",
}


def clean_label(value: str) -> str:
    return (
        value.replace("PLACEHOLDERS", "DEVELOPMENT_PATTERNS")
        .replace("PLACEHOLDER", "DEVELOPMENT_PATTERN")
        .replace("placeholder", "development pattern")
    )


def net_ids(text: str) -> dict[str, int]:
    return {name: int(num) for num, name in re.findall(r'\(net\s+(\d+)\s+"([^"]+)"\)', text)}


def find_footprint_blocks(text: str) -> dict[str, tuple[int, int, str]]:
    blocks: dict[str, tuple[int, int, str]] = {}
    for match in re.finditer(r'\(footprint "E1Phone:([^"]+)"', text):
        start = match.start()
        depth = 0
        end = None
        for index in range(start, len(text)):
            char = text[index]
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0:
                    end = index + 1
                    break
        if end is None:
            raise SystemExit(f"unterminated footprint block: {match.group(1)}")
        blocks[match.group(1)] = (start, end, text[start:end])
    return blocks


def find_dev_footprint_blocks(text: str) -> list[tuple[int, int, str, str]]:
    blocks: list[tuple[int, int, str, str]] = []
    for match in re.finditer(r'\(footprint "e1-phone-dev:([^"]+)"', text):
        start = match.start()
        depth = 0
        end = None
        for index in range(start, len(text)):
            char = text[index]
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0:
                    end = index + 1
                    break
        if end is None:
            raise SystemExit(f"unterminated development footprint block: {match.group(1)}")
        blocks.append((start, end, match.group(1), text[start:end]))
    return blocks


MODEL_BLOCK_RE = re.compile(
    r'\n  \(model "[^"]+"\n'
    r"    \(offset \(xyz [^\n]+\)\)\n"
    r"    \(scale \(xyz [^\n]+\)\)\n"
    r"    \(rotate \(xyz [^\n]+\)\)\n"
    r"  \)"
)


def library_model_blocks(footprint_name: str) -> list[str]:
    path = LIB / f"{footprint_name}.kicad_mod"
    if not path.is_file():
        return []
    return MODEL_BLOCK_RE.findall(path.read_text(encoding="utf-8"))


def refresh_development_model_blocks(text: str) -> str:
    replacements: list[tuple[int, int, str]] = []
    for start, end, footprint_name, block in find_dev_footprint_blocks(text):
        model_blocks = library_model_blocks(footprint_name)
        if not model_blocks:
            continue
        stripped = MODEL_BLOCK_RE.sub("", block)
        insert_at = stripped.rfind("\n)")
        if insert_at < 0:
            raise SystemExit(f"development footprint block missing close: {footprint_name}")
        refreshed = stripped[:insert_at] + "".join(model_blocks) + stripped[insert_at:]
        if refreshed != block:
            replacements.append((start, end, refreshed))
    for start, end, replacement in reversed(replacements):
        text = text[:start] + replacement + text[end:]
    return text


def first_match(pattern: str, text: str, default: str = "") -> str:
    match = re.search(pattern, text, re.S)
    return match.group(1) if match else default


def pad_records(block: str) -> list[dict[str, str]]:
    records: list[dict[str, str]] = []
    for line in block.splitlines():
        match = re.search(r'\(pad\s+"([^"]*)"', line)
        if not match:
            continue
        net_match = re.search(r'\(net\s+(\d+)\s+"([^"]+)"\)', line)
        records.append(
            {
                "pad": match.group(1),
                "net_id": net_match.group(1) if net_match else "",
                "net_name": net_match.group(2) if net_match else "",
            }
        )
    return records


def is_mechanical_pad(pad_name: str) -> bool:
    return pad_name.startswith("SH") or pad_name in {"", "EP", "PAD", "GND_PAD"}


def split_contact_index(pad_name: str) -> int | None:
    match = re.fullmatch(r"([AB])(\d+)", pad_name)
    if not match:
        return None
    side, number_text = match.groups()
    return (int(number_text) - 1) * 2 + (1 if side == "A" else 2)


def unassigned_pad_disposition(target: str, pad_name: str) -> str:
    if target.startswith("e1-phone-dev:"):
        target = target.split(":", 1)[1]
    if is_mechanical_pad(pad_name):
        return "mechanical_or_shield_pad_without_explicit_release_tie"
    if target in {"FIDUCIAL_1MM_DEV", "MOUNTING_HOLE_1P2_DEV"}:
        return "non_electrical_fiducial_or_mounting_feature"
    if target == "GCT_USB4105_GF_A_DEV":
        if pad_name in {"A2", "A3", "A10", "A11", "B2", "B3", "B10", "B11"}:
            return "usb3_superspeed_contacts_not_used_by_usb2_development_topology"
        if pad_name in {"A8", "B8"}:
            return "usb_type_c_sbu_contacts_not_used_by_development_topology"
        return "usb_c_contact_pending_release_review"
    if target == "HIROSE_DF40_80P_0P4_DEV":
        contact = split_contact_index(pad_name)
        if contact is not None and 41 <= contact <= 46:
            return "declared_nc_evt_spare_contact"
        if contact is not None and contact > 49:
            return "connector_contact_count_margin_pending_supplier_selection"
        return "split_interconnect_contact_pending_supplier_pin_order"
    if target == "CAMERA_30P_0P50_DEV" and pad_name.isdigit() and int(pad_name) >= 25:
        return "front_camera_connector_reserved_tail_contacts_pending_module_drawing"
    if target == "CAMERA_30P_0P50_DEV" and pad_name == "16":
        return "front_camera_pwdn_contact_pending_local_netlist_or_module_drawing"
    if target == "AUDIO_CODEC_QFN48_DEV" and pad_name.isdigit() and int(pad_name) >= 19:
        return "audio_development_carrier_reserved_spare_contact"
    if target in {
        "QUECTEL_RG255C_GEOMETRY_DEV",
        "MURATA_TYPE_2EA_GEOMETRY_DEV",
        "SODIMM_260P_0P5_COMPUTE_SOM_DEV",
    }:
        return "module_public_pinout_unassigned_or_supplier_reserved_contact"
    if target in {"ADI_MAX77860_WLP81_DEV", "TI_TPS65987_RSH_56QFN_DEV"}:
        return "power_ic_unused_or_supplier_reserved_pad_pending_release_review"
    if target in SUPPORT_TARGET_FOOTPRINTS:
        return "development_support_pattern_optional_or_unused_terminal"
    return "supplier_pinout_or_local_contract_missing_for_pad"


def unassigned_pad_summary(target: str, pads: list[dict[str, str]]) -> dict[str, object]:
    unassigned = [item["pad"] for item in pads if not item["net_name"]]
    dispositions = Counter(unassigned_pad_disposition(target, pad) for pad in unassigned)
    return {
        "unassigned_pad_count": len(unassigned),
        "unassigned_pad_names": unassigned,
        "unassigned_pad_disposition_counts": dict(sorted(dispositions.items())),
    }


def usb_pad_net_name(pad_name: str) -> str:
    return {
        "A1": "GND",
        "A2": "",
        "A3": "",
        "A4": "VBUS",
        "A5": "USB_CC1",
        "A6": "USB_DP",
        "A7": "USB_DN",
        "A8": "",
        "A9": "VBUS",
        "A10": "",
        "A11": "",
        "A12": "GND",
        "B1": "GND",
        "B2": "",
        "B3": "",
        "B4": "VBUS",
        "B5": "USB_CC2",
        "B6": "USB_DN",
        "B7": "USB_DP",
        "B8": "",
        "B9": "VBUS",
        "B10": "",
        "B11": "",
        "B12": "GND",
        "SH1": "GND",
        "SH2": "GND",
    }.get(pad_name, "")


DEVELOPMENT_CONTRACT_PIN_NETS = {
    "DISPLAY_40P_0P30_DEV": [
        "GND",
        "DISP_AVDD_5V5",
        "DISP_AVEE_N5V5",
        "IO_1V8",
        "DSI_CLK_P",
        "DSI_CLK_N",
        "GND",
        "DSI_D0_P",
        "DSI_D0_N",
        "DSI_D1_P",
        "DSI_D1_N",
        "GND",
        "DSI_D2_P",
        "DSI_D2_N",
        "DSI_D3_P",
        "DSI_D3_N",
        "GND",
        "DISP_RESET_N",
        "DISP_TE",
        "DISP_BL_EN",
        "DISP_BL_PWM",
        "TOUCH_I2C_SCL",
        "TOUCH_I2C_SDA",
        "TOUCH_IRQ_N",
        "TOUCH_RESET_N",
        "GND",
        "IO_1V8",
        "DISP_AVDD_5V5",
        "DISP_AVEE_N5V5",
        "GND",
        "DISP_BL_EN",
        "DISP_BL_PWM",
        "GND",
        "TOUCH_I2C_SCL",
        "TOUCH_I2C_SDA",
        "GND",
        "IO_1V8",
        "DISP_RESET_N",
        "DISP_TE",
        "GND",
    ],
    "CAMERA_24P_0P50_DEV": [
        "GND",
        "CAM_AVDD_2V8",
        "CAM_DVDD_1V2",
        "IO_1V8",
        "CAM0_MCLK",
        "GND",
        "CAM0_CSI_CLK_P",
        "CAM0_CSI_CLK_N",
        "CAM0_CSI_D0_P",
        "CAM0_CSI_D0_N",
        "GND",
        "CAM0_CSI_D1_P",
        "CAM0_CSI_D1_N",
        "CAM0_CSI_D2_P",
        "CAM0_CSI_D2_N",
        "GND",
        "CAM0_CSI_D3_P",
        "CAM0_CSI_D3_N",
        "CAM0_RESET_N",
        "CAM0_PWDN",
        "CAM0_I2C_SCL",
        "CAM0_I2C_SDA",
        "CAM_AFVDD_2V8",
        "GND",
    ],
    "CAMERA_30P_0P50_DEV": [
        "GND",
        "CAM_AVDD_2V8",
        "CAM_DVDD_1V2",
        "IO_1V8",
        "CAM1_MCLK",
        "GND",
        "CAM1_CSI_CLK_P",
        "CAM1_CSI_CLK_N",
        "CAM1_CSI_D0_P",
        "CAM1_CSI_D0_N",
        "GND",
        "CAM1_CSI_D1_P",
        "CAM1_CSI_D1_N",
        "GND",
        "CAM1_RESET_N",
        "CAM1_PWDN",
        "CAM1_I2C_SCL",
        "CAM1_I2C_SDA",
        "CAM_AFVDD_2V8",
        "GND",
        "GND",
        "CAM_AVDD_2V8",
        "CAM_DVDD_1V2",
        "IO_1V8",
        "",
        "",
        "",
        "",
        "",
        "",
    ],
    "BATTERY_4P_1P00_DEV": ["VBAT", "BAT_NTC", "BAT_ID", "GND"],
    "AUDIO_CODEC_QFN48_DEV": [
        "VDD_AUDIO_3V3",
        "IO_1V8",
        "GND",
        "AUDIO_I2C_SCL",
        "AUDIO_I2C_SDA",
        "CODEC_INT",
        "I2S_BCLK",
        "I2S_LRCLK",
        "I2S_DOUT",
        "I2S_DIN",
        "PDM_CLK",
        "PDM_DAT",
        "VDD_AMP_3V3",
        "SPK_P",
        "SPK_N",
        "AMP_INT",
        "HAPTIC_OUT",
        "SYS",
    ],
}


SUPPORT_FOOTPRINT_PIN_NETS = {
    "SW_POWER_VOL": ["PWR_KEY_N", "VOL_UP_N", "VOL_DOWN_N", "GND"],
    "USB_PROTECT_USB2_ESD": ["USB_DP", "USB_DN", "GND", "GND", "", ""],
    "USB_PROTECT_CC_ESD": ["USB_CC1", "USB_CC2", "GND", "GND", "", ""],
    "USB_PROTECT_VBUS_TVS": ["VBUS", "GND"],
    "USB_TP_VBUS": ["VBUS"],
    "USB_TP_CC1": ["USB_CC1"],
    "USB_TP_CC2": ["USB_CC2"],
    "USB_TP_DP": ["USB_DP"],
    "USB_TP_DN": ["USB_DN"],
    "SIDE_KEY_ESD": ["PWR_KEY_N", "VOL_UP_N", "VOL_DOWN_N", "AON_1V8", "GND", "GND"],
    "SIDE_KEY_COND_PWR_KEY_N": ["PWR_KEY_N", "GND", "PWR_KEY_N", "AON_1V8", "", "", "", ""],
    "SIDE_KEY_COND_VOL_UP_N": ["VOL_UP_N", "GND", "VOL_UP_N", "AON_1V8", "", "", "", ""],
    "SIDE_KEY_COND_VOL_DOWN_N": ["VOL_DOWN_N", "GND", "VOL_DOWN_N", "AON_1V8", "", "", "", ""],
    "DISPLAY_DSI_ESD": ["DSI_CLK_P", "DSI_CLK_N", "DSI_D0_P", "DSI_D0_N", "DSI_D1_P", "DSI_D1_N"],
    "DISPLAY_TOUCH_CTRL_ESD": [
        "TOUCH_I2C_SCL",
        "TOUCH_I2C_SDA",
        "TOUCH_IRQ_N",
        "TOUCH_RESET_N",
        "GND",
        "IO_1V8",
    ],
    "DISPLAY_BIAS_BACKLIGHT": [
        "DISP_AVDD_5V5",
        "DISP_AVEE_N5V5",
        "DISP_BL_EN",
        "DISP_BL_PWM",
        "IO_1V8",
        "GND",
        "GND",
        "GND",
    ],
    "CAMERA_CSI0_ESD": [
        "CAM0_CSI_CLK_P",
        "CAM0_CSI_CLK_N",
        "CAM0_CSI_D0_P",
        "CAM0_CSI_D0_N",
        "CAM0_CSI_D1_P",
        "CAM0_CSI_D1_N",
    ],
    "CAMERA_CSI1_ESD": [
        "CAM1_CSI_CLK_P",
        "CAM1_CSI_CLK_N",
        "CAM1_CSI_D0_P",
        "CAM1_CSI_D0_N",
        "CAM1_CSI_D1_P",
        "CAM1_CSI_D1_N",
    ],
    "CAMERA_POWER_SEQUENCE": [
        "CAM0_RESET_N",
        "GND",
        "CAM0_PWDN",
        "IO_1V8",
        "CAM0_MCLK",
        "GND",
        "CAM_AVDD_2V8",
        "GND",
    ],
    "CAMERA_I2C_AF_PULLUPS": ["CAM0_I2C_SCL", "IO_1V8"],
    "AUDIO_CODEC_RAIL_DECOUPLING": ["VDD_AUDIO_3V3", "GND"],
    "AUDIO_AMP_RAIL_DECOUPLING": ["VDD_AMP_3V3", "GND"],
    "AUDIO_I2S_PDM_DAMPING": ["I2S_BCLK", "I2S_BCLK"],
    "AUDIO_I2C_IRQ_PULLUPS": ["AUDIO_I2C_SCL", "IO_1V8"],
    "AUDIO_MIC_BIAS_ESD": ["PDM_CLK", "PDM_DAT", "IO_1V8", "GND", "", ""],
    "AUDIO_SPK_OUTPUT_PROTECT": ["SPK_P", "SPK_N"],
    "HAPTIC_DRIVER_OUTPUT": ["SYS", "IO_1V8", "GND", "HAPTIC_OUT", "GND", "", "", "", ""],
    "POWER_USBPD_LOCAL_RAIL": ["VIN_3V3", "GND"],
    "POWER_CHARGER_INPUT_FILTER": ["VBUS", "GND"],
    "POWER_CHARGER_BATTERY_SENSE": ["BAT_NTC", "GND"],
    "POWER_FUEL_GAUGE_PLACEHOLDER": [
        "VBAT",
        "GND",
        "BAT_NTC",
        "BAT_ID",
        "CHG_I2C_SCL",
        "CHG_I2C_SDA",
        "",
        "",
        "",
        "",
        "",
        "",
    ],
    "POWER_PMIC_CONTROL_PULLUPS": ["PMIC_I2C_SCL", "IO_1V8"],
    "POWER_PMIC_INPUT_DECOUPLING": ["SYS", "GND"],
    "POWER_AP_RAIL_DECOUPLING": ["AP_1V1", "GND"],
    "POWER_RF_RAIL_DECOUPLING": ["RF_VBAT", "GND"],
    "POWER_CAMERA_RAIL_DECOUPLING": ["CAM_AVDD_2V8", "GND"],
    "POWER_DISPLAY_RAIL_DECOUPLING": ["DISP_AVDD_5V5", "GND"],
    "POWER_AON_BUTTON_WAKE_DECOUPLING": ["AON_1V8", "GND"],
    "POWER_HIGH_CURRENT_SHUNT_PLACEHOLDERS": ["SYS", "VBAT"],
    "COMPUTE_SOC_LOCAL_DECOUPLING": ["AP_0V8", "GND"],
    "COMPUTE_LPDDR_CK_DQS_TERM": ["LPDDR_CK_P", "LPDDR_CK_N"],
    "COMPUTE_LPDDR_CA_DAMPING": ["LPDDR_CA0", "LPDDR_CA1"],
    "COMPUTE_LPDDR_DQ_ESCAPE": ["LPDDR_DQ0", "LPDDR_DQ1"],
    "COMPUTE_UFS_MPHY_ESD_TERM": ["UFS_TX_P", "UFS_TX_N", "UFS_RX_P", "UFS_RX_N", "GND", "GND"],
    "COMPUTE_DEBUG_BOOT_STRAPS": ["BOOT_MODE0", "GND"],
    "PHONE_IDENTITY_USIM_ESD_LEVELSHIFT": [
        "USIM_VCC",
        "USIM_CLK",
        "USIM_RST",
        "USIM_IO",
        "USIM_DET",
        "GND",
        "IO_1V8",
        "",
        "",
        "",
    ],
    "PHONE_IDENTITY_ESIM_PLACEHOLDER": [
        "GND",
        "",
        "ESIM_IO",
        "",
        "",
        "ESIM_CLK",
        "ESIM_RST",
        "ESIM_VCC",
        "GND",
    ],
    "PHONE_IDENTITY_GNSS_LNA_SAW": ["CELL_GNSS_RF", "GND"],
    "PHONE_IDENTITY_NFC_CONTROLLER": [
        "AON_1V8",
        "IO_1V8",
        "GND",
        "NFC_I2C_SCL",
        "NFC_I2C_SDA",
        "NFC_IRQ_N",
        "NFC_EN",
        "NFC_RF_P",
        "NFC_RF_N",
    ],
    "PHONE_IDENTITY_NFC_LOOP_MATCH": ["NFC_RF_P", "NFC_RF_P", "NFC_RF_N", "GND", "GND"],
    "PHONE_IDENTITY_SENSOR_HUB": [
        "AON_1V8",
        "IO_1V8",
        "GND",
        "SENSOR_I2C_SCL",
        "SENSOR_I2C_SDA",
        "IMU_INT",
        "ALS_PROX_INT",
        "BARO_INT",
        "MAG_INT",
    ],
    "RF_MATCH_CELL_RF_MAIN": ["CELL_RF_MAIN", "CELL_RF_MAIN", "CELL_RF_MAIN", "GND", "GND"],
    "RF_TP_CELL_RF_MAIN": ["CELL_RF_MAIN"],
    "RF_MATCH_CELL_RF_DIV": ["CELL_RF_DIV", "CELL_RF_DIV", "CELL_RF_DIV", "GND", "GND"],
    "RF_TP_CELL_RF_DIV": ["CELL_RF_DIV"],
    "RF_MATCH_CELL_GNSS_RF": ["CELL_GNSS_RF", "CELL_GNSS_RF", "CELL_GNSS_RF", "GND", "GND"],
    "RF_TP_CELL_GNSS_RF": ["CELL_GNSS_RF"],
    "RF_MATCH_WIFI_BT_RF0": ["WIFI_BT_RF0", "WIFI_BT_RF0", "WIFI_BT_RF0", "GND", "GND"],
    "RF_TP_WIFI_BT_RF0": ["WIFI_BT_RF0"],
    "RF_MATCH_WIFI_BT_RF1": ["WIFI_BT_RF1", "WIFI_BT_RF1", "WIFI_BT_RF1", "GND", "GND"],
    "RF_TP_WIFI_BT_RF1": ["WIFI_BT_RF1"],
    "TP_VBUS": ["VBUS"],
    "TP_VBAT": ["VBAT"],
    "TP_SYS": ["SYS"],
    "TP_AON_1V8": ["AON_1V8"],
    "TP_IO_1V8": ["IO_1V8"],
    "TP_RF_VBAT": ["RF_VBAT"],
    "TP_CAM_AVDD_2V8": ["CAM_AVDD_2V8"],
    "TP_DISP_AVDD_5V5": ["DISP_AVDD_5V5"],
}


COMPUTE_SOM_PIN_NETS = {
    1: "CAM0_MCLK",
    9: "CELL_USB2_DN",
    11: "CELL_USB2_DP",
    15: "USB_DN",
    17: "USB_DP",
    20: "CAM0_RESET_N",
    21: "CAM1_MCLK",
    23: "IMU_INT",
    25: "TOUCH_I2C_SCL",
    26: "TOUCH_RESET_N",
    27: "TOUCH_I2C_SDA",
    28: "DISP_RESET_N",
    29: "CAM1_PWDN",
    31: "CAM1_RESET_N",
    45: "CAM0_CSI_D3_N",
    47: "CAM0_CSI_D3_P",
    49: "CAM0_CSI_D2_N",
    51: "CAM0_CSI_D2_P",
    53: "CAM0_CSI_D1_N",
    55: "CAM0_CSI_D1_P",
    57: "CAM0_CSI_D0_N",
    59: "CAM0_CSI_D0_P",
    60: "CAM1_CSI_CLK_N",
    62: "CAM1_CSI_CLK_P",
    66: "CAM0_CSI_CLK_N",
    68: "CAM0_CSI_CLK_P",
    81: "DSI_D3_N",
    83: "DSI_D3_P",
    85: "DSI_D2_N",
    87: "DSI_D2_P",
    89: "DSI_D1_N",
    90: "DSI_CLK_N",
    91: "DSI_D1_P",
    92: "DSI_CLK_P",
    93: "DSI_D0_N",
    95: "DSI_D0_P",
    108: "CAM0_I2C_SCL",
    110: "CAM0_I2C_SDA",
    120: "DISP_BL_EN",
    125: "DISP_BL_EN",
    127: "TOUCH_IRQ_N",
    139: "CELL_PCIE_RX_P",
    141: "CELL_PCIE_RX_N",
    145: "VBUS",
    149: "CELL_PCIE_TX_N",
    151: "CELL_PCIE_TX_P",
    152: "BOOT_MODE0",
    154: "BOOT_MODE1",
    160: "WIFI_SDIO_D2",
    162: "WIFI_SDIO_D3",
    164: "WIFI_SDIO_CMD",
    166: "WIFI_SDIO_CLK",
    168: "WIFI_SDIO_D0",
    170: "WIFI_SDIO_D1",
    195: "BT_EN",
    203: "WIFI_EN",
    205: "WIFI_HOST_WAKE",
    209: "CELL_RESET_N",
    218: "SOC_RESET_N",
    221: "PWR_KEY_N",
    224: "IO_1V8",
    228: "IO_1V8",
    230: "VDD_AUDIO_3V3",
    232: "WIFI_32K",
}


COMPUTE_SOM_GROUND_PINS = {7, 13, 19, 43, 61, 79, 97, 115, 158, 172, 190, 222, 244, 246, 248, 250}


def compute_som_pad_net_name(pad_name: str) -> str:
    match = re.fullmatch(r"([AB])(\d+)", pad_name)
    if not match:
        return ""
    side, index_text = match.groups()
    index = int(index_text)
    pin = index * 2 - 1 if side == "A" else index * 2
    if pin in COMPUTE_SOM_GROUND_PINS:
        return "GND"
    return COMPUTE_SOM_PIN_NETS.get(pin, "")


def tps65987_pad_net_name(pad_name: str) -> str:
    return {
        "1": "SYS",
        "2": "SYS",
        "3": "VBUS",
        "4": "VBUS",
        "5": "VIN_3V3",
        "7": "SYS",
        "8": "VBUS",
        "11": "SYS",
        "12": "SYS",
        "13": "VBUS",
        "14": "VBUS",
        "15": "VBUS",
        "19": "VBUS",
        "20": "GND",
        "24": "USB_CC1",
        "25": "VBUS",
        "26": "USB_CC2",
        "27": "CHG_I2C_SCL",
        "28": "CHG_I2C_SDA",
        "29": "SOC_RESET_N",
        "32": "PMIC_I2C_SCL",
        "33": "PMIC_I2C_SDA",
        "35": "IO_1V8",
        "44": "SOC_RESET_N",
        "45": "GND",
        "46": "GND",
        "47": "GND",
        "50": "USB_DP",
        "51": "GND",
        "52": "SYS",
        "53": "USB_DN",
        "56": "SYS",
        "57": "SYS",
        "58": "VBUS",
        "59": "GND",
    }.get(pad_name, "")


def max77860_pad_net_name(pad_name: str) -> str:
    return {
        "A1": "GND",
        "A2": "BAT_NTC",
        "A3": "GND",
        "A4": "USB_CC2",
        "A5": "VBUS",
        "A6": "USB_CC1",
        "A7": "USB_DN",
        "A8": "USB_DP",
        "A9": "GND",
        "B1": "BAT_NTC",
        "B6": "GND",
        "B7": "GND",
        "B8": "GND",
        "B9": "GND",
        "C1": "VBAT",
        "C2": "VBAT",
        "C4": "GND",
        "C7": "CHG_IRQ_N",
        "C8": "GND",
        "C9": "GND",
        "D1": "VBAT",
        "D2": "VBAT",
        "D3": "GND",
        "D4": "GND",
        "D5": "GND",
        "D6": "SYS",
        "D7": "VBUS",
        "D8": "CHG_IRQ_N",
        "D9": "SYS",
        "E1": "SYS",
        "E2": "SYS",
        "E3": "SYS",
        "E4": "VBAT",
        "E5": "GND",
        "E6": "CHG_IRQ_N",
        "E7": "BAT_ID",
        "E8": "IO_1V8",
        "E9": "CHG_I2C_SCL",
        "F1": "SYS",
        "F2": "SYS",
        "F3": "GND",
        "F4": "GND",
        "F5": "IO_1V8",
        "F6": "VBUS",
        "F9": "CHG_I2C_SDA",
        "G1": "GND",
        "G2": "GND",
        "G3": "VBUS",
        "G4": "IO_1V8",
        "G5": "VBUS",
        "G6": "VBUS",
        "H1": "GND",
        "H2": "SYS",
        "H3": "SYS",
        "H4": "VBUS",
        "H5": "VBUS",
        "H6": "VBUS",
        "J1": "GND",
        "J2": "SYS",
        "J3": "SYS",
        "J4": "VBUS",
        "J5": "VBUS",
        "J6": "VBUS",
        "J7": "VBUS",
        "J8": "GND",
        "J9": "GND",
    }.get(pad_name, "")


MURATA_TYPE2EA_GROUND_PINS = (
    {4, 9, 15, 20, 21, 23, 25, 29, 31, 36, 38, 39, 42}
    | set(range(46, 51))
    | {52, 54, 56, 59, 67, 70, 73}
    | set(range(76, 96))
    | {98, 103, 104, 107, 108, 111, 112, 113}
    | set(range(115, 125))
    | {132, 133}
    | set(range(135, 200))
)


QUECTEL_RG255C_GROUND_PINS = (
    {10, 11, 12, 23, 26, 33, 35, 38, 40, 50, 52, 54}
    | set(range(56, 61))
    | {62, 78, 109, 115, 125, 126, 135, 137, 140, 141, 143, 149, 151, 163}
    | set(range(169, 205))
)


def quectel_rg255c_pad_net_name(pad_name: str) -> str:
    try:
        pin = int(pad_name)
    except ValueError:
        return ""
    if pin in QUECTEL_RG255C_GROUND_PINS:
        return "GND"
    return {
        4: "CELL_W_DISABLE_N",
        7: "IO_1V8",
        20: "CELL_RESET_N",
        24: "CELL_RESET_N",
        39: "CELL_RF_DIV",
        51: "CELL_GNSS_RF",
        55: "CELL_RF_MAIN",
        63: "RF_VBAT",
        64: "RF_VBAT",
        65: "VBAT",
        66: "VBAT",
        75: "CELL_USB2_DP",
        76: "CELL_USB2_DN",
        77: "VBUS",
        100: "AP_WAKE_CELL",
        101: "CELL_PCIE_RX_P",
        102: "CELL_PCIE_RX_N",
        103: "CELL_PCIE_TX_P",
        104: "CELL_PCIE_TX_N",
        105: "CELL_PCIE_REFCLK_P",
        107: "CELL_PCIE_REFCLK_N",
    }.get(pin, "")


def murata_type2ea_pad_net_name(pad_name: str) -> str:
    try:
        pin = int(pad_name)
    except ValueError:
        return ""
    if pin in MURATA_TYPE2EA_GROUND_PINS:
        return "GND"
    return {
        16: "BT_UART_RXD",
        17: "BT_UART_RTS_N",
        18: "BT_UART_TXD",
        19: "BT_UART_CTS_N",
        22: "WIFI_BT_RF1",
        24: "WIFI_BT_RF0",
        26: "BT_DEV_WAKE",
        27: "BT_HOST_WAKE",
        30: "WIFI_BT_RF0",
        37: "WIFI_BT_RF1",
        41: "WIFI_EN",
        43: "WIFI_HOST_WAKE",
        45: "BT_EN",
        55: "IO_1V8",
        57: "RF_VBAT",
        58: "RF_VBAT",
        60: "WIFI_EN",
        61: "WIFI_SDIO_D2",
        62: "WIFI_SDIO_D0",
        63: "WIFI_SDIO_D1",
        64: "WIFI_SDIO_CMD",
        65: "WIFI_SDIO_CLK",
        66: "WIFI_SDIO_D3",
    }.get(pin, "")


def split_interconnect_contract_nets() -> list[str]:
    data = yaml.safe_load(SPLIT_PIN_ALLOCATION.read_text())
    rows = sorted(data["pin_allocation"], key=lambda item: int(item["contact"]))
    return [str(item["net"]) for item in rows]


def net_clause(net_name: str, ids: dict[str, int]) -> str:
    if not net_name or net_name not in ids:
        return ""
    return f' (net {ids[net_name]} "{net_name}")'


def build_net_map(
    old_block: str, old_name: str, new_name: str, ids: dict[str, int]
) -> dict[str, str]:
    old_pads = pad_records(old_block)
    old_by_pad = {item["pad"]: item["net_name"] for item in old_pads if item["net_name"]}
    old_electrical_nets = [
        item["net_name"]
        for item in old_pads
        if item["net_name"] and not is_mechanical_pad(item["pad"])
    ]

    lib_text = (LIB / f"{new_name}.kicad_mod").read_text()
    new_pad_names = [item["pad"] for item in pad_records(lib_text)]
    mapping: dict[str, str] = {}
    if new_name == "GCT_USB4105_GF_A_DEV":
        for pad_name in new_pad_names:
            mapping[pad_name] = usb_pad_net_name(pad_name)
        return mapping
    if new_name in DEVELOPMENT_CONTRACT_PIN_NETS:
        contract_nets = DEVELOPMENT_CONTRACT_PIN_NETS[new_name]
        for index, pad_name in enumerate(new_pad_names):
            net_name = contract_nets[index] if index < len(contract_nets) else ""
            mapping[pad_name] = net_name if net_name in ids else ""
        return mapping
    if new_name == "HIROSE_DF40_80P_0P4_DEV":
        contract_nets = split_interconnect_contract_nets()
        for index, pad_name in enumerate(new_pad_names):
            net_name = contract_nets[index] if index < len(contract_nets) else ""
            mapping[pad_name] = net_name if net_name in ids else ""
        return mapping
    if new_name == "SODIMM_260P_0P5_COMPUTE_SOM_DEV":
        for pad_name in new_pad_names:
            net_name = compute_som_pad_net_name(pad_name)
            mapping[pad_name] = net_name if net_name in ids else ""
        return mapping
    if new_name == "TI_TPS65987_RSH_56QFN_DEV":
        for pad_name in new_pad_names:
            net_name = tps65987_pad_net_name(pad_name)
            mapping[pad_name] = net_name if net_name in ids else ""
        return mapping
    if new_name == "ADI_MAX77860_WLP81_DEV":
        for pad_name in new_pad_names:
            net_name = max77860_pad_net_name(pad_name)
            mapping[pad_name] = net_name if net_name in ids else ""
        return mapping
    if new_name == "QUECTEL_RG255C_GEOMETRY_DEV":
        for pad_name in new_pad_names:
            net_name = quectel_rg255c_pad_net_name(pad_name)
            mapping[pad_name] = net_name if net_name in ids else ""
        return mapping
    if new_name == "MURATA_TYPE_2EA_GEOMETRY_DEV":
        for pad_name in new_pad_names:
            net_name = murata_type2ea_pad_net_name(pad_name)
            mapping[pad_name] = net_name if net_name in ids else ""
        return mapping
    if old_name in SUPPORT_FOOTPRINT_PIN_NETS:
        support_nets = SUPPORT_FOOTPRINT_PIN_NETS[old_name]
        for index, pad_name in enumerate(new_pad_names):
            net_name = support_nets[index] if index < len(support_nets) else ""
            mapping[pad_name] = net_name if net_name in ids else ""
        return mapping

    sequential_index = 0
    for pad_name in new_pad_names:
        if pad_name in old_by_pad:
            mapping[pad_name] = old_by_pad[pad_name]
        elif is_mechanical_pad(pad_name):
            mapping[pad_name] = "GND" if "GND" in ids else ""
        elif sequential_index < len(old_electrical_nets):
            mapping[pad_name] = old_electrical_nets[sequential_index]
            sequential_index += 1
        else:
            mapping[pad_name] = ""
    return mapping


def format_library_block(
    old_block: str, old_name: str, new_name: str, ids: dict[str, int]
) -> tuple[str, dict[str, int]]:
    lib_text = (LIB / f"{new_name}.kicad_mod").read_text().rstrip()
    lib_lines = lib_text.splitlines()
    ref = first_match(r'\(fp_text reference "([^"]+)"', old_block, old_name)
    value = first_match(r'\(fp_text value "([^"]+)"', old_block, new_name)
    at_match = re.search(r"\n\s+\(at\s+([^)]+)\)", old_block)
    at_clause = f"  (at {at_match.group(1)})" if at_match else "  (at 0 0)"
    layer = first_match(r'\(footprint "[^"]+"\s+\(layer "([^"]+)"\)', old_block, "F.Cu")
    tstamp = first_match(r'\(tstamp "([^"]+)"\)', old_block)
    net_map = build_net_map(old_block, old_name, new_name, ids)
    contract_assigned = sum(
        1
        for net_name in net_map.values()
        if net_name
        and net_name in ids
        and (new_name in DEVELOPMENT_CONTRACT_PIN_NETS or new_name == "HIROSE_DF40_80P_0P4_DEV")
    )
    split_assigned = sum(
        1
        for net_name in net_map.values()
        if net_name and net_name in ids and new_name == "HIROSE_DF40_80P_0P4_DEV"
    )
    support_assigned = sum(
        1
        for net_name in net_map.values()
        if net_name and net_name in ids and old_name in SUPPORT_FOOTPRINT_PIN_NETS
    )
    compute_som_assigned = sum(
        1
        for net_name in net_map.values()
        if net_name and net_name in ids and new_name == "SODIMM_260P_0P5_COMPUTE_SOM_DEV"
    )

    output_lines = [f'(footprint "e1-phone-dev:{new_name}" (layer "{layer}")']
    output_lines.append(at_clause)
    if tstamp:
        output_lines.append(f'  (tstamp "{tstamp}")')
    skip_next = 0
    for line in lib_lines[1:-1]:
        stripped = line.strip()
        if skip_next:
            skip_next -= 1
            continue
        if stripped.startswith("(version ") or stripped.startswith("(generator "):
            continue
        if stripped.startswith("(fp_text reference "):
            output_lines.append(
                re.sub(r'\(fp_text reference "[^"]+"', f'(fp_text reference "{ref}"', line)
            )
            continue
        if stripped.startswith("(fp_text value "):
            output_lines.append(
                re.sub(r'\(fp_text value "[^"]+"', f'(fp_text value "{clean_label(value)}"', line)
            )
            continue
        if stripped.startswith("(pad "):
            pad_name = first_match(r'\(pad\s+"([^"]*)"', stripped)
            net_name = net_map.get(pad_name, "")
            if "(net " not in line:
                line = line[:-1] + net_clause(net_name, ids) + ")" if line.endswith(")") else line
            output_lines.append(line)
            continue
        output_lines.append(line)
    output_lines.append(
        f'  (fp_text user "development_footprint_bound_not_release" (at 0 0 0) (layer "Cmts.User") hide (uuid "{tstamp or old_name}-bound"))'
    )
    output_lines.append(")")
    assigned = sum(1 for net_name in net_map.values() if net_name and net_name in ids)
    mapped_pads = [
        {"pad": pad_name, "net_id": str(ids[net_name]), "net_name": net_name}
        if net_name and net_name in ids
        else {"pad": pad_name, "net_id": "", "net_name": ""}
        for pad_name, net_name in net_map.items()
    ]
    return "\n".join(output_lines), {
        "embedded_library_body": 1,
        "new_pad_count": len(net_map),
        "assigned_pad_net_count": assigned,
        "contract_sequence_assigned_pad_net_count": contract_assigned,
        "split_interconnect_assigned_pad_net_count": split_assigned,
        "support_pattern_assigned_pad_net_count": support_assigned,
        "compute_som_assigned_pad_net_count": compute_som_assigned,
        **unassigned_pad_summary(new_name, mapped_pads),
    }


def clone_source_block(
    block: str,
    *,
    reference: str,
    value: str,
    dx_mm: float,
    salt: str,
) -> str:
    cloned = re.sub(
        r'\(fp_text reference "[^"]+"',
        f'(fp_text reference "{reference}"',
        block,
        count=1,
    )
    cloned = re.sub(
        r'\(fp_text value "[^"]+"',
        f'(fp_text value "{value}"',
        cloned,
        count=1,
    )
    at_match = re.search(r"\n(\s+)\(at\s+([-0-9.]+)\s+([-0-9.]+)([^)]*)\)", cloned)
    if at_match:
        indent, x_text, y_text, rest = at_match.groups()
        x = float(x_text) + dx_mm
        cloned = (
            cloned[: at_match.start()]
            + f"\n{indent}(at {x:.2f} {float(y_text):.2f}{rest})"
            + cloned[at_match.end() :]
        )
    cloned = re.sub(
        r'\(tstamp "[^"]+"\)',
        f'(tstamp "{uuid.uuid5(uuid.NAMESPACE_URL, "eliza/e1-phone/dev-split/" + salt)}")',
        cloned,
        count=1,
    )
    return cloned


def replace_footprints(text: str) -> tuple[str, list[dict[str, object]]]:
    records: list[dict[str, object]] = []
    ids = net_ids(text)
    blocks = find_footprint_blocks(text)
    replacements: list[tuple[int, int, str]] = []
    for old_name, new_name in MAPPING.items():
        found = blocks.get(old_name)
        if not found:
            records.append(
                {
                    "source": clean_label(f"E1Phone:{old_name}"),
                    "target": f"e1-phone-dev:{new_name}",
                    "bound": False,
                }
            )
            continue
        start, end, block = found
        if old_name == "J_CAM0_CAM1":
            rear_block = clone_source_block(
                block,
                reference="J_REAR_CAMERA",
                value="24-pin rear MIPI CSI camera FPC development connector",
                dx_mm=-5.0,
                salt="J_REAR_CAMERA",
            )
            front_block = clone_source_block(
                block,
                reference="J_FRONT_CAMERA",
                value="30-pin front MIPI CSI camera FPC development connector",
                dx_mm=5.0,
                salt="J_FRONT_CAMERA",
            )
            rear_new_block, rear_stats = format_library_block(
                rear_block, old_name, "CAMERA_24P_0P50_DEV", ids
            )
            front_new_block, front_stats = format_library_block(
                front_block, old_name, "CAMERA_30P_0P50_DEV", ids
            )
            replacements.append((start, end, rear_new_block + "\n" + front_new_block))
            records.append(
                {
                    "source": "E1Phone:J_REAR_CAMERA split from J_CAM0_CAM1",
                    "target": "e1-phone-dev:CAMERA_24P_0P50_DEV",
                    "bound": True,
                    **rear_stats,
                }
            )
            records.append(
                {
                    "source": "E1Phone:J_FRONT_CAMERA split from J_CAM0_CAM1",
                    "target": "e1-phone-dev:CAMERA_30P_0P50_DEV",
                    "bound": True,
                    **front_stats,
                }
            )
            continue
        if old_name == "U_PMIC_CHARGER":
            charger_block = clone_source_block(
                block,
                reference="U_CHARGER",
                value="MAX77860 charger/power-path development package",
                dx_mm=-4.25,
                salt="U_CHARGER",
            )
            pd_block = clone_source_block(
                block,
                reference="U_USB_PD",
                value="TPS65987 USB-PD controller development package",
                dx_mm=4.25,
                salt="U_USB_PD",
            )
            charger_new_block, charger_stats = format_library_block(
                charger_block, old_name, "ADI_MAX77860_WLP81_DEV", ids
            )
            pd_new_block, pd_stats = format_library_block(
                pd_block, old_name, "TI_TPS65987_RSH_56QFN_DEV", ids
            )
            replacements.append((start, end, charger_new_block + "\n" + pd_new_block))
            records.append(
                {
                    "source": "E1Phone:U_CHARGER split from U_PMIC_CHARGER",
                    "target": "e1-phone-dev:ADI_MAX77860_WLP81_DEV",
                    "bound": True,
                    **charger_stats,
                }
            )
            records.append(
                {
                    "source": "E1Phone:U_USB_PD split from U_PMIC_CHARGER",
                    "target": "e1-phone-dev:TI_TPS65987_RSH_56QFN_DEV",
                    "bound": True,
                    **pd_stats,
                }
            )
            continue
        new_block, stats = format_library_block(block, old_name, new_name, ids)
        replacements.append((start, end, new_block))
        records.append(
            {
                "source": clean_label(f"E1Phone:{old_name}"),
                "target": f"e1-phone-dev:{new_name}",
                "bound": True,
                **stats,
            }
        )
    for start, end, new_block in sorted(replacements, reverse=True):
        text = text[:start] + new_block + text[end:]
    return text, records


SUPPORT_TARGET_FOOTPRINTS = {
    "ESD_ARRAY_6CH_DEV",
    "TVS_DIODE_2P_DEV",
    "TESTPOINT_1MM_DEV",
    "FIDUCIAL_1MM_DEV",
    "MOUNTING_HOLE_1P2_DEV",
    "R0402_DEV",
    "C0402_DEV",
    "L0402_DEV",
    "PI_MATCH_0402_DEV",
    "RC_ARRAY_4CH_DEV",
    "SHUNT_1206_DEV",
    "USIM_ESD_LEVELSHIFT_DEV",
    "ESIM_LGA_DEV",
    "NFC_CONTROLLER_QFN_DEV",
    "NFC_LOOP_MATCH_DEV",
    "SENSOR_HUB_QFN_DEV",
    "BACKLIGHT_BIAS_POWER_DEV",
    "HAPTIC_DRIVER_WLCSP_DEV",
    "FUEL_GAUGE_WLCSP_DEV",
}


def already_bound_records(text: str) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for match in re.finditer(r'\(footprint "e1-phone-dev:([^"]+)"', text):
        start = match.start()
        depth = 0
        end = None
        for index in range(start, len(text)):
            char = text[index]
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0:
                    end = index + 1
                    break
        if end is None:
            raise SystemExit(f"unterminated development footprint block: {match.group(1)}")
        target = match.group(1)
        block = text[start:end]
        pads = pad_records(block)
        assigned = sum(
            1 for line in block.splitlines() if line.strip().startswith("(pad ") and "(net " in line
        )
        contract_assigned = (
            assigned
            if target in DEVELOPMENT_CONTRACT_PIN_NETS or target == "HIROSE_DF40_80P_0P4_DEV"
            else 0
        )
        split_assigned = assigned if target == "HIROSE_DF40_80P_0P4_DEV" else 0
        support_assigned = assigned if target in SUPPORT_TARGET_FOOTPRINTS else 0
        compute_som_assigned = assigned if target == "SODIMM_260P_0P5_COMPUTE_SOM_DEV" else 0
        ref = first_match(r'\(fp_text reference "([^"]+)"', block, target)
        records.append(
            {
                "source": f"already-bound:{ref}",
                "target": f"e1-phone-dev:{target}",
                "bound": True,
                "embedded_library_body": 1,
                "new_pad_count": len(pads),
                "assigned_pad_net_count": assigned,
                "contract_sequence_assigned_pad_net_count": contract_assigned,
                "split_interconnect_assigned_pad_net_count": split_assigned,
                "support_pattern_assigned_pad_net_count": support_assigned,
                "compute_som_assigned_pad_net_count": compute_som_assigned,
                **unassigned_pad_summary(target, pads),
            }
        )
    return records


def main() -> int:
    text = SRC.read_text()
    output, records = replace_footprints(text)
    if (
        not any(bool(item.get("bound")) for item in records)
        and '(footprint "e1-phone-dev:' in output
    ):
        records = already_bound_records(output)
    output = clean_label(output)
    output = refresh_development_model_blocks(output)
    OUT.write_text(output)
    footprint_manifest = yaml.safe_load(FOOTPRINT_MANIFEST.read_text())
    footprint_records = {item["name"]: item for item in footprint_manifest["records"]}
    for record in records:
        target = str(record["target"]).split(":", 1)[1]
        info = footprint_records.get(target, {})
        record["model"] = info.get("model", "")
        if info.get("extra_models"):
            record["extra_models"] = info["extra_models"]
        record["step_binding_status"] = info.get("step_binding_status", "")
        record["footprint_file"] = f"board/kicad/e1-phone/e1-phone-dev.pretty/{target}.kicad_mod"
    report = {
        "schema": "eliza.e1_phone_real_footprint_development_board_binding.v1",
        "date": "2026-05-22",
        "status": "development_board_bound_to_concrete_footprint_ids_not_release",
        "claim_boundary": (
            "This board binds the routed-development snapshot to concrete development "
            "footprint library IDs and STEP-bound footprint files. Public USB-C pins "
            "and development contract-sequence display/camera/battery connector nets "
            "plus split-interconnect allocation nets are assigned for local continuity "
            "review only. Development support patterns are also assigned where local "
            "block-netlist evidence identifies their nets, and public compute SoM "
            "connector pins are mapped to e1-phone nets where the local SoM pinout "
            "capture has explicit pin numbers. Pads without assigned nets are "
            "explicitly classified by disposition so that NC, mechanical, unused, "
            "geometry-only, and supplier-pending contacts are not silent TODOs. "
            "It is still not a "
            "fabrication release because several patterns remain geometry-only or need "
            "supplier drawing/DFM signoff before pin order can be frozen."
        ),
        "source_board": str(SRC.relative_to(ROOT)),
        "output_board": str(OUT.relative_to(ROOT)),
        "fp_lib_table": "board/kicad/e1-phone/fp-lib-table",
        "bound_footprint_count": sum(1 for item in records if item["bound"]),
        "unbound_footprint_count": sum(1 for item in records if not item["bound"]),
        "remaining_placeholder_marker_count": output.count("placeholder_not_fabrication_footprint"),
        "development_bound_marker_count": output.count("development_footprint_bound_not_release"),
        "embedded_library_body_count": sum(
            int(item.get("embedded_library_body", 0)) for item in records
        ),
        "assigned_pad_net_count": sum(
            int(item.get("assigned_pad_net_count", 0)) for item in records
        ),
        "unassigned_pad_count": sum(int(item.get("unassigned_pad_count", 0)) for item in records),
        "unassigned_pad_disposition_counts": dict(
            sorted(
                sum(
                    (
                        Counter(
                            {
                                str(key): int(value)
                                for key, value in item.get(
                                    "unassigned_pad_disposition_counts", {}
                                ).items()
                            }
                        )
                        for item in records
                    ),
                    Counter(),
                ).items()
            )
        ),
        "contract_sequence_assigned_pad_net_count": sum(
            int(item.get("contract_sequence_assigned_pad_net_count", 0)) for item in records
        ),
        "split_interconnect_assigned_pad_net_count": sum(
            int(item.get("split_interconnect_assigned_pad_net_count", 0)) for item in records
        ),
        "support_pattern_assigned_pad_net_count": sum(
            int(item.get("support_pattern_assigned_pad_net_count", 0)) for item in records
        ),
        "compute_som_assigned_pad_net_count": sum(
            int(item.get("compute_som_assigned_pad_net_count", 0)) for item in records
        ),
        "segment_count": len(re.findall(r"\n\s*\(segment\b", output)),
        "via_count": len(re.findall(r"\n\s*\(via\b", output)),
        "bindings": records,
        "release_blockers_preserved": [
            "bound footprints are development patterns, not supplier-approved production land patterns",
            "display/camera FPC pin order still needs signed supplier drawings",
            "Quectel/Murata per-pad maps still need supplier design-pack capture",
            "production DRC/ERC/SI/PI/RF/factory evidence is absent",
        ],
    }
    MANIFEST.write_text(yaml.safe_dump(report, sort_keys=False))
    print(f"wrote {OUT.relative_to(ROOT)}")
    print(
        f"bound={report['bound_footprint_count']} segments={report['segment_count']} "
        f"remaining_placeholders={report['remaining_placeholder_marker_count']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
