#!/usr/bin/env python3
"""Aggregate generated AP Linux boot blockers without creating boot evidence."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from cpu_ap_evidence_lib import ROOT, rel

BUILD = ROOT / "build/chipyard/eliza_rocket"
REPORT = ROOT / "build/reports/cpu_ap_boot_readiness.json"
LINUX_ARTIFACTS = ROOT / "docs/evidence/linux/eliza-linux-boot-artifacts.json"

REQUIRED_GENERATED = {
    "generated_manifest": BUILD / "ElizaRocketConfig.manifest.json",
    "verilog": BUILD / "eliza_rocket_ap.v",
    "dts": BUILD / "eliza-e1.dts",
}
REQUIRED_DTS_TOKENS = {
    "cpu": "cpu@0",
    "mmu": "riscv,sv39",
    "memory": "memory@80000000",
    "uart": "serial@10001000",
    "plic": "interrupt-controller@c000000",
}
FALSE_CLAIM_FLAGS = (
    "phone_claim_allowed",
    "release_claim_allowed",
    "android_boot_claim_allowed",
)
GENERATED_AP_BOOT_FLAGS = (
    "linux_boot_claim_allowed",
    "generated_ap_boot_claim_allowed",
    "privileged_boot_claim_allowed",
)


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except json.JSONDecodeError:
        return {"_invalid_json": True}
    return value if isinstance(value, dict) else {"_invalid_json": True}


def add_blocker(blockers: list[dict[str, str]], gate: str, detail: str, next_command: str) -> None:
    blockers.append({"gate": gate, "detail": detail, "next": next_command})


def check_generated(errors: list[str], blockers: list[dict[str, str]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name, path in REQUIRED_GENERATED.items():
        state = "pass" if path.is_file() and path.stat().st_size else "missing"
        result[name] = {"path": rel(path), "state": state}
        if state != "pass":
            add_blocker(
                blockers,
                f"generated.{name}",
                f"{rel(path)} is missing",
                "python3 scripts/generate_chipyard_eliza.py",
            )
    dts = REQUIRED_GENERATED["dts"]
    if dts.is_file():
        text = dts.read_text(encoding="utf-8", errors="replace")
        for name, token in REQUIRED_DTS_TOKENS.items():
            if token not in text:
                errors.append(f"generated DTS missing {name}: {token}")
    return result


def check_smoke(blockers: list[dict[str, str]]) -> dict[str, Any]:
    path = BUILD / "verilator-linux-smoke.json"
    report = load_json(path)
    if report.get("status") == "pass":
        return {"path": rel(path), "state": "pass"}
    progress = report.get("progress", {})
    stage = progress.get("stage", "missing") if isinstance(progress, dict) else "missing"
    add_blocker(
        blockers,
        "chipyard.verilator_linux_smoke",
        f"generated AP Linux smoke not passing; progress_stage={stage}",
        "CHIPYARD_LINUX_BINARY=<payload> scripts/run_chipyard_eliza_linux_smoke.sh",
    )
    return {"path": rel(path), "state": "blocked", "progress_stage": stage}


def check_linux_artifacts(blockers: list[dict[str, str]]) -> dict[str, Any]:
    manifest = load_json(LINUX_ARTIFACTS)
    if not manifest:
        add_blocker(
            blockers,
            "linux_boot_artifacts.manifest",
            f"missing {rel(LINUX_ARTIFACTS)}",
            "make linux-boot-artifacts-check",
        )
        return {"path": rel(LINUX_ARTIFACTS), "state": "missing"}
    items = []
    for spec in manifest.get("artifacts", []):
        if not isinstance(spec, dict) or not isinstance(spec.get("path"), str):
            continue
        path = ROOT / spec["path"]
        state = "pass" if path.is_file() and path.stat().st_size else "missing"
        item = {"id": spec.get("id", ""), "path": rel(path), "state": state}
        items.append(item)
        if state != "pass":
            add_blocker(
                blockers,
                f"linux_boot_artifact.{spec.get('id', 'unknown')}",
                f"missing {rel(path)}",
                str(spec.get("producer", "make linux-boot-artifacts-check")),
            )
    state = "pass" if items and all(item["state"] == "pass" for item in items) else "blocked"
    return {"path": rel(LINUX_ARTIFACTS), "state": state, "artifacts": items}


def build_report() -> dict[str, Any]:
    errors: list[str] = []
    blockers: list[dict[str, str]] = []
    report = {
        "schema": "eliza.cpu_ap_boot_readiness.v1",
        "claim_boundary": (
            "generated_rocket_rv64gc_ap_boot_readiness_only_not_phone_android_release_or_silicon_evidence"
        ),
        "generated_utc": utc_now(),
        **{flag: False for flag in FALSE_CLAIM_FLAGS},
        **{flag: False for flag in GENERATED_AP_BOOT_FLAGS},
        "generated_artifacts": check_generated(errors, blockers),
        "chipyard_verilator_linux_smoke": check_smoke(blockers),
        "linux_boot_artifacts": check_linux_artifacts(blockers),
        "errors": errors,
        "blockers": blockers,
    }
    report["status"] = "fail" if errors else ("blocked" if blockers else "pass")
    if report["status"] == "pass":
        for flag in GENERATED_AP_BOOT_FLAGS:
            report[flag] = True
    for flag in FALSE_CLAIM_FLAGS:
        if report.get(flag) is not False:
            errors.append(f"{flag} must be exactly false")
    for flag in GENERATED_AP_BOOT_FLAGS:
        expected = report["status"] == "pass"
        if report.get(flag) is not expected:
            errors.append(f"{flag} must be {expected} when status is {report['status']}")
    if errors:
        report["status"] = "fail"
    return report


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--require-pass", action="store_true")
    args = parser.parse_args(argv)
    report = build_report()
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(f"STATUS: {report['status'].upper()} cpu_ap.boot_readiness")
        print(f"  report: {rel(REPORT)}")
        for error in report["errors"]:
            print(f"  - ERROR: {error}")
        for blocker in report["blockers"]:
            print(f"  - BLOCKED {blocker['gate']}: {blocker['detail']}")
            print(f"    next: {blocker['next']}")
    if report["status"] == "fail":
        return 1
    if report["status"] == "blocked" and args.require_pass:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
