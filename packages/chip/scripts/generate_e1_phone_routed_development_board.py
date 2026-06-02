#!/usr/bin/env python3
"""Generate a non-release routed-development KiCad board snapshot.

This creates visible copper segments for the major E1 phone route classes without
promoting the concept PCB to a fabrication release. The output is intentionally
separate from e1-phone-mainboard-concept.kicad_pcb and production/step.
"""

from __future__ import annotations

import hashlib
import math
import re
import shutil
import uuid
from pathlib import Path
from typing import cast, Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
CONCEPT = ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb"
REAL_FOOTPRINT_BOARD = (
    ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-real-footprint-development.kicad_pcb"
)
OUT = ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-routed-development.kicad_pcb"
DEV_STEP = ROOT / "board/kicad/e1-phone/pcb/fab-demo/e1-phone-mainboard-routed-development.step"
CAD_STEP = ROOT / "mechanical/e1-phone/out/main_pcb.step"
DETAILED_DEV_STEP = (
    ROOT / "board/kicad/e1-phone/pcb/fab-demo/e1-phone-mainboard-real-footprint-development.step"
)
DETAILED_DEV_STEP_INTAKE = (
    ROOT / "board/kicad/e1-phone/real-footprint-development-step-intake-2026-05-22.yaml"
)
AUDIT = ROOT / "board/kicad/e1-phone/routed-development-board-intake-2026-05-22.yaml"


def stable_uuid(*parts: object) -> str:
    text = "/".join(str(part) for part in parts)
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"eliza-e1-phone-routed-dev/{text}"))


def net_ids(text: str) -> dict[str, int]:
    return {name: int(num) for num, name in re.findall(r'\(net\s+(\d+)\s+"([^"]+)"\)', text)}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


