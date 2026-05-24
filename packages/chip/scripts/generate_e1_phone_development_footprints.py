#!/usr/bin/env python3
"""Generate concrete non-release footprint patterns for the E1 phone package."""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "board/kicad/e1-phone/e1-phone-dev.pretty"
FP_LIB_TABLE = ROOT / "board/kicad/e1-phone/fp-lib-table"
MANIFEST = ROOT / "board/kicad/e1-phone/development-footprint-library-manifest-2026-05-22.yaml"

MODEL_MAP = {
    "GCT_USB4105_GF_A_DEV": "usb_c_receptacle.step",
    "PANASONIC_EVQ_P7_DEV": "power_button_cap.step",
    "DISPLAY_40P_0P30_DEV": "display_fpc_connector.step",
    "CAMERA_24P_0P50_DEV": "rear_camera_module.step",
    "CAMERA_30P_0P50_DEV": "front_camera_module.step",
    "HIROSE_DF40_80P_0P4_DEV": "split_interconnect_top_connector.step",
    "BATTERY_4P_1P00_DEV": "battery_connector_lead_flex.step",
    "TI_TPS65987_RSH_56QFN_DEV": "pmic_package_marker.step",
    "ADI_MAX77860_WLP81_DEV": "pmic_package_marker.step",
    "AUDIO_CODEC_QFN48_DEV": "audio_codec_package_marker.step",
    "MURATA_TYPE_2EA_GEOMETRY_DEV": "wifi_bt_module_keepout.step",
    "QUECTEL_RG255C_GEOMETRY_DEV": "cellular_lga_module_keepout.step",
    "SODIMM_260P_0P5_COMPUTE_SOM_DEV": "compute_som_sodimm_connector.step",
    "ESD_ARRAY_6CH_DEV": "esd_array_6ch_marker.step",
    "TVS_DIODE_2P_DEV": "tvs_diode_2p_marker.step",
    "TESTPOINT_1MM_DEV": "testpoint_1mm_marker.step",
    "FIDUCIAL_1MM_DEV": "fiducial_1mm_marker.step",
    "MOUNTING_HOLE_1P2_DEV": "mounting_hole_1p2_marker.step",
    "R0402_DEV": "r0402_component_marker.step",
    "C0402_DEV": "c0402_component_marker.step",
    "L0402_DEV": "l0402_component_marker.step",
    "PI_MATCH_0402_DEV": "pi_match_0402_marker.step",
    "RC_ARRAY_4CH_DEV": "rc_array_4ch_marker.step",
    "SHUNT_1206_DEV": "shunt_1206_marker.step",
    "USIM_ESD_LEVELSHIFT_DEV": "usim_levelshift_package_marker.step",
    "ESIM_LGA_DEV": "esim_package_marker.step",
    "NFC_CONTROLLER_QFN_DEV": "nfc_controller_package_marker.step",
    "NFC_LOOP_MATCH_DEV": "nfc_loop_match_marker.step",
    "SENSOR_HUB_QFN_DEV": "sensor_hub_package_marker.step",
    "BACKLIGHT_BIAS_POWER_DEV": "backlight_bias_package_marker.step",
    "HAPTIC_DRIVER_WLCSP_DEV": "haptic_driver_package_marker.step",
    "FUEL_GAUGE_WLCSP_DEV": "fuel_gauge_package_marker.step",
}

EXTRA_MODEL_MAP = {
    "SODIMM_260P_0P5_COMPUTE_SOM_DEV": ["compute_som_daughterboard_keepout.step"],
}

SUPPORT_FOOTPRINTS = [
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
]

