#!/usr/bin/env python3
"""
Generate the non-release E1 phone routed mainboard *demonstration* set.

This script is idempotent. It does NOT flip any closure gates, does NOT
modify the existing concept/scaffold files, and every artifact it emits is
clearly tagged with `evidence_class: non_release_routing_demonstration`.

Outputs (all under board/kicad/e1-phone/):
  schematic/<block>-demo.kicad_sch  -- six block sheets + root
  pcb/e1-phone-mainboard-demo.kicad_pcb
  pcb/fab-demo/*.{gbr,drl,csv,step}
  pcb-implementation-audit-demo.yaml

Plus a copy of the demo STEP into mechanical/e1-phone/out/.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BOARD_DIR = ROOT / "board/kicad/e1-phone"
SCH_DIR = BOARD_DIR / "schematic"
PCB_DIR = BOARD_DIR / "pcb"
FAB_DIR = PCB_DIR / "fab-demo"
MECH_OUT = ROOT / "mechanical/e1-phone/out"

KICAD_CLI = ROOT / "tools/bin/kicad-cli"

EVIDENCE = "non_release_routing_demonstration"
NS = uuid.UUID("12345678-1234-5678-1234-567812345678")  # deterministic namespace


def det_uuid(key: str) -> str:
    return str(uuid.uuid5(NS, key))


# ---------------------------------------------------------------------------
# Schematic generation
# ---------------------------------------------------------------------------
#
# These are deliberately *minimal* v8 KiCad schematics: paper, title block,
# explanatory text, named-net labels matching block-netlist.yaml, and a few
# generic Conn_01_xNN/R/C/L symbols rendered as text-only placeholders. The
# point is to make the netlist-bearing relationships visible, not to pretend
# this is ERC-clean reviewed schematic capture.

SHEET_HEADER = """(kicad_sch (version 20240618) (generator "eliza-phone-demo-generator")
  (uuid "{uuid}")
  (paper "A3")
  (title_block
    (title "{title}")
    (date "2026-05-20")
    (rev "concept-routing-demo-r0")
    (company "Eliza phone board planning")
    (comment 1 "Evidence class: non_release_routing_demonstration")
    (comment 2 "Not ERC-clean. Not a production schematic. Not fabrication-bound.")
    (comment 3 "Source: board/kicad/e1-phone/block-netlist.yaml")
  )
  (text "Evidence class: non_release_routing_demonstration" (at 20.00 18.00 0)
    (effects (font (size 2.20 2.20) (thickness 0.4)) (justify left bottom))
  )
  (text "{subtitle}" (at 20.00 24.00 0)
    (effects (font (size 1.60 1.60)) (justify left bottom))
  )
"""

SHEET_FOOTER = ")\n"


def sheet_text_block(lines: list[str], x: float = 20.0, y_start: float = 32.0, dy: float = 5.0, size: float = 1.20) -> str:
    out = []
    y = y_start
    for line in lines:
        # KiCad string escape
        safe = line.replace("\\", "\\\\").replace('"', '\\"')
        out.append(
            f'  (text "{safe}" (at {x:.2f} {y:.2f} 0)\n'
            f'    (effects (font (size {size:.2f} {size:.2f})) (justify left bottom))\n  )\n'
        )
        y += dy
    return "".join(out)


def write_sheet(path: Path, title: str, subtitle: str, lines: list[str]) -> None:
    body = (
        SHEET_HEADER.format(uuid=det_uuid(path.name), title=title, subtitle=subtitle)
        + sheet_text_block(lines)
        + SHEET_FOOTER
    )
    path.write_text(body)


def gen_schematics() -> list[Path]:
    SCH_DIR.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []

    # power_usb-demo
    p = SCH_DIR / "power_usb-demo.kicad_sch"
    write_sheet(
        p,
        "E1 Phone DEMO - Power, Battery, Charger, USB-C",
        "Routing demonstration only. Generic Conn_01_x24 / R / C / L symbols, named nets.",
        [
            "J_USB_C : Conn_01_x24 (USB-C 24-pin receptacle placeholder)",
            "  nets: VBUS, GND, SHIELD_GND, USB_DP, USB_DN, USB_CC1, USB_CC2",
            "  ESD: TVS arrays on VBUS/USB_DP/USB_DN/USB_CC1/USB_CC2",
            "U_USB_PD : usb_pd_controller (TPS65987 placeholder)",
            "  power: VIN_3V3, GND  control: USBPD_I2C_SCL/SDA, USBPD_IRQ_N, USBPD_RESET",
            "U_CHARGER : charger_power_path (MAX77860 placeholder)",
            "  power: VBUS, VBAT, SYS, GND  ctrl: CHG_I2C_SCL/SDA, CHG_IRQ_N, BAT_NTC, BAT_ID",
            "J_BATTERY : Conn_01_x06 (battery pack flex)  nets: VBAT, GND, BAT_NTC, BAT_ID",
            "U_PMIC : pmic (DA9063 placeholder) outputs: AON_1V8, AP_0V8, AP_1V1, IO_1V8,",
            "  RF_VBAT, CAM_AVDD_2V8, CAM_DVDD_1V2, VDD_AUDIO_3V3, VDD_AMP_3V3",
            "Decoupling: C_VBUS=10uF/25V (x2), C_SYS=22uF (x2), C_VBAT=22uF, C_3V3=10uF+0.1uF per rail",
            "Inductors: L_AP_0V8=0.47uH (DCDC1), L_AP_1V1=0.47uH (DCDC2), L_IO_1V8=1.0uH",
            "Test points: TP_VBUS, TP_SYS, TP_VBAT, TP_AON_1V8, TP_AP_0V8, TP_AP_1V1",
            "Status: non_release_routing_demonstration. Replace with reviewed supplier pinouts before fab.",
        ],
    )
    paths.append(p)

    # compute-demo
    p = SCH_DIR / "compute-demo.kicad_sch"
    write_sheet(
        p,
        "E1 Phone DEMO - Compute (SoC, LPDDR, UFS)",
        "Routing demonstration only.",
        [
            "U_SOC : application_processor (E1 SoC, BGA placeholder)",
            "  power: AP_0V8, AP_1V1, IO_1V8, GND (decouple: 22uF + 4x10uF + many 0.1uF)",
            "  memory: LPDDR_CK_P/N, LPDDR_CA0..CA3, LPDDR_DQ0..DQ3, LPDDR_DQS_P/N,",
            "    LPDDR_RESET_N, LPDDR_ZQ",
            "  storage: UFS_REFCLK_P/N, UFS_TX_P/N, UFS_RX_P/N, UFS_RESET_N",
            "  debug_boot: JTAG_TCK/TMS/TDI/TDO/TRST_N, BOOT_MODE0..2, SOC_RESET_N",
            "  display: DSI_CLK_P/N, DSI_D0_P/N, DSI_D1_P/N, DSI_D2_P/N, DSI_D3_P/N,",
            "    DISP_RESET_N, DISP_TE, DISP_BL_EN, DISP_BL_PWM",
            "  camera: CAM0_CSI_CLK_P/N, CAM0_CSI_D0..D3_P/N, CAM1_CSI_CLK_P/N,",
            "    CAM1_CSI_D0..D1_P/N",
            "  wireless: WIFI_PCIE_TX/RX_P/N, BT_UART_TX/RX/CTS_N/RTS_N,",
            "    CELL_USB2_DP/DN, CELL_PCIE_TX/RX_P/N",
            "U_LPDDR_UFS : memory_storage_combo (LPDDR + UFS stacked BGA)",
            "Decoupling: 12x 0.1uF + 4x 1uF + 2x 10uF clustered under BGA escape.",
            "Status: non_release_routing_demonstration.",
        ],
    )
    paths.append(p)

    # display_camera-demo
    p = SCH_DIR / "display_camera-demo.kicad_sch"
    write_sheet(
        p,
        "E1 Phone DEMO - Display, Touch, Cameras",
        "Routing demonstration only. Display 40-pin, rear cam 24-pin, front cam 22-pin connectors.",
        [
            "J_DISPLAY_TOUCH : Conn_01_x40 (display + touch combo FPC)",
            "  power: DISP_AVDD_5V5, DISP_AVEE_N5V5, IO_1V8, GND",
            "  display: DSI_CLK_P/N, DSI_D0..D3_P/N, DISP_RESET_N, DISP_TE, DISP_BL_EN, DISP_BL_PWM",
            "  touch: TOUCH_I2C_SCL, TOUCH_I2C_SDA, TOUCH_INT, TOUCH_RESET_N",
            "U_DISP_BIAS : display_bias_boost_inverter outputs DISP_AVDD_5V5 / DISP_AVEE_N5V5",
            "J_CAM0 : Conn_01_x24 (rear camera FPC)",
            "  power: CAM_AVDD_2V8, CAM_DVDD_1V2, CAM_AFVDD_2V8, IO_1V8, GND",
            "  data:  CAM0_CSI_CLK_P/N, CAM0_CSI_D0..D3_P/N",
            "  ctrl:  CAM0_I2C_SCL/SDA, CAM0_AF_I2C_SCL/SDA, CAM0_MCLK, CAM0_PWDN, CAM0_RESET_N",
            "J_CAM1 : Conn_01_x22 (front camera FPC)",
            "  power: CAM_AVDD_2V8, CAM_DVDD_1V2, IO_1V8, GND",
            "  data:  CAM1_CSI_CLK_P/N, CAM1_CSI_D0..D1_P/N",
            "  ctrl:  CAM1_I2C_SCL/SDA, CAM1_MCLK, CAM1_RESET_N",
            "Decoupling: 0.1uF per camera rail at connector + 1uF bulk; 10uF on display bias outputs.",
            "Status: non_release_routing_demonstration.",
        ],
    )
    paths.append(p)

    # radios-demo
    p = SCH_DIR / "radios-demo.kicad_sch"
    write_sheet(
        p,
        "E1 Phone DEMO - Radios (Cellular 5G-RedCap, Wi-Fi 6E, Bluetooth, GNSS)",
        "Routing demonstration only. Cellular M.2/B2B 80-pin host interface.",
        [
            "U_CELL : cellular_modem (Quectel 5G-RedCap module placeholder)",
            "  power: RF_VBAT, IO_1V8, AON_1V8, GND  ctrl: CELL_RESET_N, CELL_W_DISABLE_N, CELL_WAKE_AP, AP_WAKE_CELL",
            "  host:  CELL_USB2_DP/DN, CELL_PCIE_TX/RX_P/N, CELL_PCIE_REFCLK_P/N",
            "  RF:    CELL_RF_MAIN, CELL_RF_DIV, CELL_GNSS_RF (50R SE microstrip)",
            "U_WIFI_BT : wifi_bt_module (Murata Type 2EA placeholder)",
            "  power: IO_1V8, RF_VBAT, GND  ctrl: WIFI_EN, BT_EN",
            "  wifi:  WIFI_PCIE_TX_P/N, WIFI_PCIE_RX_P/N, WIFI_PCIE_REFCLK_P/N",
            "  bt:    BT_UART_TX, BT_UART_RX, BT_UART_CTS_N, BT_UART_RTS_N",
            "  sdio (alt): WIFI_SDIO_CLK, WIFI_SDIO_CMD, WIFI_SDIO_D0..D3",
            "  RF:    WIFI_BT_RF (50R SE)",
            "J_USIM : Conn_01_x06 (uSIM tray)  nets: USIM_VDD, USIM_CLK, USIM_IO, USIM_RST, USIM_DET, GND",
            "U_NFC : nfc_controller (I2C0_NFC bus, NFC_IRQ_N, NFC_EN, NFC_VEN)",
            "Pi-matching networks (L+C+L) populated on each antenna feed; placeholder values.",
            "Status: non_release_routing_demonstration.",
        ],
    )
    paths.append(p)

    # audio_buttons-demo
    p = SCH_DIR / "audio_buttons-demo.kicad_sch"
    write_sheet(
        p,
        "E1 Phone DEMO - Audio Codec, Speaker Amp, Buttons, Sensors",
        "Routing demonstration only.",
        [
            "U_CODEC : audio_codec (ALC5688 placeholder)",
            "  power: VDD_AUDIO_3V3, AON_1V8, GND  data: I2S_BCLK, I2S_LRCLK, I2S_DOUT, I2S_DIN",
            "  ctrl:  AUDIO_I2C_SCL, AUDIO_I2C_SDA, CODEC_INT",
            "U_SPK_AMP : speaker_amplifier (mono Class-D placeholder)",
            "  power: VDD_AMP_3V3, GND  audio: I2S_BCLK, I2S_LRCLK, I2S_DIN  ctrl: AMP_INT",
            "MIC0, MIC1 : digital_PDM (PDM_CLK, PDM_DAT)",
            "SW_POWER, SW_VOL_UP, SW_VOL_DOWN : side-key tact -> PWR_KEY_N, VOL_UP_N, VOL_DOWN_N",
            "U_IMU, U_BARO, U_MAG, U_ALS_PROX : SENSOR_I2C bus + INTx lines",
            "Haptic LRA driver -> HAPTIC_PWM via small bridge driver",
            "Decoupling: 10uF + 0.1uF per codec rail; 10uF + 2x 0.1uF at speaker amp.",
            "Status: non_release_routing_demonstration.",
        ],
    )
    paths.append(p)

    # split_interconnect-demo
    p = SCH_DIR / "split_interconnect-demo.kicad_sch"
    write_sheet(
        p,
        "E1 Phone DEMO - Split Top/Bottom Interconnect (B2B)",
        "Routing demonstration only. Hirose BM28 80-contact B2B placeholder.",
        [
            "J_B2B_TOP, J_B2B_BOT : Conn_01_x80 (Hirose BM28-style placeholders)",
            "  power buses: VBAT, SYS, AON_1V8, IO_1V8, RF_VBAT, GND (multi-pin)",
            "  shared high-speed: USB_DP/DN, DSI_CLK_P/N, CAM0/1_CSI_CLK_P/N",
            "  shared controls:   PWR_KEY_N, VOL_UP/DOWN_N, USB_CC1/2, WIFI_EN, BT_EN, CELL_RESET_N",
            "  shared low-speed:  I2C0_*, BT_UART_*, SENSOR_I2C_*, AUDIO_I2C_*",
            "Bypass: 2x 22uF bulk + 4x 1uF + many 0.1uF distributed across B2B power pins.",
            "Status: non_release_routing_demonstration.",
        ],
    )
    paths.append(p)

    # Root sheet - hierarchical references to the 6 sub-sheets
    root = SCH_DIR / "e1-phone-demo.kicad_sch"
    sub_sheets = [
        ("power_usb-demo.kicad_sch", "Power / USB / Battery (DEMO)", 30.0, 40.0),
        ("compute-demo.kicad_sch", "Compute / Memory / Storage (DEMO)", 130.0, 40.0),
        ("display_camera-demo.kicad_sch", "Display / Touch / Cameras (DEMO)", 230.0, 40.0),
        ("radios-demo.kicad_sch", "Cellular / Wi-Fi / BT / GNSS (DEMO)", 30.0, 130.0),
        ("audio_buttons-demo.kicad_sch", "Audio / Buttons / Sensors (DEMO)", 130.0, 130.0),
        ("split_interconnect-demo.kicad_sch", "Top/Bottom B2B Interconnect (DEMO)", 230.0, 130.0),
    ]
    root_body = SHEET_HEADER.format(
        uuid=det_uuid("e1-phone-demo.kicad_sch"),
        title="E1 Phone Mainboard DEMO - Root (non-release routing demonstration)",
        subtitle="Hierarchical references to 6 demo sub-sheets. Not ERC-clean. Not fabrication-bound.",
    )
    root_body += sheet_text_block(
        [
            "Required shared power nets: VBAT, VBUS, SYS, AON_1V8, IO_1V8, RF_VBAT, GND",
            "Required shared high-speed nets: USB_DP, USB_DN, DSI_CLK_P, DSI_D0_P,",
            "  CAM0_CSI_CLK_P, CAM1_CSI_CLK_P, CELL_USB2_DP, WIFI_PCIE_TX_P, UFS_TX_P, LPDDR_CK_P",
            "Required shared control nets: PWR_KEY_N, VOL_UP_N, VOL_DOWN_N, USB_CC1, USB_CC2,",
            "  WIFI_EN, BT_EN, CELL_RESET_N, USIM_DET, NFC_I2C_SCL, SENSOR_I2C_SCL",
            "Evidence class: non_release_routing_demonstration.",
            "Release blocker: replace demo sheets with reviewed supplier pinouts before fabrication.",
        ],
        y_start=30.0, dy=5.0, size=1.30,
    )
    for fname, label, sx, sy in sub_sheets:
        suuid = det_uuid(f"sheet:{fname}")
        root_body += (
            f'  (sheet (at {sx:.2f} {sy:.2f}) (size 80 60) (fields_autoplaced)\n'
            f'    (stroke (width 0.1524) (type solid))\n'
            f'    (fill (color 0 0 0 0.0000))\n'
            f'    (uuid "{suuid}")\n'
            f'    (property "Sheetname" "{label}" (at {sx:.2f} {sy-1.0:.2f} 0)\n'
            f'      (effects (font (size 1.2 1.2)) (justify left bottom))\n'
            f'    )\n'
            f'    (property "Sheetfile" "{fname}" (at {sx:.2f} {sy+61.0:.2f} 0)\n'
            f'      (effects (font (size 1.0 1.0)) (justify left top))\n'
            f'    )\n'
            f'  )\n'
        )
    root_body += SHEET_FOOTER
    root.write_text(root_body)
    paths.append(root)

    return paths


# ---------------------------------------------------------------------------
# PCB generation
# ---------------------------------------------------------------------------
#
# We reuse the layer stackup of the existing concept board, place rectangular
# placeholder footprints at the coordinates from component-envelope-fit-audit
# and mechanical-overlay, and hand-author a small set of straight L-shaped
# traces (USB diff pair, MIPI DSI clock pair, cellular RF feed) plus power
# net stitching.

# Net list. Order matters - index = KiCad net id. Net 0 is the no-connect net.
NETS = [
    "GND",
    "VBUS", "VBAT", "SYS", "+3V3", "+1V8", "+1V1", "+0V8", "AON_1V8",
    "RF_VBAT", "CAM_AVDD_2V8", "CAM_DVDD_1V2",
    "DISP_AVDD_5V5", "DISP_AVEE_N5V5", "VDD_AUDIO_3V3", "VDD_AMP_3V3",
    "USB_DP", "USB_DN", "USB_CC1", "USB_CC2", "SHIELD_GND",
    "DSI_CLK_P", "DSI_CLK_N", "DSI_D0_P", "DSI_D0_N",
    "CAM0_CSI_CLK_P", "CAM0_CSI_CLK_N",
    "CELL_RF_MAIN", "CELL_RF_DIV", "CELL_GNSS_RF",
    "WIFI_BT_RF",
    "PWR_KEY_N", "VOL_UP_N", "VOL_DOWN_N",
    "I2C0_SCL", "I2C0_SDA",
    "BT_UART_TX", "BT_UART_RX",
    "SDIO_CLK", "SDIO_CMD", "SDIO_D0", "SDIO_D1", "SDIO_D2", "SDIO_D3",
    "CELL_RESET_N", "WIFI_EN", "BT_EN",
]


def net_index(name: str) -> int:
    # 0 is unconnected; named nets start at 1
    return NETS.index(name) + 1


# Placeholder footprints: (refdes, x, y, w, h, pin_count, primary_nets[list], description)
# Coordinates from component-envelope-fit-audit.yaml + mechanical-overlay.yaml.
PLACEMENTS = [
    # ref,            cx,    cy,    w,    h,  pins, nets-for-some-pads,                   desc
    ("J_USB_C",       34.0, 129.0, 16.0, 6.0, 24,
        ["VBUS","USB_DP","USB_DN","USB_CC1","USB_CC2","SHIELD_GND","GND","VBUS"],
        "USB-C 24-pin receptacle (demo placeholder)"),
    ("U_USB_PD",      14.0, 122.0,  4.0, 4.0, 24,
        ["VBUS","USB_CC1","USB_CC2","+3V3","GND","I2C0_SCL","I2C0_SDA"],
        "USB PD controller (TPS65987 demo)"),
    ("U_CHARGER",     14.0, 110.0,  5.0, 5.0, 32,
        ["VBUS","SYS","VBAT","GND","I2C0_SCL","I2C0_SDA"],
        "Battery charger (MAX77860 demo)"),
    ("J_BATTERY",     32.0, 117.0, 14.0, 4.0,  6,
        ["VBAT","GND","VBAT","GND"],
        "Battery flex connector (demo)"),
    ("U_PMIC",        50.0, 122.0,  6.0, 6.0, 64,
        ["SYS","VBAT","GND","+3V3","+1V8","+1V1","+0V8","AON_1V8","RF_VBAT"],
        "PMIC (DA9063 demo)"),
    ("U_SOC",         32.0,  60.0, 14.0,14.0,400,
        ["+0V8","+1V1","+1V8","GND","USB_DP","USB_DN","DSI_CLK_P","DSI_CLK_N"],
        "Application processor BGA (E1 SoC demo)"),
    ("U_LPDDR_UFS",   32.0,  78.0, 11.0,10.0,200,
        ["+1V1","+1V8","GND"],
        "LPDDR + UFS combo stack (demo)"),
    ("J_DISPLAY_TOUCH", 52.0, 38.5, 18.0, 5.0,40,
        ["DISP_AVDD_5V5","DISP_AVEE_N5V5","+1V8","GND",
         "DSI_CLK_P","DSI_CLK_N","DSI_D0_P","DSI_D0_N"],
        "Display + Touch FPC (40-pin demo)"),
    ("J_CAM0",        54.0,  20.0, 14.0, 4.0, 24,
        ["CAM_AVDD_2V8","CAM_DVDD_1V2","+1V8","GND",
         "CAM0_CSI_CLK_P","CAM0_CSI_CLK_N","I2C0_SCL","I2C0_SDA"],
        "Rear camera FPC (24-pin demo)"),
    ("J_CAM1",        13.0,  10.0, 12.0, 4.0, 22,
        ["CAM_AVDD_2V8","CAM_DVDD_1V2","+1V8","GND"],
        "Front camera FPC (22-pin demo)"),
    ("U_CELL",        20.0,  95.0, 14.0,12.0, 80,
        ["RF_VBAT","+1V8","AON_1V8","GND","CELL_RESET_N",
         "CELL_RF_MAIN","CELL_RF_DIV","CELL_GNSS_RF"],
        "Cellular 5G-RedCap module M.2/B2B (demo)"),
    ("U_WIFI_BT",     10.0,  23.0, 12.5, 9.4, 60,
        ["RF_VBAT","+1V8","GND","WIFI_EN","BT_EN","WIFI_BT_RF",
         "BT_UART_TX","BT_UART_RX","SDIO_CLK","SDIO_CMD"],
        "Wi-Fi 6E + BT module (Murata 2EA demo)"),
    ("J_USIM",        60.0,  60.0,  6.0,12.0,  6,
        ["+1V8","GND"],
        "uSIM tray (demo)"),
    ("U_CODEC",       28.0, 102.0,  4.0, 4.0, 32,
        ["VDD_AUDIO_3V3","AON_1V8","GND","I2C0_SCL","I2C0_SDA"],
        "Audio codec (ALC5688 demo)"),
    ("U_SPK_AMP",     45.0, 110.0,  4.0, 4.0, 20,
        ["VDD_AMP_3V3","GND"],
        "Speaker amp (Class-D demo)"),
    ("SW_POWER_VOL",  24.0,  27.5, 12.0, 3.0,  5,
        ["PWR_KEY_N","VOL_UP_N","VOL_DOWN_N","AON_1V8","GND"],
        "Power+volume side-key flex (demo)"),
    ("U_HAPTIC",      57.0, 107.0,  6.0,12.0,  8,
        ["VBAT","GND"],
        "Haptic LRA driver (demo)"),
    ("J_B2B_TOP",     32.0,  45.0, 30.0, 3.0, 80,
        ["VBAT","SYS","AON_1V8","+1V8","RF_VBAT","GND"],
        "Top island B2B 80-pin (Hirose BM28 demo)"),
    ("J_B2B_BOT",     32.0, 115.0, 30.0, 3.0, 80,
        ["VBAT","SYS","AON_1V8","+1V8","RF_VBAT","GND"],
        "Bottom island B2B 80-pin (Hirose BM28 demo)"),
]

# Fiducials, test points, mounting holes
FIDUCIALS = [(3.0, 3.0), (61.0, 129.0)]
MOUNTING_HOLES = [(3.0, 3.0), (61.0, 3.0), (3.0, 129.0), (61.0, 129.0)]
TEST_POINTS = [
    ("TP_VBUS",   42.0, 124.0, "VBUS"),
    ("TP_SYS",    20.0, 110.0, "SYS"),
    ("TP_VBAT",   42.0, 117.0, "VBAT"),
    ("TP_3V3",    55.0, 122.0, "+3V3"),
    ("TP_1V8",    45.0, 122.0, "+1V8"),
    ("TP_1V1",    50.0, 117.0, "+1V1"),
    ("TP_0V8",    55.0, 117.0, "+0V8"),
    ("TP_AON",    45.0, 117.0, "AON_1V8"),
    ("TP_SCL",    40.0, 110.0, "I2C0_SCL"),
    ("TP_SDA",    40.0, 113.0, "I2C0_SDA"),
]

# Hand-authored L-shaped traces. Each entry: (net, layer, width_mm, [(x,y),...]).
DEMO_TRACES = [
    # USB-C diff pair from connector to USB-PD controller on F.Cu
    ("USB_DP", "F.Cu", 0.10, [(31.71, 131.55), (31.71, 124.0), (16.0, 124.0)]),
    ("USB_DN", "F.Cu", 0.10, [(32.86, 131.55), (32.86, 123.7), (16.0, 123.7)]),
    # USB-C VBUS from connector to charger (power, fatter)
    ("VBUS",   "F.Cu", 0.30, [(28.29, 131.55), (28.29, 120.0), (16.0, 120.0), (16.0, 112.5)]),
    # SYS from charger to PMIC
    ("SYS",    "F.Cu", 0.30, [(16.5, 110.0), (40.0, 110.0), (40.0, 122.0), (47.0, 122.0)]),
    # MIPI DSI clk pair from SOC to display FPC on In2.Sig
    ("DSI_CLK_P", "In2.Cu", 0.10, [(39.0, 60.0), (47.0, 60.0), (47.0, 38.0)]),
    ("DSI_CLK_N", "In2.Cu", 0.10, [(39.0, 60.5), (46.7, 60.5), (46.7, 38.0)]),
    # Cellular RF main feed - 50R microstrip to top antenna keepout edge
    ("CELL_RF_MAIN", "F.Cu", 0.20, [(20.0, 89.0), (20.0, 12.0), (3.0, 12.0)]),
    # Wi-Fi/BT RF feed to side-antenna pi-network area
    ("WIFI_BT_RF",   "F.Cu", 0.20, [(16.25, 23.0), (41.0, 35.0)]),
    # I2C0 SCL backbone
    ("I2C0_SCL", "In4.Cu", 0.15, [(40.0, 110.0), (40.0, 102.0), (28.0, 102.0)]),
    ("I2C0_SDA", "In4.Cu", 0.15, [(40.0, 113.0), (40.0, 104.0), (28.0, 104.0)]),
    # PWR_KEY backbone
    ("PWR_KEY_N", "F.Cu", 0.15, [(20.0, 27.5), (20.0, 60.0)]),
    # Battery VBAT trunk from battery connector to PMIC
    ("VBAT", "F.Cu", 0.40, [(32.0, 117.0), (50.0, 117.0), (50.0, 122.0)]),
    # +1V8 distribution to display FPC
    ("+1V8", "In3.Cu", 0.25, [(50.0, 122.0), (50.0, 40.0)]),
]


PCB_HEADER = '''(kicad_pcb (version 20240108) (generator "eliza-phone-demo-routing")
  (general
    (thickness 0.8)
  )
  (paper "A4")
  (title_block
    (title "E1 Phone Mainboard DEMO - non-release routing demonstration")
    (date "2026-05-20")
    (rev "concept-routing-demo-r0")
    (company "Eliza phone board planning")
    (comment 1 "Evidence class: non_release_routing_demonstration")
    (comment 2 "NOT for tape-out, fabrication, or factory assembly.")
    (comment 3 "Placeholder footprints; pinouts not supplier-locked.")
  )
  (layers
    (0 "F.Cu" signal)
    (1 "In1.Cu" power "In1.GND")
    (2 "In2.Cu" signal "In2.Cu")
    (3 "In3.Cu" power "In3.Cu")
    (4 "In4.Cu" signal "In4.Cu")
    (5 "In5.Cu" signal "In5.Sig")
    (6 "In6.Cu" power "In6.PWR")
    (7 "In7.Cu" signal "In7.Sig")
    (8 "In8.Cu" power "In8.GND")
    (31 "B.Cu" signal)
    (32 "B.Adhes" user)
    (33 "F.Adhes" user)
    (34 "B.Paste" user)
    (35 "F.Paste" user)
    (36 "B.SilkS" user "B.Silkscreen")
    (37 "F.SilkS" user "F.Silkscreen")
    (38 "B.Mask" user)
    (39 "F.Mask" user)
    (40 "Dwgs.User" user)
    (41 "Cmts.User" user)
    (42 "Eco1.User" user)
    (43 "Eco2.User" user)
    (44 "Edge.Cuts" user)
    (45 "Margin" user)
    (46 "B.CrtYd" user)
    (47 "F.CrtYd" user)
    (48 "B.Fab" user)
    (49 "F.Fab" user)
  )
'''

PCB_SETUP = '''  (setup
    (pad_to_mask_clearance 0)
    (allow_soldermask_bridges_in_footprints no)
    (stackup
      (layer "F.SilkS" (type "Top Silk Screen"))
      (layer "F.Paste" (type "Top Solder Paste"))
      (layer "F.Mask" (type "Top Solder Mask") (thickness 0.01))
      (layer "F.Cu" (type "copper") (thickness 0.018))
      (layer "dielectric 1" (type "prepreg") (thickness 0.06) (material "FR4"))
      (layer "In1.Cu" (type "copper") (thickness 0.018))
      (layer "dielectric 2" (type "core") (thickness 0.09) (material "FR4"))
      (layer "In2.Cu" (type "copper") (thickness 0.018))
      (layer "dielectric 3" (type "prepreg") (thickness 0.08) (material "FR4"))
      (layer "In3.Cu" (type "copper") (thickness 0.018))
      (layer "dielectric 4" (type "core") (thickness 0.12) (material "FR4"))
      (layer "In4.Cu" (type "copper") (thickness 0.018))
      (layer "dielectric 5" (type "core") (thickness 0.12) (material "FR4"))
      (layer "In5.Cu" (type "copper") (thickness 0.018))
      (layer "dielectric 6" (type "prepreg") (thickness 0.08) (material "FR4"))
      (layer "In6.Cu" (type "copper") (thickness 0.018))
      (layer "dielectric 7" (type "core") (thickness 0.09) (material "FR4"))
      (layer "In7.Cu" (type "copper") (thickness 0.018))
      (layer "dielectric 8" (type "prepreg") (thickness 0.06) (material "FR4"))
      (layer "In8.Cu" (type "copper") (thickness 0.018))
      (layer "dielectric 9" (type "prepreg") (thickness 0.06) (material "FR4"))
      (layer "B.Cu" (type "copper") (thickness 0.018))
      (layer "B.Mask" (type "Bottom Solder Mask") (thickness 0.01))
      (layer "B.Paste" (type "Bottom Solder Paste"))
      (layer "B.SilkS" (type "Bottom Silk Screen"))
    )
  )
  (net_class "default" "demo default netclass"
    (clearance 0.15)
    (trace_width 0.15)
    (via_dia 0.45)
    (via_drill 0.2)
    (uvia_dia 0.3)
    (uvia_drill 0.15)
    (add_net "")
  )
'''


def edge_cuts() -> str:
    # Outline 64x132 mm. Rounded corners with 0.5 mm radius approximated as gr_lines + gr_arcs.
    r = 0.5
    L = []
    L.append(f'  (gr_line (start {r} 0) (end {64.0-r} 0) (stroke (width 0.15) (type solid)) (layer "Edge.Cuts"))')
    L.append(f'  (gr_arc (start {64.0-r} 0) (mid {64.0-r+r*0.293} {r-r*0.707}) (end 64.0 {r}) (stroke (width 0.15) (type solid)) (layer "Edge.Cuts"))')
    L.append(f'  (gr_line (start 64.0 {r}) (end 64.0 {132.0-r}) (stroke (width 0.15) (type solid)) (layer "Edge.Cuts"))')
    L.append(f'  (gr_arc (start 64.0 {132.0-r}) (mid {64.0-r+r*0.293} {132.0-r+r*0.707}) (end {64.0-r} 132.0) (stroke (width 0.15) (type solid)) (layer "Edge.Cuts"))')
    L.append(f'  (gr_line (start {64.0-r} 132.0) (end {r} 132.0) (stroke (width 0.15) (type solid)) (layer "Edge.Cuts"))')
    L.append(f'  (gr_arc (start {r} 132.0) (mid {r-r*0.293} {132.0-r+r*0.707}) (end 0 {132.0-r}) (stroke (width 0.15) (type solid)) (layer "Edge.Cuts"))')
    L.append(f'  (gr_line (start 0 {132.0-r}) (end 0 {r}) (stroke (width 0.15) (type solid)) (layer "Edge.Cuts"))')
    L.append(f'  (gr_arc (start 0 {r}) (mid {r-r*0.293} {r-r*0.707}) (end {r} 0) (stroke (width 0.15) (type solid)) (layer "Edge.Cuts"))')
    L.append('  (gr_text "E1-PHONE-MAINBOARD-DEMO  non_release_routing_demonstration" (at 32 1.8 0) (layer "F.SilkS") (effects (font (size 1.0 1.0) (thickness 0.15))))')
    return "\n".join(L) + "\n"


def render_footprint(ref: str, cx: float, cy: float, w: float, h: float, pins: int,
                     pin_nets: list[str], desc: str) -> str:
    fp_uuid = det_uuid(f"fp:{ref}")
    half_w, half_h = w / 2.0, h / 2.0
    s = []
    s.append(f'  (footprint "E1PhoneDemo:{ref}" (layer "F.Cu")')
    s.append(f'    (tstamp "{fp_uuid}")')
    s.append(f'    (at {cx:.3f} {cy:.3f})')
    s.append(f'    (descr "DEMO placeholder footprint - non_release_routing_demonstration - {desc}")')
    s.append('    (tags "E1_PHONE_DEMO NON_RELEASE_ROUTING_DEMONSTRATION")')
    s.append('    (attr smd exclude_from_pos_files exclude_from_bom)')
    s.append(f'    (fp_text reference "{ref}" (at 0 {-half_h-1.2:.3f} 0) (layer "F.SilkS") (tstamp "{det_uuid(f"ref:{ref}")}")')
    s.append('      (effects (font (size 0.8 0.8) (thickness 0.12)))')
    s.append('    )')
    s.append(f'    (fp_text value "DEMO" (at 0 {half_h+1.2:.3f} 0) (layer "F.Fab") (tstamp "{det_uuid(f"val:{ref}")}")')
    s.append('      (effects (font (size 0.6 0.6) (thickness 0.1)))')
    s.append('    )')
    s.append(f'    (fp_rect (start {-half_w:.3f} {-half_h:.3f}) (end {half_w:.3f} {half_h:.3f}) (stroke (width 0.1) (type solid)) (fill none) (layer "F.Fab") (tstamp "{det_uuid(f"fab:{ref}")}"))')
    s.append(f'    (fp_rect (start {-half_w-0.25:.3f} {-half_h-0.25:.3f}) (end {half_w+0.25:.3f} {half_h+0.25:.3f}) (stroke (width 0.05) (type dash)) (fill none) (layer "F.CrtYd") (tstamp "{det_uuid(f"crt:{ref}")}"))')
    s.append(f'    (fp_text user "NON-RELEASE-DEMO" (at 0 0 0) (layer "F.SilkS") (tstamp "{det_uuid(f"banner:{ref}")}")')
    s.append('      (effects (font (size 0.6 0.6) (thickness 0.1)))')
    s.append('    )')
    # Lay pads around the perimeter
    pad_size = 0.5
    if pins <= 4:
        positions = [(-half_w*0.6, half_h*0.6), (half_w*0.6, half_h*0.6),
                     (-half_w*0.6, -half_h*0.6), (half_w*0.6, -half_h*0.6)][:pins]
    else:
        # Distribute around perimeter on two long sides
        per_side = pins // 2
        pitch_x = (w - 1.0) / max(per_side - 1, 1)
        positions = []
        for i in range(per_side):
            positions.append((-half_w + 0.5 + i * pitch_x, half_h - 0.3))
        for i in range(pins - per_side):
            positions.append((-half_w + 0.5 + i * pitch_x, -half_h + 0.3))
    for i, (px, py) in enumerate(positions, start=1):
        net_name = pin_nets[(i-1) % len(pin_nets)] if pin_nets else "GND"
        try:
            nidx = net_index(net_name)
        except ValueError:
            nidx = net_index("GND")
            net_name = "GND"
        s.append(
            f'    (pad "{i}" smd roundrect (at {px:.3f} {py:.3f}) (size {pad_size:.2f} 0.75) '
            f'(layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.2) '
            f'(net {nidx} "{net_name}") (tstamp "{det_uuid(f"pad:{ref}:{i}")}"))'
        )
    s.append('  )')
    return "\n".join(s) + "\n"


def render_test_point(name: str, x: float, y: float, net: str) -> str:
    nidx = net_index(net)
    fp_uuid = det_uuid(f"tp:{name}")
    return (
        f'  (footprint "E1PhoneDemo:{name}" (layer "F.Cu")\n'
        f'    (tstamp "{fp_uuid}")\n'
        f'    (at {x:.3f} {y:.3f})\n'
        f'    (descr "DEMO test point - non_release_routing_demonstration")\n'
        f'    (attr smd exclude_from_pos_files exclude_from_bom)\n'
        f'    (fp_text reference "{name}" (at 0 -1.4 0) (layer "F.SilkS") (tstamp "{det_uuid(f"tpr:{name}")}")\n'
        f'      (effects (font (size 0.55 0.55) (thickness 0.1)))\n'
        f'    )\n'
        f'    (fp_text value "{net}" (at 0 1.4 0) (layer "F.Fab") (tstamp "{det_uuid(f"tpv:{name}")}")\n'
        f'      (effects (font (size 0.5 0.5) (thickness 0.08)))\n'
        f'    )\n'
        f'    (pad "1" smd circle (at 0 0) (size 1.0 1.0) (layers "F.Cu" "F.Paste" "F.Mask") '
        f'(net {nidx} "{net}") (tstamp "{det_uuid(f"tpp:{name}")}"))\n'
        f'  )\n'
    )


def render_mounting_hole(idx: int, x: float, y: float) -> str:
    fp_uuid = det_uuid(f"mh:{idx}")
    return (
        f'  (footprint "E1PhoneDemo:MH{idx}" (layer "F.Cu")\n'
        f'    (tstamp "{fp_uuid}")\n'
        f'    (at {x:.3f} {y:.3f})\n'
        f'    (descr "DEMO mounting hole - non_release_routing_demonstration")\n'
        f'    (attr exclude_from_pos_files exclude_from_bom)\n'
        f'    (pad "" np_thru_hole circle (at 0 0) (size 2.0 2.0) (drill 1.2) (layers "*.Cu" "*.Mask") (tstamp "{det_uuid(f"mhp:{idx}")}"))\n'
        f'  )\n'
    )


def render_fiducial(idx: int, x: float, y: float) -> str:
    fp_uuid = det_uuid(f"fid:{idx}")
    return (
        f'  (footprint "E1PhoneDemo:FID{idx}" (layer "F.Cu")\n'
        f'    (tstamp "{fp_uuid}")\n'
        f'    (at {x:.3f} {y:.3f})\n'
        f'    (descr "DEMO fiducial - non_release_routing_demonstration")\n'
        f'    (attr smd exclude_from_pos_files exclude_from_bom)\n'
        f'    (pad "1" smd circle (at 0 0) (size 1.0 1.0) (layers "F.Cu" "F.Mask") (tstamp "{det_uuid(f"fidp:{idx}")}"))\n'
        f'  )\n'
    )


def render_segment(net: str, layer: str, width: float, p0: tuple[float,float], p1: tuple[float,float], key: str) -> str:
    nidx = net_index(net)
    su = det_uuid(f"seg:{key}")
    return (
        f'  (segment (start {p0[0]:.3f} {p0[1]:.3f}) (end {p1[0]:.3f} {p1[1]:.3f}) '
        f'(width {width:.3f}) (layer "{layer}") (net {nidx}) (tstamp "{su}"))\n'
    )


def gen_pcb() -> Path:
    PCB_DIR.mkdir(parents=True, exist_ok=True)
    pcb_path = PCB_DIR / "e1-phone-mainboard-demo.kicad_pcb"

    parts: list[str] = [PCB_HEADER]

    # Net declarations
    parts.append('  (net 0 "")\n')
    for i, n in enumerate(NETS, start=1):
        parts.append(f'  (net {i} "{n}")\n')

    parts.append(PCB_SETUP)
    parts.append(edge_cuts())

    # Mechanical overlay text
    parts.append('  (gr_text "DEMO ROUTING - non_release_routing_demonstration - NOT FAB" '
                 '(at 32 130.2 0) (layer "F.SilkS") (effects (font (size 0.9 0.9) (thickness 0.12))))\n')

    # Footprints
    for (ref, cx, cy, w, h, pins, pin_nets, desc) in PLACEMENTS:
        parts.append(render_footprint(ref, cx, cy, w, h, pins, pin_nets, desc))

    for i, (x, y) in enumerate(MOUNTING_HOLES, start=1):
        parts.append(render_mounting_hole(i, x, y))

    for i, (x, y) in enumerate(FIDUCIALS, start=1):
        parts.append(render_fiducial(i, x, y))

    for (name, x, y, net) in TEST_POINTS:
        parts.append(render_test_point(name, x, y, net))

    # Hand-routed traces (as multiple straight segments per polyline)
    for ti, (net, layer, width, pts) in enumerate(DEMO_TRACES):
        for si in range(len(pts) - 1):
            parts.append(render_segment(net, layer, width, pts[si], pts[si+1], f"{net}:{ti}:{si}"))

    # Power-plane via stitching: place GND vias at a coarse grid skipping
    # battery_window keepout area.
    via_uuid_base = 0
    for ix in range(2, 64, 8):
        for iy in range(2, 132, 8):
            # skip battery window (y in 29.5..116.5)
            if 29.5 <= iy <= 116.5:
                continue
            su = det_uuid(f"via:{ix}:{iy}")
            parts.append(
                f'  (via (at {ix} {iy}) (size 0.45) (drill 0.2) (layers "F.Cu" "B.Cu") '
                f'(net {net_index("GND")}) (tstamp "{su}"))\n'
            )
            via_uuid_base += 1

    parts.append(")\n")

    pcb_path.write_text("".join(parts))
    return pcb_path


# ---------------------------------------------------------------------------
# Fab export via kicad-cli
# ---------------------------------------------------------------------------


def run_cli(args: list[str]) -> tuple[int, str]:
    try:
        out = subprocess.check_output(args, stderr=subprocess.STDOUT, text=True)
        return 0, out
    except subprocess.CalledProcessError as exc:
        return exc.returncode, exc.output


def gen_fab(pcb_path: Path) -> dict:
    FAB_DIR.mkdir(parents=True, exist_ok=True)
    results: dict = {}

    # Gerbers (all signal + tech layers including inner planes)
    layers = ",".join([
        "F.Cu", "In1.Cu", "In2.Cu", "In3.Cu", "In4.Cu",
        "In5.Cu", "In6.Cu", "In7.Cu", "In8.Cu", "B.Cu",
        "F.Mask", "B.Mask", "F.Paste", "B.Paste",
        "F.SilkS", "B.SilkS", "Edge.Cuts",
    ])
    code, out = run_cli([
        str(KICAD_CLI), "pcb", "export", "gerbers",
        "--output", str(FAB_DIR) + "/",
        "--layers", layers,
        "--no-protel-ext",
        str(pcb_path),
    ])
    results["gerbers"] = {"rc": code, "tail": out.splitlines()[-3:]}

    # Drill
    code, out = run_cli([
        str(KICAD_CLI), "pcb", "export", "drill",
        "--output", str(FAB_DIR) + "/",
        "--format", "excellon",
        "--excellon-separate-th",
        str(pcb_path),
    ])
    results["drill"] = {"rc": code, "tail": out.splitlines()[-3:]}

    # STEP
    step_out = FAB_DIR / "e1-phone-mainboard-demo.step"
    code, out = run_cli([
        str(KICAD_CLI), "pcb", "export", "step",
        "--force", "--subst-models", "--no-unspecified", "--no-dnp",
        "-o", str(step_out),
        str(pcb_path),
    ])
    results["step"] = {"rc": code, "tail": out.splitlines()[-3:], "path": str(step_out)}

    # Pos
    pos_out = FAB_DIR / "e1-phone-mainboard-demo-pos.csv"
    code, out = run_cli([
        str(KICAD_CLI), "pcb", "export", "pos",
        "--output", str(pos_out),
        "--format", "csv", "--units", "mm", "--side", "both",
        str(pcb_path),
    ])
    results["pos"] = {"rc": code, "tail": out.splitlines()[-3:]}

    # BOM (from the demo root schematic)
    bom_out = FAB_DIR / "e1-phone-mainboard-demo-bom.csv"
    root_sch = SCH_DIR / "e1-phone-demo.kicad_sch"
    code, out = run_cli([
        str(KICAD_CLI), "sch", "export", "bom",
        "--output", str(bom_out),
        str(root_sch),
    ])
    results["bom"] = {"rc": code, "tail": out.splitlines()[-3:]}

    # Mechanical out copy
    if step_out.is_file():
        MECH_OUT.mkdir(parents=True, exist_ok=True)
        shutil.copy2(step_out, MECH_OUT / step_out.name)

    return results


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------


def write_manifest(pcb_path: Path, sch_paths: list[Path], fab_results: dict) -> Path:
    out = BOARD_DIR / "pcb-implementation-audit-demo.yaml"
    fab_files = sorted(p.name for p in FAB_DIR.glob("*"))
    body = []
    body.append("schema: eliza.e1_phone_pcb_implementation_audit_demo.v1")
    body.append(f"evidence_class: {EVIDENCE}")
    body.append("status: blocked_concept_routing_demo_not_supplier_pinout_locked")
    body.append("date: '2026-05-20'")
    body.append("claim_boundary: >")
    body.append("  This manifest indexes a non-release routing demonstration set. It is NOT")
    body.append("  a tape-out package, NOT a fabrication release, NOT a factory-assembly")
    body.append("  package, and NOT supplier-pinout-locked. Generic Conn_01_xNN symbols and")
    body.append("  placeholder land patterns stand in for real supplier components. All gates")
    body.append("  in routed-release-plan.yaml, manufacturing-closure.yaml,")
    body.append("  production-readiness.yaml, and kicad-mechanical-handoff.json remain")
    body.append("  fail-closed.")
    body.append("not_release_for:")
    body.append("  - tape_out")
    body.append("  - fabrication")
    body.append("  - factory_assembly")
    body.append("  - enclosure_release")
    body.append("  - supplier_pinout_lock")
    body.append("concept_routing_demo:")
    body.append("  schematic_root: board/kicad/e1-phone/schematic/e1-phone-demo.kicad_sch")
    body.append("  schematic_sheets:")
    for p in sch_paths:
        if p.name == "e1-phone-demo.kicad_sch":
            continue
        body.append(f"    - board/kicad/e1-phone/schematic/{p.name}")
    body.append(f"  pcb: board/kicad/e1-phone/pcb/{pcb_path.name}")
    body.append("  fab_demo_dir: board/kicad/e1-phone/pcb/fab-demo")
    body.append("  fab_demo_files:")
    for f in fab_files:
        body.append(f"    - {f}")
    body.append("  step_secondary_copy: mechanical/e1-phone/out/e1-phone-mainboard-demo.step")
    body.append("export_status:")
    for k, v in fab_results.items():
        body.append(f"  {k}: {'ok' if v['rc'] == 0 else 'failed'}")
    body.append("regenerated_by: scripts/generate_e1_phone_routed_mainboard_demo.py")
    out.write_text("\n".join(body) + "\n")
    return out


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main() -> int:
    if not KICAD_CLI.is_file():
        print(f"FAIL: kicad-cli not found at {KICAD_CLI}", file=sys.stderr)
        return 1

    sch_paths = gen_schematics()
    pcb_path = gen_pcb()
    fab_results = gen_fab(pcb_path)
    manifest = write_manifest(pcb_path, sch_paths, fab_results)

    print(f"schematics: {len(sch_paths)} sheets written under {SCH_DIR}")
    for p in sch_paths:
        print(f"  - {p}")
    print(f"pcb: {pcb_path}")
    print(f"fab-demo dir: {FAB_DIR}")
    for k, v in fab_results.items():
        print(f"  {k}: rc={v['rc']}")
    print(f"manifest: {manifest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