ROUTES = [
    ("USB_VBUS", "VBUS", "F.Cu", 0.35, [(32.0, 124.0), (37.0, 121.8), (42.0, 121.8)]),
    ("USB_CC1", "USB_CC1", "F.Cu", 0.15, [(31.2, 124.0), (31.45, 121.8), (23.0, 118.4)]),
    ("USB_CC2", "USB_CC2", "F.Cu", 0.15, [(32.8, 124.0), (32.0, 121.8), (30.2, 118.4)]),
    ("USB_DP", "USB_DP", "F.Cu", 0.16, [(30.5, 124.0), (26.45, 121.8), (44.6, 118.4)]),
    ("USB_DN", "USB_DN", "F.Cu", 0.16, [(29.8, 124.0), (27.0, 121.8), (37.4, 118.4)]),
    ("BATTERY_VBAT", "VBAT", "F.Cu", 0.45, [(24.0, 118.0), (39.0, 118.0), (43.0, 112.0)]),
    ("BATTERY_SYS", "SYS", "F.Cu", 0.45, [(31.0, 118.0), (42.0, 116.0), (45.0, 112.0)]),
    ("AON_WAKE", "PWR_KEY_N", "F.Cu", 0.12, [(58.0, 9.0), (60.0, 35.0), (58.0, 55.0)]),
    ("VOL_UP", "VOL_UP_N", "F.Cu", 0.12, [(59.0, 12.0), (61.0, 35.0), (59.0, 58.0)]),
    ("VOL_DOWN", "VOL_DOWN_N", "F.Cu", 0.12, [(60.0, 15.0), (62.0, 35.0), (60.0, 61.0)]),
    ("DISPLAY_DSI0_P", "DSI_D0_P", "F.Cu", 0.10, [(47.0, 8.0), (45.0, 16.0), (42.0, 24.0)]),
    ("DISPLAY_DSI0_N", "DSI_D0_N", "F.Cu", 0.10, [(47.5, 8.0), (45.5, 16.0), (42.5, 24.0)]),
    ("DISPLAY_DSI1_P", "DSI_D1_P", "F.Cu", 0.10, [(49.0, 8.0), (48.0, 16.0), (45.0, 24.0)]),
    ("DISPLAY_DSI1_N", "DSI_D1_N", "F.Cu", 0.10, [(49.5, 8.0), (48.5, 16.0), (45.5, 24.0)]),
    ("DISPLAY_DSI_CLK_P", "DSI_CLK_P", "F.Cu", 0.10, [(50.0, 8.0), (50.0, 15.5), (47.0, 23.5)]),
    ("DISPLAY_DSI_CLK_N", "DSI_CLK_N", "F.Cu", 0.10, [(50.5, 8.0), (50.5, 15.5), (47.5, 23.5)]),
    ("DISPLAY_DSI2_P", "DSI_D2_P", "F.Cu", 0.10, [(51.0, 8.0), (52.0, 16.0), (49.0, 24.0)]),
    ("DISPLAY_DSI2_N", "DSI_D2_N", "F.Cu", 0.10, [(51.5, 8.0), (52.5, 16.0), (49.5, 24.0)]),
    ("DISPLAY_DSI3_P", "DSI_D3_P", "F.Cu", 0.10, [(52.0, 8.0), (54.0, 16.0), (51.0, 24.0)]),
    ("DISPLAY_DSI3_N", "DSI_D3_N", "F.Cu", 0.10, [(52.5, 8.0), (54.5, 16.0), (51.5, 24.0)]),
    ("DISPLAY_RESET", "DISP_RESET_N", "F.Cu", 0.12, [(53.0, 8.0), (53.0, 20.5), (43.6, 26.2)]),
    ("DISPLAY_TE", "DISP_TE", "F.Cu", 0.12, [(53.5, 8.0), (54.0, 20.5), (44.4, 26.2)]),
    ("TOUCH_I2C_SCL", "TOUCH_I2C_SCL", "F.Cu", 0.12, [(54.0, 8.0), (55.0, 20.5), (45.2, 26.2)]),
    ("TOUCH_I2C_SDA", "TOUCH_I2C_SDA", "F.Cu", 0.12, [(54.5, 8.0), (56.0, 20.5), (46.0, 26.2)]),
    ("CSI0_P", "CAM0_CSI_D0_P", "F.Cu", 0.10, [(30.0, 8.0), (29.0, 14.0), (28.0, 22.0)]),
    ("CSI0_N", "CAM0_CSI_D0_N", "F.Cu", 0.10, [(30.5, 8.0), (29.5, 14.0), (28.5, 22.0)]),
    ("CSI0_CLK_P", "CAM0_CSI_CLK_P", "F.Cu", 0.10, [(31.0, 8.0), (32.0, 14.0), (43.2, 10.8)]),
    ("CSI0_CLK_N", "CAM0_CSI_CLK_N", "F.Cu", 0.10, [(31.5, 8.0), (32.5, 14.0), (43.7, 10.8)]),
    ("CSI0_D1_P", "CAM0_CSI_D1_P", "F.Cu", 0.10, [(32.0, 8.0), (34.0, 14.0), (44.2, 10.8)]),
    ("CSI0_D1_N", "CAM0_CSI_D1_N", "F.Cu", 0.10, [(32.5, 8.0), (34.5, 14.0), (44.7, 10.8)]),
    ("CSI0_D2_P", "CAM0_CSI_D2_P", "F.Cu", 0.10, [(33.0, 8.0), (36.0, 14.0), (45.2, 10.8)]),
    ("CSI0_D2_N", "CAM0_CSI_D2_N", "F.Cu", 0.10, [(33.5, 8.0), (36.5, 14.0), (45.7, 10.8)]),
    ("CSI0_D3_P", "CAM0_CSI_D3_P", "F.Cu", 0.10, [(34.0, 8.0), (38.0, 14.0), (46.2, 10.8)]),
    ("CSI0_D3_N", "CAM0_CSI_D3_N", "F.Cu", 0.10, [(34.5, 8.0), (38.5, 14.0), (46.7, 10.8)]),
    ("CSI1_CLK_P", "CAM1_CSI_CLK_P", "F.Cu", 0.10, [(35.0, 8.0), (38.0, 17.0), (43.2, 14.8)]),
    ("CSI1_CLK_N", "CAM1_CSI_CLK_N", "F.Cu", 0.10, [(35.5, 8.0), (38.5, 17.0), (43.7, 14.8)]),
    ("CSI1_D0_P", "CAM1_CSI_D0_P", "F.Cu", 0.10, [(36.0, 8.0), (40.0, 17.0), (44.2, 14.8)]),
    ("CSI1_D0_N", "CAM1_CSI_D0_N", "F.Cu", 0.10, [(36.5, 8.0), (40.5, 17.0), (44.7, 14.8)]),
    ("CSI1_D1_P", "CAM1_CSI_D1_P", "F.Cu", 0.10, [(37.0, 8.0), (42.0, 17.0), (45.2, 14.8)]),
    ("CSI1_D1_N", "CAM1_CSI_D1_N", "F.Cu", 0.10, [(37.5, 8.0), (42.5, 17.0), (45.7, 14.8)]),
    ("CAM0_MCLK", "CAM0_MCLK", "F.Cu", 0.12, [(38.0, 8.0), (43.2, 18.7), (43.2, 22.6)]),
    ("CAM1_MCLK", "CAM1_MCLK", "F.Cu", 0.12, [(38.5, 8.0), (44.2, 18.7), (44.2, 22.6)]),
    ("CELL_MAIN_RF", "CELL_RF_MAIN", "F.Cu", 0.22, [(7.0, 6.7), (12.2, 6.7), (17.0, 4.2)]),
    ("CELL_DIV_RF", "CELL_RF_DIV", "F.Cu", 0.22, [(13.2, 6.7), (18.4, 6.7), (22.0, 4.2)]),
    ("GNSS_RF", "CELL_GNSS_RF", "F.Cu", 0.18, [(55.0, 6.7), (59.0, 6.7), (61.0, 4.2)]),
    ("CELL_USB2_DP", "CELL_USB2_DP", "F.Cu", 0.16, [(12.0, 12.0), (18.0, 13.0), (30.0, 10.0)]),
    ("CELL_USB2_DN", "CELL_USB2_DN", "F.Cu", 0.16, [(12.5, 12.5), (18.5, 13.5), (30.5, 10.5)]),
    ("CELL_PCIE_TX_P", "CELL_PCIE_TX_P", "F.Cu", 0.10, [(13.0, 13.0), (20.0, 15.0), (31.0, 11.0)]),
    ("CELL_PCIE_TX_N", "CELL_PCIE_TX_N", "F.Cu", 0.10, [(13.5, 13.5), (20.5, 15.5), (31.5, 11.5)]),
    ("CELL_PCIE_RX_P", "CELL_PCIE_RX_P", "F.Cu", 0.10, [(14.0, 14.0), (22.0, 17.0), (32.0, 12.0)]),
    ("CELL_PCIE_RX_N", "CELL_PCIE_RX_N", "F.Cu", 0.10, [(14.5, 14.5), (22.5, 17.5), (32.5, 12.5)]),
    ("CELL_RESET", "CELL_RESET_N", "F.Cu", 0.12, [(15.0, 15.0), (25.0, 18.5), (38.0, 29.0)]),
    ("CELL_DISABLE", "CELL_W_DISABLE_N", "F.Cu", 0.12, [(15.5, 15.5), (25.5, 19.5), (39.0, 29.0)]),
    ("WIFI_RF0", "WIFI_BT_RF0", "F.Cu", 0.18, [(10.0, 21.5), (10.0, 25.5), (18.0, 27.0)]),
    ("WIFI_RF1", "WIFI_BT_RF1", "F.Cu", 0.18, [(15.0, 21.5), (15.0, 25.5), (23.0, 27.0)]),
    ("WIFI_PCIE_TX_P", "WIFI_PCIE_TX_P", "F.Cu", 0.10, [(17.0, 23.0), (22.0, 20.0), (30.0, 12.0)]),
    ("WIFI_PCIE_TX_N", "WIFI_PCIE_TX_N", "F.Cu", 0.10, [(17.5, 23.5), (22.5, 20.5), (30.5, 12.5)]),
    ("WIFI_PCIE_RX_P", "WIFI_PCIE_RX_P", "F.Cu", 0.10, [(18.0, 24.0), (24.0, 22.0), (31.0, 13.0)]),
    ("WIFI_PCIE_RX_N", "WIFI_PCIE_RX_N", "F.Cu", 0.10, [(18.5, 24.5), (24.5, 22.5), (31.5, 13.5)]),
    ("WIFI_ENABLE", "WIFI_EN", "F.Cu", 0.12, [(19.0, 25.0), (29.0, 24.0), (38.0, 29.0)]),
    ("BT_ENABLE", "BT_EN", "F.Cu", 0.12, [(19.5, 25.5), (29.5, 25.0), (39.0, 29.0)]),
    ("UFS_TX_P", "UFS_TX_P", "F.Cu", 0.10, [(31.0, 10.0), (36.0, 8.0), (40.5, 7.8)]),
    ("UFS_TX_N", "UFS_TX_N", "F.Cu", 0.10, [(31.5, 10.5), (36.5, 8.5), (41.0, 7.8)]),
    ("UFS_RX_P", "UFS_RX_P", "F.Cu", 0.10, [(32.0, 11.0), (37.0, 9.0), (41.5, 7.8)]),
    ("UFS_RX_N", "UFS_RX_N", "F.Cu", 0.10, [(32.5, 11.5), (37.5, 9.5), (42.0, 7.8)]),
    ("LPDDR_CK_P", "LPDDR_CK_P", "F.Cu", 0.09, [(29.0, 10.0), (27.0, 8.5), (25.5, 7.8)]),
    ("LPDDR_CK_N", "LPDDR_CK_N", "F.Cu", 0.09, [(29.5, 10.5), (27.5, 9.0), (26.0, 7.8)]),
    ("LPDDR_DQS_P", "LPDDR_DQS_P", "F.Cu", 0.09, [(30.0, 11.0), (32.0, 8.5), (35.5, 7.8)]),
    ("LPDDR_DQS_N", "LPDDR_DQS_N", "F.Cu", 0.09, [(30.5, 11.5), (32.5, 9.0), (36.0, 7.8)]),
    ("NFC_I2C_SCL", "NFC_I2C_SCL", "F.Cu", 0.12, [(51.0, 127.2), (45.0, 122.5), (39.0, 127.2)]),
    ("NFC_I2C_SDA", "NFC_I2C_SDA", "F.Cu", 0.12, [(51.5, 127.6), (45.5, 123.0), (39.5, 127.2)]),
    ("NFC_IRQ", "NFC_IRQ_N", "F.Cu", 0.12, [(51.8, 124.4), (50.0, 123.0), (40.0, 127.2)]),
    ("NFC_ENABLE", "NFC_EN", "F.Cu", 0.12, [(52.2, 124.4), (51.0, 123.0), (40.5, 127.2)]),
    ("NFC_RF_P_LOOP", "NFC_RF_P", "F.Cu", 0.16, [(52.8, 124.4), (52.8, 128.7), (49.8, 130.2)]),
    ("NFC_RF_N_LOOP", "NFC_RF_N", "F.Cu", 0.16, [(53.8, 125.4), (53.8, 129.2), (52.2, 130.2)]),
    ("SENSOR_I2C_SCL", "SENSOR_I2C_SCL", "F.Cu", 0.12, [(11.5, 17.0), (18.0, 20.0), (38.0, 29.0)]),
    ("SENSOR_I2C_SDA", "SENSOR_I2C_SDA", "F.Cu", 0.12, [(12.0, 17.5), (18.5, 20.5), (39.0, 29.0)]),
    ("AON_1V8_TP", "AON_1V8", "F.Cu", 0.20, [(18.0, 28.8), (27.6, 121.0), (38.0, 29.0)]),
    ("IO_1V8_TP", "IO_1V8", "F.Cu", 0.20, [(24.5, 22.0), (34.8, 118.0), (38.5, 29.0)]),
    ("RF_VBAT_TP", "RF_VBAT", "F.Cu", 0.28, [(31.2, 22.8), (42.0, 121.0), (10.0, 10.0)]),
    ("SPEAKER_P", "SPK_P", "F.Cu", 0.16, [(15.0, 121.0), (21.0, 121.0), (25.0, 126.0)]),
    ("SPEAKER_N", "SPK_N", "F.Cu", 0.16, [(15.5, 122.0), (22.0, 122.0), (26.0, 126.0)]),
    ("HAPTIC_OUT_A", "HAPTIC_OUT", "F.Cu", 0.16, [(46.0, 118.0), (51.0, 119.5), (55.0, 122.0)]),
    ("HAPTIC_OUT_B", "HAPTIC_OUT", "F.Cu", 0.16, [(47.0, 119.0), (52.0, 120.5), (56.0, 123.0)]),
    ("GND_STITCH_TOP", "GND", "F.Cu", 0.30, [(4.0, 4.0), (30.0, 4.0), (60.0, 4.0)]),
    ("GND_STITCH_BOTTOM", "GND", "F.Cu", 0.30, [(8.0, 124.0), (34.0, 126.0), (56.0, 124.0)]),
    ("SHIELD_GND_USB", "SHIELD_GND", "F.Cu", 0.30, [(34.0, 129.0), (35.0, 126.0), (37.0, 121.8)]),
    ("BAT_NTC", "BAT_NTC", "F.Cu", 0.12, [(37.0, 28.0), (54.8, 24.8), (43.0, 112.0)]),
    ("BAT_ID", "BAT_ID", "F.Cu", 0.12, [(37.5, 28.5), (55.3, 24.8), (44.0, 112.0)]),
    ("CHG_IRQ", "CHG_IRQ_N", "F.Cu", 0.12, [(24.5, 22.0), (50.5, 24.8), (38.0, 29.0)]),
    ("CHG_I2C_SCL", "CHG_I2C_SCL", "F.Cu", 0.12, [(25.0, 22.5), (50.8, 25.3), (38.5, 29.5)]),
    ("CHG_I2C_SDA", "CHG_I2C_SDA", "F.Cu", 0.12, [(25.5, 23.0), (51.1, 25.8), (39.0, 30.0)]),
    ("USBPD_I2C_SCL", "USBPD_I2C_SCL", "F.Cu", 0.12, [(34.0, 121.8), (46.5, 24.8), (38.0, 29.0)]),
    ("USBPD_I2C_SDA", "USBPD_I2C_SDA", "F.Cu", 0.12, [(34.5, 121.8), (47.0, 24.8), (38.5, 29.0)]),
    ("USBPD_IRQ", "USBPD_IRQ_N", "F.Cu", 0.12, [(35.0, 121.8), (47.5, 24.8), (39.0, 29.0)]),
    ("USBPD_RESET", "USBPD_RESET", "F.Cu", 0.12, [(35.5, 121.8), (48.0, 24.8), (39.5, 29.0)]),
    ("DISP_AVDD", "DISP_AVDD_5V5", "F.Cu", 0.18, [(53.5, 7.0), (42.4, 22.8), (56.4, 121.0)]),
    ("DISP_AVEE", "DISP_AVEE_N5V5", "F.Cu", 0.18, [(54.0, 7.5), (42.9, 22.8), (56.0, 120.5)]),
    ("CAM0_I2C_SCL", "CAM0_I2C_SCL", "F.Cu", 0.12, [(53.5, 18.5), (43.2, 22.6), (38.0, 29.0)]),
    ("CAM0_I2C_SDA", "CAM0_I2C_SDA", "F.Cu", 0.12, [(54.0, 19.0), (43.7, 22.6), (38.5, 29.0)]),
    ("CAM1_I2C_SCL", "CAM1_I2C_SCL", "F.Cu", 0.12, [(54.5, 19.5), (44.2, 22.6), (39.0, 29.0)]),
    ("CAM1_I2C_SDA", "CAM1_I2C_SDA", "F.Cu", 0.12, [(55.0, 20.0), (44.7, 22.6), (39.5, 29.0)]),
    ("CAM0_RESET", "CAM0_RESET_N", "F.Cu", 0.12, [(55.5, 20.5), (43.2, 18.7), (38.0, 29.5)]),
    ("CAM1_RESET", "CAM1_RESET_N", "F.Cu", 0.12, [(56.0, 21.0), (44.2, 18.7), (38.5, 29.5)]),
    ("CAM_AVDD", "CAM_AVDD_2V8", "F.Cu", 0.18, [(43.2, 18.7), (49.2, 118.0), (36.8, 22.8)]),
    ("CAM_DVDD", "CAM_DVDD_1V2", "F.Cu", 0.18, [(43.7, 18.7), (48.7, 117.5), (37.3, 22.8)]),
    ("WIFI_SDIO_CLK", "WIFI_SDIO_CLK", "F.Cu", 0.10, [(18.0, 23.0), (24.0, 18.0), (30.0, 10.0)]),
    ("WIFI_SDIO_CMD", "WIFI_SDIO_CMD", "F.Cu", 0.10, [(18.5, 23.5), (24.5, 18.5), (30.5, 10.5)]),
    ("WIFI_SDIO_D0", "WIFI_SDIO_D0", "F.Cu", 0.10, [(19.0, 24.0), (25.0, 19.0), (31.0, 11.0)]),
    ("WIFI_SDIO_D1", "WIFI_SDIO_D1", "F.Cu", 0.10, [(19.5, 24.5), (25.5, 19.5), (31.5, 11.5)]),
    ("WIFI_SDIO_D2", "WIFI_SDIO_D2", "F.Cu", 0.10, [(20.0, 25.0), (26.0, 20.0), (32.0, 12.0)]),
    ("WIFI_SDIO_D3", "WIFI_SDIO_D3", "F.Cu", 0.10, [(20.5, 25.5), (26.5, 20.5), (32.5, 12.5)]),
    ("BT_UART_TX", "BT_UART_TX", "F.Cu", 0.12, [(21.0, 23.0), (28.0, 26.0), (38.0, 29.0)]),
    ("BT_UART_RX", "BT_UART_RX", "F.Cu", 0.12, [(21.5, 23.5), (28.5, 26.5), (38.5, 29.0)]),
    ("BT_UART_CTS", "BT_UART_CTS_N", "F.Cu", 0.12, [(22.0, 24.0), (29.0, 27.0), (39.0, 29.0)]),
    ("BT_UART_RTS", "BT_UART_RTS_N", "F.Cu", 0.12, [(22.5, 24.5), (29.5, 27.5), (39.5, 29.0)]),
    ("WIFI_HOST_WAKE", "WIFI_HOST_WAKE", "F.Cu", 0.12, [(23.0, 25.0), (30.0, 28.0), (40.0, 29.0)]),
    ("USIM_VCC", "USIM_VCC", "F.Cu", 0.12, [(52.0, 28.7), (15.0, 15.0), (10.0, 10.0)]),
    ("USIM_CLK", "USIM_CLK", "F.Cu", 0.12, [(52.5, 28.7), (15.5, 15.5), (10.5, 10.5)]),
    ("USIM_RST", "USIM_RST", "F.Cu", 0.12, [(53.0, 28.7), (16.0, 16.0), (11.0, 11.0)]),
    ("USIM_IO", "USIM_IO", "F.Cu", 0.12, [(53.5, 28.7), (16.5, 16.5), (11.5, 11.5)]),
    ("USIM_DET", "USIM_DET", "F.Cu", 0.12, [(54.0, 28.7), (17.0, 17.0), (12.0, 12.0)]),
    ("ESIM_VCC", "ESIM_VCC", "F.Cu", 0.12, [(59.0, 28.7), (18.0, 17.0), (12.5, 12.5)]),
    ("ESIM_CLK", "ESIM_CLK", "F.Cu", 0.12, [(59.5, 28.7), (18.5, 17.5), (13.0, 13.0)]),
    ("ESIM_RST", "ESIM_RST", "F.Cu", 0.12, [(60.0, 28.7), (19.0, 18.0), (13.5, 13.5)]),
    ("ESIM_IO", "ESIM_IO", "F.Cu", 0.12, [(60.5, 28.7), (19.5, 18.5), (14.0, 14.0)]),
    ("UFS_REFCLK_P", "UFS_REFCLK_P", "F.Cu", 0.10, [(30.5, 10.0), (35.0, 8.0), (40.0, 7.8)]),
    ("UFS_REFCLK_N", "UFS_REFCLK_N", "F.Cu", 0.10, [(31.0, 10.5), (35.5, 8.5), (40.5, 7.8)]),
    ("LPDDR_CA0", "LPDDR_CA0", "F.Cu", 0.09, [(30.5, 10.0), (30.5, 8.5), (30.5, 7.8)]),
    ("LPDDR_CA1", "LPDDR_CA1", "F.Cu", 0.09, [(31.0, 10.5), (31.0, 8.5), (31.0, 7.8)]),
    ("LPDDR_CA2", "LPDDR_CA2", "F.Cu", 0.09, [(31.5, 11.0), (31.5, 8.5), (31.5, 7.8)]),
    ("LPDDR_CA3", "LPDDR_CA3", "F.Cu", 0.09, [(32.0, 11.5), (32.0, 8.5), (32.0, 7.8)]),
    ("LPDDR_RESET", "LPDDR_RESET_N", "F.Cu", 0.09, [(32.5, 12.0), (33.0, 8.5), (33.5, 7.8)]),
    ("LPDDR_ZQ", "LPDDR_ZQ", "F.Cu", 0.09, [(33.0, 12.5), (34.0, 8.5), (34.5, 7.8)]),
    ("JTAG_TCK", "JTAG_TCK", "F.Cu", 0.10, [(30.5, 10.0), (39.0, 14.0), (44.0, 16.2)]),
    ("JTAG_TMS", "JTAG_TMS", "F.Cu", 0.10, [(31.0, 10.5), (39.5, 14.5), (44.5, 16.2)]),
    ("JTAG_TDI", "JTAG_TDI", "F.Cu", 0.10, [(31.5, 11.0), (40.0, 15.0), (45.0, 16.2)]),
    ("JTAG_TDO", "JTAG_TDO", "F.Cu", 0.10, [(32.0, 11.5), (40.5, 15.5), (45.5, 16.2)]),
    ("JTAG_TRST", "JTAG_TRST_N", "F.Cu", 0.10, [(32.5, 12.0), (41.0, 16.0), (46.0, 16.2)]),
    ("BOOT_MODE0", "BOOT_MODE0", "F.Cu", 0.10, [(33.0, 12.5), (41.5, 16.5), (46.5, 16.2)]),
    ("BOOT_MODE1", "BOOT_MODE1", "F.Cu", 0.10, [(33.5, 13.0), (42.0, 17.0), (47.0, 16.2)]),
    ("BOOT_MODE2", "BOOT_MODE2", "F.Cu", 0.10, [(34.0, 13.5), (42.5, 17.5), (47.5, 16.2)]),
    ("SOC_RESET", "SOC_RESET_N", "F.Cu", 0.10, [(34.5, 14.0), (43.0, 18.0), (48.0, 16.2)]),
    ("I2S_BCLK", "I2S_BCLK", "F.Cu", 0.12, [(54.0, 27.5), (28.0, 127.2), (14.0, 124.0)]),
    ("I2S_LRCLK", "I2S_LRCLK", "F.Cu", 0.12, [(54.5, 27.5), (28.5, 127.2), (14.5, 124.0)]),
    ("I2S_DOUT", "I2S_DOUT", "F.Cu", 0.12, [(55.0, 27.5), (29.0, 127.2), (15.0, 124.0)]),
    ("I2S_DIN", "I2S_DIN", "F.Cu", 0.12, [(55.5, 27.5), (29.5, 127.2), (15.5, 124.0)]),
    ("PDM_CLK", "PDM_CLK", "F.Cu", 0.12, [(56.0, 27.5), (13.0, 119.4), (14.0, 124.0)]),
    ("PDM_DAT", "PDM_DAT", "F.Cu", 0.12, [(56.5, 27.5), (13.5, 119.4), (14.5, 124.0)]),
    ("AUDIO_I2C_SCL", "AUDIO_I2C_SCL", "F.Cu", 0.12, [(57.0, 27.5), (39.0, 127.2), (14.0, 124.0)]),
    ("AUDIO_I2C_SDA", "AUDIO_I2C_SDA", "F.Cu", 0.12, [(57.5, 27.5), (39.5, 127.2), (14.5, 124.0)]),
    ("CODEC_INT", "CODEC_INT", "F.Cu", 0.12, [(58.0, 27.5), (40.0, 127.2), (15.0, 124.0)]),
    ("AMP_INT", "AMP_INT", "F.Cu", 0.12, [(58.5, 27.5), (40.5, 127.2), (15.5, 124.0)]),
]