SUPPORT_PATTERN_BASIS: dict[str, dict[str, object]] = {
    "C0402_DEV": {
        "coverage": "explicit_local_standard_0402_capacitor_land_pattern",
        "basis": "local IPC-7351-style 0402 two-terminal development land pattern",
        "terminal_contract": ["1", "2"],
    },
    "ESD_ARRAY_6CH_DEV": {
        "coverage": "explicit_local_six_channel_esd_array_terminal_contract",
        "basis": "local six-channel ESD/TVS array terminal contract pending selected device",
        "terminal_contract": ["1", "2", "3", "4", "5", "6"],
    },
    "FIDUCIAL_1MM_DEV": {
        "coverage": "explicit_local_global_fiducial_land_pattern",
        "basis": "local 1.0 mm copper fiducial with solder-mask clearance",
        "terminal_contract": ["1"],
    },
    "L0402_DEV": {
        "coverage": "explicit_local_standard_0402_inductor_land_pattern",
        "basis": "local IPC-7351-style 0402 two-terminal development land pattern",
        "terminal_contract": ["1", "2"],
    },
    "MOUNTING_HOLE_1P2_DEV": {
        "coverage": "explicit_local_1p2mm_npth_mechanical_land_pattern",
        "basis": "local 1.2 mm NPTH mechanical mounting-hole contract",
        "terminal_contract": [],
    },
    "PI_MATCH_0402_DEV": {
        "coverage": "explicit_local_three_element_rf_pi_match_terminal_contract",
        "basis": "local five-terminal 0402 RF pi-match development contract",
        "terminal_contract": ["1", "2", "3", "4", "5"],
    },
    "R0402_DEV": {
        "coverage": "explicit_local_standard_0402_resistor_land_pattern",
        "basis": "local IPC-7351-style 0402 two-terminal development land pattern",
        "terminal_contract": ["1", "2"],
    },
    "RC_ARRAY_4CH_DEV": {
        "coverage": "explicit_local_four_channel_rc_array_terminal_contract",
        "basis": "local eight-terminal RC array development contract pending selected array",
        "terminal_contract": ["1", "2", "3", "4", "5", "6", "7", "8"],
    },
    "SHUNT_1206_DEV": {
        "coverage": "explicit_local_standard_1206_shunt_land_pattern",
        "basis": "local 1206 two-terminal current-shunt development land pattern",
        "terminal_contract": ["1", "2"],
    },
    "TESTPOINT_1MM_DEV": {
        "coverage": "explicit_local_1mm_testpoint_land_pattern",
        "basis": "local one-terminal 1.0 mm solderable testpoint contract",
        "terminal_contract": ["1"],
    },
    "TVS_DIODE_2P_DEV": {
        "coverage": "explicit_local_two_terminal_tvs_diode_land_pattern",
        "basis": "local two-terminal TVS diode development land pattern",
        "terminal_contract": ["1", "2"],
    },
}


def uid(*parts: object) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "eliza/e1-phone/dev-footprint/" + "/".join(map(str, parts))))


def header(name: str, descr: str, tags: str) -> list[str]:
    return [
        f'(footprint "{name}"',
        '  (version 20240108)',
        '  (generator "generate_e1_phone_development_footprints.py")',
        f'  (descr "{descr}")',
        f'  (tags "{tags} NON_RELEASE_DEVELOPMENT_PATTERN")',
        '  (attr smd)',
        f'  (fp_text reference "REF**" (at 0 -3 0) (layer "F.SilkS") (uuid "{uid(name, "ref")}")',
        '    (effects (font (size 0.8 0.8) (thickness 0.1)))',
        '  )',
        f'  (fp_text value "{name}" (at 0 3 0) (layer "F.Fab") (uuid "{uid(name, "value")}")',
        '    (effects (font (size 0.7 0.7) (thickness 0.1)))',
        '  )',
        f'  (fp_text user "NON-RELEASE DEVELOPMENT FOOTPRINT" (at 0 0 0) (layer "Cmts.User") (uuid "{uid(name, "claim")}")',
        '    (effects (font (size 0.65 0.65) (thickness 0.1)))',
        '  )',
    ]


def pad(num: str, x: float, y: float, sx: float, sy: float, *, shape: str = "roundrect", layers: str = '"F.Cu" "F.Paste" "F.Mask"') -> str:
    rr = " (roundrect_rratio 0.2)" if shape == "roundrect" else ""
    return f'  (pad "{num}" smd {shape} (at {x:.3f} {y:.3f}) (size {sx:.3f} {sy:.3f}) (layers {layers}){rr} (uuid "{uid(num, x, y, sx, sy)}"))'


def rect(name: str, w: float, h: float, layer: str = "F.Fab") -> str:
    return f'  (fp_rect (start {-w/2:.3f} {-h/2:.3f}) (end {w/2:.3f} {h/2:.3f}) (stroke (width 0.05) (type solid)) (fill none) (layer "{layer}") (uuid "{uid(name, layer)}"))'


def model_lines(name: str) -> list[str]:
    models = [MODEL_MAP[name]] if name in MODEL_MAP else []
    models.extend(EXTRA_MODEL_MAP.get(name, []))
    if not models:
        return []
    lines: list[str] = []
    for model in models:
        path = f"${{KIPRJMOD}}/../../../mechanical/e1-phone/out/{model}"
        lines.extend(
            [
                f'  (model "{path}"',
                '    (offset (xyz 0 0 0))',
                '    (scale (xyz 1 1 1))',
                '    (rotate (xyz 0 0 0))',
                '  )',
            ]
        )
    return lines


