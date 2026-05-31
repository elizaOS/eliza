#!/usr/bin/env python3
"""Generate/check the fail-closed E1 SoC PD input contract."""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "pd/openlane/config.sky130.json"
MACRO_MANIFEST = ROOT / "pd/macros/manifest.yaml"
SIGNOFF_MANIFEST = ROOT / "pd/signoff/manifest.yaml"
HARD_MACRO_GATE = ROOT / "docs/evidence/pd/e1-soc-hard-macro-signoff-gate.yaml"
OUTPUT = ROOT / "docs/evidence/pd/e1-soc-pd-input-contract.yaml"
TARGET_MACRO = "sky130_sram_2kbyte_1rw1r_32x512_8"
TARGET_INSTANCE_DOT = "u_soc.u_weight_buffer.u_sram"
TARGET_INSTANCE_SLASH = "u_soc/u_weight_buffer/u_sram"
REQUIRED_RELEASE_FLAGS = [
    "QUIT_ON_TIMING_VIOLATIONS",
    "QUIT_ON_MAGIC_DRC",
    "QUIT_ON_LVS_ERROR",
    "QUIT_ON_SLEW_VIOLATIONS",
]
REQUIRED_RTL = [
    "rtl/top/e1_soc_pkg.sv",
    "rtl/top/e1_chip_top.sv",
    "rtl/top/e1_soc_top.sv",
    "rtl/bootrom/e1_bootrom.sv",
    "rtl/memory/e1_weight_buffer_sram.sv",
]
MIN_MACRO_FILE_BYTES = {
    "lef": 1024,
    "lib": 1024,
    "gds": 1024,
    "spice": 1024,
    "nl": 128,
}
EXPECTED_SRAM_PORTS = {
    "vccd1",
    "vssd1",
    "clk0",
    "csb0",
    "web0",
    "wmask0",
    "addr0",
    "din0",
    "dout0",
    "clk1",
    "csb1",
    "addr1",
    "dout1",
}
FORBIDDEN_REPORT_TERMS = [
    "tapeout-ready",
    "tapeout_ready: true",
    "pd_release_allowed: true",
    "fabrication_release_allowed: true",
]
FALSE_CLAIM_FLAGS = {
    "drc_claim_allowed": False,
    "lvs_claim_allowed": False,
    "sta_claim_allowed": False,
    "pd_release_claim_allowed": False,
    "tapeout_claim_allowed": False,
    "fabrication_claim_allowed": False,
}


class NoAliasDumper(yaml.SafeDumper):
    def ignore_aliases(self, data: Any) -> bool:
        return True


def load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: expected YAML mapping")
    return data


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: expected JSON object")
    return data


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def pdk_root_from_macro(macro: dict[str, Any]) -> Path | None:
    for key in ("lef", "lib", "gds", "spice"):
        value = macro.get(key)
        if not isinstance(value, str):
            continue
        path = (ROOT / value).resolve()
        parts = path.parts
        if "libs.ref" not in parts:
            continue
        libs_index = parts.index("libs.ref")
        return Path(*parts[:libs_index])
    return None


def resolve_dir_ref(value: str, base: Path, pdk_root: Path | None = None) -> Path:
    if value.startswith("dir::"):
        return (base / value.removeprefix("dir::")).resolve()
    if value.startswith("pdk_dir::"):
        if pdk_root is None:
            return (ROOT / value).resolve()
        return (pdk_root / value.removeprefix("pdk_dir::")).resolve()
    path = Path(value)
    return path if path.is_absolute() else (ROOT / path).resolve()


def dir_ref_for(path_text: str, base: Path) -> str:
    path = ROOT / path_text
    return "dir::" + Path(os.path.relpath(path, base)).as_posix()


def ref_matches(expected: str | None, actual: object, base: Path, pdk_root: Path | None) -> bool:
    if not isinstance(expected, str) or not isinstance(actual, str):
        return False
    return resolve_dir_ref(expected, base, pdk_root) == resolve_dir_ref(actual, base, pdk_root)


def macro_record(manifest: dict[str, Any]) -> dict[str, Any]:
    for item in manifest["pdks"]["sky130A"]["target_macros"]:
        if item.get("name") == TARGET_MACRO:
            return item
    raise SystemExit(f"macro manifest missing {TARGET_MACRO}")


def listed_verilog_files(config: dict[str, Any]) -> list[str]:
    files: list[str] = []
    for item in config.get("VERILOG_FILES", []):
        path = resolve_dir_ref(str(item), CONFIG.parent)
        files.append(path.relative_to(ROOT).as_posix())
    return files