VIAS = [
    ("USB_DP_ESCAPE_VIA", "USB_DP", 35.8, 121.8, 0.45, 0.20),
    ("USB_DN_ESCAPE_VIA", "USB_DN", 36.3, 121.8, 0.45, 0.20),
    ("USB_CC1_ESCAPE_VIA", "USB_CC1", 24.0, 118.4, 0.45, 0.20),
    ("USB_CC2_ESCAPE_VIA", "USB_CC2", 31.0, 118.4, 0.45, 0.20),
    ("VBUS_POWER_VIA_A", "VBUS", 38.0, 121.8, 0.55, 0.25),
    ("VBUS_POWER_VIA_B", "VBUS", 41.0, 121.8, 0.55, 0.25),
    ("VBAT_POWER_VIA_A", "VBAT", 39.0, 118.0, 0.55, 0.25),
    ("SYS_POWER_VIA_A", "SYS", 42.0, 116.0, 0.55, 0.25),
    ("DISPLAY_DSI_BREAKOUT_VIA", "DSI_CLK_P", 47.0, 23.5, 0.40, 0.18),
    ("DISPLAY_DSI_RETURN_VIA", "GND", 47.8, 23.5, 0.45, 0.20),
    ("CAM0_CSI_BREAKOUT_VIA", "CAM0_CSI_CLK_P", 43.2, 10.8, 0.40, 0.18),
    ("CAM1_CSI_BREAKOUT_VIA", "CAM1_CSI_CLK_P", 43.2, 14.8, 0.40, 0.18),
    ("CELL_PCIE_BREAKOUT_VIA", "CELL_PCIE_TX_P", 31.0, 11.0, 0.40, 0.18),
    ("WIFI_PCIE_BREAKOUT_VIA", "WIFI_PCIE_TX_P", 30.0, 12.0, 0.40, 0.18),
    ("CELL_RF_GND_STITCH_A", "GND", 10.0, 6.7, 0.45, 0.20),
    ("CELL_RF_GND_STITCH_B", "GND", 20.0, 6.7, 0.45, 0.20),
    ("WIFI_RF_GND_STITCH_A", "GND", 10.0, 25.5, 0.45, 0.20),
    ("WIFI_RF_GND_STITCH_B", "GND", 15.0, 25.5, 0.45, 0.20),
    ("COMPUTE_MEMORY_ESCAPE_VIA_A", "LPDDR_CK_P", 25.5, 7.8, 0.35, 0.15),
    ("COMPUTE_MEMORY_ESCAPE_VIA_B", "UFS_TX_P", 40.5, 7.8, 0.35, 0.15),
    ("AUDIO_I2S_VIA", "I2S_BCLK", 28.0, 127.2, 0.40, 0.18),
    ("NFC_LOOP_RETURN_VIA", "GND", 51.0, 130.0, 0.45, 0.20),
    ("BOTTOM_GND_STITCH_A", "GND", 8.0, 124.0, 0.45, 0.20),
    ("BOTTOM_GND_STITCH_B", "GND", 56.0, 124.0, 0.45, 0.20),
]