def write_mod(name: str, lines: list[str]) -> None:
    LIB.mkdir(parents=True, exist_ok=True)
    (LIB / f"{name}.kicad_mod").write_text("\n".join(lines + model_lines(name) + [")", ""]))


def record(name: str, **fields: object) -> dict[str, object]:
    model = MODEL_MAP.get(name)
    item = {
        "name": name,
        **fields,
        "step_binding_status": "development_pattern_no_component_step_required"
        if not model
        else "development_envelope_step_bound",
    }
    if model:
        item["model"] = f"mechanical/e1-phone/out/{model}"
        item["model_binding"] = f"${{KIPRJMOD}}/../../../mechanical/e1-phone/out/{model}"
    extra_models = EXTRA_MODEL_MAP.get(name, [])
    if extra_models:
        item["extra_models"] = [f"mechanical/e1-phone/out/{extra}" for extra in extra_models]
        item["extra_model_bindings"] = [
            f"${{KIPRJMOD}}/../../../mechanical/e1-phone/out/{extra}"
            for extra in extra_models
        ]
    if name in SUPPORT_PATTERN_BASIS:
        basis = SUPPORT_PATTERN_BASIS[name]
        item["land_pattern_basis"] = basis["basis"]
        item["local_terminal_contract"] = basis["terminal_contract"]
        item["local_terminal_contract_source"] = "generated_development_footprint_support_pattern_basis"
    return item


def single_row_fpc(name: str, pins: int, pitch: float, pad_w: float, pad_h: float, body_w: float, body_h: float, descr: str) -> dict[str, object]:
    lines = header(name, descr, f"FPC {pins}P {pitch}MM")
    origin = -(pins - 1) * pitch / 2
    for idx in range(pins):
        lines.append(pad(str(idx + 1), origin + idx * pitch, 0.0, pad_w, pad_h))
    lines += [rect(name, body_w, body_h), rect(name + "_crtyd", body_w + 0.6, body_h + 0.6, "F.CrtYd")]
    write_mod(name, lines)
    return record(name, pin_count=pins, pitch_mm=pitch, status="development_pattern_generated")


def dual_row_connector(name: str, per_row: int, pitch: float, row_gap: float, pad_w: float, pad_h: float, body_w: float, body_h: float, descr: str) -> dict[str, object]:
    lines = header(name, descr, f"DUAL_ROW {per_row*2}P {pitch}MM")
    origin = -(per_row - 1) * pitch / 2
    for idx in range(per_row):
        lines.append(pad(f"A{idx + 1}", origin + idx * pitch, -row_gap / 2, pad_w, pad_h))
        lines.append(pad(f"B{idx + 1}", origin + idx * pitch, row_gap / 2, pad_w, pad_h))
    lines += [rect(name, body_w, body_h), rect(name + "_crtyd", body_w + 0.6, body_h + 0.6, "F.CrtYd")]
    write_mod(name, lines)
    return record(name, pin_count=per_row * 2, pitch_mm=pitch, status="development_pattern_generated")


def qfn(name: str, pins: int, body: float, pitch: float, descr: str) -> dict[str, object]:
    per_side = pins // 4
    lines = header(name, descr, f"QFN {pins}P {pitch}MM")
    origin = -(per_side - 1) * pitch / 2
    n = 1
    for idx in range(per_side):
        x = origin + idx * pitch
        lines.append(pad(str(n), x, -body / 2 - 0.35, 0.22, 0.75)); n += 1
    for idx in range(per_side):
        y = origin + idx * pitch
        lines.append(pad(str(n), body / 2 + 0.35, y, 0.75, 0.22)); n += 1
    for idx in range(per_side):
        x = -origin - idx * pitch
        lines.append(pad(str(n), x, body / 2 + 0.35, 0.22, 0.75)); n += 1
    for idx in range(per_side):
        y = -origin - idx * pitch
        lines.append(pad(str(n), -body / 2 - 0.35, y, 0.75, 0.22)); n += 1
    lines.append(pad("EP", 0, 0, body * 0.62, body * 0.62, shape="rect"))
    lines += [rect(name, body, body), rect(name + "_crtyd", body + 1.2, body + 1.2, "F.CrtYd")]
    write_mod(name, lines)
    return record(name, pin_count=pins, pitch_mm=pitch, status="development_pattern_generated")