def frontend_blockers(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    sim_only_depth = 0
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = line.strip()
        if stripped.startswith("`ifndef YOSYS"):
            sim_only_depth += 1
        elif stripped.startswith("`endif") and sim_only_depth:
            sim_only_depth -= 1
        if sim_only_depth:
            continue
        code = line.split("//", 1)[0]
        if re.search(r"\bstring\b", code):
            rows.append(
                {
                    "file": rel(path),
                    "line": lineno,
                    "kind": "unguarded_systemverilog_string",
                    "text": stripped,
                }
            )
        if "$value$plusargs" in code:
            rows.append(
                {
                    "file": rel(path),
                    "line": lineno,
                    "kind": "unguarded_plusargs_only_path",
                    "text": stripped,
                }
            )
    return rows


def top_level_ports(path: Path) -> set[str]:
    text = path.read_text(encoding="utf-8")
    header = text.split(");", 1)[0]
    ports: set[str] = set()
    for match in re.finditer(
        r"\b(?:input|output|inout)\s+(?:wire|logic)?\s*(?:\[[^\]]+\]\s*)?([A-Za-z_][A-Za-z0-9_]*)",
        header,
    ):
        ports.add(match.group(1))
    return ports


def sdc_get_ports(path: Path) -> set[str]:
    text = path.read_text(encoding="utf-8")
    ports: set[str] = set()
    for bracketed in re.findall(r"\[get_ports\s+\{([^}]*)\}\]", text):
        ports.update(item.rstrip("*") for item in bracketed.split())
    for single in re.findall(r"\[get_ports\s+([A-Za-z_][A-Za-z0-9_*]*)\]", text):
        ports.add(single.rstrip("*"))
    return ports


def create_clock_binding(path: Path) -> tuple[str | None, float | None]:
    text = path.read_text(encoding="utf-8")
    match = re.search(
        r"create_clock\b[^\n]*?-period\s+([0-9.]+)\s+\[get_ports\s+([A-Za-z_][A-Za-z0-9_]*)\]",
        text,
    )
    if not match:
        return None, None
    return match.group(2), float(match.group(1))


def blackbox_ports(path: Path) -> set[str]:
    text = path.read_text(encoding="utf-8")
    ports: set[str] = set()
    for line in text.splitlines():
        code = line.split("//", 1)[0].strip()
        match = re.match(
            r"(?:input|output|inout)\s+(?:\[[^\]]+\]\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*;", code
        )
        if match:
            ports.add(match.group(1))
    return ports


def wrapper_sram_port_map(path: Path) -> set[str]:
    text = path.read_text(encoding="utf-8")
    match = re.search(
        rf"{TARGET_MACRO}\s+u_sram\s*\((.*?)\n\s*\);",
        text,
        flags=re.S,
    )
    if not match:
        return set()
    return set(re.findall(r"\.([A-Za-z_][A-Za-z0-9_]*)\s*\(", match.group(1)))


def io_pin_order_covers(port: str, text: str) -> bool:
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line == port:
            return True
        if line.endswith(".*") and port.startswith(line[:-2]):
            return True
    return False


def check_report(report: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    if report["schema"] != "eliza.e1_soc_pd_input_contract.v1":
        failures.append("schema_mismatch")
    if report["claim_boundary"] != "pd_input_contract_only_not_drc_lvs_sta_or_tapeout_signoff":
        failures.append("claim_boundary_mismatch")
    if report["summary"]["blocker_count"] != len(report["blockers"]):
        failures.append("blocker_count_stale")
    if report["summary"]["input_contract_pass"] != (len(report["blockers"]) == 0):
        failures.append("input_contract_pass_stale")
    for flag, expected in FALSE_CLAIM_FLAGS.items():
        if report.get(flag) is not expected:
            failures.append(f"{flag}_must_be_false")
    for key, value in report["release_policy"].items():
        if key.endswith("_allowed") and value is not False:
            failures.append(f"release_policy_open:{key}")
    if report["release_policy"]["input_contract_can_unlock_signoff"] is not False:
        failures.append("input_contract_can_unlock_signoff")
    if report["release_policy"]["drc_lvs_sta_signoff_required"] is not True:
        failures.append("drc_lvs_sta_signoff_not_required")
    for claim in ["drc_clean", "lvs_clean", "sta_clean", "pd_release_ready", "tapeout_ready"]:
        if claim not in report["forbidden_claims"]:
            failures.append(f"missing_forbidden_claim:{claim}")
    text = yaml.dump(report, Dumper=NoAliasDumper, sort_keys=False)
    lowered = text.lower()
    for term in FORBIDDEN_REPORT_TERMS:
        if term in lowered:
            failures.append(f"forbidden_report_term:{term}")
    return failures


def build_report() -> dict[str, Any]:
    config = load_json(CONFIG)
    manifest = load_yaml(MACRO_MANIFEST)
    signoff = load_yaml(SIGNOFF_MANIFEST)
    hard_macro_gate = load_yaml(HARD_MACRO_GATE)
    macro = macro_record(manifest)
    config_base = CONFIG.parent
    pdk_root = pdk_root_from_macro(macro)

    verilog_files = listed_verilog_files(config)
    missing_verilog_entries = [path for path in REQUIRED_RTL if path not in verilog_files]
    nonexistent_verilog = [path for path in verilog_files if not (ROOT / path).exists()]
    frontend_rows = [row for path in verilog_files for row in frontend_blockers(ROOT / path)]

    macro_cfg = config["MACROS"].get(TARGET_MACRO, {})
    expected_refs = {
        "lef": dir_ref_for(str(macro["lef"]), config_base),
        "lib": dir_ref_for(str(macro["lib"]), config_base),
        "gds": dir_ref_for(str(macro["gds"]), config_base),
        "spice": dir_ref_for(str(macro["spice"]), config_base),
    }
    actual_refs = {
        "lef": (macro_cfg.get("lef") or [None])[0],
        "lib": ((macro_cfg.get("lib") or {}).get("*") or [None])[0],
        "gds": (macro_cfg.get("gds") or [None])[0],
        "spice": (macro_cfg.get("spice") or [None])[0],
        "nl": (macro_cfg.get("nl") or [None])[0],
    }
    macro_ref_sets = {
        "extra_verilog_models": config.get("EXTRA_VERILOG_MODELS", []),
        "macro_lef": macro_cfg.get("lef", []),
        "macro_lib": (macro_cfg.get("lib") or {}).get("*", []),
        "macro_gds": macro_cfg.get("gds", []),
        "macro_nl": macro_cfg.get("nl", []),
        "macro_spice": macro_cfg.get("spice", []),
    }
    macro_ref_drift = [
        {"kind": key, "expected": expected_refs[key], "actual": actual_refs[key]}
        for key in sorted(expected_refs)
        if not ref_matches(expected_refs[key], actual_refs[key], config_base, pdk_root)
    ]
    macro_file_checks: dict[str, dict[str, Any]] = {}
    macro_file_failures: list[dict[str, Any]] = []
    for kind, value in actual_refs.items():
        if not isinstance(value, str):
            macro_file_failures.append({"kind": kind, "path": None, "reason": "missing_reference"})
            continue
        path = resolve_dir_ref(value, config_base, pdk_root)
        size = path.stat().st_size if path.exists() and path.is_file() else 0
        macro_file_checks[kind] = {"path": rel(path), "exists": path.exists(), "bytes": size}
        if not path.exists() or size < MIN_MACRO_FILE_BYTES.get(kind, 1):
            macro_file_failures.append(
                {
                    "kind": kind,
                    "path": rel(path),
                    "bytes": size,
                    "min_bytes": MIN_MACRO_FILE_BYTES.get(kind, 1),
                }
            )
    macro_ref_set_failures: list[dict[str, Any]] = []
    for key, values in macro_ref_sets.items():
        if not values:
            macro_ref_set_failures.append({"kind": key, "reason": "empty_reference_list"})
            continue
        for value in values:
            if not isinstance(value, str) or not (
                value.startswith("dir::") or value.startswith("pdk_dir::")
            ):
                macro_ref_set_failures.append(
                    {"kind": key, "value": value, "reason": "invalid_dir_ref"}
                )
            elif not resolve_dir_ref(value, config_base, pdk_root).exists():
                macro_ref_set_failures.append(
                    {"kind": key, "value": value, "reason": "missing_file"}
                )

    sram_rtl = (ROOT / "rtl/memory/e1_weight_buffer_sram.sv").read_text(encoding="utf-8")
    hard_sram_block_present = (
        "`ifdef E1_HAVE_HARD_SRAM" in sram_rtl and f"{TARGET_MACRO} u_sram" in sram_rtl
    )
    instance_paths = sorted((macro_cfg.get("instances") or {}).keys())
    duplicate_verilog_files = sorted(
        path for path in set(verilog_files) if verilog_files.count(path) > 1
    )
    duplicate_instance_paths = sorted(
        path for path in set(instance_paths) if instance_paths.count(path) > 1
    )
    release_flag_failures = [
        flag for flag in REQUIRED_RELEASE_FLAGS if config.get(flag) is not True
    ]
    define_failures = [
        define
        for define in ["E1_HAVE_HARD_SRAM"]
        if define not in config.get("VERILOG_DEFINES", [])
    ]
    sdc_refs = {
        "PNR_SDC_FILE": config.get("PNR_SDC_FILE"),
        "SIGNOFF_SDC_FILE": config.get("SIGNOFF_SDC_FILE"),
    }
    sdc_failures = [
        {"key": key, "value": value}
        for key, value in sdc_refs.items()
        if not isinstance(value, str) or not resolve_dir_ref(value, config_base).exists()
    ]
    top_ports = top_level_ports(ROOT / "rtl/top/e1_chip_top.sv")
    sdc_ports = sdc_get_ports(ROOT / "pd/constraints/e1_soc.sdc")
    clock_port, clock_period = create_clock_binding(ROOT / "pd/constraints/e1_soc.sdc")
    sdc_semantic_failures: list[dict[str, Any]] = []
    if clock_port != config.get("CLOCK_PORT"):
        sdc_semantic_failures.append(
            {
                "id": "clock_port_mismatch",
                "expected": config.get("CLOCK_PORT"),
                "actual": clock_port,
            }
        )
    expected_clock_period_raw = config.get("CLOCK_PERIOD")
    expected_clock_period: float | None = None
    if isinstance(expected_clock_period_raw, (int, float, str)):
        try:
            expected_clock_period = float(expected_clock_period_raw)
        except (TypeError, ValueError):
            expected_clock_period = None
    if expected_clock_period is None:
        # CLOCK_PERIOD missing or unparseable in config — fail closed as a
        # config error rather than masquerading as an SDC mismatch.
        sdc_semantic_failures.append(
            {
                "id": "clock_period_config_missing_or_invalid",
                "config_value": expected_clock_period_raw,
                "sdc_value": clock_period,
            }
        )
    elif clock_period != expected_clock_period:
        sdc_semantic_failures.append(
            {
                "id": "clock_period_mismatch",
                "expected": expected_clock_period,
                "actual": clock_period,
            }
        )
    for port in sorted(sdc_ports):
        if port and port not in top_ports:
            sdc_semantic_failures.append({"id": "sdc_port_missing_on_top", "port": port})
    io_pin_order_key = (
        "IO_PIN_ORDER_CFG"
        if isinstance(config.get("IO_PIN_ORDER_CFG"), str)
        else "FP_PIN_ORDER_CFG"
        if isinstance(config.get("FP_PIN_ORDER_CFG"), str)
        else None
    )
    io_pin_order_ref = config.get(io_pin_order_key) if io_pin_order_key else None
    io_pin_order_path = (
        resolve_dir_ref(io_pin_order_ref, config_base)
        if isinstance(io_pin_order_ref, str)
        else None
    )
    io_pin_order_text = (
        io_pin_order_path.read_text(encoding="utf-8")
        if io_pin_order_path and io_pin_order_path.exists()
        else ""
    )
    io_pin_order_failures: list[dict[str, Any]] = []
    if io_pin_order_path is None or not io_pin_order_path.exists():
        io_pin_order_failures.append({"id": "io_pin_order_missing", "path": io_pin_order_ref})
    else:
        for port in sorted(port for port in top_ports if port not in {"VPWR", "VGND"}):
            if not io_pin_order_covers(port, io_pin_order_text):
                io_pin_order_failures.append({"id": "io_pin_order_port_missing", "port": port})
    bb_ports = blackbox_ports(ROOT / "pd/openlane/sky130_sram_2kbyte_1rw1r_32x512_8.blackbox.v")
    mapped_ports = wrapper_sram_port_map(ROOT / "rtl/memory/e1_weight_buffer_sram.sv")
    port_compat_failures: list[dict[str, Any]] = []
    if bb_ports != EXPECTED_SRAM_PORTS:
        port_compat_failures.append(
            {
                "id": "blackbox_port_set_mismatch",
                "expected": sorted(EXPECTED_SRAM_PORTS),
                "actual": sorted(bb_ports),
            }
        )
    if not mapped_ports >= EXPECTED_SRAM_PORTS:
        port_compat_failures.append(
            {
                "id": "wrapper_port_map_missing_ports",
                "missing": sorted(EXPECTED_SRAM_PORTS - mapped_ports),
            }
        )
    upstream_warnings: list[dict[str, Any]] = []
    hard_macro_text = yaml.dump(hard_macro_gate, sort_keys=False).lower()
    if "frontend_blocker" in hard_macro_text and not frontend_rows:
        upstream_warnings.append(
            {
                "id": "upstream_evidence_mentions_old_frontend_blocker",
                "source": rel(HARD_MACRO_GATE),
                "current_input_contract_frontend_blocker_count": 0,
            }
        )

    blockers: list[dict[str, Any]] = []
    for missing_path in missing_verilog_entries:
        blockers.append({"id": "missing_required_verilog_entry", "path": missing_path})
    for nonexistent_path in nonexistent_verilog:
        blockers.append({"id": "nonexistent_verilog_file", "path": nonexistent_path})
    for row in frontend_rows:
        blockers.append({"id": "rtl_frontend_blocker", **row})
    for row in macro_ref_drift:
        blockers.append({"id": "macro_reference_drift", **row})
    for row in macro_file_failures:
        blockers.append({"id": "macro_file_missing_or_too_small", **row})
    for row in macro_ref_set_failures:
        blockers.append({"id": "macro_reference_set_invalid", **row})
    for row in sdc_semantic_failures:
        blockers.append({"id": "sdc_semantic_drift", **row})
    for row in io_pin_order_failures:
        blockers.append({"id": "io_pin_order_drift", **row})
    for row in port_compat_failures:
        blockers.append({"id": "blackbox_wrapper_port_incompatibility", **row})
    for duplicate_path in duplicate_verilog_files:
        blockers.append({"id": "duplicate_verilog_file", "path": duplicate_path})
    for path in duplicate_instance_paths:
        blockers.append({"id": "duplicate_macro_instance_path", "path": path})
    for flag in release_flag_failures:
        blockers.append({"id": "release_flag_disabled", "flag": flag})
    for define in define_failures:
        blockers.append({"id": "missing_release_define", "define": define})
    for row in sdc_failures:
        blockers.append({"id": "missing_sdc_ref", **row})
    if config.get("DESIGN_NAME") != "e1_chip_top":
        blockers.append(
            {
                "id": "design_name_mismatch",
                "expected": "e1_chip_top",
                "actual": config.get("DESIGN_NAME"),
            }
        )
    if not hard_sram_block_present:
        blockers.append(
            {
                "id": "rtl_hard_sram_instance_missing",
                "expected": f"{TARGET_MACRO} u_sram under E1_HAVE_HARD_SRAM",
            }
        )
    if TARGET_INSTANCE_DOT not in instance_paths:
        blockers.append(
            {
                "id": "macro_instance_path_missing",
                "expected": TARGET_INSTANCE_DOT,
                "actual": instance_paths,
            }
        )
    if macro.get("instance_path") != TARGET_INSTANCE_SLASH:
        blockers.append(
            {
                "id": "macro_manifest_instance_path_drift",
                "expected": TARGET_INSTANCE_SLASH,
                "actual": macro.get("instance_path"),
            }
        )

    input_contract_pass = not blockers
    return {
        "schema": "eliza.e1_soc_pd_input_contract.v1",
        "status": "draft_local_evidence",
        "input_contract_status": (
            "pd_input_contract_pass_signoff_still_blocked"
            if input_contract_pass
            else "blocked_pd_input_contract_drift"
        ),
        "release_use": "prohibited_until_external_review",
        "scope": "e1_soc_pd_input_contract_for_openlane_sky130_hard_sram_macro",
        **FALSE_CLAIM_FLAGS,
        "release_blockers": [
            "Input contract validation is local setup evidence only; DRC/LVS/STA, antenna, IR, density, foundry/EDA review, and tapeout signoff remain required before release use.",
            "Upstream hard-macro and PD signoff evidence remain prohibited for release until externally reviewed and replayed through the complete fail-closed OpenLane/signoff flow.",
        ],
        "claim_boundary": "pd_input_contract_only_not_drc_lvs_sta_or_tapeout_signoff",
        "source_artifacts": [
            rel(CONFIG),
            rel(MACRO_MANIFEST),
            rel(ROOT / "pd/openlane/sky130_sram_2kbyte_1rw1r_32x512_8.blackbox.v"),
            rel(ROOT / "rtl/top/e1_chip_top.sv"),
            rel(ROOT / "rtl/top/e1_soc_top.sv"),
            rel(ROOT / "rtl/bootrom/e1_bootrom.sv"),
            rel(ROOT / "rtl/memory/e1_weight_buffer_sram.sv"),
            rel(ROOT / "pd/constraints/e1_soc.sdc"),
            rel(SIGNOFF_MANIFEST),
            rel(HARD_MACRO_GATE),
        ],
        "summary": {
            "input_contract_pass": input_contract_pass,
            "blocker_count": len(blockers),
            "verilog_file_count": len(verilog_files),
            "missing_required_verilog_entry_count": len(missing_verilog_entries),
            "nonexistent_verilog_file_count": len(nonexistent_verilog),
            "rtl_frontend_blocker_count": len(frontend_rows),
            "macro_reference_drift_count": len(macro_ref_drift),
            "macro_file_failure_count": len(macro_file_failures),
            "macro_reference_set_failure_count": len(macro_ref_set_failures),
            "blackbox_port_compatibility_failure_count": len(port_compat_failures),
            "sdc_semantic_failure_count": len(sdc_semantic_failures),
            "io_pin_order_failure_count": len(io_pin_order_failures),
            "upstream_warning_count": len(upstream_warnings),
            "release_flag_failure_count": len(release_flag_failures),
            "signoff_release_blocked": True,
            "tapeout_ready": False,
        },
        "config_contract": {
            "design_name": config.get("DESIGN_NAME"),
            "required_defines_present": not define_failures,
            "release_fail_closed_flags": {
                flag: config.get(flag) for flag in REQUIRED_RELEASE_FLAGS
            },
            "sdc_refs": sdc_refs,
            "verilog_files": verilog_files,
        },
        "macro_contract": {
            "macro_name": TARGET_MACRO,
            "manifest_instance_path": macro.get("instance_path"),
            "openlane_instance_paths": instance_paths,
            "expected_refs": expected_refs,
            "actual_refs": actual_refs,
            "macro_ref_sets": macro_ref_sets,
            "macro_file_checks": macro_file_checks,
            "rtl_hard_sram_block_present": hard_sram_block_present,
            "blackbox_ports": sorted(bb_ports),
            "wrapper_mapped_ports": sorted(mapped_ports),
        },
        "sdc_contract": {
            "clock_port": clock_port,
            "clock_period": clock_period,
            "top_ports": sorted(top_ports),
            "sdc_ports": sorted(sdc_ports),
            "io_pin_order_key": io_pin_order_key,
            "io_pin_order_cfg": io_pin_order_ref,
            "io_pin_order_present": bool(io_pin_order_path and io_pin_order_path.exists()),
        },
        "frontend_contract": {
            "guarded_yosys_incompatible_constructs_allowed": True,
            "unguarded_blockers": frontend_rows,
        },
        "upstream_signoff_state": {
            "pd_signoff_manifest_status": signoff.get("status"),
            "hard_macro_gate_status": hard_macro_gate.get("status"),
            "hard_macro_gate_release_use": hard_macro_gate.get("release_use"),
            "warnings": upstream_warnings,
        },
        "blockers": blockers,
        "release_policy": {
            "input_contract_can_unlock_signoff": False,
            "drc_lvs_sta_signoff_required": True,
            "external_review_required": True,
            "pd_release_allowed": False,
            "tapeout_release_allowed": False,
            "fabrication_release_allowed": False,
        },
        "forbidden_claims": [
            "drc_clean",
            "lvs_clean",
            "sta_clean",
            "pd_release_ready",
            "tapeout_ready",
            "fabrication_ready",
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--write-report", action="store_true")
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Exit nonzero if the input contract itself has blockers.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report()
    check_failures = check_report(report)
    if check_failures:
        raise SystemExit(
            "E1 SoC PD input contract report self-check failed: " + ", ".join(check_failures)
        )
    output = yaml.dump(report, Dumper=NoAliasDumper, sort_keys=False, width=100)
    if args.write_report:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
    else:
        print(output, end="")
    if args.strict and report["summary"]["blocker_count"]:
        print(
            "STATUS: BLOCKED E1 SoC PD input contract "
            f"blockers={report['summary']['blocker_count']}"
        )
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