COPPER_ZONES = [
    {
        "id": "E1Phone_LOCAL_GND_TOP_ISLAND_POUR",
        "net": "GND",
        "layers": ["F.Cu", "In1.GND", "B.Cu"],
        "points": [(1.000, 1.000), (63.000, 1.000), (63.000, 28.200), (1.000, 28.200)],
        "purpose": "local development GND reference fill on top board island clear of battery window",
    },
    {
        "id": "E1Phone_LOCAL_GND_BOTTOM_ISLAND_POUR",
        "net": "GND",
        "layers": ["F.Cu", "In8.GND", "B.Cu"],
        "points": [(1.000, 117.800), (63.000, 117.800), (63.000, 131.000), (1.000, 131.000)],
        "purpose": "local development GND reference fill on bottom board island clear of battery window",
    },
]


NET_ALIASES = {
    "BT_UART_CTS": "BT_UART_CTS_N",
    "BT_UART_RTS": "BT_UART_RTS_N",
    "CAM_IOVDD_1V8": "IO_1V8",
    "CHG_INT_N": "CHG_IRQ_N",
    "CHG_SCL": "CHG_I2C_SCL",
    "CHG_SDA": "CHG_I2C_SDA",
    "DISPLAY_RESET_N": "DISP_RESET_N",
    "DSI_TE": "DISP_TE",
    "HOST_WAKE_BT": "WIFI_HOST_WAKE",
    "HOST_WAKE_WLAN": "WIFI_HOST_WAKE",
    "MIC_BIAS": "PDM_DAT",
    "SPK_OUT_N": "SPK_N",
    "SPK_OUT_P": "SPK_P",
    "USBPD_RESET_N": "USBPD_RESET",
    "WLAN_EN": "WIFI_EN",
}


