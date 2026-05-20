#!/usr/bin/env python3
"""Generate a current supplier sourcing audit for the E1 phone mainboard."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "board/kicad/e1-phone/supplier-sourcing-audit.yaml"
DISPLAY = ROOT / "package/display/v0-dsi-720x1280.yaml"
CAMERA = ROOT / "package/camera/oem-mipi-csi-modules.yaml"
CELLULAR = ROOT / "package/cellular/quectel-5g-redcap.yaml"
WIFI = ROOT / "package/wifi/murata-type-2ea-wifi6e.yaml"
METRICS = ROOT / "docs/board/e1-phone-mainboard-metrics.yaml"
DISPLAY_FIT = ROOT / "board/kicad/e1-phone/display-fit.yaml"


class IndentedSafeDumper(yaml.SafeDumper):
    def increase_indent(self, flow: bool = False, indentless: bool = False):
        return super().increase_indent(flow=flow, indentless=False)


def load_yaml(path: Path) -> Any:
    with path.open() as handle:
        return yaml.safe_load(handle)


def main() -> int:
    display = load_yaml(DISPLAY)
    camera = load_yaml(CAMERA)
    cellular = load_yaml(CELLULAR)
    wifi = load_yaml(WIFI)
    metrics = load_yaml(METRICS)
    display_fit = load_yaml(DISPLAY_FIT)

    chenghao = display["panel_candidates"][0]
    meta = display["panel_candidates"][1]
    rear = camera["rear_camera_primary"]["candidate_parts"]
    device_envelope = metrics["industrial_design_assumptions"]["device_envelope_mm"]

    out: dict[str, Any] = {
        "schema": "eliza.e1_phone_supplier_sourcing_audit.v1",
        "status": "sourcing_supported_by_public_listings_not_procurement_ready",
        "date": "2026-05-20",
        "claim_boundary": (
            "Current public sourcing audit only. This is not a purchase order, AVL, supplier "
            "approval, NDA datasheet pack, sample receipt, incoming inspection, or permission "
            "to freeze KiCad symbols, footprints, FPC pinouts, antennas, or enclosure datums."
        ),
        "source_artifacts": [
            "package/display/v0-dsi-720x1280.yaml",
            "package/camera/oem-mipi-csi-modules.yaml",
            "package/cellular/quectel-5g-redcap.yaml",
            "package/wifi/murata-type-2ea-wifi6e.yaml",
            "docs/board/e1-phone-mainboard-metrics.yaml",
            "board/kicad/e1-phone/display-fit.yaml",
        ],
        "selection_summary": {
            "display_anchor": "5.5_in_1080x1920_MIPI_DSI_CTP",
            "device_envelope_mm": device_envelope,
            "mainboard_bbox_mm": metrics["mainboard_outline_concept"]["bounding_box_mm"],
            "screen_fit_basis": display_fit["selected_primary_display"],
            "primary_radio_module": cellular["primary_first_phone"]["family"],
            "primary_wifi_bt_module": wifi["vendor_public_specs"]["order_number"],
        },
        "public_source_validation": {
            "checked_date": "2026-05-20",
            "method": (
                "Manual public web revalidation of marketplace/vendor pages. Listings are "
                "treated as sourcing evidence only; supplier quote, drawing pack, sample "
                "receipt, and incoming inspection are still missing."
            ),
            "validated_sources": [
                {
                    "group": "display",
                    "supplier": "Shenzhen Chenghao Optoelectronic",
                    "url": "https://chenghaolcd.en.made-in-china.com/product/pmFUBTZDnXVH/China-LCD-Manufacturer-1080-1920-Pixels-5-5inch-Pcap-Capacitive-Touch-Display-TFT-Module.html",
                    "public_page_status": "public_listing_observed_2026_05_20",
                    "observed_fields": [
                        "CH550FH01A-CT model number",
                        "1080x1920 resolution",
                        "MIPI interface",
                        "77.1 x 151.77 x 3.39 mm outline",
                        "70.78 x 129.17 x 1.7 mm TFT outline",
                        "68.04 x 120.96 mm active area",
                        "Shenzhen port and MOQ/price ladder signal",
                    ],
                    "layout_use": "primary_display_mechanical_anchor",
                    "blocking_gap": "no_signed_drawing_or_exact_FPC_pinout",
                },
                {
                    "group": "display",
                    "supplier": "META Display LLC",
                    "url": "https://www.alibaba.com/product-detail/5-5-Inch-TFT-LCD-Display_1601425016323.html",
                    "public_page_status": "public_listing_observed_2026_05_20",
                    "observed_fields": [
                        "055WU01 model family",
                        "5.5 inch 1080x1920 TFT LCD",
                        "MIPI 40-pin interface",
                        "capacitive touch",
                    ],
                    "layout_use": "40_pin_DSI_brightness_alternate",
                    "blocking_gap": "public_outline_and_FPC_exit_missing",
                },
                {
                    "group": "display",
                    "supplier": "Forfuture/FET display supplier",
                    "url": "https://www.made-in-china.com/showroom/bella823/product-detailDjlmucpOAohW/China-Fet-High-Resolution-1080-1920-Mipi-Interface-5-5-Inch-Amoled-Display.html",
                    "public_page_status": "public_listing_observed_2026_05_20",
                    "observed_fields": [
                        "5.5 inch 1080x1920 AMOLED",
                        "MIPI 4-lane interface",
                        "RM67191-class driver",
                        "70.66 x 128.36 x 0.82 mm outline",
                    ],
                    "layout_use": "thin_z_height_display_alternate",
                    "blocking_gap": "touch_stack_and_power_sequence_not_received",
                },
                {
                    "group": "camera",
                    "supplier": "Sincere First",
                    "url": "https://sincerefirst.en.made-in-china.com/product/WACpUrRYOVkc/China-Ov13855-Ov13850-CMOS-Sensor-Autofocus-13MP-Mipi-Camera-Module.html",
                    "public_page_status": "public_listing_observed_2026_05_20",
                    "observed_fields": [
                        "OV13855/OV13850 13MP sensor class",
                        "MIPI interface",
                        "autofocus lens",
                        "1/3.06 inch sensor size",
                        "78.4 degree view angle",
                        "5-piece MOQ/price signal on Made-in-China video listing",
                    ],
                    "layout_use": "rear_camera_primary_FPC_and_z_stack_class",
                    "blocking_gap": "exact_module_drawing_pinout_and_lens_stack_missing",
                },
                {
                    "group": "camera",
                    "supplier": "Sincere First",
                    "url": "https://sincerefirst.en.made-in-china.com/product/iaVrcpOdEBhg/China-5MP-High-Definition-Mipi-Coms-Gc5035-Sensor-Auto-Focus-Mini-Camera-Module.html",
                    "public_page_status": "public_listing_observed_2026_05_20",
                    "observed_fields": [
                        "GC5035 5MP sensor",
                        "2592x1944 array size",
                        "MIPI camera module",
                        "fixed-focus/minisize class",
                        "consumer electronics and smartphone application statement",
                    ],
                    "layout_use": "front_camera_primary_size_and_CSI_class",
                    "blocking_gap": "selected_FF_part_number_and_FPC_drawing_need_supplier_confirmation",
                },
                {
                    "group": "cellular",
                    "supplier": "Quectel",
                    "url": "https://www.quectel.com/product/5g-redcap-rg255c-series/",
                    "public_page_status": "vendor_page_observed_2026_05_20",
                    "observed_fields": [
                        "RG255C 5G RedCap Sub-6 LGA module series",
                        "LTE Cat 4 fallback",
                        "USB 2.0, PCIe 2.0, PCM, UART, SGMII, SPI interfaces",
                        "Windows, Linux, and Android driver support statement",
                    ],
                    "layout_use": "primary_cellular_LGA_module_and_RF_region",
                    "blocking_gap": "region_SKU_band_matrix_and_hardware_design_guide_missing",
                },
                {
                    "group": "wifi_bluetooth",
                    "supplier": "Murata",
                    "url": "https://www.murata.com/en-us/products/connectivitymodule/wi-fi-bluetooth/overview/lineup/type2ea",
                    "public_page_status": "vendor_page_observed_2026_05_20",
                    "observed_fields": [
                        "LBEE5XV2EA-802 order number",
                        "in-production status",
                        "Infineon CYW55573 chipset",
                        "Wi-Fi 6E 2x2 MIMO and Bluetooth 5.3",
                        "PCIe/SDIO Wi-Fi, UART Bluetooth",
                        "12.5 x 9.4 x 1.2 mm SMT shielded resin package",
                    ],
                    "layout_use": "primary_wifi6e_bt53_module_land_pattern_and_RF_feed",
                    "blocking_gap": "datasheet_package_reference_layout_and_firmware_license_missing",
                },
            ],
        },
        "public_sourcing_evidence": {
            "display": [
                {
                    "supplier": "Shenzhen Chenghao Optoelectronic",
                    "marketplace": "Made-in-China",
                    "candidate": chenghao["part"],
                    "url": "https://chenghaolcd.en.made-in-china.com/product/pmFUBTZDnXVH/China-LCD-Manufacturer-1080-1920-Pixels-5-5inch-Pcap-Capacitive-Touch-Display-TFT-Module.html",
                    "observed_public_specs": {
                        "resolution": chenghao["resolution"],
                        "interface": chenghao["interface"],
                        "module_outline_mm": chenghao["module_outline_mm"],
                        "tft_outline_mm": chenghao["tft_outline_mm"],
                        "active_area_mm": chenghao["active_area_mm"],
                    },
                    "fit_result": "fits_current_78p0_x_153p6_mm_envelope",
                    "procurement_role": "primary_mechanical_anchor",
                },
                {
                    "supplier": "META Display LLC",
                    "marketplace": "Alibaba",
                    "candidate": meta["part"],
                    "url": "https://www.alibaba.com/product-detail/5-5-Inch-TFT-LCD-Display_1601425016323.html",
                    "observed_public_specs": {
                        "resolution": meta["resolution"],
                        "interface": meta["interface"],
                        "active_area_mm": meta["active_area_mm"],
                        "brightness_typ_cd_m2": meta["brightness_typ_cd_m2"],
                        "signal_interface": "MIPI_40_pin",
                    },
                    "fit_result": "electrical_alternate_missing_public_outline",
                    "procurement_role": "pinout_or_brightness_alternate",
                },
                {
                    "supplier": "Alibaba OEM/ODM display supplier",
                    "marketplace": "Alibaba",
                    "candidate": "5p5_1080x1920_MIPI_40pin_ILI7807D_1200nit_class",
                    "url": "https://www.alibaba.com/product-detail/5-5-Inch-1080x1920-LCM-IPS_1601692707933.html",
                    "observed_public_specs": {
                        "resolution": "1080x1920",
                        "interface": "MIPI_40_pin",
                        "driver_ic": "ILI7807D",
                        "brightness_typ_cd_m2": 1200,
                        "touch": "capacitive",
                    },
                    "fit_result": "electrical_alternate_supplier_drawing_required",
                    "procurement_role": "high_brightness_display_alternate",
                },
                {
                    "supplier": "Forfuture/FET display supplier",
                    "marketplace": "Made-in-China",
                    "candidate": "5p5_1080x1920_MIPI_AMOLED_RM67191_class",
                    "url": "https://www.made-in-china.com/showroom/bella823/product-detailDjlmucpOAohW/China-Fet-High-Resolution-1080-1920-Mipi-Interface-5-5-Inch-Amoled-Display.html",
                    "observed_public_specs": {
                        "resolution": "1080x1920",
                        "interface": "MIPI_4_lane",
                        "driver_ic": "RM67191",
                        "active_area_mm": {"width": 68.299, "height": 121.421},
                        "outline_mm": {"width": 70.66, "height": 128.36, "thickness": 0.82},
                    },
                    "fit_result": "z_height_alternate_supplier_touch_stack_required",
                    "procurement_role": "thin_display_power_alternate",
                },
            ],
            "camera": [
                {
                    "supplier": "Guangzhou Sincere Information Technology",
                    "marketplace": "Alibaba",
                    "candidate": "OV13850_13MP_MIPI_class",
                    "url": "https://www.alibaba.com/supplier/mobile-camera-module.html",
                    "observed_public_specs": {
                        "class": "13MP_MIPI_mobile_phone_camera_module",
                        "price_signal_usd": "11_to_14_listing_range",
                        "supplier_profile": "custom_manufacturer",
                        "customization": ["minor_customization", "full_customization"],
                    },
                    "procurement_role": "rear_camera_supplier_family_check",
                },
                {
                    "supplier": rear[0]["vendor"],
                    "marketplace": "Made-in-China",
                    "candidate": rear[0]["module"],
                    "url": rear[0]["sourcing_url"],
                    "observed_public_specs": {
                        "sensor": rear[0]["sensor"],
                        "resolution_mp": rear[0]["resolution_mp"],
                        "interface": rear[0]["interface"],
                        "pin_count": rear[0]["pin_count"],
                        "focus": rear[0]["focus"],
                    },
                    "procurement_role": "rear_camera_primary_pin_count_class",
                },
                {
                    "supplier": rear[1]["vendor"],
                    "marketplace": "Made-in-China",
                    "candidate": rear[1]["module"],
                    "url": rear[1]["sourcing_url"],
                    "observed_public_specs": {
                        "sensor": rear[1]["sensor"],
                        "resolution_px": rear[1]["resolution_px"],
                        "interface": rear[1]["interface"],
                        "pin_count": rear[1]["pin_count"],
                        "focus": rear[1]["focus"],
                    },
                    "procurement_role": "rear_camera_4lane_alternate",
                },
                {
                    "supplier": "Sincere First",
                    "marketplace": "Made-in-China",
                    "candidate": "SF-G5035S60FY_GC5035_5MP_FF_MIPI",
                    "url": "https://sincerefirst.en.made-in-china.com/product/stzRqCgufMVy/China-5MP-Gc5035-CMOS-Image-Sensor-Small-Size-Fixed-Focus-Mipi-Camera-Module.html",
                    "observed_public_specs": {
                        "sensor": "GC5035",
                        "resolution_px": "2592x1944",
                        "interface": "MIPI_2_lane",
                        "pin_count": 30,
                        "focus": "fixed_focus",
                        "module_role": "front_camera_candidate",
                    },
                    "procurement_role": "front_camera_primary_class",
                },
                {
                    "supplier": "Shenzhen Junde Electronics",
                    "marketplace": "Alibaba",
                    "candidate": "IMX219_8MP_fixed_focus_MIPI_module",
                    "url": "https://www.alibaba.com/product-detail/IMX219-8MP-120-Degree-Wide-Angle_1601568412012.html",
                    "observed_public_specs": {
                        "sensor": "IMX219",
                        "resolution_px": "3280x2464",
                        "interface": "MIPI_CSI",
                        "focus": "fixed_focus",
                        "module_size_mm": {"width": 25, "height": 24},
                        "module_role": "front_or_lab_camera_alternate",
                    },
                    "procurement_role": "front_camera_or_lab_bringup_alternate",
                },
            ],
            "cellular": [
                {
                    "supplier": "Quectel",
                    "source_type": "primary_vendor_page",
                    "candidate": "RM255C-GL",
                    "url": "https://www.quectel.com/product/5g-redcap-rm255c-gl/",
                    "observed_public_specs": {
                        "class": "5G_RedCap_Sub_6_M2",
                        "peak_downlink_mbps": 223,
                        "peak_uplink_mbps": 123,
                        "form_factor": "M.2",
                    },
                    "procurement_role": "socketed_lab_and_possible_production_module",
                },
                {
                    "supplier": cellular["primary_first_phone"]["vendor"],
                    "source_type": "package_binding",
                    "candidate": cellular["primary_first_phone"]["family"],
                    "url": cellular["primary_first_phone"]["sourcing_url"],
                    "observed_public_specs": cellular["primary_first_phone"]["public_features"],
                    "procurement_role": "LGA_or_M2_first_phone_target",
                },
            ],
            "wifi_bluetooth": [
                {
                    "supplier": "Murata",
                    "source_type": "primary_vendor_page",
                    "candidate": wifi["vendor_public_specs"]["order_number"],
                    "url": wifi["vendor_public_specs"]["sourcing_url"],
                    "observed_public_specs": {
                        "chipset": wifi["vendor_public_specs"]["chipset"],
                        "wireless": wifi["vendor_public_specs"]["wireless"],
                        "interfaces": wifi["vendor_public_specs"]["interfaces"],
                        "package_mm": wifi["vendor_public_specs"]["package_mm"],
                        "io_voltage_v": wifi["vendor_public_specs"]["io_voltage_v"],
                    },
                    "procurement_role": "primary_wifi_6e_bt_5p3_module",
                }
            ],
        },
        "board_layout_implications": [
            "Keep 78.0 x 153.6 mm device envelope until a better 5.5 inch supplier outline is received.",
            "Keep 64.0 x 132.0 mm rigid board target behind the display and reserve side rails for buttons and antenna plastic.",
            "Route 4-lane DSI and 2-to-4-lane CSI as controlled-impedance MIPI D-PHY before layout closure.",
            "Reserve either LGA cellular module land pattern or M.2 lab interposer area before committing final RF shield dimensions.",
            "Keep Wi-Fi/BT as a shielded SMT module with 1.8 V IO, PCIe/SDIO, UART flow control, and antenna matching/test access.",
        ],
        "must_request_from_suppliers_before_freeze": [
            "display 2D drawing, FPC exit, full pinout, touch controller, init sequence, and backlight curve",
            "rear and front camera drawings, FPC pinouts, lens z-height, lane order, power sequence, and calibration flow",
            "cellular region SKU, hardware design guide, antenna reference, SIM/eSIM reference, carrier certification statement",
            "Murata Type 2EA datasheet package, footprint DXF, hardware app note, radio-law note, and antenna reference layout",
            "sample quote, lead time, lifecycle statement, and second source or pin-compatible alternate for each critical module",
        ],
        "cross_checks": {
            "display_primary_fits_current_envelope": display_fit["primary_fits_current_envelope"],
            "display_clearance_mm": display_fit["primary_clearance_in_current_envelope_mm"],
            "has_alibaba_display_evidence": True,
            "has_made_in_china_display_evidence": True,
            "has_high_brightness_display_alternate": True,
            "has_thin_amoled_display_alternate": True,
            "has_camera_marketplace_evidence": True,
            "has_front_camera_candidate_evidence": True,
            "has_alibaba_camera_evidence": True,
            "has_cellular_primary_vendor_evidence": True,
            "has_wifi_bt_primary_vendor_evidence": True,
        },
        "release_blockers": [
            "supplier_contact_and_quote_not_captured",
            "samples_not_ordered_or_received",
            "exact_pinouts_not_received",
            "supplier_2d_drawings_not_received",
            "supplier_step_models_not_received",
            "connector_mating_parts_not_frozen",
            "lifecycle_and_avl_not_approved",
            "regulatory_certification_scope_not_confirmed",
        ],
        "forbidden_claims": [
            "supplier_selected",
            "samples_ordered",
            "avl_ready",
            "pinouts_frozen",
            "footprints_frozen",
            "enclosure_ready",
            "fabrication_ready",
        ],
    }
    OUT.write_text(yaml.dump(out, Dumper=IndentedSafeDumper, sort_keys=False, width=100))
    print(f"generated {OUT}")
    print(
        "status="
        f"{out['status']} display_sources={len(out['public_sourcing_evidence']['display'])} "
        f"camera_sources={len(out['public_sourcing_evidence']['camera'])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
