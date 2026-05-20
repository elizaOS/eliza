#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


def load(rel: str) -> dict:
    with (ROOT / rel).open() as handle:
        data = yaml.safe_load(handle)
    if not isinstance(data, dict):
        raise SystemExit(f"{rel} must be a mapping")
    return data


def require(rel: str) -> None:
    path = ROOT / rel
    if not path.is_file():
        raise SystemExit(f"missing required phone artifact: {rel}")


def main() -> int:
    manifest = load("board/kicad/e1-phone/artifact-manifest.yaml")
    if manifest["status"] != "blocked_not_fabrication_ready":
        raise SystemExit("phone manifest must remain fail-closed")
    for group_paths in manifest["current_artifacts"].values():
        for rel in group_paths:
            require(rel)
    target = manifest["design_target"]
    if target["display_anchor"] != "5.5_in_1080x1920_MIPI_LCM_CTP":
        raise SystemExit("phone must be anchored to the 5.5in 1080x1920 MIPI CTP display")
    if target["board_bbox_mm"] != {"width": 64.0, "height": 132.0}:
        raise SystemExit(f"unexpected board bbox: {target['board_bbox_mm']}")
    if target["battery_window_mm"] != {"width": 64.0, "height": 87.0}:
        raise SystemExit(f"unexpected battery window: {target['battery_window_mm']}")
    if target["usb_c_ports"] != 1:
        raise SystemExit("phone must have exactly one USB-C port")
    for item in ["power", "volume_up", "volume_down"]:
        if item not in target["side_buttons"]:
            raise SystemExit(f"missing side button {item}")
    for radio in ["5g_redcap_cellular", "wifi_6e", "bluetooth_5_3"]:
        if radio not in target["radios"]:
            raise SystemExit(f"missing radio {radio}")

    display = load("board/kicad/e1-phone/display-fit.yaml")
    if not display["primary_fits_current_envelope"]:
        raise SystemExit("selected display must fit envelope")
    clearance = display["primary_clearance_in_current_envelope_mm"]
    if clearance["width_clearance_mm"] < 0.8 or clearance["height_clearance_mm"] < 1.8:
        raise SystemExit(f"display clearance too tight: {clearance}")

    utilization = load("board/kicad/e1-phone/layout-utilization.yaml")
    reserve = utilization["route_shield_test_reserve_pct_of_placement_area"]
    if not (8.0 <= reserve <= 18.0):
        raise SystemExit(f"layout reserve outside target band: {reserve}")

    audit = load("board/kicad/e1-phone/supplier-sourcing-audit.yaml")
    groups = {record["group"] for record in audit["public_source_validation"]}
    for group in ["display", "camera", "cellular", "wifi_bt"]:
        if group not in groups:
            raise SystemExit(f"sourcing audit missing {group}")
    urls = " ".join(record["url"] for record in audit["public_source_validation"])
    for host in ["alibaba.com", "made-in-china.com", "quectel.com", "murata.com"]:
        if host not in urls:
            raise SystemExit(f"sourcing audit missing {host}")

    bindings = {
        "cellular": load("package/cellular/quectel-5g-redcap.yaml"),
        "wifi": load("package/wifi/murata-type-2ea-wifi6e.yaml"),
        "camera": load("package/camera/oem-mipi-csi-modules.yaml"),
        "usb": load("package/usb-c/e1-phone-usb-c-port.yaml"),
        "buttons": load("package/human-interface/side-buttons.yaml"),
        "battery": load("package/battery/e1-phone-17p3wh-pack.yaml"),
    }
    if "RG255" not in bindings["cellular"]["selected"]:
        raise SystemExit("cellular binding must select Quectel RG255 class")
    if "Type 2EA" not in bindings["wifi"]["selected"]:
        raise SystemExit("Wi-Fi/Bluetooth binding must select Murata Type 2EA")
    if "OV13855" not in bindings["camera"]["rear_camera_candidate"]:
        raise SystemExit("rear camera binding must include OV13855")
    if "GC5035" not in bindings["camera"]["front_camera_candidate"]:
        raise SystemExit("front camera binding must include GC5035")
    if bindings["usb"]["ports"] != 1 or "VBUS" not in bindings["usb"]["nets"]:
        raise SystemExit("USB-C binding must include one VBUS port")
    if bindings["buttons"]["layout_closure_requirements"]["side_key_flex_pin_budget"]["recommended_min_contacts"] < 8:
        raise SystemExit("side-key flex pin budget too weak")

    plan = load("board/kicad/e1-phone/routed-release-plan.yaml")
    if plan["ready_to_fabricate"] or plan["ready_for_enclosure"]:
        raise SystemExit("routed-release plan cannot claim ready state")
    outputs = plan["required_release_output_manifest"]
    if len(outputs) < 16:
        raise SystemExit("routed-release plan must enumerate release outputs")
    for name, item in outputs.items():
        if item["present"] or not item["release_required"]:
            raise SystemExit(f"release output {name} must be missing and required")

    pcb = (ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb").read_text()
    for token in ["(end 64 132)", "BATTERY CAVITY 64x87", "USB-C", "PWR VOL+ VOL-", "RG255G 5G REDCAP", "MURATA 2EA WIFI6E BT5.3"]:
        if token not in pcb:
            raise SystemExit(f"PCB concept missing token {token}")
    print("E1 phone board package scaffold consistent; not fabrication ready")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