def flatten_nets(value: object) -> list[str]:
    if isinstance(value, dict):
        nets: list[str] = []
        for child in value.values():
            nets.extend(flatten_nets(child))
        return nets
    if isinstance(value, list):
        nets = []
        for child in value:
            nets.extend(flatten_nets(child))
        return nets
    return [str(value)]


def canonical_net(name: str) -> str:
    return NET_ALIASES.get(name, name)


def polyline_length(points: list[tuple[float, float]]) -> float:
    return sum(
        math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(points, points[1:], strict=False)
    )


def manhattan_length(points: list[tuple[float, float]]) -> float:
    return sum(
        abs(b[0] - a[0]) + abs(b[1] - a[1]) for a, b in zip(points, points[1:], strict=False)
    )


def classify_route(net_name: str, domain_classes: list[str], net_group: str = "") -> str:
    net = canonical_net(net_name)
    if net_group in {"control", "type_c_pd"}:
        return next(
            (item for item in domain_classes if "control" in item or "gpio" in item),
            "control",
        )
    if net_group in {"power", "side_keys"}:
        return next((item for item in domain_classes if "power" in item), "power")
    if net_group in {"identity", "nfc", "sensors"}:
        return "sim_nfc_sensor"
    if net_group == "debug_boot":
        return "debug_boot"
    if net_group in {"audio", "haptic", "split_critical"} and not (
        net in {"USB_DP", "USB_DN"} or any(token in net for token in ("VBUS", "SYS"))
    ):
        return next((item for item in domain_classes if "audio" in item), "audio_control_aon")
    if net in {"USB_DP", "USB_DN", "CELL_USB2_DP", "CELL_USB2_DN"}:
        return "usb2_diff"
    if "CSI" in net or net.startswith("DSI_"):
        return "mipi_dphy_diff"
    if "PCIE" in net:
        return "pcie_diff"
    if net.endswith("_RF") or "_RF_" in net or net in {"NFC_RF_P", "NFC_RF_N"}:
        return "rf_single"
    if net.startswith("UFS_"):
        return "ufs_mphy"
    if net.startswith("LPDDR_"):
        return "lpddr"
    if any(token in net for token in ("VBUS", "VBAT", "SYS", "AVDD", "AVEE", "DVDD")):
        return next((item for item in domain_classes if "power" in item), "power")
    if any(token in net for token in ("I2S", "PDM", "AUDIO", "CODEC", "AMP", "SPK", "HAPTIC")):
        return next((item for item in domain_classes if "audio" in item), "audio_control_aon")
    if "GPIO" in domain_classes:
        return "side_key_gpio"
    return domain_classes[0] if domain_classes else "unclassified"


