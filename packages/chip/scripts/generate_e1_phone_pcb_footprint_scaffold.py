#!/usr/bin/env python3
"""Add non-release footprint/test/fiducial placeholders to the E1 phone PCB."""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
PCB = ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb"
BLOCK_NETLIST = ROOT / "board/kicad/e1-phone/block-netlist.yaml"
PLACEMENT = ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml"
ROUTING = ROOT / "board/kicad/e1-phone/routing-constraints.yaml"


def stable_uuid(*parts: object) -> str:
    text = "::".join(str(part) for part in parts)
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"eliza-e1-phone-pcb/{text}"))


def load_yaml(path: Path):
    with path.open() as handle:
        return yaml.safe_load(handle)


def remove_generated_content(text: str) -> str:
    lines = text.splitlines()
    out: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if line.startswith("  (net "):
            index += 1
            continue
        if line.startswith('  (net_class "E1Phone_'):
            depth = line.count("(") - line.count(")")
            index += 1
            while index < len(lines) and depth > 0:
                depth += lines[index].count("(") - lines[index].count(")")
                index += 1
            continue
        if line.startswith('  (footprint "E1Phone:'):
            depth = line.count("(") - line.count(")")
            index += 1
            while index < len(lines) and depth > 0:
                depth += lines[index].count("(") - lines[index].count(")")
                index += 1
            continue
        out.append(line)
        index += 1
    return "\n".join(out) + "\n"


def flatten_block_nets(block_netlist: dict) -> set[str]:
    nets: set[str] = set()
    for block in block_netlist["blocks"]:
        for values in block["nets"].values():
            if isinstance(values, list):
                nets.update(str(item) for item in values)
    return nets


def nets_matching(all_nets: set[str], prefix: str) -> list[str]:
    return sorted(net for net in all_nets if net.startswith(prefix))


def expand_required_net(name: str, all_nets: set[str]) -> list[str]:
    aliases = {
        "CAM0_CSI": lambda: nets_matching(all_nets, "CAM0_CSI_"),
        "CAM1_CSI": lambda: nets_matching(all_nets, "CAM1_CSI_"),
        "CAM_IOVDD_1V8": lambda: ["IO_1V8"],
        "CELL_VBAT": lambda: ["RF_VBAT"],
        "CELL_VDDIO_1V8": lambda: ["IO_1V8"],
        "CELL_USB2": lambda: ["CELL_USB2_DP", "CELL_USB2_DN"],
        "CELL_PCIE": lambda: nets_matching(all_nets, "CELL_PCIE_"),
        "USIM": lambda: ["USIM_CLK", "USIM_RST", "USIM_IO"],
        "WIFI_PCIE_OR_SDIO": lambda: (
            nets_matching(all_nets, "WIFI_PCIE_") + nets_matching(all_nets, "WIFI_SDIO_")
        ),
        "BT_UART": lambda: ["BT_UART_TX", "BT_UART_RX", "BT_UART_CTS_N", "BT_UART_RTS_N"],
        "VDDIO_1V8": lambda: ["IO_1V8"],
        "AP_RAILS": lambda: ["AP_0V8", "AP_1V1", "IO_1V8"],
        "RF_RAILS": lambda: ["RF_VBAT", "IO_1V8", "GND"],
        "CAM_RAILS": lambda: ["CAM_AVDD_2V8", "CAM_DVDD_1V2", "IO_1V8"],
        "DISP_RAILS": lambda: ["DISP_AVDD_5V5", "DISP_AVEE_N5V5", "IO_1V8"],
        "I2S_OR_PCM": lambda: ["I2S_BCLK", "I2S_LRCLK", "I2S_DOUT", "I2S_DIN"],
        "PDM_MIC": lambda: ["PDM_CLK", "PDM_DAT"],
        "I2C_AUDIO": lambda: ["AUDIO_I2C_SCL", "AUDIO_I2C_SDA"],
        "AUDIO_IRQS": lambda: ["CODEC_INT", "AMP_INT"],
        "SPK_OUT": lambda: ["SPK_P", "SPK_N"],
        "HAPTIC_DRV": lambda: ["HAPTIC_OUT"],
        "LPDDR": lambda: nets_matching(all_nets, "LPDDR_") + ["AP_0V8", "AP_1V1", "IO_1V8", "GND"],
        "UFS": lambda: nets_matching(all_nets, "UFS_") + ["AP_1V1", "IO_1V8", "GND"],
        "JTAG_OR_SWD": lambda: ["JTAG_TCK", "JTAG_TMS", "JTAG_TDI", "JTAG_TDO", "JTAG_TRST_N"],
        "BOOT_STRAPS": lambda: ["BOOT_MODE0", "BOOT_MODE1", "BOOT_MODE2", "SOC_RESET_N"],
    }
    expanded = aliases.get(name, lambda: [name])()
    return [net for net in expanded if net in all_nets or net == name]


def expand_required_nets(required_nets: Iterable[str], all_nets: set[str]) -> list[str]:
    output: list[str] = []
    for name in required_nets:
        for net in expand_required_net(str(name), all_nets):
            if net not in output:
                output.append(net)
    return output


def insert_net_table(text: str, net_names: Iterable[str]) -> tuple[str, dict[str, int]]:
    ordered = sorted(set(net_names))
    net_ids = {name: idx + 1 for idx, name in enumerate(ordered)}
    net_lines = ['  (net 0 "")']
    net_lines.extend(f'  (net {net_id} "{name}")' for name, net_id in net_ids.items())
    marker = "\n  (setup"
    if marker not in text:
        raise SystemExit(f"unexpected KiCad PCB format, missing setup block: {PCB}")
    return text.replace(marker, "\n" + "\n".join(net_lines) + marker, 1), net_ids


def class_nets(net_ids: dict[str, int], names: Iterable[str]) -> list[str]:
    return sorted(name for name in set(names) if name in net_ids)


def prefixed_class_nets(net_ids: dict[str, int], prefixes: Iterable[str]) -> list[str]:
    names: list[str] = []
    for prefix in prefixes:
        names.extend(name for name in net_ids if name.startswith(prefix))
    return sorted(set(names))


def net_class(
    name: str,
    description: str,
    nets: Iterable[str],
    *,
    clearance: float,
    trace_width: float,
    via_dia: float,
    via_drill: float,
    diff_pair_width: float | None = None,
    diff_pair_gap: float | None = None,
) -> str:
    lines = [
        f'  (net_class "{name}" "{description}"',
        f"    (clearance {clearance:.3f})",
        f"    (trace_width {trace_width:.3f})",
        f"    (via_dia {via_dia:.3f})",
        f"    (via_drill {via_drill:.3f})",
        "    (uvia_dia 0.150)",
        "    (uvia_drill 0.075)",
    ]
    if diff_pair_width is not None and diff_pair_gap is not None:
        lines.extend(
            [
                f"    (diff_pair_width {diff_pair_width:.3f})",
                f"    (diff_pair_gap {diff_pair_gap:.3f})",
            ]
        )
    lines.extend(f'    (add_net "{net}")' for net in sorted(set(nets)))
    lines.append("  )")
    return "\n".join(lines)