def tps65987_rsh_qfn() -> dict[str, object]:
    name = "TI_TPS65987_RSH_56QFN_DEV"
    body = 9.0
    pitch = 0.4
    lines = header(name, "TPS65987DDH RSH 56-pin QFN plus numbered exposed pads development pattern", "TPS65987D RSH56 QFN 0.4MM")
    per_side = 14
    origin = -(per_side - 1) * pitch / 2
    n = 1
    for idx in range(per_side):
        lines.append(pad(str(n), origin + idx * pitch, -body / 2 - 0.35, 0.22, 0.75)); n += 1
    for idx in range(per_side):
        lines.append(pad(str(n), body / 2 + 0.35, origin + idx * pitch, 0.75, 0.22)); n += 1
    for idx in range(per_side):
        lines.append(pad(str(n), -origin - idx * pitch, body / 2 + 0.35, 0.22, 0.75)); n += 1
    for idx in range(per_side):
        lines.append(pad(str(n), -body / 2 - 0.35, -origin - idx * pitch, 0.75, 0.22)); n += 1
    lines.append(pad("57", -1.55, 0, 1.2, 4.4, shape="rect"))
    lines.append(pad("58", 0, 0, 1.2, 4.4, shape="rect"))
    lines.append(pad("59", 1.55, 0, 1.2, 4.4, shape="rect"))
    lines += [rect(name, body, body), rect(name + "_crtyd", body + 1.2, body + 1.2, "F.CrtYd")]
    write_mod(name, lines)
    return record(name, pin_count=59, pitch_mm=pitch, status="public_pinout_development_pattern_generated")


def wlp_grid(name: str, rows: str, cols: int, pitch: float, body_w: float, body_h: float, descr: str) -> dict[str, object]:
    lines = header(name, descr, f"WLP {len(rows)*cols}B {pitch}MM")
    x0 = -(cols - 1) * pitch / 2
    y0 = -(len(rows) - 1) * pitch / 2
    for r_i, row in enumerate(rows):
        for col in range(1, cols + 1):
            lines.append(pad(f"{row}{col}", x0 + (col - 1) * pitch, y0 + r_i * pitch, 0.24, 0.24, shape="circle"))
    lines += [rect(name, body_w, body_h), rect(name + "_crtyd", body_w + 0.5, body_h + 0.5, "F.CrtYd")]
    write_mod(name, lines)
    return record(name, pin_count=len(rows) * cols, pitch_mm=pitch, status="development_pattern_generated")


def lga_grid(name: str, rows: int, cols: int, pitch: float, body_w: float, body_h: float, descr: str) -> dict[str, object]:
    lines = header(name, descr, f"LGA {rows*cols}P {pitch}MM")
    x0 = -(cols - 1) * pitch / 2
    y0 = -(rows - 1) * pitch / 2
    for r in range(rows):
        for c in range(cols):
            lines.append(pad(str(r * cols + c + 1), x0 + c * pitch, y0 + r * pitch, 0.48, 0.48))
    lines += [rect(name, body_w, body_h), rect(name + "_crtyd", body_w + 1.0, body_h + 1.0, "F.CrtYd")]
    write_mod(name, lines)
    return record(name, pin_count=rows * cols, pitch_mm=pitch, status="geometry_only_pending_supplier_pad_map")


def esim_mff2() -> dict[str, object]:
    name = "ESIM_LGA_DEV"
    lines = header(name, "MFF2/QFN8 eSIM public 8-pad development land pattern", "MFF2 ESIM QFN8 1.27MM")
    # Pin numbering follows the public MFF2 vendor pinout: pins 1-4 on one
    # side, pins 5-8 on the opposite side. The center exposed pad is not
    # connected and is modeled as mechanical here.
    y_positions = [-1.905, -0.635, 0.635, 1.905]
    for index, y in enumerate(y_positions, start=1):
        lines.append(pad(str(index), 2.45, y, 0.60, 0.85))
    for index, y in zip(range(5, 9), reversed(y_positions)):
        lines.append(pad(str(index), -2.45, y, 0.60, 0.85))
    lines.append(pad("EP", 0, 0, 3.4, 4.0, shape="rect"))
    lines += [rect(name, 6.0, 5.0), rect(name + "_crtyd", 6.5, 5.5, "F.CrtYd")]
    write_mod(name, lines)
    return record(name, pin_count=8, pitch_mm=1.27, status="public_mff2_esim_development_pattern_generated")