def route_metadata_index() -> dict[str, dict[str, object]]:
    burndown = yaml.safe_load(
        (ROOT / "board/kicad/e1-phone/routed-layout-si-drc-burndown-2026-05-22.yaml").read_text()
    )
    metadata: dict[str, dict[str, object]] = {}
    for domain in burndown.get("route_domains", []):
        exact_nets = domain.get("exact_nets", {})
        constraints = domain.get("constraints", {})
        route_classes = list(domain.get("route_classes", []))
        net_to_group: dict[str, str] = {}
        if isinstance(exact_nets, dict):
            for group, values in exact_nets.items():
                for net in flatten_nets(values):
                    net_to_group[canonical_net(net)] = str(group)
        for net in sorted(set(flatten_nets(exact_nets))):
            canonical = canonical_net(net)
            route_class = classify_route(canonical, route_classes, net_to_group.get(canonical, ""))
            entry = metadata.setdefault(
                canonical,
                {
                    "domains": [],
                    "net_groups": [],
                    "route_classes": [],
                    "controlled_impedance_targets_ohm": [],
                    "length_limits_mm": [],
                    "skew_limits_mm": [],
                },
            )
            cast(list[Any], entry["domains"]).append(domain["id"])
            if canonical in net_to_group:
                cast(list[Any], entry["net_groups"]).append(net_to_group[canonical])
            cast(list[Any], entry["route_classes"]).append(route_class)
            for key, value in constraints.items():
                if "impedance_ohm" in key and route_class.split("_")[0] in key:
                    cast(list[Any], entry["controlled_impedance_targets_ohm"]).append(
                        {"constraint": key, "value": value}
                    )
                if key.endswith("length_mm_max") and (
                    route_class.split("_")[0] in key
                    or net_to_group.get(canonical, "").split("_")[0] in key
                ):
                    cast(list[Any], entry["length_limits_mm"]).append({"constraint": key, "value": value})
                if key.endswith("skew_mm_max") and route_class.split("_")[0] in key:
                    cast(list[Any], entry["skew_limits_mm"]).append({"constraint": key, "value": value})
    for entry in metadata.values():
        for key in (
            "domains",
            "net_groups",
            "route_classes",
            "controlled_impedance_targets_ohm",
            "length_limits_mm",
            "skew_limits_mm",
        ):
            values = cast(list[Any], entry[key])
            if values and isinstance(values[0], dict):
                deduped: list[Any] = []
                seen: set[tuple[Any, ...]] = set()
                for value in values:
                    marker = tuple(sorted(value.items()))
                    if marker not in seen:
                        seen.add(marker)
                        deduped.append(value)
                entry[key] = deduped
            else:
                entry[key] = sorted(set(str(value) for value in values))
    return metadata


def route_coverage(route_records: list[dict[str, object]]) -> dict[str, object]:
    routed = {str(item["net"]) for item in route_records}
    block = yaml.safe_load((ROOT / "board/kicad/e1-phone/block-netlist.yaml").read_text())
    burndown = yaml.safe_load(
        (ROOT / "board/kicad/e1-phone/routed-layout-si-drc-burndown-2026-05-22.yaml").read_text()
    )
    shared_records = []
    for category, nets in block["required_shared_nets"].items():
        required = sorted(set(str(net) for net in nets))
        missing = [net for net in required if canonical_net(net) not in routed]
        shared_records.append(
            {
                "category": category,
                "required_net_count": len(required),
                "routed_net_count": len(required) - len(missing),
                "missing_nets": missing,
            }
        )
    domain_records = []
    for domain in burndown.get("route_domains", []):
        required = sorted(set(flatten_nets(domain.get("exact_nets", {}))))
        routable = [net for net in required if canonical_net(net) in routed]
        missing = [net for net in required if canonical_net(net) not in routed]
        domain_records.append(
            {
                "id": domain["id"],
                "required_net_count": len(required),
                "routed_or_aliased_net_count": len(routable),
                "missing_nets": missing,
            }
        )
    return {
        "alias_map": NET_ALIASES,
        "required_shared_net_categories": shared_records,
        "route_domains": domain_records,
        "missing_required_shared_net_count": sum(
            len(item["missing_nets"]) for item in shared_records
        ),
        "missing_route_domain_net_count": sum(len(item["missing_nets"]) for item in domain_records),
    }


def segment(
    route_id: str,
    net_name: str,
    net_id: int,
    layer: str,
    width: float,
    a: tuple[float, float],
    b: tuple[float, float],
    idx: int,
) -> str:
    return (
        f"  (segment (start {a[0]:.3f} {a[1]:.3f}) (end {b[0]:.3f} {b[1]:.3f}) "
        f'(width {width:.3f}) (layer "{layer}") (net {net_id}) '
        f'(tstamp "{stable_uuid(route_id, net_name, idx)}"))'
    )


