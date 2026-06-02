#!/usr/bin/env python3
"""Fail-closed check for the e1 cluster core-selection manifests.

Reads every ``generators/chipyard/eliza-*-manifest.json``, validates the
schema and required fields, and verifies that at least one core is
selected with a real pinned upstream SHA for each cluster role
(big_core_e1_ultra, mid_core_e1_premium, little_core_e1_pro, plus the
linux_bringup_application_hart bootstrap role).

The big-core slot is selected as the open XiangShan Kunminghu V3 scale-up
(no vendor IP license required). If no big-core manifest has a real
pinned SHA the gate writes a BLOCKED record explaining the missing
external integration step, without failing the build. Every other role
must have at least one manifest with a real pin or the gate fails closed.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
from collections.abc import Iterable
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_DIR = ROOT / "generators/chipyard"
EVIDENCE_DIR = ROOT / "docs/evidence/cpu_ap"
EVIDENCE_PATH = EVIDENCE_DIR / "core-selection.json"
REPORT = ROOT / "build/reports/core_selection.json"

REQUIRED_FIELDS = (
    "schema",
    "core_role",
    "status",
    "selected_for_2028_phone_class_big_core",
    "claim_level",
    "isa",
    "extensions",
    "privilege_modes",
    "mmu",
    "decode_width",
    "issue_width",
    "rob_entries",
    "harts",
    "cluster_role",
    "cluster_topology_target",
    "cluster_role_in_target_topology",
    "phone_class_claim_allowed",
    "fail_closed_check_command",
)

TARGET_TOPOLOGY = "1_ultra_3_premium_4_pro"
SHA_RE = re.compile(r"^[0-9a-f]{7,40}$")
CLAIM_BOUNDARY = "core_selection_inventory_only_not_rv64_linux_or_aosp_boot_evidence"
FALSE_CLAIM_FLAGS = {
    "phone_class_claim_allowed": False,
    "rv64_linux_boot_claim_allowed": False,
    "aosp_boot_claim_allowed": False,
}


def utc_now() -> str:
    return _dt.datetime.now(_dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def discover_manifests() -> list[Path]:
    if not MANIFEST_DIR.is_dir():
        return []
    return sorted(p for p in MANIFEST_DIR.glob("eliza-*-manifest.json"))


def load_manifest(path: Path, errors: list[str]) -> dict | None:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(f"{path.relative_to(ROOT)}: read failed: {exc}")
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        errors.append(f"{path.relative_to(ROOT)}: invalid JSON: {exc}")
        return None
    if not isinstance(data, dict):
        errors.append(f"{path.relative_to(ROOT)}: top-level must be a JSON object")
        return None
    return data


def manifest_has_real_pin(data: dict) -> bool:
    """True if the manifest names an upstream commit that looks like a real hash."""
    candidates: list[str] = []
    for top in ("core_ip", "wrapper_ip", "generator"):
        block = data.get(top)
        if isinstance(block, dict):
            for key in ("pinned_commit", "commit"):
                value = block.get(key)
                if isinstance(value, str):
                    candidates.append(value)
    return any(SHA_RE.match(value or "") for value in candidates)


def validate_required_fields(name: str, data: dict, errors: list[str]) -> None:
    for field in REQUIRED_FIELDS:
        if field not in data:
            errors.append(f"{name}: missing required field {field!r}")
    if data.get("schema") != "eliza.cpu_ap_core_selection_manifest.v1":
        errors.append(f"{name}: schema must be 'eliza.cpu_ap_core_selection_manifest.v1'")
    if data.get("cluster_topology_target") not in (None, TARGET_TOPOLOGY):
        errors.append(
            f"{name}: cluster_topology_target={data.get('cluster_topology_target')!r} "
            f"must be {TARGET_TOPOLOGY!r}"
        )


def role_classification(role: str | None) -> str:
    role = role or ""
    if role == "big_core_e1_ultra":
        return "big"
    if role == "mid_core_e1_premium":
        return "mid"
    if role == "mid_core_fallback":
        return "mid_fallback"
    if role == "little_core_e1_pro":
        return "little"
    if role == "linux_bringup_application_hart":
        return "linux_bringup"
    return "unknown"


def collect(manifests: Iterable[tuple[Path, dict]]) -> dict[str, list[tuple[str, dict, bool]]]:
    grouped: dict[str, list[tuple[str, dict, bool]]] = {
        "big": [],
        "mid": [],
        "mid_fallback": [],
        "little": [],
        "linux_bringup": [],
        "unknown": [],
    }
    for path, data in manifests:
        bucket = role_classification(data.get("core_role"))
        grouped[bucket].append((path.name, data, manifest_has_real_pin(data)))
    return grouped


def write_evidence(grouped: dict[str, list[tuple[str, dict, bool]]], errors: list[str]) -> None:
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    generated_utc = utc_now()
    summary = {
        "schema": "eliza.cpu_ap_core_selection_evidence.v1",
        "generated_utc": generated_utc,
        "generated_at": generated_utc,
        "claim_boundary": CLAIM_BOUNDARY,
        "manifest_dir": str(MANIFEST_DIR.relative_to(ROOT)),
        "target_topology": TARGET_TOPOLOGY,
        "roles": {
            role: [
                {
                    "manifest": name,
                    "core_role": data.get("core_role"),
                    "status": data.get("status"),
                    "isa": data.get("isa"),
                    "decode_width": data.get("decode_width"),
                    "rob_entries": data.get("rob_entries"),
                    "has_real_pin": has_pin,
                }
                for name, data, has_pin in items
            ]
            for role, items in grouped.items()
        },
        "errors": errors,
        "false_claim_flags": FALSE_CLAIM_FLAGS,
        "verdict": "blocked_big_core"
        if any(
            role == "big" and not any(has for _, _, has in items) for role, items in grouped.items()
        )
        else "ok",
    }
    EVIDENCE_PATH.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")


def build_report(
    grouped: dict[str, list[tuple[str, dict, bool]]],
    errors: list[str],
    *,
    require_big_core_pin: bool,
) -> dict[str, object]:
    big_has_pin = any(has for _, _, has in grouped["big"])
    findings: list[dict[str, object]] = []
    for error in errors:
        findings.append(
            {
                "code": "core_selection_manifest_contract_error",
                "severity": "blocker",
                "message": "core-selection manifest contract failed",
                "evidence": error,
                "next_step": "Fix the selected Chipyard core manifests so every required role has a schema-valid real upstream pin.",
            }
        )
    if not big_has_pin:
        findings.append(
            {
                "code": "core_selection_big_core_pin_blocked",
                "severity": "blocker",
                "message": "no big_core_e1_ultra manifest has a real pinned upstream commit",
                "evidence": "XiangShan Kunminghu scale-up external checkout not yet recorded",
                "next_step": "Record a real pinned upstream commit for the open Kunminghu big-core scale-up, or select a different open phone-class big-core path.",
            }
        )
    status = "fail" if errors and require_big_core_pin else ("blocked" if findings else "pass")
    return {
        "schema": "eliza.cpu_ap_core_selection_report.v1",
        "status": status,
        "generated_utc": utc_now(),
        "claim_boundary": CLAIM_BOUNDARY,
        "summary": {
            "findings": len(findings),
            "manifest_errors": len(errors),
            "big_core_has_real_pin": big_has_pin,
            "require_big_core_pin": require_big_core_pin,
            "false_claim_flags": FALSE_CLAIM_FLAGS,
        },
        "false_claim_flags": FALSE_CLAIM_FLAGS,
        "evidence": {
            "manifest_dir": str(MANIFEST_DIR.relative_to(ROOT)),
            "evidence_path": str(EVIDENCE_PATH.relative_to(ROOT)),
            "target_topology": TARGET_TOPOLOGY,
            "roles": {
                role: [
                    {
                        "manifest": name,
                        "core_role": data.get("core_role"),
                        "status": data.get("status"),
                        "has_real_pin": has_pin,
                    }
                    for name, data, has_pin in items
                ]
                for role, items in grouped.items()
            },
        },
        "findings": findings,
    }


def write_report(report: dict[str, object]) -> None:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--require-big-core-pin",
        action="store_true",
        help="Fail if no big_core_e1_ultra manifest has a real pin",
    )
    args = parser.parse_args()

    errors: list[str] = []
    paths = discover_manifests()
    if not paths:
        errors.append(f"no eliza-*-manifest.json files in {MANIFEST_DIR.relative_to(ROOT)}")

    loaded: list[tuple[Path, dict]] = []
    for path in paths:
        data = load_manifest(path, errors)
        if data is None:
            continue
        validate_required_fields(path.name, data, errors)
        loaded.append((path, data))

    grouped = collect(loaded)

    # Required roles must have at least one selected manifest. Big-core is
    # optional in the sense that license blocks; we record it but only
    # fail when --require-big-core-pin is set.
    # The "mid" role accepts either a primary mid_core_e1_premium manifest
    # with a real pin OR a mid_core_fallback manifest with a real pin. Other
    # roles require a direct manifest with a real pin.
    required_roles = ("little", "linux_bringup")
    for role in required_roles:
        if not grouped[role]:
            errors.append(f"no manifest selected for role {role}")
            continue
        if not any(has for _, _, has in grouped[role]):
            errors.append(f"no manifest in role {role} has a real pinned upstream commit")

    mid_combined = grouped["mid"] + grouped["mid_fallback"]
    if not mid_combined:
        errors.append("no manifest selected for role mid or mid_fallback")
    elif not any(has for _, _, has in mid_combined):
        errors.append("no manifest in role mid or mid_fallback has a real pinned upstream commit")

    big_has_pin = any(has for _, _, has in grouped["big"])
    if args.require_big_core_pin and not big_has_pin:
        errors.append(
            "no big_core_e1_ultra manifest has a real pinned commit; "
            "open XiangShan Kunminghu scale-up checkout not yet recorded"
        )

    write_evidence(grouped, errors)
    write_report(
        build_report(
            grouped,
            errors,
            require_big_core_pin=args.require_big_core_pin,
        )
    )

    if errors:
        print("Core selection check failed:")
        for err in errors:
            print(f"  - {err}")
        if not big_has_pin and not args.require_big_core_pin:
            print(
                "BLOCKED: big_core_e1_ultra has no real pin (open Kunminghu "
                "scale-up checkout pending); other roles passed-or-failed as above."
            )
        return 1

    print("STATUS: PASS cpu.core_selection - manifests pinned for required roles")
    if not big_has_pin:
        print(
            "STATUS: BLOCKED cpu.core_selection_big_core - "
            "open Kunminghu scale-up checkout required for big-core pin"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