def build_net_classes(net_ids: dict[str, int]) -> list[str]:
    usb2 = class_nets(net_ids, ["USB_DP", "USB_DN", "CELL_USB2_DP", "CELL_USB2_DN"])
    mipi = prefixed_class_nets(net_ids, ["DSI_", "CAM0_CSI_", "CAM1_CSI_"])
    pcie = prefixed_class_nets(net_ids, ["WIFI_PCIE_", "CELL_PCIE_"])
    sdio = prefixed_class_nets(net_ids, ["WIFI_SDIO_"])
    memory = prefixed_class_nets(net_ids, ["LPDDR_"])
    storage = prefixed_class_nets(net_ids, ["UFS_"])
    rf = class_nets(
        net_ids,
        ["CELL_RF_MAIN", "CELL_RF_DIV", "CELL_GNSS_RF", "WIFI_BT_RF0", "WIFI_BT_RF1"],
    )
    power = class_nets(
        net_ids,
        [
            "VBUS",
            "VBAT",
            "SYS",
            "RF_VBAT",
            "AP_0V8",
            "AP_1V1",
            "AON_1V8",
            "IO_1V8",
            "CAM_AVDD_2V8",
            "CAM_DVDD_1V2",
            "DISP_AVDD_5V5",
            "DISP_AVEE_N5V5",
            "VDD_AUDIO_3V3",
            "VDD_AMP_3V3",
            "GND",
            "SHIELD_GND",
        ],
    )
    audio_control = class_nets(
        net_ids,
        [
            "I2S_BCLK",
            "I2S_LRCLK",
            "I2S_DOUT",
            "I2S_DIN",
            "PDM_CLK",
            "PDM_DAT",
            "AUDIO_I2C_SCL",
            "AUDIO_I2C_SDA",
            "CODEC_INT",
            "AMP_INT",
            "PWR_KEY_N",
            "VOL_UP_N",
            "VOL_DOWN_N",
        ],
    )
    sim_nfc_sensor = class_nets(
        net_ids,
        [
            "USIM_VCC",
            "USIM_CLK",
            "USIM_RST",
            "USIM_IO",
            "USIM_DET",
            "ESIM_VCC",
            "ESIM_CLK",
            "ESIM_RST",
            "ESIM_IO",
            "NFC_I2C_SCL",
            "NFC_I2C_SDA",
            "NFC_IRQ_N",
            "NFC_EN",
            "NFC_RF_P",
            "NFC_RF_N",
            "SENSOR_I2C_SCL",
            "SENSOR_I2C_SDA",
            "IMU_INT",
            "ALS_PROX_INT",
            "BARO_INT",
            "MAG_INT",
        ],
    )
    return [
        net_class(
            "E1Phone_USB2_90R",
            "USB2 differential pairs; final widths require fabricator impedance stackup",
            usb2,
            clearance=0.130,
            trace_width=0.120,
            via_dia=0.300,
            via_drill=0.150,
            diff_pair_width=0.120,
            diff_pair_gap=0.120,
        ),
        net_class(
            "E1Phone_MIPI_DPHY_100R",
            "MIPI DSI/CSI differential lanes; final widths require field solver",
            mipi,
            clearance=0.100,
            trace_width=0.100,
            via_dia=0.250,
            via_drill=0.100,
            diff_pair_width=0.100,
            diff_pair_gap=0.100,
        ),
        net_class(
            "E1Phone_PCIE_85R",
            "PCIe differential lanes for cellular and Wi-Fi modules",
            pcie,
            clearance=0.100,
            trace_width=0.100,
            via_dia=0.250,
            via_drill=0.100,
            diff_pair_width=0.100,
            diff_pair_gap=0.120,
        ),
        net_class(
            "E1Phone_RF_50R",
            "50 ohm RF feeds; final geometry requires RF vendor stackup and matching",
            rf,
            clearance=0.250,
            trace_width=0.180,
            via_dia=0.300,
            via_drill=0.150,
        ),
        net_class(
            "E1Phone_SDIO_50R",
            "Wi-Fi SDIO fallback single-ended bus",
            sdio,
            clearance=0.100,
            trace_width=0.100,
            via_dia=0.250,
            via_drill=0.100,
        ),
        net_class(
            "E1Phone_LPDDR_LENGTH_MATCHED",
            "LPDDR memory bus concept class; final constraints require AP/package memory interface signoff",
            memory,
            clearance=0.080,
            trace_width=0.080,
            via_dia=0.220,
            via_drill=0.100,
            diff_pair_width=0.080,
            diff_pair_gap=0.090,
        ),
        net_class(
            "E1Phone_UFS_MPHY",
            "UFS M-PHY differential lanes; final widths require field solver and vendor package escape",
            storage,
            clearance=0.090,
            trace_width=0.090,
            via_dia=0.240,
            via_drill=0.100,
            diff_pair_width=0.090,
            diff_pair_gap=0.100,
        ),
        net_class(
            "E1Phone_POWER",
            "Power, ground, shield, and high-current phone rails",
            power,
            clearance=0.160,
            trace_width=0.300,
            via_dia=0.450,
            via_drill=0.200,
        ),
        net_class(
            "E1Phone_AUDIO_CONTROL_AON",
            "Audio/control/always-on signals with relaxed digital constraints",
            audio_control,
            clearance=0.100,
            trace_width=0.100,
            via_dia=0.250,
            via_drill=0.100,
        ),
        net_class(
            "E1Phone_SIM_NFC_SENSOR",
            "SIM/eSIM, NFC control/loop placeholder, and low-speed sensor nets",
            sim_nfc_sensor,
            clearance=0.100,
            trace_width=0.100,
            via_dia=0.250,
            via_drill=0.100,
        ),
    ]


def ref_for_group(refdes_group: str, function: str) -> str:
    if refdes_group.startswith("J_"):
        return refdes_group
    if refdes_group.startswith("SW_"):
        return refdes_group
    if function.startswith("power_volume"):
        return "SW_SIDE_KEYS"
    return refdes_group