def via(
    via_id: str, net_name: str, net_id: int, x: float, y: float, size: float, drill: float
) -> str:
    return (
        f"  (via (at {x:.3f} {y:.3f}) (size {size:.3f}) (drill {drill:.3f}) "
        f'(layers "F.Cu" "B.Cu") (net {net_id}) '
        f'(tstamp "{stable_uuid("via", via_id, net_name)}"))'
    )


def find_sexpr_blocks(text: str, head: str) -> list[tuple[int, int, str]]:
    blocks: list[tuple[int, int, str]] = []
    for match in re.finditer(rf"(?m)^\s*\({re.escape(head)}", text):
        start = match.start()
        depth = 0
        in_string = False
        escaped = False
        end = start
        while end < len(text):
            char = text[end]
            if in_string:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
            else:
                if char == '"':
                    in_string = True
                elif char == "(":
                    depth += 1
                elif char == ")":
                    depth -= 1
                    if depth == 0:
                        end += 1
                        break
            end += 1
        blocks.append((start, end, text[start:end]))
    return blocks


def remove_generated_local_copper_zones(text: str) -> str:
    generated_names = {str(zone["id"]) for zone in COPPER_ZONES}
    pieces: list[str] = []
    cursor = 0
    for start, end, block in find_sexpr_blocks(text, "zone "):
        name_match = re.search(r'\(name\s+"([^"]+)"\)', block)
        name = name_match.group(1) if name_match else ""
        if name in generated_names:
            pieces.append(text[cursor:start])
            cursor = end
    if cursor == 0:
        return text
    pieces.append(text[cursor:])
    return "".join(pieces)


def copper_zone(
    zone_id: str,
    net_name: str,
    net_id: int,
    layers: list[str],
    points: list[tuple[float, float]],
) -> str:
    layer_text = " ".join(f'"{layer}"' for layer in layers)
    point_text = "\n".join(f"        (xy {x:.3f} {y:.3f})" for x, y in points)
    filled_polygons = []
    for layer in layers:
        filled_polygons.append(
            "\n".join(
                [
                    f'    (filled_polygon (layer "{layer}")',
                    "      (island)",
                    "      (pts",
                    point_text,
                    "      )",
                    "    )",
                ]
            )
        )
    filled_polygon_text = "\n".join(filled_polygons)
    return "\n".join(
        [
            (
                f'  (zone (net {net_id}) (net_name "{net_name}") '
                f'(layers {layer_text}) (tstamp "{stable_uuid("zone", zone_id, net_name)}")'
            ),
            f'    (name "{zone_id}")',
            "    (hatch edge 0.500)",
            "    (priority 30)",
            "    (connect_pads (clearance 0.150))",
            "    (min_thickness 0.100)",
            "    (fill yes (thermal_gap 0.500) (thermal_bridge_width 0.500))",
            "    (polygon",
            "      (pts",
            point_text,
            "      )",
            "    )",
            filled_polygon_text,
            "  )",
        ]
    )