TYPE2EA_DXF_ROWS = [
    (8.950, [0.575, 11.925], 0.55, 0.25),
    (8.825, [1.500, 2.000, 2.500, 3.000, 3.500, 4.000, 4.500, 5.000, 5.500, 6.000, 6.500, 7.000, 7.500, 8.000, 8.500, 9.000, 9.500, 10.000, 10.500, 11.000], 0.25, 0.55),
    (8.450, [0.575, 11.925], 0.55, 0.25),
    (7.950, [0.575, 11.925], 0.55, 0.25),
    (7.700, [1.850, 10.650], 0.25, 0.55),
    (7.450, [0.575, 11.925], 0.55, 0.25),
    (7.200, [1.850, 10.650], 0.25, 0.55),
    (7.100, [3.000, 3.500, 4.000, 4.500, 5.000, 5.500, 6.000, 6.500, 7.000, 7.500, 8.000, 8.500, 9.000, 9.500], 0.25, 0.55),
    (6.950, [0.575, 11.925], 0.55, 0.25),
    (6.700, [1.850, 10.650], 0.25, 0.55),
    (6.450, [0.575, 11.925], 0.55, 0.25),
    (6.300, [3.000, 3.500, 4.000, 4.500, 5.000, 5.500, 6.000, 6.500, 7.000, 7.500, 8.000, 8.500, 9.000, 9.500], 0.25, 0.55),
    (6.200, [1.850, 10.650], 0.25, 0.55),
    (5.950, [0.575, 11.925], 0.55, 0.25),
    (5.700, [1.850, 10.650], 0.25, 0.55),
    (5.500, [3.000, 3.500, 4.000, 4.500, 5.000, 5.500, 6.000, 6.500, 7.000, 7.500, 8.000, 8.500, 9.000, 9.500], 0.25, 0.55),
    (5.450, [0.575, 11.925], 0.55, 0.25),
    (5.200, [1.850, 10.650], 0.25, 0.55),
    (4.950, [0.575, 11.925], 0.55, 0.25),
    (4.700, [1.850, 3.000, 3.500, 4.000, 4.500, 5.000, 5.500, 6.000, 6.500, 7.000, 7.500, 8.000, 8.500, 9.000, 9.500, 10.650], 0.25, 0.55),
    (4.450, [0.575, 11.925], 0.55, 0.25),
    (4.200, [1.850, 10.650], 0.25, 0.55),
    (3.950, [0.575, 11.925], 0.55, 0.25),
    (3.900, [3.000, 3.500, 4.000, 4.500, 5.000, 5.500, 6.000, 6.500, 7.000, 7.500, 8.000, 8.500, 9.000, 9.500], 0.25, 0.55),
    (3.700, [1.850, 10.650], 0.25, 0.55),
    (3.450, [0.575, 11.925], 0.55, 0.25),
    (3.200, [1.850, 10.650], 0.25, 0.55),
    (3.100, [3.000, 3.500, 4.000, 4.500, 5.000, 5.500, 6.000, 6.500, 7.000, 7.500, 8.000, 8.500, 9.000, 9.500], 0.25, 0.55),
    (2.950, [0.575, 11.925], 0.55, 0.25),
    (2.700, [1.850, 10.650], 0.25, 0.55),
    (2.450, [0.575, 11.925], 0.55, 0.25),
    (2.300, [3.500, 4.000, 4.500, 5.000, 5.500, 6.000, 6.500, 7.000, 7.500, 8.000, 8.500, 9.000, 9.500], 0.25, 0.55),
    (2.200, [1.850, 10.650], 0.25, 0.55),
    (1.950, [0.575, 11.925], 0.55, 0.25),
    (1.700, [1.850, 10.650], 0.25, 0.55),
    (1.450, [0.575, 11.925], 0.55, 0.25),
    (0.950, [0.575, 11.925], 0.55, 0.25),
    (0.575, [1.500, 2.000, 2.500, 3.000, 3.500, 4.000, 4.500, 5.000, 5.500, 6.000, 6.500, 7.000, 7.500, 8.000, 8.500, 9.000, 9.500, 10.000, 10.500, 11.000], 0.25, 0.55),
    (0.450, [0.575, 11.925], 0.55, 0.25),
]