def footprint(
    name: str,
    ref: str,
    value: str,
    x: float,
    y: float,
    w: float,
    h: float,
    nets: list[str],
    net_ids: dict[str, int],
    side: str = "F",
    source: str = "placement_matrix",
) -> str:
    layer = f"{side}.Cu"
    silk = f"{side}.SilkS"
    fab = f"{side}.Fab"
    crtyd = f"{side}.CrtYd"
    copper_layers = f'"{side}.Cu" "{side}.Paste" "{side}.Mask"'
    half_w = w / 2.0
    half_h = h / 2.0
    pad_count = len(nets)
    pad_pitch = w / max(pad_count + 1, 2)
    pad_lines = []
    for idx, net in enumerate(nets):
        pad_x = -half_w + pad_pitch * (idx + 1)
        pad_lines.append(
            f'    (pad "{idx + 1}" smd roundrect (at {pad_x:.2f} {half_h - 0.45:.2f}) '
            f"(size 0.55 0.75) (layers {copper_layers}) (roundrect_rratio 0.2) "
            f'(net {net_ids[net]} "{net}") (tstamp "{stable_uuid(name, "pad", idx + 1)}"))'
        )
    pads = "\n".join(pad_lines)
    return f'''  (footprint "E1Phone:{name}" (layer "{layer}")
    (tstamp "{stable_uuid(name, ref)}")
    (at {x:.2f} {y:.2f})
    (descr "NON-RELEASE placeholder footprint generated from E1 phone placement plan; replace with supplier land pattern before fabrication")
    (tags "E1_PHONE_PLACEHOLDER NON_RELEASE {source}")
    (fp_text reference "{ref}" (at 0 {-half_h - 1.0:.2f} 0) (layer "{silk}") (tstamp "{stable_uuid(name, "ref")}")
      (effects (font (size 0.8 0.8) (thickness 0.12)))
    )
    (fp_text value "{value}" (at 0 {half_h + 1.0:.2f} 0) (layer "{fab}") (tstamp "{stable_uuid(name, "value")}")
      (effects (font (size 0.65 0.65) (thickness 0.1)))
    )
    (fp_text user "placeholder_not_fabrication_footprint" (at 0 {-half_h - 1.8:.2f} 0) (layer "{fab}") hide (tstamp "{stable_uuid(name, "claim")}")
      (effects (font (size 0.6 0.6) (thickness 0.08)))
    )
    (attr smd exclude_from_pos_files exclude_from_bom)
    (fp_rect (start {-half_w:.2f} {-half_h:.2f}) (end {half_w:.2f} {half_h:.2f}) (stroke (width 0.1) (type solid)) (fill none) (layer "{fab}") (tstamp "{stable_uuid(name, "fab")}"))
    (fp_rect (start {-half_w - 0.25:.2f} {-half_h - 0.25:.2f}) (end {half_w + 0.25:.2f} {half_h + 0.25:.2f}) (stroke (width 0.05) (type dash)) (fill none) (layer "{crtyd}") (tstamp "{stable_uuid(name, "courtyard")}"))
    (fp_text user "NON-RELEASE" (at 0 0 0) (layer "{silk}") (tstamp "{stable_uuid(name, "user")}")
      (effects (font (size 0.65 0.65) (thickness 0.1)))
    )
{pads}
  )'''


def testpoint(name: str, x: float, y: float, net_ids: dict[str, int]) -> str:
    return f'''  (footprint "E1Phone:TP_{name}" (layer "B.Cu")
    (tstamp "{stable_uuid("tp", name)}")
    (at {x:.2f} {y:.2f})
    (descr "NON-RELEASE required power test point placeholder")
    (fp_text reference "TP_{name}" (at 0 -1.35 0) (layer "B.SilkS") (tstamp "{stable_uuid("tp", name, "ref")}")
      (effects (font (size 0.65 0.65) (thickness 0.1)))
    )
    (fp_text value "{name}" (at 0 1.35 0) (layer "B.Fab") (tstamp "{stable_uuid("tp", name, "value")}")
      (effects (font (size 0.55 0.55) (thickness 0.08)))
    )
    (attr smd exclude_from_pos_files exclude_from_bom)
    (pad "1" smd circle (at 0 0) (size 1.15 1.15) (layers "B.Cu" "B.Mask") (net {net_ids[name]} "{name}") (tstamp "{stable_uuid("tp", name, "pad")}"))
  )'''


def small_support_part(
    name: str,
    ref: str,
    value: str,
    x: float,
    y: float,
    pads: list[tuple[str, str, float, float]],
    net_ids: dict[str, int],
    tag: str,
) -> str:
    pad_lines = []
    for pad_name, net, pad_x, pad_y in pads:
        pad_lines.append(
            f'    (pad "{pad_name}" smd roundrect (at {pad_x:.2f} {pad_y:.2f}) '
            f'(size 0.50 0.55) (layers "F.Cu" "F.Paste" "F.Mask") '
            f'(roundrect_rratio 0.2) (net {net_ids[net]} "{net}") '
            f'(tstamp "{stable_uuid(name, "pad", pad_name)}"))'
        )
    return f'''  (footprint "E1Phone:{name}" (layer "F.Cu")
    (tstamp "{stable_uuid("support", name)}")
    (at {x:.2f} {y:.2f})
    (descr "NON-RELEASE interface support placeholder; replace with supplier protection/RC footprint before fabrication")
    (tags "E1_PHONE_PLACEHOLDER NON_RELEASE {tag}")
    (fp_text reference "{ref}" (at 0 -1.45 0) (layer "F.SilkS") (tstamp "{stable_uuid(name, "ref")}")
      (effects (font (size 0.50 0.50) (thickness 0.08)))
    )
    (fp_text value "{value}" (at 0 1.45 0) (layer "F.Fab") (tstamp "{stable_uuid(name, "value")}")
      (effects (font (size 0.45 0.45) (thickness 0.07)))
    )
    (attr smd exclude_from_pos_files exclude_from_bom)
    (fp_rect (start -1.45 -0.75) (end 1.45 0.75) (stroke (width 0.05) (type dash)) (fill none) (layer "F.CrtYd") (tstamp "{stable_uuid(name, "courtyard")}"))
{chr(10).join(pad_lines)}
  )'''


def interface_test_pad(name: str, net: str, x: float, y: float, net_ids: dict[str, int]) -> str:
    return f'''  (footprint "E1Phone:USB_TP_{name}" (layer "B.Cu")
    (tstamp "{stable_uuid("usb-tp", name)}")
    (at {x:.2f} {y:.2f})
    (descr "NON-RELEASE USB-C bring-up test pad placeholder for {net}")
    (tags "E1_PHONE_PLACEHOLDER NON_RELEASE USB_C_TEST_ACCESS")
    (fp_text reference "USBTP_{name}" (at 0 -1.15 0) (layer "B.SilkS") (tstamp "{stable_uuid("usb-tp", name, "ref")}")
      (effects (font (size 0.45 0.45) (thickness 0.07)))
    )
    (fp_text value "{net}" (at 0 1.15 0) (layer "B.Fab") hide (tstamp "{stable_uuid("usb-tp", name, "value")}")
      (effects (font (size 0.45 0.45) (thickness 0.07)))
    )
    (attr smd exclude_from_pos_files exclude_from_bom)
    (pad "1" smd circle (at 0 0) (size 0.85 0.85) (layers "B.Cu" "B.Mask") (net {net_ids[net]} "{net}") (tstamp "{stable_uuid("usb-tp", name, "pad")}"))
  )'''


