#!/usr/bin/env python3
import json
import sys
from argparse import ArgumentParser
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
# Default points at the surviving local run that has a complete signoff-run.yaml
# manifest. It is the e1_pd_smoke_top reduced smoke top, not the e1_chip_top
# release top, so this default proves the closure mechanics only. The release
# gate (scripts/check_pd_signoff.py) separately enforces design == e1_chip_top.
# Pass --run <chip-top-run-dir> to check a real chip-top closure.
DEFAULT_RUN = ROOT / "pd/openlane/runs/RUN_2026-05-19_05-01-02"

ZERO_METRICS = {
    "antenna__violating__nets": "antenna violating nets",
    "antenna__violating__pins": "antenna violating pins",
    "route__antenna_violation__count": "route antenna violations",
    "timing__hold_vio__count": "hold violation count",
    "timing__setup_vio__count": "setup violation count",
    "timing__hold_r2r_vio__count": "reg-to-reg hold violation count",
    "timing__setup_r2r_vio__count": "reg-to-reg setup violation count",
    "design__max_slew_violation__count": "max slew violations",
    "design__max_cap_violation__count": "max capacitance violations",
    "design__max_fanout_violation__count": "max fanout violations",
    "design__violations": "aggregate design violations",
}

NONNEGATIVE_METRICS = {
    "timing__hold__wns": "hold WNS",
    "timing__hold__tns": "hold TNS",
    "timing__hold_r2r__ws": "reg-to-reg hold worst slack",
    "timing__setup__wns": "setup WNS",
    "timing__setup__tns": "setup TNS",
    "timing__setup_r2r__ws": "reg-to-reg setup worst slack",
}

RELEASE_CLEAN_CHECKS = {
    "antenna",
    "sta",
}


def load_yaml(path: Path) -> dict:
    if not path.is_file():
        return {}
    payload = yaml.safe_load(path.read_text())
    return payload if isinstance(payload, dict) else {}


def load_metrics(run_dir: Path) -> tuple[dict, list[str]]:
    metrics_path = run_dir / "final/metrics.json"
    if not metrics_path.is_file():
        return {}, [f"missing OpenLane metrics: {metrics_path.relative_to(ROOT)}"]
    try:
        payload = json.loads(metrics_path.read_text())
    except json.JSONDecodeError as exc:
        return {}, [f"{metrics_path.relative_to(ROOT)}: invalid JSON: {exc}"]
    if not isinstance(payload, dict):
        return {}, [f"{metrics_path.relative_to(ROOT)}: metrics payload must be a JSON object"]
    return payload, []


def numeric_metric(metrics: dict, key: str, label: str, failures: list[str]) -> float | None:
    value = metrics.get(key)
    if not isinstance(value, (int, float)):
        failures.append(f"missing numeric metric {key} ({label})")
        return None
    return float(value)


def check_metrics(metrics: dict) -> list[str]:
    failures: list[str] = []
    for key, label in ZERO_METRICS.items():
        value = numeric_metric(metrics, key, label, failures)
        if value is not None and value != 0:
            failures.append(f"{label} must be 0 for PD release closure; got {value:g}")

    for key, label in NONNEGATIVE_METRICS.items():
        value = numeric_metric(metrics, key, label, failures)
        if value is not None and value < 0:
            failures.append(f"{label} must be >= 0 for PD release closure; got {value:g}")
    return failures


def check_waivers(run_dir: Path) -> list[str]:
    failures: list[str] = []
    waiver_path = run_dir / "signoff-waivers.yaml"
    waivers = load_yaml(waiver_path)
    for waiver in waivers.get("waivers", []) if isinstance(waivers.get("waivers"), list) else []:
        if not isinstance(waiver, dict):
            continue
        check = waiver.get("check")
        status = waiver.get("status")
        if check in RELEASE_CLEAN_CHECKS and status != "closed_release_clean":
            failures.append(
                f"{waiver_path.relative_to(ROOT)}: {check} waiver remains {status}; "
                "release closure requires closed_release_clean"
            )
    return failures


def check_run_manifest(run_dir: Path) -> list[str]:
    failures: list[str] = []
    manifest_path = run_dir / "signoff-run.yaml"
    manifest = load_yaml(manifest_path)
    checks = manifest.get("checks", {})
    if not isinstance(checks, dict):
        return [f"{manifest_path.relative_to(ROOT)}: checks must be a mapping"]
    for check in sorted(RELEASE_CLEAN_CHECKS):
        status = (
            checks.get(check, {}).get("status") if isinstance(checks.get(check), dict) else None
        )
        if status != "clean":
            failures.append(
                f"{manifest_path.relative_to(ROOT)}: checks.{check}.status must be clean; got {status}"
            )
    return failures


def main() -> int:
    parser = ArgumentParser(
        description="Fail closed on numeric OpenLane PD release closure metrics."
    )
    parser.add_argument(
        "--run",
        default=str(DEFAULT_RUN.relative_to(ROOT)),
        help="OpenLane run directory to check",
    )
    args = parser.parse_args()

    run_dir = (ROOT / args.run).resolve()
    try:
        rel_run = run_dir.relative_to(ROOT)
    except ValueError:
        print(f"PD closure check failed: --run must stay inside this repository: {args.run}")
        return 1
    if not run_dir.is_dir():
        print(f"PD closure check failed: run directory missing: {rel_run}")
        return 1

    metrics, failures = load_metrics(run_dir)
    if metrics:
        failures.extend(check_metrics(metrics))
    failures.extend(check_run_manifest(run_dir))
    failures.extend(check_waivers(run_dir))

    if failures:
        print(f"PD closure check failed for {rel_run}:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print(f"PD closure check passed for {rel_run}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
