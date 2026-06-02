#!/usr/bin/env python3
"""Validate display-scanout formal evidence in the formal manifest."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
FORMAL_MANIFEST = ROOT / "build/reports/formal_manifest.json"
HARNESS = ROOT / "verify/formal/e1_display_scanout_formal.sv"
RTL = ROOT / "rtl/display/e1_display_scanout.sv"
REPORT = ROOT / "build/reports/display_formal_coverage.json"
FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "panel_bringup_claim_allowed": False,
    "dsi_phy_claim_allowed": False,
    "drm_kms_claim_allowed": False,
    "full_display_correctness_claim_allowed": False,
    "production_framebuffer_claim_allowed": False,
}

TARGET = "e1_display_scanout"
EXPECTED: dict[str, Any] = {
    "status": "pass",
    "evidence_class": "sby_bmc",
    "spec": "verify/formal/e1_display_scanout.sby",
    "engine": "smtbmc z3",
    "task": {"mode": "bmc", "depth": "80", "multiclock": "off"},
    "covered_files": {
        "rtl/interconnect/axi4/e1_axi4_pkg.sv",
        "rtl/display/e1_display_scanout.sv",
        "verify/formal/e1_display_scanout_formal.sv",
    },
}

REQUIRED_HARNESS_TOKENS = (
    "assert(!m_arvalid)",
    "assert(!pix_de)",
    "assert(dcs_vsync_pulse == pix_vsync)",
    "assert(pix_de == pix_valid)",
    "assert(pix_de == formal_active)",
    "assert(!irq_vsync || pix_vsync)",
    "assert(formal_h_count < formal_h_total)",
    "assert(formal_v_count < formal_v_total)",
    "assert(formal_fifo_level <= 16'd8)",
    "assert(formal_byte_cnt <= 5'd12)",
    "assert(formal_outstanding_cnt <= 2)",
    "assert(m_rready == (formal_fifo_level < 16'd8))",
    "assert(!m_arvalid || formal_fetch_busy)",
    "assert(!m_arvalid || formal_line_words_left != 16'd0)",
    "assert(m_araddr == formal_fetch_addr)",
    "assert(m_araddr >= formal_line_start_addr)",
    "assert(m_araddr < formal_line_start_addr + {16'h0, formal_words_per_line, 2'b00})",
    "assert(m_araddr >= prev_araddr)",
    "assert(pix_data == 24'h00_0000)",
    "assert(formal_underflow_now)",
    "assert(formal_format == 32'h3432_5258)",
    "assert(formal_h_count == 16'd0)",
    "assert(formal_v_count == formal_v_sync_end)",
    "assert(formal_h_count == formal_h_active)",
    "assert(rdata[0])",
    "assert(!formal_underflow_sticky || formal_underflow_now)",
    "assert(formal_underflow_count == 32'h0 || formal_underflow_now)",
    "cover(saw_ar)",
    "cover(saw_active_underflow)",
    "cover(saw_irq_vsync)",
)

REQUIRED_RTL_TOKENS = (
    "QOS_DISPLAY_RT",
    "CACHE_NORMAL_NON_CACHEABLE",
    "PROT_DATA_NS_PRIV",
    "formal_fb_base",
    "formal_fetch_addr",
    "formal_line_start_addr",
    "formal_line_words_left",
    "formal_outstanding_cnt",
    "formal_fifo_level",
    "formal_byte_cnt",
    "formal_prefetch_arm",
    "formal_line_realign",
    "formal_underflow_now",
    "formal_underflow_sticky",
    "formal_underflow_count",
    "formal_fetch_busy",
)


def write_report(status: str, errors: list[str], manifest: dict | None) -> None:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(
        json.dumps(
            {
                "schema": "eliza.display_formal_coverage.v1",
                "status": status,
                "as_of": datetime.now(UTC).isoformat(),
                "generated_utc": datetime.now(UTC).isoformat(),
                "subsystem": "display",
                "evidence_paths": [
                    "build/reports/formal_manifest.json",
                    "verify/formal/e1_display_scanout.sby",
                    "verify/formal/e1_display_scanout_formal.sv",
                    "rtl/display/e1_display_scanout.sv",
                    "rtl/interconnect/axi4/e1_axi4_pkg.sv",
                ],
                "phone_claim_allowed": False,
                "release_claim_allowed": False,
                "panel_bringup_claim_allowed": False,
                "dsi_phy_claim_allowed": False,
                "drm_kms_claim_allowed": False,
                "full_display_correctness_claim_allowed": False,
                "production_framebuffer_claim_allowed": False,
                "false_claim_flags": FALSE_CLAIM_FLAGS,
                "claim_boundary": (
                    "Checks that the formal manifest records the display scanout "
                    "SBY target as passing with expected covered files, z3 engine "
                    "metadata, depth-80 BMC task metadata, status/log hashes, and "
                    "strict non-release manifest flags. Also checks that the harness "
                    "and RTL retain formal observability and assertions for disabled "
                    "quiescence, vsync sidebands, active-window equivalence, AXI read "
                    "attributes, FIFO/read-ready/outstanding bounds, framebuffer "
                    "address bounds, underflow fill/status, and W1C clear behavior. "
                    "This is bounded local digital scanout evidence only; it is not "
                    "DSI PHY, panel bring-up, async pixel-clock CDC, DRM/KMS, full "
                    "mode coverage, SoC replacement, hardware-in-loop, or release "
                    "evidence."
                ),
                "expected": {
                    **EXPECTED,
                    "covered_files": sorted(EXPECTED["covered_files"]),
                },
                "required_harness_tokens": list(REQUIRED_HARNESS_TOKENS),
                "required_rtl_tokens": list(REQUIRED_RTL_TOKENS),
                "formal_manifest_mode": None if manifest is None else manifest.get("mode"),
                "errors": errors,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )


def validate_manifest(manifest: dict) -> list[str]:
    errors: list[str] = []
    if manifest.get("fallback_equivalent_to_sby") is not False:
        errors.append("formal manifest must keep fallback_equivalent_to_sby=false")
    if manifest.get("deep_top_required_for_release") is not True:
        errors.append("formal manifest must keep deep_top_required_for_release=true")
    if manifest.get("strict_release_claim_allowed") is not False:
        errors.append("display formal coverage check requires non-release routine formal manifest")

    _entries_raw = manifest.get("entries")
    entries: dict[str, Any] = _entries_raw if isinstance(_entries_raw, dict) else {}
    entry = entries.get(TARGET)
    if not isinstance(entry, dict):
        return errors + [f"formal manifest missing {TARGET}"]

    if entry.get("status") != EXPECTED["status"]:
        errors.append(f"{TARGET} status must be {EXPECTED['status']}")
    if entry.get("evidence_class") != EXPECTED["evidence_class"]:
        errors.append(f"{TARGET} evidence_class must be {EXPECTED['evidence_class']}")

    _paths_raw = entry.get("paths")
    paths: dict[str, Any] = _paths_raw if isinstance(_paths_raw, dict) else {}
    for key in ("status", "status_sha256", "log", "log_sha256"):
        if key not in paths:
            errors.append(f"{TARGET} paths missing {key}")

    _sby_raw = entry.get("sby")
    sby: dict[str, Any] = _sby_raw if isinstance(_sby_raw, dict) else {}
    if sby.get("spec") != EXPECTED["spec"]:
        errors.append(f"{TARGET} spec must be {EXPECTED['spec']}")
    if EXPECTED["engine"] not in set(sby.get("engines") or []):
        errors.append(f"{TARGET} must record {EXPECTED['engine']} engine")
    covered: set[str] = set(sby.get("covered_files") or [])
    expected_covered: set[str] = set(EXPECTED["covered_files"])
    missing_files = sorted(expected_covered - covered)
    if missing_files:
        errors.append(f"{TARGET} missing covered_files: {', '.join(missing_files)}")

    _tasks_raw = sby.get("tasks")
    tasks: dict[str, Any] = _tasks_raw if isinstance(_tasks_raw, dict) else {}
    task_meta = tasks.get("bmc")
    if not isinstance(task_meta, dict):
        errors.append(f"{TARGET} missing bmc task")
    else:
        expected_task: dict[str, str] = EXPECTED["task"]
        for key, value in expected_task.items():
            if str(task_meta.get(key)) != value:
                errors.append(f"{TARGET} bmc task {key} must be {value}")
    return errors


def missing_tokens(path: Path, tokens: tuple[str, ...]) -> list[str]:
    if not path.is_file():
        return [f"missing file {path.relative_to(ROOT)}"]
    text = path.read_text(encoding="utf-8", errors="ignore")
    return [token for token in tokens if token not in text]


def main() -> int:
    if not FORMAL_MANIFEST.is_file():
        write_report("BLOCKED", [f"missing {FORMAL_MANIFEST.relative_to(ROOT)}"], None)
        print("BLOCKED: formal manifest missing")
        return 1

    manifest = json.loads(FORMAL_MANIFEST.read_text(encoding="utf-8"))
    errors = validate_manifest(manifest)
    harness_missing = missing_tokens(HARNESS, REQUIRED_HARNESS_TOKENS)
    if harness_missing:
        errors.append("display formal harness missing token(s): " + ", ".join(harness_missing))
    rtl_missing = missing_tokens(RTL, REQUIRED_RTL_TOKENS)
    if rtl_missing:
        errors.append("display RTL missing formal token(s): " + ", ".join(rtl_missing))

    if errors:
        write_report("BLOCKED", errors, manifest)
        print("BLOCKED: display formal coverage check failed")
        for error in errors:
            print(f"  - {error}")
        return 1

    write_report("PASS", [], manifest)
    print("PASS: display formal coverage manifest check")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