def murata_type2ea_lga() -> dict[str, object]:
    name = "MURATA_TYPE_2EA_GEOMETRY_DEV"
    body_w = 12.5
    body_h = 9.4
    lines = header(
        name,
        "Murata Type 2EA 199-terminal public DXF land-pattern development footprint",
        "MURATA TYPE2EA LBEE5XV2EA 199P PUBLIC_DXF",
    )
    index = 1
    for y_top, xs, pad_w, pad_h in TYPE2EA_DXF_ROWS:
        for x_left in xs:
            x = x_left - body_w / 2
            y = body_h / 2 - y_top
            lines.append(pad(str(index), x, y, pad_w, pad_h))
            index += 1
    if index != 200:
        raise SystemExit(f"Murata Type 2EA public DXF pad count stale: {index - 1}")
    lines += [rect(name, body_w, body_h), rect(name + "_crtyd", body_w + 1.0, body_h + 1.0, "F.CrtYd")]
    write_mod(name, lines)
    return record(
        name,
        pin_count=199,
        pitch_mm="public_dxf_variable",
        status="public_terminal_table_and_dxf_land_pattern_development",
    )


def quectel_rg255c_lga() -> dict[str, object]:
    name = "QUECTEL_RG255C_GEOMETRY_DEV"
    rows = 12
    cols = 17
    pitch_x = 1.45
    pitch_y = 2.35
    body_w = 29.0
    body_h = 32.0
    lines = header(
        name,
        "Quectel RG255C 204-pin public pin-table development footprint",
        "QUECTEL RG255C 204P PUBLIC_PIN_TABLE",
    )
    x0 = -(cols - 1) * pitch_x / 2
    y0 = -(rows - 1) * pitch_y / 2
    for index in range(204):
        row = index // cols
        col = index % cols
        lines.append(pad(str(index + 1), x0 + col * pitch_x, y0 + row * pitch_y, 0.55, 0.65))
    lines += [rect(name, body_w, body_h), rect(name + "_crtyd", body_w + 1.0, body_h + 1.0, "F.CrtYd")]
    write_mod(name, lines)
    return record(
        name,
        pin_count=204,
        pitch_mm="public_pin_table_synthetic_lga",
        status="public_pinout_development_pattern_pending_land_pattern",
    )


def usb_c() -> dict[str, object]:
    name = "GCT_USB4105_GF_A_DEV"
    lines = header(name, "GCT USB4105-GF-A USB-C 2.0 receptacle development land pattern", "USB_C USB4105 24P")
    xs = [-3.85, -3.15, -2.45, -1.75, -1.05, -0.35, 0.35, 1.05, 1.75, 2.45, 3.15, 3.85]
    for i, x in enumerate(xs, start=1):
        lines.append(pad(f"A{i}", x, -1.05, 0.32, 0.85))
        lines.append(pad(f"B{i}", x, 1.05, 0.32, 0.85))
    for idx, x in enumerate([-4.65, 4.65], start=1):
        lines.append(pad(f"SH{idx}", x, 0, 1.1, 2.2, shape="rect"))
    lines += [rect(name, 9.6, 7.2), rect(name + "_crtyd", 10.4, 8.0, "F.CrtYd")]
    write_mod(name, lines)
    return record(name, pin_count=24, pitch_mm=0.5, status="public_pinout_development_pattern_generated")


def tactile() -> dict[str, object]:
    name = "PANASONIC_EVQ_P7_DEV"
    lines = header(name, "Panasonic EVQ-P7 side-push tactile switch development land pattern", "EVQ_P7 TACTILE")
    for num, x, y in [("1", -1.25, -0.85), ("2", 1.25, -0.85), ("3", -1.25, 0.85), ("4", 1.25, 0.85)]:
        lines.append(pad(num, x, y, 0.85, 0.75))
    lines += [rect(name, 3.5, 2.9), rect(name + "_crtyd", 4.3, 3.7, "F.CrtYd")]
    write_mod(name, lines)
    return record(name, pin_count=4, status="public_pinout_development_pattern_generated")


def generic_smd(name: str, pins: int, pitch: float, pad_w: float, pad_h: float, body_w: float, body_h: float, descr: str, tags: str) -> dict[str, object]:
    lines = header(name, descr, tags)
    origin = -(pins - 1) * pitch / 2
    for idx in range(pins):
        lines.append(pad(str(idx + 1), origin + idx * pitch, 0.0, pad_w, pad_h))
    lines += [rect(name, body_w, body_h), rect(name + "_crtyd", body_w + 0.35, body_h + 0.35, "F.CrtYd")]
    write_mod(name, lines)
    return record(name, pin_count=pins, status="generic_off_the_shelf_development_pattern")


def passive_0402(name: str, kind: str) -> dict[str, object]:
    return generic_smd(name, 2, 0.62, 0.48, 0.56, 1.0, 0.5, f"Generic 0402 {kind} development land pattern", f"0402 {kind}")