def main() -> int:
    source_board = REAL_FOOTPRINT_BOARD if REAL_FOOTPRINT_BOARD.is_file() else CONCEPT
    text = source_board.read_text()
    ids = net_ids(text)
    route_metadata = route_metadata_index()
    body = remove_generated_local_copper_zones(text.rstrip()[:-1].rstrip())
    body = re.sub(r"\n\s*\(segment \(start [^\n]+\)", "", body)
    body = re.sub(r"\n\s*\(via \(at [^\n]+\)", "", body)
    lines: list[str] = []
    route_records: list[dict[str, object]] = []
    via_records: list[dict[str, object]] = []
    missing_nets: list[str] = []
    for route_id, net_name, layer, width, points in ROUTES:
        net_id = ids.get(net_name)
        if net_id is None:
            missing_nets.append(net_name)
            continue
        start_count = len(lines)
        for idx, (a, b) in enumerate(zip(points, points[1:], strict=False), start=1):
            lines.append(segment(route_id, net_name, net_id, layer, width, a, b, idx))
        metadata = route_metadata.get(canonical_net(net_name), {})
        route_length = round(polyline_length(points), 3)
        route_manhattan = round(manhattan_length(points), 3)
        route_records.append(
            {
                "id": route_id,
                "net": net_name,
                "canonical_net": canonical_net(net_name),
                "layer": layer,
                "width_mm": width,
                "segment_count": len(lines) - start_count,
                "length_mm": route_length,
                "manhattan_length_mm": route_manhattan,
                "source_domains": metadata.get("domains", []),
                "source_net_groups": metadata.get("net_groups", []),
                "route_classes": metadata.get("route_classes", []),
                "controlled_impedance_targets_ohm": metadata.get(
                    "controlled_impedance_targets_ohm", []
                ),
                "length_limits_mm": metadata.get("length_limits_mm", []),
                "skew_limits_mm": metadata.get("skew_limits_mm", []),
                "constraint_status": "development_trace_only_not_field_solved_or_drc_signed",
                "points_mm": [{"x": x, "y": y} for x, y in points],
            }
        )

    via_lines: list[str] = []
    for via_id, net_name, x, y, size, drill in VIAS:
        net_id = ids.get(net_name)
        if net_id is None:
            missing_nets.append(net_name)
            continue
        via_lines.append(via(via_id, net_name, net_id, x, y, size, drill))
        via_records.append(
            {
                "id": via_id,
                "net": net_name,
                "at_mm": {"x": x, "y": y},
                "size_mm": size,
                "drill_mm": drill,
                "layers": ["F.Cu", "B.Cu"],
            }
        )

    routes_by_net: dict[str, list[dict[str, object]]] = {}
    for route in route_records:
        routes_by_net.setdefault(str(route["canonical_net"]), []).append(route)
    for via_record in via_records:
        via_at_mm = cast(dict[str, float], via_record["at_mm"])
        via_size_mm = float(cast(float, via_record["size_mm"]))
        linked = [
            str(route["id"])
            for route in routes_by_net.get(str(via_record["net"]), [])
            if any(
                math.hypot(
                    float(cast(float, point["x"])) - float(via_at_mm["x"]),
                    float(cast(float, point["y"])) - float(via_at_mm["y"]),
                )
                <= max(via_size_mm, 0.6)
                for point in cast(list[dict[str, object]], route["points_mm"])
            )
        ]
        via_record["linked_route_ids"] = linked
    via_ids_by_net: dict[str, list[str]] = {}
    for via_record in via_records:
        via_ids_by_net.setdefault(str(via_record["net"]), []).append(str(via_record["id"]))
    for route in route_records:
        route["linked_via_ids"] = via_ids_by_net.get(str(route["canonical_net"]), [])

    zone_lines: list[str] = []
    zone_records: list[dict[str, object]] = []
    for zone in COPPER_ZONES:
        zone_id = str(zone["id"])
        net_name = str(zone["net"])
        net_id = ids.get(net_name)
        points = list(cast(list[tuple[float, float]], zone["points"]))
        layers = list(cast(list[str], zone["layers"]))
        if net_id is None:
            missing_nets.append(net_name)
            continue
        zone_lines.append(copper_zone(zone_id, net_name, net_id, layers, points))
        xs = [point[0] for point in points]
        ys = [point[1] for point in points]
        zone_records.append(
            {
                "id": zone_id,
                "net": net_name,
                "layers": layers,
                "polygon_point_count": len(points),
                "filled_polygon_count": len(layers),
                "release_credit": False,
                "purpose": zone["purpose"],
                "bbox_mm": {
                    "x_min": min(xs),
                    "y_min": min(ys),
                    "x_max": max(xs),
                    "y_max": max(ys),
                    "width": round(max(xs) - min(xs), 3),
                    "height": round(max(ys) - min(ys), 3),
                },
            }
        )

    class_summary: dict[str, dict[str, object]] = {}
    domain_summary: dict[str, dict[str, object]] = {}
    route_classification_gaps: list[dict[str, object]] = []
    for route in route_records:
        if (
            not route["route_classes"]
            or not route["source_domains"]
            or not route["source_net_groups"]
        ):
            route_classification_gaps.append(
                {
                    "id": route["id"],
                    "net": route["net"],
                    "missing_source_domains": not bool(route["source_domains"]),
                    "missing_source_net_groups": not bool(route["source_net_groups"]),
                    "missing_route_classes": not bool(route["route_classes"]),
                }
            )
        classes = cast(list[Any], route["route_classes"]) or ["unclassified"]
        domains = cast(list[Any], route["source_domains"]) or ["unmapped"]
        for route_class in classes:
            summary = class_summary.setdefault(
                str(route_class),
                {"route_count": 0, "segment_count": 0, "length_mm": 0.0, "nets": []},
            )
            summary["route_count"] = cast(int, summary["route_count"]) + 1
            summary["segment_count"] = cast(int, summary["segment_count"]) + cast(int, route["segment_count"])
            summary["length_mm"] = cast(float, summary["length_mm"]) + cast(float, route["length_mm"])
            cast(list[Any], summary["nets"]).append(route["canonical_net"])
        for domain in domains:
            summary = domain_summary.setdefault(
                str(domain),
                {"route_count": 0, "segment_count": 0, "length_mm": 0.0, "nets": []},
            )
            summary["route_count"] = cast(int, summary["route_count"]) + 1
            summary["segment_count"] = cast(int, summary["segment_count"]) + cast(int, route["segment_count"])
            summary["length_mm"] = cast(float, summary["length_mm"]) + cast(float, route["length_mm"])
            cast(list[Any], summary["nets"]).append(route["canonical_net"])
    for summary in list(class_summary.values()) + list(domain_summary.values()):
        summary["length_mm"] = round(float(cast(float, summary["length_mm"])), 3)
        summary["nets"] = sorted(set(str(net) for net in cast(list[Any], summary["nets"])))

    OUT.write_text(body + "\n" + "\n".join(lines + via_lines + zone_lines) + "\n)\n")
    detailed_step_intake = (
        yaml.safe_load(DETAILED_DEV_STEP_INTAKE.read_text(encoding="utf-8"))
        if DETAILED_DEV_STEP_INTAKE.is_file()
        else {}
    )
    step_source = DETAILED_DEV_STEP if DETAILED_DEV_STEP.is_file() else CAD_STEP
    if step_source.exists():
        DEV_STEP.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(step_source, DEV_STEP)

    report = {
        "schema": "eliza.e1_phone_routed_development_board_intake.v1",
        "date": "2026-05-22",
        "status": "development_routed_tracks_present_not_release",
        "claim_boundary": (
            "Non-release routed-development snapshot with visible KiCad copper segments. "
            "It is not supplier-footprint complete, not DRC/ERC/SI/PI/RF signed, not a "
            "production routed-board STEP, and not fabrication or enclosure release evidence."
        ),
        "source_board": str(source_board.relative_to(ROOT)),
        "development_board": str(OUT.relative_to(ROOT)),
        "development_step": str(DEV_STEP.relative_to(ROOT)) if DEV_STEP.exists() else "",
        "development_step_source": str(step_source.relative_to(ROOT))
        if step_source.exists()
        else "",
        "development_step_sha256": sha256(DEV_STEP) if DEV_STEP.exists() else "",
        "development_step_size_bytes": DEV_STEP.stat().st_size if DEV_STEP.exists() else 0,
        "development_step_visual_source_intake": (
            str(DETAILED_DEV_STEP_INTAKE.relative_to(ROOT)) if detailed_step_intake else ""
        ),
        "development_step_visual_detail": {
            "footprint_envelopes": detailed_step_intake.get("footprint_envelope_count", 0),
            "pad_contacts": detailed_step_intake.get("pad_contact_visual_count", 0),
            "route_segments": detailed_step_intake.get("route_segment_visual_count", 0),
            "source_step_sha256": detailed_step_intake.get("step_sha256", ""),
        },
        "evidence_class": "development_routing_visualization_not_release",
        "route_count": len(route_records),
        "segment_count": sum(int(cast(int, item["segment_count"])) for item in route_records),
        "via_count": len(via_records),
        "local_copper_zone_count": len(zone_records),
        "local_copper_zone_filled_polygon_count": sum(
            int(cast(int, item["filled_polygon_count"])) for item in zone_records
        ),
        "local_copper_zone_release_credit": False,
        "route_length_total_mm": round(sum(float(cast(float, item["length_mm"])) for item in route_records), 3),
        "controlled_impedance_route_count": sum(
            1 for item in route_records if item["controlled_impedance_targets_ohm"]
        ),
        "route_classification_gap_count": len(route_classification_gaps),
        "route_classification_gaps": route_classification_gaps,
        "route_traceability_summary": {
            "classes": dict(sorted(class_summary.items())),
            "domains": dict(sorted(domain_summary.items())),
        },
        "missing_nets": sorted(set(missing_nets)),
        "coverage": route_coverage(route_records),
        "routes": route_records,
        "vias": via_records,
        "local_copper_zones": zone_records,
        "release_blockers_preserved": [
            "development footprint IDs remain non-release review patterns",
            "supplier-frozen land patterns and signed STEP models are not frozen",
            "no production routed-board STEP is imported into mechanical release",
            "no DRC/ERC/SI/PI/RF/factory evidence is attached",
        ],
    }
    AUDIT.write_text(yaml.safe_dump(report, sort_keys=False))
    print(f"wrote {OUT.relative_to(ROOT)}")
    print(
        f"routes={report['route_count']} segments={report['segment_count']} "
        f"vias={report['via_count']}"
    )
    if DEV_STEP.exists():
        print(f"wrote {DEV_STEP.relative_to(ROOT)}")
    if missing_nets:
        print(f"missing_nets={','.join(sorted(set(missing_nets)))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
