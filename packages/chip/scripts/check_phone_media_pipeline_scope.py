#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from chip_utils import load_yaml_object, require

ROOT = Path(__file__).resolve().parents[1]
MIN_BLOCKS = ROOT / "docs/project/phone-soc-minimum-blocks.yaml"
PHONE_PLATFORM = ROOT / "docs/architecture-optimization/phone-platform.md"
REAL_WORLD_GAPS = ROOT / "docs/manufacturing/real-world-verification-gaps.yaml"
DISPLAY_RTL = ROOT / "rtl/display/e1_display.sv"
DISPLAY_TEST = ROOT / "verify/cocotb/test_e1_display.py"
OUT = ROOT / "build/reports/phone_media_pipeline_scope.json"
FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "graphics_runtime_claim_allowed": False,
    "camera_runtime_claim_allowed": False,
    "android_hwc_claim_allowed": False,
    "camera_hal_claim_allowed": False,
    "image_quality_claim_allowed": False,
    "hardware_boot_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def block_by_id(blocks: list[Any], block_id: str) -> dict[str, Any]:
    for block in blocks:
        if isinstance(block, dict) and block.get("id") == block_id:
            return block
    return {}


def gap_by_id(gaps: list[Any], gap_id: str) -> dict[str, Any]:
    for gap in gaps:
        if isinstance(gap, dict) and gap.get("id") == gap_id:
            return gap
    return {}


def contains_all(text: str, tokens: tuple[str, ...]) -> bool:
    lowered = text.lower()
    return all(token.lower() in lowered for token in tokens)


def code_from_text(text: str, fallback: str) -> str:
    cleaned = "".join(char.lower() if char.isalnum() else "_" for char in text)
    parts = [part for part in cleaned.split("_") if part]
    return "_".join(parts[:10]) or fallback


def structured_findings(
    display_blockers: list[str],
    camera_blockers: list[str],
    checks: list[dict[str, Any]],
) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    for item in display_blockers:
        findings.append(
            {
                "code": f"media_display_missing_real_evidence_{code_from_text(item, 'evidence')}",
                "severity": "blocker",
                "message": item,
                "evidence": "display_scaffold.blocked_until_real_evidence",
                "next_step": "Capture booted display/GPU/HWC/panel evidence before claiming phone-class display or no-issues UI runtime.",
            }
        )
    for item in camera_blockers:
        findings.append(
            {
                "code": f"media_camera_missing_real_evidence_{code_from_text(item, 'evidence')}",
                "severity": "blocker",
                "message": item,
                "evidence": "camera_isp_scope.blocked_until_real_evidence",
                "next_step": "Capture sensor/CSI/ISP/V4L2 or Android Camera HAL evidence before claiming phone-class camera readiness.",
            }
        )
    for check in checks:
        if check.get("status") == "pass":
            continue
        ident = str(check.get("id", "scope_check"))
        findings.append(
            {
                "code": f"media_scope_check_failed_{code_from_text(ident, 'scope_check')}",
                "severity": "blocker",
                "message": f"{ident} structural scope check is {check.get('status')}",
                "evidence": str(check.get("evidence", "")),
                "next_step": "Repair the media pipeline scope contract before using this report as runtime evidence.",
            }
        )
    return findings