def pi_match(name: str = "PI_MATCH_0402_DEV", descr: str = "Three-element 0402 RF pi-match development pattern") -> dict[str, object]:
    lines = header(name, descr, "RF PI_MATCH 0402")
    for num, x, y in [("1", -1.25, 0), ("2", 0, 0), ("3", 1.25, 0), ("4", 0, -0.9), ("5", 0, 0.9)]:
        lines.append(pad(num, x, y, 0.46, 0.54))
    lines += [rect(name, 3.2, 2.4), rect(name + "_crtyd", 3.6, 2.8, "F.CrtYd")]
    write_mod(name, lines)
    return record(name, pin_count=5, status="generic_rf_pi_match_development_pattern")


def testpoint() -> dict[str, object]:
    name = "TESTPOINT_1MM_DEV"
    lines = header(name, "1.0 mm solderable production-test development pad", "TESTPOINT 1MM")
    lines.append(pad("1", 0, 0, 1.0, 1.0, shape="circle", layers='"F.Cu" "F.Mask"'))
    lines += [rect(name, 1.4, 1.4, "F.CrtYd")]
    write_mod(name, lines)
    return record(name, pin_count=1, status="off_the_shelf_test_pad_development_pattern")


def fiducial() -> dict[str, object]:
    name = "FIDUCIAL_1MM_DEV"
    lines = header(name, "1.0 mm global fiducial with 1.0 mm mask clearance", "FIDUCIAL 1MM")
    lines.append('  (pad "1" smd circle (at 0 0) (size 1.000 1.000) (layers "F.Cu" "F.Mask") (solder_mask_margin 1.0) (clearance 1.0) (uuid "' + uid(name, "pad") + '"))')
    lines += [rect(name, 3.0, 3.0, "F.CrtYd")]
    write_mod(name, lines)
    return record(name, pin_count=1, status="standard_global_fiducial_development_pattern")


def mounting_hole() -> dict[str, object]:
    name = "MOUNTING_HOLE_1P2_DEV"
    lines = header(name, "1.2 mm non-plated mounting hole development pattern", "NPTH MOUNT 1P2")
    lines.append('  (attr exclude_from_pos_files exclude_from_bom)')
    lines.append('  (pad "" np_thru_hole circle (at 0 0) (size 2.000 2.000) (drill 1.200) (layers "*.Cu" "*.Mask") (uuid "' + uid(name, "npth") + '"))')
    lines += [rect(name, 3.2, 3.2, "F.CrtYd")]
    write_mod(name, lines)
    return record(name, pin_count=0, status="mechanical_np_thru_hole_development_pattern")


def qfn_support(name: str, pins: int, body: float, pitch: float, descr: str) -> dict[str, object]:
    return qfn(name, pins, body, pitch, descr) | {"status": "generic_qfn_support_development_pattern"}


def wlp_support(name: str, rows: str, cols: int, pitch: float, body_w: float, body_h: float, descr: str) -> dict[str, object]:
    return wlp_grid(name, rows, cols, pitch, body_w, body_h, descr) | {"status": "generic_wlp_support_development_pattern"}


def support_records() -> list[dict[str, object]]:
    return [
        generic_smd("ESD_ARRAY_6CH_DEV", 6, 0.42, 0.30, 0.42, 2.4, 1.0, "Six-channel low-capacitance ESD array development pattern", "ESD ARRAY 6CH"),
        generic_smd("TVS_DIODE_2P_DEV", 2, 1.0, 0.55, 0.70, 1.6, 0.9, "Two-pad TVS diode development pattern", "TVS DIODE 2P"),
        testpoint(),
        fiducial(),
        mounting_hole(),
        passive_0402("R0402_DEV", "resistor"),
        passive_0402("C0402_DEV", "capacitor"),
        passive_0402("L0402_DEV", "inductor"),
        pi_match(),
        generic_smd("RC_ARRAY_4CH_DEV", 8, 0.45, 0.28, 0.46, 3.2, 1.0, "Four-channel resistor/capacitor array development pattern", "RC ARRAY 4CH"),
        generic_smd("SHUNT_1206_DEV", 2, 1.8, 1.15, 1.65, 3.2, 1.6, "1206 current sense shunt development pattern", "SHUNT 1206"),
        generic_smd("USIM_ESD_LEVELSHIFT_DEV", 10, 0.40, 0.25, 0.45, 3.0, 1.4, "USIM ESD/level-shift support development pattern", "USIM ESD LEVELSHIFT"),
        esim_mff2(),
        qfn_support("NFC_CONTROLLER_QFN_DEV", 32, 5.0, 0.5, "NFC controller QFN development pattern"),
        pi_match("NFC_LOOP_MATCH_DEV", "NFC antenna loop pi-match development pattern"),
        qfn_support("SENSOR_HUB_QFN_DEV", 24, 4.0, 0.5, "Sensor hub QFN development pattern"),
        qfn_support("BACKLIGHT_BIAS_POWER_DEV", 24, 4.0, 0.5, "Display bias/backlight power development pattern"),
        wlp_support("HAPTIC_DRIVER_WLCSP_DEV", "ABC", 3, 0.4, 1.6, 1.6, "Haptic driver WLCSP development pattern"),
        wlp_support("FUEL_GAUGE_WLCSP_DEV", "ABC", 4, 0.4, 2.0, 1.6, "Fuel-gauge WLCSP development pattern"),
    ]