def build_interface_support_footprints(net_ids: dict[str, int]) -> list[str]:
    output = [
        small_support_part(
            "USB_PROTECT_USB2_ESD",
            "D_USB2_ESD",
            "USB2_ESD_ARRAY",
            27.0,
            121.8,
            [("1", "USB_DP", -0.55, 0.0), ("2", "USB_DN", 0.0, 0.0), ("3", "GND", 0.55, 0.0)],
            net_ids,
            "USB_C_ESD",
        ),
        small_support_part(
            "USB_PROTECT_CC_ESD",
            "D_CC_ESD",
            "CC_ESD_ARRAY",
            32.0,
            121.8,
            [("1", "USB_CC1", -0.55, 0.0), ("2", "USB_CC2", 0.0, 0.0), ("3", "GND", 0.55, 0.0)],
            net_ids,
            "USB_C_ESD",
        ),
        small_support_part(
            "USB_PROTECT_VBUS_TVS",
            "D_VBUS_TVS",
            "VBUS_TVS",
            37.0,
            121.8,
            [("1", "VBUS", -0.35, 0.0), ("2", "GND", 0.35, 0.0)],
            net_ids,
            "USB_C_VBUS_TVS",
        ),
    ]
    for idx, (name, net) in enumerate(
        [
            ("VBUS", "VBUS"),
            ("CC1", "USB_CC1"),
            ("CC2", "USB_CC2"),
            ("DP", "USB_DP"),
            ("DN", "USB_DN"),
        ]
    ):
        output.append(interface_test_pad(name, net, 23.0 + idx * 3.0, 118.4, net_ids))
    output.append(
        small_support_part(
            "SIDE_KEY_ESD",
            "D_KEYS_ESD",
            "SIDE_KEY_ESD_ARRAY",
            10.0,
            27.2,
            [
                ("1", "PWR_KEY_N", -0.72, 0.0),
                ("2", "VOL_UP_N", -0.24, 0.0),
                ("3", "VOL_DOWN_N", 0.24, 0.0),
                ("4", "GND", 0.72, 0.0),
            ],
            net_ids,
            "SIDE_KEY_ESD",
        )
    )
    for idx, net in enumerate(["PWR_KEY_N", "VOL_UP_N", "VOL_DOWN_N"]):
        output.append(
            small_support_part(
                f"SIDE_KEY_COND_{net}",
                f"RC_{idx + 1}",
                f"{net}_RC_DEBOUNCE",
                3.0 + idx * 5.0,
                28.8,
                [("1", net, -0.55, 0.0), ("2", "AON_1V8", 0.0, 0.0), ("3", "GND", 0.55, 0.0)],
                net_ids,
                "SIDE_KEY_CONDITIONING",
            )
        )
    return output


def spread_pads(nets: list[str], pitch: float = 0.46) -> list[tuple[str, str, float, float]]:
    start = -pitch * (len(nets) - 1) / 2.0
    return [(str(idx + 1), net, start + idx * pitch, 0.0) for idx, net in enumerate(nets)]


def build_display_camera_support_footprints(net_ids: dict[str, int]) -> list[str]:
    output = [
        small_support_part(
            "DISPLAY_DSI_ESD",
            "D_DSI_ESD",
            "DSI_4LANE_ESD_ARRAY",
            43.6,
            21.8,
            spread_pads(
                [
                    "DSI_CLK_P",
                    "DSI_CLK_N",
                    "DSI_D0_P",
                    "DSI_D0_N",
                    "DSI_D1_P",
                    "DSI_D1_N",
                    "DSI_D2_P",
                    "DSI_D2_N",
                    "DSI_D3_P",
                    "DSI_D3_N",
                    "GND",
                ],
                pitch=0.36,
            ),
            net_ids,
            "DISPLAY_DSI_ESD",
        ),
        small_support_part(
            "DISPLAY_TOUCH_CTRL_ESD",
            "D_TOUCH_ESD",
            "TOUCH_CONTROL_ESD",
            43.6,
            26.2,
            spread_pads(
                ["TOUCH_I2C_SCL", "TOUCH_I2C_SDA", "TOUCH_IRQ_N", "TOUCH_RESET_N", "GND"],
                pitch=0.48,
            ),
            net_ids,
            "DISPLAY_TOUCH_ESD",
        ),
        small_support_part(
            "DISPLAY_BIAS_BACKLIGHT",
            "U_DISP_BIAS",
            "DISPLAY_BIAS_BACKLIGHT_PLACEHOLDER",
            41.5,
            28.6,
            spread_pads(
                [
                    "DISP_AVDD_5V5",
                    "DISP_AVEE_N5V5",
                    "DISP_BL_EN",
                    "DISP_BL_PWM",
                    "DISP_RESET_N",
                    "IO_1V8",
                    "GND",
                ],
                pitch=0.42,
            ),
            net_ids,
            "DISPLAY_BIAS_BACKLIGHT",
        ),
        small_support_part(
            "CAMERA_CSI0_ESD",
            "D_CAM0_ESD",
            "CAM0_CSI_ESD_ARRAY",
            43.2,
            10.8,
            spread_pads(
                [
                    "CAM0_CSI_CLK_P",
                    "CAM0_CSI_CLK_N",
                    "CAM0_CSI_D0_P",
                    "CAM0_CSI_D0_N",
                    "CAM0_CSI_D1_P",
                    "CAM0_CSI_D1_N",
                    "CAM0_CSI_D2_P",
                    "CAM0_CSI_D2_N",
                    "CAM0_CSI_D3_P",
                    "CAM0_CSI_D3_N",
                    "GND",
                ],
                pitch=0.36,
            ),
            net_ids,
            "CAMERA_CSI_ESD",
        ),
        small_support_part(
            "CAMERA_CSI1_ESD",
            "D_CAM1_ESD",
            "CAM1_CSI_ESD_ARRAY",
            43.2,
            14.8,
            spread_pads(
                [
                    "CAM1_CSI_CLK_P",
                    "CAM1_CSI_CLK_N",
                    "CAM1_CSI_D0_P",
                    "CAM1_CSI_D0_N",
                    "CAM1_CSI_D1_P",
                    "CAM1_CSI_D1_N",
                    "GND",
                ],
                pitch=0.42,
            ),
            net_ids,
            "CAMERA_CSI_ESD",
        ),
        small_support_part(
            "CAMERA_POWER_SEQUENCE",
            "U_CAM_PWR",
            "CAMERA_POWER_SEQUENCE_PLACEHOLDER",
            43.2,
            18.7,
            spread_pads(
                [
                    "CAM_AVDD_2V8",
                    "CAM_DVDD_1V2",
                    "IO_1V8",
                    "CAM0_RESET_N",
                    "CAM1_RESET_N",
                    "CAM0_PWDN",
                    "GND",
                ],
                pitch=0.42,
            ),
            net_ids,
            "CAMERA_POWER_SEQUENCE",
        ),
        small_support_part(
            "CAMERA_I2C_AF_PULLUPS",
            "RN_CAM_I2C",
            "CAMERA_I2C_AF_PULLUPS",
            43.2,
            22.6,
            spread_pads(
                [
                    "CAM0_I2C_SCL",
                    "CAM0_I2C_SDA",
                    "CAM1_I2C_SCL",
                    "CAM1_I2C_SDA",
                    "CAM0_AF_I2C_SCL",
                    "CAM0_AF_I2C_SDA",
                    "IO_1V8",
                    "GND",
                ],
                pitch=0.40,
            ),
            net_ids,
            "CAMERA_I2C_AF_PULLUPS",
        ),
    ]
    return output