def build_report() -> dict[str, Any]:
    min_blocks = load_yaml_object(MIN_BLOCKS)
    real_world = load_yaml_object(REAL_WORLD_GAPS)
    phone_platform = PHONE_PLATFORM.read_text(encoding="utf-8")
    display_rtl = DISPLAY_RTL.read_text(encoding="utf-8")
    display_test = DISPLAY_TEST.read_text(encoding="utf-8")

    blocks = min_blocks.get("phone_soc_blocks")
    if not isinstance(blocks, list):
        raise ValueError("phone-soc-minimum-blocks must list phone_soc_blocks")
    gaps = real_world.get("gaps")
    if not isinstance(gaps, list):
        raise ValueError("real-world-verification-gaps must list gaps")

    display_block = block_by_id(blocks, "graphics_display_subsystem")
    phone_io_block = block_by_id(blocks, "phone_io_and_power")
    camera_gap = gap_by_id(gaps, "camera_isp_stack")

    display_checks = [
        {
            "id": "display_block_fail_closed",
            "status": "pass"
            if "blocked" in str(display_block.get("current_status", ""))
            else "fail",
            "evidence": "docs/project/phone-soc-minimum-blocks.yaml#graphics_display_subsystem",
        },
        {
            "id": "display_rtl_underflow_contract_present",
            "status": "pass"
            if contains_all(
                display_rtl,
                ("underflow_count", "fb_read_ready", "scan_vsync", "scan_rgb"),
            )
            else "fail",
            "evidence": rel(DISPLAY_RTL),
        },
        {
            "id": "display_cocotb_scope_boundary_present",
            "status": "pass"
            if contains_all(
                display_test,
                (
                    "no DRM/KMS",
                    "display_counts_fetched_pixels_and_underflows",
                    "display_reports_stride_and_frame_byte_count",
                    "display_disable_resets_scan_position_and_blocks_fetches",
                ),
            )
            else "fail",
            "evidence": rel(DISPLAY_TEST),
        },
        {
            "id": "phone_platform_display_work_order_present",
            "status": "pass"
            if contains_all(
                phone_platform,
                ("scanout", "framebuffer format", "underflow detection", "Android HAL"),
            )
            else "fail",
            "evidence": rel(PHONE_PLATFORM),
        },
    ]

    camera_checks = [
        {
            "id": "camera_isp_real_world_gap_fail_closed",
            "status": "pass"
            if "not implemented" in str(camera_gap.get("claim_boundary", ""))
            else "fail",
            "evidence": "docs/manufacturing/real-world-verification-gaps.yaml#camera_isp_stack",
        },
        {
            "id": "camera_isp_required_evidence_enumerated",
            "status": "pass"
            if contains_all(
                "\n".join(str(item) for item in camera_gap.get("required_evidence", [])),
                ("sensor", "CSI", "ISP", "tuning", "HAL"),
            )
            else "fail",
            "evidence": "docs/manufacturing/real-world-verification-gaps.yaml#camera_isp_stack",
        },
        {
            "id": "phone_io_camera_scope_blocked",
            "status": "pass"
            if "blocked" in str(phone_io_block.get("current_status", ""))
            and "camera CSI/ISP path"
            in "\n".join(str(item) for item in phone_io_block.get("minimum_subblocks", []))
            else "fail",
            "evidence": "docs/project/phone-soc-minimum-blocks.yaml#phone_io_and_power",
        },
    ]
    checks = display_checks + camera_checks
    display_blockers = [
        "GPU or 2D composition path",
        "DRM/KMS or Android HWC runtime transcript",
        "DSI/eDP/HDMI or panel bridge evidence",
        "memory-pressure underflow measurement",
    ]
    camera_blockers = [
        "sensor and lens selection",
        "CSI lane and PHY evidence",
        "ISP ownership and tuning package",
        "Linux V4L2 or Android Camera HAL transcript",
        "privacy indicator and permission evidence",
    ]
    findings = structured_findings(display_blockers, camera_blockers, checks)
    return {
        "schema": "eliza.phone_media_pipeline_scope.v1",
        "status": "media_pipeline_scope_release_blocked",
        "generated_utc": datetime.now(UTC).isoformat(),
        "claim_boundary": (
            "Display scaffold and camera/ISP scope audit only; not GPU, DRM/KMS, "
            "Android HWC, DSI/CSI PHY, camera sensor, ISP tuning, HAL, image quality, "
            "or phone-class graphics/camera evidence."
        ),
        **FALSE_CLAIM_FLAGS,
        "display_scaffold": {
            "rtl": rel(DISPLAY_RTL),
            "cocotb": rel(DISPLAY_TEST),
            "covered_now": [
                "XR24 scanout",
                "frame byte count",
                "vsync/hsync cadence",
                "framebuffer ready backpressure",
                "underflow counter",
            ],
            "blocked_until_real_evidence": display_blockers,
        },
        "camera_isp_scope": {
            "gap_id": "camera_isp_stack",
            "current_state": "blocked_not_implemented",
            "blocked_until_real_evidence": camera_blockers,
        },
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
    require(
        data.get("schema") == "eliza.phone_media_pipeline_scope.v1",
        "schema mismatch",
        errors,
    )
    require(
        data.get("status") == "media_pipeline_scope_release_blocked",
        "status must remain media_pipeline_scope_release_blocked",
        errors,
    )
    boundary = str(data.get("claim_boundary", ""))
    for token in ("not GPU", "DRM/KMS", "Android HWC", "DSI/CSI PHY", "camera sensor"):
        require(token in boundary, f"claim boundary missing {token}", errors)
    for key, expected in FALSE_CLAIM_FLAGS.items():
        require(data.get(key) is expected, f"{key} must stay false", errors)
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
    display = data.get("display_scaffold")
    camera = data.get("camera_isp_scope")
    if not isinstance(display, dict) or not isinstance(camera, dict):
        errors.append("display_scaffold and camera_isp_scope must be mappings")
        return errors
    display_blocked = display.get("blocked_until_real_evidence")
    camera_blocked = camera.get("blocked_until_real_evidence")
    if not isinstance(display_blocked, list) or len(display_blocked) < 4:
        errors.append("display must list blocked real-evidence items")
    if not isinstance(camera_blocked, list) or len(camera_blocked) < 5:
        errors.append("camera/ISP must list blocked real-evidence items")
    findings = data.get("findings")
    if not isinstance(findings, list) or not findings:
        errors.append("findings must list structured media pipeline blockers")
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
    print(f"Phone media pipeline scope check passed: {rel(OUT)} remains release-blocked.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