def main() -> int:
    records = [
        usb_c(),
        tactile(),
        single_row_fpc("DISPLAY_40P_0P30_DEV", 40, 0.3, 0.18, 0.75, 13.0, 2.4, "40-pin 0.30 mm display/touch FPC development pattern"),
        single_row_fpc("CAMERA_24P_0P50_DEV", 24, 0.5, 0.28, 0.85, 14.0, 2.6, "24-pin 0.50 mm rear camera FPC development pattern"),
        single_row_fpc("CAMERA_30P_0P50_DEV", 30, 0.5, 0.28, 0.85, 18.0, 2.6, "30-pin 0.50 mm front camera FPC development pattern"),
        dual_row_connector("HIROSE_DF40_80P_0P4_DEV", 40, 0.4, 1.6, 0.22, 0.65, 18.5, 4.2, "Hirose DF40/BM28-class 80-position 0.4 mm B2B development pattern"),
        single_row_fpc("BATTERY_4P_1P00_DEV", 4, 1.0, 0.55, 1.25, 6.0, 3.0, "4-pin battery pack lead connector development pattern"),
        tps65987_rsh_qfn(),
        wlp_grid("ADI_MAX77860_WLP81_DEV", "ABCDEFGHJ", 9, 0.4, 3.9, 4.0, "MAX77860 81-bump WLP development pattern"),
        qfn_support("AUDIO_CODEC_QFN48_DEV", 48, 7.0, 0.5, "48-pin audio codec QFN development pattern"),
        murata_type2ea_lga(),
        quectel_rg255c_lga(),
        dual_row_connector("SODIMM_260P_0P5_COMPUTE_SOM_DEV", 130, 0.5, 2.0, 0.28, 1.0, 69.6, 5.0, "260-pin compute SoM edge connector development pattern"),
    ] + support_records()
    active_names = {str(item["name"]) for item in records}
    for stale in LIB.glob("*.kicad_mod"):
        if stale.stem not in active_names:
            stale.unlink()
    manifest = {
        "schema": "eliza.e1_phone_development_footprint_library_manifest.v1",
        "date": "2026-05-22",
        "status": "development_footprints_generated_not_fabrication_release",
        "claim_boundary": (
            "Concrete KiCad footprint patterns for development routing and CAD binding. "
            "These reduce placeholder ambiguity but are not production release land "
            "patterns until each supplier drawing/pad map and DFM review is signed."
        ),
        "library": str(LIB.relative_to(ROOT)),
        "fp_lib_table": str(FP_LIB_TABLE.relative_to(ROOT)),
        "footprint_count": len(records),
        "step_bound_footprint_count": sum(
            1 for item in records if item["step_binding_status"] == "development_envelope_step_bound"
        ),
        "records": records,
        "release_blockers_preserved": [
            "display/camera FPC exact pin order still needs signed module drawings",
            "Murata Type 2EA public table/DXF and Quectel public pin table still need supplier/CM signoff",
            "DFM/DFA, assembly tolerances, solder-paste apertures, and component STEP models still need review",
        ],
    }
    MANIFEST.write_text(yaml.safe_dump(manifest, sort_keys=False))
    FP_LIB_TABLE.write_text(
        "\n".join(
            [
                "(fp_lib_table",
                '  (lib (name "e1-phone-dev")(type "KiCad")(uri "${KIPRJMOD}/e1-phone-dev.pretty")(options "")(descr "E1 phone non-release development footprints with CAD envelope STEP bindings"))',
                ")",
                "",
            ]
        )
    )
    print(json.dumps({"library": str(LIB.relative_to(ROOT)), "footprints": len(records)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