def build_audio_haptic_support_footprints(net_ids: dict[str, int]) -> list[str]:
    return [
        small_support_part(
            "AUDIO_CODEC_RAIL_DECOUPLING",
            "C_AUDIO",
            "AUDIO_CODEC_RAIL_DECOUPLING",
            8.0,
            127.2,
            spread_pads(["VDD_AUDIO_3V3", "IO_1V8", "GND"], pitch=0.52),
            net_ids,
            "AUDIO_RAIL_DECOUPLING",
        ),
        small_support_part(
            "AUDIO_AMP_RAIL_DECOUPLING",
            "C_AMP",
            "SMART_AMP_RAIL_DECOUPLING",
            17.0,
            127.2,
            spread_pads(["VDD_AMP_3V3", "SYS", "GND"], pitch=0.52),
            net_ids,
            "AUDIO_RAIL_DECOUPLING",
        ),
        small_support_part(
            "AUDIO_I2S_PDM_DAMPING",
            "RN_AUDIO_DIG",
            "I2S_PDM_DAMPING_PLACEHOLDER",
            28.0,
            127.2,
            spread_pads(
                ["I2S_BCLK", "I2S_LRCLK", "I2S_DOUT", "I2S_DIN", "PDM_CLK", "PDM_DAT", "GND"],
                pitch=0.42,
            ),
            net_ids,
            "AUDIO_I2S_PDM_DAMPING",
        ),
        small_support_part(
            "AUDIO_I2C_IRQ_PULLUPS",
            "RN_AUDIO_CTL",
            "AUDIO_I2C_IRQ_PULLUPS",
            39.0,
            127.2,
            spread_pads(
                ["AUDIO_I2C_SCL", "AUDIO_I2C_SDA", "CODEC_INT", "AMP_INT", "IO_1V8", "GND"],
                pitch=0.44,
            ),
            net_ids,
            "AUDIO_I2C_IRQ_PULLUPS",
        ),
        small_support_part(
            "AUDIO_MIC_BIAS_ESD",
            "D_MIC",
            "PDM_MIC_ESD_BIAS_PLACEHOLDER",
            13.0,
            119.4,
            spread_pads(["PDM_CLK", "PDM_DAT", "VDD_AUDIO_3V3", "GND"], pitch=0.50),
            net_ids,
            "AUDIO_MIC_BIAS_ESD",
        ),
        small_support_part(
            "AUDIO_SPK_OUTPUT_PROTECT",
            "D_SPK",
            "SPEAKER_OUTPUT_PROTECT",
            47.0,
            119.4,
            spread_pads(["SPK_P", "SPK_N", "GND"], pitch=0.58),
            net_ids,
            "AUDIO_SPEAKER_PROTECT",
        ),
        small_support_part(
            "HAPTIC_DRIVER_OUTPUT",
            "U_HAPTIC",
            "HAPTIC_DRIVER_PLACEHOLDER",
            58.0,
            127.2,
            spread_pads(["HAPTIC_OUT", "SYS", "IO_1V8", "GND"], pitch=0.48),
            net_ids,
            "HAPTIC_DRIVER",
        ),
    ]


def build_power_management_support_footprints(net_ids: dict[str, int]) -> list[str]:
    return [
        small_support_part(
            "POWER_USBPD_LOCAL_RAIL",
            "C_USBPD",
            "USBPD_VIN_DECOUPLING",
            46.5,
            24.8,
            spread_pads(["VIN_3V3", "GND"], pitch=0.58),
            net_ids,
            "POWER_USBPD_LOCAL_RAIL",
        ),
        small_support_part(
            "POWER_CHARGER_INPUT_FILTER",
            "FL_CHG_IN",
            "VBUS_CHARGER_INPUT_FILTER",
            50.5,
            24.8,
            spread_pads(["VBUS", "SYS", "GND"], pitch=0.52),
            net_ids,
            "POWER_CHARGER_INPUT_FILTER",
        ),
        small_support_part(
            "POWER_CHARGER_BATTERY_SENSE",
            "RN_BAT_SENSE",
            "BATTERY_NTC_ID_SENSE",
            54.8,
            24.8,
            spread_pads(["VBAT", "BAT_NTC", "BAT_ID", "GND"], pitch=0.48),
            net_ids,
            "POWER_CHARGER_BATTERY_SENSE",
        ),
        small_support_part(
            "POWER_FUEL_GAUGE_PLACEHOLDER",
            "U_FG",
            "FUEL_GAUGE_PLACEHOLDER",
            59.0,
            24.8,
            spread_pads(
                ["VBAT", "SYS", "CHG_I2C_SCL", "CHG_I2C_SDA", "BAT_NTC", "BAT_ID", "GND"],
                pitch=0.42,
            ),
            net_ids,
            "POWER_FUEL_GAUGE",
        ),
        small_support_part(
            "POWER_PMIC_CONTROL_PULLUPS",
            "RN_PMIC_CTL",
            "PMIC_CHARGER_PD_I2C_IRQ_PULLUPS",
            38.0,
            29.0,
            spread_pads(
                [
                    "PMIC_I2C_SCL",
                    "PMIC_I2C_SDA",
                    "PMIC_IRQ_N",
                    "PMIC_RESET_N",
                    "CHG_I2C_SCL",
                    "CHG_I2C_SDA",
                    "CHG_IRQ_N",
                    "USBPD_I2C_SCL",
                    "USBPD_I2C_SDA",
                    "USBPD_IRQ_N",
                    "USBPD_RESET",
                    "AON_1V8",
                    "GND",
                ],
                pitch=0.32,
            ),
            net_ids,
            "POWER_CONTROL_PULLUPS",
        ),
        small_support_part(
            "POWER_PMIC_INPUT_DECOUPLING",
            "C_PMIC_IN",
            "PMIC_SYS_VBAT_INPUT_DECOUPLING",
            20.0,
            22.8,
            spread_pads(["SYS", "VBAT", "GND"], pitch=0.52),
            net_ids,
            "POWER_PMIC_INPUT_DECOUPLING",
        ),
        small_support_part(
            "POWER_AP_RAIL_DECOUPLING",
            "C_AP_RAILS",
            "AP_CORE_IO_DECOUPLING",
            25.6,
            22.8,
            spread_pads(["AP_0V8", "AP_1V1", "IO_1V8", "GND"], pitch=0.48),
            net_ids,
            "POWER_AP_RAIL_DECOUPLING",
        ),
        small_support_part(
            "POWER_RF_RAIL_DECOUPLING",
            "C_RF_RAILS",
            "RF_VBAT_IO_DECOUPLING",
            31.2,
            22.8,
            spread_pads(["RF_VBAT", "IO_1V8", "GND"], pitch=0.52),
            net_ids,
            "POWER_RF_RAIL_DECOUPLING",
        ),
        small_support_part(
            "POWER_CAMERA_RAIL_DECOUPLING",
            "C_CAM_RAILS",
            "CAMERA_AVDD_DVDD_DECOUPLING",
            36.8,
            22.8,
            spread_pads(["CAM_AVDD_2V8", "CAM_DVDD_1V2", "IO_1V8", "GND"], pitch=0.48),
            net_ids,
            "POWER_CAMERA_RAIL_DECOUPLING",
        ),
        small_support_part(
            "POWER_DISPLAY_RAIL_DECOUPLING",
            "C_DISP_RAILS",
            "DISPLAY_BIAS_DECOUPLING",
            42.4,
            22.8,
            spread_pads(["DISP_AVDD_5V5", "DISP_AVEE_N5V5", "IO_1V8", "GND"], pitch=0.48),
            net_ids,
            "POWER_DISPLAY_RAIL_DECOUPLING",
        ),
        small_support_part(
            "POWER_AON_BUTTON_WAKE_DECOUPLING",
            "C_AON",
            "AON_BUTTON_WAKE_DECOUPLING",
            18.0,
            28.8,
            spread_pads(["AON_1V8", "PWR_KEY_N", "GND"], pitch=0.52),
            net_ids,
            "POWER_AON_WAKE",
        ),
        small_support_part(
            "POWER_HIGH_CURRENT_SHUNT_PLACEHOLDERS",
            "RS_PWR",
            "VBUS_VBAT_SYS_CURRENT_SENSE",
            24.0,
            28.8,
            spread_pads(["VBUS", "VBAT", "SYS", "RF_VBAT", "GND"], pitch=0.46),
            net_ids,
            "POWER_CURRENT_SENSE",
        ),
    ]


def build_compute_storage_support_footprints(net_ids: dict[str, int]) -> list[str]:
    return [
        small_support_part(
            "COMPUTE_SOC_LOCAL_DECOUPLING",
            "C_SOC_CORE",
            "SOC_CORE_IO_DECOUPLING",
            20.5,
            7.8,
            spread_pads(["AP_0V8", "AP_1V1", "IO_1V8", "GND"], pitch=0.48),
            net_ids,
            "COMPUTE_SOC_DECOUPLING",
        ),
        small_support_part(
            "COMPUTE_LPDDR_CK_DQS_TERM",
            "RN_LPDDR_DIFF",
            "LPDDR_CK_DQS_TERM_PLACEHOLDER",
            25.5,
            7.8,
            spread_pads(
                ["LPDDR_CK_P", "LPDDR_CK_N", "LPDDR_DQS_P", "LPDDR_DQS_N", "GND"], pitch=0.44
            ),
            net_ids,
            "COMPUTE_LPDDR_DIFF_TERM",
        ),
        small_support_part(
            "COMPUTE_LPDDR_CA_DAMPING",
            "RN_LPDDR_CA",
            "LPDDR_CA_DAMPING_PLACEHOLDER",
            30.5,
            7.8,
            spread_pads(
                [
                    "LPDDR_CA0",
                    "LPDDR_CA1",
                    "LPDDR_CA2",
                    "LPDDR_CA3",
                    "LPDDR_RESET_N",
                    "LPDDR_ZQ",
                    "GND",
                ],
                pitch=0.40,
            ),
            net_ids,
            "COMPUTE_LPDDR_CA_DAMPING",
        ),
        small_support_part(
            "COMPUTE_LPDDR_DQ_ESCAPE",
            "RN_LPDDR_DQ",
            "LPDDR_DQ_ESCAPE_PLACEHOLDER",
            35.5,
            7.8,
            spread_pads(["LPDDR_DQ0", "LPDDR_DQ1", "LPDDR_DQ2", "LPDDR_DQ3", "GND"], pitch=0.44),
            net_ids,
            "COMPUTE_LPDDR_DQ_ESCAPE",
        ),
        small_support_part(
            "COMPUTE_UFS_MPHY_ESD_TERM",
            "RN_UFS",
            "UFS_MPHY_ESD_TERM_PLACEHOLDER",
            40.5,
            7.8,
            spread_pads(
                [
                    "UFS_REFCLK_P",
                    "UFS_REFCLK_N",
                    "UFS_TX_P",
                    "UFS_TX_N",
                    "UFS_RX_P",
                    "UFS_RX_N",
                    "UFS_RESET_N",
                    "GND",
                ],
                pitch=0.36,
            ),
            net_ids,
            "COMPUTE_UFS_MPHY",
        ),
        small_support_part(
            "COMPUTE_DEBUG_BOOT_STRAPS",
            "J_DEBUG",
            "JTAG_BOOT_STRAP_TEST_ACCESS",
            44.0,
            16.2,
            spread_pads(
                [
                    "JTAG_TCK",
                    "JTAG_TMS",
                    "JTAG_TDI",
                    "JTAG_TDO",
                    "JTAG_TRST_N",
                    "BOOT_MODE0",
                    "BOOT_MODE1",
                    "BOOT_MODE2",
                    "SOC_RESET_N",
                    "IO_1V8",
                    "GND",
                ],
                pitch=0.34,
            ),
            net_ids,
            "COMPUTE_DEBUG_BOOT",
        ),
    ]


def build_identity_sensor_support_footprints(net_ids: dict[str, int]) -> list[str]:
    return [
        small_support_part(
            "PHONE_IDENTITY_USIM_ESD_LEVELSHIFT",
            "D_USIM",
            "USIM_ESD_LEVEL_SHIFT_PLACEHOLDER",
            52.0,
            28.7,
            spread_pads(
                ["USIM_VCC", "USIM_CLK", "USIM_RST", "USIM_IO", "USIM_DET", "GND"], pitch=0.42
            ),
            net_ids,
            "PHONE_IDENTITY_USIM",
        ),
        small_support_part(
            "PHONE_IDENTITY_ESIM_PLACEHOLDER",
            "U_ESIM",
            "ESIM_MODULE_PLACEHOLDER",
            59.0,
            28.7,
            spread_pads(
                ["ESIM_VCC", "ESIM_CLK", "ESIM_RST", "ESIM_IO", "IO_1V8", "GND"], pitch=0.42
            ),
            net_ids,
            "PHONE_IDENTITY_ESIM",
        ),
        small_support_part(
            "PHONE_IDENTITY_GNSS_LNA_SAW",
            "U_GNSS_RF",
            "GNSS_LNA_SAW_PLACEHOLDER",
            56.2,
            10.5,
            spread_pads(["CELL_GNSS_RF", "RF_VBAT", "IO_1V8", "GND"], pitch=0.48),
            net_ids,
            "PHONE_IDENTITY_GNSS",
        ),
        small_support_part(
            "PHONE_IDENTITY_NFC_CONTROLLER",
            "U_NFC",
            "NFC_CONTROLLER_PLACEHOLDER",
            51.0,
            127.2,
            spread_pads(
                [
                    "NFC_I2C_SCL",
                    "NFC_I2C_SDA",
                    "NFC_IRQ_N",
                    "NFC_EN",
                    "NFC_RF_P",
                    "NFC_RF_N",
                    "IO_1V8",
                    "GND",
                ],
                pitch=0.36,
            ),
            net_ids,
            "PHONE_IDENTITY_NFC",
        ),
        small_support_part(
            "PHONE_IDENTITY_NFC_LOOP_MATCH",
            "MN_NFC",
            "NFC_LOOP_MATCH_PLACEHOLDER",
            51.0,
            130.2,
            spread_pads(["NFC_RF_P", "NFC_RF_N", "GND"], pitch=0.58),
            net_ids,
            "PHONE_IDENTITY_NFC_LOOP",
        ),
        small_support_part(
            "PHONE_IDENTITY_SENSOR_HUB",
            "U_SENS",
            "IMU_ALS_PROX_BARO_PLACEHOLDER",
            11.5,
            17.0,
            spread_pads(
                [
                    "SENSOR_I2C_SCL",
                    "SENSOR_I2C_SDA",
                    "IMU_INT",
                    "ALS_PROX_INT",
                    "BARO_INT",
                    "MAG_INT",
                    "AON_1V8",
                    "IO_1V8",
                    "GND",
                ],
                pitch=0.36,
            ),
            net_ids,
            "PHONE_IDENTITY_SENSORS",
        ),
    ]


def rf_matching_network(name: str, net: str, x: float, y: float, net_ids: dict[str, int]) -> str:
    net_id = net_ids[net]
    gnd_id = net_ids["GND"]
    return f'''  (footprint "E1Phone:RF_MATCH_{net}" (layer "F.Cu")
    (tstamp "{stable_uuid("rf-match", net)}")
    (at {x:.2f} {y:.2f})
    (descr "NON-RELEASE RF pi matching placeholder for {net}; replace with vendor reference layout before fabrication")
    (tags "E1_PHONE_PLACEHOLDER NON_RELEASE RF_MATCHING {name}")
    (fp_text reference "MN_{name}" (at 0 -1.8 0) (layer "F.SilkS") (tstamp "{stable_uuid("rf-match", net, "ref")}")
      (effects (font (size 0.55 0.55) (thickness 0.08)))
    )
    (fp_text value "{net}_PI_MATCH" (at 0 1.8 0) (layer "F.Fab") (tstamp "{stable_uuid("rf-match", net, "value")}")
      (effects (font (size 0.45 0.45) (thickness 0.07)))
    )
    (fp_text user "NON-RELEASE RF MATCH" (at 0 0 0) (layer "F.Fab") hide (tstamp "{stable_uuid("rf-match", net, "user")}")
      (effects (font (size 0.45 0.45) (thickness 0.07)))
    )
    (attr smd exclude_from_pos_files exclude_from_bom)
    (fp_rect (start -1.55 -0.85) (end 1.55 0.85) (stroke (width 0.05) (type dash)) (fill none) (layer "F.CrtYd") (tstamp "{stable_uuid("rf-match", net, "courtyard")}"))
    (pad "1" smd rect (at -0.95 0) (size 0.45 0.55) (layers "F.Cu" "F.Paste" "F.Mask") (net {net_id} "{net}") (tstamp "{stable_uuid("rf-match", net, "pad1")}"))
    (pad "2" smd rect (at 0 0) (size 0.45 0.55) (layers "F.Cu" "F.Paste" "F.Mask") (net {net_id} "{net}") (tstamp "{stable_uuid("rf-match", net, "pad2")}"))
    (pad "3" smd rect (at 0.95 0) (size 0.45 0.55) (layers "F.Cu" "F.Paste" "F.Mask") (net {net_id} "{net}") (tstamp "{stable_uuid("rf-match", net, "pad3")}"))
    (pad "4" smd rect (at -0.48 0.65) (size 0.45 0.45) (layers "F.Cu" "F.Paste" "F.Mask") (net {gnd_id} "GND") (tstamp "{stable_uuid("rf-match", net, "pad4")}"))
    (pad "5" smd rect (at 0.48 0.65) (size 0.45 0.45) (layers "F.Cu" "F.Paste" "F.Mask") (net {gnd_id} "GND") (tstamp "{stable_uuid("rf-match", net, "pad5")}"))
  )'''


def rf_conducted_pad(name: str, net: str, x: float, y: float, net_ids: dict[str, int]) -> str:
    return f'''  (footprint "E1Phone:RF_TP_{net}" (layer "F.Cu")
    (tstamp "{stable_uuid("rf-tp", net)}")
    (at {x:.2f} {y:.2f})
    (descr "NON-RELEASE EVT0 conducted RF test pad for {net}; final U.FL/pad decision requires RF review")
    (tags "E1_PHONE_PLACEHOLDER NON_RELEASE RF_CONDUCTED_TEST {name}")
    (fp_text reference "RFTP_{name}" (at 0 -1.25 0) (layer "F.SilkS") (tstamp "{stable_uuid("rf-tp", net, "ref")}")
      (effects (font (size 0.50 0.50) (thickness 0.08)))
    )
    (fp_text value "{net}" (at 0 1.25 0) (layer "F.Fab") hide (tstamp "{stable_uuid("rf-tp", net, "value")}")
      (effects (font (size 0.45 0.45) (thickness 0.07)))
    )
    (attr smd exclude_from_pos_files exclude_from_bom)
    (pad "1" smd circle (at 0 0) (size 0.95 0.95) (layers "F.Cu" "F.Mask") (net {net_ids[net]} "{net}") (tstamp "{stable_uuid("rf-tp", net, "pad")}"))
  )'''


def build_rf_feed_footprints(routing: dict, net_ids: dict[str, int]) -> list[str]:
    positions = {
        "CELL_RF_MAIN": ("CELL_MAIN", 7.0, 6.7, 12.2, 6.7),
        "CELL_RF_DIV": ("CELL_DIV", 13.2, 6.7, 18.4, 6.7),
        "CELL_GNSS_RF": ("GNSS", 55.0, 6.7, 59.0, 6.7),
        "WIFI_BT_RF0": ("WIFI0", 10.0, 21.5, 10.0, 25.5),
        "WIFI_BT_RF1": ("WIFI1", 15.0, 21.5, 15.0, 25.5),
    }
    output: list[str] = []
    for item in routing["rf_layout"]["matching_networks_required"]:
        net = item["net"]
        if net not in positions or net not in net_ids:
            continue
        name, match_x, match_y, tp_x, tp_y = positions[net]
        output.append(rf_matching_network(name, net, match_x, match_y, net_ids))
        output.append(rf_conducted_pad(name, net, tp_x, tp_y, net_ids))
    return output


def fiducial(name: str, x: float, y: float) -> str:
    return f'''  (footprint "E1Phone:FID_{name}" (layer "F.Cu")
    (tstamp "{stable_uuid("fid", name)}")
    (at {x:.2f} {y:.2f})
    (descr "NON-RELEASE global fiducial placeholder")
    (fp_text reference "FID_{name}" (at 0 -1.4 0) (layer "F.SilkS") hide (tstamp "{stable_uuid("fid", name, "ref")}")
      (effects (font (size 0.55 0.55) (thickness 0.08)))
    )
    (fp_text value "FIDUCIAL" (at 0 1.4 0) (layer "F.Fab") hide (tstamp "{stable_uuid("fid", name, "value")}")
      (effects (font (size 0.55 0.55) (thickness 0.08)))
    )
    (attr smd exclude_from_pos_files exclude_from_bom)
    (pad "1" smd circle (at 0 0) (size 1.0 1.0) (layers "F.Cu" "F.Mask") (solder_mask_margin 1.0) (clearance 1.0) (tstamp "{stable_uuid("fid", name, "pad")}"))
  )'''


def mounting_hole(name: str, x: float, y: float) -> str:
    return f'''  (footprint "E1Phone:MH_{name}" (layer "F.Cu")
    (tstamp "{stable_uuid("mh", name)}")
    (at {x:.2f} {y:.2f})
    (descr "NON-RELEASE mechanical mounting hole placeholder; final boss/screw geometry required")
    (fp_text reference "MH_{name}" (at 0 -2.2 0) (layer "F.SilkS") hide (tstamp "{stable_uuid("mh", name, "ref")}")
      (effects (font (size 0.55 0.55) (thickness 0.08)))
    )
    (fp_text value "MOUNT" (at 0 2.2 0) (layer "F.Fab") hide (tstamp "{stable_uuid("mh", name, "value")}")
      (effects (font (size 0.55 0.55) (thickness 0.08)))
    )
    (attr exclude_from_pos_files exclude_from_bom)
    (pad "" np_thru_hole circle (at 0 0) (size 2.0 2.0) (drill 1.2) (layers "*.Cu" "*.Mask") (tstamp "{stable_uuid("mh", name, "pad")}"))
    (fp_circle (center 0 0) (end 1.6 0) (stroke (width 0.08) (type dash)) (fill none) (layer "F.CrtYd") (tstamp "{stable_uuid("mh", name, "courtyard")}"))
  )'''


def build_placement_footprints(
    placements: Iterable[dict], all_nets: set[str], net_ids: dict[str, int]
) -> list[str]:
    output: list[str] = []
    for item in placements:
        region = item["region_mm"]
        ref = ref_for_group(item["refdes_group"], item["function"])
        x = float(region["x"]) + float(region["width"]) / 2.0
        y = float(region["y"]) + float(region["height"]) / 2.0
        nets = expand_required_nets(item.get("required_nets", []), all_nets)
        if item["refdes_group"].startswith("J_TOP_BOTTOM_FLEX_"):
            while len(nets) < 49:
                nets.append("GND")
        else:
            nets = nets[:24]
        while len(nets) < 2:
            nets.append("GND")
        value = item["function"][:52]
        output.append(
            footprint(
                item["refdes_group"],
                ref,
                value,
                x,
                y,
                float(region["width"]),
                float(region["height"]),
                nets,
                net_ids,
                source=item.get("package_binding", "placement_matrix"),
            )
        )
    return output


def main() -> int:
    block_netlist = load_yaml(BLOCK_NETLIST)
    placement = load_yaml(PLACEMENT)
    routing = load_yaml(ROUTING)
    text = remove_generated_content(PCB.read_text())
    if not text.rstrip().endswith(")"):
        raise SystemExit(f"unexpected KiCad PCB format: {PCB}")
    all_nets = flatten_block_nets(block_netlist)
    placement_nets: list[str] = []
    for item in placement["placements"]:
        placement_nets.extend(expand_required_nets(item.get("required_nets", []), all_nets)[:24])
    testpoint_nets = list(routing["power_integrity"]["test_points_required"])
    text, net_ids = insert_net_table(text, sorted(all_nets) + placement_nets + testpoint_nets)
    body = text.rstrip()[:-1].rstrip()

    generated: list[str] = []
    generated.extend(build_net_classes(net_ids))
    generated.extend(build_placement_footprints(placement["placements"], all_nets, net_ids))
    interface_support = build_interface_support_footprints(net_ids)
    generated.extend(interface_support)
    display_camera_support = build_display_camera_support_footprints(net_ids)
    generated.extend(display_camera_support)
    audio_haptic_support = build_audio_haptic_support_footprints(net_ids)
    generated.extend(audio_haptic_support)
    power_management_support = build_power_management_support_footprints(net_ids)
    generated.extend(power_management_support)
    compute_storage_support = build_compute_storage_support_footprints(net_ids)
    generated.extend(compute_storage_support)
    identity_sensor_support = build_identity_sensor_support_footprints(net_ids)
    generated.extend(identity_sensor_support)
    generated.extend(build_rf_feed_footprints(routing, net_ids))

    tp_positions = [
        (name, 6.0 + idx * 7.2, 118.0 if idx % 2 == 0 else 121.0)
        for idx, name in enumerate(routing["power_integrity"]["test_points_required"])
    ]
    generated.extend(testpoint(name, x, y, net_ids) for name, x, y in tp_positions)
    generated.extend(
        [
            fiducial("TL", 4.0, 4.0),
            fiducial("TR", 60.0, 4.0),
            fiducial("BR", 60.0, 128.0),
            mounting_hole("TL", 8.0, 26.0),
            mounting_hole("TR", 56.0, 26.0),
            mounting_hole("BL", 8.0, 124.0),
            mounting_hole("BR", 56.0, 124.0),
        ]
    )
    new_text = body + "\n" + "\n".join(generated) + "\n)\n"
    PCB.write_text(new_text)
    print(f"updated {PCB}")
    print(
        f"generated_placement_footprints={len(placement['placements'])} "
        f"testpoints={len(tp_positions)} fiducials=3 mounting_holes=4 "
        f"interface_support_placeholders={len(interface_support)} "
        f"display_camera_support_placeholders={len(display_camera_support)} "
        f"audio_haptic_support_placeholders={len(audio_haptic_support)} "
        f"power_management_support_placeholders={len(power_management_support)} "
        f"compute_storage_support_placeholders={len(compute_storage_support)} "
        f"identity_sensor_support_placeholders={len(identity_sensor_support)} "
        f"rf_feed_placeholders={len(build_rf_feed_footprints(routing, net_ids))} "
        f"declared_nets={len(net_ids)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
